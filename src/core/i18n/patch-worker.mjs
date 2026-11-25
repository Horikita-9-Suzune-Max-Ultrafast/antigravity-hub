import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDataPaths } from '../paths.mjs';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage.mjs';
import { hasAsarFile, readAsarFile, patchAsarStreaming } from './asar.mjs';
import {
  CONSOLE_META_PATH,
  CONSOLE_RUNTIME_PATH,
  CONSOLE_MAIN_PATH,
  inspectAsarMarkers,
  scanBackups,
  readAsarPackageVersion,
  readElectronVersionFile,
} from './detector.mjs';
import {
  injectMarkerBlock,
  stripMarkerBlock,
  buildPreloadLoaderSnippet,
  buildMainLoaderSnippet,
  buildRendererRuntimeSource,
  buildMainRuntimeSource,
} from './payload-templates.mjs';
import { compileRuntimeBundle } from './dictionary.mjs';

export const PATCH_VERSION = '1.0.0';
const CONSOLE_BACKUP_NAME = 'app.asar.agy-console.bak';
const DEFAULT_WAIT_BEFORE_KILL_MS = 800;
const DEFAULT_UNLOCK_TIMEOUT_MS = 12_000;
const UNLOCK_POLL_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atomicCopyFile(srcPath, destPath) {
  const dir = path.dirname(path.resolve(destPath));
  ensureDir(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(destPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.copyFileSync(srcPath, tmpPath);
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function isFileWritable(filePath) {
  if (!fs.existsSync(filePath)) return true;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    fd = null;
    return true;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return false;
  }
}

async function waitForFileWritable(filePath, timeoutMs = DEFAULT_UNLOCK_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || DEFAULT_UNLOCK_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (isFileWritable(filePath)) return true;
    await sleep(UNLOCK_POLL_INTERVAL_MS);
  }
  return isFileWritable(filePath);
}

function terminateAntigravityProcess(exePath) {
  const platform = process.platform;
  const exeName = exePath ? path.basename(exePath) : platform === 'win32' ? 'Antigravity.exe' : 'Antigravity';
  try {
    if (platform === 'win32') {
      // Do NOT pass /T (tree kill): only terminate Antigravity.exe processes holding app.asar,
      // never risk killing detached helper workers in an ancestor/descendant chain.
      execFileSync('taskkill', ['/F', '/IM', exeName], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      execFileSync('pkill', ['-x', exeName], {
        stdio: 'ignore',
      });
    }
  } catch {
    // Process may already be closed or not running; ignore non-zero exit code
  }
}

function relaunchAntigravityProcess(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return false;
  if (process.platform === 'win32') {
    const psEscape = (s) => String(s).replace(/'/g, "''");
    const cwd = path.dirname(exePath);
    for (const shell of ['pwsh', 'powershell']) {
      try {
        execFileSync(
          shell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Process -FilePath '${psEscape(exePath)}' -WorkingDirectory '${psEscape(cwd)}'`,
          ],
          { stdio: 'ignore', windowsHide: true, timeout: 8000 }
        );
        return true;
      } catch {
        // Fallback to next method
      }
    }
  }
  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(exePath),
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function updateJobFile(jobFilePath, record) {
  if (!jobFilePath) return;
  try {
    ensureDir(path.dirname(jobFilePath));
    atomicWriteJson(jobFilePath, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort status write
  }
}

function normalizeBaseSemver(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+\.\d+\.\d+)(?:-(.+))?$/i);
  if (!m) return null;
  return { core: m[1], tag: m[2] || '' };
}

function backupMatchesForThirdParty(backup, currentAsarVersion) {
  if (backup.matchesCurrentVersion) return true;
  if (!currentAsarVersion || !backup.appVersion) return false;
  const cur = normalizeBaseSemver(currentAsarVersion);
  const bak = normalizeBaseSemver(backup.appVersion);
  if (!cur || !bak || cur.core !== bak.core) return false;
  // Block distinct numbered prereleases (e.g. beta.1 vs beta.2), while allowing same-release
  // patch-tag variants (e.g. 2.35.2 vs 2.35.2-zh-cn or 1.2.4-clean vs 1.2.4-third-party).
  const hasDigit = (s) => /\d/.test(s);
  if (hasDigit(cur.tag) && hasDigit(bak.tag) && cur.tag !== bak.tag) return false;
  return Boolean(cur.tag || bak.tag);
}

/**
 * Resolve the clean base ASAR for apply without EVER backing up a patched app.asar as clean original
 * or downgrading to a stale older-version .bak.
 */
function resolveCleanBaseForApply(asarPath, resourcesDir) {
  const consoleBackupPath = path.join(resourcesDir, CONSOLE_BACKUP_NAME);
  const currentMarkers = inspectAsarMarkers(asarPath);
  if (!currentMarkers.valid) {
    throw new Error(`Invalid target app.asar: ${currentMarkers.error || asarPath}`);
  }

  // Case 1: Current app.asar is clean original (first-time apply OR after official Antigravity update).
  // Refresh app.asar.agy-console.bak from the current clean app.asar so it matches the installed version.
  if (currentMarkers.isCleanOriginal) {
    atomicCopyFile(asarPath, consoleBackupPath);
    return {
      baseAsarPath: consoleBackupPath,
      backupPath: consoleBackupPath,
      backupSource: 'current_clean_asar',
    };
  }

  const currentAsarVersion = readAsarPackageVersion(asarPath);
  const backups = scanBackups(resourcesDir, currentAsarVersion);
  const cleanBackups = backups.filter((b) => b.valid && b.isCleanOriginal);
  const isBackupEligible = (b) =>
    currentMarkers.hasThirdPartyPatch
      ? backupMatchesForThirdParty(b, currentAsarVersion)
      : Boolean(b.matchesCurrentVersion);

  const consoleBackup = cleanBackups.find(
    (b) => b.name === CONSOLE_BACKUP_NAME && isBackupEligible(b)
  );
  const otherCleanBackup = cleanBackups.find(
    (b) => b.name !== CONSOLE_BACKUP_NAME && isBackupEligible(b)
  );
  const hasMismatchedCleanBackup = cleanBackups.length > 0 && !consoleBackup && !otherCleanBackup;

  // Case 2: Current app.asar is already patched (either by us or third-party).
  // NEVER copy current patched app.asar to app.asar.agy-console.bak, and never downgrade to a stale .bak!
  if (consoleBackup) {
    return {
      baseAsarPath: consoleBackup.path,
      backupPath: consoleBackup.path,
      backupSource: 'existing_console_backup',
    };
  }

  // Case 3: No matching clean console backup, but a matching clean third-party/generic backup exists.
  if (otherCleanBackup) {
    atomicCopyFile(otherCleanBackup.path, consoleBackupPath);
    return {
      baseAsarPath: consoleBackupPath,
      backupPath: consoleBackupPath,
      backupSource: otherCleanBackup.name,
    };
  }

  // Case 4: Patched by third-party with NO matching clean backup -> refuse safely!
  if (currentMarkers.hasThirdPartyPatch) {
    if (hasMismatchedCleanBackup) {
      const foundVersions = cleanBackups
        .map((b) => `${b.name}(${b.appVersion ? `v${b.appVersion}` : '未知版本'})`)
        .join('、');
      throw new Error(
        `检测到第三方汉化补丁，但已有原版备份版本与当前 app.asar（${currentAsarVersion ? `v${currentAsarVersion}` : '未知版本'}）不匹配（检测到：${foundVersions}），已阻止替换以防误覆盖降级。`
      );
    }
    throw new Error(
      '检测到第三方汉化补丁，但未找到干净的原版 app.asar 备份（app.asar.agy-console.bak / app.asar.zh-cn.bak / app.asar.bak）。已中止以防损坏原版备份。'
    );
  }

  // Case 5: Patched only by Console, and backup was deleted or only stale older-version backups exist ->
  // re-patch current app.asar idempotently WITHOUT downgrading or creating a fake clean backup.
  return {
    baseAsarPath: asarPath,
    backupPath: null,
    backupSource: 'repatch_without_backup',
  };
}

function loadOrCompileBundle(jobSpec) {
  if (jobSpec.bundleFilePath && fs.existsSync(jobSpec.bundleFilePath)) {
    const parsed = readJsonSafe(jobSpec.bundleFilePath, null);
    if (parsed && typeof parsed === 'object' && parsed.ui) {
      return parsed;
    }
  }
  const compiled = compileRuntimeBundle({ dataDir: jobSpec.dataDir });
  return compiled.bundle;
}

function performApply(jobSpec) {
  const { asarPath, resourcesDir, appVersion, electronVersion, bundleFilePath, stateFilePath, installDir } = jobSpec;
  const resolvedInstallDir = installDir || (resourcesDir ? path.dirname(resourcesDir) : path.dirname(path.dirname(asarPath)));
  const { baseAsarPath, backupPath, backupSource } = resolveCleanBaseForApply(asarPath, resourcesDir);
  const bundle = loadOrCompileBundle(jobSpec);

  const resolvedElectronVersion =
    electronVersion || readElectronVersionFile(resolvedInstallDir, resourcesDir) || null;
  const resolvedAppVersion =
    appVersion ||
    readAsarPackageVersion(baseAsarPath) ||
    readAsarPackageVersion(asarPath) ||
    resolvedElectronVersion ||
    null;

  const hasPreload = hasAsarFile(baseAsarPath, 'dist/preload.js');
  const hasMain = hasAsarFile(baseAsarPath, 'dist/main.js');
  if (!hasPreload && !hasMain) {
    throw new Error(
      '目标 app.asar 中未找到 dist/preload.js 或 dist/main.js，无法注入汉化运行时。'
    );
  }

  const setMap = new Map();
  const rendererSrc = buildRendererRuntimeSource(bundle, bundleFilePath);
  const mainSrc = buildMainRuntimeSource(bundle, bundleFilePath);
  const bundleHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(bundle))
    .digest('hex')
    .slice(0, 16);

  setMap.set(CONSOLE_RUNTIME_PATH, Buffer.from(rendererSrc, 'utf8'));
  setMap.set(CONSOLE_MAIN_PATH, Buffer.from(mainSrc, 'utf8'));

  if (hasPreload) {
    const origPreload = readAsarFile(baseAsarPath, 'dist/preload.js').toString('utf8');
    // Inline full fail-open runtime directly into dist/preload.js so Electron sandbox:true preloads execute it reliably
    const nextPreload = injectMarkerBlock(origPreload, 'PRELOAD_RUNTIME', rendererSrc);
    setMap.set('dist/preload.js', Buffer.from(nextPreload, 'utf8'));
  }

  if (hasMain) {
    const origMain = readAsarFile(baseAsarPath, 'dist/main.js').toString('utf8');
    const nextMain = injectMarkerBlock(origMain, 'MAIN_MENU', buildMainLoaderSnippet());
    setMap.set('dist/main.js', Buffer.from(nextMain, 'utf8'));
  }

  const nowIso = new Date().toISOString();
  const metaObj = {
    engine: 'agy-console-i18n',
    patchVersion: PATCH_VERSION,
    patchedAt: nowIso,
    appVersion: resolvedAppVersion,
    electronVersion: resolvedElectronVersion,
    bundleFilePath: bundleFilePath || '',
    bundleHash,
    menuLocalizationEnabled: bundle?.config?.menuLocalizationEnabled !== false,
    brandMode: bundle?.config?.brandMode || 'original',
    injectedPreload: hasPreload,
    injectedMain: hasMain,
  };
  setMap.set(CONSOLE_META_PATH, Buffer.from(JSON.stringify(metaObj, null, 2) + '\n', 'utf8'));

  const patchInfo = patchAsarStreaming(baseAsarPath, asarPath, { set: setMap });

  const quarantinedBackups = [];
  if (jobSpec.quarantineThirdParty && backupPath && fs.existsSync(backupPath)) {
    try {
      const qDir = path.join(path.dirname(stateFilePath || bundleFilePath || asarPath), 'quarantine');
      ensureDir(qDir);
      const backupsNow = scanBackups(resourcesDir, resolvedAppVersion);
      for (const b of backupsNow) {
        if (b.kind !== 'third_party' || !fs.existsSync(b.path)) continue;
        const dest = path.join(qDir, `${Date.now()}-${b.name}`);
        fs.copyFileSync(b.path, dest);
        fs.unlinkSync(b.path);
        quarantinedBackups.push({ name: b.name, archivedTo: dest });
      }
    } catch {
      // Non-fatal: never fail an already succeeded patch
    }
  }

  if (stateFilePath) {
    ensureDir(path.dirname(stateFilePath));
    atomicWriteJson(stateFilePath, {
      patched: true,
      lastAction: 'apply',
      lastAppliedAt: nowIso,
      patchedAppVersion: resolvedAppVersion,
      appVersion: resolvedAppVersion,
      electronVersion: resolvedElectronVersion,
      installDir: resolvedInstallDir,
      backupPath,
      backupSource,
      quarantinedBackups,
      patchVersion: PATCH_VERSION,
      bundleHash,
    });
  }

  return {
    action: 'apply',
    asarPath,
    backupPath,
    backupSource,
    meta: metaObj,
    patchInfo,
  };
}

function performRestore(jobSpec) {
  const { asarPath, resourcesDir, stateFilePath, installDir } = jobSpec;

  // (a) Anti-downgrade guard: never overwrite an already clean original app.asar (e.g., after official update)
  const markers = inspectAsarMarkers(asarPath);
  if (markers.valid && markers.isCleanOriginal) {
    throw new Error('当前 app.asar 已是干净原版，已阻止还原以防误覆盖降级');
  }

  // (b) Prefer a clean backup whose internal package.json version matches current app.asar package.json version
  const currentAsarVersion = markers.valid ? readAsarPackageVersion(asarPath) : null;
  const backups = scanBackups(resourcesDir, currentAsarVersion);
  const cleanBackups = backups.filter((b) => b.valid && b.isCleanOriginal);
  const matchingCleanBackup =
    cleanBackups.find((b) => b.name === CONSOLE_BACKUP_NAME && b.matchesCurrentVersion) ||
    cleanBackups.find((b) => b.matchesCurrentVersion);
  const hasMismatchedCleanBackup = cleanBackups.length > 0 && !matchingCleanBackup;

  const nowIso = new Date().toISOString();
  let method = 'backup_restore';
  let restoredFrom = null;

  if (matchingCleanBackup) {
    atomicCopyFile(matchingCleanBackup.path, asarPath);
    restoredFrom = matchingCleanBackup.path;
  } else if (markers.valid && markers.hasConsolePatch && !markers.hasThirdPartyPatch) {
    // Fallback: if current app.asar only has our Console patch (no matching backup or only stale backups),
    // strip our markers and injected files in place without risking a version downgrade.
    method = 'marker_strip';
    const setMap = new Map();
    if (hasAsarFile(asarPath, 'dist/preload.js')) {
      const curPreload = readAsarFile(asarPath, 'dist/preload.js').toString('utf8');
      setMap.set('dist/preload.js', Buffer.from(stripMarkerBlock(curPreload, 'PRELOAD_RUNTIME'), 'utf8'));
    }
    if (hasAsarFile(asarPath, 'dist/main.js')) {
      const curMain = readAsarFile(asarPath, 'dist/main.js').toString('utf8');
      setMap.set('dist/main.js', Buffer.from(stripMarkerBlock(curMain, 'MAIN_MENU'), 'utf8'));
    }
    const removeSet = new Set([CONSOLE_RUNTIME_PATH, CONSOLE_MAIN_PATH, CONSOLE_META_PATH]);
    patchAsarStreaming(asarPath, asarPath, { set: setMap, remove: removeSet });
  } else if (hasMismatchedCleanBackup) {
    const foundVersions = cleanBackups
      .map((b) => `${b.name}(${b.appVersion ? `v${b.appVersion}` : '未知版本'})`)
      .join('、');
    throw new Error(
      `已有原版备份版本与当前 app.asar（${currentAsarVersion ? `v${currentAsarVersion}` : '未知版本'}）不匹配（检测到：${foundVersions}），已阻止还原以防误覆盖降级。`
    );
  } else {
    throw new Error(
      '未找到可用的干净原版备份（app.asar.agy-console.bak / app.asar.zh-cn.bak / app.asar.bak），无法还原原版。'
    );
  }

  if (stateFilePath) {
    ensureDir(path.dirname(stateFilePath));
    atomicWriteJson(stateFilePath, {
      patched: false,
      lastAction: 'restore',
      lastRestoredAt: nowIso,
      installDir: installDir || path.dirname(resourcesDir),
      restoredFrom,
      method,
    });
  }

  return {
    action: 'restore',
    asarPath,
    method,
    restoredFrom,
  };
}

/**
 * Execute an apply or restore patch job.
 * When jobSpec.skipProcessControl === true, skips waiting, taskkill/pkill, and relaunch (safe for unit tests).
 */
export async function executePatchJob(jobSpec) {
  if (!jobSpec || typeof jobSpec !== 'object') {
    throw new Error('Invalid patch job specification.');
  }
  const action = jobSpec.action;
  if (action !== 'apply' && action !== 'restore') {
    throw new Error(`Unsupported patch job action: "${action}"`);
  }

  const paths = jobSpec.dataDir ? getDataPaths({ dataDir: jobSpec.dataDir }) : null;
  const resolvedSpec = {
    ...jobSpec,
    jobId: jobSpec.jobId || `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    resourcesDir: jobSpec.resourcesDir || (jobSpec.asarPath ? path.dirname(jobSpec.asarPath) : ''),
    bundleFilePath: jobSpec.bundleFilePath || paths?.i18nBundleFile || '',
    stateFilePath: jobSpec.stateFilePath || paths?.i18nStateFile || '',
    jobFilePath: jobSpec.jobFilePath || paths?.i18nJobFile || '',
    skipProcessControl: Boolean(jobSpec.skipProcessControl),
    relaunch: jobSpec.relaunch !== false,
  };

  if (!resolvedSpec.asarPath) {
    throw new Error('Patch job is missing target asarPath.');
  }

  const startedAt = new Date().toISOString();
  const baseJobRecord = {
    jobId: resolvedSpec.jobId,
    action,
    asarPath: resolvedSpec.asarPath,
    startedAt,
    finishedAt: null,
    error: null,
    details: null,
  };

  updateJobFile(resolvedSpec.jobFilePath, {
    ...baseJobRecord,
    status: 'running',
    phase: 'starting',
    message: action === 'apply' ? '正在启动汉化补丁任务...' : '正在启动原版还原任务...',
  });

  try {
    if (!resolvedSpec.skipProcessControl) {
      updateJobFile(resolvedSpec.jobFilePath, {
        ...baseJobRecord,
        status: 'running',
        phase: 'stopping_app',
        message: '正在关闭 Antigravity 客户端以释放 app.asar 文件锁...',
      });
      const waitMs =
        resolvedSpec.waitBeforeKillMs === undefined
          ? DEFAULT_WAIT_BEFORE_KILL_MS
          : Math.max(0, Number(resolvedSpec.waitBeforeKillMs) || 0);
      if (waitMs > 0) await sleep(waitMs);

      terminateAntigravityProcess(resolvedSpec.exePath);

      updateJobFile(resolvedSpec.jobFilePath, {
        ...baseJobRecord,
        status: 'running',
        phase: 'waiting_unlock',
        message: '正在等待 app.asar 文件锁释放...',
      });
      const unlocked = await waitForFileWritable(
        resolvedSpec.asarPath,
        resolvedSpec.unlockTimeoutMs ?? DEFAULT_UNLOCK_TIMEOUT_MS
      );
      if (!unlocked) {
        throw new Error(
          '等待 Antigravity 释放 app.asar 文件锁超时（12s）。请手动关闭 Antigravity 后重试。'
        );
      }
    }

    updateJobFile(resolvedSpec.jobFilePath, {
      ...baseJobRecord,
      status: 'running',
      phase: action === 'apply' ? 'patching' : 'restoring',
      message: action === 'apply' ? '正在流式写入汉化补丁到 app.asar...' : '正在从纯净备份还原 app.asar...',
    });

    const details =
      action === 'apply' ? performApply(resolvedSpec) : performRestore(resolvedSpec);

    let relaunched = false;
    if (!resolvedSpec.skipProcessControl && resolvedSpec.relaunch && resolvedSpec.exePath) {
      updateJobFile(resolvedSpec.jobFilePath, {
        ...baseJobRecord,
        status: 'running',
        phase: 'relaunching',
        message: '补丁写入完成，正在重新启动 Antigravity...',
        details,
      });
      relaunched = relaunchAntigravityProcess(resolvedSpec.exePath);
    }

    const finalRecord = {
      ...baseJobRecord,
      status: 'succeeded',
      phase: 'done',
      message: action === 'apply' ? '汉化补丁已成功应用' : '已成功还原原版 app.asar',
      finishedAt: new Date().toISOString(),
      details: { ...details, relaunched },
    };
    updateJobFile(resolvedSpec.jobFilePath, finalRecord);

    return { ok: true, ...finalRecord };
  } catch (err) {
    const errorMsg = err?.message || String(err);
    const failedRecord = {
      ...baseJobRecord,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: errorMsg,
    };
    updateJobFile(resolvedSpec.jobFilePath, failedRecord);

    // Best-effort relaunch if we killed Antigravity before failing, so user isn't left stranded
    if (!resolvedSpec.skipProcessControl && resolvedSpec.relaunch && resolvedSpec.exePath) {
      relaunchAntigravityProcess(resolvedSpec.exePath);
    }

    return { ok: false, ...failedRecord };
  }
}

// CLI Entrypoint: node patch-worker.mjs --job <path>
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  (async () => {
    const jobArgIdx = process.argv.indexOf('--job');
    const jobPath = jobArgIdx >= 0 ? process.argv[jobArgIdx + 1] : null;
    if (!jobPath || !fs.existsSync(jobPath)) {
      process.stderr.write('Usage: node patch-worker.mjs --job <job-spec.json>\n');
      process.exit(2);
    }

    let jobSpec;
    try {
      jobSpec = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`Failed to read job spec: ${err.message}\n`);
      process.exit(2);
    }

    const result = await executePatchJob(jobSpec);
    try {
      if (jobSpec.cleanupSpecFile && fs.existsSync(jobPath)) {
        fs.unlinkSync(jobPath);
      }
    } catch {
      // ignore cleanup
    }
    process.exit(result.ok ? 0 : 1);
  })();
}
