import crypto from 'node:crypto';
import { findTranscriptPath, getDataPaths } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { createLruCache, safeStatSig } from '../fs-utils.mjs';
import { ensureIndexReady, prepareCached, withIndexDb } from '../index-db.mjs';
import { listConversations } from '../transcript-parser.mjs';
import { getTimingsLogPath, registerTimingsInvalidator } from './timings-store.mjs';
import { syncConversationTelemetry } from './sync-engine.mjs';
import { evaluateAlerts } from './alerts.mjs';

const TELEMETRY_REPORT_TTL_MS = 1_500;
const telemetryReportCache = createLruCache(24);

export function clearReportCache() {
  telemetryReportCache.clear();
}

registerTimingsInvalidator(clearReportCache);

/**
 * Compute token-weighted average TPS:
 * - For native_db calls with TTFT, uses pure decode duration (durationMs - ttftMs).
 * - Excludes 'estimated' steps and sub-second decode steps (effectiveTps === 0) when valid timed calls exist.
 */
export function calcWeightedAvgTps(calls) {
  if (!calls || !calls.length) return 0;
  const realTimed = calls.filter((c) => c.timingSource !== 'estimated' && (Number(c.effectiveTps) || 0) > 0);
  const pool = realTimed.length > 0 ? realTimed : calls.filter((c) => (Number(c.effectiveTps) || 0) > 0);
  if (!pool.length) return 0;
  let totalOut = 0;
  let totalMs = 0;
  for (const c of pool) {
    const out = Math.max(0, Number(c.outputTokens) || 0);
    const dur = Math.max(0, Number(c.durationMs) || 0);
    const ttft = c.ttftMs != null && Number.isFinite(Number(c.ttftMs)) ? Number(c.ttftMs) : null;
    const activeMs = ttft != null && dur > ttft ? dur - ttft : dur;
    totalOut += out;
    totalMs += activeMs;
  }
  if (totalMs > 0 && totalOut > 0) {
    return Number((totalOut / (totalMs / 1000)).toFixed(1));
  }
  return Number((pool.reduce((s, c) => s + (c.effectiveTps || 0), 0) / pool.length).toFixed(1));
}

/**
 * Format zero-model-token single-line status banner for PostInvocation metadata.user_markdown.
 */
export function formatUserMarkdownBanner(call) {
  if (!call) return '';
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const srcHint = call.timingSource === 'hook_ms' ? '' : ' (est)';
  const dropNote = call.cacheDrop ? ` | ⚠️ 击穿(${call.dropReason})` : '';
  return `⚡ ${call.effectiveTps.toFixed(1)} tok/s${srcHint} | Cache ${call.cacheHitRate.toFixed(1)}% (${fmtK(call.cacheReadTokens)}/${fmtK(call.contextTokens)}) | +${fmtK(call.inputTokens)} in / ${call.outputTokens} out | $${call.estimatedCostUsd.toFixed(3)}${dropNote}`;
}

export function summarizeCallStats(calls, rawLinesCount) {
  const byTimingSource = {};
  let spikeCount = 0;
  let lowTpsCount = 0;
  for (const c of calls) {
    const src = c.timingSource || 'unknown';
    byTimingSource[src] = (byTimingSource[src] || 0) + 1;
    const tps = Number(c.effectiveTps) || 0;
    if (tps > 1000) spikeCount++;
    if (tps > 0 && tps < 2 && src !== 'estimated') lowTpsCount++;
  }
  return {
    rawLines: rawLinesCount,
    uniqueCalls: calls.length,
    spikeCount,
    lowTpsCount,
    avgTps: calcWeightedAvgTps(calls),
    byTimingSource,
  };
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

function hashRev(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

function applyReportFilters(baseReport, params = {}) {
  const allCalls = baseReport.allCalls;
  const agentFilter = params.agentFilter && params.agentFilter !== 'all' ? params.agentFilter : 'all';
  const modelFilter = params.modelFilter && params.modelFilter !== 'all' ? params.modelFilter : 'all';
  const onlyDrop = Boolean(params.onlyDrop);

  const filtered =
    agentFilter === 'all' && modelFilter === 'all' && !onlyDrop
      ? allCalls
      : allCalls.filter((c) => {
          if (agentFilter !== 'all' && c.agentType !== agentFilter) return false;
          if (modelFilter !== 'all' && c.model !== modelFilter) return false;
          if (onlyDrop && !c.cacheDrop) return false;
          return true;
        });

  const rev =
    agentFilter === 'all' && modelFilter === 'all' && !onlyDrop
      ? baseReport.rev
      : hashRev([baseReport.rev, agentFilter, modelFilter, onlyDrop ? 1 : 0, filtered.length]);

  return {
    rev,
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
 * Cached for 1.5s and emits a deterministic 12-hex `rev` digest for `lastRev` short-circuiting.
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
      sourceLabel: `${rolePrefix} / ${convLabel} (${shortId})`,
      sourceTitle: convLabel,
    };
  });

  const byAgentMap = new Map();
  const byModelMap = new Map();
  for (const c of allCalls) {
    const isReal = c.timingSource !== 'estimated';
    const ag = byAgentMap.get(c.agentTag) || {
      agentTag: c.agentTag,
      agentType: c.agentType,
      steps: 0,
      outSum: 0,
      durSum: 0,
      realOutSum: 0,
      realDurSum: 0,
      cacheSum: 0,
      cost: 0,
      maxContext: 0,
      drops: 0,
    };
    ag.steps++;
    ag.outSum += c.outputTokens || 0;
    ag.durSum += c.durationMs || 0;
    if (isReal) {
      ag.realOutSum += c.outputTokens || 0;
      ag.realDurSum += c.durationMs || 0;
    }
    ag.cacheSum += c.cacheHitRate;
    ag.cost += c.estimatedCostUsd;
    ag.maxContext = Math.max(ag.maxContext, c.contextTokens);
    if (c.cacheDrop) ag.drops++;
    byAgentMap.set(c.agentTag, ag);

    const md = byModelMap.get(c.model) || {
      model: c.model,
      steps: 0,
      outSum: 0,
      durSum: 0,
      realOutSum: 0,
      realDurSum: 0,
      cost: 0,
    };
    md.steps++;
    md.outSum += c.outputTokens || 0;
    md.durSum += c.durationMs || 0;
    if (isReal) {
      md.realOutSum += c.outputTokens || 0;
      md.realDurSum += c.durationMs || 0;
    }
    md.cost += c.estimatedCostUsd;
    byModelMap.set(c.model, md);
  }

  const byAgent = [...byAgentMap.values()].map((a) => ({
    agentTag: a.agentTag,
    agentType: a.agentType,
    steps: a.steps,
    avgTps:
      a.realDurSum > 0
        ? Number((a.realOutSum / (a.realDurSum / 1000)).toFixed(1))
        : a.durSum > 0
          ? Number((a.outSum / (a.durSum / 1000)).toFixed(1))
          : 0,
    avgCache: Number((a.cacheSum / a.steps).toFixed(1)),
    cost: Number(a.cost.toFixed(4)),
    maxContext: a.maxContext,
    drops: a.drops,
  }));

  const byModel = [...byModelMap.values()].map((m) => ({
    model: m.model,
    steps: m.steps,
    avgTps:
      m.realDurSum > 0
        ? Number((m.realOutSum / (m.realDurSum / 1000)).toFixed(1))
        : m.durSum > 0
          ? Number((m.outSum / (m.durSum / 1000)).toFixed(1))
          : 0,
    cost: Number(m.cost.toFixed(4)),
  }));

  const latestMain = allCalls.find((c) => c.agentType === 'main') || allCalls[0] || null;
  const totalCost = allCalls.reduce((s, c) => s + c.estimatedCostUsd, 0);
  const avgTps = calcWeightedAvgTps(allCalls);
  const alerts = evaluateAlerts(allCalls, config);

  const watchedList = [...watchedPaths];
  const fingerprint = buildReportFingerprint(paths, watchedList);
  const rev = hashRev([
    synced.conversationId || '',
    allCalls.length,
    latestMain?.callUid || '',
    latestMain?.tsMs || 0,
    latestMain?.durationMs || 0,
    latestMain?.effectiveTps || 0,
    latestMain?.cacheHitRate || 0,
    Number(totalCost.toFixed(4)),
    Number(avgTps.toFixed(1)),
    alerts.length,
    fingerprint,
  ]);

  const baseReport = {
    rev,
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
    alerts,
    banner: latestMain ? formatUserMarkdownBanner(latestMain) : '',
  };

  telemetryReportCache.set(cacheKey, {
    baseReport,
    watchedPaths: watchedList,
    fingerprint,
    expiresAt: Date.now() + TELEMETRY_REPORT_TTL_MS,
  });

  return applyReportFilters(baseReport, params);
}

const VALID_USAGE_RANGES = new Set(['today', '24h', '7d', '30d', 'all']);

/**
 * Aggregate cross-session cumulative usage statistics directly from the SQLite `calls` table.
 */
export function getUsageStats(params = {}, options = {}) {
  const range = VALID_USAGE_RANGES.has(params.range) ? params.range : 'today';
  const modelFilter =
    typeof params.modelFilter === 'string' && params.modelFilter.trim() ? params.modelFilter.trim() : 'all';

  ensureIndexReady(options);

  const now = new Date();
  const nowMs = now.getTime();
  let sinceMs = 0;
  if (range === 'today') {
    sinceMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  } else if (range === '24h') {
    sinceMs = nowMs - 24 * 3600 * 1000;
  } else if (range === '7d') {
    sinceMs = nowMs - 7 * 24 * 3600 * 1000;
  } else if (range === '30d') {
    sinceMs = nowMs - 30 * 24 * 3600 * 1000;
  }

  return withIndexDb(options, (db) => {
    const modelRows = prepareCached(
      db,
      'SELECT DISTINCT model FROM calls WHERE ts_ms >= ? ORDER BY model ASC'
    ).all(sinceMs);
    const models = modelRows.map((r) => r.model).filter(Boolean);

    const rows =
      modelFilter !== 'all'
        ? prepareCached(
            db,
            `SELECT model, input_tokens, cache_read_tokens, output_tokens,
                    estimated_cost_usd, cache_drop, timing_source,
                    effective_tps, duration_ms, ttft_ms
             FROM calls
             WHERE ts_ms >= ? AND model = ?`
          ).all(sinceMs, modelFilter)
        : prepareCached(
            db,
            `SELECT model, input_tokens, cache_read_tokens, output_tokens,
                    estimated_cost_usd, cache_drop, timing_source,
                    effective_tps, duration_ms, ttft_ms
             FROM calls
             WHERE ts_ms >= ?`
          ).all(sinceMs);

    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let totalCostUsdSum = 0;
    let cacheDropCount = 0;

    let timedCount = 0;
    let tpsOutSum = 0;
    let tpsMsSum = 0;
    let tpsFallbackSum = 0;

    let ttftCount = 0;
    let ttftSum = 0;

    const byModelMap = new Map();

    for (const r of rows) {
      const inp = Math.max(0, Number(r.input_tokens) || 0);
      const cache = Math.max(0, Number(r.cache_read_tokens) || 0);
      const out = Math.max(0, Number(r.output_tokens) || 0);
      const cost = Number(r.estimated_cost_usd) || 0;
      const drop = r.cache_drop ? 1 : 0;

      inputTokens += inp;
      cacheReadTokens += cache;
      outputTokens += out;
      totalCostUsdSum += cost;
      cacheDropCount += drop;

      const modelName = r.model || 'unknown';
      let bucket = byModelMap.get(modelName);
      if (!bucket) {
        bucket = {
          model: modelName,
          requests: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          timedCount: 0,
          tpsOutSum: 0,
          tpsMsSum: 0,
          tpsFallbackSum: 0,
        };
        byModelMap.set(modelName, bucket);
      }
      bucket.requests += 1;
      bucket.inputTokens += inp;
      bucket.cacheReadTokens += cache;
      bucket.outputTokens += out;
      bucket.costUsd += cost;

      const effTps = Number(r.effective_tps) || 0;
      const dur = Math.max(0, Number(r.duration_ms) || 0);
      const ttft = r.ttft_ms != null && Number.isFinite(Number(r.ttft_ms)) ? Number(r.ttft_ms) : null;

      if (r.timing_source !== 'estimated' && effTps > 0 && out > 0) {
        const activeMs = ttft != null && dur > ttft ? dur - ttft : dur;
        timedCount += 1;
        tpsFallbackSum += effTps;
        if (activeMs > 0) {
          tpsOutSum += out;
          tpsMsSum += activeMs;
        }
        bucket.timedCount += 1;
        bucket.tpsFallbackSum += effTps;
        if (activeMs > 0) {
          bucket.tpsOutSum += out;
          bucket.tpsMsSum += activeMs;
        }
      }

      if (ttft != null && ttft > 0) {
        ttftCount += 1;
        ttftSum += ttft;
      }
    }

    const totalRequests = rows.length;
    const totalTokens = inputTokens + cacheReadTokens + outputTokens;
    const totalIn = inputTokens + cacheReadTokens;
    const cacheHitRate = totalIn > 0 ? Number(((cacheReadTokens / totalIn) * 100).toFixed(1)) : 0;

    const avgTps =
      tpsMsSum > 0 && tpsOutSum > 0
        ? Number((tpsOutSum / (tpsMsSum / 1000)).toFixed(1))
        : timedCount > 0
          ? Number((tpsFallbackSum / timedCount).toFixed(1))
          : 0;

    const avgTtftMs = ttftCount > 0 ? Number((ttftSum / ttftCount).toFixed(1)) : 0;

    const byModel = [...byModelMap.values()]
      .map((m) => {
        const mTotalTokens = m.inputTokens + m.cacheReadTokens + m.outputTokens;
        const mTotalIn = m.inputTokens + m.cacheReadTokens;
        const mCacheHitRate = mTotalIn > 0 ? Number(((m.cacheReadTokens / mTotalIn) * 100).toFixed(1)) : 0;
        const mAvgTps =
          m.tpsMsSum > 0 && m.tpsOutSum > 0
            ? Number((m.tpsOutSum / (m.tpsMsSum / 1000)).toFixed(1))
            : m.timedCount > 0
              ? Number((m.tpsFallbackSum / m.timedCount).toFixed(1))
              : 0;
        return {
          model: m.model,
          requests: m.requests,
          totalTokens: mTotalTokens,
          inputTokens: m.inputTokens,
          cacheReadTokens: m.cacheReadTokens,
          outputTokens: m.outputTokens,
          cacheHitRate: mCacheHitRate,
          costUsd: Number(m.costUsd.toFixed(6)),
          avgTps: mAvgTps,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.model.localeCompare(b.model));

    return {
      range,
      modelFilter,
      sinceMs,
      updatedAt: new Date().toISOString(),
      totalRequests,
      totalTokens,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalCostUsd: Number(totalCostUsdSum.toFixed(6)),
      cacheDropCount,
      cacheHitRate,
      avgTps,
      timedCount,
      avgTtftMs,
      ttftCount,
      models,
      byModel,
    };
  });
}
