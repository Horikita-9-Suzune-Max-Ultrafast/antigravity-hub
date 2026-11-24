import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const GIT_CTX_TTL_MS = 12_000;
const GIT_CTX_MAX_ENTRIES = 64;
const COMMITS_AHEAD_TTL_MS = 60_000;
const COMMITS_AHEAD_MAX_ENTRIES = 256;

const gitContextCache = new Map();
const commitsAheadCache = new Map();

export function clearGitContextCache() {
  gitContextCache.clear();
  commitsAheadCache.clear();
}

function lruSet(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function safeStatSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

function resolveGitDir(repoRoot) {
  const dotGit = path.join(repoRoot, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/im.exec(content);
      if (m && m[1]) {
        return path.resolve(repoRoot, m[1].trim());
      }
    }
  } catch {
    // not a git root directly
  }
  return null;
}

function computeGitStateFingerprint(repoRoot) {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;
  const headPath = path.join(gitDir, 'HEAD');
  const indexPath = path.join(gitDir, 'index');
  const headSig = safeStatSig(headPath);
  const indexSig = safeStatSig(indexPath);

  // Also capture current branch ref target SHA (fast 41-byte read) so commits
  // advancing refs/heads/<branch> invalidate immediately even if .git/HEAD mtime is unchanged.
  let headRefSig = '';
  try {
    const headRaw = fs.readFileSync(headPath, 'utf8').trim();
    if (headRaw.startsWith('ref:')) {
      const refRel = headRaw.slice(4).trim();
      const refFile = path.join(gitDir, refRel);
      try {
        headRefSig = fs.readFileSync(refFile, 'utf8').trim();
      } catch {
        headRefSig = safeStatSig(path.join(gitDir, 'packed-refs'));
      }
    } else {
      headRefSig = headRaw;
    }
  } catch {
    headRefSig = 'err';
  }

  return `${gitDir}|H:${headSig}|I:${indexSig}|R:${headRefSig}`;
}

function runGitReadOnly(args, cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    const out = execFileSync('git', args, {
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

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/**
 * Strictly read-only Git context detection.
 * Never writes or mutates any file in the target workspace/repository.
 * Cached in-memory for 12s and invalidated immediately if .git/HEAD, .git/index, or active ref changes.
 */
export function getGitContext(targetDir) {
  const resolved = targetDir ? path.resolve(targetDir) : process.cwd();
  const cacheKey = resolved.toLowerCase();
  const now = Date.now();

  const cached = gitContextCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    if (cached.value.isGitRepo) {
      const curFp = computeGitStateFingerprint(cached.value.repoRoot);
      if (curFp && curFp === cached.fingerprint) {
        lruSet(gitContextCache, cacheKey, cached, GIT_CTX_MAX_ENTRIES);
        return cached.value;
      }
    } else {
      const curDirSig = `${safeStatSig(resolved)}|git:${safeStatSig(path.join(resolved, '.git'))}`;
      if (curDirSig === cached.fingerprint) {
        lruSet(gitContextCache, cacheKey, cached, GIT_CTX_MAX_ENTRIES);
        return cached.value;
      }
    }
  }

  const repoRoot = runGitReadOnly(['rev-parse', '--show-toplevel'], resolved);

  if (!repoRoot) {
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
    lruSet(gitContextCache, cacheKey, { value: result, fingerprint: fp, expiresAt: now + GIT_CTX_TTL_MS }, GIT_CTX_MAX_ENTRIES);
    return result;
  }

  const resolvedRoot = path.resolve(repoRoot);
  const remoteOrigin = runGitReadOnly(['config', '--get', 'remote.origin.url'], resolvedRoot) || '';
  const branch =
    runGitReadOnly(['symbolic-ref', '--short', 'HEAD'], resolvedRoot) ||
    runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], resolvedRoot) ||
    'detached';
  const headFull = runGitReadOnly(['rev-parse', 'HEAD'], resolvedRoot) || '';
  const head = headFull ? headFull.slice(0, 7) : 'unborn';
  const statusShort = runGitReadOnly(['status', '--porcelain'], resolvedRoot);
  const dirty = Boolean(statusShort && statusShort.length > 0);

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
  lruSet(gitContextCache, cacheKey, { value: result, fingerprint: fp, expiresAt: now + GIT_CTX_TTL_MS }, GIT_CTX_MAX_ENTRIES);
  return result;
}

/**
 * Strictly read-only calculation of how many commits current HEAD is ahead of a recorded commit SHA.
 * Returns null if not a git repo, SHAs match, or ancestor relation cannot be established.
 * Deduplicated and cached by (repoRoot, recordedHead, currentHead).
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
    lruSet(commitsAheadCache, key, cached, COMMITS_AHEAD_MAX_ENTRIES);
    return cached.value;
  }

  const aheadStr = runGitReadOnly(['rev-list', '--count', `${recordedHead}..HEAD`], repoRoot);
  let val = -1;
  if (aheadStr !== null) {
    const n = Number(aheadStr);
    val = Number.isFinite(n) ? n : -1;
  }
  lruSet(commitsAheadCache, key, { value: val, expiresAt: now + COMMITS_AHEAD_TTL_MS }, COMMITS_AHEAD_MAX_ENTRIES);
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
  const repoRoot = runGitReadOnly(['rev-parse', '--show-toplevel'], resolved);
  if (!repoRoot) {
    return { isGitRepo: false, repoRoot: resolved, changedFiles: [], recentCommits: [] };
  }

  const changedFiles = [];
  try {
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
    const rawLog = runGitReadOnly(['log', `-n`, String(limit), '--pretty=format:%h%x09%s'], repoRoot);
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
