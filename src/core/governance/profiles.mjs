import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataPaths } from '../paths.mjs';
import {
  PROTECTED_PLUGINS,
  appendAuditLog,
  atomicWriteJsonSafe,
  createHostSnapshot,
  getHostConfigPaths,
  loadDisabledGlobalMcp,
  rollbackSnapshot,
} from './guardrails.mjs';
import { scanEcosystem } from './scanner.mjs';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadProfilesStore(options = {}) {
  const { governanceProfilesFile } = getDataPaths(options);
  try {
    if (!fs.existsSync(governanceProfilesFile)) return { profiles: [] };
    const raw = fs.readFileSync(governanceProfilesFile, 'utf8');
    if (!raw.trim()) return { profiles: [] };
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.profiles) ? parsed : { profiles: [] };
  } catch {
    return { profiles: [] };
  }
}

function saveProfilesStore(store, options = {}) {
  const { governanceDir, governanceProfilesFile } = getDataPaths(options);
  ensureDir(governanceDir);
  const tmp = `${governanceProfilesFile}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, governanceProfilesFile);
}

const BUILTIN_PROFILE_DEFS = [
  {
    id: 'builtin:minimal-chat',
    name: '极简省流',
    badge: '确定性',
    tone: 'success',
    deterministic: true,
    summary: '仅保留系统保护与用户常驻插件，停用其余可选插件与全局 MCP。',
    suitableFor: '高频问答、短对话查阅与压缩基线上下文。',
    resolve(eco) {
      const plugins = {};
      for (const p of eco.plugins || []) {
        plugins[p.id] = Boolean(p.systemProtected || p.userPinned);
      }
      const globalMcp = {};
      for (const m of eco.mcpServers || []) {
        if (m.scope === 'global') globalMcp[m.name] = false;
      }
      return { plugins, globalMcp };
    },
  },
  {
    id: 'builtin:coding-focus',
    name: '专注编码',
    badge: '推荐模板',
    tone: 'info',
    deterministic: false,
    summary: '保留常驻核心与开发类扩展，关闭办公协作类扩展，未归类项保持现状。',
    suitableFor: '日常编码、重构、调试与测试。',
    resolve(eco) {
      const plugins = {};
      for (const p of eco.plugins || []) {
        if (p.systemProtected || p.userPinned) {
          plugins[p.id] = true;
        } else {
          const cat = p.classification?.category || 'general';
          if (cat === 'coding') plugins[p.id] = true;
          else if (cat === 'office') plugins[p.id] = false;
          else plugins[p.id] = Boolean(p.enabled);
        }
      }
      const globalMcp = {};
      for (const m of eco.mcpServers || []) {
        if (m.scope === 'global') {
          const cat = m.classification?.category || 'general';
          if (cat === 'coding') globalMcp[m.name] = true;
          else if (cat === 'office') globalMcp[m.name] = false;
          else globalMcp[m.name] = Boolean(m.enabled);
        }
      }
      return { plugins, globalMcp };
    },
  },
  {
    id: 'builtin:workspace-office',
    name: '办公协作',
    badge: '推荐模板',
    tone: 'warn',
    deterministic: false,
    summary: '保留常驻核心与办公协作类扩展，暂停开发类扩展，未归类项保持现状。',
    suitableFor: '处理邮件、文档、云盘、日程与协作资料。',
    resolve(eco) {
      const plugins = {};
      for (const p of eco.plugins || []) {
        if (p.systemProtected || p.userPinned) {
          plugins[p.id] = true;
        } else {
          const cat = p.classification?.category || 'general';
          if (cat === 'office') plugins[p.id] = true;
          else if (cat === 'coding') plugins[p.id] = false;
          else plugins[p.id] = Boolean(p.enabled);
        }
      }
      const globalMcp = {};
      for (const m of eco.mcpServers || []) {
        if (m.scope === 'global') {
          const cat = m.classification?.category || 'general';
          if (cat === 'office') globalMcp[m.name] = true;
          else if (cat === 'coding') globalMcp[m.name] = false;
          else globalMcp[m.name] = Boolean(m.enabled);
        }
      }
      return { plugins, globalMcp };
    },
  },
  {
    id: 'builtin:full-power',
    name: '全部启用',
    badge: '确定性',
    tone: 'info',
    deterministic: true,
    summary: '启用全部已安装插件与全局 MCP 服务。',
    suitableFor: '跨工具复杂任务，需要同时调用开发与协作扩展。',
    resolve(eco) {
      const plugins = {};
      for (const p of eco.plugins || []) {
        plugins[p.id] = true;
      }
      const globalMcp = {};
      for (const m of eco.mcpServers || []) {
        if (m.scope === 'global') globalMcp[m.name] = true;
      }
      return { plugins, globalMcp };
    },
  },
];

export function listBuiltinProfiles(eco = null, options = {}) {
  const snapshotEco = eco || scanEcosystem({}, options);
  return BUILTIN_PROFILE_DEFS.map((def) => {
    const resolved = def.resolve(snapshotEco);
    for (const prot of PROTECTED_PLUGINS) {
      if (prot in resolved.plugins) resolved.plugins[prot] = true;
    }
    const pluginVals = Object.values(resolved.plugins);
    const mcpVals = Object.values(resolved.globalMcp);
    const uncertainCount = def.deterministic
      ? 0
      : (snapshotEco.plugins || []).filter(
          (p) => !p.systemProtected && !p.userPinned && (p.classification?.category || 'general') === 'general'
        ).length +
        (snapshotEco.mcpServers || []).filter(
          (m) => m.scope === 'global' && (m.classification?.category || 'general') === 'general'
        ).length;

    return {
      id: def.id,
      name: def.name,
      badge: def.badge,
      tone: def.tone,
      builtin: true,
      deterministic: Boolean(def.deterministic),
      description: def.summary,
      suitableFor: def.suitableFor,
      plugins: resolved.plugins,
      globalMcp: resolved.globalMcp,
      stats: {
        enabledPlugins: pluginVals.filter(Boolean).length,
        totalPlugins: pluginVals.length,
        enabledMcp: mcpVals.filter(Boolean).length,
        totalMcp: mcpVals.length,
        uncertainCount,
      },
    };
  });
}

export function listProfiles(options = {}) {
  return loadProfilesStore(options).profiles;
}

/**
 * Save current active plugins & global MCP servers (or explicit state) as a named Profile.
 */
export function saveProfile(payload = {}, options = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('场景预设名称不能为空');

  const eco = scanEcosystem({}, options);
  const pluginsMap = {};
  for (const p of eco.plugins) {
    pluginsMap[p.id] = p.systemProtected ? true : Boolean(p.enabled);
  }
  const globalMcpMap = {};
  for (const m of eco.mcpServers) {
    if (m.scope === 'global') {
      globalMcpMap[m.name] = Boolean(m.enabled);
    }
  }

  const store = loadProfilesStore(options);
  const id = payload.id || `prof-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const entry = {
    id,
    name,
    description: String(payload.description || '').trim(),
    updatedAt: now,
    createdAt: now,
    plugins: payload.plugins && typeof payload.plugins === 'object' ? { ...payload.plugins } : pluginsMap,
    globalMcp: payload.globalMcp && typeof payload.globalMcp === 'object' ? { ...payload.globalMcp } : globalMcpMap,
  };

  // Enforce self-protection inside stored profile as well
  for (const prot of PROTECTED_PLUGINS) {
    if (prot in entry.plugins) entry.plugins[prot] = true;
  }

  const idx = store.profiles.findIndex((p) => p.id === id || p.name === name);
  if (idx >= 0) {
    entry.id = store.profiles[idx].id;
    entry.createdAt = store.profiles[idx].createdAt || now;
    store.profiles[idx] = entry;
  } else {
    store.profiles.unshift(entry);
  }
  saveProfilesStore(store, options);
  return entry;
}

export function deleteProfile(profileId, options = {}) {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('预设 ID 不能为空');
  if (id.startsWith('builtin:')) throw new Error('内置推荐预设不可删除');
  const store = loadProfilesStore(options);
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.profiles.length === before) throw new Error(`未找到预设: ${id}`);
  saveProfilesStore(store, options);
  return { ok: true, id };
}

/**
 * Compute an exact Diff preview before applying a Profile (supports both built-in and user-saved profiles).
 * Accepts optional `options.overrides = { plugins?: Record<string, boolean>, globalMcp?: Record<string, boolean> }`.
 */
export function previewProfileDiff(profileId, options = {}) {
  const eco = scanEcosystem({}, options);
  let profile = null;
  if (String(profileId || '').startsWith('builtin:')) {
    profile = listBuiltinProfiles(eco, options).find((p) => p.id === profileId) || null;
  } else {
    const store = loadProfilesStore(options);
    profile = store.profiles.find((p) => p.id === profileId) || null;
  }
  if (!profile) throw new Error(`未找到场景预设: ${profileId}`);

  const overrides = options.overrides && typeof options.overrides === 'object' ? options.overrides : null;
  const pluginOverrides = overrides?.plugins && typeof overrides.plugins === 'object' ? overrides.plugins : {};
  const mcpOverrides = overrides?.globalMcp && typeof overrides.globalMcp === 'object' ? overrides.globalMcp : {};

  const pluginChanges = [];
  const mcpChanges = [];
  const skippedProtected = [];
  const unchangedUncertain = [];
  const tokenBreakdown = { rules: 0, skills: 0, mcp: 0, total: 0 };

  for (const p of eco.plugins) {
    const hasOverride = p.id in pluginOverrides;
    if (!hasOverride && !(p.id in (profile.plugins || {}))) continue;
    const desired = hasOverride ? Boolean(pluginOverrides[p.id]) : Boolean(profile.plugins[p.id]);
    const isSystemProtected = Boolean(p.systemProtected ?? PROTECTED_PLUGINS.has(p.id));
    if (isSystemProtected && !desired) {
      skippedProtected.push(p.id);
      continue;
    }
    const pot = p.potentialTokens || p.tokens || { rules: 0, skills: 0, mcp: 0, total: 0 };
    if (p.enabled !== desired) {
      const sign = desired ? 1 : -1;
      tokenBreakdown.rules += sign * (pot.rules || 0);
      tokenBreakdown.skills += sign * (pot.skills || 0);
      tokenBreakdown.mcp += sign * (pot.mcp || 0);
      tokenBreakdown.total += sign * (pot.total || 0);
      pluginChanges.push({
        id: p.id,
        displayName: p.displayName,
        from: p.enabled,
        to: desired,
        action: desired ? 'enable' : 'disable',
        userPinned: Boolean(p.userPinned),
        classification: p.classification || null,
        tokenBreakdown: {
          rules: pot.rules || 0,
          skills: pot.skills || 0,
          mcp: pot.mcp || 0,
          total: pot.total || 0,
        },
      });
    } else if (
      profile.builtin &&
      !profile.deterministic &&
      !isSystemProtected &&
      !p.userPinned &&
      (p.classification?.category || 'general') === 'general'
    ) {
      unchangedUncertain.push({
        kind: 'plugin',
        id: p.id,
        displayName: p.displayName,
        enabled: p.enabled,
        classification: p.classification || null,
        tokenBreakdown: {
          rules: pot.rules || 0,
          skills: pot.skills || 0,
          mcp: pot.mcp || 0,
          total: pot.total || 0,
        },
      });
    }
  }

  for (const m of eco.mcpServers) {
    if (m.scope !== 'global') continue;
    const hasOverride = m.name in mcpOverrides;
    if (!hasOverride && !(m.name in (profile.globalMcp || {}))) continue;
    const desired = hasOverride ? Boolean(mcpOverrides[m.name]) : Boolean(profile.globalMcp[m.name]);
    const potMcp = m.potentialTokens ?? m.tokens ?? 0;
    if (m.enabled !== desired) {
      const sign = desired ? 1 : -1;
      tokenBreakdown.mcp += sign * potMcp;
      tokenBreakdown.total += sign * potMcp;
      mcpChanges.push({
        name: m.name,
        from: m.enabled,
        to: desired,
        action: desired ? 'enable' : 'disable',
        classification: m.classification || null,
        tokenBreakdown: {
          rules: 0,
          skills: 0,
          mcp: potMcp,
          total: potMcp,
        },
      });
    } else if (profile.builtin && !profile.deterministic && (m.classification?.category || 'general') === 'general') {
      unchangedUncertain.push({
        kind: 'mcp',
        id: m.name,
        displayName: m.name,
        enabled: m.enabled,
        classification: m.classification || null,
        tokenBreakdown: {
          rules: 0,
          skills: 0,
          mcp: potMcp,
          total: potMcp,
        },
      });
    }
  }

  return {
    profile,
    pluginChanges,
    mcpChanges,
    skippedProtected,
    unchangedUncertain,
    totalChanges: pluginChanges.length + mcpChanges.length,
    estimatedTokenDelta: tokenBreakdown.total,
    estimatedTokenBreakdown: tokenBreakdown,
  };
}

/**
 * Apply a Profile atomically with a single pre-write host snapshot.
 * Supports `options.overrides` for interactive checkbox adjustments and optional `options.saveAsName`.
 */
export function applyProfile(profileId, options = {}) {
  const diff = previewProfileDiff(profileId, options);
  const saveAsName = String(options.saveAsName || '').trim();

  if (diff.totalChanges === 0) {
    let savedProfile = null;
    if (saveAsName) {
      savedProfile = saveProfile(
        {
          name: saveAsName,
          description: `基于「${diff.profile.name}」保存`,
        },
        options
      );
    }
    return {
      ok: true,
      profileId,
      changed: 0,
      snapshotId: null,
      savedProfile,
      message: savedProfile
        ? `当前状态已与预设一致，并另存为自定义预设「${savedProfile.name}」`
        : `当前状态已与预设「${diff.profile.name}」一致，无需修改`,
    };
  }

  const { hostConfigFile, hostMcpConfigFile } = getHostConfigPaths(options);
  const { governanceDisabledMcpFile } = getDataPaths(options);

  const snapshot = createHostSnapshot(
    [hostConfigFile, hostMcpConfigFile, governanceDisabledMcpFile],
    `profile:apply:${diff.profile.name}`,
    options
  );

  try {
    if (diff.pluginChanges.length > 0) {
      atomicWriteJsonSafe(
        hostConfigFile,
        {
          allowEmpty: true,
          skipSnapshot: true,
          mutate: (cfg) => {
            if (!cfg.plugins || typeof cfg.plugins !== 'object' || Array.isArray(cfg.plugins)) {
              cfg.plugins = {};
            }
            for (const ch of diff.pluginChanges) {
              if (PROTECTED_PLUGINS.has(ch.id) && !ch.to) continue;
              const prev = cfg.plugins[ch.id] && typeof cfg.plugins[ch.id] === 'object' ? cfg.plugins[ch.id] : {};
              cfg.plugins[ch.id] = { ...prev, enabled: ch.to };
            }
            return cfg;
          },
          validate: (next, prev) => {
            for (const k of Object.keys(prev)) {
              if (!(k in next)) return `顶层字段 "${k}" 意外丢失`;
            }
            return null;
          },
        },
        options
      );
    }

    if (diff.mcpChanges.length > 0) {
      const disabledStore = loadDisabledGlobalMcp(options);
      atomicWriteJsonSafe(
        hostMcpConfigFile,
        {
          allowEmpty: true,
          skipSnapshot: true,
          mutate: (cfg) => {
            if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
              cfg.mcpServers = {};
            }
            for (const ch of diff.mcpChanges) {
              if (!ch.to && cfg.mcpServers[ch.name]) {
                disabledStore.servers[ch.name] = {
                  config: structuredClone(cfg.mcpServers[ch.name]),
                  disabledAt: new Date().toISOString(),
                };
                delete cfg.mcpServers[ch.name];
              } else if (ch.to && disabledStore.servers[ch.name]?.config) {
                cfg.mcpServers[ch.name] = structuredClone(disabledStore.servers[ch.name].config);
                delete disabledStore.servers[ch.name];
              }
            }
            return cfg;
          },
        },
        options
      );
      const { governanceDir } = getDataPaths(options);
      ensureDir(governanceDir);
      const tmp = `${governanceDisabledMcpFile}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(disabledStore, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, governanceDisabledMcpFile);
    }
  } catch (err) {
    rollbackSnapshot(snapshot.id, options);
    throw new Error(`批量切换预设失败并已自动回滚: ${err.message}`);
  }

  let savedProfile = null;
  if (saveAsName) {
    savedProfile = saveProfile(
      {
        name: saveAsName,
        description: `基于「${diff.profile.name}」微调保存`,
      },
      options
    );
  }

  appendAuditLog(
    {
      action: 'apply_profile',
      profileId: diff.profile.id,
      profileName: diff.profile.name,
      pluginChanges: diff.pluginChanges.length,
      mcpChanges: diff.mcpChanges.length,
      snapshotId: snapshot.id,
      savedProfileId: savedProfile?.id || null,
    },
    options
  );

  return {
    ok: true,
    profileId: diff.profile.id,
    profileName: diff.profile.name,
    changed: diff.totalChanges,
    snapshotId: snapshot.id,
    savedProfile,
    message: savedProfile
      ? `已切换至「${diff.profile.name}」（变更 ${diff.totalChanges} 项）并另存为「${savedProfile.name}」`
      : `已切换至场景预设「${diff.profile.name}」（变更 ${diff.totalChanges} 项，新会话生效）`,
  };
}
