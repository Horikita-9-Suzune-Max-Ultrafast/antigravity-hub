import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitContext } from '../git-context.mjs';
import { isPathInsideRoot } from '../fs-utils.mjs';

const execFileAsync = promisify(execFile);

export const VALID_REVIEW_SCOPES = ['uncommitted', 'staged', 'last_commit', 'branch'];

const DEFAULT_MAX_DIFF_BYTES = Math.round(1.5 * 1024 * 1024); // 1.5 MiB
const MAX_SINGLE_FILE_DIFF_BYTES = 120 * 1024; // 120 KiB
const MAX_UNTRACKED_SYNTHETIC_BYTES = 64 * 1024; // 64 KiB
const GIT_EXEC_TIMEOUT_MS = 8000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

const SAFE_BASE_REF_RE = /^[A-Za-z0-9._/-]{1,120}$/;

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'go.sum',
]);

const GENERATED_DIR_RE = /(?:^|\/)(?:dist|build|\.next|out|coverage)\//i;
const GENERATED_EXT_RE = /\.(?:min\.js|min\.css|map)$/i;

/**
 * Strictly validate a Git baseRef to prevent option/argument injection.
 */
export function validateBaseRef(baseRef) {
  if (typeof baseRef !== 'string') {
    throw new Error('Invalid baseRef: must be a non-empty string');
  }
  const trimmed = baseRef.trim();
  if (!trimmed) {
    throw new Error('Invalid baseRef: must be a non-empty string');
  }
  if (
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    !SAFE_BASE_REF_RE.test(trimmed)
  ) {
    throw new Error(`Unsafe baseRef rejected: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Classify noise files that should be folded out of static line scan & L2 diff payload.
 */
export function classifyNoiseFile(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm) return null;
  const base = path.posix.basename(norm).toLowerCase();
  if (LOCKFILE_NAMES.has(base)) {
    return 'lockfile';
  }
  if (GENERATED_DIR_RE.test(norm) || GENERATED_EXT_RE.test(norm)) {
    return 'generated';
  }
  return null;
}

async function execGit(args, cwd, { encoding = 'utf8', allowFail = false } = {}) {
  try {
    const res = await execFileAsync('git', args, {
      cwd,
      encoding,
      windowsHide: true,
      timeout: GIT_EXEC_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { ok: true, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    if (allowFail) {
      return { ok: false, stdout: err?.stdout || '', stderr: err?.stderr || '', err };
    }
    throw err;
  }
}

function unquoteGitPath(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        if (next >= '0' && next <= '7') {
          const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] || next;
          bytes.push(parseInt(oct, 8));
          i += oct.length;
        } else {
          const map = { n: 10, r: 13, t: 9, '\\': 92, '"': 34 };
          bytes.push(map[next] ?? next.charCodeAt(0));
          i += 1;
        }
      } else {
        const buf = Buffer.from(s[i], 'utf8');
        for (const b of buf) bytes.push(b);
      }
    }
    s = Buffer.from(bytes).toString('utf8');
  }
  return s.replace(/\\/g, '/');
}

function stripDiffPrefix(p) {
  const unquoted = unquoteGitPath(p);
  if (unquoted === '/dev/null') return '/dev/null';
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function parseDiffHeaderPaths(headerLine) {
  // Handle `diff --git a/foo b/foo` and quoted `diff --git "a/foo bar" "b/foo bar"`
  const rest = headerLine.slice('diff --git '.length).trim();
  const tokens = [];
  let cur = '';
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      cur += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (ch === ' ' && !inQuotes) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (tokens.length >= 2) {
    return {
      aPath: stripDiffPrefix(tokens[0]),
      bPath: stripDiffPrefix(tokens[tokens.length - 1]),
    };
  }
  return { aPath: '', bPath: '' };
}

function formatPatchLine(prefix, lineNum, content) {
  if (prefix === '-') {
    return `-    | ${content}`;
  }
  const numStr = String(lineNum).padStart(4, '0');
  return `${prefix}${numStr}| ${content}`;
}

/**
 * Parse a unified git diff output string into structured files, hunks, exact new-file line numbers,
 * and folded skipped files.
 */
export function parseUnifiedDiff(rawDiff, { maxDiffBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  const files = [];
  const skippedFiles = [];
  let truncated = false;
  let usedBytes = 0;

  if (!rawDiff || typeof rawDiff !== 'string') {
    return { files, skippedFiles, truncated, totalDiffBytes: 0 };
  }

  // Split into per-file sections starting at `diff --git `
  const lines = rawDiff.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current);

  let totalDiffBytes = 0;

  for (const secLines of sections) {
    const secText = secLines.join('\n');
    const secBytes = Buffer.byteLength(secText, 'utf8');
    totalDiffBytes += secBytes;

    const { aPath, bPath } = parseDiffHeaderPaths(secLines[0]);
    let oldPath = aPath || null;
    let newPath = bPath || null;
    let status = 'M';
    let isBinary = false;
    let renameFrom = null;
    let renameTo = null;
    let sawNewFileMode = false;
    let sawDeletedFileMode = false;

    let firstHunkIdx = secLines.length;
    for (let i = 1; i < secLines.length; i++) {
      const l = secLines[i];
      if (l.startsWith('@@ ')) {
        firstHunkIdx = i;
        break;
      }
      if (l.startsWith('new file mode ')) {
        sawNewFileMode = true;
      } else if (l.startsWith('deleted file mode ')) {
        sawDeletedFileMode = true;
      } else if (l.startsWith('rename from ')) {
        renameFrom = unquoteGitPath(l.slice('rename from '.length));
      } else if (l.startsWith('rename to ')) {
        renameTo = unquoteGitPath(l.slice('rename to '.length));
      } else if (l.startsWith('--- ')) {
        const p = stripDiffPrefix(l.slice(4));
        if (p === '/dev/null') {
          sawNewFileMode = true;
        } else {
          oldPath = p;
        }
      } else if (l.startsWith('+++ ')) {
        const p = stripDiffPrefix(l.slice(4));
        if (p === '/dev/null') {
          sawDeletedFileMode = true;
        } else {
          newPath = p;
        }
      } else if (l.startsWith('Binary files ') || l === 'GIT binary patch') {
        isBinary = true;
      }
    }

    if (renameFrom && renameTo) {
      status = 'R';
      oldPath = renameFrom;
      newPath = renameTo;
    } else if (sawNewFileMode) {
      status = 'A';
      oldPath = null;
    } else if (sawDeletedFileMode) {
      status = 'D';
    } else {
      status = 'M';
    }

    const displayPath = status === 'D' ? (oldPath || newPath || '') : (newPath || oldPath || '');
    if (!displayPath) continue;

    const noiseReason = classifyNoiseFile(displayPath);
    if (noiseReason) {
      skippedFiles.push({ path: displayPath, status, reason: noiseReason, bytes: secBytes });
      continue;
    }
    if (isBinary) {
      skippedFiles.push({ path: displayPath, status, reason: 'binary', bytes: secBytes });
      continue;
    }
    if (secBytes > MAX_SINGLE_FILE_DIFF_BYTES) {
      skippedFiles.push({ path: displayPath, status, reason: 'oversized_diff', bytes: secBytes });
      continue;
    }
    if (usedBytes + secBytes > maxDiffBytes) {
      truncated = true;
      skippedFiles.push({ path: displayPath, status, reason: 'oversized_diff', bytes: secBytes });
      continue;
    }

    usedBytes += secBytes;

    const hunks = [];
    let additions = 0;
    let deletions = 0;
    let addedBytes = 0;
    let curHunk = null;
    let curNewLine = 0;

    for (let i = firstHunkIdx; i < secLines.length; i++) {
      const l = secLines[i];
      if (l.startsWith('@@ ')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
        if (m) {
          if (curHunk) {
            curHunk.contextPatch = curHunk._patchLines.join('\n');
            delete curHunk._patchLines;
            hunks.push(curHunk);
          }
          const newStart = Number(m[3]);
          const newLines = m[4] === undefined ? 1 : Number(m[4]);
          curNewLine = newStart;
          curHunk = {
            header: l,
            newStart,
            newLines,
            addedLines: [],
            _patchLines: [l],
          };
          continue;
        }
      }
      if (!curHunk) continue;

      if (l.startsWith('+')) {
        const content = l.slice(1);
        curHunk.addedLines.push({ line: curNewLine, content });
        curHunk._patchLines.push(formatPatchLine('+', curNewLine, content));
        additions++;
        addedBytes += Buffer.byteLength(content, 'utf8') + 1;
        curNewLine++;
      } else if (l.startsWith('-')) {
        const content = l.slice(1);
        curHunk._patchLines.push(formatPatchLine('-', 0, content));
        deletions++;
      } else if (l.startsWith(' ')) {
        const content = l.slice(1);
        curHunk._patchLines.push(formatPatchLine(' ', curNewLine, content));
        curNewLine++;
      } else if (l.startsWith('\\ No newline at end of file')) {
        // Metadata line: do not advance line counters
      }
    }

    if (curHunk) {
      curHunk.contextPatch = curHunk._patchLines.join('\n');
      delete curHunk._patchLines;
      hunks.push(curHunk);
    }

    files.push({
      path: displayPath,
      oldPath: status === 'R' ? oldPath : (status === 'A' ? null : oldPath),
      status,
      additions,
      deletions,
      bytes: status === 'A' ? addedBytes : secBytes,
      lineCount: status === 'A' ? additions : 0,
      hunks,
    });
  }

  return { files, skippedFiles, truncated, totalDiffBytes };
}

function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function splitFileLines(text) {
  if (!text) return [];
  const raw = text.split(/\r?\n/);
  if (raw.length > 0 && raw[raw.length - 1] === '') {
    raw.pop();
  }
  return raw;
}

async function collectUntrackedFiles(repoRoot, existingPaths, skippedFiles, { remainingBudget }) {
  const res = await execGit(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot, {
    encoding: 'utf8',
    allowFail: true,
  });
  if (!res.ok || !res.stdout) {
    return { files: [], bytesAdded: 0, truncated: false };
  }

  const relPaths = res.stdout
    .split('\0')
    .map((p) => p.replace(/\\/g, '/').trim())
    .filter(Boolean);

  const syntheticFiles = [];
  let bytesAdded = 0;
  let truncated = false;

  for (const rel of relPaths) {
    if (existingPaths.has(rel.toLowerCase())) continue;

    const fullPath = path.resolve(repoRoot, rel);
    if (!isPathInsideRoot(fullPath, repoRoot)) continue;

    let st;
    try {
      st = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;

    const noiseReason = classifyNoiseFile(rel);
    if (noiseReason) {
      skippedFiles.push({ path: rel, status: 'A', reason: noiseReason, bytes: st.size });
      continue;
    }

    if (st.size > MAX_UNTRACKED_SYNTHETIC_BYTES) {
      skippedFiles.push({ path: rel, status: 'A', reason: 'oversized_diff', bytes: st.size });
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(fullPath);
    } catch {
      continue;
    }

    if (isBinaryBuffer(buf)) {
      skippedFiles.push({ path: rel, status: 'A', reason: 'binary', bytes: st.size });
      continue;
    }

    if (bytesAdded + st.size > remainingBudget) {
      truncated = true;
      skippedFiles.push({ path: rel, status: 'A', reason: 'oversized_diff', bytes: st.size });
      continue;
    }

    const text = buf.toString('utf8');
    const lines = splitFileLines(text);
    const header = `@@ -0,0 +1,${lines.length} @@`;
    const addedLines = lines.map((content, idx) => ({ line: idx + 1, content }));
    const patchLines = [header, ...addedLines.map((l) => formatPatchLine('+', l.line, l.content))];

    bytesAdded += st.size;
    syntheticFiles.push({
      path: rel,
      oldPath: null,
      status: 'A',
      additions: lines.length,
      deletions: 0,
      bytes: st.size,
      lineCount: lines.length,
      untracked: true,
      hunks: [
        {
          header,
          newStart: 1,
          newLines: lines.length,
          addedLines,
          contextPatch: patchLines.join('\n'),
        },
      ],
    });
  }

  return { files: syntheticFiles, bytesAdded, truncated };
}

async function resolveBranchBaseRef(repoRoot, explicitBaseRef) {
  if (explicitBaseRef !== undefined && explicitBaseRef !== null && String(explicitBaseRef).trim() !== '') {
    return validateBaseRef(String(explicitBaseRef));
  }

  // Auto-detect origin/HEAD -> main -> master -> origin/main -> origin/master
  const sym = await execGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoRoot, {
    allowFail: true,
  });
  if (sym.ok && sym.stdout.trim()) {
    const candidate = sym.stdout.trim();
    if (SAFE_BASE_REF_RE.test(candidate) && !candidate.startsWith('-')) {
      const verify = await execGit(['rev-parse', '--verify', candidate], repoRoot, { allowFail: true });
      if (verify.ok) return candidate;
    }
  }

  for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
    const verify = await execGit(['rev-parse', '--verify', candidate], repoRoot, { allowFail: true });
    if (verify.ok) return candidate;
  }

  throw new Error('Unable to auto-detect base branch (origin/HEAD, main, or master); please specify baseRef');
}

/**
 * Collect strictly read-only Git diff across 4 supported review scopes:
 * - uncommitted (HEAD diff + synthetic untracked small files; unborn-safe)
 * - staged (--cached)
 * - last_commit (HEAD~1..HEAD or git show HEAD for initial commit)
 * - branch (<safeBase>...HEAD with strict baseRef injection protection)
 */
export async function collectGitDiff({
  projectDir,
  scope = 'uncommitted',
  baseRef,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
} = {}) {
  const normalizedScope = String(scope || 'uncommitted').trim();
  if (!VALID_REVIEW_SCOPES.includes(normalizedScope)) {
    throw new Error(`Unsupported review scope: ${normalizedScope}`);
  }

  // Validate explicit baseRef up front even before touching git, so malicious inputs are always rejected.
  let validatedBaseRef = null;
  if (normalizedScope === 'branch' && baseRef !== undefined && baseRef !== null && String(baseRef).trim() !== '') {
    validatedBaseRef = validateBaseRef(String(baseRef));
  } else if (baseRef !== undefined && baseRef !== null && String(baseRef).trim() !== '') {
    validateBaseRef(String(baseRef));
  }

  const resolvedDir = projectDir ? path.resolve(projectDir) : process.cwd();
  const git = getGitContext(resolvedDir);

  if (!git.isGitRepo) {
    return {
      isGitRepo: false,
      repoRoot: resolvedDir,
      scope: normalizedScope,
      baseRef: validatedBaseRef,
      git,
      files: [],
      skippedFiles: [],
      truncated: false,
      stats: {
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        skippedCount: 0,
        totalDiffBytes: 0,
      },
    };
  }

  const repoRoot = git.repoRoot;
  const budget = Math.max(64 * 1024, Math.floor(Number(maxDiffBytes) || DEFAULT_MAX_DIFF_BYTES));

  const headCheck = await execGit(['rev-parse', '--verify', 'HEAD'], repoRoot, { allowFail: true });
  const hasHead = headCheck.ok;

  let rawDiff = '';
  let resolvedBaseRef = validatedBaseRef;

  if (normalizedScope === 'uncommitted') {
    const args = hasHead
      ? ['diff', '--no-color', '--unified=3', 'HEAD', '--']
      : ['diff', '--no-color', '--unified=3', '--cached', '--'];
    const diffRes = await execGit(args, repoRoot, { allowFail: true });
    rawDiff = diffRes.ok ? diffRes.stdout : '';
  } else if (normalizedScope === 'staged') {
    const diffRes = await execGit(['diff', '--no-color', '--unified=3', '--cached', '--'], repoRoot, {
      allowFail: true,
    });
    rawDiff = diffRes.ok ? diffRes.stdout : '';
  } else if (normalizedScope === 'last_commit') {
    if (hasHead) {
      const parentCheck = await execGit(['rev-parse', '--verify', 'HEAD~1'], repoRoot, { allowFail: true });
      const args = parentCheck.ok
        ? ['diff', '--no-color', '--unified=3', 'HEAD~1', 'HEAD', '--']
        : ['show', '--no-color', '--unified=3', '--format=', 'HEAD'];
      const diffRes = await execGit(args, repoRoot, { allowFail: true });
      rawDiff = diffRes.ok ? diffRes.stdout : '';
    }
  } else if (normalizedScope === 'branch') {
    resolvedBaseRef = validatedBaseRef || (await resolveBranchBaseRef(repoRoot, null));
    if (hasHead) {
      const diffRes = await execGit(
        ['diff', '--no-color', '--unified=3', `${resolvedBaseRef}...HEAD`, '--'],
        repoRoot,
        { allowFail: false }
      );
      rawDiff = diffRes.stdout || '';
    }
  }

  const parsed = parseUnifiedDiff(rawDiff, { maxDiffBytes: budget });
  const files = [...parsed.files];
  const skippedFiles = [...parsed.skippedFiles];
  let truncated = parsed.truncated;
  let totalDiffBytes = parsed.totalDiffBytes;

  if (normalizedScope === 'uncommitted') {
    const existing = new Set([
      ...files.map((f) => f.path.toLowerCase()),
      ...skippedFiles.map((f) => f.path.toLowerCase()),
    ]);
    const remainingBudget = Math.max(0, budget - totalDiffBytes);
    const untracked = await collectUntrackedFiles(repoRoot, existing, skippedFiles, { remainingBudget });
    files.push(...untracked.files);
    totalDiffBytes += untracked.bytesAdded;
    if (untracked.truncated) truncated = true;
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    isGitRepo: true,
    repoRoot,
    scope: normalizedScope,
    baseRef: resolvedBaseRef,
    git,
    files,
    skippedFiles,
    truncated,
    stats: {
      filesChanged: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      skippedCount: skippedFiles.length,
      totalDiffBytes,
    },
  };
}
