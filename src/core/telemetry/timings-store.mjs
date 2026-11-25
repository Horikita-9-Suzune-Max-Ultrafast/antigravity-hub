import fs from 'node:fs';
import path from 'node:path';
import { createLruCache, safeStatSig } from '../fs-utils.mjs';
import { atomicWriteFile, appendJsonl, ensureDataDirs, readJsonSafe } from '../storage.mjs';

const TIMINGS_COMPACT_MAX_LINES = 500;
const TIMINGS_COMPACT_SIZE_HINT = 32_768;
const HOOK_MATCH_WINDOW_MS = 5_000;

const timingsMapCache = createLruCache(16);
const reportInvalidators = new Set();

export function registerTimingsInvalidator(fn) {
  if (typeof fn === 'function') reportInvalidators.add(fn);
}

export function clearTimingsCache() {
  timingsMapCache.clear();
}

export function getTimingsLogPath(paths) {
  return paths.timingsFile.replace(/\.json$/i, '.jsonl');
}

function applyTimingEvent(map, convId, ev) {
  if (!convId) return null;
  const entry = map[convId] || { pendingPreMs: null, pendingInvocationNum: null, samples: [] };
  if (ev.s && typeof ev.s === 'object') {
    entry.samples.push(ev.s);
    if (entry.samples.length > 200) entry.samples = entry.samples.slice(-200);
  } else if (ev.p === 'pre') {
    entry.pendingPreMs = ev.t;
    entry.pendingInvocationNum = ev.n ?? null;
  } else if (ev.p === 'post') {
    const startMs = entry.pendingPreMs;
    const timestampMs = ev.t;
    if (startMs && timestampMs >= startMs && timestampMs - startMs <= 600_000) {
      const durationMs = Math.max(150, timestampMs - startMs);
      entry.samples.push({
        startMs,
        endMs: timestampMs,
        durationMs,
        invocationNum: ev.n ?? entry.pendingInvocationNum ?? null,
      });
      if (entry.samples.length > 200) {
        entry.samples = entry.samples.slice(-200);
      }
    }
    entry.pendingPreMs = null;
  }
  map[convId] = entry;
  return entry;
}

export function loadTimingsMap(paths) {
  const logPath = getTimingsLogPath(paths);
  const legacyPath = paths.timingsFile;
  const sig = `${safeStatSig(logPath)}|${safeStatSig(legacyPath)}`;
  const cacheKey = path.resolve(logPath).toLowerCase();

  const cached = timingsMapCache.get(cacheKey);
  if (cached && cached.sig === sig) {
    return cached.map;
  }

  const map = {};
  const legacy = readJsonSafe(legacyPath, null);
  if (legacy && typeof legacy === 'object') {
    for (const [cid, val] of Object.entries(legacy)) {
      if (!val || typeof val !== 'object') continue;
      map[cid] = {
        pendingPreMs: val.pendingPreMs ?? null,
        pendingInvocationNum: val.pendingInvocationNum ?? null,
        samples: Array.isArray(val.samples) ? val.samples.slice(-200) : [],
      };
    }
  }

  if (fs.existsSync(logPath)) {
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev && ev.c) {
            applyTimingEvent(map, ev.c, ev);
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // fail open
    }
  }

  timingsMapCache.set(cacheKey, { sig, map });
  return map;
}

function compactTimingsLogIfNeeded(paths) {
  const logPath = getTimingsLogPath(paths);
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return;
  }
  if (stat.size < TIMINGS_COMPACT_SIZE_HINT) return;

  let raw = '';
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= TIMINGS_COMPACT_MAX_LINES) return;

  const map = {};
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev && ev.c) applyTimingEvent(map, ev.c, ev);
    } catch {
      // ignore
    }
  }

  const entries = Object.entries(map);
  const kept = entries.length > 100 ? entries.slice(entries.length - 100) : entries;
  const outLines = [];
  for (const [cid, ent] of kept) {
    for (const s of (ent.samples || []).slice(-200)) {
      outLines.push(JSON.stringify({ c: cid, s }));
    }
    if (ent.pendingPreMs) {
      outLines.push(JSON.stringify({ c: cid, p: 'pre', n: ent.pendingInvocationNum ?? null, t: ent.pendingPreMs }));
    }
  }
  atomicWriteFile(logPath, outLines.length ? outLines.join('\n') + '\n' : '');
}

/**
 * Record PreInvocation or PostInvocation hook timestamp for exact hook_ms TPS calculation.
 * Uses O(1) append-only timings.jsonl with lazy compaction (>500 lines).
 */
export function recordHookTiming({ conversationId, phase, invocationNum, timestampMs = Date.now() }, options = {}) {
  if (!conversationId) return null;
  const paths = ensureDataDirs(options);
  const logPath = getTimingsLogPath(paths);

  const rec = {
    c: String(conversationId),
    p: phase === 'post' ? 'post' : 'pre',
    n: invocationNum ?? null,
    t: Number(timestampMs) || Date.now(),
  };
  appendJsonl(logPath, rec);
  compactTimingsLogIfNeeded(paths);

  timingsMapCache.delete(path.resolve(logPath).toLowerCase());
  for (const fn of reportInvalidators) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  return rec;
}

/**
 * Match a hook_ms timing sample near a transcript step's start timestamp (1-to-1 consumption, <= 5s).
 */
export function findHookTimingMatch(timingsEntry, stepTsMs, usedSampleIndices = null) {
  if (!timingsEntry || !Array.isArray(timingsEntry.samples) || !stepTsMs) return null;
  const samples = timingsEntry.samples;
  let bestStartIdx = -1;
  let bestStartDist = Infinity;

  for (let i = 0; i < samples.length; i++) {
    if (usedSampleIndices && usedSampleIndices.has(i)) continue;
    const s = samples[i];
    if (!s || !Number.isFinite(s.startMs) || !Number.isFinite(s.durationMs)) continue;
    const startDist = Math.abs(s.startMs - stepTsMs);
    if (startDist <= HOOK_MATCH_WINDOW_MS && startDist < bestStartDist) {
      bestStartIdx = i;
      bestStartDist = startDist;
    }
  }

  if (bestStartIdx === -1) return null;
  return { idx: bestStartIdx, durationMs: samples[bestStartIdx].durationMs };
}
