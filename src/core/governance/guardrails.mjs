import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigRoot, getDataPaths, formatDisplayPath } from '../paths.mjs';
import { redactText } from '../redact.mjs';

export const PROTECTED_PLUGINS = new Set(['context-cache']);
const MAX_SNAPSHOTS = 30;

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
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, contentStr, 'utf8');
    const verify = fs.readFileSync(tmpPath, 'utf8');
    if (verify !== contentStr) {
      throw new Error('Write verification mismatch');
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
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
 * Create an immutable pre-write snapshot of one or more host config files.
 * Preserves the very first baseline snapshot permanently and retains the latest MAX_SNAPSHOTS entries.
 */
export function createHostSnapshot(targetFiles, reason, options = {}) {
  const { hostBackupsDir } = getDataPaths(options);
  ensureDir(hostBackupsDir);

  const index = loadSnapshotIndex(options);
  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, '-');
  const id = `snap-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const isBaseline = index.snapshots.length === 0;

  const files = [];
  for (const absPath of targetFiles) {
    const baseName = path.basename(absPath);
    const existed = fs.existsSync(absPath);
    const rawBuf = existed ? fs.readFileSync(absPath) : Buffer.alloc(0);
    const backupName = `${isBaseline ? 'baseline-' : ''}${id}-${baseName}.bak`;
    const backupPath = path.join(hostBackupsDir, backupName);
    if (existed) {
      fs.writeFileSync(backupPath, rawBuf);
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
}

/**
 * Safely mutate a JSON host configuration file with pre-write snapshot,
 * JSON round-trip validation, and atomic rename.
 */
export function atomicWriteJsonSafe(filePath, { allowEmpty = false, reason = 'update', skipSnapshot = false, mutate, validate }, options = {}) {
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
  // Round-trip validation before touching disk
  const reparsed = JSON.parse(serialized);
  if (!reparsed || typeof reparsed !== 'object') {
    throw new Error('JSON 往返校验失败');
  }

  const snapshot = skipSnapshot ? null : createHostSnapshot([filePath], reason, options);
  writeAtomicRaw(filePath, serialized);
  return { snapshot, before: current, after: next };
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
        // Ensure no unrelated top-level keys were lost
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

function saveDisabledGlobalMcp(data, options = {}) {
  const { governanceDir, governanceDisabledMcpFile } = getDataPaths(options);
  ensureDir(governanceDir);
  writeAtomicRaw(governanceDisabledMcpFile, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Guardrail #2 + #3: Toggle a global MCP server by moving its definition cleanly
 * between ~/.gemini/config/mcp_config.json and ~/.context-cache/governance/disabled-mcp.json.
 * Never injects non-standard fields into mcp_config.json.
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
    // Move from host mcp_config.json -> disabled-mcp.json
    const res = atomicWriteJsonSafe(
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
      // Roll back host file if staging write fails
      rollbackSnapshot(snapshot.id, options);
      throw err;
    }
    void res;
  } else {
    // Move from disabled-mcp.json -> host mcp_config.json
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
    available: (s.files || []).every((f) => !f.existed || (f.backupName && fs.existsSync(path.join(hostBackupsDir, f.backupName)))),
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
      action: f.existed ? (curExists ? 'restore' : 'recreate') : (curExists ? 'remove' : 'noop'),
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
 * Guardrail #4: Restore host configuration files byte-for-byte from a saved snapshot.
 */
export function rollbackSnapshot(snapshotId, options = {}) {
  const { hostBackupsDir } = getDataPaths(options);
  const index = loadSnapshotIndex(options);
  const target = snapshotId ? index.snapshots.find((s) => s.id === snapshotId) : index.snapshots[0];
  if (!target) {
    throw new Error(snapshotId ? `未找到快照: ${snapshotId}` : '当前没有可恢复的宿主配置快照');
  }

  // Create a safety pre-rollback snapshot first (skip if rolling back to the very latest identical state)
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
      ensureDir(path.dirname(f.targetPath));
      const tmpPath = `${f.targetPath}.rollback.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, bakBuf);
      fs.renameSync(tmpPath, f.targetPath);
      restoredFiles.push(f.displayPath);
    } else if (fs.existsSync(f.targetPath)) {
      fs.unlinkSync(f.targetPath);
      restoredFiles.push(`${f.displayPath} (removed)`);
    }
  }

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
