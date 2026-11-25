import { getModelLimit } from '../config.mjs';

/**
 * Evaluate local anomaly alerts (0 model tokens):
 * 1) Context > threshold%
 * 2) Recent cache drop
 * 3) Single subagent high context/cost share
 * 4) Consecutive low TPS streak (< threshold for N+ steps, excluding 'estimated')
 * 5) Long-context media / image cache hygiene risk
 * 6) Micro-step inefficiency streak
 */
export function evaluateAlerts(calls, config, contextPct = null) {
  const alerts = [];
  if (!Array.isArray(calls) || calls.length === 0) return alerts;

  const mainCalls = calls.filter((c) => c.agentType === 'main');
  const latestMain = mainCalls[0] || calls[0];
  const limit = getModelLimit(latestMain?.model, config);
  const pct =
    contextPct != null ? contextPct : latestMain && limit > 0 ? (latestMain.contextTokens / limit) * 100 : 0;

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
    if (
      sub.maxCtx >= config.alerts.subagentContextWarnTokens ||
      sharePct >= config.alerts.subagentShareThresholdPct
    ) {
      alerts.push({
        code: 'subagent_burst',
        level: 'warning',
        title: `子 Agent [${sub.tag}] 上下文达 ${(sub.maxCtx / 1000).toFixed(1)}K`,
        detail: `${sub.steps} 步累计估算 $${sub.cost.toFixed(3)}（占会话费用 ${sharePct.toFixed(0)}%），建议关注子任务收敛。`,
      });
    }
  }

  // 4. Consecutive low TPS streak (exclude 'estimated' fallback steps from alerts)
  const streakNeed = config.alerts.lowTpsStreak || 3;
  const lowThresh = config.alerts.lowTpsThreshold || 15;
  const chronological = [...calls].reverse();
  let streak = 0;
  let maxStreak = 0;
  for (const c of chronological) {
    if (c.timingSource === 'estimated') continue;
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
    if (
      c.agentType === 'main' &&
      c.outputTokens > 0 &&
      c.outputTokens < 220 &&
      (c.toolCallCount === 1 || c.toolCallCount === 0)
    ) {
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
