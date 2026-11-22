import fs from 'node:fs';
import path from 'node:path';
import { getCandidateAppDataDirs, findTranscriptPath } from './paths.mjs';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = parseAnnotationPbtxt(raw);
        if (parsed.title || parsed.lastViewMs > 0) return parsed;
      }
    } catch {
      // fail open if unreadable
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

/**
 * Parse a full transcript file from byte 0.
 */
export function parseTranscriptFull(filePath) {
  return parseTranscriptIncremental(filePath, 0).steps;
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

/**
 * Extract a concise human-readable label from a conversation's transcript.
 */
export function extractConversationMeta(filePath, conversationId, options = {}) {
  let label = conversationId.slice(0, 8);
  let promptLabel = '';
  let lastModel = '';
  let stepCount = 0;
  let lastUsedTokens = 0;
  let touchedFiles = [];

  const annotation = readConversationAnnotation(conversationId, options);

  try {
    const steps = parseTranscriptFull(filePath);
    stepCount = steps.length;
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
    if (annotation.title) {
      label = annotation.title;
    } else if (promptLabel) {
      label = promptLabel;
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
    touchedFiles = [...fileSet].slice(0, 8);
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

  // Identify subagent conversation IDs referenced by recent parent transcripts so main selector stays clean
  const subagentIds = new Set();
  const subagentParentMap = new Map();
  for (const c of candidates.slice(0, Math.min(candidates.length, 20))) {
    try {
      const steps = parseTranscriptFull(c.transcriptPath);
      const discovered = discoverSubagentIds(steps, c.conversationId);
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
  for (const c of candidates) {
    const lowerId = c.conversationId.toLowerCase();
    const isSub = subagentIds.has(lowerId);
    const isRecentSub = isSub && nowMs - c.mtimeMs <= recentSubagentWindowMs;
    if (isSub && !options.includeSubagents && !(options.includeRecentSubagents && isRecentSub)) continue;
    const meta = extractConversationMeta(c.transcriptPath, c.conversationId, options);
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
