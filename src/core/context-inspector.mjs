import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir, getConfigRoot, findTranscriptPath } from './paths.mjs';
import { loadConfig, getModelLimit } from './config.mjs';
import { getGitContext } from './git-context.mjs';
import { buildCompactBrief } from './vault.mjs';
import { redactText } from './redact.mjs';
import { createLruCache, isPathInsideRoot, previewAuthorizedFile, safeRealpath } from './fs-utils.mjs';
import { scanEcosystemInventory, clearEcosystemInventoryCache } from './ecosystem-inventory.mjs';
import { getTranscriptAnalysis, listConversations } from './transcript-parser.mjs';
import { getTelemetryReport, evaluateAlerts } from './telemetry.mjs';
import { resolveTargetSession } from './session-tracker.mjs';

const skillFileTokensCache = createLruCache(128);

export function clearContextInspectorCache() {
  clearEcosystemInventoryCache();
  skillFileTokensCache.clear();
}

function fmtSizeK(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

/**
 * Project unified ecosystem inventory into context-inspector MCP / Rules / Skills / Agents view.
 * Strictly honors disabled plugins from config.json and separates eager vs deferred MCP tokens.
 */
function projectInventoryForContext(eco, loadedSkillPaths, workspaceDir, options = {}) {
  // 1. Active MCP servers (enabled configured + cache-only deferred dirs)
  const mcpItems = [];
  let eagerTokens = 0;
  let eagerCount = 0;
  let deferredTokens = 0;
  let deferredCount = 0;

  for (const s of eco.mcpServers || []) {
    if (!s.enabled) continue;
    eagerTokens += Number(s.eagerTokens) || 0;
    eagerCount += Number(s.eagerCount) || 0;
    deferredTokens += Number(s.deferredTokens) || 0;
    deferredCount += Number(s.deferredCount) || 0;

    const displayName = s.isOwnPlugin && s.shortName ? s.shortName : s.name;
    const meta = s.isOwnPlugin
      ? '5 model + 11 app-only'
      : s.mode === 'deferred'
        ? `${s.toolCount} tools (deferred)`
        : 'configured MCP server';

    mcpItems.push({
      name: displayName,
      kind: 'mcp_server',
      mode: s.mode,
      sourceLayer: s.scope || 'global',
      filePath: s.filePath || s.configFile || '',
      displayPath: s.displayPath || s.displayConfigFile || '',
      toolCount: s.toolCount,
      deferredCount: s.deferredCount ?? (s.mode === 'deferred' ? s.toolCount : 0),
      eagerCount: s.eagerCount ?? (s.mode === 'eager' ? s.toolCount : 0),
      eagerTokens: Number(s.eagerTokens) || 0,
      deferredTokens: Number(s.deferredTokens) || 0,
      tokens: Number(s.tokens) || 0,
      meta,
      size: fmtSizeK(Number(s.tokens) || 0),
      tools: Array.isArray(s.tools) ? s.tools : [],
    });
  }

  for (const c of eco.cachedOnlyMcpServers || []) {
    deferredTokens += Number(c.deferredTokens) || 0;
    deferredCount += Number(c.deferredCount) || 0;
    mcpItems.push({
      name: c.name,
      kind: 'mcp_server',
      mode: 'deferred',
      sourceLayer: 'global',
      filePath: c.filePath || '',
      displayPath: c.displayPath || '',
      toolCount: c.toolCount,
      deferredCount: c.deferredCount,
      eagerCount: 0,
      eagerTokens: 0,
      deferredTokens: Number(c.deferredTokens) || 0,
      tokens: Number(c.tokens) || 0,
      meta: `${c.toolCount} tools (deferred)`,
      size: fmtSizeK(Number(c.tokens) || 0),
      tools: Array.isArray(c.tools) ? c.tools : [],
    });
  }
  mcpItems.sort((a, b) => b.tokens - a.tokens);

  // 2. Active Rules + Vault SessionStart Compact Brief
  const ruleItems = (eco.rules || [])
    .filter((r) => r.active)
    .map((r) => ({
      name: r.displayName || r.name,
      kind: 'rule',
      sourceLayer: r.scope || 'workspace',
      filePath: r.filePath || '',
      displayPath: r.displayPath || '',
      meta:
        r.scope === 'plugin'
          ? r.pluginId === 'context-cache'
            ? 'plugin slim rule'
            : 'global plugin rule'
          : r.scope === 'global'
            ? 'global rule'
            : 'workspace rule',
      tokens: r.tokens,
      size: fmtSizeK(r.tokens),
      bytes: r.bytes || 0,
      path: r.filePath || '',
    }));

  const brief = buildCompactBrief({ projectDir: workspaceDir }, options);
  if (brief.tokens > 0) {
    const briefPreview = redactText(brief.text || '');
    ruleItems.push({
      name: 'SessionStart Compact Brief',
      kind: 'brief',
      sourceLayer: 'vault',
      filePath: '',
      displayPath: brief.projectStoragePath || '',
      meta: `vault (${brief.count} items)`,
      tokens: brief.tokens,
      size: fmtSizeK(brief.tokens),
      bytes: Buffer.byteLength(briefPreview, 'utf8'),
      previewText: briefPreview,
    });
  }
  ruleItems.sort((a, b) => b.tokens - a.tokens);
  const rulesTotalTokens = ruleItems.reduce((s, f) => s + f.tokens, 0);

  // 3. Active Skills (metadata summaries + transcript-loaded full skills) & Active Custom Agents
  const activeSkills = (eco.skills || []).filter((sk) => sk.active && !sk.shadowedBy);
  const skillMetadataTokens = activeSkills.length * 45;
  const loadedSkills = [];
  let loadedSkillsTokens = 0;

  if (loadedSkillPaths && loadedSkillPaths.size > 0) {
    for (const sk of activeSkills) {
      const normP = sk.normPath || path.resolve(sk.filePath).toLowerCase();
      if (!loadedSkillPaths.has(normP)) continue;
      loadedSkillsTokens += sk.fullTokens;
      loadedSkills.push({
        name: sk.name,
        kind: 'skill',
        sourceLayer: sk.scope || 'global',
        filePath: sk.filePath,
        displayPath: sk.displayPath,
        meta: 'skill (loaded)',
        tokens: sk.fullTokens,
        size: fmtSizeK(sk.fullTokens),
        bytes: sk.bytes || 0,
      });
    }
  }
  loadedSkills.sort((a, b) => b.tokens - a.tokens);

  const activeAgents = (eco.agents || []).filter((a) => a.active);
  const agentTokens = activeAgents.reduce((s, a) => s + a.tokens, 0);

  return {
    mcpScan: {
      servers: mcpItems,
      eagerTokens,
      eagerCount,
      deferredTokens,
      deferredCount,
    },
    rulesScan: {
      files: ruleItems,
      totalTokens: rulesTotalTokens,
    },
    skillScan: {
      skillsTotalTokens: skillMetadataTokens + loadedSkillsTokens,
      totalDiscoveredSkills: activeSkills.length,
      loadedSkillsCount: loadedSkills.length,
      loadedSkills,
      agents: activeAgents,
      agentTokens,
    },
  };
}

/**
 * Inspect full context breakdown, deferred tools, mounted inventories, bloat attribution,
 * and deterministic `rev` digest for zero-DOM-recompute polling short-circuiting.
 */
export function inspectContext(params = {}, options = {}) {
  const config = loadConfig(options);
  const fallbackWorkspace = params.projectDir || options.projectDir || process.cwd();

  const sessions = listConversations({ ...options, limit: 18, includeRecentSubagents: true });
  const isAggregateAll = params.conversationId === '__active_all__';
  const followActive = !isAggregateAll && params.followActive !== false && !params.conversationId;
  const target = resolveTargetSession(
    {
      requestedConversationId: isAggregateAll ? null : params.conversationId || null,
      followActive,
      sessions,
      fallbackProjectDir: fallbackWorkspace,
      requestedProjectDir: params.explicitProjectDir || '',
      requestedTranscriptPath: isAggregateAll ? '' : params.transcriptPath || '',
    },
    options
  );

  const convId = target.conversationId;
  const workspaceDir = target.projectDir || fallbackWorkspace;
  const tPath = target.transcriptPath || (convId ? findTranscriptPath(convId, options) : null);
  const git = getGitContext(workspaceDir);

  const sessionList = [...sessions];
  if (convId && !sessionList.some((s) => s.conversationId === convId)) {
    sessionList.unshift({
      conversationId: convId,
      label: `新会话 (${convId.slice(0, 8)})`,
      lastModel: '',
      stepCount: 0,
      lastUsedTokens: 0,
      mtimeMs: target.activeSession?.updatedAtMs || Date.now(),
    });
  }

  // O(1) incremental transcript analysis (no full re-parse or JSON.stringify over historical steps)
  const analysis = tPath && fs.existsSync(tPath) ? getTranscriptAnalysis(tPath) : null;
  const acc = analysis?.acc || null;
  const latestPlanner = acc?.latestPlanner || null;

  const matchedSession = sessionList.find((s) => s.conversationId === convId);
  const model = latestPlanner?.model || matchedSession?.lastModel || 'gemini-4-neon-high';
  const limitTokens = getModelLimit(model, config);
  const usedTokens = latestPlanner ? latestPlanner.inputTokens + latestPlanner.cacheReadTokens : 0;

  const msgRawTokens = acc ? acc.msgRawTokens : 0;
  const toolOutputTokens = acc ? acc.toolOutputTokens : 0;
  const loadedSkillPaths = acc ? acc.loadedSkillPaths : new Set();

  // Unified ecosystem inventory (5s fast-TTL + 15s fingerprint, strictly respects disabled plugins)
  const eco = scanEcosystemInventory({ projectDir: workspaceDir, force: Boolean(params.force) }, options);
  const { mcpScan, rulesScan, skillScan } = projectInventoryForContext(eco, loadedSkillPaths, workspaceDir, options);

  const fixedActive = mcpScan.eagerTokens + skillScan.skillsTotalTokens + rulesScan.totalTokens + skillScan.agentTokens;
  let messagesTokens = msgRawTokens;
  let systemBaselineTokens = 0;

  if (usedTokens > 0) {
    if (fixedActive + messagesTokens <= usedTokens) {
      systemBaselineTokens = Math.max(0, usedTokens - fixedActive - messagesTokens);
    } else {
      systemBaselineTokens = Math.min(12000, Math.round(usedTokens * 0.1));
      const budgetForMsg = Math.max(0, usedTokens - fixedActive - systemBaselineTokens);
      messagesTokens = budgetForMsg;
    }
  }

  const effectiveUsed = usedTokens > 0 ? usedTokens : fixedActive + messagesTokens;
  const freeTokens = Math.max(0, limitTokens - effectiveUsed);
  const usedPercent = limitTokens > 0 ? Number(((effectiveUsed / limitTokens) * 100).toFixed(1)) : 0;

  const breakdown = [
    {
      id: 'msg',
      key: 'Messages',
      tokens: messagesTokens,
      color: 'var(--chart-1)',
      note: '对话历史与工具输出',
    },
    {
      id: 'sys',
      key: 'System baseline',
      tokens: systemBaselineTokens,
      color: 'var(--chart-2)',
      note: '系统底座与内置工具残差',
    },
    {
      id: 'mcp',
      key: 'MCP tools',
      tokens: mcpScan.eagerTokens,
      color: 'var(--chart-3)',
      note: `${mcpScan.eagerCount} 个常驻工具`,
    },
    {
      id: 'skl',
      key: 'Skills',
      tokens: skillScan.skillsTotalTokens,
      color: 'var(--chart-4)',
      note: `${skillScan.totalDiscoveredSkills} 技能摘要 + ${skillScan.loadedSkillsCount} 已激活`,
    },
    {
      id: 'mem',
      key: 'Memory & Rules',
      tokens: rulesScan.totalTokens,
      color: 'var(--chart-5)',
      note: `${rulesScan.files.length} 份规则与简报`,
    },
    {
      id: 'agt',
      key: 'Custom agents',
      tokens: skillScan.agentTokens,
      color: 'var(--chart-6)',
      note: `${skillScan.agents.length} 个自定义子代理`,
    },
  ];

  const deferred = [
    {
      id: 'mcp_deferred',
      key: 'MCP tools (deferred)',
      tokens: mcpScan.deferredTokens,
      toolCount: mcpScan.deferredCount,
      count: `${mcpScan.deferredCount} tools`,
    },
  ];

  const inventories = [
    {
      id: 'mcp_servers',
      title: 'MCP servers & tools',
      stats: { deferred: mcpScan.deferredCount, eager: mcpScan.eagerCount },
      count: `${mcpScan.deferredCount} deferred / ${mcpScan.eagerCount} eager`,
      items: mcpScan.servers.slice(0, 50).map((s) => ({
        name: s.name,
        kind: s.kind || 'mcp_server',
        mode: s.mode,
        sourceLayer: s.sourceLayer || 'global',
        filePath: s.filePath || '',
        displayPath: s.displayPath || '',
        tokens: s.tokens,
        eagerTokens: s.eagerTokens,
        deferredTokens: s.deferredTokens,
        toolCount: s.toolCount,
        deferredCount: s.deferredCount ?? (s.mode === 'deferred' ? s.toolCount : 0),
        eagerCount: s.eagerCount ?? (s.mode === 'eager' ? s.toolCount : 0),
        meta: s.meta,
        size: s.size,
        tools: Array.isArray(s.tools) ? s.tools : [],
      })),
    },
    {
      id: 'memory_rules',
      title: 'Memory & Rules files',
      stats: { files: rulesScan.files.length },
      count: `${rulesScan.files.length} files`,
      items: rulesScan.files.slice(0, 50).map((f) => ({
        name: f.name,
        kind: f.kind || 'rule',
        sourceLayer: f.sourceLayer || 'workspace',
        filePath: f.filePath || '',
        displayPath: f.displayPath || '',
        tokens: f.tokens,
        bytes: f.bytes || 0,
        meta: f.meta,
        size: f.size,
        ...(f.previewText ? { previewText: f.previewText } : {}),
      })),
    },
    {
      id: 'skills_agents',
      title: 'Active Skills & Custom Agents',
      stats: { active: skillScan.loadedSkillsCount, agents: skillScan.agents.length },
      count: `${skillScan.loadedSkillsCount} active / ${skillScan.agents.length} agents`,
      items: [...skillScan.loadedSkills, ...skillScan.agents].slice(0, 50).map((it) => ({
        name: it.name,
        kind: it.kind || 'skill',
        sourceLayer: it.sourceLayer || 'global',
        filePath: it.filePath || '',
        displayPath: it.displayPath || '',
        tokens: it.tokens,
        bytes: it.bytes || 0,
        meta: it.meta,
        size: it.size,
      })),
    },
  ];

  // Bloat attribution analysis
  const sortedParts = [...breakdown].sort((a, b) => b.tokens - a.tokens);
  const top1 = sortedParts[0];
  const toolRatio = msgRawTokens > 0 ? Math.round((toolOutputTokens / msgRawTokens) * 100) : 0;
  const heavyMcp = mcpScan.servers.filter((s) => s.tokens >= (config.alerts.mcpServerWarnTokens || 15000));

  const attrParts = [];
  if (usedPercent >= config.alerts.contextWarningPct) {
    attrParts.push(
      `当前上下文已达 ${usedPercent}%（超过 ${config.alerts.contextWarningPct}% 警戒线），建议先生成交接胶囊再执行 /compact`
    );
  } else if (top1 && effectiveUsed > 0) {
    const share = ((top1.tokens / limitTokens) * 100).toFixed(1);
    const extra = top1.id === 'msg' && toolRatio > 0 ? `（工具返回占比约 ${toolRatio}%）` : '';
    attrParts.push(`首要占用为 ${top1.key} 占 ${share}%${extra}`);
  }
  if (mcpScan.deferredCount > 0) {
    attrParts.push(`发现 ${mcpScan.deferredCount} 个懒加载 MCP 工具（${fmtSizeK(mcpScan.deferredTokens)}，未占常驻上下文）`);
  }
  if (heavyMcp.length > 0) {
    attrParts.push(`偏重 MCP 服务：${heavyMcp.map((s) => `${s.name} (${s.size})`).join('、')}`);
  }
  if (attrParts.length === 0) {
    attrParts.push('当前上下文结构轻盈，本插件 5 个精简模型工具仅占约 0.6K tokens。');
  }

  // Pull synced telemetry KPIs & alerts
  const telemetry = getTelemetryReport(
    {
      conversationId: isAggregateAll ? '__active_all__' : convId,
      transcriptPath: isAggregateAll ? undefined : tPath,
      force: Boolean(params.force),
    },
    options
  );
  const alerts = evaluateAlerts(telemetry.calls, config, usedPercent);

  const latestCallTsMs = (() => {
    const latestCall = (telemetry.calls || []).find((c) => c.agentType === 'main') || (telemetry.calls || [])[0];
    if (latestCall?.tsMs) {
      const dur = Number(latestCall.durationMs) || 0;
      return latestCall.tsMs + (dur > 0 && dur < 600_000 ? dur : 0);
    }
    return latestPlanner?.tsMs || matchedSession?.mtimeMs || 0;
  })();

  const isTurnActive = Boolean(matchedSession?.isActive && target.activeSession?.event === 'PreInvocation');

  // Deterministic 12-hex revision digest for lastRev short-circuiting (§1.3 #3)
  const revSeed = [
    isAggregateAll ? '__active_all__' : convId || '',
    workspaceDir || '',
    analysis?.offset ?? 0,
    analysis?.size ?? 0,
    eco.fingerprint || '',
    effectiveUsed,
    limitTokens,
    mcpScan.eagerTokens,
    mcpScan.deferredTokens,
    rulesScan.totalTokens,
    skillScan.skillsTotalTokens,
    telemetry.rev || '',
    latestCallTsMs,
    isTurnActive ? 1 : 0,
    git.branch || '',
    git.head || '',
    git.dirty ? 1 : 0,
    sessionList.length,
    sessionList[0]?.conversationId || '',
    sessionList[0]?.mtimeMs || 0,
  ].join('|');
  const rev = crypto.createHash('sha256').update(revSeed).digest('hex').slice(0, 12);

  return {
    rev,
    conversationId: isAggregateAll ? '__active_all__' : convId,
    projectDir: workspaceDir,
    followResolvedBy: isAggregateAll ? 'aggregate_active' : target.source,
    sessions: sessionList.map((s) => ({
      id: s.conversationId,
      label: s.label,
      model: s.lastModel,
      usedTokens: s.lastUsedTokens,
      stepCount: s.stepCount,
      isSubagent: Boolean(s.isSubagent),
      parentId: s.parentConversationId || null,
      subTag: s.subTag || null,
      isActive: Boolean(s.isActive),
      mtimeMs: s.mtimeMs || 0,
    })),
    git: {
      projectId: git.projectId,
      projectName: git.projectName,
      branch: git.branch,
      head: git.head,
      dirty: git.dirty,
    },
    model,
    latestModel: telemetry.summary.latestModel || latestPlanner?.model || matchedSession?.lastModel || '',
    latestCallTsMs,
    isTurnActive,
    usedTokens: effectiveUsed,
    limitTokens,
    freeTokens,
    usedPercent,
    latestCacheHitRate: telemetry.summary.latestCacheHitRate,
    avgTps: telemetry.summary.avgTps,
    totalCostUsd: telemetry.summary.totalCostUsd,
    totalCallsCount: telemetry.totalCallsCount,
    attribution: attrParts.join('；') + '。',
    topSources: sortedParts.slice(0, 3).map((p) => ({ key: p.key, tokens: p.tokens })),
    breakdown,
    deferred,
    inventories,
    alerts,
  };
}

function inferAssetSourceLayer(realPath, workspaceDir, options = {}) {
  const appDir = safeRealpath(getAppDataDir(options));
  const configRoot = safeRealpath(getConfigRoot(options));
  if (isPathInsideRoot(realPath, path.join(appDir, 'builtin'))) return 'builtin';
  if (isPathInsideRoot(realPath, path.join(configRoot, 'plugins'))) return 'plugin';
  if (isPathInsideRoot(realPath, configRoot) || isPathInsideRoot(realPath, appDir)) return 'global';
  if (workspaceDir && isPathInsideRoot(realPath, safeRealpath(workspaceDir))) return 'workspace';
  return 'workspace';
}

function inferAssetKind(realPath) {
  const base = path.basename(realPath).toLowerCase();
  const norm = realPath.replace(/\\/g, '/').toLowerCase();
  if (base === 'skill.md') return 'skill';
  if (norm.includes('/agents/') && base.endsWith('.md')) return 'agent';
  if (base === 'agents.md' || base === 'gemini.md' || norm.includes('/rules/')) return 'rule';
  if (base === 'mcp_config.json' || norm.includes('/mcp/')) return 'mcp_server';
  return 'file';
}

/**
 * Strictly read-only, boundary-checked, redacted preview for mounted context assets
 * delegating core security checks to `fs-utils.mjs` `previewAuthorizedFile`.
 */
export function previewContextAsset(params = {}, options = {}) {
  const workspaceDir = params.projectDir || options.projectDir || process.cwd();
  const rawRoots = [getConfigRoot(options), getAppDataDir(options), workspaceDir].filter(Boolean);
  const allowedRoots = [];
  for (const r of rawRoots) {
    const resolvedRoot = path.resolve(r);
    allowedRoots.push(resolvedRoot);
    const realRoot = safeRealpath(resolvedRoot);
    if (realRoot.toLowerCase() !== resolvedRoot.toLowerCase()) {
      allowedRoots.push(realRoot);
    }
  }

  let base;
  try {
    base = previewAuthorizedFile({
      filePath: params.filePath,
      allowedRoots,
      maxChars: 24000,
    });
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('超出工作区') || msg.includes('符号链接')) {
      throw new Error(`拒绝读取：${msg}`);
    }
    throw err;
  }

  const realPath = safeRealpath(base.filePath);
  return {
    ...base,
    filePath: realPath,
    kind: inferAssetKind(realPath),
    sourceLayer: inferAssetSourceLayer(realPath, workspaceDir, options),
    size: fmtSizeK(base.tokens),
  };
}
