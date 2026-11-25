import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { formatDisplayPath } from './paths.mjs';
import { redactText } from './redact.mjs';

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, Math.round(ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback busy wait if Atomics.wait is unavailable
    }
  }
}

function estimatePreviewTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.max(1, Math.ceil(cjk * 0.9 + ascii / 3.8));
}

/**
 * Lightweight file stat signature (`${mtimeMs}:${size}`), or `'-'` if missing/unreadable.
 */
export function safeStatSig(filePath) {
  if (!filePath || typeof filePath !== 'string') return '-';
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

/**
 * Bounded-capacity LRU cache backed by Map insertion order.
 */
export function createLruCache(maxEntries = 64) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 64));
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const val = map.get(key);
      map.delete(key);
      map.set(key, val);
      return val;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Resolve canonical filesystem path (handles Windows 8.3 short paths and symlinks).
 * Falls back to `path.resolve` if the target does not yet exist.
 */
export function safeRealpath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(resolved);
    }
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizePathForCompare(p) {
  const normalized = path.resolve(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(target, root) {
  const t = normalizePathForCompare(target);
  const r = normalizePathForCompare(root);
  if (t === r) return true;
  const prefix = r.endsWith(path.sep) ? r : `${r}${path.sep}`;
  return t.startsWith(prefix);
}

/**
 * Strict containment check validating both logical path and resolved realpath
 * to prevent directory prefix collisions and symlink escapes.
 */
export function isPathInsideRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath || typeof targetPath !== 'string' || typeof rootPath !== 'string') {
    return false;
  }
  if (targetPath.includes('\0') || rootPath.includes('\0')) {
    return false;
  }
  const logicalTarget = path.resolve(targetPath);
  const logicalRoot = path.resolve(rootPath);
  if (!isContained(logicalTarget, logicalRoot)) {
    return false;
  }
  const realTarget = safeRealpath(logicalTarget);
  const realRoot = safeRealpath(logicalRoot);
  return isContained(realTarget, realRoot);
}

const RETRYABLE_WIN_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_BACKOFF_MS = [15, 40, 80];

/**
 * Windows EPERM/EBUSY-resilient atomic file writer with optional read-back verify,
 * exponential backoff retries on rename, and copyFileSync fallback.
 */
export function atomicWriteFileSafe(filePath, content, options = {}) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const isBuf = Buffer.isBuffer(content);
  const payload = isBuf ? content : String(content ?? '');
  const expectedBytes = isBuf ? payload.length : Buffer.byteLength(payload, 'utf8');
  const tmpName = `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  try {
    if (isBuf) {
      fs.writeFileSync(tmpPath, payload);
    } else {
      fs.writeFileSync(tmpPath, payload, 'utf8');
    }

    if (options.verify) {
      const writtenSize = fs.statSync(tmpPath).size;
      if (writtenSize !== expectedBytes) {
        throw new Error(`Atomic write verification failed for ${target}: expected ${expectedBytes} bytes, got ${writtenSize}`);
      }
    }

    let renamed = false;
    let lastErr = null;
    for (let attempt = 0; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
      try {
        fs.renameSync(tmpPath, target);
        renamed = true;
        break;
      } catch (err) {
        lastErr = err;
        if (!RETRYABLE_WIN_CODES.has(err?.code) || attempt === RENAME_BACKOFF_MS.length) {
          break;
        }
        sleepSync(RENAME_BACKOFF_MS[attempt]);
      }
    }

    if (!renamed) {
      try {
        fs.copyFileSync(tmpPath, target);
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore temp cleanup failure after successful copy
        }
      } catch (copyErr) {
        throw lastErr || copyErr;
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function atomicWriteJsonObj(filePath, data) {
  atomicWriteFileSafe(filePath, JSON.stringify(data, null, 2) + '\n');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means process exists but owned by another user
    return err?.code === 'EPERM';
  }
}

function isLockStale(lockPath, staleMs) {
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > staleMs) {
      return true;
    }
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (raw) {
      try {
        const meta = JSON.parse(raw);
        if (meta && Number.isInteger(meta.pid) && meta.pid !== process.pid && !isPidAlive(meta.pid)) {
          return true;
        }
      } catch {
        // Non-JSON lock content: rely on mtime check above
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Cross-process advisory file lock using O_CREAT | O_EXCL (`wx`) on `<target>.lock`,
 * with PID liveness probing and automatic stale lock recovery.
 */
export function withFileLockSync(lockTargetFile, fn, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 2500);
  const staleMs = Math.max(1000, Number(options.staleMs) || 10_000);
  const target = path.resolve(lockTargetFile);
  const lockPath = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let fd = null;
  let acquired = false;

  while (!acquired) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);
      fd = null;
      acquired = true;
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
      }
      if (err?.code !== 'EEXIST' && !RETRYABLE_WIN_CODES.has(err?.code)) {
        throw err;
      }
      if (isLockStale(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have already broken or re-acquired it
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      sleepSync(15);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore lock removal error
    }
  }
}

export const BLOCKED_SECRET_FILE_RE = /^(?:\.env(?:\..+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|kdbx|keystore)|\.npmrc|\.pypirc|\.netrc|credentials\.json)$/i;

/**
 * Unified read-only redacted file preview enforcing authorized roots,
 * null-byte checks, symlink escape protection, and secret filename blocking.
 */
export function previewAuthorizedFile({ filePath, allowedRoots = [], maxChars = 24000 } = {}) {
  if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error('无效的目标文件路径');
  }
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter((r) => typeof r === 'string' && r.trim()) : [];
  if (roots.length === 0 || !roots.some((root) => isPathInsideRoot(filePath, root))) {
    throw new Error('拒绝预览超出工作区或 Antigravity 配置边界的文件');
  }

  const resolved = path.resolve(filePath);
  const name = path.basename(resolved);
  if (BLOCKED_SECRET_FILE_RE.test(name)) {
    throw new Error(`出于安全策略拒绝预览敏感凭据文件：${name}`);
  }

  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error('目标文件不存在');
  }
  if (!st.isFile()) {
    throw new Error('目标路径不是常规文件');
  }

  const realTarget = safeRealpath(resolved);
  if (!roots.some((root) => isPathInsideRoot(realTarget, root))) {
    throw new Error('拒绝预览符号链接逃逸出授权边界的文件');
  }

  const raw = fs.readFileSync(realTarget, 'utf8');
  const limit = Math.max(256, Math.floor(Number(maxChars) || 24000));
  const truncated = raw.length > limit;
  const content = redactText(truncated ? raw.slice(0, limit) : raw);
  const lines = raw ? raw.split(/\r?\n/).length : 0;

  return {
    filePath: resolved,
    displayPath: formatDisplayPath(resolved),
    name,
    bytes: Buffer.byteLength(raw, 'utf8'),
    lines,
    tokens: estimatePreviewTokens(raw),
    truncated,
    redacted: true,
    content,
  };
}
