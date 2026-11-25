import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, getCandidateAppDataDirs, findTranscriptPath } from './paths.mjs';
import { atomicWriteJson, ensureDataDirs, readJsonSafe } from './storage.mjs';
import { parseAnnotationPbtxt } from './transcript-parser.mjs';

const MAX_REGISTRY_ENTRIES = 100;
const PEEK_ANNOTATION_TTL_MS = 3_000;
const PEEK_ANNOTATION_CACHE = new Map(); // cacheKey -> { fingerprint, bestFullPath, bestMtimeMs, result, expiresAt }

export function clearSessionTrackerCache() {
  PEEK_ANNOTATION_CACHE.clear();
}

function safeMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Ultra-fast (<0.2ms) check of the top newest <appDataDir>/annotations/<convId>.pbtxt files
 * to detect pure UI clicks in Antigravity's conversation sidebar without parsing transcripts.
 * Cached for 3s and invalidated immediately when any annotations dir mtime (or top file mtime) changes.
 */
export function peekLatestViewedAnnotation(options = {}) {
  const appDirs = getCandidateAppDataDirs(options);
  const cacheKey = appDirs.map((d) => path.resolve(d).toLowerCase()).join('|');
  const dirFp = appDirs.map((d) => safeMtimeMs(path.join(d, 'annotations'))).join(',');
  const now = Date.now();

  const cached = PEEK_ANNOTATION_CACHE.get(cacheKey);
  if (cached && now < cached.expiresAt && cached.fingerprint === dirFp) {
    if (!cached.bestFullPath || safeMtimeMs(cached.bestFullPath) === cached.bestMtimeMs) {
      return cached.result;
    }
  }

  const candidates = [];
  for (const appDir of appDirs) {
    const annDir = path.join(appDir, 'annotations');
    if (!fs.existsSync(annDir)) continue;
    let files = [];
    try {
      files = fs.readdirSync(annDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.pbtxt')) continue;
      const convId = f.slice(0, -6);
      const fullPath = path.join(annDir, f);
      try {
        const st = fs.statSync(fullPath);
        candidates.push({ convId, fullPath, mtimeMs: st.mtimeMs, appDir });
      } catch {
        // ignore
      }
    }
  }

  if (candidates.length === 0) {
    PEEK_ANNOTATION_CACHE.set(cacheKey, {
      fingerprint: dirFp,
      bestFullPath: '',
      bestMtimeMs: -1,
      result: null,
      expiresAt: now + PEEK_ANNOTATION_TTL_MS,
    });
    return null;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let best = null;
  let bestFullPath = '';
  let bestMtimeMs = -1;
  for (const c of candidates.slice(0, 5)) {
    const tPath = findTranscriptPath(c.convId, { ...options, appDataDir: c.appDir });
    if (!tPath) continue;
    try {
      const parsed = parseAnnotationPbtxt(fs.readFileSync(c.fullPath, 'utf8'));
      const viewMs = parsed.lastViewMs || Math.round(c.mtimeMs);
      if (!best || viewMs > best.lastViewMs) {
        best = {
          conversationId: c.convId,
          title: parsed.title || '',
          lastViewMs: viewMs,
          transcriptPath: tPath,
        };
        bestFullPath = c.fullPath;
        bestMtimeMs = c.mtimeMs;
      }
    } catch {
      // ignore
    }
  }

  if (PEEK_ANNOTATION_CACHE.size > 32) {
    const oldest = PEEK_ANNOTATION_CACHE.keys().next().value;
    if (oldest !== undefined) PEEK_ANNOTATION_CACHE.delete(oldest);
  }
  PEEK_ANNOTATION_CACHE.set(cacheKey, {
    fingerprint: dirFp,
    bestFullPath,
    bestMtimeMs,
    result: best,
    expiresAt: now + PEEK_ANNOTATION_TTL_MS,
  });
  return best;
}

function normalizeDir(dir) {
  if (!dir || typeof dir !== 'string') return '';
  const trimmed = dir.trim();
  if (!trimmed) return '';
  try {
    return path.resolve(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Record the latest active conversation (from Hook, explicit Tool call, or cross-view UI sync)
 * and persist its workspace projectDir/transcriptPath in the session registry.
 */
export function recordActiveSession(
  {
    conversationId,
    projectDir = '',
    transcriptPath = '',
    source = 'hook',
    event = '',
    updatedAtMs = Date.now(),
  } = {},
  options = {}
) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;

  const paths = ensureDataDirs(options);
  const ts = Number.isFinite(Number(updatedAtMs)) ? Number(updatedAtMs) : Date.now();
  const registry = readJsonSafe(paths.sessionsRegistryFile, {});
  const prevEntry = registry[convId] && typeof registry[convId] === 'object' ? registry[convId] : {};

  const normProjectDir = normalizeDir(projectDir) || prevEntry.projectDir || '';
  const normTranscript = String(transcriptPath || '').trim() || prevEntry.transcriptPath || findTranscriptPath(convId, options) || '';

  const entry = {
    conversationId: convId,
    projectDir: normProjectDir,
    transcriptPath: normTranscript,
    lastSource: source || prevEntry.lastSource || 'hook',
    lastEvent: event || prevEntry.lastEvent || '',
    lastActiveMs: Math.max(ts, Number(prevEntry.lastActiveMs) || 0),
    updatedAt: new Date(ts).toISOString(),
  };

  registry[convId] = entry;

  // Prune oldest entries beyond limit
  const entries = Object.entries(registry);
  if (entries.length > MAX_REGISTRY_ENTRIES) {
    entries.sort((a, b) => (Number(b[1]?.lastActiveMs) || 0) - (Number(a[1]?.lastActiveMs) || 0));
    const pruned = {};
    for (const [k, v] of entries.slice(0, MAX_REGISTRY_ENTRIES)) {
      pruned[k] = v;
    }
    atomicWriteJson(paths.sessionsRegistryFile, pruned);
  } else {
    atomicWriteJson(paths.sessionsRegistryFile, registry);
  }

  const active = {
    conversationId: convId,
    projectDir: normProjectDir,
    transcriptPath: normTranscript,
    source: source || 'hook',
    event: event || '',
    updatedAtMs: ts,
    updatedAt: new Date(ts).toISOString(),
  };

  // Prevent an older event from overwriting a strictly newer active session timestamp
  const existing = readJsonSafe(paths.activeSessionFile, null);
  if (!existing || ts >= (Number(existing.updatedAtMs) || 0) || source === 'ui_sync' || source === 'tool') {
    atomicWriteJson(paths.activeSessionFile, active);
    return active;
  }
  return existing;
}

/**
 * Read the most recently recorded active session pointer.
 */
export function readActiveSession(options = {}) {
  const paths = getDataPaths(options);
  const raw = readJsonSafe(paths.activeSessionFile, null);
  if (!raw || typeof raw !== 'object' || !raw.conversationId) return null;
  return {
    conversationId: String(raw.conversationId),
    projectDir: String(raw.projectDir || ''),
    transcriptPath: String(raw.transcriptPath || ''),
    source: String(raw.source || 'hook'),
    event: String(raw.event || ''),
    updatedAtMs: Number(raw.updatedAtMs) || 0,
    updatedAt: String(raw.updatedAt || ''),
  };
}

/**
 * Read the full conversationId -> session metadata registry.
 */
export function readSessionsRegistry(options = {}) {
  const paths = getDataPaths(options);
  const raw = readJsonSafe(paths.sessionsRegistryFile, {});
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Resolve the workspace projectDir associated with a given conversationId,
 * falling back cleanly if unrecorded or if the directory no longer exists.
 */
export function getSessionProjectDir(conversationId, fallbackProjectDir = '', options = {}) {
  const convId = String(conversationId || '').trim();
  if (convId) {
    const registry = readSessionsRegistry(options);
    const rec = registry[convId];
    if (rec?.projectDir && fs.existsSync(rec.projectDir)) {
      return rec.projectDir;
    }
    const active = readActiveSession(options);
    if (active && active.conversationId === convId && active.projectDir && fs.existsSync(active.projectDir)) {
      return active.projectDir;
    }
  }
  return fallbackProjectDir || process.cwd();
}

/**
 * Resolve which conversation & projectDir the monitor should inspect.
 *
 * Priority:
 * 1) Explicit pinned conversationId (when followActive === false or requestedConversationId is supplied)
 * 2) Auto-follow mode: compare active-session.json (Hook / Tool / cross-view UI sync)
 *    against newest transcript.jsonl mtimeMs and pick the freshest active conversation.
 */
export function resolveTargetSession(
  {
    requestedConversationId = null,
    followActive = true,
    sessions = [],
    fallbackProjectDir = '',
    requestedProjectDir = '',
    requestedTranscriptPath = '',
  } = {},
  options = {}
) {
  const registry = readSessionsRegistry(options);
  const active = readActiveSession(options);
  const newestTranscriptSession = Array.isArray(sessions) && sessions.length > 0 ? sessions[0] : null;

  let conversationId = null;
  let source = 'none';
  let transcriptPath = requestedTranscriptPath || '';

  if (requestedConversationId) {
    conversationId = String(requestedConversationId).trim();
    source = 'explicit';
  } else if (followActive) {
    const activeMs = active?.updatedAtMs || 0;

    // Find the conversation with the newest user-view timestamp (annotations/<id>.pbtxt last_user_view_time)
    // and the conversation with the newest transcript modification timestamp.
    let newestViewedSession = null;
    let newestTranscript = null;
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if ((s.lastViewMs || 0) > (newestViewedSession?.lastViewMs || 0)) {
        newestViewedSession = s;
      }
      if ((s.mtimeMs || 0) > (newestTranscript?.mtimeMs || 0)) {
        newestTranscript = s;
      }
    }
    if (!newestTranscript && newestTranscriptSession) {
      newestTranscript = newestTranscriptSession;
    }

    const peekedView = peekLatestViewedAnnotation(options);
    if (peekedView && (!newestViewedSession || peekedView.lastViewMs >= (newestViewedSession.lastViewMs || 0))) {
      newestViewedSession = peekedView;
    }

    const viewMs = newestViewedSession?.lastViewMs || 0;
    const latestTranscriptMs = newestTranscript?.mtimeMs || 0;

    // Compare the 3 live signals:
    // 1) Pure UI click in Antigravity sidebar (viewMs from annotations/<id>.pbtxt)
    // 2) Active session record (Hook SessionStart/PreInvocation/PostInvocation/Stop, or cross-view UI dropdown pick)
    // 3) Fallback transcript file mtimeMs
    if (viewMs > 0 && viewMs > activeMs && viewMs >= latestTranscriptMs - 1000) {
      conversationId = newestViewedSession.conversationId;
      source = 'antigravity_view';
      if (!transcriptPath) {
        transcriptPath = newestViewedSession.transcriptPath || '';
      }
    } else if (
      active?.conversationId &&
      (!newestTranscript ||
        active.source === 'ui_sync' ||
        active.source === 'tool' ||
        activeMs >= latestTranscriptMs - 1500)
    ) {
      conversationId = active.conversationId;
      source = active.source || 'hook';
      if (!transcriptPath && active.transcriptPath && fs.existsSync(active.transcriptPath)) {
        transcriptPath = active.transcriptPath;
      }
    } else if (newestTranscript?.conversationId) {
      conversationId = newestTranscript.conversationId;
      source = 'transcript';
      if (!transcriptPath) {
        transcriptPath = newestTranscript.transcriptPath || '';
      }
    }
  } else if (newestTranscriptSession?.conversationId) {
    conversationId = newestTranscriptSession.conversationId;
    source = 'transcript';
    if (!transcriptPath) {
      transcriptPath = newestTranscriptSession.transcriptPath || '';
    }
  }

  if (conversationId && !transcriptPath) {
    const regEntry = registry[conversationId];
    if (regEntry?.transcriptPath && fs.existsSync(regEntry.transcriptPath)) {
      transcriptPath = regEntry.transcriptPath;
    } else {
      transcriptPath = findTranscriptPath(conversationId, options) || '';
    }
  }

  const resolvedProjectDir =
    normalizeDir(requestedProjectDir) ||
    getSessionProjectDir(conversationId, fallbackProjectDir, options);

  return {
    conversationId,
    projectDir: resolvedProjectDir,
    transcriptPath: transcriptPath || null,
    source,
    activeSession: active,
  };
}
