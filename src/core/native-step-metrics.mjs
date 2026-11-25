import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCandidateAppDataDirs } from './paths.mjs';

const MIN_VALID_EPOCH_MS = 1_600_000_000_000; // ~2020-09
const MAX_VALID_EPOCH_MS = 2_500_000_000_000; // ~2049-03
const MAX_TTFT_MS = 300_000;
const MAX_MODEL_DURATION_MS = 600_000;
const MAX_CACHE_ENTRIES = 32;

const nativeMetricsCache = new Map(); // normDbPath -> { sig, map }

export function clearNativeStepMetricsCache() {
  nativeMetricsCache.clear();
}

function safeStatSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

function lruSet(map, key, val) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Locate Antigravity's read-only local conversation SQLite DB (<appDataDir>/conversations/<id>.db).
 */
export function findNativeConversationDbPath(conversationId, options = {}) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const safeId = path.basename(conversationId);
  if (!safeId || safeId === '.' || safeId === '..') return null;

  for (const appDir of getCandidateAppDataDirs(options)) {
    const dbPath = path.join(appDir, 'conversations', `${safeId}.db`);
    if (fs.existsSync(dbPath)) return dbPath;
  }
  return null;
}

/**
 * Return a cheap stat signature covering both <id>.db and <id>.db-wal so callers know when metrics changed.
 */
export function getNativeDbSignature(conversationId, options = {}) {
  const dbPath = findNativeConversationDbPath(conversationId, options);
  if (!dbPath) return '-';
  return `${safeStatSig(dbPath)}|${safeStatSig(`${dbPath}-wal`)}`;
}

// ==================== Zero-Dep Protobuf Wire Reader ====================

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let off = offset;
  while (off < buf.length) {
    const b = buf[off++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [result, off];
    }
    shift += 7n;
    if (shift > 64n) return [null, buf.length];
  }
  return [null, buf.length];
}

function parseProtoFields(buf) {
  const fields = {};
  let off = 0;
  while (off < buf.length) {
    const [tag, o1] = decodeVarint(buf, off);
    if (tag === null) return null;
    off = o1;
    const fieldNum = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNum <= 0 || fieldNum > 10_000) return null;

    if (wire === 0) {
      const [val, o2] = decodeVarint(buf, off);
      if (val === null) return null;
      off = o2;
      const numVal = val <= 9007199254740991n ? Number(val) : Number(val);
      (fields[fieldNum] ||= []).push(numVal);
    } else if (wire === 1) {
      if (off + 8 > buf.length) return null;
      off += 8;
    } else if (wire === 2) {
      const [lenBig, o2] = decodeVarint(buf, off);
      if (lenBig === null) return null;
      const len = Number(lenBig);
      if (len < 0 || o2 + len > buf.length) return null;
      const sub = buf.subarray(o2, o2 + len);
      off = o2 + len;
      (fields[fieldNum] ||= []).push(sub);
    } else if (wire === 5) {
      if (off + 4 > buf.length) return null;
      off += 4;
    } else {
      return null;
    }
  }
  return fields;
}

function parseProtoTimestampMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const msg = parseProtoFields(buf);
  if (!msg) return null;
  const seconds = msg[1]?.[0];
  const nanos = msg[2]?.[0] ?? 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  if (nanos < 0 || nanos >= 1_000_000_000) return null;
  const ms = seconds * 1000 + nanos / 1_000_000;
  if (ms < MIN_VALID_EPOCH_MS || ms > MAX_VALID_EPOCH_MS) return null;
  return ms;
}

/**
 * Parse a single Antigravity `steps.metadata` protobuf blob into validated timing + exact token split.
 * Strictly self-validating & fail-open: returns null if any invariant fails (immune to future schema drift).
 */
export function parseNativeStepMetadataBlob(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 8) return null;

  const root = parseProtoFields(buf);
  if (!root) return null;

  const createdAtMs = parseProtoTimestampMs(root[1]?.[0]);
  const firstTokenAtMs = parseProtoTimestampMs(root[6]?.[0]);
  const completedAtMs = parseProtoTimestampMs(root[7]?.[0]) ?? parseProtoTimestampMs(root[8]?.[0]);

  let ttftMs = null;
  let modelDurationMs = null;
  let decodeDurationMs = null;

  if (createdAtMs != null && completedAtMs != null) {
    const total = completedAtMs - createdAtMs;
    if (total >= 50 && total <= MAX_MODEL_DURATION_MS) {
      modelDurationMs = Number(total.toFixed(1));
      if (firstTokenAtMs != null) {
        const ttft = firstTokenAtMs - createdAtMs;
        const decode = completedAtMs - firstTokenAtMs;
        if (ttft >= 10 && ttft <= MAX_TTFT_MS && decode >= -5 && ttft <= total + 5) {
          ttftMs = Number(ttft.toFixed(1));
          decodeDurationMs = Number(Math.max(0, decode).toFixed(1));
        }
      }
    }
  }

  let thinkingTokens = null;
  let contentTokens = null;
  const usageBuf = root[9]?.[0];
  if (Buffer.isBuffer(usageBuf)) {
    const u = parseProtoFields(usageBuf);
    if (u) {
      const outTok = u[3]?.[0];
      const thinkTok = u[9]?.[0];
      const contentTok = u[10]?.[0];
      if (
        Number.isFinite(outTok) &&
        outTok > 0 &&
        Number.isFinite(thinkTok) &&
        Number.isFinite(contentTok) &&
        thinkTok >= 0 &&
        contentTok >= 0 &&
        thinkTok + contentTok === outTok
      ) {
        thinkingTokens = thinkTok;
        contentTokens = contentTok;
      }
    }
  }

  if (modelDurationMs == null && thinkingTokens == null) return null;
  return {
    createdAtMs,
    firstTokenAtMs,
    completedAtMs,
    ttftMs,
    modelDurationMs,
    decodeDurationMs,
    thinkingTokens,
    contentTokens,
  };
}

/**
 * Load per-step native millisecond TTFT, pure model duration, and exact thinking/content token split
 * from Antigravity's local read-only SQLite conversation store.
 * Fail-open: returns an empty Map on missing DB, lock contention, or unknown format.
 */
export function loadNativeStepMetrics(conversationId, options = {}) {
  const dbPath = findNativeConversationDbPath(conversationId, options);
  if (!dbPath) return new Map();

  const key = process.platform === 'win32' ? path.resolve(dbPath).toLowerCase() : path.resolve(dbPath);
  const sig = `${safeStatSig(dbPath)}|${safeStatSig(`${dbPath}-wal`)}`;
  const cached = nativeMetricsCache.get(key);
  if (cached && cached.sig === sig) {
    return cached.map;
  }

  const map = new Map();
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 500;');
    const rows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL').all();
    for (const row of rows) {
      if (row == null || !Number.isFinite(Number(row.idx)) || !row.metadata) continue;
      const parsed = parseNativeStepMetadataBlob(row.metadata);
      if (parsed) {
        map.set(Number(row.idx), parsed);
      }
    }
    lruSet(nativeMetricsCache, key, { sig, map });
  } catch {
    // Strictly fail-open: never block telemetry when host DB is absent, locked, or changed
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return map;
}
