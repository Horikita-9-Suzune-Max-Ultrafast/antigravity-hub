import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, findTranscriptPath } from './paths.mjs';
import { loadConfig, estimateCallCostUsd, getModelLimit } from './config.mjs';
import { atomicWriteFile, atomicWriteJson, appendJsonl, ensureDataDirs, readJsonSafe } from './storage.mjs';
import { ensureIndexReady, upsertCallRow, withIndexDb } from './index-db.mjs';
import {
  discoverSubagentIds,
  listConversations,
  parseTranscriptIncremental,
} from './transcript-parser.mjs';

const TELEMETRY_REPORT_TTL_MS = 1_500;
const TELEMETRY_REPORT_CACHE_MAX = 24;
const TIMINGS_COMPACT_MAX_LINES = 500;
const TIMINGS_COMPACT_SIZE_HINT = 32_768;

const telemetryReportCache = new Map();
const timingsMapCache = new Map();

export function clearTelemetryCache() {
  telemetryReportCache.clear();
  timingsMapCache.clear();
}

function safeStatSig(filePath) {
  if (!filePath) return '-';
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

function getTimingsLogPath(paths) {
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

function loadTimingsMap(paths) {
  const logPath = getTimingsLogPath(paths);
  const legacyPath = paths.timingsFile;
  const sig = `${safeStatSig(logPath)}|${safeStatSig(legacyPath)}`;
  const cacheKey = path.resolve(logPath).toLowerCase();

  const cached = timingsMapCache.get(cacheKey);
  if (cached && cached.sig === sig) {
    return cached.map;
  }

  const map = {};
  // Backward compatibility: load legacy timings.json if present
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

  // Replay lightweight append-only timings.jsonl
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

  if (timingsMapCache.size > 16) {
    const oldest = timingsMapCache.keys().next().value;
    if (oldest !== undefined) timingsMapCache.delete(oldest);
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

  // Keep latest 100 conversations and at most 200 samples per conversation
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
 * Resolve quota group id for a model name based on config.quotaGroups.
 */
export function resolveQuotaGroup(modelName, config) {
  const name = String(modelName || '').toLowerCase();
  const groups = config?.quotaGroups || [];
  for (const g of groups) {
    const inc = g.includePattern ? new RegExp(g.includePattern, 'i') : null;
    const exc = g.excludePattern ? new RegExp(g.excludePattern, 'i') : null;
    if (inc && inc.test(name) && (!exc || !exc.test(name))) {
      return g.id;
    }
  }
  return groups[0]?.id || 'gemini';
}

/**
 * Record PreInvocation or PostInvocation hook timestamp for exact hook_ms TPS calculation.
 * Uses O(1) append-only timings.jsonl with lazy compaction (>500 lines) instead of full timings.json rewrites.
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
  telemetryReportCache.clear();
  return rec;
}

/**
 * Match a hook_ms timing sample near a transcript step's timestamp (1-to-1 consumption).
 * Transcript `created_at` has 1s granularity marking step start, so match `startMs` first
 * to avoid stealing the previous step's `endMs` when two steps occur within the same second.
 */
function findHookTimingMs(timingsEntry, stepTsMs, usedSampleIndices = null) {
  if (!timingsEntry || !Array.isArray(timingsEntry.samples) || !stepTsMs) return null;
  const samples = timingsEntry.samples;
  let bestStartIdx = -1;
  let bestStartDist = Infinity;

  for (let i = 0; i < samples.length; i++) {
    if (usedSampleIndices && usedSampleIndices.has(i)) continue;
    const s = samples[i];
    const startDist = Math.abs(s.startMs - stepTsMs);
    if (startDist <= 30_000 && startDist < bestStartDist) {
      bestStartIdx = i;
      bestStartDist = startDist;
    }
  }

  // Prefer startMs when within 5s (covers 1s transcript truncation + hook dispatch jitter)
  if (bestStartIdx !== -1 && bestStartDist <= 5_000) {
    if (usedSampleIndices) usedSampleIndices.add(bestStartIdx);
    return samples[bestStartIdx].durationMs;
  }

  // Fallback to endMs only if no startMs matched closely (legacy/end-stamped transcripts)
  let bestEndIdx = -1;
  let bestEndDist = Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (usedSampleIndices && usedSampleIndices.has(i)) continue;
    const s = samples[i];
    const endDist = Math.abs(s.endMs - stepTsMs);
    if (endDist <= 2_000 && endDist < bestEndDist) {
      bestEndIdx = i;
      bestEndDist = endDist;
    }
  }

  const chosenIdx = bestEndIdx !== -1 ? bestEndIdx : bestStartIdx;
  if (chosenIdx === -1) return null;
  if (usedSampleIndices) usedSampleIndices.add(chosenIdx);
  return samples[chosenIdx].durationMs;
}

/**
 * Split real outputTokens into thinkingTokensEst and contentTokensEst proportionally.
 */
function splitOutputTokens(outputTokens, thinkingText, contentText, toolCalls) {
  const total = Math.max(0, Number(outputTokens) || 0);
  if (total === 0) return { thinkingTokensEst: 0, contentTokensEst: 0 };
  const thinkLen = (thinkingText || '').length;
  const toolLen = Array.isArray(toolCalls) && toolCalls.length ? JSON.stringify(toolCalls).length : 0;
  const contentLen = (contentText || '').length + toolLen;
  if (thinkLen === 0 && contentLen === 0) {
    return { thinkingTokensEst: 0, contentTokensEst: total };
  }
  const ratio = thinkLen / (thinkLen + contentLen);
  const thinkingTokensEst = Math.round(total * ratio);
  const contentTokensEst = Math.max(0, total - thinkingTokensEst);
  return { thinkingTokensEst, contentTokensEst };
}

/**
 * Estimate duration and timingSource using dual/triple-source strategy:
 * 1) hook_ms (exact PreInvocation->PostInvocation)
 * 2) reportedDurationMs (if transcript adds native duration_ms)
 * 3) hybrid_tool_split (step[i+1].tsMs - step[i].tsMs when next step is tool output or model response)
 * 4) transcript_fallback (delta from previous step or conservative estimate)
 */
function computeStepDuration(steps, idx, timingsEntry, usedSampleIndices = null) {
  const cur = steps[idx];
  const hookMs = findHookTimingMs(timingsEntry, cur.tsMs, usedSampleIndices);
  if (hookMs != null) {
    return { durationMs: hookMs, timingSource: 'hook_ms' };
  }
  if (cur.reportedDurationMs != null && cur.reportedDurationMs >= 100) {
    return { durationMs: cur.reportedDurationMs, timingSource: 'hook_ms' };
  }

  const next = steps[idx + 1];
  if (next && cur.tsMs > 0 && next.tsMs > cur.tsMs) {
    const delta = next.tsMs - cur.tsMs;
    if (delta >= 200 && delta <= 180_000) {
      const source = cur.toolCalls.length > 0 ? 'hybrid_tool_split' : 'transcript_fallback';
      return { durationMs: delta, timingSource: source };
    }
  }

  const prev = steps[idx - 1];
  if (prev && cur.tsMs > 0 && prev.tsMs > 0 && cur.tsMs > prev.tsMs) {
    const delta = cur.tsMs - prev.tsMs;
    if (delta >= 200 && delta <= 180_000) {
      return { durationMs: delta, timingSource: 'transcript_fallback' };
    }
  }

  // Fallback conservative duration proportional to output tokens (~60 tok/s baseline)
  const fallbackMs = Math.max(800, Math.round(((cur.outputTokens || 60) / 60) * 1000));
  return { durationMs: fallbackMs, timingSource: 'transcript_fallback' };
}

/**
 * Detect cache drop relative to the previous call of the same agent.
 */
function evaluateCacheDrop(prev, cur, thresholdPct) {
  if (!prev) return { cacheDrop: false, dropReason: null, dropDetail: null };

  const dropDelta = prev.cacheHitRate - cur.cacheHitRate;
  const isModelSwitchDrop = prev.model && cur.model && prev.model !== cur.model && cur.cacheHitRate < 25;
  const isLargeDrop = prev.cacheHitRate >= 50 && dropDelta >= thresholdPct;

  if (!isModelSwitchDrop && !isLargeDrop) {
    return { cacheDrop: false, dropReason: null, dropDetail: null };
  }

  const gapMs = cur.tsMs && prev.tsMs ? Math.max(0, cur.tsMs - prev.tsMs) : 0;
  const gapMin = Math.floor(gapMs / 60000);
  const gapSec = Math.floor((gapMs % 60000) / 1000);

  if (prev.model && cur.model && prev.model !== cur.model) {
    return {
      cacheDrop: true,
      dropReason: 'model_changed',
      dropDetail: `模型由 ${prev.model} 切换至 ${cur.model}，跨模型切换触发前缀缓存重建。`,
    };
  }
  if (gapMs >= 5 * 60 * 1000) {
    return {
      cacheDrop: true,
      dropReason: 'idle_ttl_expired',
      dropDetail: `距上一步 #${prev.stepIndex} 间隔 ${gapMin}m ${gapSec}s，前缀缓存由 ${prev.cacheHitRate.toFixed(1)}% 骤降至 ${cur.cacheHitRate.toFixed(1)}%，疑似超出前缀缓存 TTL。`,
    };
  }
  if (prev.contextTokens > 0 && cur.contextTokens < prev.contextTokens * 0.75) {
    return {
      cacheDrop: true,
      dropReason: 'context_compacted_or_reset',
      dropDetail: `上下文由 ${Math.round(prev.contextTokens / 1000)}K 回落至 ${Math.round(cur.contextTokens / 1000)}K，疑似发生对话压缩或历史重置。`,
    };
  }
  return {
    cacheDrop: true,
    dropReason: 'prefix_mutated_unknown',
    dropDetail: `前缀缓存由 ${prev.cacheHitRate.toFixed(1)}% 降至 ${cur.cacheHitRate.toFixed(1)}%，系统前缀或工具列表可能发生变更。`,
  };
}

function compactTailSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  return steps.slice(-6).map((s) => {
    const invokeCalls = Array.isArray(s.toolCalls)
      ? s.toolCalls.filter((tc) => {
          const name = String(tc?.name || tc?.tool || '').toLowerCase();
          return name === 'invoke_subagent' || name.endsWith('invoke_subagent');
        })
      : [];
    const rawContent = typeof s.content === 'string' ? s.content : '';
    const keepContent =
      rawContent && /conversationid|conversation_id|conversation:\/\/|subagent|launched/i.test(rawContent)
        ? rawContent.slice(0, 320)
        : '';
    return {
      stepIndex: s.stepIndex,
      type: s.type,
      tsMs: s.tsMs,
      mediaCount: s.mediaCount || 0,
      toolCalls: invokeCalls,
      content: keepContent,
    };
  });
}

function compactLastCall(call) {
  if (!call) return null;
  return {
    model: call.model,
    tsMs: call.tsMs,
    stepIndex: call.stepIndex,
    cacheHitRate: call.cacheHitRate,
    contextTokens: call.contextTokens,
  };
}

/**
 * Build normalized telemetry call records from parsed steps (full or incremental slice).
 * When startIdx > 0, preceding steps[0..startIdx-1] provide lookbehind context (prevStep / media / tsMs).
 */
function buildCallsFromSteps({
  steps,
  startIdx = 0,
  initialPrevCall = null,
  conversationId,
  rootConversationId,
  agentType,
  agentTag,
  config,
  timingsMap,
}) {
  const timingsEntry = timingsMap[conversationId];
  const usedSampleIndices = new Set();
  const calls = [];
  let prev = initialPrevCall || null;

  for (let i = startIdx; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'PLANNER_RESPONSE') continue;
    if (step.inputTokens === 0 && step.cacheReadTokens === 0 && step.outputTokens === 0) continue;

    const contextTokens = step.inputTokens + step.cacheReadTokens;
    const { durationMs, timingSource } = computeStepDuration(steps, i, timingsEntry, usedSampleIndices);
    const effectiveTps = durationMs > 0 ? Number((step.outputTokens / (durationMs / 1000)).toFixed(2)) : 0;
    const cacheHitRate = contextTokens > 0 ? Number(((step.cacheReadTokens / contextTokens) * 100).toFixed(2)) : 0;
    const { thinkingTokensEst, contentTokensEst } = splitOutputTokens(
      step.outputTokens,
      step.thinking,
      step.content,
      step.toolCalls
    );
    const estimatedCostUsd = estimateCallCostUsd(
      {
        model: step.model,
        inputTokens: step.inputTokens,
        cacheReadTokens: step.cacheReadTokens,
        outputTokens: step.outputTokens,
      },
      config
    );

    const prevStep = i > 0 ? steps[i - 1] : null;
    const hasRecentMedia = Boolean((step.mediaCount || 0) > 0 || (prevStep && (prevStep.mediaCount || 0) > 0));
    const baseCall = {
      callUid: `${conversationId}:${step.stepIndex}`,
      conversationId,
      rootConversationId,
      agentType,
      agentTag,
      stepIndex: step.stepIndex,
      model: step.model || 'unknown',
      createdAt: step.createdAt || new Date().toISOString(),
      tsMs: step.tsMs || Date.now(),
      durationMs: Number(durationMs.toFixed(1)),
      timingSource,
      ttftMs: step.ttftMs,
      inputTokens: step.inputTokens,
      cacheReadTokens: step.cacheReadTokens,
      outputTokens: step.outputTokens,
      contextTokens,
      thinkingTokensEst,
      contentTokensEst,
      effectiveTps,
      cacheHitRate,
      estimatedCostUsd,
      quotaGroup: resolveQuotaGroup(step.model, config),
      toolCallCount: Array.isArray(step.toolCalls) ? step.toolCalls.length : 0,
      hasMedia: hasRecentMedia,
    };

    const drop = evaluateCacheDrop(prev, baseCall, config.alerts.cacheDropThresholdPct);
    const fullCall = { ...baseCall, ...drop };
    calls.push(fullCall);
    prev = fullCall;
  }

  return { calls, lastCall: prev ? compactLastCall(prev) : initialPrevCall };
}

/**
 * Incrementally (or full-fallback) parse a single transcript file into new/updated calls + updated cursor state.
 */
function parseTranscriptForSync({
  transcriptPath,
  conversationId,
  rootConversationId,
  agentType,
  agentTag,
  prevState,
  canIncremental,
  config,
  timingsMap,
}) {
  const stat = fs.statSync(transcriptPath);
  const prevOffset = Number(prevState?.offset) || 0;
  const useIncremental =
    Boolean(canIncremental) && prevOffset > 0 && prevOffset <= stat.size;

  if (useIncremental && prevOffset === stat.size) {
    return {
      mode: 'skip',
      size: stat.size,
      offset: prevOffset,
      stepsForSubDiscovery: [],
      calls: [],
      lastCall: prevState?.lastCall || null,
      tailSteps: Array.isArray(prevState?.tailSteps) ? prevState.tailSteps : [],
    };
  }

  if (useIncremental) {
    const inc = parseTranscriptIncremental(transcriptPath, prevOffset);
    const tail = Array.isArray(prevState?.tailSteps) ? prevState.tailSteps : [];
    const combinedSteps = [...tail, ...inc.steps];
    const built = buildCallsFromSteps({
      steps: combinedSteps,
      startIdx: tail.length,
      initialPrevCall: prevState?.lastCall || null,
      conversationId,
      rootConversationId,
      agentType,
      agentTag,
      config,
      timingsMap,
    });
    return {
      mode: 'incremental',
      size: stat.size,
      offset: inc.nextOffset,
      stepsForSubDiscovery: combinedSteps,
      calls: built.calls,
      lastCall: built.lastCall,
      tailSteps: compactTailSteps(combinedSteps),
    };
  }

  // Full parse fallback (force, missing cursor, file shrank/rotated, or empty DB)
  const full = parseTranscriptIncremental(transcriptPath, 0);
  const built = buildCallsFromSteps({
    steps: full.steps,
    startIdx: 0,
    initialPrevCall: null,
    conversationId,
    rootConversationId,
    agentType,
    agentTag,
    config,
    timingsMap,
  });
  return {
    mode: 'full',
    size: stat.size,
    offset: full.nextOffset,
    stepsForSubDiscovery: full.steps,
    calls: built.calls,
    lastCall: built.lastCall,
    tailSteps: compactTailSteps(full.steps),
  };
}

/**
 * Sync a main conversation + all discovered subagents into JSONL truth source & SQLite index.
 * Uses true byte-offset incremental parsing (parseTranscriptIncremental) when transcript grows,
 * falling back to full parse on force, file shrink/rotation, or empty DB.
 */
export function syncConversationTelemetry({ conversationId, transcriptPath, force = false }, options = {}) {
  const paths = ensureDataDirs(options);
  ensureIndexReady(options);
  const config = loadConfig(options);

  let resolvedPath = transcriptPath;
  let resolvedId = conversationId;
  if (!resolvedPath && resolvedId) {
    resolvedPath = findTranscriptPath(resolvedId, options);
  }
  if (!resolvedPath && !resolvedId) {
    const convs = listConversations({ ...options, limit: 1 });
    if (convs[0]) {
      resolvedId = convs[0].conversationId;
      resolvedPath = convs[0].transcriptPath;
    }
  }
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return { conversationId: resolvedId || null, calls: [], subagents: [], syncedNew: 0 };
  }
  if (!resolvedId) {
    // Derive conversationId from path .../brain/<id>/.system_generated/logs/transcript.jsonl
    const parts = resolvedPath.split(/[\\/]/);
    const brainIdx = parts.lastIndexOf('brain');
    resolvedId = brainIdx >= 0 && parts[brainIdx + 1] ? parts[brainIdx + 1] : 'default';
  }

  const cursors = readJsonSafe(paths.cursorsFile, {});
  const timingsMap = loadTimingsMap(paths);

  const mainStat = fs.statSync(resolvedPath);
  const prevCursor = cursors[resolvedId] || { size: -1, offset: 0, subagents: [] };
  let needsSync = force || prevCursor.size !== mainStat.size || (Number(prevCursor.offset) || 0) !== mainStat.size;

  if (!needsSync && Array.isArray(prevCursor.subagents)) {
    for (const sub of prevCursor.subagents) {
      if (sub.path && fs.existsSync(sub.path)) {
        const subSz = fs.statSync(sub.path).size;
        if (subSz !== sub.size || (Number(sub.offset) || 0) !== subSz) {
          needsSync = true;
          break;
        }
      }
    }
  }

  // Always check DB state in case DB was rebuilt/wiped
  const existingDbCalls = queryCalls({ rootConversationId: resolvedId }, options);
  const hasExistingDbRows = existingDbCalls.length > 0;

  if (!needsSync && hasExistingDbRows) {
    return {
      conversationId: resolvedId,
      calls: existingDbCalls,
      subagents: prevCursor.subagents || [],
      syncedNew: 0,
    };
  }

  const canIncrementalMain =
    !force &&
    hasExistingDbRows &&
    Number(prevCursor.offset) > 0 &&
    Number(prevCursor.offset) <= mainStat.size;

  const mainRes = parseTranscriptForSync({
    transcriptPath: resolvedPath,
    conversationId: resolvedId,
    rootConversationId: resolvedId,
    agentType: 'main',
    agentTag: '主',
    prevState: prevCursor,
    canIncremental: canIncrementalMain,
    config,
    timingsMap,
  });

  // Merge previously known subagents with any newly discovered subagents
  const prevSubMap = new Map();
  const orderedSubIds = [];
  if (mainRes.mode !== 'full' && Array.isArray(prevCursor.subagents)) {
    for (const s of prevCursor.subagents) {
      if (!s?.conversationId) continue;
      const lower = s.conversationId.toLowerCase();
      if (!prevSubMap.has(lower)) {
        prevSubMap.set(lower, s);
        orderedSubIds.push(s.conversationId);
      }
    }
  }
  const discoveredSubs = discoverSubagentIds(mainRes.stepsForSubDiscovery, resolvedId);
  for (const sid of discoveredSubs) {
    const lower = sid.toLowerCase();
    if (!prevSubMap.has(lower)) {
      prevSubMap.set(lower, null);
      orderedSubIds.push(sid);
    }
  }

  const callsToUpsert = [...mainRes.calls];
  const subMeta = [];

  orderedSubIds.forEach((subId, idx) => {
    const prevSub = prevSubMap.get(subId.toLowerCase()) || null;
    const subPath = prevSub?.path && fs.existsSync(prevSub.path) ? prevSub.path : findTranscriptPath(subId, options);
    const tag = prevSub?.tag || `子${idx + 1}`;
    if (!subPath || !fs.existsSync(subPath)) {
      subMeta.push({ conversationId: subId, tag, path: null, size: 0, offset: 0 });
      return;
    }
    const subStat = fs.statSync(subPath);
    const canIncrementalSub =
      !force &&
      hasExistingDbRows &&
      Number(prevSub?.offset) > 0 &&
      Number(prevSub?.offset) <= subStat.size;

    const subRes = parseTranscriptForSync({
      transcriptPath: subPath,
      conversationId: subId,
      rootConversationId: resolvedId,
      agentType: 'sub',
      agentTag: tag,
      prevState: prevSub,
      canIncremental: canIncrementalSub,
      config,
      timingsMap,
    });
    subMeta.push({
      conversationId: subId,
      tag,
      path: subPath,
      size: subRes.size,
      offset: subRes.offset,
      lastCall: subRes.lastCall,
      tailSteps: subRes.tailSteps,
    });
    if (subRes.calls.length > 0) {
      callsToUpsert.push(...subRes.calls);
    }
  });

  // Upsert ONLY newly parsed/updated calls in a single SQLite transaction
  let syncedNew = 0;
  if (callsToUpsert.length > 0) {
    withIndexDb(options, (db) => {
      const rows = db.prepare('SELECT call_uid FROM calls WHERE root_conversation_id = ?').all(resolvedId);
      const existingUids = new Set(rows.map((r) => r.call_uid));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const c of callsToUpsert) {
          if (!existingUids.has(c.callUid)) {
            appendJsonl(paths.callsLogFile, c);
            existingUids.add(c.callUid);
            syncedNew++;
          }
          upsertCallRow(db, c);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  cursors[resolvedId] = {
    size: mainRes.size,
    offset: mainRes.offset,
    lastCall: mainRes.lastCall,
    tailSteps: mainRes.tailSteps,
    updatedAt: new Date().toISOString(),
    subagents: subMeta,
  };
  atomicWriteJson(paths.cursorsFile, cursors);

  // If full sync with no skipped subagents, we already have all calls in memory (including transient hasMedia/toolCallCount).
  // Otherwise merge updated calls with DB rows cleanly.
  let finalCalls;
  if (mainRes.mode === 'full' && !subMeta.some((s) => s.path && s.size > 0 && !callsToUpsert.some((c) => c.conversationId === s.conversationId))) {
    finalCalls = [...callsToUpsert].sort((a, b) => b.tsMs - a.tsMs || b.stepIndex - a.stepIndex);
  } else {
    const dbCalls = queryCalls({ rootConversationId: resolvedId }, options);
    const enriched = new Map(callsToUpsert.map((c) => [c.callUid, c]));
    finalCalls = dbCalls.map((r) => {
      const fresh = enriched.get(r.callUid);
      return fresh ? { ...r, hasMedia: fresh.hasMedia, toolCallCount: fresh.toolCallCount } : r;
    });
  }

  return {
    conversationId: resolvedId,
    calls: finalCalls,
    subagents: subMeta,
    syncedNew,
  };
}

function rowToCall(r) {
  return {
    callUid: r.call_uid,
    conversationId: r.conversation_id,
    rootConversationId: r.root_conversation_id,
    agentType: r.agent_type,
    agentTag: r.agent_tag,
    stepIndex: r.step_index,
    model: r.model,
    createdAt: r.created_at,
    tsMs: r.ts_ms,
    durationMs: r.duration_ms,
    timingSource: r.timing_source,
    ttftMs: r.ttft_ms,
    inputTokens: r.input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    outputTokens: r.output_tokens,
    contextTokens: r.context_tokens,
    thinkingTokensEst: r.thinking_tokens_est,
    contentTokensEst: r.content_tokens_est,
    effectiveTps: r.effective_tps,
    cacheHitRate: r.cache_hit_rate,
    cacheDrop: Boolean(r.cache_drop),
    dropReason: r.drop_reason,
    dropDetail: r.drop_detail,
    estimatedCostUsd: r.estimated_cost_usd,
    quotaGroup: r.quota_group,
  };
}

export function queryCalls(filters = {}, options = {}) {
  ensureIndexReady(options);
  return withIndexDb(options, (db) => {
    const clauses = [];
    const args = [];
    if (filters.rootConversationId) {
      clauses.push('root_conversation_id = ?');
      args.push(filters.rootConversationId);
    }
    if (filters.agentType && filters.agentType !== 'all') {
      clauses.push('agent_type = ?');
      args.push(filters.agentType);
    }
    if (filters.model && filters.model !== 'all') {
      clauses.push('model = ?');
      args.push(filters.model);
    }
    if (filters.onlyDrop) {
      clauses.push('cache_drop = 1');
    }
    if (filters.sinceMs) {
      clauses.push('ts_ms >= ?');
      args.push(Number(filters.sinceMs));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(2000, Number(filters.limit) || 500));
    args.push(limit);
    const rows = db.prepare(`SELECT * FROM calls ${where} ORDER BY ts_ms DESC, step_index DESC LIMIT ?`).all(...args);
    return rows.map(rowToCall);
  });
}

/**
 * Evaluate 4 classes of local anomaly alerts (0 model tokens):
 * 1) Context > threshold%
 * 2) Recent cache drop
 * 3) Single subagent high context/cost share
 * 4) Consecutive low TPS streak (< 15 tok/s for 3+ steps)
 */
export function evaluateAlerts(calls, config, contextPct = null) {
  const alerts = [];
  if (!Array.isArray(calls) || calls.length === 0) return alerts;

  const mainCalls = calls.filter((c) => c.agentType === 'main');
  const latestMain = mainCalls[0] || calls[0];
  const limit = getModelLimit(latestMain?.model, config);
  const pct = contextPct != null ? contextPct : latestMain && limit > 0 ? (latestMain.contextTokens / limit) * 100 : 0;

  // 1. Context warning
  if (pct >= config.alerts.contextWarningPct) {
    const freeK = Math.max(0, limit - (latestMain?.contextTokens || 0)) / 1000;
    alerts.push({
      code: 'context_high',
      level: 'warning',
      title: `上下文占用 ${pct.toFixed(1)}%，已超过 ${config.alerts.contextWarningPct}% 警戒线`,
      detail: `剩余空间约 ${freeK.toFixed(1)}K，建议先生成交接胶囊沉淀核心决策再执行 /compact。`,
    });
  }

  // 2. Recent cache drops (last 10 calls)
  const recentDrops = calls.slice(0, 10).filter((c) => c.cacheDrop);
  for (const d of recentDrops.slice(0, 2)) {
    alerts.push({
      code: 'cache_drop',
      level: 'error',
      title: `步骤 [${d.agentTag}] #${d.stepIndex} 发生缓存击穿（命中 ${d.cacheHitRate.toFixed(1)}%）`,
      detail: d.dropDetail || `归因：${d.dropReason}`,
    });
  }

  // 3. Subagent burst / high consumption
  const totalCost = calls.reduce((s, c) => s + c.estimatedCostUsd, 0);
  const bySub = new Map();
  for (const c of calls) {
    if (c.agentType !== 'sub') continue;
    const g = bySub.get(c.agentTag) || { tag: c.agentTag, steps: 0, maxCtx: 0, cost: 0 };
    g.steps++;
    g.maxCtx = Math.max(g.maxCtx, c.contextTokens);
    g.cost += c.estimatedCostUsd;
    bySub.set(c.agentTag, g);
  }
  for (const sub of bySub.values()) {
    const sharePct = totalCost > 0 ? (sub.cost / totalCost) * 100 : 0;
    if (sub.maxCtx >= config.alerts.subagentContextWarnTokens || sharePct >= config.alerts.subagentShareThresholdPct) {
      alerts.push({
        code: 'subagent_burst',
        level: 'warning',
        title: `子 Agent [${sub.tag}] 上下文达 ${(sub.maxCtx / 1000).toFixed(1)}K`,
        detail: `${sub.steps} 步累计估算 $${sub.cost.toFixed(3)}（占会话费用 ${sharePct.toFixed(0)}%），建议关注子任务收敛。`,
      });
    }
  }

  // 4. Consecutive low TPS streak
  const streakNeed = config.alerts.lowTpsStreak || 3;
  const lowThresh = config.alerts.lowTpsThreshold || 15;
  const chronological = [...calls].reverse();
  let streak = 0;
  let maxStreak = 0;
  for (const c of chronological) {
    if (c.effectiveTps > 0 && c.effectiveTps < lowThresh) {
      streak++;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
  }
  if (maxStreak >= streakNeed) {
    alerts.push({
      code: 'low_tps_streak',
      level: 'warning',
      title: `检测到连续 ${maxStreak} 步低速输出（< ${lowThresh} tok/s）`,
      detail: '可能受模型队列拥堵或上下文过长影响，建议切换轻量模型或压缩对话。',
    });
  }

  // 5. Long-context media / image cache hygiene risk (read-only)
  const mediaDrop = calls.slice(0, 12).find((c) => c.hasMedia && c.contextTokens >= 150000 && c.cacheDrop);
  if (mediaDrop) {
    alerts.push({
      code: 'long_ctx_media_cache_risk',
      level: 'warning',
      title: `长上下文（${Math.round(mediaDrop.contextTokens / 1000)}K）媒体注入伴随缓存击穿`,
      detail: `步骤 [${mediaDrop.agentTag}] #${mediaDrop.stepIndex} 在高上下文中注入图片/媒体后缓存命中骤降至 ${mediaDrop.cacheHitRate.toFixed(1)}%，建议将图片查看委托给子代理返回纯文本结论。`,
    });
  }

  // 6. Micro-step inefficiency streak (many consecutive low-output single-tool turns)
  let microStreak = 0;
  let maxMicroStreak = 0;
  for (const c of chronological) {
    if (c.agentType === 'main' && c.outputTokens > 0 && c.outputTokens < 220 && (c.toolCallCount === 1 || c.toolCallCount === 0)) {
      microStreak++;
      if (microStreak > maxMicroStreak) maxMicroStreak = microStreak;
    } else {
      microStreak = 0;
    }
  }
  if (maxMicroStreak >= 5) {
    alerts.push({
      code: 'micro_step_streak',
      level: 'info',
      title: `检测到连续 ${maxMicroStreak} 轮碎步小调用（每轮 < 220 out tokens）`,
      detail: '高频单步往返会重复支付每轮固定首字等待（TTFT），建议并行合并只读搜索或批量编辑。',
    });
  }

  return alerts;
}

/**
 * Compute token-weighted average TPS: sum(outputTokens) / sum(durationSec).
 * Avoids short low-token tool steps skewing overall throughput downward.
 */
function calcWeightedAvgTps(calls) {
  if (!calls || !calls.length) return 0;
  let totalOut = 0;
  let totalMs = 0;
  for (const c of calls) {
    totalOut += Math.max(0, Number(c.outputTokens) || 0);
    totalMs += Math.max(0, Number(c.durationMs) || 0);
  }
  if (totalMs > 0 && totalOut > 0) {
    return Number((totalOut / (totalMs / 1000)).toFixed(1));
  }
  return Number((calls.reduce((s, c) => s + (c.effectiveTps || 0), 0) / calls.length).toFixed(1));
}

function buildReportFingerprint(paths, watchedPaths) {
  const parts = [
    safeStatSig(getTimingsLogPath(paths)),
    safeStatSig(paths.timingsFile),
    safeStatSig(paths.cursorsFile),
  ];
  for (const wp of watchedPaths) {
    parts.push(`${wp}:${safeStatSig(wp)}`);
  }
  return parts.join('|');
}

function applyReportFilters(baseReport, params = {}) {
  const allCalls = baseReport.allCalls;
  const filtered = allCalls.filter((c) => {
    if (params.agentFilter && params.agentFilter !== 'all' && c.agentType !== params.agentFilter) return false;
    if (params.modelFilter && params.modelFilter !== 'all' && c.model !== params.modelFilter) return false;
    if (params.onlyDrop && !c.cacheDrop) return false;
    return true;
  });
  return {
    conversationId: baseReport.conversationId,
    calls: filtered,
    totalCallsCount: baseReport.totalCallsCount,
    models: baseReport.models,
    subagents: baseReport.subagents,
    summary: baseReport.summary,
    alerts: baseReport.alerts,
    banner: baseReport.banner,
  };
}

/**
 * Summarize telemetry calls for UI `明细` tab and KPI strip.
 * Cached for 1.5s (invalidated immediately on transcript/timings/cursor change or force: true)
 * so inspectContext + app_get_calls in the same refresh cycle share one computation.
 */
export function getTelemetryReport(params = {}, options = {}) {
  const paths = getDataPaths(options);
  const cacheKey = `${paths.dataDir.toLowerCase()}|${String(options.appDataDir || '').toLowerCase()}|${String(params.conversationId || '')}|${String(params.transcriptPath || '')}`;
  const now = Date.now();

  if (!params.force) {
    const cached = telemetryReportCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      const curFp = buildReportFingerprint(paths, cached.watchedPaths);
      if (curFp === cached.fingerprint) {
        return applyReportFilters(cached.baseReport, params);
      }
    }
  }

  const config = loadConfig(options);
  const recentConvs = listConversations({ ...options, limit: 25, includeRecentSubagents: true });
  const convLabelMap = new Map(recentConvs.map((c) => [c.conversationId, c.label || c.conversationId.slice(0, 8)]));
  const watchedPaths = new Set();

  let synced;
  if (params.conversationId === '__active_all__') {
    const nowMs = Date.now();
    const activeWindowMs = 15 * 60 * 1000;
    let activeList = recentConvs.filter((c) => nowMs - (c.mtimeMs || 0) <= activeWindowMs);
    if (!activeList.length) activeList = recentConvs.slice(0, 3);
    const mergedMap = new Map();
    const mergedSubs = [];
    for (const conv of activeList) {
      if (conv.transcriptPath) watchedPaths.add(conv.transcriptPath);
      const res = syncConversationTelemetry(
        { conversationId: conv.conversationId, transcriptPath: conv.transcriptPath, force: Boolean(params.force) },
        options
      );
      for (const c of res.calls) {
        if (!mergedMap.has(c.callUid)) mergedMap.set(c.callUid, c);
      }
      if (Array.isArray(res.subagents)) {
        for (const s of res.subagents) {
          if (s?.path) watchedPaths.add(s.path);
          mergedSubs.push(s);
        }
      }
    }
    const mergedCalls = [...mergedMap.values()].sort((a, b) => b.tsMs - a.tsMs || b.stepIndex - a.stepIndex);
    synced = {
      conversationId: '__active_all__',
      calls: mergedCalls,
      subagents: mergedSubs,
      syncedNew: 0,
    };
  } else {
    const resolvedTPath =
      params.transcriptPath ||
      (params.conversationId ? findTranscriptPath(params.conversationId, options) : recentConvs[0]?.transcriptPath);
    if (resolvedTPath) watchedPaths.add(resolvedTPath);
    synced = syncConversationTelemetry(
      {
        conversationId: params.conversationId,
        transcriptPath: params.transcriptPath,
        force: Boolean(params.force),
      },
      options
    );
    for (const s of synced.subagents || []) {
      if (s?.path) watchedPaths.add(s.path);
    }
  }

  const allCalls = synced.calls.map((c) => {
    const convLabel = convLabelMap.get(c.conversationId) || c.conversationId.slice(0, 8);
    const shortId = String(c.conversationId || '').slice(0, 8);
    const rolePrefix = c.agentType === 'sub' ? `子代理 ${c.agentTag}` : '主对话';
    return {
      ...c,
      sourceLabel: `${rolePrefix} · ${convLabel} (${shortId})`,
      sourceTitle: convLabel,
    };
  });

  const byAgentMap = new Map();
  const byModelMap = new Map();
  for (const c of allCalls) {
    const ag = byAgentMap.get(c.agentTag) || {
      agentTag: c.agentTag,
      agentType: c.agentType,
      steps: 0,
      outSum: 0,
      durSum: 0,
      cacheSum: 0,
      cost: 0,
      maxContext: 0,
      drops: 0,
    };
    ag.steps++;
    ag.outSum += c.outputTokens || 0;
    ag.durSum += c.durationMs || 0;
    ag.cacheSum += c.cacheHitRate;
    ag.cost += c.estimatedCostUsd;
    ag.maxContext = Math.max(ag.maxContext, c.contextTokens);
    if (c.cacheDrop) ag.drops++;
    byAgentMap.set(c.agentTag, ag);

    const md = byModelMap.get(c.model) || { model: c.model, steps: 0, outSum: 0, durSum: 0, cost: 0 };
    md.steps++;
    md.outSum += c.outputTokens || 0;
    md.durSum += c.durationMs || 0;
    md.cost += c.estimatedCostUsd;
    byModelMap.set(c.model, md);
  }

  const byAgent = [...byAgentMap.values()].map((a) => ({
    agentTag: a.agentTag,
    agentType: a.agentType,
    steps: a.steps,
    avgTps: a.durSum > 0 ? Number((a.outSum / (a.durSum / 1000)).toFixed(1)) : 0,
    avgCache: Number((a.cacheSum / a.steps).toFixed(1)),
    cost: Number(a.cost.toFixed(4)),
    maxContext: a.maxContext,
    drops: a.drops,
  }));

  const byModel = [...byModelMap.values()].map((m) => ({
    model: m.model,
    steps: m.steps,
    avgTps: m.durSum > 0 ? Number((m.outSum / (m.durSum / 1000)).toFixed(1)) : 0,
    cost: Number(m.cost.toFixed(4)),
  }));

  const latestMain = allCalls.find((c) => c.agentType === 'main') || allCalls[0] || null;
  const totalCost = allCalls.reduce((s, c) => s + c.estimatedCostUsd, 0);
  const avgTps = calcWeightedAvgTps(allCalls);

  const baseReport = {
    conversationId: synced.conversationId,
    allCalls,
    totalCallsCount: allCalls.length,
    models: [...byModelMap.keys()],
    subagents: synced.subagents,
    summary: {
      byAgent,
      byModel,
      totalCostUsd: Number(totalCost.toFixed(4)),
      avgTps: Number(avgTps.toFixed(1)),
      latestCacheHitRate: latestMain ? latestMain.cacheHitRate : 0,
      latestContextTokens: latestMain ? latestMain.contextTokens : 0,
      latestModel: latestMain ? latestMain.model : '',
    },
    alerts: evaluateAlerts(allCalls, config),
    banner: latestMain ? formatUserMarkdownBanner(latestMain) : '',
  };

  const watchedList = [...watchedPaths];
  const fingerprint = buildReportFingerprint(paths, watchedList);
  if (telemetryReportCache.has(cacheKey)) telemetryReportCache.delete(cacheKey);
  telemetryReportCache.set(cacheKey, {
    baseReport,
    watchedPaths: watchedList,
    fingerprint,
    expiresAt: Date.now() + TELEMETRY_REPORT_TTL_MS,
  });
  while (telemetryReportCache.size > TELEMETRY_REPORT_CACHE_MAX) {
    const oldest = telemetryReportCache.keys().next().value;
    if (oldest === undefined) break;
    telemetryReportCache.delete(oldest);
  }

  return applyReportFilters(baseReport, params);
}

/**
 * Format zero-model-token single-line status banner for PostInvocation metadata.user_markdown.
 */
export function formatUserMarkdownBanner(call) {
  if (!call) return '';
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const srcHint = call.timingSource === 'hook_ms' ? '' : ' (est)';
  const dropNote = call.cacheDrop ? ` · ⚠️ 击穿(${call.dropReason})` : '';
  return `⚡ ${call.effectiveTps.toFixed(1)} tok/s${srcHint} · Cache ${call.cacheHitRate.toFixed(1)}% (${fmtK(call.cacheReadTokens)}/${fmtK(call.contextTokens)}) · +${fmtK(call.inputTokens)} in / ${call.outputTokens} out · $${call.estimatedCostUsd.toFixed(3)}${dropNote}`;
}
