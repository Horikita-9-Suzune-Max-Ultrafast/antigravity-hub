import fs from 'node:fs';
import path from 'node:path';
import { findTranscriptPath, getCandidateAppDataDirs } from '../paths.mjs';
import { loadConfig, estimateCallCostUsd } from '../config.mjs';
import { safeStatSig } from '../fs-utils.mjs';
import {
  atomicWriteFile,
  atomicWriteJson,
  appendJsonlBatch,
  ensureDataDirs,
  readJsonSafe,
  readJsonlSafe,
} from '../storage.mjs';
import { ensureIndexReady, prepareCached, rebuildIndex, upsertCallRow, withIndexDb } from '../index-db.mjs';
import { discoverSubagentIds, listConversations, parseTranscriptIncremental } from '../transcript-parser.mjs';
import { getNativeDbSignature, loadNativeStepMetrics } from '../native-step-metrics.mjs';
import { findHookTimingMatch, getTimingsLogPath, loadTimingsMap } from './timings-store.mjs';

const MAX_TOOL_SPAN_MS = 600_000;
const MAX_TRANSCRIPT_FALLBACK_MS = 180_000;
const MIN_DECODE_TPS_WINDOW_MS = 1_000;
const MIN_DECODE_TPS_TOKENS = 15;
const MAX_CURSORS_ENTRIES = 64;

const USER_BOUNDARY_STEP_TYPES = new Set(['USER_INPUT', 'SYSTEM_MESSAGE']);
const TIMING_SOURCE_PRIORITY = {
  estimated: 0,
  transcript_fallback: 1,
  hybrid_tool_split: 2,
  hook_ms: 3,
  native_db: 4,
};

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

export function rowToCall(r) {
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

/**
 * Query indexed calls from SQLite.
 * Pass `limit: 0` or `unlimited: true` (e.g. quota 7d window) to avoid the 500/2000 row cap.
 */
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
    const unlimited =
      filters.unlimited === true || filters.limit === 0 || filters.limit === null || filters.limit === Infinity;

    if (unlimited) {
      const sql = `SELECT * FROM calls ${where} ORDER BY ts_ms DESC, step_index DESC`;
      return prepareCached(db, sql).all(...args).map(rowToCall);
    }

    const limit = Math.max(1, Number(filters.limit) || 500);
    args.push(limit);
    const sql = `SELECT * FROM calls ${where} ORDER BY ts_ms DESC, step_index DESC LIMIT ?`;
    return prepareCached(db, sql).all(...args).map(rowToCall);
  });
}

/**
 * O(1) existence probe for indexed calls under a root conversation.
 */
export function hasCallsForRoot(rootConversationId, options = {}) {
  if (!rootConversationId) return false;
  return withIndexDb(options, (db) => {
    const row = prepareCached(db, 'SELECT 1 AS hit FROM calls WHERE root_conversation_id = ? LIMIT 1').get(
      rootConversationId
    );
    return Boolean(row);
  });
}

function pruneCursorsLru(cursors, maxEntries = MAX_CURSORS_ENTRIES) {
  const entries = Object.entries(cursors || {});
  if (entries.length <= maxEntries) return cursors;
  entries.sort((a, b) => {
    const ta = Date.parse(a[1]?.updatedAt || '') || 0;
    const tb = Date.parse(b[1]?.updatedAt || '') || 0;
    return tb - ta;
  });
  const pruned = {};
  for (const [k, v] of entries.slice(0, maxEntries)) {
    pruned[k] = v;
  }
  return pruned;
}

function computeToolGroupSpan(steps, idx) {
  const cur = steps[idx];
  const toolCount = Array.isArray(cur?.toolCalls) ? cur.toolCalls.length : 0;
  if (toolCount === 0 || !(cur.tsMs > 0)) {
    return { minTranscriptSpanMs: null, toolStepsFound: 0 };
  }

  let toolStepsFound = 0;
  let lastToolTsMs = 0;
  for (let j = idx + 1; j < steps.length && toolStepsFound < toolCount; j++) {
    const s = steps[j];
    if (!s) break;
    if (s.type === 'PLANNER_RESPONSE' || USER_BOUNDARY_STEP_TYPES.has(s.type)) {
      break;
    }
    toolStepsFound++;
    if (s.tsMs > cur.tsMs && s.tsMs > lastToolTsMs) {
      lastToolTsMs = s.tsMs;
    }
  }

  return {
    minTranscriptSpanMs: lastToolTsMs > cur.tsMs ? lastToolTsMs - cur.tsMs : null,
    toolStepsFound,
  };
}

function splitOutputTokens(outputTokens, thinkingText, contentText, toolCalls, metaLengths = null) {
  const total = Math.max(0, Number(outputTokens) || 0);
  if (total === 0) return { thinkingTokensEst: 0, contentTokensEst: 0 };
  const thinkLen =
    metaLengths && Number.isFinite(metaLengths.thinkingLen)
      ? metaLengths.thinkingLen
      : (thinkingText || '').length;
  const toolLen =
    metaLengths && Number.isFinite(metaLengths.toolCallsLen)
      ? metaLengths.toolCallsLen
      : Array.isArray(toolCalls) && toolCalls.length
        ? JSON.stringify(toolCalls).length
        : 0;
  const contentLen =
    (metaLengths && Number.isFinite(metaLengths.contentLen)
      ? metaLengths.contentLen
      : (contentText || '').length) + toolLen;
  if (thinkLen === 0 && contentLen === 0) {
    return { thinkingTokensEst: 0, contentTokensEst: total };
  }
  const ratio = thinkLen / (thinkLen + contentLen);
  const thinkingTokensEst = Math.round(total * ratio);
  const contentTokensEst = Math.max(0, total - thinkingTokensEst);
  return { thinkingTokensEst, contentTokensEst };
}

function computeStepDuration(steps, idx, timingsEntry, usedSampleIndices = null, nativeMetric = null) {
  const cur = steps[idx];
  const toolCount = Array.isArray(cur?.toolCalls) ? cur.toolCalls.length : 0;
  const { minTranscriptSpanMs, toolStepsFound } = computeToolGroupSpan(steps, idx);

  if (nativeMetric && Number.isFinite(nativeMetric.modelDurationMs) && nativeMetric.modelDurationMs >= 50) {
    return {
      durationMs: nativeMetric.modelDurationMs,
      ttftMs: nativeMetric.ttftMs ?? cur.ttftMs ?? null,
      decodeDurationMs: nativeMetric.decodeDurationMs ?? null,
      timingSource: 'native_db',
    };
  }

  const hookMatch = findHookTimingMatch(timingsEntry, cur.tsMs, usedSampleIndices);
  if (hookMatch != null) {
    const hookMs = hookMatch.durationMs;
    if (
      toolCount > 0 &&
      minTranscriptSpanMs != null &&
      minTranscriptSpanMs >= 1_000 &&
      minTranscriptSpanMs <= MAX_TOOL_SPAN_MS &&
      hookMs > minTranscriptSpanMs + 2_000
    ) {
      if (usedSampleIndices) usedSampleIndices.add(hookMatch.idx);
      return {
        durationMs: minTranscriptSpanMs,
        ttftMs: cur.ttftMs ?? null,
        decodeDurationMs: null,
        timingSource: 'hybrid_tool_split',
      };
    }
    if (minTranscriptSpanMs != null && minTranscriptSpanMs >= 3_000 && hookMs < minTranscriptSpanMs - 2_000) {
      if (minTranscriptSpanMs <= MAX_TOOL_SPAN_MS) {
        return {
          durationMs: minTranscriptSpanMs,
          ttftMs: cur.ttftMs ?? null,
          decodeDurationMs: null,
          timingSource: 'hybrid_tool_split',
        };
      }
    } else {
      if (usedSampleIndices) usedSampleIndices.add(hookMatch.idx);
      return {
        durationMs: hookMs,
        ttftMs: cur.ttftMs ?? null,
        decodeDurationMs: null,
        timingSource: 'hook_ms',
      };
    }
  }

  if (cur.reportedDurationMs != null && cur.reportedDurationMs >= 100) {
    return {
      durationMs: cur.reportedDurationMs,
      ttftMs: cur.ttftMs ?? null,
      decodeDurationMs: null,
      timingSource: 'hook_ms',
    };
  }

  if (toolCount > 0 && toolStepsFound > 0) {
    if (minTranscriptSpanMs != null && minTranscriptSpanMs >= 200 && minTranscriptSpanMs <= MAX_TOOL_SPAN_MS) {
      return {
        durationMs: minTranscriptSpanMs,
        ttftMs: cur.ttftMs ?? null,
        decodeDurationMs: null,
        timingSource: 'hybrid_tool_split',
      };
    }
  } else {
    const next = steps[idx + 1];
    if (next && !USER_BOUNDARY_STEP_TYPES.has(next.type) && cur.tsMs > 0 && next.tsMs > cur.tsMs) {
      const delta = next.tsMs - cur.tsMs;
      if (delta >= 200 && delta <= MAX_TRANSCRIPT_FALLBACK_MS) {
        return {
          durationMs: delta,
          ttftMs: cur.ttftMs ?? null,
          decodeDurationMs: null,
          timingSource: 'transcript_fallback',
        };
      }
    }
  }

  const fallbackMs = Math.max(800, Math.round(((cur.outputTokens || 60) / 60) * 1000));
  return {
    durationMs: fallbackMs,
    ttftMs: cur.ttftMs ?? null,
    decodeDurationMs: null,
    timingSource: 'estimated',
  };
}

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

function getTimingSourcePriority(source) {
  return TIMING_SOURCE_PRIORITY[source] ?? 0;
}

function shouldPersistRevisedCall(existingRow, nextCall, { force = false } = {}) {
  if (!existingRow) return true;
  const oldPri = getTimingSourcePriority(existingRow.timing_source);
  const newPri = getTimingSourcePriority(nextCall.timingSource);
  if (newPri > oldPri) return true;

  const oldDur = Number(existingRow.duration_ms) || 0;
  const newDur = Number(nextCall.durationMs) || 0;
  const shifted = (oldDur <= 0 && newDur > 0) || (oldDur > 0 && Math.abs(newDur - oldDur) / oldDur > 0.05);
  if (!shifted) return false;

  if (newPri === oldPri) return true;
  if (oldPri === TIMING_SOURCE_PRIORITY.hook_ms && newPri === TIMING_SOURCE_PRIORITY.hybrid_tool_split) {
    return true;
  }
  if (force) return true;
  return false;
}

function findRecomputableTailPlannerIdx(tailSteps) {
  if (!Array.isArray(tailSteps) || tailSteps.length === 0) return -1;
  for (let i = tailSteps.length - 1; i >= 0; i--) {
    const s = tailSteps[i];
    if (s && s.type === 'PLANNER_RESPONSE' && s._recomputable) {
      return i;
    }
  }
  return -1;
}

export function compactTailSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  let lastPlannerIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && s.type === 'PLANNER_RESPONSE' && (s.inputTokens > 0 || s.cacheReadTokens > 0 || s.outputTokens > 0)) {
      lastPlannerIdx = i;
      break;
    }
  }
  const defaultStart = Math.max(0, steps.length - 6);
  const plannerStart = lastPlannerIdx >= 0 ? Math.max(0, lastPlannerIdx - 1) : defaultStart;
  const minAllowedStart = Math.max(0, steps.length - 32);
  const sliceStart = Math.max(minAllowedStart, Math.min(defaultStart, plannerStart));

  return steps.slice(sliceStart).map((s, relIdx) => {
    const absIdx = sliceStart + relIdx;
    const rawContent = typeof s.content === 'string' ? s.content : '';
    const keepContent =
      rawContent && /conversationid|conversation_id|conversation:\/\/|subagent|launched/i.test(rawContent)
        ? rawContent.slice(0, 320)
        : '';

    if (absIdx === lastPlannerIdx) {
      const compactTools = Array.isArray(s.toolCalls)
        ? s.toolCalls.map((tc) => ({ name: tc?.name || tc?.tool || '' }))
        : [];
      return {
        stepIndex: s.stepIndex,
        type: s.type,
        createdAt: s.createdAt || '',
        tsMs: s.tsMs,
        model: s.model || '',
        inputTokens: Number(s.inputTokens) || 0,
        cacheReadTokens: Number(s.cacheReadTokens) || 0,
        outputTokens: Number(s.outputTokens) || 0,
        ttftMs: s.ttftMs ?? null,
        reportedDurationMs: s.reportedDurationMs ?? null,
        thinkingLen: Number.isFinite(s.thinkingLen) ? s.thinkingLen : (s.thinking || '').length,
        contentLen: Number.isFinite(s.contentLen) ? s.contentLen : rawContent.length,
        toolCallsLen: Number.isFinite(s.toolCallsLen)
          ? s.toolCallsLen
          : Array.isArray(s.toolCalls) && s.toolCalls.length
            ? JSON.stringify(s.toolCalls).length
            : 0,
        mediaCount: s.mediaCount || 0,
        toolCalls: compactTools,
        content: keepContent,
        _recomputable: true,
      };
    }

    const invokeCalls = Array.isArray(s.toolCalls)
      ? s.toolCalls.filter((tc) => {
          const name = String(tc?.name || tc?.tool || '').toLowerCase();
          return name === 'invoke_subagent' || name.endsWith('invoke_subagent');
        })
      : [];
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
    timingSource: call.timingSource || 'estimated',
  };
}

export function buildCallsFromSteps({
  steps,
  startIdx = 0,
  initialPrevCall = null,
  conversationId,
  rootConversationId,
  agentType,
  agentTag,
  config,
  timingsMap,
  nativeMetrics = null,
}) {
  const timingsEntry = timingsMap[conversationId];
  const usedSampleIndices = new Set();
  const calls = [];
  let prev = initialPrevCall || null;
  let prevBeforeLast = initialPrevCall || null;

  for (let i = startIdx; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'PLANNER_RESPONSE') continue;
    if (step.inputTokens === 0 && step.cacheReadTokens === 0 && step.outputTokens === 0) continue;

    const contextTokens = step.inputTokens + step.cacheReadTokens;
    const nativeMetric = nativeMetrics instanceof Map ? nativeMetrics.get(step.stepIndex) || null : null;
    const { durationMs, ttftMs, decodeDurationMs, timingSource } = computeStepDuration(
      steps,
      i,
      timingsEntry,
      usedSampleIndices,
      nativeMetric
    );

    let effectiveTps = 0;
    if (timingSource === 'native_db' && ttftMs != null) {
      const decodeMs = decodeDurationMs != null ? decodeDurationMs : Math.max(0, durationMs - ttftMs);
      if (decodeMs >= MIN_DECODE_TPS_WINDOW_MS && step.outputTokens >= MIN_DECODE_TPS_TOKENS) {
        effectiveTps = Number((step.outputTokens / (decodeMs / 1000)).toFixed(2));
      } else {
        effectiveTps = 0;
      }
    } else if (durationMs > 0) {
      effectiveTps = Number((step.outputTokens / (durationMs / 1000)).toFixed(2));
    }

    const cacheHitRate = contextTokens > 0 ? Number(((step.cacheReadTokens / contextTokens) * 100).toFixed(2)) : 0;
    const hasExactNativeSplit =
      nativeMetric != null &&
      Number.isFinite(nativeMetric.thinkingTokens) &&
      Number.isFinite(nativeMetric.contentTokens) &&
      nativeMetric.thinkingTokens + nativeMetric.contentTokens === step.outputTokens;
    const { thinkingTokensEst, contentTokensEst } = hasExactNativeSplit
      ? { thinkingTokensEst: nativeMetric.thinkingTokens, contentTokensEst: nativeMetric.contentTokens }
      : splitOutputTokens(
          step.outputTokens,
          step.thinking,
          step.content,
          step.toolCalls,
          step._recomputable ? step : null
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
      ttftMs: ttftMs == null ? null : Number(Number(ttftMs).toFixed(1)),
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
    prevBeforeLast = prev;
    prev = fullCall;
  }

  return {
    calls,
    lastCall: prev ? compactLastCall(prev) : initialPrevCall,
    prevCallBeforeLast: calls.length > 0 ? compactLastCall(prevBeforeLast) : null,
  };
}

function parseTranscriptForSync({
  transcriptPath,
  conversationId,
  rootConversationId,
  agentType,
  agentTag,
  prevState,
  canIncremental,
  timingsChanged = false,
  config,
  timingsMap,
  nativeMetrics = null,
}) {
  const stat = fs.statSync(transcriptPath);
  const prevOffset = Number(prevState?.offset) || 0;
  const useIncremental = Boolean(canIncremental) && prevOffset > 0 && prevOffset <= stat.size;

  if (useIncremental && prevOffset === stat.size) {
    const tail = Array.isArray(prevState?.tailSteps) ? prevState.tailSteps : [];
    const recomputeIdx = timingsChanged ? findRecomputableTailPlannerIdx(tail) : -1;
    if (recomputeIdx >= 0) {
      const built = buildCallsFromSteps({
        steps: tail,
        startIdx: recomputeIdx,
        initialPrevCall: prevState?.prevCallBeforeLast || null,
        conversationId,
        rootConversationId,
        agentType,
        agentTag,
        config,
        timingsMap,
        nativeMetrics,
      });
      return {
        mode: 'recompute_tail',
        size: stat.size,
        offset: prevOffset,
        stepsForSubDiscovery: [],
        calls: built.calls,
        lastCall: built.calls.length > 0 ? built.lastCall : prevState?.lastCall || null,
        prevCallBeforeLast:
          built.calls.length > 0 ? built.prevCallBeforeLast : prevState?.prevCallBeforeLast || null,
        tailSteps: tail,
      };
    }

    return {
      mode: 'skip',
      size: stat.size,
      offset: prevOffset,
      stepsForSubDiscovery: [],
      calls: [],
      lastCall: prevState?.lastCall || null,
      prevCallBeforeLast: prevState?.prevCallBeforeLast || null,
      tailSteps: tail,
    };
  }

  if (useIncremental) {
    const inc = parseTranscriptIncremental(transcriptPath, prevOffset);
    const tail = Array.isArray(prevState?.tailSteps) ? prevState.tailSteps : [];
    const combinedSteps = [...tail, ...inc.steps];
    const recomputeIdx = findRecomputableTailPlannerIdx(tail);
    const startIdx = recomputeIdx >= 0 ? recomputeIdx : tail.length;
    const initialPrevCall =
      recomputeIdx >= 0 ? prevState?.prevCallBeforeLast || null : prevState?.lastCall || null;

    const built = buildCallsFromSteps({
      steps: combinedSteps,
      startIdx,
      initialPrevCall,
      conversationId,
      rootConversationId,
      agentType,
      agentTag,
      config,
      timingsMap,
      nativeMetrics,
    });
    return {
      mode: 'incremental',
      size: stat.size,
      offset: inc.nextOffset,
      stepsForSubDiscovery: combinedSteps,
      calls: built.calls,
      lastCall: built.calls.length > 0 ? built.lastCall : prevState?.lastCall || null,
      prevCallBeforeLast:
        built.calls.length > 0 ? built.prevCallBeforeLast : prevState?.prevCallBeforeLast || null,
      tailSteps: compactTailSteps(combinedSteps),
    };
  }

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
    nativeMetrics,
  });
  return {
    mode: 'full',
    size: stat.size,
    offset: full.nextOffset,
    stepsForSubDiscovery: full.steps,
    calls: built.calls,
    lastCall: built.lastCall,
    prevCallBeforeLast: built.prevCallBeforeLast,
    tailSteps: compactTailSteps(full.steps),
  };
}

const EXISTING_CALLS_BY_ROOT_SQL =
  'SELECT call_uid, duration_ms, timing_source, effective_tps, root_conversation_id, agent_type, agent_tag, cache_drop FROM calls WHERE root_conversation_id = ?';

/**
 * Sync a main conversation + all discovered subagents into SQLite index & JSONL truth source.
 * - Uses O(1) `SELECT 1 ... LIMIT 1` to probe existing DB rows instead of a 500-row scan.
 * - Batches `calls.jsonl` append OUTSIDE the SQLite `BEGIN IMMEDIATE ... COMMIT` lock.
 * - Prunes `cursors.json` to the newest 64 root conversations (LRU).
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
    return { conversationId: resolvedId || null, calls: [], subagents: [], syncedNew: 0, syncedUpdated: 0 };
  }
  if (!resolvedId) {
    const parts = resolvedPath.split(/[\\/]/);
    const brainIdx = parts.lastIndexOf('brain');
    resolvedId = brainIdx >= 0 && parts[brainIdx + 1] ? parts[brainIdx + 1] : 'default';
  }

  const cursors = readJsonSafe(paths.cursorsFile, {});
  const timingsMap = loadTimingsMap(paths);
  const baseTimingsSig = `${safeStatSig(getTimingsLogPath(paths))}|${safeStatSig(paths.timingsFile)}`;
  const mainNativeSig = getNativeDbSignature(resolvedId, options);
  const timingsSig = `${baseTimingsSig}|${mainNativeSig}`;

  const mainStat = fs.statSync(resolvedPath);
  const prevCursor = cursors[resolvedId] || { size: -1, offset: 0, subagents: [] };
  const mainHasPendingTail =
    Boolean(prevCursor.lastCall && prevCursor.lastCall.timingSource !== 'native_db') &&
    findRecomputableTailPlannerIdx(prevCursor.tailSteps) >= 0;
  const timingsChangedMain = Boolean(
    mainHasPendingTail && prevCursor.timingsSig && prevCursor.timingsSig !== timingsSig
  );
  let needsSync =
    force ||
    prevCursor.size !== mainStat.size ||
    (Number(prevCursor.offset) || 0) !== mainStat.size ||
    timingsChangedMain;

  if (!needsSync && Array.isArray(prevCursor.subagents)) {
    for (const sub of prevCursor.subagents) {
      if (sub.path && fs.existsSync(sub.path)) {
        const subSz = fs.statSync(sub.path).size;
        const subSig = `${baseTimingsSig}|${getNativeDbSignature(sub.conversationId, options)}`;
        const subHasPendingTail =
          Boolean(sub.lastCall && sub.lastCall.timingSource !== 'native_db') &&
          findRecomputableTailPlannerIdx(sub.tailSteps) >= 0;
        const subTimingsChanged = Boolean(
          subHasPendingTail && sub.timingsSig && sub.timingsSig !== subSig
        );
        if (subSz !== sub.size || (Number(sub.offset) || 0) !== subSz || subTimingsChanged) {
          needsSync = true;
          break;
        }
      }
    }
  }

  // O(1) existence check instead of querying 500 rows before knowing whether sync is needed
  const hasExistingDbRows = hasCallsForRoot(resolvedId, options);

  if (!needsSync && hasExistingDbRows) {
    const existingDbCalls = queryCalls({ rootConversationId: resolvedId }, options);
    return {
      conversationId: resolvedId,
      calls: existingDbCalls,
      subagents: prevCursor.subagents || [],
      syncedNew: 0,
      syncedUpdated: 0,
    };
  }

  const canIncrementalMain =
    !force &&
    hasExistingDbRows &&
    Number(prevCursor.offset) > 0 &&
    Number(prevCursor.offset) <= mainStat.size;

  const mainNativeMetrics = loadNativeStepMetrics(resolvedId, options);
  const mainRes = parseTranscriptForSync({
    transcriptPath: resolvedPath,
    conversationId: resolvedId,
    rootConversationId: resolvedId,
    agentType: 'main',
    agentTag: '主',
    prevState: prevCursor,
    canIncremental: canIncrementalMain,
    timingsChanged: timingsChangedMain,
    config,
    timingsMap,
    nativeMetrics: mainNativeMetrics,
  });

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
    const subSig = `${baseTimingsSig}|${getNativeDbSignature(subId, options)}`;
    const subHasPendingTail =
      Boolean(prevSub?.lastCall && prevSub.lastCall.timingSource !== 'native_db') &&
      findRecomputableTailPlannerIdx(prevSub?.tailSteps) >= 0;
    const timingsChangedSub = Boolean(
      subHasPendingTail && prevSub?.timingsSig && prevSub.timingsSig !== subSig
    );

    const subNativeMetrics = loadNativeStepMetrics(subId, options);
    const subRes = parseTranscriptForSync({
      transcriptPath: subPath,
      conversationId: subId,
      rootConversationId: resolvedId,
      agentType: 'sub',
      agentTag: tag,
      prevState: prevSub,
      canIncremental: canIncrementalSub,
      timingsChanged: timingsChangedSub,
      config,
      timingsMap,
      nativeMetrics: subNativeMetrics,
    });
    subMeta.push({
      conversationId: subId,
      tag,
      path: subPath,
      size: subRes.size,
      offset: subRes.offset,
      lastCall: subRes.lastCall,
      prevCallBeforeLast: subRes.prevCallBeforeLast,
      tailSteps: subRes.tailSteps,
      timingsSig: subSig,
    });
    if (subRes.calls.length > 0) {
      callsToUpsert.push(...subRes.calls);
    }
  });

  // Upsert newly parsed/revised calls inside SQLite transaction; flush JSONL batch AFTER COMMIT
  let syncedNew = 0;
  let syncedUpdated = 0;
  const jsonlToAppend = [];

  if (callsToUpsert.length > 0) {
    withIndexDb(options, (db) => {
      const rows = prepareCached(db, EXISTING_CALLS_BY_ROOT_SQL).all(resolvedId);
      const existingMap = new Map(rows.map((r) => [r.call_uid, r]));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const c of callsToUpsert) {
          const existing = existingMap.get(c.callUid);
          if (!existing) {
            jsonlToAppend.push(c);
            existingMap.set(c.callUid, {
              call_uid: c.callUid,
              duration_ms: c.durationMs,
              timing_source: c.timingSource,
              effective_tps: c.effectiveTps,
              root_conversation_id: c.rootConversationId,
              agent_type: c.agentType,
              agent_tag: c.agentTag,
              cache_drop: c.cacheDrop ? 1 : 0,
            });
            upsertCallRow(db, c);
            syncedNew++;
          } else {
            const metadataChanged =
              existing.root_conversation_id !== c.rootConversationId ||
              existing.agent_type !== c.agentType ||
              existing.agent_tag !== c.agentTag ||
              Boolean(existing.cache_drop) !== Boolean(c.cacheDrop);
            if (shouldPersistRevisedCall(existing, c, { force }) || metadataChanged) {
              jsonlToAppend.push(c);
              existingMap.set(c.callUid, {
                call_uid: c.callUid,
                duration_ms: c.durationMs,
                timing_source: c.timingSource,
                effective_tps: c.effectiveTps,
                root_conversation_id: c.rootConversationId,
                agent_type: c.agentType,
                agent_tag: c.agentTag,
                cache_drop: c.cacheDrop ? 1 : 0,
              });
              upsertCallRow(db, c);
              syncedUpdated++;
            }
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });

    // Single merged append outside SQLite transaction lock
    if (jsonlToAppend.length > 0) {
      appendJsonlBatch(paths.callsLogFile, jsonlToAppend);
    }
  }

  cursors[resolvedId] = {
    size: mainRes.size,
    offset: mainRes.offset,
    lastCall: mainRes.lastCall,
    prevCallBeforeLast: mainRes.prevCallBeforeLast,
    tailSteps: mainRes.tailSteps,
    timingsSig,
    updatedAt: new Date().toISOString(),
    subagents: subMeta,
  };
  atomicWriteJson(paths.cursorsFile, pruneCursorsLru(cursors, MAX_CURSORS_ENTRIES));

  let finalCalls;
  if (
    mainRes.mode === 'full' &&
    !subMeta.some((s) => s.path && s.size > 0 && !callsToUpsert.some((c) => c.conversationId === s.conversationId))
  ) {
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
    syncedUpdated,
  };
}

function discoverAllLocalTranscripts(options = {}) {
  const found = [];
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
      const key = convId.toLowerCase();
      if (seen.has(key)) continue;
      const tPath = findTranscriptPath(convId, { ...options, appDataDir: appDir });
      if (!tPath) continue;
      try {
        const stat = fs.statSync(tPath);
        if (stat.size === 0) continue;
        seen.add(key);
        found.push({ conversationId: convId, transcriptPath: tPath, stat });
      } catch {
        // ignore unreadable transcript
      }
    }
  }
  return found;
}

/**
 * Re-parse all local existing transcript files with the latest TPS timing engine,
 * clear stale cursors, merge/deduplicate with orphaned historical calls in calls.jsonl,
 * atomically write compacted calls.jsonl, and rebuild SQLite index.
 */
export function resyncAllHistoricalTelemetry(options = {}, { summarizeStats, onAfterResync } = {}) {
  const paths = ensureDataDirs(options);
  const config = loadConfig(options);
  const timingsMap = loadTimingsMap(paths);
  const timingsSig = `${safeStatSig(getTimingsLogPath(paths))}|${safeStatSig(paths.timingsFile)}`;

  const existingRawCalls = readJsonlSafe(paths.callsLogFile);
  const existingByUid = new Map();
  const existingConvRole = new Map();
  for (const c of existingRawCalls) {
    if (!c || !c.callUid) continue;
    existingByUid.set(c.callUid, c);
    if (c.conversationId && c.agentType === 'sub' && c.rootConversationId && c.rootConversationId !== c.conversationId) {
      existingConvRole.set(String(c.conversationId).toLowerCase(), {
        rootConversationId: c.rootConversationId,
        agentType: 'sub',
        agentTag: c.agentTag || '子1',
      });
    }
  }
  const beforeStats = summarizeStats ? summarizeStats([...existingByUid.values()], existingRawCalls.length) : null;

  const localTranscripts = discoverAllLocalTranscripts(options);
  const parsedMap = new Map();
  const subParentMap = new Map();
  const parentSubsMap = new Map();

  for (const item of localTranscripts) {
    try {
      const parsed = parseTranscriptIncremental(item.transcriptPath, 0);
      const lower = item.conversationId.toLowerCase();
      parsedMap.set(lower, {
        ...item,
        steps: parsed.steps,
        nextOffset: parsed.nextOffset,
      });
      const discoveredSubs = discoverSubagentIds(parsed.steps, item.conversationId);
      if (discoveredSubs.length > 0) {
        const subList = [];
        discoveredSubs.forEach((sid, idx) => {
          const sLower = sid.toLowerCase();
          const tag = `子${idx + 1}`;
          subList.push({ subId: sid, tag });
          if (!subParentMap.has(sLower)) {
            subParentMap.set(sLower, { rootConversationId: item.conversationId, agentTag: tag });
          }
        });
        parentSubsMap.set(lower, subList);
      }
    } catch {
      // skip unreadable transcript
    }
  }

  const reparsedByUid = new Map();
  const builtMetaByConv = new Map();

  for (const [lowerId, entry] of parsedMap.entries()) {
    const subInfo = subParentMap.get(lowerId) || existingConvRole.get(lowerId) || null;
    const rootConversationId = subInfo ? subInfo.rootConversationId : entry.conversationId;
    const agentType = subInfo ? 'sub' : 'main';
    const agentTag = subInfo ? subInfo.agentTag : '主';

    const nativeMetrics = loadNativeStepMetrics(entry.conversationId, options);
    const built = buildCallsFromSteps({
      steps: entry.steps,
      startIdx: 0,
      initialPrevCall: null,
      conversationId: entry.conversationId,
      rootConversationId,
      agentType,
      agentTag,
      config,
      timingsMap,
      nativeMetrics,
    });
    for (const c of built.calls) {
      reparsedByUid.set(c.callUid, c);
    }
    builtMetaByConv.set(lowerId, {
      conversationId: entry.conversationId,
      transcriptPath: entry.transcriptPath,
      size: entry.stat.size,
      offset: entry.nextOffset,
      lastCall: built.lastCall,
      prevCallBeforeLast: built.prevCallBeforeLast,
      tailSteps: compactTailSteps(entry.steps),
    });
  }

  const mergedByUid = new Map();
  let orphanedPreserved = 0;
  for (const [uid, oldCall] of existingByUid.entries()) {
    if (!reparsedByUid.has(uid)) {
      mergedByUid.set(uid, oldCall);
      orphanedPreserved++;
    }
  }

  let addedCalls = 0;
  let updatedCalls = 0;
  for (const [uid, freshCall] of reparsedByUid.entries()) {
    const prev = existingByUid.get(uid);
    if (!prev) {
      addedCalls++;
    } else if (
      prev.timingSource !== freshCall.timingSource ||
      Math.abs((Number(prev.durationMs) || 0) - (Number(freshCall.durationMs) || 0)) > 0.1 ||
      Math.abs((Number(prev.effectiveTps) || 0) - (Number(freshCall.effectiveTps) || 0)) > 0.01
    ) {
      updatedCalls++;
    }
    mergedByUid.set(uid, freshCall);
  }

  const mergedCalls = [...mergedByUid.values()].sort(
    (a, b) =>
      (Number(a.tsMs) || 0) - (Number(b.tsMs) || 0) ||
      (Number(a.stepIndex) || 0) - (Number(b.stepIndex) || 0) ||
      String(a.callUid).localeCompare(String(b.callUid))
  );

  const compactedContent = mergedCalls.length ? mergedCalls.map((c) => JSON.stringify(c)).join('\n') + '\n' : '';
  atomicWriteFile(paths.callsLogFile, compactedContent);

  const freshCursors = {};
  const nowIso = new Date().toISOString();
  for (const [lowerId, meta] of builtMetaByConv.entries()) {
    if (subParentMap.has(lowerId)) continue;
    const subs = (parentSubsMap.get(lowerId) || []).map(({ subId, tag }) => {
      const sMeta = builtMetaByConv.get(subId.toLowerCase());
      if (!sMeta) {
        return { conversationId: subId, tag, path: null, size: 0, offset: 0 };
      }
      return {
        conversationId: subId,
        tag,
        path: sMeta.transcriptPath,
        size: sMeta.size,
        offset: sMeta.offset,
        lastCall: sMeta.lastCall,
        prevCallBeforeLast: sMeta.prevCallBeforeLast,
        tailSteps: sMeta.tailSteps,
        timingsSig,
      };
    });
    freshCursors[meta.conversationId] = {
      size: meta.size,
      offset: meta.offset,
      lastCall: meta.lastCall,
      prevCallBeforeLast: meta.prevCallBeforeLast,
      tailSteps: meta.tailSteps,
      timingsSig,
      updatedAt: nowIso,
      subagents: subs,
    };
  }
  atomicWriteJson(paths.cursorsFile, pruneCursorsLru(freshCursors, MAX_CURSORS_ENTRIES));

  if (typeof onAfterResync === 'function') onAfterResync();
  const rebuild = rebuildIndex(options);
  const afterStats = summarizeStats ? summarizeStats(mergedCalls, mergedCalls.length) : null;

  return {
    transcriptsScanned: localTranscripts.length,
    reparsedCalls: reparsedByUid.size,
    orphanedPreserved,
    addedCalls,
    updatedCalls,
    before: beforeStats,
    after: afterStats,
    rebuild,
  };
}
