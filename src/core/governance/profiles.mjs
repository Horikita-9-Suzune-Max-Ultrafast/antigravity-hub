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
    pluginsMap[p.id] = p.protected ? true : Boolean(p.enabled);
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
  const store = loadProfilesStore(options);
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.profiles.length === before) throw new Error(`未找到预设: ${id}`);
  saveProfilesStore(store, options);
  return { ok: true, id };
}

/**
 * Compute an exact Diff preview before applying a Profile.
 */
export function previewProfileDiff(profileId, options = {}) {
  const store = loadProfilesStore(options);
  const profile = store.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`未找到场景预设: ${profileId}`);

  const eco = scanEcosystem({}, options);
  const pluginChanges = [];
  const mcpChanges = [];
  const skippedProtected = [];
  let tokenDelta = 0;

  for (const p of eco.plugins) {
    if (!(p.id in (profile.plugins || {}))) continue;
    const desired = Boolean(profile.plugins[p.id]);
    if (p.protected && !desired) {
      skippedProtected.push(p.id);
      continue;
    }
    if (p.enabled !== desired) {
      // Approximate token impact
      const impact = p.tokens.total || 0;
      tokenDelta += desired ? impact : -impact;
      pluginChanges.push({
        id: p.id,
        displayName: p.displayName,
        from: p.enabled,
        to: desired,
        action: desired ? 'enable' : 'disable',
      });
    }
  }

  for (const m of eco.mcpServers) {
    if (m.scope !== 'global') continue;
    if (!(m.name in (profile.globalMcp || {}))) continue;
    const desired = Boolean(profile.globalMcp[m.name]);
    if (m.enabled !== desired) {
      const impact = m.tokens || 0;
      tokenDelta += desired ? impact : -impact;
      mcpChanges.push({
        name: m.name,
        from: m.enabled,
        to: desired,
        action: desired ? 'enable' : 'disable',
      });
    }
  }

  return {
    profile,
    pluginChanges,
    mcpChanges,
    skippedProtected,
    totalChanges: pluginChanges.length + mcpChanges.length,
    estimatedTokenDelta: tokenDelta,
  };
}

/**
 * Apply a Profile atomically with a single pre-write host snapshot.
 */
export function applyProfile(profileId, options = {}) {
  const diff = previewProfileDiff(profileId, options);
  if (diff.totalChanges === 0) {
    return {
      ok: true,
      profileId,
      changed: 0,
      snapshotId: null,
      message: `当前状态已与预设「${diff.profile.name}」一致，无需修改`,
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

  appendAuditLog(
    {
      action: 'apply_profile',
      profileId: diff.profile.id,
      profileName: diff.profile.name,
      pluginChanges: diff.pluginChanges.length,
      mcpChanges: diff.mcpChanges.length,
      snapshotId: snapshot.id,
    },
    options
  );

  return {
    ok: true,
    profileId: diff.profile.id,
    profileName: diff.profile.name,
    changed: diff.totalChanges,
    snapshotId: snapshot.id,
    message: `已切换至场景预设「${diff.profile.name}」（变更 ${diff.totalChanges} 项，新会话生效）`,
  };
}
