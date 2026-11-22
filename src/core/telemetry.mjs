import fs from 'node:fs';
import { getDataPaths, findTranscriptPath } from './paths.mjs';
import { loadConfig, estimateCallCostUsd, getModelLimit } from './config.mjs';
import { atomicWriteJson, appendJsonl, ensureDataDirs, readJsonSafe } from './storage.mjs';
import { ensureIndexReady, upsertCallRow, withIndexDb } from './index-db.mjs';
import {
  discoverSubagentIds,
  listConversations,
  parseTranscriptFull,
  parseTranscriptIncremental,
} from './transcript-parser.mjs';

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
 */
export function recordHookTiming({ conversationId, phase, invocationNum, timestampMs = Date.now() }, options = {}) {
  if (!conversationId) return null;
  const paths = ensureDataDirs(options);
  const timings = readJsonSafe(paths.timingsFile, {});
  const entry = timings[conversationId] || { pendingPreMs: null, samples: [] };

  if (phase === 'pre') {
    entry.pendingPreMs = timestampMs;
    entry.pendingInvocationNum = invocationNum ?? null;
  } else if (phase === 'post') {
    const startMs = entry.pendingPreMs;
    if (startMs && timestampMs >= startMs && timestampMs - startMs <= 600_000) {
      const durationMs = Math.max(150, timestampMs - startMs);
      entry.samples.push({
        startMs,
        endMs: timestampMs,
        durationMs,
        invocationNum: invocationNum ?? entry.pendingInvocationNum ?? null,
      });
      if (entry.samples.length > 200) {
        entry.samples = entry.samples.slice(-200);
      }
    }
    entry.pendingPreMs = null;
  }

  timings[conversationId] = entry;
  // Prune stale conversations (> 100 entries)
  const keys = Object.keys(timings);
  if (keys.length > 100) {
    for (const k of keys.slice(0, keys.length - 100)) {
      delete timings[k];
    }
  }
  atomicWriteJson(paths.timingsFile, timings);
  return entry;
}

/**
 * Match a hook_ms timing sample near a transcript step's timestamp.
 */
function findHookTimingMs(timingsEntry, stepTsMs) {
  if (!timingsEntry || !Array.isArray(timingsEntry.samples) || !stepTsMs) return null;
  let best = null;
  let bestDist = Infinity;
  for (const s of timingsEntry.samples) {
    const dist = Math.min(Math.abs(s.startMs - stepTsMs), Math.abs(s.endMs - stepTsMs));
    if (dist <= 30_000 && dist < bestDist) {
      best = s.durationMs;
      bestDist = dist;
    }
  }
  return best;
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
function computeStepDuration(steps, idx, timingsEntry) {
  const cur = steps[idx];
  const hookMs = findHookTimingMs(timingsEntry, cur.tsMs);
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

/**
 * Parse a single transcript (main or subagent) into normalized telemetry call records.
 */
function buildCallsFromTranscript({
  transcriptPath,
  conversationId,
  rootConversationId,
  agentType,
  agentTag,
  config,
  timingsMap,
}) {
  const steps = parseTranscriptFull(transcriptPath);
  const timingsEntry = timingsMap[conversationId];
  const calls = [];
  let prev = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'PLANNER_RESPONSE') continue;
    if (step.inputTokens === 0 && step.cacheReadTokens === 0 && step.outputTokens === 0) continue;

    const contextTokens = step.inputTokens + step.cacheReadTokens;
    const { durationMs, timingSource } = computeStepDuration(steps, i, timingsEntry);
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
    };

    const drop = evaluateCacheDrop(prev, baseCall, config.alerts.cacheDropThresholdPct);
    const fullCall = { ...baseCall, ...drop };
    calls.push(fullCall);
    prev = fullCall;
  }

  return { steps, calls };
}

/**
 * Sync a main conversation + all discovered subagents into JSONL truth source & SQLite index.
 * Uses file byte cursor to avoid redundant work when files haven't grown.
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
  const timingsMap = readJsonSafe(paths.timingsFile, {});

  // Check if main or any known subagent transcript changed size
  const mainStat = fs.statSync(resolvedPath);
  const prevCursor = cursors[resolvedId] || { size: -1, subagents: [] };
  let needsSync = force || prevCursor.size !== mainStat.size;

  if (!needsSync && Array.isArray(prevCursor.subagents)) {
    for (const sub of prevCursor.subagents) {
      if (sub.path && fs.existsSync(sub.path)) {
        if (fs.statSync(sub.path).size !== sub.size) {
          needsSync = true;
          break;
        }
      }
    }
  }

  // Always check DB count in case DB was rebuilt
  if (!needsSync) {
    const existing = queryCalls({ rootConversationId: resolvedId }, options);
    if (existing.length > 0) {
      return {
        conversationId: resolvedId,
        calls: existing,
        subagents: prevCursor.subagents || [],
        syncedNew: 0,
      };
    }
  }

  const mainRes = buildCallsFromTranscript({
    transcriptPath: resolvedPath,
    conversationId: resolvedId,
    rootConversationId: resolvedId,
    agentType: 'main',
    agentTag: '主',
    config,
    timingsMap,
  });

  const subIds = discoverSubagentIds(mainRes.steps, resolvedId);
  const allCalls = [...mainRes.calls];
  const subMeta = [];

  subIds.forEach((subId, idx) => {
    const subPath = findTranscriptPath(subId, options);
    const tag = `子${idx + 1}`;
    if (!subPath || !fs.existsSync(subPath)) {
      subMeta.push({ conversationId: subId, tag, path: null, size: 0 });
      return;
    }
    const subStat = fs.statSync(subPath);
    subMeta.push({ conversationId: subId, tag, path: subPath, size: subStat.size });
    const subRes = buildCallsFromTranscript({
      transcriptPath: subPath,
      conversationId: subId,
      rootConversationId: resolvedId,
      agentType: 'sub',
      agentTag: tag,
      config,
      timingsMap,
    });
    allCalls.push(...subRes.calls);
  });

  // Sort newest first for display, persist new call UIDs to append-only JSONL truth source
  const existingUids = withIndexDb(options, (db) => {
    const rows = db.prepare('SELECT call_uid FROM calls WHERE root_conversation_id = ?').all(resolvedId);
    return new Set(rows.map((r) => r.call_uid));
  });

  let syncedNew = 0;
  withIndexDb(options, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of allCalls) {
        if (!existingUids.has(c.callUid)) {
          appendJsonl(paths.callsLogFile, c);
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

  // Also record incremental byte offset using parseTranscriptIncremental
  const incCheck = parseTranscriptIncremental(resolvedPath, prevCursor.offset || 0);
  cursors[resolvedId] = {
    size: mainStat.size,
    offset: incCheck.nextOffset,
    updatedAt: new Date().toISOString(),
    subagents: subMeta,
  };
  atomicWriteJson(paths.cursorsFile, cursors);

  allCalls.sort((a, b) => b.tsMs - a.tsMs || b.stepIndex - a.stepIndex);
  return {
    conversationId: resolvedId,
    calls: allCalls,
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

  return alerts;
}

/**
 * Summarize telemetry calls for UI `明细` tab and KPI strip.
 */
export function getTelemetryReport(params = {}, options = {}) {
  const config = loadConfig(options);
  const synced = syncConversationTelemetry(
    {
      conversationId: params.conversationId,
      transcriptPath: params.transcriptPath,
      force: Boolean(params.force),
    },
    options
  );

  const allCalls = synced.calls;
  const filtered = allCalls.filter((c) => {
    if (params.agentFilter && params.agentFilter !== 'all' && c.agentType !== params.agentFilter) return false;
    if (params.modelFilter && params.modelFilter !== 'all' && c.model !== params.modelFilter) return false;
    if (params.onlyDrop && !c.cacheDrop) return false;
    return true;
  });

  const byAgentMap = new Map();
  const byModelMap = new Map();
  for (const c of allCalls) {
    const ag = byAgentMap.get(c.agentTag) || {
      agentTag: c.agentTag,
      agentType: c.agentType,
      steps: 0,
      tpsSum: 0,
      cacheSum: 0,
      cost: 0,
      maxContext: 0,
      drops: 0,
    };
    ag.steps++;
    ag.tpsSum += c.effectiveTps;
    ag.cacheSum += c.cacheHitRate;
    ag.cost += c.estimatedCostUsd;
    ag.maxContext = Math.max(ag.maxContext, c.contextTokens);
    if (c.cacheDrop) ag.drops++;
    byAgentMap.set(c.agentTag, ag);

    const md = byModelMap.get(c.model) || { model: c.model, steps: 0, tpsSum: 0, cost: 0 };
    md.steps++;
    md.tpsSum += c.effectiveTps;
    md.cost += c.estimatedCostUsd;
    byModelMap.set(c.model, md);
  }

  const byAgent = [...byAgentMap.values()].map((a) => ({
    agentTag: a.agentTag,
    agentType: a.agentType,
    steps: a.steps,
    avgTps: Number((a.tpsSum / a.steps).toFixed(1)),
    avgCache: Number((a.cacheSum / a.steps).toFixed(1)),
    cost: Number(a.cost.toFixed(4)),
    maxContext: a.maxContext,
    drops: a.drops,
  }));

  const byModel = [...byModelMap.values()].map((m) => ({
    model: m.model,
    steps: m.steps,
    avgTps: Number((m.tpsSum / m.steps).toFixed(1)),
    cost: Number(m.cost.toFixed(4)),
  }));

  const latestMain = allCalls.find((c) => c.agentType === 'main') || allCalls[0] || null;
  const totalCost = allCalls.reduce((s, c) => s + c.estimatedCostUsd, 0);
  const avgTps = allCalls.length ? allCalls.reduce((s, c) => s + c.effectiveTps, 0) / allCalls.length : 0;

  return {
    conversationId: synced.conversationId,
    calls: filtered,
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
