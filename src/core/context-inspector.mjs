import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir, getConfigRoot, findTranscriptPath } from './paths.mjs';
import { loadConfig, getModelLimit } from './config.mjs';
import { getGitContext } from './git-context.mjs';
import { estimateTokens, buildCompactBrief } from './vault.mjs';
import { parseTranscriptFull, listConversations } from './transcript-parser.mjs';
import { getTelemetryReport, evaluateAlerts } from './telemetry.mjs';
import { resolveTargetSession } from './session-tracker.mjs';

function safeReadFile(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch {
    // ignore unreadable file
  }
  return '';
}

function fmtSizeK(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${tokens}`;
}

/**
 * Scan documented MCP schema cache directories (<appDataDir>/mcp/<server>/*.json)
 * plus configured MCP servers for eager vs deferred breakdown.
 */
function scanMcpTools(options = {}) {
  const appDir = getAppDataDir(options);
  const mcpDir = path.join(appDir, 'mcp');
  const servers = [];
  let deferredTokens = 0;
  let deferredCount = 0;
  let eagerTokens = 0;
  let eagerCount = 0;

  if (fs.existsSync(mcpDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(mcpDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const serverName = entry.name;
      const serverPath = path.join(mcpDir, serverName);
      let files = [];
      try {
        files = fs.readdirSync(serverPath).filter((f) => f.endsWith('.json'));
      } catch {
        files = [];
      }
      let sTokens = 0;
      for (const f of files) {
        const text = safeReadFile(path.join(serverPath, f));
        sTokens += estimateTokens(text);
      }
      // Lazy-loaded schemas live in <appDataDir>/mcp/<server>/*.json
      deferredTokens += sTokens;
      deferredCount += files.length;
      servers.push({
        name: serverName,
        mode: 'deferred',
        toolCount: files.length,
        tokens: sTokens,
        meta: `${files.length} tools (deferred)`,
        size: fmtSizeK(sTokens),
      });
    }
  }

  // Also account for plugin's own slim 5 model-visible tools (~600t) if deployed or active
  const configRoot = getConfigRoot(options);
  const pluginsDir = path.join(configRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const pe of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!pe.isDirectory()) continue;
        const mcpCfgPath = path.join(pluginsDir, pe.name, 'mcp_config.json');
        if (!fs.existsSync(mcpCfgPath)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(mcpCfgPath, 'utf8'));
          for (const srvKey of Object.keys(cfg.mcpServers || {})) {
            const fullKey = `${pe.name}_${srvKey}`;
            if (servers.some((s) => s.name === fullKey || s.name === srvKey)) continue;
            if (pe.name === 'context-cache' || srvKey === 'context-cache-server') {
              const tok = 600;
              eagerTokens += tok;
              eagerCount += 5;
              servers.push({
                name: srvKey,
                mode: 'eager',
                toolCount: 5,
                tokens: tok,
                meta: '5 model + 7 app-only',
                size: fmtSizeK(tok),
              });
            } else {
              const tok = 900;
              eagerTokens += tok;
              eagerCount += 4;
              servers.push({
                name: fullKey,
                mode: 'eager',
                toolCount: 4,
                tokens: tok,
                meta: 'configured MCP server',
                size: fmtSizeK(tok),
              });
            }
          }
        } catch {
          // ignore malformed mcp_config
        }
      }
    } catch {
      // ignore
    }
  }

  servers.sort((a, b) => b.tokens - a.tokens);

  return {
    servers,
    eagerTokens,
    eagerCount,
    deferredTokens,
    deferredCount,
  };
}

/**
 * Scan active Rules & Memory files across global plugins, global rules, and workspace root.
 */
function scanRulesAndMemory(workspaceDir, options = {}) {
  const configRoot = getConfigRoot(options);
  const files = [];
  const seen = new Set();

  const addFile = (absPath, displayName, meta) => {
    const norm = path.resolve(absPath).toLowerCase();
    if (seen.has(norm)) return;
    const text = safeReadFile(absPath);
    if (!text) return;
    seen.add(norm);
    const tokens = estimateTokens(text);
    files.push({ name: displayName, meta, tokens, size: fmtSizeK(tokens), path: absPath });
  };

  // Global plugin rules
  const pluginsDir = path.join(configRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const pe of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!pe.isDirectory()) continue;
        const rDir = path.join(pluginsDir, pe.name, 'rules');
        if (!fs.existsSync(rDir)) continue;
        for (const f of fs.readdirSync(rDir)) {
          if (f.endsWith('.md')) {
            addFile(path.join(rDir, f), `${pe.name}/rules/${f}`, pe.name === 'context-cache' ? 'plugin slim rule' : 'global plugin rule');
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global standalone rules
  const globalRulesDir = path.join(configRoot, 'rules');
  if (fs.existsSync(globalRulesDir)) {
    try {
      for (const f of fs.readdirSync(globalRulesDir)) {
        if (f.endsWith('.md')) {
          addFile(path.join(globalRulesDir, f), `global/rules/${f}`, 'global rule');
        }
      }
    } catch {
      // ignore
    }
  }

  // Workspace rules (AGENTS.md, GEMINI.md, .agents/rules/*.md)
  if (workspaceDir && fs.existsSync(workspaceDir)) {
    const baseName = path.basename(workspaceDir);
    for (const fname of ['AGENTS.md', 'GEMINI.md']) {
      addFile(path.join(workspaceDir, fname), `${baseName}/${fname}`, 'workspace rule');
    }
    const wsRulesDir = path.join(workspaceDir, '.agents', 'rules');
    if (fs.existsSync(wsRulesDir)) {
      try {
        for (const f of fs.readdirSync(wsRulesDir)) {
          if (f.endsWith('.md')) {
            addFile(path.join(wsRulesDir, f), `${baseName}/.agents/rules/${f}`, 'workspace rule');
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Active SessionStart Compact Brief from vault
  const brief = buildCompactBrief({ projectDir: workspaceDir }, options);
  if (brief.tokens > 0) {
    files.push({
      name: 'SessionStart Compact Brief',
      meta: `vault (${brief.count} items)`,
      tokens: brief.tokens,
      size: fmtSizeK(brief.tokens),
    });
  }

  files.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = files.reduce((s, f) => s + f.tokens, 0);
  return { files, totalTokens };
}

/**
 * Scan available skills (metadata summaries) + detect skills loaded in full via read_file in transcript.
 */
function scanSkillsAndAgents(steps, workspaceDir, options = {}) {
  const configRoot = getConfigRoot(options);
  const appDir = getAppDataDir(options);

  // Detect SKILL.md paths read during transcript
  const loadedSkillPaths = new Set();
  for (const s of steps) {
    for (const tc of s.toolCalls) {
      const name = String(tc?.name || '').toLowerCase();
      if (name === 'read_file' || name === 'view_file') {
        const p = String(tc?.args?.Path || tc?.args?.path || tc?.args?.AbsolutePath || '').replace(/^"|"$/g, '');
        if (/skill\.md$/i.test(p)) {
          loadedSkillPaths.add(path.resolve(p).toLowerCase());
        }
      }
    }
  }

  const skillRoots = [
    path.join(appDir, 'builtin', 'skills'),
    path.join(configRoot, 'skills'),
  ];
  const pluginsDir = path.join(configRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const pe of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (pe.isDirectory()) skillRoots.push(path.join(pluginsDir, pe.name, 'skills'));
      }
    } catch {
      // ignore
    }
  }
  if (workspaceDir) {
    skillRoots.push(path.join(workspaceDir, '.agents', 'skills'));
  }

  const skills = [];
  const seenSkillNames = new Set();
  let skillMetadataTokens = 0;
  let loadedSkillsTokens = 0;
  let loadedSkillsCount = 0;

  for (const root of skillRoots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(root, e.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      if (seenSkillNames.has(e.name)) continue;
      seenSkillNames.add(e.name);

      // Summary frontmatter costs ~45 tokens per skill in system prompt
      skillMetadataTokens += 45;
      const isLoaded = loadedSkillPaths.has(path.resolve(skillFile).toLowerCase());
      if (isLoaded) {
        const fullText = safeReadFile(skillFile);
        const tok = estimateTokens(fullText);
        loadedSkillsTokens += tok;
        loadedSkillsCount++;
        skills.push({
          name: e.name,
          meta: 'skill (loaded)',
          tokens: tok,
          size: fmtSizeK(tok),
        });
      }
    }
  }

  // Custom agents
  const agentDirs = [path.join(configRoot, 'agents')];
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const pe of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (pe.isDirectory()) agentDirs.push(path.join(pluginsDir, pe.name, 'agents'));
      }
    } catch {
      // ignore
    }
  }
  if (workspaceDir) agentDirs.push(path.join(workspaceDir, '.agents', 'agents'));

  const agents = [];
  let agentTokens = 0;
  for (const dir of agentDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const fullPath = path.join(dir, f);
        const text = safeReadFile(fullPath);
        // Only name+description are injected into system prompt (~80-220t)
        const tok = Math.min(250, Math.max(60, Math.round(estimateTokens(text) * 0.25)));
        agentTokens += tok;
        agents.push({
          name: f.replace(/\.md$/i, ''),
          meta: 'custom subagent',
          tokens: tok,
          size: fmtSizeK(tok),
        });
      }
    } catch {
      // ignore
    }
  }

  return {
    skillsTotalTokens: skillMetadataTokens + loadedSkillsTokens,
    totalDiscoveredSkills: seenSkillNames.size,
    loadedSkillsCount,
    loadedSkills: skills.sort((a, b) => b.tokens - a.tokens),
    agents,
    agentTokens,
  };
}

/**
 * Inspect full context breakdown, deferred tools, mounted inventories, and bloat attribution.
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

  // If the resolved active conversation was just started (SessionStart before first transcript line),
  // surface it at the top of the session list so UI dropdowns display it cleanly.
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

  const steps = tPath && fs.existsSync(tPath) ? parseTranscriptFull(tPath) : [];
  const plannerSteps = steps.filter((s) => s.type === 'PLANNER_RESPONSE' && s.inputTokens + s.cacheReadTokens > 0);
  const latestPlanner = plannerSteps[plannerSteps.length - 1] || null;

  const matchedSession = sessionList.find((s) => s.conversationId === convId);
  const model = latestPlanner?.model || matchedSession?.lastModel || 'gemini-4-neon-high';
  let limitTokens = getModelLimit(model, config);
  const usedTokens = latestPlanner ? latestPlanner.inputTokens + latestPlanner.cacheReadTokens : 0;
  // Guard against future unknown model names exceeding fallback 200K limit
  if (usedTokens > limitTokens) {
    limitTokens = usedTokens <= 1_000_000 ? 1_000_000 : 2_000_000;
  }

  // Estimate messages & tool outputs from transcript
  let msgRawTokens = 0;
  let toolOutputTokens = 0;
  for (const s of steps) {
    const textTok = estimateTokens(s.content) + (s.toolCalls.length ? estimateTokens(JSON.stringify(s.toolCalls)) : 0);
    msgRawTokens += textTok;
    if (s.type !== 'USER_INPUT' && s.type !== 'PLANNER_RESPONSE') {
      toolOutputTokens += textTok;
    }
  }

  const mcpScan = scanMcpTools(options);
  const rulesScan = scanRulesAndMemory(workspaceDir, options);
  const skillScan = scanSkillsAndAgents(steps, workspaceDir, options);

  // Reconcile breakdown cleanly with actual reported usedTokens (so breakdown sums exactly to usedTokens when usedTokens > 0)
  const fixedActive = mcpScan.eagerTokens + skillScan.skillsTotalTokens + rulesScan.totalTokens + skillScan.agentTokens;
  let messagesTokens = msgRawTokens;
  let systemBaselineTokens = 0;

  if (usedTokens > 0) {
    if (fixedActive + messagesTokens <= usedTokens) {
      systemBaselineTokens = Math.max(0, usedTokens - fixedActive - messagesTokens);
    } else {
      // Reserve realistic system baseline (~10K or 10% of usedTokens) and cap messages to remainder
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
      items: mcpScan.servers.slice(0, 12).map((s) => ({
        name: s.name,
        meta: s.meta,
        size: s.size,
      })),
    },
    {
      id: 'memory_rules',
      title: 'Memory & Rules files',
      stats: { files: rulesScan.files.length },
      count: `${rulesScan.files.length} files`,
      items: rulesScan.files.slice(0, 12).map((f) => ({
        name: f.name,
        meta: f.meta,
        size: f.size,
      })),
    },
    {
      id: 'skills_agents',
      title: 'Active Skills & Custom Agents',
      stats: { active: skillScan.loadedSkillsCount, agents: skillScan.agents.length },
      count: `${skillScan.loadedSkillsCount} active / ${skillScan.agents.length} agents`,
      items: [...skillScan.loadedSkills, ...skillScan.agents].slice(0, 12).map((it) => ({
        name: it.name,
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
    attrParts.push(`当前上下文已达 ${usedPercent}%（超过 ${config.alerts.contextWarningPct}% 警戒线），建议先生成交接胶囊再执行 /compact`);
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
    },
    options
  );
  const alerts = evaluateAlerts(telemetry.calls, config, usedPercent);

  return {
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
