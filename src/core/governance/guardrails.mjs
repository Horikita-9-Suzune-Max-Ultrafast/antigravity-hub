import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigRoot, getDataPaths, formatDisplayPath } from '../paths.mjs';
import { redactText } from '../redact.mjs';
import { atomicWriteFileSafe, withFileLockSync } from '../fs-utils.mjs';

export const PROTECTED_PLUGINS = new Set(['context-cache']);
const MAX_SNAPSHOTS = 30;

// Hook injected by governance/index.mjs or scanner to invalidate inventory cache without circular ESM imports
const cacheInvalidators = new Set();
export function registerGovernanceCacheInvalidator(fn) {
  if (typeof fn === 'function') cacheInvalidators.add(fn);
}
function notifyCacheInvalidators() {
  for (const fn of cacheInvalidators) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeAtomicRaw(filePath, contentStr) {
  atomicWriteFileSafe(filePath, contentStr, { verify: true });
}

export function appendAuditLog(entry, options = {}) {
  try {
    const { governanceDir, governanceAuditLog } = getDataPaths(options);
    ensureDir(governanceDir);
    const record = {
      ts: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(governanceAuditLog, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // non-fatal
  }
}

export function getHostConfigPaths(options = {}) {
  const configRoot = getConfigRoot(options);
  return {
    configRoot,
    hostConfigFile: path.join(configRoot, 'config.json'),
    hostMcpConfigFile: path.join(configRoot, 'mcp_config.json'),
  };
}

function loadSnapshotIndex(options = {}) {
  const { hostBackupsIndexFile } = getDataPaths(options);
  const idx = safeReadJson(hostBackupsIndexFile, { snapshots: [] });
  if (!idx || !Array.isArray(idx.snapshots)) return { snapshots: [] };
  return idx;
}

function saveSnapshotIndex(index, options = {}) {
  const { hostBackupsDir, hostBackupsIndexFile } = getDataPaths(options);
  ensureDir(hostBackupsDir);
  writeAtomicRaw(hostBackupsIndexFile, JSON.stringify(index, null, 2) + '\n');
}

/**
 * Create an immutable pre-write snapshot of one or more host or workspace config files.
 * Preserves the very first baseline snapshot permanently and retains the latest MAX_SNAPSHOTS entries.
 * Encodes target path hashes in backup filenames to avoid basename collisions across workspaces (v1.7.0 R10 ready).
 */
export function createHostSnapshot(targetFiles, reason, options = {}) {
  const { hostBackupsDir, hostBackupsIndexFile } = getDataPaths(options);
  ensureDir(hostBackupsDir);

  return withFileLockSync(hostBackupsIndexFile, () => {
    const index = loadSnapshotIndex(options);
    const ts = new Date();
    const stamp = ts.toISOString().replace(/[:.]/g, '-');
    const id = `snap-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const isBaseline = index.snapshots.length === 0;

    const files = [];
    for (const rawPath of targetFiles) {
      const absPath = path.resolve(rawPath);
      const baseName = path.basename(absPath);
      const pathHash = sha256(absPath.toLowerCase()).slice(0, 8);
      const existed = fs.existsSync(absPath);
      const rawBuf = existed ? fs.readFileSync(absPath) : Buffer.alloc(0);
      const backupName = `${isBaseline ? 'baseline-' : ''}${id}-${pathHash}-${baseName}.bak`;
      const backupPath = path.join(hostBackupsDir, backupName);
      if (existed) {
        atomicWriteFileSafe(backupPath, rawBuf, { verify: true });
      }
      files.push({
        targetPath: absPath,
        displayPath: formatDisplayPath(absPath),
        fileName: baseName,
        existed,
        bytes: rawBuf.length,
        sha256: existed ? sha256(rawBuf) : null,
        backupName: existed ? backupName : null,
      });
    }

    const record = {
      id,
      createdAt: ts.toISOString(),
      reason: String(reason || 'manual'),
      baseline: isBaseline,
      files,
    };

    index.snapshots.unshift(record);

    // Prune old non-baseline snapshots beyond MAX_SNAPSHOTS
    const keep = [];
    const drop = [];
    for (const s of index.snapshots) {
      if (s.baseline || keep.length < MAX_SNAPSHOTS) {
        keep.push(s);
      } else {
        drop.push(s);
      }
    }
    for (const old of drop) {
      for (const f of old.files || []) {
        if (!f.backupName) continue;
        const p = path.join(hostBackupsDir, f.backupName);
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // ignore prune error
        }
      }
    }

    index.snapshots = keep;
    saveSnapshotIndex(index, options);
    return record;
  });
}

/**
 * Safely mutate a JSON host configuration file with cross-process advisory lock,
 * pre-write snapshot, JSON round-trip validation, and Windows-resilient atomic write.
 */
export function atomicWriteJsonSafe(
  filePath,
  { allowEmpty = false, reason = 'update', skipSnapshot = false, mutate, validate },
  options = {}
) {
  return withFileLockSync(filePath, () => {
    const existed = fs.existsSync(filePath);
    let current = {};

    if (existed) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) {
        if (!allowEmpty) {
          throw new Error(`目标配置文件为空，为避免覆盖异常文件已中止写入: ${formatDisplayPath(filePath)}`);
        }
        current = {};
      } else {
        try {
          current = JSON.parse(raw);
        } catch (err) {
          throw new Error(`目标配置文件 JSON 解析失败，已中止写入以防损坏: ${err.message}`);
        }
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          throw new Error(`目标配置文件根节点必须为 JSON 对象: ${formatDisplayPath(filePath)}`);
        }
      }
    } else if (!allowEmpty) {
      throw new Error(`目标配置文件不存在: ${formatDisplayPath(filePath)}`);
    }

    const clone = structuredClone(current);
    const next = mutate(clone);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('变更函数未返回合法 JSON 对象，已中止写入');
    }

    if (typeof validate === 'function') {
      const errMsg = validate(next, current);
      if (errMsg) {
        throw new Error(`配置 Schema 校验失败: ${errMsg}`);
      }
    }

    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const reparsed = JSON.parse(serialized);
    if (!reparsed || typeof reparsed !== 'object') {
      throw new Error('JSON 往返校验失败');
    }

    const snapshot = skipSnapshot ? null : createHostSnapshot([filePath], reason, options);
    writeAtomicRaw(filePath, serialized);
    return { snapshot, before: current, after: next };
  });
}

/**
 * Guardrail #1 + #2 + #3: Toggle a plugin's enabled state in ~/.gemini/config/config.json.
 */
export function togglePluginEnabled(pluginId, enabled, options = {}) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('插件 ID 不能为空');
  if (PROTECTED_PLUGINS.has(id) && !enabled) {
    throw new Error(`「${id}」为受保护核心控制台插件，禁止禁用以防自身失联`);
  }

  const { hostConfigFile } = getHostConfigPaths(options);
  const res = atomicWriteJsonSafe(
    hostConfigFile,
    {
      allowEmpty: true,
      reason: `plugin:${id}:${enabled ? 'enable' : 'disable'}`,
      mutate: (cfg) => {
        if (!cfg.plugins || typeof cfg.plugins !== 'object' || Array.isArray(cfg.plugins)) {
          cfg.plugins = {};
        }
        const prevEntry = cfg.plugins[id] && typeof cfg.plugins[id] === 'object' ? cfg.plugins[id] : {};
        cfg.plugins[id] = {
          ...prevEntry,
          enabled: Boolean(enabled),
        };
        return cfg;
      },
      validate: (next, prev) => {
        for (const k of Object.keys(prev)) {
          if (!(k in next)) return `顶层字段 "${k}" 意外丢失`;
        }
        if (typeof next.plugins?.[id]?.enabled !== 'boolean') {
          return `plugins.${id}.enabled 必须为布尔值`;
        }
        return null;
      },
    },
    options
  );

  notifyCacheInvalidators();
  appendAuditLog(
    {
      action: 'toggle_plugin',
      pluginId: id,
      enabled: Boolean(enabled),
      snapshotId: res.snapshot?.id || null,
    },
    options
  );

  return {
    ok: true,
    pluginId: id,
    enabled: Boolean(enabled),
    snapshotId: res.snapshot?.id || null,
    message: `已${enabled ? '启用' : '停用'}插件「${id}」（新会话生效）`,
  };
}

export function loadDisabledGlobalMcp(options = {}) {
  const { governanceDisabledMcpFile } = getDataPaths(options);
  const data = safeReadJson(governanceDisabledMcpFile, { servers: {} });
  if (!data || typeof data !== 'object' || !data.servers || typeof data.servers !== 'object') {
    return { servers: {} };
  }
  return data;
}

export function saveDisabledGlobalMcp(data, options = {}) {
  const { governanceDir, governanceDisabledMcpFile } = getDataPaths(options);
  ensureDir(governanceDir);
  withFileLockSync(governanceDisabledMcpFile, () => {
    writeAtomicRaw(governanceDisabledMcpFile, `${JSON.stringify(data, null, 2)}\n`);
  });
}

/**
 * Guardrail #2 + #3: Toggle a global MCP server by moving its definition cleanly
 * between ~/.gemini/config/mcp_config.json and ~/.context-cache/governance/disabled-mcp.json.
 */
export function toggleGlobalMcpServer(serverName, enabled, options = {}) {
  const name = String(serverName || '').trim();
  if (!name) throw new Error('MCP Server 名称不能为空');

  const { hostMcpConfigFile } = getHostConfigPaths(options);
  const { governanceDisabledMcpFile } = getDataPaths(options);
  const disabledStore = loadDisabledGlobalMcp(options);

  const snapshot = createHostSnapshot(
    [hostMcpConfigFile, governanceDisabledMcpFile],
    `mcp:${name}:${enabled ? 'enable' : 'disable'}`,
    options
  );

  let movedConfig = null;
  if (!enabled) {
    atomicWriteJsonSafe(
      hostMcpConfigFile,
      {
        allowEmpty: false,
        skipSnapshot: true,
        mutate: (cfg) => {
          if (!cfg.mcpServers || !cfg.mcpServers[name]) {
            throw new Error(`全局 mcp_config.json 中未找到「${name}」`);
          }
          movedConfig = structuredClone(cfg.mcpServers[name]);
          delete cfg.mcpServers[name];
          return cfg;
        },
        validate: (next) => {
          if (!next.mcpServers || typeof next.mcpServers !== 'object' || Array.isArray(next.mcpServers)) {
            return 'mcpServers 必须为对象';
          }
          return null;
        },
      },
      options
    );
    try {
      disabledStore.servers[name] = {
        config: movedConfig,
        disabledAt: new Date().toISOString(),
      };
      saveDisabledGlobalMcp(disabledStore, options);
    } catch (err) {
      rollbackSnapshot(snapshot.id, options);
      throw err;
    }
  } else {
    const staged = disabledStore.servers[name];
    if (!staged || !staged.config) {
      throw new Error(`暂存区中未找到已停用的全局 MCP「${name}」`);
    }
    atomicWriteJsonSafe(
      hostMcpConfigFile,
      {
        allowEmpty: true,
        skipSnapshot: true,
        mutate: (cfg) => {
          if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
            cfg.mcpServers = {};
          }
          cfg.mcpServers[name] = structuredClone(staged.config);
          return cfg;
        },
        validate: (next) => {
          if (!next.mcpServers || !next.mcpServers[name]) {
            return `未能恢复全局 MCP "${name}"`;
          }
          return null;
        },
      },
      options
    );
    try {
      delete disabledStore.servers[name];
      saveDisabledGlobalMcp(disabledStore, options);
    } catch (err) {
      rollbackSnapshot(snapshot.id, options);
      throw err;
    }
  }

  notifyCacheInvalidators();
  appendAuditLog(
    {
      action: 'toggle_mcp',
      serverName: name,
      enabled: Boolean(enabled),
      snapshotId: snapshot.id,
    },
    options
  );

  return {
    ok: true,
    serverName: name,
    enabled: Boolean(enabled),
    snapshotId: snapshot.id,
    message: `已${enabled ? '恢复启用' : '隔离停用'}全局 MCP「${name}」（新会话生效）`,
  };
}

export function listSnapshots(options = {}) {
  const { hostBackupsDir } = getDataPaths(options);
  const index = loadSnapshotIndex(options);
  return index.snapshots.map((s) => ({
    ...s,
    available: (s.files || []).every(
      (f) => !f.existed || (f.backupName && fs.existsSync(path.join(hostBackupsDir, f.backupName)))
    ),
  }));
}

export function previewRollback(snapshotId, options = {}) {
  const snapshots = listSnapshots(options);
  const target = snapshotId ? snapshots.find((s) => s.id === snapshotId) : snapshots[0];
  if (!target) throw new Error('未找到可恢复的宿主配置快照');

  const { hostBackupsDir } = getDataPaths(options);
  const diffs = (target.files || []).map((f) => {
    const curExists = fs.existsSync(f.targetPath);
    const curBuf = curExists ? fs.readFileSync(f.targetPath) : Buffer.alloc(0);
    const curHash = curExists ? sha256(curBuf) : null;
    const bakPath = f.backupName ? path.join(hostBackupsDir, f.backupName) : null;
    const bakText = f.existed && bakPath && fs.existsSync(bakPath) ? fs.readFileSync(bakPath, 'utf8') : '';
    const curText = curExists ? curBuf.toString('utf8') : '';
    return {
      fileName: f.fileName,
      displayPath: f.displayPath,
      willChange: curHash !== f.sha256 || curExists !== f.existed,
      action: f.existed ? (curExists ? 'restore' : 'recreate') : curExists ? 'remove' : 'noop',
      currentBytes: curBuf.length,
      snapshotBytes: f.bytes,
      snapshotPreview: redactText(bakText).slice(0, 800),
      currentPreview: redactText(curText).slice(0, 800),
    };
  });

  return {
    snapshot: target,
    diffs,
  };
}

/**
 * Guardrail #4: Restore host/workspace configuration files byte-for-byte from a saved snapshot.
 */
export function rollbackSnapshot(snapshotId, options = {}) {
  const { hostBackupsDir } = getDataPaths(options);
  const index = loadSnapshotIndex(options);
  const target = snapshotId ? index.snapshots.find((s) => s.id === snapshotId) : index.snapshots[0];
  if (!target) {
    throw new Error(snapshotId ? `未找到快照: ${snapshotId}` : '当前没有可恢复的宿主配置快照');
  }

  const restoredFiles = [];
  for (const f of target.files || []) {
    if (f.existed) {
      const bakPath = f.backupName ? path.join(hostBackupsDir, f.backupName) : null;
      if (!bakPath || !fs.existsSync(bakPath)) {
        throw new Error(`快照备份文件缺失: ${f.backupName || f.fileName}`);
      }
      const bakBuf = fs.readFileSync(bakPath);
      if (f.sha256 && sha256(bakBuf) !== f.sha256) {
        throw new Error(`快照完整性校验失败（SHA-256 不匹配）: ${f.fileName}`);
      }
      withFileLockSync(f.targetPath, () => {
        atomicWriteFileSafe(f.targetPath, bakBuf, { verify: true });
      });
      restoredFiles.push(f.displayPath);
    } else if (fs.existsSync(f.targetPath)) {
      withFileLockSync(f.targetPath, () => {
        if (fs.existsSync(f.targetPath)) fs.unlinkSync(f.targetPath);
      });
      restoredFiles.push(`${f.displayPath} (removed)`);
    }
  }

  notifyCacheInvalidators();
  appendAuditLog(
    {
      action: 'rollback_snapshot',
      snapshotId: target.id,
      restoredFiles,
    },
    options
  );

  return {
    ok: true,
    snapshotId: target.id,
    reason: target.reason,
    createdAt: target.createdAt,
    restoredFiles,
    message: `已无损还原快照 ${target.id}（${restoredFiles.length} 个文件）`,
  };
}

export const VALID_ITEM_CATEGORIES = new Set(['coding', 'office', 'general']);

export function loadGovernancePreferences(options = {}) {
  const { governancePrefsFile } = getDataPaths(options);
  const raw = safeReadJson(governancePrefsFile, null);
  const pinnedPlugins = Array.isArray(raw?.pinnedPlugins)
    ? [...new Set(raw.pinnedPlugins.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];
  const categories = {};
  if (raw?.categories && typeof raw.categories === 'object' && !Array.isArray(raw.categories)) {
    for (const [k, v] of Object.entries(raw.categories)) {
      const key = String(k || '').trim();
      const val = String(v || '').trim();
      if (key && VALID_ITEM_CATEGORIES.has(val)) {
        categories[key] = val;
      }
    }
  }
  const ignoredFindings = Array.isArray(raw?.ignoredFindings)
    ? [...new Set(raw.ignoredFindings.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];
  return { pinnedPlugins, categories, ignoredFindings };
}

export function saveGovernancePreferences(prefs, options = {}) {
  const { governanceDir, governancePrefsFile } = getDataPaths(options);
  ensureDir(governanceDir);
  const normalized = {
    pinnedPlugins: [...new Set((prefs?.pinnedPlugins || []).map((x) => String(x || '').trim()).filter(Boolean))],
    categories: {},
    ignoredFindings: [...new Set((prefs?.ignoredFindings || []).map((x) => String(x || '').trim()).filter(Boolean))],
    updatedAt: new Date().toISOString(),
  };
  if (prefs?.categories && typeof prefs.categories === 'object') {
    for (const [k, v] of Object.entries(prefs.categories)) {
      const key = String(k || '').trim();
      const val = String(v || '').trim();
      if (key && VALID_ITEM_CATEGORIES.has(val)) {
        normalized.categories[key] = val;
      }
    }
  }
  withFileLockSync(governancePrefsFile, () => {
    writeAtomicRaw(governancePrefsFile, `${JSON.stringify(normalized, null, 2)}\n`);
  });
  notifyCacheInvalidators();
  return normalized;
}

export function setPluginPinned(pluginId, pinned, options = {}) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('插件 ID 不能为空');
  if (PROTECTED_PLUGINS.has(id) && !pinned) {
    throw new Error(`「${id}」为系统保护插件，无法取消常驻`);
  }

  const prefs = loadGovernancePreferences(options);
  const set = new Set(prefs.pinnedPlugins);
  if (pinned) {
    set.add(id);
  } else {
    set.delete(id);
  }
  const saved = saveGovernancePreferences({ ...prefs, pinnedPlugins: [...set] }, options);

  appendAuditLog(
    {
      action: 'set_plugin_pin',
      pluginId: id,
      pinned: Boolean(pinned),
    },
    options
  );

  return {
    ok: true,
    pluginId: id,
    pinned: Boolean(pinned),
    preferences: saved,
    message: pinned ? `已将「${id}」设为常驻核心插件` : `已取消「${id}」的常驻保护`,
  };
}

export function setItemCategory(itemKey, category, options = {}) {
  const key = String(itemKey || '').trim();
  if (!key || (!key.startsWith('plugin:') && !key.startsWith('mcp:'))) {
    throw new Error('itemKey 格式必须为 plugin:<id> 或 mcp:<name>');
  }
  const cat = String(category || '').trim().toLowerCase();
  const prefs = loadGovernancePreferences(options);
  const nextCategories = { ...prefs.categories };

  if (!cat || cat === 'auto') {
    delete nextCategories[key];
  } else if (VALID_ITEM_CATEGORIES.has(cat)) {
    nextCategories[key] = cat;
  } else {
    throw new Error(`不支持的分类标签: ${category}`);
  }

  const saved = saveGovernancePreferences({ ...prefs, categories: nextCategories }, options);

  appendAuditLog(
    {
      action: 'set_item_category',
      itemKey: key,
      category: cat || 'auto',
    },
    options
  );

  const labelMap = { auto: '自动推断', coding: '开发', office: '办公协作', general: '通用' };
  return {
    ok: true,
    itemKey: key,
    category: cat || 'auto',
    preferences: saved,
    message: `已更新分类为「${labelMap[cat || 'auto'] || cat}」`,
  };
}

export function setLintFindingIgnored(findingId, ignored, options = {}) {
  const id = String(findingId || '').trim();
  if (!id) throw new Error('findingId 不能为空');
  const prefs = loadGovernancePreferences(options);
  const set = new Set(prefs.ignoredFindings || []);
  if (ignored) {
    set.add(id);
  } else {
    set.delete(id);
  }
  const saved = saveGovernancePreferences({ ...prefs, ignoredFindings: [...set] }, options);

  appendAuditLog(
    {
      action: 'set_lint_ignore',
      findingId: id,
      ignored: Boolean(ignored),
    },
    options
  );

  return {
    ok: true,
    findingId: id,
    ignored: Boolean(ignored),
    preferences: saved,
    message: ignored ? '已忽略该体检项（可随时在底部恢复）' : '已恢复该体检项检查',
  };
}
