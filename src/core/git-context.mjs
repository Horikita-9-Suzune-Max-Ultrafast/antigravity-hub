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
