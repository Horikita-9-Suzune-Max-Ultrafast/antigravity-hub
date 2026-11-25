import fs from 'node:fs';
import path from 'node:path';
import { getCandidateAppDataDirs, findTranscriptPath, formatDisplayPath } from './paths.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_TRANSCRIPT_CACHE = 64;
const MAX_ANNOTATION_CACHE = 256;

const transcriptCache = new Map(); // normFilePath -> { size, mtimeMs, steps, metaBase, subagentIds }
const annotationCache = new Map(); // normFilePath -> { size, mtimeMs, parsed }

export function clearTranscriptCache() {
  transcriptCache.clear();
  annotationCache.clear();
}

function lruPut(map, key, val, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function normCacheKey(filePath) {
  const abs = path.resolve(filePath);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Parse a single Antigravity annotation .pbtxt file (<appDataDir>/annotations/<convId>.pbtxt)
 * for official conversation title and last_user_view_time (updated whenever the user clicks a conversation in the UI).
 */
export function parseAnnotationPbtxt(rawText) {
  if (!rawText || typeof rawText !== 'string') return { title: '', lastViewMs: 0, archived: false };
  let title = '';
  const titleMatch = /title:\s*"((?:[^"\\]|\\.)*)"/.exec(rawText);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  }
  let lastViewMs = 0;
  const viewMatch = /last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/.exec(rawText);
  if (viewMatch && viewMatch[1]) {
    const sec = Number(viewMatch[1]) || 0;
    const nanos = Number(viewMatch[2]) || 0;
    lastViewMs = sec * 1000 + Math.round(nanos / 1_000_000);
  }
  const archived = /archived:\s*true\b/.test(rawText);
  return { title, lastViewMs, archived };
}

/**
 * Read annotation metadata (<appDataDir>/annotations/<convId>.pbtxt) for a conversation if available.
 */
export function readConversationAnnotation(conversationId, options = {}) {
  if (!conversationId) return { title: '', lastViewMs: 0, archived: false };
  const safeId = path.basename(String(conversationId));
  for (const appDir of getCandidateAppDataDirs(options)) {
    const p = path.join(appDir, 'annotations', `${safeId}.pbtxt`);
    try {
      const st = fs.statSync(p);
      const key = normCacheKey(p);
      const cached = annotationCache.get(key);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        lruPut(annotationCache, key, cached, MAX_ANNOTATION_CACHE);
        if (cached.parsed.title || cached.parsed.lastViewMs > 0) return cached.parsed;
        continue;
      }
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = parseAnnotationPbtxt(raw);
      lruPut(annotationCache, key, { size: st.size, mtimeMs: st.mtimeMs, parsed }, MAX_ANNOTATION_CACHE);
      if (parsed.title || parsed.lastViewMs > 0) return parsed;
    } catch {
      // fail open if missing or unreadable
    }
  }
  return { title: '', lastViewMs: 0, archived: false };
}

/**
 * Normalize a single transcript step across snake_case / camelCase schema variations.
 */
export function normalizeTranscriptStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stepIndex = Number(raw.step_index ?? raw.stepIndex ?? raw.step_idx ?? raw.stepIdx ?? -1);
  const type = String(raw.type ?? raw.stepType ?? raw.step_type ?? '').toUpperCase();
  const source = String(raw.source ?? '').toUpperCase();
  const status = String(raw.status ?? '').toUpperCase();
  const createdAt = String(raw.created_at ?? raw.createdAt ?? raw.timestamp ?? '');
  const tsMs = createdAt ? Date.parse(createdAt) : NaN;
  const model = String(raw.model ?? raw.model_name ?? raw.modelName ?? '').trim();

  const inputTokens = Number(raw.input_tokens ?? raw.inputTokens ?? raw.usage?.input_tokens ?? raw.usage?.inputTokens ?? 0) || 0;
  const cacheReadTokens =
    Number(
      raw.cache_read_tokens ??
        raw.cacheReadTokens ??
        raw.cached_input_tokens ??
        raw.cachedInputTokens ??
        raw.usage?.cache_read_tokens ??
        raw.usage?.cacheReadTokens ??
        0
    ) || 0;
  const outputTokens =
    Number(raw.output_tokens ?? raw.outputTokens ?? raw.usage?.output_tokens ?? raw.usage?.outputTokens ?? 0) || 0;

  const ttftRaw = raw.ttft_ms ?? raw.ttftMs ?? raw.usage?.ttft_ms ?? raw.usage?.ttftMs ?? null;
  const ttftMs = ttftRaw != null && Number.isFinite(Number(ttftRaw)) ? Number(ttftRaw) : null;

  const durationRaw = raw.duration_ms ?? raw.durationMs ?? raw.latency_ms ?? raw.latencyMs ?? null;
  const reportedDurationMs = durationRaw != null && Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : null;

  const thinking = typeof raw.thinking === 'string' ? raw.thinking : '';
  const content = typeof raw.content === 'string' ? raw.content : '';
  const toolCalls = Array.isArray(raw.tool_calls)
    ? raw.tool_calls
    : Array.isArray(raw.toolCalls)
      ? raw.toolCalls
      : [];
  const mediaList = Array.isArray(raw.media) ? raw.media : [];

  return {
    stepIndex,
    type,
    source,
    status,
    createdAt,
    tsMs: Number.isFinite(tsMs) ? tsMs : 0,
    model,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    ttftMs,
    reportedDurationMs,
    thinking,
    content,
    toolCalls,
    mediaCount: mediaList.length,
  };
}

/**
 * Incrementally parse a transcript.jsonl file starting from a byte offset.
 * Safely stops before an incomplete trailing line without advancing cursor past it.
 */
export function parseTranscriptIncremental(filePath, byteOffset = 0) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { steps: [], nextOffset: byteOffset, fileSize: 0 };
  }
  const stat = fs.statSync(filePath);
  let start = Number(byteOffset) || 0;
  if (start > stat.size) {
    // File was truncated or rewritten
    start = 0;
  }
  if (start === stat.size) {
    return { steps: [], nextOffset: start, fileSize: stat.size };
  }

  const length = stat.size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  let completeText = text;
  let consumedBytes = length;

  // If the file doesn't end with newline, check if last line is valid JSON; if not, keep cursor before it
  if (lastNewline === -1) {
    try {
      const obj = JSON.parse(text.trim());
      const norm = normalizeTranscriptStep(obj);
      return { steps: norm ? [norm] : [], nextOffset: stat.size, fileSize: stat.size };
    } catch {
      return { steps: [], nextOffset: start, fileSize: stat.size };
    }
  } else if (lastNewline < text.length - 1) {
    const tail = text.slice(lastNewline + 1).trim();
    if (tail) {
      try {
        JSON.parse(tail);
        // Valid complete JSON without trailing newline -> consume all
      } catch {
        completeText = text.slice(0, lastNewline + 1);
        consumedBytes = Buffer.byteLength(completeText, 'utf8');
      }
    }
  }

  const steps = [];
  for (const line of completeText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const norm = normalizeTranscriptStep(parsed);
      if (norm) steps.push(norm);
    } catch {
      // Tolerate malformed line without failing
    }
  }

  return {
    steps,
    nextOffset: start + consumedBytes,
    fileSize: stat.size,
  };
}

function computeMetaBase(steps) {
  let promptLabel = '';
  let lastModel = '';
  const stepCount = steps.length;
  let lastUsedTokens = 0;

  const firstUser = steps.find((s) => s.type === 'USER_INPUT' && s.content);
  if (firstUser) {
    const cleaned = firstUser.content
      .replace(/<\/?USER_REQUEST>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) {
      promptLabel = cleaned.slice(0, 48) + (cleaned.length > 48 ? '…' : '');
    }
  }
  const fileSet = new Set();
  for (const s of steps) {
    if (s.type === 'PLANNER_RESPONSE') {
      if (s.model) lastModel = s.model;
      if (s.inputTokens + s.cacheReadTokens > 0) {
        lastUsedTokens = s.inputTokens + s.cacheReadTokens;
      }
      for (const tc of s.toolCalls) {
        const name = String(tc?.name || '').toLowerCase();
        if (name === 'write_file' || name === 'edit_file' || name === 'replace_file_content') {
          const p = tc?.args?.Path || tc?.args?.path || tc?.args?.TargetFile;
          if (p) fileSet.add(path.basename(String(p).replace(/^"|"$/g, '')));
        }
      }
    }
  }
  return {
    promptLabel,
    lastModel,
    stepCount,
    lastUsedTokens,
    touchedFiles: [...fileSet].slice(0, 8),
  };
}

function getTranscriptCacheEntry(filePath, statOverride = null) {
  if (!filePath) return null;
  let stat = statOverride;
  if (!stat) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
  }
  const key = normCacheKey(filePath);
  const cached = transcriptCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    lruPut(transcriptCache, key, cached, MAX_TRANSCRIPT_CACHE);
    return cached;
  }
  const { steps } = parseTranscriptIncremental(filePath, 0);
  const entry = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    steps,
    metaBase: null,
    subagentIdsByParent: new Map(),
  };
  lruPut(transcriptCache, key, entry, MAX_TRANSCRIPT_CACHE);
  return entry;
}

/**
 * Parse a full transcript file from byte 0 (with (size, mtimeMs) LRU cache).
 */
export function parseTranscriptFull(filePath) {
  const entry = getTranscriptCacheEntry(filePath);
  return entry ? entry.steps : [];
}

/**
 * Discover subagent conversationIds launched via invoke_subagent in a parent transcript.
 */
export function discoverSubagentIds(steps, parentConversationId = '') {
  const found = [];
  const seen = new Set();
  if (parentConversationId) seen.add(parentConversationId.toLowerCase());

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasInvoke = step.toolCalls.some((tc) => {
      const name = String(tc?.name || tc?.tool || '').toLowerCase();
      return name === 'invoke_subagent' || name.endsWith('invoke_subagent');
    });
    if (!hasInvoke) continue;

    // Look in the subsequent 1..6 steps for tool return containing conversationId
    for (let j = i + 1; j < Math.min(steps.length, i + 7); j++) {
      const next = steps[j];
      const text = next.content || '';
      if (!text) continue;
      if (!/conversationid|conversation_id|conversation:\/\/|subagent|launched/i.test(text)) continue;
      const matches = text.match(UUID_RE) || [];
      for (const uuid of matches) {
        const lower = uuid.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          found.push(uuid);
        }
      }
    }
  }

  return found;
}

function getCachedSubagentIds(entry, parentConversationId) {
  const pid = String(parentConversationId || '').toLowerCase();
  if (entry.subagentIdsByParent.has(pid)) {
    return entry.subagentIdsByParent.get(pid);
  }
  const discovered = discoverSubagentIds(entry.steps, parentConversationId);
  entry.subagentIdsByParent.set(pid, discovered);
  return discovered;
}

function getCachedMetaBase(entry) {
  if (!entry.metaBase) {
    entry.metaBase = computeMetaBase(entry.steps);
  }
  return entry.metaBase;
}

/**
 * Extract a concise human-readable label from a conversation's transcript.
 */
export function extractConversationMeta(filePath, conversationId, options = {}) {
  let label = conversationId.slice(0, 8);
  let lastModel = '';
  let stepCount = 0;
  let lastUsedTokens = 0;
  let touchedFiles = [];

  const annotation = options._annotation || readConversationAnnotation(conversationId, options);

  try {
    const entry = options._cacheEntry || getTranscriptCacheEntry(filePath, options._stat || null);
    if (entry) {
      const base = getCachedMetaBase(entry);
      stepCount = base.stepCount;
      lastModel = base.lastModel;
      lastUsedTokens = base.lastUsedTokens;
      touchedFiles = base.touchedFiles;
      if (annotation.title) {
        label = annotation.title;
      } else if (base.promptLabel) {
        label = base.promptLabel;
      }
    } else if (annotation.title) {
      label = annotation.title;
    }
  } catch {
    if (annotation.title) label = annotation.title;
  }

  return {
    conversationId,
    label,
    title: annotation.title || '',
    lastViewMs: annotation.lastViewMs || 0,
    lastModel,
    stepCount,
    lastUsedTokens,
    touchedFiles,
  };
}

/**
 * Discover recent Antigravity conversations sorted by most recently updated transcript.
 * Single-pass with LRU transcript caching; avoids parsing old transcripts when limit is small.
 */
export function listConversations(options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 15));
  const candidates = [];
  const seen = new Set();

  for (const appDir of getCandidateAppDataDirs(options)) {
    const brainDir = path.join(appDir, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      if (seen.has(convId)) continue;
      const tPath = findTranscriptPath(convId, { ...options, appDataDir: appDir });
      if (!tPath) continue;
      try {
        const stat = fs.statSync(tPath);
        if (stat.size === 0) continue;
        const ann = readConversationAnnotation(convId, { ...options, appDataDir: appDir });
        seen.add(convId);
        candidates.push({
          conversationId: convId,
          transcriptPath: tPath,
          stat,
          annotation: ann,
          mtimeMs: stat.mtimeMs,
          lastViewMs: ann.lastViewMs || 0,
          activityMs: Math.max(stat.mtimeMs, ann.lastViewMs || 0),
          size: stat.size,
        });
      } catch {
        // ignore unreadable transcript
      }
    }
  }

  candidates.sort((a, b) => b.activityMs - a.activityMs || b.mtimeMs - a.mtimeMs);

  // Single-pass lazy parsing: only parse enough top candidates to discover subagent parents
  // and build metadata without re-parsing files or parsing 20 old files when limit is small.
  const subScanWindow =
    limit <= 3
      ? Math.min(candidates.length, Math.max(limit + 2, 3))
      : Math.min(candidates.length, Math.min(20, limit + 5));

  const subagentIds = new Set();
  const subagentParentMap = new Map();
  const entryCacheByIdx = new Map();

  for (let i = 0; i < subScanWindow; i++) {
    const c = candidates[i];
    try {
      const entry = getTranscriptCacheEntry(c.transcriptPath, c.stat);
      if (!entry) continue;
      entryCacheByIdx.set(i, entry);
      const discovered = getCachedSubagentIds(entry, c.conversationId);
      discovered.forEach((sid, idx) => {
        const lower = sid.toLowerCase();
        subagentIds.add(lower);
        if (!subagentParentMap.has(lower)) {
          subagentParentMap.set(lower, {
            parentConversationId: c.conversationId,
            subTag: `子${idx + 1}`,
          });
        }
      });
    } catch {
      // ignore
    }
  }

  const nowMs = Date.now();
  const recentSubagentWindowMs = 2 * 60 * 60 * 1000;
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const lowerId = c.conversationId.toLowerCase();
    const isSub = subagentIds.has(lowerId);
    const isRecentSub = isSub && nowMs - c.mtimeMs <= recentSubagentWindowMs;
    if (isSub && !options.includeSubagents && !(options.includeRecentSubagents && isRecentSub)) continue;

    const cachedEntry = entryCacheByIdx.get(i) || getTranscriptCacheEntry(c.transcriptPath, c.stat);
    const meta = extractConversationMeta(c.transcriptPath, c.conversationId, {
      ...options,
      _annotation: c.annotation,
      _cacheEntry: cachedEntry,
      _stat: c.stat,
    });
    const subInfo = subagentParentMap.get(lowerId) || null;
    results.push({
      ...meta,
      transcriptPath: c.transcriptPath,
      mtimeMs: c.mtimeMs,
      lastViewMs: Math.max(c.lastViewMs || 0, meta.lastViewMs || 0),
      isSubagent: isSub,
      parentConversationId: subInfo?.parentConversationId || null,
      subTag: subInfo?.subTag || null,
      isActive: nowMs - c.mtimeMs <= 90_000,
    });
    if (results.length >= limit) break;
  }

  return results;
}

const FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'create_file',
]);

function safeRealpath(p) {
  const abs = path.resolve(p);
  try {
    if (fs.existsSync(abs)) {
      return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
    }
  } catch {
    // ignore
  }
  return abs;
}

function normalizeWorkspaceRelPath(rawPath, projectDir) {
  const cleaned = String(rawPath || '').trim().replace(/^"|"$/g, '');
  if (!cleaned) return '';
  if (projectDir) {
    try {
      const absTarget = safeRealpath(cleaned);
      const absRoot = safeRealpath(projectDir);
      let rel = path.relative(absRoot, absTarget);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, '/');
      }
      // Fallback for non-existent target file whose parent dir exists (e.g., deleted/virtual file on Windows 8.3 path)
      const parentReal = safeRealpath(path.dirname(cleaned));
      rel = path.relative(absRoot, path.join(parentReal, path.basename(cleaned)));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, '/');
      }
    } catch {
      // fall through
    }
  }
  return cleaned.replace(/\\/g, '/');
}

function isArtifactPath(rawPath, brainDir) {
  const norm = String(rawPath || '').replace(/\\/g, '/').toLowerCase();
  if (!norm) return false;
  if (norm.includes('/.system_generated/')) return false;
  if (brainDir) {
    const normBrain = path.resolve(brainDir).replace(/\\/g, '/').toLowerCase();
    if (norm === normBrain || norm.startsWith(`${normBrain}/`)) {
      return true;
    }
  }
  return /\/brain\/[0-9a-f-]{8,}\/[^/]+\.md$/i.test(norm);
}

function resolveBrainDirFromTranscript(transcriptPath) {
  if (!transcriptPath) return '';
  const abs = path.resolve(transcriptPath);
  const parent = path.dirname(abs);
  if (path.basename(parent).toLowerCase() === 'logs' && path.basename(path.dirname(parent)).toLowerCase() === '.system_generated') {
    return path.dirname(path.dirname(parent));
  }
  if (path.basename(path.dirname(parent)).toLowerCase() === 'brain') {
    return parent;
  }
  return '';
}

/**
 * Extract 0-token handoff context from a conversation's transcript.jsonl:
 * - recent user requests summary
 * - edited / created project files
 * - produced Artifact paths
 */
export function extractTranscriptHandoffContext(filePath, { projectDir = '', maxRequests = 3, maxFiles = 30, maxArtifacts = 16 } = {}) {
  const empty = {
    latestUserRequest: '',
    recentUserRequests: [],
    editedFiles: [],
    artifacts: [],
  };
  if (!filePath || !fs.existsSync(filePath)) return empty;

  const brainDir = resolveBrainDirFromTranscript(filePath);
  let steps = [];
  try {
    steps = parseTranscriptFull(filePath);
  } catch {
    return empty;
  }

  const userRequests = [];
  const editedSet = new Set();
  const editedFiles = [];
  const artifactMap = new Map();

  const addArtifact = (absPath) => {
    const cleaned = String(absPath || '').trim().replace(/^"|"$/g, '');
    if (!cleaned) return;
    const resolved = path.resolve(cleaned);
    const key = resolved.toLowerCase();
    if (artifactMap.has(key) || artifactMap.size >= maxArtifacts) return;
    artifactMap.set(key, {
      path: resolved,
      displayPath: formatDisplayPath(resolved),
      name: path.basename(resolved),
    });
  };

  for (const s of steps) {
    if (s.type === 'USER_INPUT' && s.content) {
      let cleaned = String(s.content)
        .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, ' ')
        .replace(/<\/?USER_REQUEST>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) {
        if (cleaned.length > 180) cleaned = cleaned.slice(0, 180) + '…';
        userRequests.push(cleaned);
      }
    }
    if (s.type === 'PLANNER_RESPONSE' && Array.isArray(s.toolCalls)) {
      for (const tc of s.toolCalls) {
        const toolName = String(tc?.name || tc?.tool || '').toLowerCase().replace(/^default_api:/, '');
        if (!FILE_MUTATION_TOOLS.has(toolName)) continue;
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        const targetPath = args.Path || args.path || args.TargetFile || args.filePath || args.file_path;
        if (!targetPath) continue;
        const hasArtifactMeta = Boolean(args.ArtifactMetadata || args.artifactMetadata);
        if (hasArtifactMeta || isArtifactPath(targetPath, brainDir)) {
          addArtifact(targetPath);
        } else {
          const rel = normalizeWorkspaceRelPath(targetPath, projectDir);
          const key = rel.toLowerCase();
          if (rel && !editedSet.has(key) && editedFiles.length < maxFiles) {
            editedSet.add(key);
            editedFiles.push(rel);
          }
        }
      }
    }
  }

  // Also discover top-level markdown artifacts inside brain/<convId>/ (e.g. implementation_plan.md, walkthrough.md)
  if (brainDir && fs.existsSync(brainDir)) {
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
        addArtifact(path.join(brainDir, e.name));
      }
    } catch {
      // ignore
    }
  }

  const recentUserRequests = userRequests.slice(-maxRequests);
  const latestUserRequest = recentUserRequests[recentUserRequests.length - 1] || '';

  return {
    latestUserRequest,
    recentUserRequests,
    editedFiles,
    artifacts: [...artifactMap.values()],
  };
}
