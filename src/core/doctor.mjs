import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, getPluginDeployDir, formatDisplayPath } from './paths.mjs';
import { ensureDataDirs, readJsonSafe, readJsonlSafe, scanAllMemoryFiles, atomicWriteJson } from './storage.mjs';
import { rebuildIndex, withIndexDb } from './index-db.mjs';
import { redactObject } from './redact.mjs';

/**
 * Run comprehensive health & anti-fragile update diagnostics.
 */
export function runDoctor(options = {}) {
  const paths = ensureDataDirs(options);
  const pluginDir = getPluginDeployDir(options);
  const issues = [];

  // 1. Truth sources
  const truthMemories = scanAllMemoryFiles(options);
  const truthCalls = readJsonlSafe(paths.callsLogFile);
  const truthRawCallLines = truthCalls.length;
  const uniqueCallUids = new Set();
  for (const c of truthCalls) {
    if (c && c.callUid) uniqueCallUids.add(c.callUid);
  }
  const truthUniqueCalls = uniqueCallUids.size;

  // 2. SQLite WAL + FTS5 index status
  let dbMemories = 0;
  let dbCalls = 0;
  let dbOk = true;
  try {
    if (fs.existsSync(paths.dbFile)) {
      const stats = withIndexDb(options, (db) => {
        const m = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
        const c = db.prepare('SELECT COUNT(*) AS n FROM calls').get().n;
        const fts = db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n;
        return { m, c, fts };
      });
      dbMemories = stats.m;
      dbCalls = stats.c;
      if (stats.m !== truthMemories.length || stats.fts !== stats.m) {
        dbOk = false;
        issues.push(`SQLite 索引与真相源不一致（DB=${stats.m}, FTS=${stats.fts}, Truth=${truthMemories.length}）`);
      }
    } else if (truthMemories.length > 0 || truthCalls.length > 0) {
      dbOk = false;
      issues.push('SQLite 索引缺失但存在真相源文件，需重建索引');
    }
  } catch (err) {
    dbOk = false;
    issues.push(`SQLite 索引读取异常：${err.message}`);
  }

  // 3. Schema drift diagnostics
  const driftEntries = readJsonlSafe(paths.driftLogFile);
  if (driftEntries.length > 0) {
    issues.push(`检测到 ${driftEntries.length} 条 Hook 契约漂移记录（已安全降级处理）`);
  }

  // 4. Circuit breaker status
  const circuit = readJsonSafe(paths.circuitFile, { failures: 0, openUntil: 0, lastError: null });
  const now = Date.now();
  const circuitState = circuit.openUntil && now < circuit.openUntil ? 'OPEN' : 'CLOSED';
  if (circuitState === 'OPEN') {
    issues.push(`Fail-Open 熔断器当前处于 OPEN 状态（连续失败 ${circuit.failures} 次）`);
  }

  // 5. Deployed plugin bundle verification
  const requiredFiles = [
    'plugin.json',
    'hooks.json',
    'mcp_config.json',
    'rules/AGENTS.md',
    'skills/context-cache/SKILL.md',
    'dist/dashboard.html',
    'src/mcp/server.mjs',
    'src/adapters/antigravity/hook.mjs',
  ];
  const deployedExists = fs.existsSync(pluginDir);
  const missingDeployFiles = deployedExists
    ? requiredFiles.filter((rel) => !fs.existsSync(path.join(pluginDir, rel)))
    : requiredFiles;
  const hasNodeModules = deployedExists && fs.existsSync(path.join(pluginDir, 'node_modules'));
  const deployManifest = deployedExists ? readJsonSafe(path.join(pluginDir, 'deploy-manifest.json'), null) : null;

  let uiSizeBytes = 0;
  let uiHasExternalLinks = false;
  const uiPath = path.join(pluginDir, 'dist', 'dashboard.html');
  if (fs.existsSync(uiPath)) {
    const html = fs.readFileSync(uiPath, 'utf8');
    uiSizeBytes = Buffer.byteLength(html, 'utf8');
    uiHasExternalLinks = /<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html);
  }

  if (!deployedExists) {
    issues.push(`插件尚未部署至 ${formatDisplayPath(pluginDir)}`);
  } else {
    if (missingDeployFiles.length > 0) {
      issues.push(`部署目录缺少必要文件：${missingDeployFiles.join(', ')}`);
    }
    if (hasNodeModules) {
      issues.push('部署目录包含 node_modules（违反零运行时依赖规范）');
    }
    if (uiHasExternalLinks) {
      issues.push('单文件 UI 包含外部 script/link 链接（违反 MCP App CSP）');
    }
  }

  const healthy = dbOk && circuitState === 'CLOSED' && missingDeployFiles.length === 0 && !hasNodeModules && !uiHasExternalLinks;

  return {
    healthy,
    status: healthy ? 'healthy' : 'attention',
    version: deployManifest?.version || '1.6.1',
    dataDir: formatDisplayPath(paths.dataDir),
    pluginDir: formatDisplayPath(pluginDir),
    drift: {
      count: driftEntries.length,
      recent: driftEntries.slice(-5),
    },
    circuit: {
      state: circuitState,
      failures: Number(circuit.failures) || 0,
      threshold: 3,
      openUntil: circuit.openUntil || 0,
      lastError: circuit.lastError || null,
    },
    index: {
      ok: dbOk,
      truthMemories: truthMemories.length,
      dbMemories,
      truthCalls: truthRawCallLines,
      truthUniqueCalls,
      truthRawCallLines,
      dbCalls,
    },
    deployment: {
      exists: deployedExists,
      missingFiles: missingDeployFiles,
      zeroNodeModules: !hasNodeModules,
      uiSizeBytes,
      uiUnder10MiB: uiSizeBytes > 0 && uiSizeBytes < 10 * 1024 * 1024,
      uiSelfContained: !uiHasExternalLinks,
      deployedAt: deployManifest?.deployedAt || null,
    },
    issues,
  };
}

/**
 * Reset circuit breaker back to CLOSED.
 */
export function resetCircuitBreaker(options = {}) {
  const paths = ensureDataDirs(options);
  atomicWriteJson(paths.circuitFile, { failures: 0, openUntil: 0, lastError: null, resetAt: new Date().toISOString() });
  return { state: 'CLOSED', failures: 0 };
}

/**
 * Export a sanitized JSON backup bundle of truth sources & config to <dataDir>/exports/.
 */
export function exportBackup(options = {}) {
  const paths = ensureDataDirs(options);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(paths.exportsDir, `context-cache-backup-${stamp}.json`);

  const memories = scanAllMemoryFiles(options).map((m) => redactObject(m));
  const calls = readJsonlSafe(paths.callsLogFile).map((c) => redactObject(c));
  const config = redactObject(readJsonSafe(paths.configFile, {}));

  const payload = {
    exportedAt: new Date().toISOString(),
    version: '1.6.1',
    counts: {
      memories: memories.length,
      calls: calls.length,
    },
    config,
    memories,
    calls,
  };

  atomicWriteJson(outFile, payload);
  return {
    exportPath: outFile,
    displayPath: formatDisplayPath(outFile),
    counts: payload.counts,
  };
}

/**
 * Self-healing repair: optionally resync historical telemetry, rebuild SQLite WAL+FTS5 index
 * from truth sources & reset circuit breaker.
 */
export async function repairLocalState(options = {}) {
  let telemetryResync = null;
  if (options.resyncTelemetry) {
    const mod = await import('./telemetry.mjs');
    if (typeof mod.resyncAllHistoricalTelemetry === 'function') {
      telemetryResync = await mod.resyncAllHistoricalTelemetry(options);
    }
  }
  const rebuild = telemetryResync?.rebuild || rebuildIndex(options);
  const circuit = resetCircuitBreaker(options);
  const report = runDoctor(options);
  return {
    repaired: true,
    ...(telemetryResync ? { telemetryResync } : {}),
    rebuild,
    circuit,
    report,
  };
}
