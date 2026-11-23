import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir, getConfigRoot, formatDisplayPath } from '../paths.mjs';
import { estimateTokens } from '../vault.mjs';
import { PROTECTED_PLUGINS, loadDisabledGlobalMcp, loadGovernancePreferences } from './guardrails.mjs';
import { classifyGlobalMcp, classifyPlugin } from './classifier.mjs';

function safeReadText(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch {
    // ignore
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
      let val = kv[2].trim();
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
  let entries = [];
  try {
    entries = fs.readdirSync(mcpDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srvDir = path.join(mcpDir, entry.name);
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
      tools.push({ name: f.replace(/\.json$/i, ''), tokens: tok });
    }
    map.set(entry.name, {
      toolCount: files.length,
      tokens: totalTokens,
      tools: tools.sort((a, b) => b.tokens - a.tokens),
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
      displayPath: formatDisplayPath(skillMd),
      skillDir: path.join(skillsDir, entry.name),
      descTokens: estimateTokens(`${name}: ${description}`),
      fullTokens: estimateTokens(text),
    });
  }
  return items;
}

function scanRulesInDir(rulesDir, { scope, priority, sourceLabel, pluginId = null, active = true }) {
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
      scope,
      priority,
      sourceLabel,
      pluginId,
      active,
      trigger: fm.trigger || 'always_on',
      filePath: abs,
      displayPath: formatDisplayPath(abs),
      tokens: estimateTokens(text),
      lines: text ? text.split(/\r?\n/).length : 0,
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

  // Support both { "hooks": { EventName: [...] } } and { "<groupName>": { EventName: [...] } }
  const top = parsed.data;
  const groups = top.hooks && typeof top.hooks === 'object' ? { default: top.hooks } : top;

  for (const [groupKey, groupVal] of Object.entries(groups)) {
    if (!groupVal || typeof groupVal !== 'object') continue;
    if (Array.isArray(groupVal)) {
      // Direct event -> array format
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
        scope: 'workspace',
        priority: 1,
        sourceLabel: '工作区根目录',
        pluginId: null,
        active: true,
        trigger: 'always_on',
        filePath: c,
        displayPath: formatDisplayPath(c),
        tokens: estimateTokens(text),
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
      })
    );
  }
  return rules;
}

/**
 * Scan the complete Antigravity customization ecosystem and build the Effective Harness Stack (#1).
 */
export function scanEcosystem(params = {}, options = {}) {
  const configRoot = getConfigRoot(options);
  const appDataDir = getAppDataDir(options);
  const projectDir = params.projectDir || options.projectDir || process.cwd();

  const hostConfigPath = path.join(configRoot, 'config.json');
  const hostMcpPath = path.join(configRoot, 'mcp_config.json');
  const hostConfigRes = safeReadJsonDetailed(hostConfigPath);
  const hostMcpRes = safeReadJsonDetailed(hostMcpPath);
  const hostConfig = hostConfigRes.data || {};
  const pluginStates = hostConfig.plugins && typeof hostConfig.plugins === 'object' ? hostConfig.plugins : {};
  const preferences = loadGovernancePreferences(options);
  const pinnedSet = new Set(preferences.pinnedPlugins || []);

  const mcpCache = scanMcpSchemaCache(appDataDir);
  const disabledGlobalMcp = loadDisabledGlobalMcp(options);

  const plugins = [];
  const mcpServers = [];
  const skills = [];
  const rules = [];
  const hooks = [];
  const configIssues = [];

  if (hostConfigRes.error) {
    configIssues.push({
      severity: 'error',
      file: formatDisplayPath(hostConfigPath),
      message: `config.json JSON 解析失败: ${hostConfigRes.error}`,
    });
  }
  if (hostMcpRes.error) {
    configIssues.push({
      severity: 'error',
      file: formatDisplayPath(hostMcpPath),
      message: `mcp_config.json JSON 解析失败: ${hostMcpRes.error}`,
    });
  }

  // 1. Workspace-level rules & skills (Priority 1)
  rules.push(...scanWorkspaceRules(projectDir));
  for (const folder of ['.agents', '.agent', '_agents', '_agent']) {
    skills.push(
      ...scanSkillsInDir(path.join(projectDir, folder, 'skills'), {
        scope: 'workspace',
        priority: 1,
        sourceLabel: `工作区 (${folder})`,
        active: true,
      })
    );
  }

  // 2. Global-level rules, skills, hooks, MCP (Priority 2)
  rules.push(
    ...scanRulesInDir(path.join(configRoot, 'rules'), {
      scope: 'global',
      priority: 2,
      sourceLabel: '全局配置',
      active: true,
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
  const globalHooksPath = path.join(configRoot, 'hooks.json');
  if (fs.existsSync(globalHooksPath)) {
    const { hooks: gh, parseError } = parseHooksFile(globalHooksPath, {
      scope: 'global',
      sourceLabel: '全局 hooks.json',
      active: true,
    });
    hooks.push(...gh);
    if (parseError) {
      configIssues.push({ severity: 'warn', file: formatDisplayPath(globalHooksPath), message: `全局 hooks.json 解析失败: ${parseError}` });
    }
  }

  // Global active MCP servers
  const globalMcpMap = hostMcpRes.data?.mcpServers && typeof hostMcpRes.data.mcpServers === 'object' ? hostMcpRes.data.mcpServers : {};
  for (const [srvName, srvCfg] of Object.entries(globalMcpMap)) {
    const cached = mcpCache.get(srvName);
    const eagerTools = srvCfg?.tools ? Object.values(srvCfg.tools).filter((t) => t?.eager).length : 0;
    const mode = eagerTools > 0 ? 'eager' : cached ? 'deferred' : 'configured';
    const toolNames = cached ? cached.tools.map((t) => t.name) : [];
    const potentialTokens = cached ? cached.tokens : eagerTools * 220;
    const srvEntry = {
      id: `global:${srvName}`,
      name: srvName,
      scope: 'global',
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
      toolCount: cached ? cached.toolCount : eagerTools,
      toolNames,
      tokens: potentialTokens,
      potentialTokens,
      configFile: hostMcpPath,
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
    const eagerTools = srvCfg?.tools ? Object.values(srvCfg.tools).filter((t) => t?.eager).length : 0;
    const toolNames = cached ? cached.tools.map((t) => t.name) : [];
    const potentialTokens = cached ? cached.tokens : eagerTools * 220;
    const srvEntry = {
      id: `global:${srvName}`,
      name: srvName,
      scope: 'global',
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
      toolCount: cached ? cached.toolCount : 0,
      toolNames,
      tokens: 0,
      potentialTokens,
      configFile: hostMcpPath,
      displayConfigFile: formatDisplayPath(hostMcpPath),
    };
    srvEntry.classification = classifyGlobalMcp(srvEntry, { preferences });
    mcpServers.push(srvEntry);
  }

  // 3. Installed Plugins (Priority 3)
  const pluginsDir = path.join(configRoot, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    let pEntries = [];
    try {
      pEntries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      pEntries = [];
    }
    for (const pe of pEntries) {
      const dirName = pe.name;
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

      const pSkills = scanSkillsInDir(path.join(pDir, 'skills'), {
        scope: 'plugin',
        priority: 3,
        sourceLabel: `插件 · ${manifest.displayName || manifest.name || dirName}`,
        pluginId: dirName,
        active: enabled,
      });
      skills.push(...pSkills);

      const pRules = scanRulesInDir(path.join(pDir, 'rules'), {
        scope: 'plugin',
        priority: 3,
        sourceLabel: `插件 · ${manifest.displayName || manifest.name || dirName}`,
        pluginId: dirName,
        active: enabled,
      });
      rules.push(...pRules);

      let pHooks = [];
      const pHooksPath = path.join(pDir, 'hooks.json');
      if (fs.existsSync(pHooksPath)) {
        const { hooks: parsedHooks, parseError } = parseHooksFile(pHooksPath, {
          scope: 'plugin',
          sourceLabel: `插件 · ${manifest.displayName || manifest.name || dirName}`,
          pluginId: dirName,
          active: enabled,
        });
        pHooks = parsedHooks;
        hooks.push(...parsedHooks);
        if (parseError) {
          configIssues.push({ severity: 'warn', file: formatDisplayPath(pHooksPath), message: `插件 ${dirName} hooks.json 解析失败: ${parseError}` });
        }
      }

      let pMcpTokens = 0;
      let pMcpPotentialTokens = 0;
      let pMcpCount = 0;
      const pMcpEntries = [];
      const pMcpPath = path.join(pDir, 'mcp_config.json');
      if (fs.existsSync(pMcpPath)) {
        const pMcpRes = safeReadJsonDetailed(pMcpPath);
        if (pMcpRes.error) {
          configIssues.push({ severity: 'warn', file: formatDisplayPath(pMcpPath), message: `插件 ${dirName} mcp_config.json 解析失败: ${pMcpRes.error}` });
        }
        const srvs = pMcpRes.data?.mcpServers && typeof pMcpRes.data.mcpServers === 'object' ? pMcpRes.data.mcpServers : {};
        for (const [srvKey, srvCfg] of Object.entries(srvs)) {
          const fullKey = `${dirName}_${srvKey}`;
          const cached = mcpCache.get(fullKey) || mcpCache.get(srvKey);
          const eagerTools = srvCfg?.tools ? Object.values(srvCfg.tools).filter((t) => t?.eager).length : 0;
          const potTok =
            dirName === 'context-cache'
              ? 600
              : cached
                ? cached.tokens
                : Math.max(400, eagerTools * 220);
          const tok = enabled ? potTok : 0;
          pMcpTokens += tok;
          pMcpPotentialTokens += potTok;
          pMcpCount++;
          const mcpEntry = {
            id: `plugin:${fullKey}`,
            name: fullKey,
            shortName: srvKey,
            scope: 'plugin',
            pluginId: dirName,
            pluginDisplayName: manifest.displayName || manifest.name || dirName,
            enabled,
            canToggle: false, // Controlled via parent plugin
            transport: srvCfg?.url || srvCfg?.serverUrl ? 'http' : 'stdio',
            command: srvCfg?.command || '',
            args: Array.isArray(srvCfg?.args) ? srvCfg.args : [],
            url: srvCfg?.url || srvCfg?.serverUrl || '',
            envKeys: srvCfg?.env && typeof srvCfg.env === 'object' ? Object.keys(srvCfg.env) : [],
            mode: !enabled ? 'disabled' : eagerTools > 0 ? 'eager' : cached ? 'deferred' : 'configured',
            eagerCount: eagerTools,
            toolCount: cached ? cached.toolCount : dirName === 'context-cache' ? 5 : eagerTools,
            toolNames: cached ? cached.tools.map((t) => t.name) : [],
            tokens: tok,
            potentialTokens: potTok,
            configFile: pMcpPath,
            displayConfigFile: formatDisplayPath(pMcpPath),
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
      const totalTokens = ruleTokens + skillDescTokens + pMcpTokens;
      const systemProtected = PROTECTED_PLUGINS.has(dirName);
      const userPinned = !systemProtected && pinnedSet.has(dirName);

      const pluginEntry = {
        id: dirName,
        name: manifest.name || dirName,
        displayName: manifest.displayName || manifest.name || dirName,
        version: manifest.version || stateEntry.installedFrom?.version || 'local',
        description: manifest.description || '',
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
          mcp: pMcpTokens,
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

  // Sort plugins: protected first, then enabled, then by token cost desc
  plugins.sort((a, b) => Number(b.protected) - Number(a.protected) || Number(b.enabled) - Number(a.enabled) || b.tokens.total - a.tokens.total);
  mcpServers.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.tokens - a.tokens);
  rules.sort((a, b) => a.priority - b.priority || b.tokens - a.tokens);

  const activeRulesTokens = rules.filter((r) => r.active).reduce((s, r) => s + r.tokens, 0);
  const activeSkillsDescTokens = sortedSkills.filter((sk) => sk.active && !sk.shadowedBy).reduce((s, sk) => s + sk.descTokens, 0);
  const activeMcpTokens = mcpServers.filter((m) => m.enabled).reduce((s, m) => s + m.tokens, 0);

  return {
    scannedAt: new Date().toISOString(),
    projectDir,
    displayProjectDir: formatDisplayPath(projectDir),
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
      estimatedBaselineTokens: activeRulesTokens + activeSkillsDescTokens + activeMcpTokens,
      breakdownTokens: {
        rules: activeRulesTokens,
        skills: activeSkillsDescTokens,
        mcp: activeMcpTokens,
      },
    },
    plugins,
    mcpServers,
    skills: sortedSkills,
    rules,
    hooks,
    configIssues,
    preferences,
  };
}
