import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createLruCache, safeStatSig } from './fs-utils.mjs';

const GIT_CTX_TTL_MS = 12_000;
const COMMITS_AHEAD_TTL_MS = 60_000;

const gitContextCache = createLruCache(64);
const commitsAheadCache = createLruCache(256);

let gitSpawnMetricsCount = 0;

export function clearGitContextCache() {
  gitContextCache.clear();
  commitsAheadCache.clear();
}

export function getGitSpawnCount() {
  return gitSpawnMetricsCount;
}

export function resetGitSpawnCount() {
  gitSpawnMetricsCount = 0;
}

/**
 * Pure filesystem walk upward to locate `.git` (supports normal repos and Git worktree pointer files).
 * Zero child processes spawned.
 */
function findGitRootAndDir(startDir) {
  let cur = path.resolve(startDir);
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const dotGit = path.join(cur, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) {
        return { repoRoot: cur, gitDir: dotGit, commonDir: dotGit };
      }
      if (st.isFile()) {
        const content = fs.readFileSync(dotGit, 'utf8').trim();
        const m = /^gitdir:\s*(.+)$/im.exec(content);
        if (m && m[1]) {
          const gitDir = path.resolve(cur, m[1].trim());
          let commonDir = gitDir;
          const commonDirFile = path.join(gitDir, 'commondir');
          try {
            if (fs.existsSync(commonDirFile)) {
              const relCommon = fs.readFileSync(commonDirFile, 'utf8').trim();
              if (relCommon) {
                commonDir = path.resolve(gitDir, relCommon);
              }
            }
          } catch {
            // fallback to gitDir
          }
          return { repoRoot: cur, gitDir, commonDir };
        }
      }
    } catch {
      // not a git root at this level
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Read `[remote "origin"] url = ...` directly from `.git/config` (or worktree commondir/config).
 * Zero child processes spawned.
 */
function readOriginUrlFromConfig(commonDir, gitDir) {
  const candidates =
    commonDir && commonDir !== gitDir
      ? [path.join(commonDir, 'config'), path.join(gitDir, 'config')]
      : [path.join(gitDir, 'config')];

  for (const cfgPath of candidates) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      let inOrigin = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
        if (trimmed.startsWith('[')) {
          inOrigin = /^\[\s*remote\s+"origin"\s*\]/i.test(trimmed);
          continue;
        }
        if (inOrigin) {
          const m = /^url\s*=\s*(.+)$/i.exec(trimmed);
          if (m && m[1]) {
            return m[1].trim();
          }
        }
      }
    } catch {
      // ignore unreadable config
    }
  }
  return '';
}

function computeGitStateFingerprint(repoRoot) {
  const located = findGitRootAndDir(repoRoot);
  if (!located) return null;
  const { gitDir, commonDir } = located;
  const headPath = path.join(gitDir, 'HEAD');
  const indexPath = path.join(gitDir, 'index');
  const headSig = safeStatSig(headPath);
  const indexSig = safeStatSig(indexPath);

  let headRefSig = '';
  try {
    const headRaw = fs.readFileSync(headPath, 'utf8').trim();
    if (headRaw.startsWith('ref:')) {
      const refRel = headRaw.slice(4).trim();
      const refFile = path.join(commonDir, refRel);
      try {
        headRefSig = fs.readFileSync(refFile, 'utf8').trim();
      } catch {
        const localRefFile = path.join(gitDir, refRel);
        try {
          headRefSig = fs.readFileSync(localRefFile, 'utf8').trim();
        } catch {
          headRefSig = safeStatSig(path.join(commonDir, 'packed-refs'));
        }
      }
    } else {
      headRefSig = headRaw;
    }
  } catch {
    headRefSig = 'err';
  }

  return `${gitDir}|H:${headSig}|I:${indexSig}|R:${headRefSig}`;
}

function runGitReadOnly(args, cwd, execFn = execFileSync) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    gitSpawnMetricsCount++;
    const out = execFn('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

function parsePorcelainV2Branch(rawOutput) {
  let headFull = '';
  let head = 'unborn';
  let branch = 'detached';
  let dirty = false;

  if (typeof rawOutput !== 'string') {
    return { parsed: false, headFull, head, branch, dirty };
  }

  let sawHeader = false;
  for (const line of rawOutput.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# ')) {
      sawHeader = true;
      if (line.startsWith('# branch.oid ')) {
        const oid = line.slice('# branch.oid '.length).trim();
        if (oid && oid !== '(initial)') {
          headFull = oid;
          head = oid.slice(0, 7);
        } else {
          headFull = '';
          head = 'unborn';
        }
      } else if (line.startsWith('# branch.head ')) {
        const bName = line.slice('# branch.head '.length).trim();
        if (bName === '(detached)' || !bName) {
          branch = 'detached';
        } else {
          branch = bName;
        }
      }
    } else {
      dirty = true;
    }
  }

  return { parsed: sawHeader, headFull, head, branch, dirty };
}

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/**
 * Strictly read-only Git context detection.
 * Converges 5 git spawns down to 1 single `git status --porcelain=v2 --branch`
 * by resolving `.git` root/worktree and `[remote "origin"]` directly from the filesystem.
 * Cached in-memory for 12s and invalidated immediately if .git/HEAD, .git/index, or active ref changes.
 */
export function getGitContext(targetDir, options = {}) {
  const resolved = targetDir ? path.resolve(targetDir) : process.cwd();
  const cacheKey = resolved.toLowerCase();
  const now = Date.now();
  const execFn = typeof options._execFileSync === 'function' ? options._execFileSync : execFileSync;

  const cached = gitContextCache.get(cacheKey);
  if (!options.force && cached && now < cached.expiresAt) {
    if (cached.value.isGitRepo) {
      const curFp = computeGitStateFingerprint(cached.value.repoRoot);
      if (curFp && curFp === cached.fingerprint) {
        return cached.value;
      }
    } else {
      const curDirSig = `${safeStatSig(resolved)}|git:${safeStatSig(path.join(resolved, '.git'))}`;
      if (curDirSig === cached.fingerprint) {
        return cached.value;
      }
    }
  }

  // 1. Fast pure-fs `.git` walk (0 git spawns)
  let located = fs.existsSync(resolved) ? findGitRootAndDir(resolved) : null;
  let resolvedRoot = located ? path.resolve(located.repoRoot) : '';

  // Fallback to rev-parse only when GIT_DIR env override is explicitly present
  if (!located && process.env.GIT_DIR) {
    const revRoot = runGitReadOnly(['rev-parse', '--show-toplevel'], resolved, execFn);
    if (revRoot) {
      resolvedRoot = path.resolve(revRoot);
      located = findGitRootAndDir(resolvedRoot) || {
        repoRoot: resolvedRoot,
        gitDir: path.resolve(process.env.GIT_DIR),
        commonDir: path.resolve(process.env.GIT_DIR),
      };
    }
  }

  if (!located || !resolvedRoot) {
    const norm = resolved.replace(/\\/g, '/').toLowerCase();
    const result = {
      isGitRepo: false,
      repoRoot: resolved,
      projectId: shortHash(`dir:${norm}`),
      projectName: path.basename(resolved) || 'workspace',
      branch: 'nogit',
      head: 'none',
      headFull: '',
      dirty: false,
      remoteOrigin: '',
    };
    const fp = `${safeStatSig(resolved)}|git:${safeStatSig(path.join(resolved, '.git'))}`;
    gitContextCache.set(cacheKey, { value: result, fingerprint: fp, expiresAt: now + GIT_CTX_TTL_MS });
    return result;
  }

  // 2. Direct `.git/config` parse for origin URL (0 git spawns)
  const remoteOrigin = readOriginUrlFromConfig(located.commonDir, located.gitDir);

  // 3. Single git subprocess for branch, HEAD OID, and dirty working tree status
  const statusOut = runGitReadOnly(['status', '--porcelain=v2', '--branch'], resolvedRoot, execFn);
  let { parsed, headFull, head, branch, dirty } = parsePorcelainV2Branch(statusOut);

  if (!parsed) {
    // Rare fallback when porcelain=v2 is unavailable
    branch =
      runGitReadOnly(['symbolic-ref', '--short', 'HEAD'], resolvedRoot, execFn) ||
      runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], resolvedRoot, execFn) ||
      'detached';
    headFull = runGitReadOnly(['rev-parse', 'HEAD'], resolvedRoot, execFn) || '';
    head = headFull ? headFull.slice(0, 7) : 'unborn';
    const statusShort = runGitReadOnly(['status', '--porcelain'], resolvedRoot, execFn);
    dirty = Boolean(statusShort && statusShort.length > 0);
  }

  const normOrigin = remoteOrigin
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^https?:\/\/[^@]+@/i, 'https://')
    .toLowerCase();
  const normRoot = resolvedRoot.replace(/\\/g, '/').toLowerCase();
  const fingerprintSource = normOrigin ? `git:${normOrigin}` : `repo:${normRoot}`;

  const result = {
    isGitRepo: true,
    repoRoot: resolvedRoot,
    projectId: shortHash(fingerprintSource),
    projectName: path.basename(resolvedRoot) || 'repo',
    branch,
    head,
    headFull,
    dirty,
    remoteOrigin: normOrigin ? remoteOrigin.replace(/^(https?:\/\/)[^@]+@/i, '$1') : '',
  };

  const fp = computeGitStateFingerprint(resolvedRoot);
  gitContextCache.set(cacheKey, { value: result, fingerprint: fp, expiresAt: now + GIT_CTX_TTL_MS });
  return result;
}

/**
 * Strictly read-only calculation of how many commits current HEAD is ahead of a recorded commit SHA.
 * Returns null if not a git repo, SHAs match, or ancestor relation cannot be established.
 */
export function getCommitsAhead(repoRoot, recordedHead, currentHeadHint = '') {
  if (!repoRoot || !recordedHead || recordedHead === 'none' || recordedHead === 'unborn') return null;
  if (!/^[0-9a-f]{6,40}$/i.test(recordedHead)) return null;

  let current = currentHeadHint && /^[0-9a-f]{6,40}$/i.test(currentHeadHint) ? currentHeadHint.slice(0, 7) : '';
  if (!current) {
    const ctx = getGitContext(repoRoot);
    if (ctx.isGitRepo && ctx.head && ctx.head !== 'unborn' && ctx.head !== 'none') {
      current = ctx.head;
    } else {
      current = runGitReadOnly(['rev-parse', '--short=7', 'HEAD'], repoRoot) || '';
    }
  }
  if (!current) return null;
  if (current.toLowerCase() === recordedHead.slice(0, 7).toLowerCase()) return 0;

  const key = `${path.resolve(repoRoot).toLowerCase()}|${recordedHead.toLowerCase()}|${current.toLowerCase()}`;
  const now = Date.now();
  const cached = commitsAheadCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  const aheadStr = runGitReadOnly(['rev-list', '--count', `${recordedHead}..HEAD`], repoRoot);
  let val = -1;
  if (aheadStr !== null) {
    const n = Number(aheadStr);
    val = Number.isFinite(n) ? n : -1;
  }
  commitsAheadCache.set(key, { value: val, expiresAt: now + COMMITS_AHEAD_TTL_MS });
  return val;
}

function normalizePorcelainStatus(xy) {
  const code = String(xy || '');
  if (code === '??') return '?';
  if (code.includes('A')) return 'A';
  if (code.includes('D')) return 'D';
  if (code.includes('R')) return 'R';
  return 'M';
}

function unquoteGitPath(rawPath) {
  let p = String(rawPath || '').trim();
  if (p.includes(' -> ')) {
    p = p.split(' -> ').pop().trim();
  }
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p.replace(/\\/g, '/');
}

/**
 * Strictly read-only Git working tree summary:
 * - uncommitted changed files (`M`/`A`/`?`/`D`/`R`)
 * - recent N commit subjects (default 2)
 */
export function getGitWorkingSummary(targetDir, { commitLimit = 2, fileLimit = 30 } = {}) {
  const resolved = targetDir ? path.resolve(targetDir) : process.cwd();
  const located = fs.existsSync(resolved) ? findGitRootAndDir(resolved) : null;
  const repoRoot = located ? located.repoRoot : runGitReadOnly(['rev-parse', '--show-toplevel'], resolved);
  if (!repoRoot) {
    return { isGitRepo: false, repoRoot: resolved, changedFiles: [], recentCommits: [] };
  }

  const changedFiles = [];
  try {
    gitSpawnMetricsCount++;
    const rawStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const seen = new Set();
    for (const line of String(rawStatus || '').split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const xy = line.slice(0, 2);
      const rel = unquoteGitPath(line.slice(3));
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      changedFiles.push({
        path: rel,
        status: normalizePorcelainStatus(xy),
      });
      if (changedFiles.length >= fileLimit) break;
    }
  } catch {
    // fail open
  }

  const recentCommits = [];
  const limit = Math.max(0, Math.min(10, Number(commitLimit) || 2));
  if (limit > 0) {
    const rawLog = runGitReadOnly(['log', '-n', String(limit), '--pretty=format:%h%x09%s'], repoRoot);
    if (rawLog) {
      for (const line of rawLog.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx === -1) continue;
        const sha = line.slice(0, tabIdx).trim();
        const subject = line.slice(tabIdx + 1).trim();
        if (sha && subject) {
          recentCommits.push({ sha, subject });
        }
      }
    }
  }

  return {
    isGitRepo: true,
    repoRoot: path.resolve(repoRoot),
    changedFiles,
    recentCommits,
  };
}
