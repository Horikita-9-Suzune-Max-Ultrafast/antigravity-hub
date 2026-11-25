import { loadConfig, saveConfig, getModelPricing } from './config.mjs';
import { queryCalls, resolveQuotaGroup } from './telemetry.mjs';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Weighted token consumption used for sliding-window quota deduction.
 * Cached input reads carry a 0.1x weight; output tokens carry a 3x weight.
 */
export function weightedTokens(call) {
  const freshIn = Number(call.inputTokens) || 0;
  const cachedIn = Number(call.cacheReadTokens) || 0;
  const out = Number(call.outputTokens) || 0;
  return freshIn + cachedIn * 0.1 + out * 3;
}

/**
 * Abstract QuotaProvider port (allows plugging in future official Quota API/CLI without touching UI/core).
 */
export class QuotaProvider {
  constructor(name = 'base') {
    this.name = name;
  }
  getSnapshot(_context) {
    throw new Error('QuotaProvider.getSnapshot must be implemented');
  }
}

/**
 * Default compliant provider: local 5h/7d sliding windows + user baseline calibration.
 */
export class LocalCalibratedQuotaProvider extends QuotaProvider {
  constructor() {
    super('local-calibrated');
  }

  getSnapshot({ calls, config, nowMs = Date.now() }) {
    const groups = config.quotaGroups || [];
    const calibrations = config.quotaCalibrations || {};

    const results = groups.map((group) => {
      const groupCalls = calls.filter((c) => (c.quotaGroup || resolveQuotaGroup(c.model, config)) === group.id);
      const cal = calibrations[group.id] || null;

      // 7d window stats
      const calls7d = groupCalls.filter((c) => c.tsMs >= nowMs - SEVEN_DAYS_MS);
      const rawTokens7d = calls7d.reduce((s, c) => s + (c.inputTokens || 0) + (c.cacheReadTokens || 0) + (c.outputTokens || 0), 0);
      const weighted7d = calls7d.reduce((s, c) => s + weightedTokens(c), 0);

      // 5h window stats
      const calls5h = groupCalls.filter((c) => c.tsMs >= nowMs - FIVE_HOURS_MS);
      const weighted5h = calls5h.reduce((s, c) => s + weightedTokens(c), 0);

      const weeklyBudget = cal?.weeklyBudgetTokens || group.defaultWeeklyBudgetTokens || 10_000_000;
      const h5Budget = cal?.h5BudgetTokens || group.default5hBudgetTokens || 2_000_000;

      // Weekly remaining calculation with auto-reset when nowMs >= weeklyResetAt
      let weeklyPct = 100;
      let weeklyHrs = 168;
      let weeklyCalibrated = false;

      if (cal && cal.weeklyResetAt && nowMs < cal.weeklyResetAt) {
        weeklyCalibrated = true;
        const postCalCalls = groupCalls.filter((c) => c.tsMs > cal.calibratedAt && c.tsMs <= nowMs);
        const postWeighted = postCalCalls.reduce((s, c) => s + weightedTokens(c), 0);
        const dropPct = weeklyBudget > 0 ? (postWeighted / weeklyBudget) * 100 : 0;
        weeklyPct = Math.max(0, Math.min(100, Math.round(cal.weeklyBaselinePct - dropPct)));
        weeklyHrs = Math.max(1, Math.ceil((cal.weeklyResetAt - nowMs) / HOUR_MS));
      } else {
        // Uncalibrated or rolled into new cycle after resetAt
        const windowStart = cal && cal.weeklyResetAt && nowMs >= cal.weeklyResetAt ? cal.weeklyResetAt : nowMs - SEVEN_DAYS_MS;
        const cycleCalls = groupCalls.filter((c) => c.tsMs >= windowStart && c.tsMs <= nowMs);
        const cycleWeighted = cycleCalls.reduce((s, c) => s + weightedTokens(c), 0);
        const usedPct = weeklyBudget > 0 ? (cycleWeighted / weeklyBudget) * 100 : 0;
        weeklyPct = Math.max(0, Math.min(100, Math.round(100 - usedPct)));
        weeklyHrs = 168;
      }

      // 5h remaining calculation
      let h5Pct = null;
      let h5Mins = null;
      if (group.has5hWindow) {
        if (cal && cal.h5ResetAt && nowMs < cal.h5ResetAt && cal.h5BaselinePct != null) {
          const postCal5h = groupCalls.filter((c) => c.tsMs > cal.calibratedAt && c.tsMs <= nowMs);
          const postWeighted5h = postCal5h.reduce((s, c) => s + weightedTokens(c), 0);
          const drop5h = h5Budget > 0 ? (postWeighted5h / h5Budget) * 100 : 0;
          h5Pct = Math.max(0, Math.min(100, Math.round(cal.h5BaselinePct - drop5h)));
          h5Mins = Math.max(1, Math.ceil((cal.h5ResetAt - nowMs) / 60_000));
        } else {
          const windowStart5h = cal && cal.h5ResetAt && nowMs >= cal.h5ResetAt ? cal.h5ResetAt : nowMs - FIVE_HOURS_MS;
          const cycle5h = groupCalls.filter((c) => c.tsMs >= windowStart5h && c.tsMs <= nowMs);
          const cycleW5h = cycle5h.reduce((s, c) => s + weightedTokens(c), 0);
          const used5h = h5Budget > 0 ? (cycleW5h / h5Budget) * 100 : 0;
          h5Pct = Math.max(0, Math.min(100, Math.round(100 - used5h)));
          h5Mins = 300;
        }
      }

      return {
        id: group.id,
        name: group.name,
        desc: group.desc,
        has5hWindow: Boolean(group.has5hWindow),
        weeklyPct,
        weeklyHrs,
        h5Pct,
        h5Mins,
        localTokens7d: fmtTokens(rawTokens7d),
        localTokens7dRaw: rawTokens7d,
        localWeighted7d: Math.round(weighted7d),
        localCalls7d: calls7d.length,
        localCalls5h: calls5h.length,
        localWeighted5h: Math.round(weighted5h),
        calibrated: weeklyCalibrated,
        calibratedAt: cal?.calibratedAt ? new Date(cal.calibratedAt).toISOString() : null,
      };
    });

    // 7-day daily usage chart + cache savings summary
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const buckets = [];
    const todayStart = new Date(nowMs);
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();

    for (let offset = 6; offset >= 0; offset--) {
      const start = todayStartMs - offset * DAY_MS;
      const end = start + DAY_MS;
      const d = new Date(start);
      const dayCalls = calls.filter((c) => c.tsMs >= start && c.tsMs < end);
      const cachedTokens = dayCalls.reduce((s, c) => s + (c.cacheReadTokens || 0), 0);
      const freshTokens = dayCalls.reduce((s, c) => s + (c.inputTokens || 0), 0);
      const totalIn = cachedTokens + freshTokens;
      buckets.push({
        day: offset === 0 ? '今天' : dayNames[d.getDay()],
        cachedTokens,
        freshTokens,
        totalTokens: totalIn,
        calls: dayCalls.length,
      });
    }

    const maxDayTokens = Math.max(1, ...buckets.map((b) => b.totalTokens));
    const weeklyChart = buckets.map((b) => {
      const totalPct = b.totalTokens > 0 ? Math.max(12, Math.round((b.totalTokens / maxDayTokens) * 92)) : 6;
      const cachedRatio = b.totalTokens > 0 ? b.cachedTokens / b.totalTokens : 0;
      return {
        day: b.day,
        total: totalPct,
        cached: Math.round(totalPct * cachedRatio),
        totalTokens: b.totalTokens,
        cachedTokens: b.cachedTokens,
        calls: b.calls,
      };
    });

    // Cache savings estimate over last 7 days
    let totalSavedUsd = 0;
    let totalCtx7d = 0;
    let totalCached7d = 0;
    for (const c of calls.filter((x) => x.tsMs >= nowMs - SEVEN_DAYS_MS)) {
      const p = getModelPricing(c.model, config);
      const saved = ((c.cacheReadTokens || 0) * Math.max(0, p.input - p.cacheRead)) / 1_000_000;
      totalSavedUsd += saved;
      totalCtx7d += (c.inputTokens || 0) + (c.cacheReadTokens || 0);
      totalCached7d += c.cacheReadTokens || 0;
    }
    const avgCacheHit7d = totalCtx7d > 0 ? Number(((totalCached7d / totalCtx7d) * 100).toFixed(1)) : 0;

    return {
      provider: this.name,
      groups: results,
      weeklyChart,
      savings7d: {
        savedUsd: Number(totalSavedUsd.toFixed(2)),
        avgCacheHitPct: avgCacheHit7d,
      },
    };
  }
}

const defaultProvider = new LocalCalibratedQuotaProvider();

/**
 * Retrieve quota snapshot using the active QuotaProvider.
 */
export function getQuotaSnapshot(params = {}, options = {}) {
  const config = loadConfig(options);
  const nowMs = params.nowMs || Date.now();
  const calls = Array.isArray(params.calls)
    ? params.calls
    : queryCalls({ sinceMs: nowMs - SEVEN_DAYS_MS, limit: 0 }, options);
  const provider = options.provider || defaultProvider;
  return provider.getSnapshot({ calls, config, nowMs });
}

/**
 * Persist a user baseline calibration for a quota group and return updated snapshot.
 */
export function calibrateQuotaGroup(input, options = {}) {
  const config = loadConfig(options);
  const group = (config.quotaGroups || []).find((g) => g.id === input.groupId);
  if (!group) throw new Error(`Unknown quota group: ${input.groupId}`);

  const nowMs = input.nowMs || Date.now();
  const weeklyPct = Math.max(0, Math.min(100, Number(input.weeklyPct ?? 100)));
  const weeklyHrs = Math.max(1, Math.min(168, Number(input.weeklyHrs ?? 168)));
  const h5Pct = group.has5hWindow ? Math.max(0, Math.min(100, Number(input.h5Pct ?? 100))) : null;
  const h5Mins = group.has5hWindow ? Math.max(1, Math.min(300, Number(input.h5Mins ?? 300))) : null;

  const calEntry = {
    calibratedAt: nowMs,
    weeklyBaselinePct: weeklyPct,
    weeklyResetAt: nowMs + weeklyHrs * HOUR_MS,
    weeklyBudgetTokens: Number(input.weeklyBudgetTokens) || group.defaultWeeklyBudgetTokens,
    h5BaselinePct: h5Pct,
    h5ResetAt: h5Mins != null ? nowMs + h5Mins * 60_000 : null,
    h5BudgetTokens: Number(input.h5BudgetTokens) || group.default5hBudgetTokens,
  };

  saveConfig({ quotaCalibrations: { [group.id]: calEntry } }, options);
  return getQuotaSnapshot({ nowMs }, options);
}
