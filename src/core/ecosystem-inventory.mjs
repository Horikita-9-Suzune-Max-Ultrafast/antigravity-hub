import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir, getConfigRoot, getDataPaths, formatDisplayPath } from './paths.mjs';
import { createLruCache, safeStatSig } from './fs-utils.mjs';
import { estimateTokens } from './vault.mjs';
import { PROTECTED_PLUGINS, loadDisabledGlobalMcp, loadGovernancePreferences } from './governance/guardrails.mjs';
import { classifyGlobalMcp, classifyPlugin } from './governance/classifier.mjs';

const INVENTORY_FAST_TTL_MS = 5_000;
const INVENTORY_FINGERPRINT_TTL_MS = 15_000;
const inventoryCache = createLruCache(32);

export function clearEcosystemInventoryCache() {
  inventoryCache.clear();
}

function fmtSizeK(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function safeReadText(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch {
    // ignore unreadable file
  }
  return '';
}

function safeReadJsonDetailed(p) {
  if (!fs.existsSync(p)) return { exists: false, empty: false, data: null, error: null };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return { exists: true, empty: true, data: null, error: null };
    return { exists: true, empty: false, data: JSON.parse(raw), error: null };
  } catch (err) {
    return { exists: true, empty: false, data: null, error: err.message };
  }
}

function listSubdirsSafe(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val === '>-' || val === '>' || val === '|-' || val === '|') {
        out[currentKey] = '';
      } else {
        out[currentKey] = val.replace(/^["']|["']$/g, '');
      }
    } else if (currentKey && /^\s+/.test(line)) {
      out[currentKey] = `${out[currentKey] ? `${out[currentKey]} ` : ''}${line.trim()}`;
    }
  }
  return out;
}

function scanMcpSchemaCache(appDataDir) {
  const mcpDir = path.join(appDataDir, 'mcp');
  const map = new Map();
  if (!fs.existsSync(mcpDir)) return map;
  for (const srvName of listSubdirsSafe(mcpDir)) {
    const srvDir = path.join(mcpDir, srvName);
    let files = [];
    try {
      files = fs.readdirSync(srvDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    let totalTokens = 0;
    const tools = [];
    for (const f of files) {
      const txt = safeReadText(path.join(srvDir, f));
      const tok = estimateTokens(txt);
      totalTokens += tok;
      let toolName = f.replace(/\.json$/i, '');
      try {
        const parsed = JSON.parse(txt);
        if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
          toolName = parsed.name.trim();
        }
      } catch {
        // fallback to filename
      }
      tools.push({
        name: toolName,
        deferred: true,
        tokens: tok,
        size: fmtSizeK(tok),
      });
    }
    tools.sort((a, b) => b.tokens - a.tokens);
    map.set(srvName, {
      serverPath: srvDir,
      displayPath: formatDisplayPath(srvDir),
      toolCount: files.length,
      tokens: totalTokens,
      tools,
    });
  }
  return map;
}

function scanSkillsInDir(skillsDir, { scope, priority, sourceLabel, pluginId = null, active = true }) {
  const items = [];
  if (!fs.existsSync(skillsDir)) return items;
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const text = safeReadText(skillMd);
    const fm = parseFrontmatter(text);
    const name = fm.name || entry.name;
    const description = fm.description || '';
    items.push({
      id: `${scope}:${pluginId || 'root'}:${name}`,
      name,
      dirName: entry.name,
      description,
      scope,
      priority,
      sourceLabel,
      pluginId,
      active,
      filePath: skillMd,
      normPath: path.resolve(skillMd).toLowerCase(),
      displayPath: formatDisplayPath(skillMd),
      skillDir: path.join(skillsDir, entry.name),
      descTokens: estimateTokens(`${name}: ${description}`),
      fullTokens: estimateTokens(text),
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  return items;
}

function scanRulesInDir(rulesDir, { scope, priority, sourceLabel, pluginId = null, active = true, displayPrefix = '' }) {
  const items = [];
  if (!fs.existsSync(rulesDir)) return items;
  let entries = [];
  try {
    entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(rulesDir, entry.name);
    const text = safeReadText(abs);
    const fm = parseFrontmatter(text);
    items.push({
      id: `${scope}:${pluginId || 'root'}:${entry.name}`,
      name: entry.name,
      displayName: displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name,
      scope,
      priority,
      sourceLabel,
      pluginId,
      active,
      trigger: fm.trigger || 'always_on',
      filePath: abs,
      displayPath: formatDisplayPath(abs),
      tokens: estimateTokens(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text ? text.split(/\r?\n/).length : 0,
    });
  }
  return items;
}

function scanAgentsInDir(agentsDir, { scope, pluginId = null, active = true }) {
  const items = [];
  if (!fs.existsSync(agentsDir)) return items;
  let files = [];
  try {
    files = fs.readdirSync(agentsDir);
  } catch {
    return items;
  }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const fullPath = path.join(agentsDir, f);
    const text = safeReadText(fullPath);
    if (!text) continue;
    const tok = Math.min(250, Math.max(60, Math.round(estimateTokens(text) * 0.25)));
    items.push({
      name: f.replace(/\.md$/i, ''),
      kind: 'agent',
      scope,
      sourceLayer: scope,
      pluginId,
      active,
      filePath: fullPath,
      displayPath: formatDisplayPath(fullPath),
      meta: 'custom subagent',
      tokens: tok,
      size: fmtSizeK(tok),
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  return items;
}

function parseHooksFile(hooksPath, { scope, sourceLabel, pluginId = null, active = true }) {
  const parsed = safeReadJsonDetailed(hooksPath);
  const hooks = [];
  if (!parsed.data || typeof parsed.data !== 'object') {
    return { hooks, parseError: parsed.error };
  }

  const top = parsed.data;
  const groups = top.hooks && typeof top.hooks === 'object' ? { default: top.hooks } : top;

  for (const [groupKey, groupVal] of Object.entries(groups)) {
    if (!groupVal || typeof groupVal !== 'object') continue;
    if (Array.isArray(groupVal)) {
      for (const h of groupVal) {
        const list = Array.isArray(h?.hooks) ? h.hooks : [h];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          hooks.push({
            event: groupKey,
            matcher: h?.matcher || '*',
            type: item.type || 'command',
            command: item.command || '',
            timeout: Number(item.timeout) || null,
            scope,
            sourceLabel,
            pluginId,
            active,
            filePath: hooksPath,
            displayPath: formatDisplayPath(hooksPath),
            isPreToolUse: /pretooluse/i.test(groupKey),
          });
        }
      }
      continue;
    }
    for (const [eventName, entries] of Object.entries(groupVal)) {
      if (!Array.isArray(entries)) continue;
      for (const h of entries) {
        const list = Array.isArray(h?.hooks) ? h.hooks : [h];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          hooks.push({
            event: eventName,
            group: groupKey,
            matcher: h?.matcher || '*',
            type: item.type || 'command',
            command: item.command || '',
            timeout: Number(item.timeout) || null,
            scope,
            sourceLabel,
            pluginId,
            active,
            filePath: hooksPath,
            displayPath: formatDisplayPath(hooksPath),
            isPreToolUse: /pretooluse/i.test(eventName),
          });
        }
      }
    }
  }
  return { hooks, parseError: null };
}

function scanWorkspaceRules(projectDir) {
  const rules = [];
  if (!projectDir || !fs.existsSync(projectDir)) return rules;
  const baseName = path.basename(projectDir);
  const seen = new Set();
  const candidates = [
    path.join(projectDir, 'AGENTS.md'),
    path.join(projectDir, 'GEMINI.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const key = path.resolve(c).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const text = safeReadText(c);
      rules.push({
        id: `workspace:${path.basename(c)}`,
        name: path.basename(c),
        displayName: `${baseName}/${path.basename(c)}`,
        scope: 'workspace',
        priority: 1,
        sourceLabel: '工作区根目录',
        pluginId: null,
        active: true,
        trigger: 'always_on',
        filePath: c,
        displayPath: formatDisplayPath(c),
        tokens: estimateTokens(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text ? text.split(/\r?\n/).length : 0,
      });
    }
  }
  for (const folder of ['.agents', '.agent', '_agents', '_agent']) {
    const rDir = path.join(projectDir, folder, 'rules');
    rules.push(
      ...scanRulesInDir(rDir, {
        scope: 'workspace',
        priority: 1,
        sourceLabel: `工作区 (${folder}/rules)`,
        active: true,
        displayPrefix: `${baseName}/${folder}/rules`,
      })
    );
  }
  return rules;
}

/**
 * Reserved read-only hook for v1.7.0 R10 workspace-scoped local plugins & MCP.
 * Parses `<projectDir>/.agents/plugins.json` if present without mutating workspace files.
 */
export function scanWorkspaceLocalPlugins(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    return { configPath: null, exists: false, plugins: [], mcpServers: [], parseError: null };
  }
  const configPath = path.join(path.resolve(projectDir), '.agents', 'plugins.json');
  const res = safeReadJsonDetailed(configPath);
  if (!res.exists) {
    return { configPath, exists: false, plugins: [], mcpServers: [], parseError: null };
  }
  if (res.error || !res.data || typeof res.data !== 'object') {
    return { configPath, exists: true, plugins: [], mcpServers: [], parseError: res.error || null };
  }

  const plugins = [];
  const mcpServers = [];
  const rawPlugins = res.data.plugins && typeof res.data.plugins === 'object' ? res.data.plugins : {};
  for (const [id, entry] of Object.entries(rawPlugins)) {
    if (!entry || typeof entry !== 'object') continue;
    plugins.push({
      id,
      name: entry.name || id,
      displayName: entry.displayName || entry.name || id,
      enabled: entry.enabled !== false,
      scope: 'workspace',
      workspaceConfigPath: configPath,
      displayPath: formatDisplayPath(configPath),
    });
  }

  const rawMcps = res.data.mcpServers && typeof res.data.mcpServers === 'object' ? res.data.mcpServers : {};
  for (const [srvName, srvCfg] of Object.entries(rawMcps)) {
    if (!srvCfg || typeof srvCfg !== 'object') continue;
    mcpServers.push({
      id: `workspace:${srvName}`,
      name: srvName,
      scope: 'workspace',
      workspaceConfigPath: configPath,
      enabled: srvCfg.disabled !== true,
      transport: srvCfg.url || srvCfg.serverUrl ? 'http' : 'stdio',
      command: srvCfg.command || '',
      args: Array.isArray(srvCfg.args) ? srvCfg.args : [],
      url: srvCfg.url || srvCfg.serverUrl || '',
      displayConfigFile: formatDisplayPath(configPath),
    });
  }

  return { configPath, exists: true, plugins, mcpServers, parseError: null };
}

function splitMcpTokens(cached, eagerTools, defaultConfiguredEager = 0) {
  if (cached) {
    if (eagerTools > 0) {
      const eagerTok =
        cached.toolCount > 0 && eagerTools >= cached.toolCount
          ? cached.tokens
          : Math.min(cached.tokens, eagerTools * 220);
      const deferredTok = Math.max(0, cached.tokens - eagerTok);
      return {
        eagerTokens: eagerTok,
        deferredTokens: deferredTok,
        deferredCount: Math.max(0, cached.toolCount - eagerTools),
      };
    }
    return {
      eagerTokens: 0,
      deferredTokens: cached.tokens,
      deferredCount: cached.toolCount,
    };
  }
  const eagerTok = eagerTools > 0 ? eagerTools * 220 : defaultConfiguredEager;
  return {
    eagerTokens: eagerTok,
    deferredTokens: 0,
    deferredCount: 0,
  };
}

function buildInventoryFingerprint({ appDataDir, configRoot, projectDir, dataPaths }) {
  const mcpDir = path.join(appDataDir, 'mcp');
  const pluginsDir = path.join(configRoot, 'plugins');
  const mcpSubdirs = listSubdirsSafe(mcpDir);
  const pluginSubdirs = listSubdirsSafe(pluginsDir);

  const parts = [
    safeStatSig(path.join(configRoot, 'config.json')),
    safeStatSig(path.join(configRoot, 'mcp_config.json')),
    safeStatSig(path.join(configRoot, 'hooks.json')),
    safeStatSig(path.join(configRoot, 'rules')),
    safeStatSig(path.join(configRoot, 'skills')),
    safeStatSig(path.join(configRoot, 'agents')),
    safeStatSig(path.join(appDataDir, 'builtin', 'skills')),
    safeStatSig(dataPaths.governanceDisabledMcpFile),
    safeStatSig(dataPaths.governancePrefsFile),
    safeStatSig(mcpDir),
    ...mcpSubdirs.map((d) => `${d}:${safeStatSig(path.join(mcpDir, d))}`),
    safeStatSig(pluginsDir),
    ...pluginSubdirs.map(
      (d) =>
        `${d}:${safeStatSig(path.join(pluginsDir, d, 'plugin.json'))}:${safeStatSig(
          path.join(pluginsDir, d, 'mcp_config.json')
        )}:${safeStatSig(path.join(pluginsDir, d, 'rules'))}:${safeStatSig(
          path.join(pluginsDir, d, 'skills')
        )}:${safeStatSig(path.join(pluginsDir, d, 'agents'))}:${safeStatSig(
          path.join(pluginsDir, d, 'hooks.json')
        )}`
    ),
  ];

  if (projectDir) {
    parts.push(
      safeStatSig(path.join(projectDir, 'AGENTS.md')),
      safeStatSig(path.join(projectDir, 'GEMINI.md')),
      safeStatSig(path.join(projectDir, '.agents', 'rules')),
      safeStatSig(path.join(projectDir, '.agents', 'skills')),
      safeStatSig(path.join(projectDir, '.agents', 'agents')),
      safeStatSig(path.join(projectDir, '.agents', 'plugins.json'))
    );
  }
  return parts.join('|');
}

const OWN_CTX_CACHE_TOOLS = [
  { name: 'ctx_open_monitor', deferred: false, tokens: 140, size: fmtSizeK(140) },
  { name: 'ctx_brief', deferred: false, tokens: 110, size: fmtSizeK(110) },
  { name: 'ctx_save', deferred: false, tokens: 130, size: fmtSizeK(130) },
  { name: 'ctx_search', deferred: false, tokens: 110, size: fmtSizeK(110) },
  { name: 'ctx_doctor', deferred: false, tokens: 110, size: fmtSizeK(110) },
];

/**
 * Unified Antigravity ecosystem scanner shared by context-inspector and governance.
 * - Enforces config.json plugin enabled/disabled states strictly across rules, skills, agents, hooks, MCP.
 * - Separates MCP `eagerTokens` (baseline) from `deferredTokens` (on-demand cache).
 * - Two-tier cache: 5s fast memory TTL (0 fs syscalls) + 15s stat-fingerprint cache; `options.force` bypasses both.
 */
export function scanEcosystemInventory(params = {}, options = {}) {
  const configRoot = getConfigRoot(options);
  const appDataDir = getAppDataDir(options);
  const dataPaths = getDataPaths(options);
  const projectDir = params.projectDir || options.projectDir || process.cwd();
  const wsNorm = projectDir ? path.resolve(projectDir) : '';
  const force = Boolean(options.force || params.force);

  const cacheKey = [
    path.resolve(dataPaths.dataDir).toLowerCase(),
    path.resolve(appDataDir).toLowerCase(),
    path.resolve(configRoot).toLowerCase(),
    wsNorm.toLowerCase(),
  ].join('|');

  const now = Date.now();
  const cachedEntry = inventoryCache.get(cacheKey);
  if (!force && cachedEntry && now < cachedEntry.fastExpiresAt) {
    return cachedEntry.value;
  }

  const fingerprint = buildInventoryFingerprint({
    appDataDir,
    configRoot,
    projectDir: wsNorm,
    dataPaths,
  });

  if (!force && cachedEntry && now < cachedEntry.expiresAt && cachedEntry.fingerprint === fingerprint) {
    cachedEntry.fastExpiresAt = now + INVENTORY_FAST_TTL_MS;
    return cachedEntry.value;
  }

  const hostConfigPath = path.join(configRoot, 'config.json');
  const hostMcpPath = path.join(configRoot, 'mcp_config.json');
  const hostConfigRes = safeReadJsonDetailed(hostConfigPath);
  const hostMcpRes = safeReadJsonDetailed(hostMcpPath);
  const hostConfig = hostConfigRes.data || {};
  const pluginStates = hostConfig.plugins && typeof hostConfig.plugins === 'object' ? hostConfig.plugins : {};
  const preferences = loadGovernancePreferences(options);
  const pinnedSet = new Set(preferences.pinnedPlugins || []);

  const mcpCache = scanMcpSchemaCache(appDataDir);
  const matchedCacheKeys = new Set();
  const disabledGlobalMcp = loadDisabledGlobalMcp(options);

  const plugins = [];
  const mcpServers = [];
  const skills = [];
  const rules = [];
  const agents = [];
  const hooks = [];
  const configIssues = [];

  if (hostConfigRes.error) {
    configIssues.push({
      severity: 'error',
      file: formatDisplayPath(hostConfigPath),
      absFile: hostConfigPath,
      message: `config.json JSON 解析失败: ${hostConfigRes.error}`,
    });
  }
  if (hostMcpRes.error) {
    configIssues.push({
      severity: 'error',
      file: formatDisplayPath(hostMcpPath),
      absFile: hostMcpPath,
      message: `mcp_config.json JSON 解析失败: ${hostMcpRes.error}`,
    });
  }

  // 1. Workspace-level rules, skills, agents & v1.7.0 local plugins hook (Priority 1)
  rules.push(...scanWorkspaceRules(wsNorm));
  for (const folder of ['.agents', '.agent', '_agents', '_agent']) {
    if (!wsNorm) continue;
    skills.push(
      ...scanSkillsInDir(path.join(wsNorm, folder, 'skills'), {
        scope: 'workspace',
        priority: 1,
        sourceLabel: `工作区 (${folder})`,
        active: true,
      })
    );
  }
  if (wsNorm) {
    agents.push(...scanAgentsInDir(path.join(wsNorm, '.agents', 'agents'), { scope: 'workspace', active: true }));
  }
  const workspaceLocalPlugins = scanWorkspaceLocalPlugins(wsNorm);

  // 2. Global-level rules, skills, agents, hooks, MCP (Priority 2)
  rules.push(
    ...scanRulesInDir(path.join(configRoot, 'rules'), {
      scope: 'global',
      priority: 2,
      sourceLabel: '全局配置',
      active: true,
      displayPrefix: 'global/rules',
    })
  );
  skills.push(
    ...scanSkillsInDir(path.join(configRoot, 'skills'), {
      scope: 'global',
      priority: 2,
      sourceLabel: '全局配置',
      active: true,
    })
  );
  agents.push(...scanAgentsInDir(path.join(configRoot, 'agents'), { scope: 'global', active: true }));

  const globalHooksPath = path.join(configRoot, 'hooks.json');
  if (fs.existsSync(globalHooksPath)) {
    const { hooks: gh, parseError } = parseHooksFile(globalHooksPath, {
      scope: 'global',
      sourceLabel: '全局 hooks.json',
      active: true,
    });
    hooks.push(...gh);
    if (parseError) {
      configIssues.push({
        severity: 'warn',
        file: formatDisplayPath(globalHooksPath),
        absFile: globalHooksPath,
        message: `全局 hooks.json 解析失败: ${parseError}`,
      });
    }
  }

  // Global active MCP servers
  const globalMcpMap =
    hostMcpRes.data?.mcpServers && typeof hostMcpRes.data.mcpServers === 'object' ? hostMcpRes.data.mcpServers : {};
  for (const [srvName, srvCfg] of Object.entries(globalMcpMap)) {
    const cached = mcpCache.get(srvName);
    if (cached) matchedCacheKeys.add(srvName);
    const eagerTools = srvCfg?.tools ? Object.values(srvCfg.tools).filter((t) => t?.eager).length : 0;
    const mode = eagerTools > 0 ? 'eager' : cached ? 'deferred' : 'configured';
    const { eagerTokens, deferredTokens, deferredCount } = splitMcpTokens(cached, eagerTools, 0);
    const toolNames = cached ? cached.tools.map((t) => t.name) : [];
    const potentialTokens = eagerTokens + deferredTokens;
    const srvEntry = {
      id: `global:${srvName}`,
      name: srvName,
      scope: 'global',
      workspaceConfigPath: null,
      pluginId: null,
      enabled: true,
      canToggle: true,
      transport: srvCfg?.url || srvCfg?.serverUrl ? 'http' : 'stdio',
      command: srvCfg?.command || '',
      args: Array.isArray(srvCfg?.args) ? srvCfg.args : [],
      url: srvCfg?.url || srvCfg?.serverUrl || '',
      envKeys: srvCfg?.env && typeof srvCfg.env === 'object' ? Object.keys(srvCfg.env) : [],
      mode,
      eagerCount: eagerTools,
      deferredCount,
      toolCount: cached ? cached.toolCount : eagerTools,
      toolNames,
      tools: cached ? cached.tools : [],
      eagerTokens,
      deferredTokens,
      tokens: potentialTokens,
      potentialTokens,
      configFile: hostMcpPath,
      filePath: cached ? cached.serverPath : hostMcpPath,
      displayPath: cached ? cached.displayPath : formatDisplayPath(hostMcpPath),
      displayConfigFile: formatDisplayPath(hostMcpPath),
    };
    srvEntry.classification = classifyGlobalMcp(srvEntry, { preferences });
    mcpServers.push(srvEntry);
  }

  // Global disabled (staged) MCP servers
  for (const [srvName, staged] of Object.entries(disabledGlobalMcp.servers || {})) {
    if (globalMcpMap[srvName]) continue;
    const srvCfg = staged?.config || {};
    const cached = mcpCache.get(srvName);
    if (cached) matchedCacheKeys.add(srvName);
    const eagerTools = srvCfg?.tools ? Object.values(srvCfg.tools).filter((t) => t?.eager).length : 0;
    const { eagerTokens: potEager, deferredTokens: potDeferred } = splitMcpTokens(cached, eagerTools, 0);
    const toolNames = cached ? cached.tools.map((t) => t.name) : [];
    const potentialTokens = potEager + potDeferred;
    const srvEntry = {
      id: `global:${srvName}`,
      name: srvName,
      scope: 'global',
      workspaceConfigPath: null,
      pluginId: null,
      enabled: false,
      canToggle: true,
      disabledAt: staged?.disabledAt || null,
      transport: srvCfg?.url || srvCfg?.serverUrl ? 'http' : 'stdio',
      command: srvCfg?.command || '',
      args: Array.isArray(srvCfg?.args) ? srvCfg.args : [],
      url: srvCfg?.url || srvCfg?.serverUrl || '',
      envKeys: srvCfg?.env && typeof srvCfg.env === 'object' ? Object.keys(srvCfg.env) : [],
      mode: 'disabled',
      eagerCount: 0,
      deferredCount: 0,
      toolCount: cached ? cached.toolCount : 0,
      toolNames,
      tools: cached ? cached.tools : [],
      eagerTokens: 0,
      deferredTokens: 0,
      tokens: 0,
      potentialTokens,
      configFile: hostMcpPath,
      filePath: cached ? cached.serverPath : hostMcpPath,
      displayPath: cached ? cached.displayPath : formatDisplayPath(hostMcpPath),
      displayConfigFile: formatDisplayPath(hostMcpPath),
    };
    srvEntry.classification = classifyGlobalMcp(srvEntry, { preferences });
    mcpServers.push(srvEntry);
  }

  // 3. Installed Plugins (Priority 3)
  const pluginsDir = path.join(configRoot, 'plugins');
  for (const dirName of listSubdirsSafe(pluginsDir)) {
    const pDir = path.join(pluginsDir, dirName);
    const manifestPath = path.join(pDir, 'plugin.json');
    const manifestRes = safeReadJsonDetailed(manifestPath);
    const manifest = manifestRes.data || {};
    const stateEntry = pluginStates[dirName] || {};

    // Antigravity rule: config.json wins when present, else fallback to manifest.disabled
    let enabled = true;
    let statusSource = 'default';
    if (typeof stateEntry.enabled === 'boolean') {
      enabled = stateEntry.enabled;
      statusSource = 'config.json';
    } else if (manifest.disabled === true) {
      enabled = false;
      statusSource = 'manifest';
    }

    const pluginLabel = manifest.displayName || manifest.name || dirName;
    const sourceLabel = `插件: ${pluginLabel}`;

    const pSkills = scanSkillsInDir(path.join(pDir, 'skills'), {
      scope: 'plugin',
      priority: 3,
      sourceLabel,
      pluginId: dirName,
      active: enabled,
    });
    skills.push(...pSkills);

    const pRules = scanRulesInDir(path.join(pDir, 'rules'), {
      scope: 'plugin',
      priority: 3,
      sourceLabel,
      pluginId: dirName,
      active: enabled,
      displayPrefix: `${dirName}/rules`,
    });
    rules.push(...pRules);

    const pAgents = scanAgentsInDir(path.join(pDir, 'agents'), {
      scope: 'plugin',
      pluginId: dirName,
      active: enabled,
    });
    agents.push(...pAgents);

    let pHooks = [];
    const pHooksPath = path.join(pDir, 'hooks.json');
    if (fs.existsSync(pHooksPath)) {
      const { hooks: parsedHooks, parseError } = parseHooksFile(pHooksPath, {
        scope: 'plugin',
        sourceLabel,
        pluginId: dirName,
        active: enabled,
      });
      pHooks = parsedHooks;
      hooks.push(...parsedHooks);
      if (parseError) {
        configIssues.push({
          severity: 'warn',
          file: formatDisplayPath(pHooksPath),
          absFile: pHooksPath,
          message: `插件 ${dirName} hooks.json 解析失败: ${parseError}`,
        });
      }
    }

    let pMcpEagerTokens = 0;
    let pMcpDeferredTokens = 0;
    let pMcpPotentialTokens = 0;
    let pMcpCount = 0;
    const pMcpEntries = [];
    const pMcpPath = path.join(pDir, 'mcp_config.json');
    if (fs.existsSync(pMcpPath)) {
      const pMcpRes = safeReadJsonDetailed(pMcpPath);
      if (pMcpRes.error) {
        configIssues.push({
          severity: 'warn',
          file: formatDisplayPath(pMcpPath),
          absFile: pMcpPath,
          message: `插件 ${dirName} mcp_config.json 解析失败: ${pMcpRes.error}`,
        });
      }
      const srvs =
        pMcpRes.data?.mcpServers && typeof pMcpRes.data.mcpServers === 'object' ? pMcpRes.data.mcpServers : {};
      for (const [srvKey, srvCfg] of Object.entries(srvs)) {
        const fullKey = `${dirName}_${srvKey}`;
        const cached = mcpCache.get(fullKey) || mcpCache.get(srvKey);
        if (mcpCache.has(fullKey)) matchedCacheKeys.add(fullKey);
        if (mcpCache.has(srvKey)) matchedCacheKeys.add(srvKey);

        const isOwnPlugin = dirName === 'context-cache' || srvKey === 'context-cache-server';
        const eagerTools = isOwnPlugin
          ? 5
          : srvCfg?.tools
            ? Object.values(srvCfg.tools).filter((t) => t?.eager).length
            : 0;

        let potEager = 0;
        let potDeferred = 0;
        let deferredCount = 0;
        let mode = 'configured';
        let toolCount = 0;
        let toolsList = [];

        if (isOwnPlugin) {
          potEager = 600;
          potDeferred = 0;
          deferredCount = 0;
          mode = enabled ? 'eager' : 'disabled';
          toolCount = 5;
          toolsList = OWN_CTX_CACHE_TOOLS;
        } else {
          const split = splitMcpTokens(cached, eagerTools, 400);
          potEager = split.eagerTokens;
          potDeferred = split.deferredTokens;
          deferredCount = split.deferredCount;
          mode = !enabled ? 'disabled' : eagerTools > 0 ? 'eager' : cached ? 'deferred' : 'configured';
          toolCount = cached ? cached.toolCount : eagerTools || 4;
          toolsList = cached ? cached.tools : [];
        }

        const eagerTok = enabled ? potEager : 0;
        const deferredTok = enabled ? potDeferred : 0;
        const potTok = potEager + potDeferred;
        const tok = eagerTok + deferredTok;

        pMcpEagerTokens += eagerTok;
        pMcpDeferredTokens += deferredTok;
        pMcpPotentialTokens += potTok;
        pMcpCount++;

        const mcpEntry = {
          id: `plugin:${fullKey}`,
          name: fullKey,
          shortName: srvKey,
          scope: 'plugin',
          workspaceConfigPath: null,
          pluginId: dirName,
          pluginDisplayName: pluginLabel,
          enabled,
          canToggle: false,
          transport: srvCfg?.url || srvCfg?.serverUrl ? 'http' : 'stdio',
          command: srvCfg?.command || '',
          args: Array.isArray(srvCfg?.args) ? srvCfg.args : [],
          url: srvCfg?.url || srvCfg?.serverUrl || '',
          envKeys: srvCfg?.env && typeof srvCfg.env === 'object' ? Object.keys(srvCfg.env) : [],
          mode,
          eagerCount: enabled ? (isOwnPlugin ? 5 : eagerTools || (!cached ? 4 : 0)) : 0,
          deferredCount: enabled ? deferredCount : 0,
          toolCount,
          toolNames: cached ? cached.tools.map((t) => t.name) : toolsList.map((t) => t.name),
          tools: toolsList,
          eagerTokens: eagerTok,
          deferredTokens: deferredTok,
          tokens: tok,
          potentialTokens: potTok,
          configFile: pMcpPath,
          filePath: pMcpPath,
          displayPath: formatDisplayPath(pMcpPath),
          displayConfigFile: formatDisplayPath(pMcpPath),
          isOwnPlugin,
        };
        pMcpEntries.push(mcpEntry);
        mcpServers.push(mcpEntry);
      }
    }

    const potentialRuleTokens = pRules.reduce((s, r) => s + r.tokens, 0);
    const potentialSkillDescTokens = pSkills.reduce((s, sk) => s + sk.descTokens, 0);
    const potentialTotalTokens = potentialRuleTokens + potentialSkillDescTokens + pMcpPotentialTokens;
    const ruleTokens = enabled ? potentialRuleTokens : 0;
    const skillDescTokens = enabled ? potentialSkillDescTokens : 0;
    const totalTokens = ruleTokens + skillDescTokens + pMcpEagerTokens;
    const systemProtected = PROTECTED_PLUGINS.has(dirName);
    const userPinned = !systemProtected && pinnedSet.has(dirName);

    const pluginEntry = {
      id: dirName,
      name: manifest.name || dirName,
      displayName: pluginLabel,
      version: manifest.version || stateEntry.installedFrom?.version || 'local',
      description: manifest.description || '',
      scope: 'plugin',
      workspaceConfigPath: null,
      source: stateEntry.installedFrom?.marketplace ? 'marketplace' : 'local',
      marketplaceId: stateEntry.installedFrom?.id || null,
      enabled,
      statusSource,
      systemProtected,
      userPinned,
      protected: systemProtected || userPinned,
      dirPath: pDir,
      displayPath: formatDisplayPath(pDir),
      manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
      counts: {
        skills: pSkills.length,
        rules: pRules.length,
        mcp: pMcpCount,
        hooks: pHooks.length,
      },
      tokens: {
        rules: ruleTokens,
        skills: skillDescTokens,
        mcp: pMcpEagerTokens,
        mcpEager: pMcpEagerTokens,
        mcpDeferred: pMcpDeferredTokens,
        total: totalTokens,
      },
      potentialTokens: {
        rules: potentialRuleTokens,
        skills: potentialSkillDescTokens,
        mcp: pMcpPotentialTokens,
        total: potentialTotalTokens,
      },
    };
    pluginEntry.classification = classifyPlugin(pluginEntry, {
      skills: pSkills,
      mcpServers: pMcpEntries,
      rules: pRules,
      preferences,
    });
    plugins.push(pluginEntry);
  }

  // Unmatched MCP schema cache directories (for context-inspector deferred visibility)
  const cachedOnlyMcpServers = [];
  for (const [srvName, cached] of mcpCache.entries()) {
    if (matchedCacheKeys.has(srvName)) continue;
    cachedOnlyMcpServers.push({
      id: `cache:${srvName}`,
      name: srvName,
      scope: 'global',
      workspaceConfigPath: null,
      pluginId: null,
      enabled: true,
      canToggle: false,
      cacheOnly: true,
      mode: 'deferred',
      eagerCount: 0,
      deferredCount: cached.toolCount,
      toolCount: cached.toolCount,
      toolNames: cached.tools.map((t) => t.name),
      tools: cached.tools,
      eagerTokens: 0,
      deferredTokens: cached.tokens,
      tokens: cached.tokens,
      potentialTokens: cached.tokens,
      filePath: cached.serverPath,
      displayPath: cached.displayPath,
    });
  }

  // 4. Built-in Skills (Priority 4)
  skills.push(
    ...scanSkillsInDir(path.join(appDataDir, 'builtin', 'skills'), {
      scope: 'builtin',
      priority: 4,
      sourceLabel: '内置 (Built-in)',
      active: true,
    })
  );

  // Detect Skill name overrides / collisions across priorities
  const activeSkillWinners = new Map();
  const sortedSkills = [...skills].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  for (const sk of sortedSkills) {
    if (!sk.active) {
      sk.shadowedBy = null;
      continue;
    }
    const key = sk.name.toLowerCase();
    if (activeSkillWinners.has(key)) {
      sk.shadowedBy = activeSkillWinners.get(key).sourceLabel;
    } else {
      sk.shadowedBy = null;
      activeSkillWinners.set(key, sk);
    }
  }

  // Sort lists deterministically
  plugins.sort(
    (a, b) =>
      Number(b.protected) - Number(a.protected) ||
      Number(b.enabled) - Number(a.enabled) ||
      b.tokens.total - a.tokens.total
  );
  mcpServers.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.tokens - a.tokens);
  rules.sort((a, b) => a.priority - b.priority || b.tokens - a.tokens);

  const activeRulesTokens = rules.filter((r) => r.active).reduce((s, r) => s + r.tokens, 0);
  const activeSkillsDescTokens = sortedSkills
    .filter((sk) => sk.active && !sk.shadowedBy)
    .reduce((s, sk) => s + sk.descTokens, 0);
  const activeEagerMcpTokens = mcpServers
    .filter((m) => m.enabled)
    .reduce((s, m) => s + (Number(m.eagerTokens) || 0), 0);
  const activeDeferredMcpTokens =
    mcpServers.filter((m) => m.enabled).reduce((s, m) => s + (Number(m.deferredTokens) || 0), 0) +
    cachedOnlyMcpServers.reduce((s, m) => s + (Number(m.deferredTokens) || 0), 0);

  const result = {
    scannedAt: new Date().toISOString(),
    fingerprint,
    projectDir: wsNorm || projectDir,
    displayProjectDir: formatDisplayPath(wsNorm || projectDir),
    configRoot,
    displayConfigRoot: formatDisplayPath(configRoot),
    summary: {
      pluginsTotal: plugins.length,
      pluginsEnabled: plugins.filter((p) => p.enabled).length,
      mcpTotal: mcpServers.length,
      mcpEnabled: mcpServers.filter((m) => m.enabled).length,
      skillsTotal: sortedSkills.length,
      skillsActive: sortedSkills.filter((sk) => sk.active && !sk.shadowedBy).length,
      skillsShadowed: sortedSkills.filter((sk) => Boolean(sk.shadowedBy)).length,
      rulesTotal: rules.length,
      rulesActive: rules.filter((r) => r.active).length,
      hooksTotal: hooks.length,
      hooksActive: hooks.filter((h) => h.active).length,
      estimatedBaselineTokens: activeRulesTokens + activeSkillsDescTokens + activeEagerMcpTokens,
      breakdownTokens: {
        rules: activeRulesTokens,
        skills: activeSkillsDescTokens,
        mcp: activeEagerMcpTokens,
        mcpEager: activeEagerMcpTokens,
        mcpDeferred: activeDeferredMcpTokens,
      },
    },
    plugins,
    mcpServers,
    cachedOnlyMcpServers,
    skills: sortedSkills,
    rules,
    agents,
    hooks,
    configIssues,
    preferences,
    workspaceLocalPlugins,
  };

  inventoryCache.set(cacheKey, {
    fingerprint,
    value: result,
    fastExpiresAt: now + INVENTORY_FAST_TTL_MS,
    expiresAt: now + INVENTORY_FINGERPRINT_TTL_MS,
  });

  return result;
}
