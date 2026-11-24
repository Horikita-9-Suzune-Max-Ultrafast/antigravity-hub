import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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
 */
export function getGitContext(targetDir) {
  const resolved = targetDir ? path.resolve(targetDir) : process.cwd();
  const repoRoot = runGitReadOnly(['rev-parse', '--show-toplevel'], resolved);

  if (!repoRoot) {
    const norm = resolved.replace(/\\/g, '/').toLowerCase();
    return {
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
  }

  const remoteOrigin = runGitReadOnly(['config', '--get', 'remote.origin.url'], repoRoot) || '';
  const branch =
    runGitReadOnly(['symbolic-ref', '--short', 'HEAD'], repoRoot) ||
    runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) ||
    'detached';
  const headFull = runGitReadOnly(['rev-parse', 'HEAD'], repoRoot) || '';
  const head = headFull ? headFull.slice(0, 7) : 'unborn';
  const statusShort = runGitReadOnly(['status', '--porcelain'], repoRoot);
  const dirty = Boolean(statusShort && statusShort.length > 0);

  const normOrigin = remoteOrigin
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^https?:\/\/[^@]+@/i, 'https://')
    .toLowerCase();
  const normRoot = path.resolve(repoRoot).replace(/\\/g, '/').toLowerCase();
  const fingerprintSource = normOrigin ? `git:${normOrigin}` : `repo:${normRoot}`;

  return {
    isGitRepo: true,
    repoRoot: path.resolve(repoRoot),
    projectId: shortHash(fingerprintSource),
    projectName: path.basename(repoRoot) || 'repo',
    branch,
    head,
    headFull,
    dirty,
    remoteOrigin: normOrigin ? remoteOrigin.replace(/^(https?:\/\/)[^@]+@/i, '$1') : '',
  };
}

/**
 * Strictly read-only calculation of how many commits current HEAD is ahead of a recorded commit SHA.
 * Returns null if not a git repo, SHAs match, or ancestor relation cannot be established.
 */
export function getCommitsAhead(repoRoot, recordedHead) {
  if (!repoRoot || !recordedHead || recordedHead === 'none' || recordedHead === 'unborn') return null;
  if (!/^[0-9a-f]{6,40}$/i.test(recordedHead)) return null;
  const current = runGitReadOnly(['rev-parse', '--short=7', 'HEAD'], repoRoot);
  if (!current) return null;
  if (current.toLowerCase() === recordedHead.slice(0, 7).toLowerCase()) return 0;

  const aheadStr = runGitReadOnly(['rev-list', '--count', `${recordedHead}..HEAD`], repoRoot);
  if (aheadStr === null) return -1; // diverged or unknown commit
  const n = Number(aheadStr);
  return Number.isFinite(n) ? n : -1;
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
