import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDataPaths } from './paths.mjs';
import { ensureDataDirs, readJsonlSafe, scanAllMemoryFiles } from './storage.mjs';

const DB_IDLE_TIMEOUT_MS = 5_000;
const INDEX_READY_TTL_MS = 5_000;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  head TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  file_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_proj_branch ON memories(project_id, branch, archived, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  project_id UNINDEXED,
  title,
  summary,
  tags
);

CREATE TABLE IF NOT EXISTS calls (
  call_uid TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  root_conversation_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_tag TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  timing_source TEXT NOT NULL,
  ttft_ms REAL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  context_tokens INTEGER NOT NULL,
  thinking_tokens_est INTEGER NOT NULL,
  content_tokens_est INTEGER NOT NULL,
  effective_tps REAL NOT NULL,
  cache_hit_rate REAL NOT NULL,
  cache_drop INTEGER NOT NULL DEFAULT 0,
  drop_reason TEXT,
  drop_detail TEXT,
  estimated_cost_usd REAL NOT NULL,
  quota_group TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_root_ts ON calls(root_conversation_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_calls_group_ts ON calls(quota_group, ts_ms DESC);
`;

const DB_POOL = new Map(); // normDbPath -> { db, dbPath, timer, activeDepth }
const SCHEMA_INITIALIZED_DBS = new Map(); // normDbPath -> { size, mtimeMs }
const INDEX_READY_CACHE = new Map(); // normDbPath -> { stats, checkedAt }
let exitHookRegistered = false;

function normDbKey(dbPath) {
  const resolved = path.resolve(dbPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideOsTmpDir(filePath) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const target = path.resolve(filePath).toLowerCase();
  return target === tmp || target.startsWith(`${tmp}${path.sep}`);
}

function isRunningInNodeTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.some((a) => a === '--test');
}

function shouldKeepPooled(dbPath, options = {}) {
  if (options.keepOpen === true || process.env.CONTEXT_CACHE_DB_POOL === '1') return true;
  if (options.keepOpen === false || process.env.CONTEXT_CACHE_DB_POOL === '0') return false;
  // On Windows, SQLite holds exclusive delete locks while open; legacy node:test suites
  // delete temp dirs synchronously via fs.unlinkSync/fs.rmSync without calling closeIndexDb().
  if (process.platform === 'win32' && isRunningInNodeTest() && isInsideOsTmpDir(dbPath)) {
    return false;
  }
  return true;
}

function registerExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    closeIndexDb();
  });
}

function disposePoolEntry(key) {
  const entry = DB_POOL.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  DB_POOL.delete(key);
  try {
    entry.db.close();
  } catch {
    // ignore close error
  }
}

/**
 * Close a pooled SQLite connection (or all pooled connections when dbPath is omitted).
 */
export function closeIndexDb(dbPath = null) {
  if (dbPath) {
    const key = normDbKey(dbPath);
    disposePoolEntry(key);
    INDEX_READY_CACHE.delete(key);
    return;
  }
  for (const key of [...DB_POOL.keys()]) {
    disposePoolEntry(key);
  }
  INDEX_READY_CACHE.clear();
}

function scheduleIdleClose(key, entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.activeDepth <= 0) {
      disposePoolEntry(key);
    }
  }, DB_IDLE_TIMEOUT_MS);
  entry.timer.unref?.();
}

function openFreshDb(dbFile, skipDdlIfInitialized = false) {
  const key = normDbKey(dbFile);
  const existed = fs.existsSync(dbFile);
  const db = new DatabaseSync(dbFile);
  let needSchema = true;
  if (skipDdlIfInitialized && existed) {
    const initMeta = SCHEMA_INITIALIZED_DBS.get(key);
    try {
      const st = fs.statSync(dbFile);
      if (initMeta && st.size > 0 && st.birthtimeMs === initMeta.birthtimeMs) {
        needSchema = false;
      }
    } catch {
      needSchema = true;
    }
  }
  if (needSchema) {
    db.exec(SCHEMA_SQL);
    try {
      const st = fs.statSync(dbFile);
      SCHEMA_INITIALIZED_DBS.set(key, { birthtimeMs: st.birthtimeMs, size: st.size });
    } catch {
      // ignore
    }
  } else {
    db.exec('PRAGMA busy_timeout = 3000;');
  }
  return db;
}

export function openIndexDb(options = {}) {
  const paths = ensureDataDirs(options);
  return openFreshDb(paths.dbFile, false);
}

export function withIndexDb(options, fn) {
  const opts = options || {};
  const paths = ensureDataDirs(opts);
  const dbFile = paths.dbFile;
  const key = normDbKey(dbFile);
  const poolEnabled = shouldKeepPooled(dbFile, opts);

  let entry = DB_POOL.get(key);
  // If db file was removed externally while pooled, discard stale handle
  if (entry && !fs.existsSync(dbFile)) {
    disposePoolEntry(key);
    SCHEMA_INITIALIZED_DBS.delete(key);
    INDEX_READY_CACHE.delete(key);
    entry = null;
  }

  let createdHere = false;
  if (!entry) {
    registerExitCleanup();
    const db = openFreshDb(dbFile, !poolEnabled);
    entry = { db, dbPath: dbFile, timer: null, activeDepth: 0 };
    DB_POOL.set(key, entry);
    createdHere = true;
  } else if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.activeDepth++;
  try {
    return fn(entry.db);
  } finally {
    entry.activeDepth = Math.max(0, entry.activeDepth - 1);
    if (entry.activeDepth === 0) {
      if (poolEnabled) {
        scheduleIdleClose(key, entry);
      } else if (createdHere) {
        disposePoolEntry(key);
      }
    }
  }
}

export function upsertMemoryRow(db, mem) {
  const tagsStr = Array.isArray(mem.tags) ? mem.tags.join(' ') : '';
  db.prepare(
    `INSERT INTO memories (id, project_id, branch, head, kind, title, summary, tags_json, archived, created_at, updated_at, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       branch = excluded.branch,
       head = excluded.head,
       kind = excluded.kind,
       title = excluded.title,
       summary = excluded.summary,
       tags_json = excluded.tags_json,
       archived = excluded.archived,
       updated_at = excluded.updated_at,
       file_path = excluded.file_path`
  ).run(
    mem.id,
    mem.projectId,
    mem.branch || 'main',
    mem.head || 'none',
    mem.kind || 'decision',
    mem.title || '',
    mem.summary || '',
    JSON.stringify(Array.isArray(mem.tags) ? mem.tags : []),
    mem.archived ? 1 : 0,
    mem.createdAt,
    mem.updatedAt,
    mem.filePath || ''
  );

  db.prepare('DELETE FROM memories_fts WHERE id = ?').run(mem.id);
  db.prepare('INSERT INTO memories_fts (id, project_id, title, summary, tags) VALUES (?, ?, ?, ?, ?)').run(
    mem.id,
    mem.projectId,
    mem.title || '',
    mem.summary || '',
    tagsStr
  );
}

export function upsertCallRow(db, c) {
  db.prepare(
    `INSERT INTO calls (
      call_uid, conversation_id, root_conversation_id, agent_type, agent_tag,
      step_index, model, created_at, ts_ms, duration_ms, timing_source, ttft_ms,
      input_tokens, cache_read_tokens, output_tokens, context_tokens,
      thinking_tokens_est, content_tokens_est, effective_tps, cache_hit_rate,
      cache_drop, drop_reason, drop_detail, estimated_cost_usd, quota_group
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_uid) DO UPDATE SET
      root_conversation_id = excluded.root_conversation_id,
      agent_type = excluded.agent_type,
      agent_tag = excluded.agent_tag,
      duration_ms = excluded.duration_ms,
      timing_source = excluded.timing_source,
      ttft_ms = excluded.ttft_ms,
      thinking_tokens_est = excluded.thinking_tokens_est,
      content_tokens_est = excluded.content_tokens_est,
      effective_tps = excluded.effective_tps,
      cache_hit_rate = excluded.cache_hit_rate,
      cache_drop = excluded.cache_drop,
      drop_reason = excluded.drop_reason,
      drop_detail = excluded.drop_detail,
      estimated_cost_usd = excluded.estimated_cost_usd,
      quota_group = excluded.quota_group`
  ).run(
    c.callUid,
    c.conversationId,
    c.rootConversationId || c.conversationId,
    c.agentType || 'main',
    c.agentTag || '主',
    Number(c.stepIndex) || 0,
    c.model || 'unknown',
    c.createdAt || new Date(c.tsMs || Date.now()).toISOString(),
    Number(c.tsMs) || 0,
    Number(c.durationMs) || 1000,
    c.timingSource || 'transcript_fallback',
    c.ttftMs == null ? null : Number(c.ttftMs),
    Number(c.inputTokens) || 0,
    Number(c.cacheReadTokens) || 0,
    Number(c.outputTokens) || 0,
    Number(c.contextTokens) || 0,
    Number(c.thinkingTokensEst) || 0,
    Number(c.contentTokensEst) || 0,
    Number(c.effectiveTps) || 0,
    Number(c.cacheHitRate) || 0,
    c.cacheDrop ? 1 : 0,
    c.dropReason || null,
    c.dropDetail || null,
    Number(c.estimatedCostUsd) || 0,
    c.quotaGroup || 'gemini'
  );
}

/**
 * Wipe and losslessly rebuild SQLite WAL + FTS5 index from Markdown/JSONL truth sources.
 */
export function rebuildIndex(options = {}) {
  const started = Date.now();
  const paths = ensureDataDirs(options);
  const key = normDbKey(paths.dbFile);

  // Close any pooled handle before unlinking DB files (required on Windows)
  closeIndexDb(paths.dbFile);
  SCHEMA_INITIALIZED_DBS.delete(key);
  INDEX_READY_CACHE.delete(key);

  for (const suffix of ['', '-wal', '-shm']) {
    const f = paths.dbFile + suffix;
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // If locked on Windows, fall back to clearing tables inside open DB
    }
  }

  const memories = scanAllMemoryFiles(options);
  const calls = readJsonlSafe(paths.callsLogFile);

  withIndexDb(options, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM calls;');
      for (const mem of memories) {
        upsertMemoryRow(db, mem);
      }
      for (const call of calls) {
        if (call && call.callUid) {
          upsertCallRow(db, call);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  const callsIndexed = calls.filter((c) => c && c.callUid).length;
  INDEX_READY_CACHE.set(key, {
    stats: { memories: memories.length, calls: callsIndexed },
    checkedAt: Date.now(),
  });

  return {
    memoriesIndexed: memories.length,
    callsIndexed,
    elapsedMs: Date.now() - started,
    dbFile: paths.dbFile,
  };
}

/**
 * Ensure index exists and is populated if truth files exist but DB is empty/missing.
 */
export function ensureIndexReady(options = {}) {
  const paths = getDataPaths(options);
  if (!fs.existsSync(paths.dbFile)) {
    return rebuildIndex(options);
  }
  const key = normDbKey(paths.dbFile);
  const now = Date.now();
  const cached = INDEX_READY_CACHE.get(key);
  if (cached && now - cached.checkedAt < INDEX_READY_TTL_MS) {
    return cached.stats;
  }
  try {
    const stats = withIndexDb(options, (db) => {
      const m = db.prepare('SELECT COUNT(*) AS n FROM memories').get();
      const c = db.prepare('SELECT COUNT(*) AS n FROM calls').get();
      return { memories: m.n, calls: c.n };
    });
    if (stats.memories === 0) {
      const truthMems = scanAllMemoryFiles(options);
      if (truthMems.length > 0) {
        return rebuildIndex(options);
      }
    }
    INDEX_READY_CACHE.set(key, { stats, checkedAt: now });
    return stats;
  } catch {
    return rebuildIndex(options);
  }
}
