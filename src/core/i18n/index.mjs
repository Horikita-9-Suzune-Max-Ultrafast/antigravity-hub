import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDataPaths } from '../paths.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { atomicWriteJson, ensureDir } from '../storage.mjs';
import { getI18nStatus as detectI18nStatus } from './detector.mjs';
import {
  compileRuntimeBundle,
  getMergedDictionary,
  listDictionaryEntries,
  upsertCustomEntry,
  deleteCustomEntry,
  importDictionary,
  exportDictionary,
  syncCommunityDictionary,
} from './dictionary.mjs';
import { executePatchJob } from './patch-worker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PATCH_WORKER_PATH = path.join(__dirname, 'patch-worker.mjs');

export { detectI18nStatus as getI18nStatus };

/**
 * Update config.i18n fields, recompile runtime-bundle.json for live hot-reload, and return fresh status.
 */
export function updateI18nConfig(patch = {}, options = {}) {
  const i18nPatch =
    patch && typeof patch === 'object' && patch.i18n && typeof patch.i18n === 'object'
      ? patch.i18n
      : patch && typeof patch === 'object'
        ? patch
        : {};

  const saved = saveConfig({ i18n: i18nPatch }, options);
  const { bundlePath, stats } = compileRuntimeBundle(options);
  const statusInfo = detectI18nStatus(options);

  return {
    ...statusInfo,
    statusInfo,
    config: saved.i18n,
    bundlePath,
    stats,
  };
}

/**
 * Recompile merged 3-layer dictionary + rules into <dataDir>/i18n/runtime-bundle.json.
 */
export function refreshRuntimeBundle(options = {}) {
  const { bundlePath, bundle, stats } = compileRuntimeBundle(options);
  return {
    ok: true,
    bundlePath,
    bundle,
    stats,
    compiledAt: bundle.compiledAt,
  };
}

function spawnWindowsBreakaway(nodeExe, workerPath, specPath, cwd) {
  const quoteCmd = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const cmdLine = `${quoteCmd(nodeExe)} --no-warnings ${quoteCmd(workerPath)} --job ${quoteCmd(specPath)}`;
  const psEscape = (s) => String(s).replace(/'/g, "''");
  const psScript = [
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly",
    `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psEscape(cmdLine)}'; CurrentDirectory = '${psEscape(cwd)}'; ProcessStartupInformation = $si }`,
    'if ($res.ReturnValue -ne 0) { exit ([int]$res.ReturnValue) }',
    'Write-Output $res.ProcessId',
  ].join('; ');

  for (const shell of ['pwsh', 'powershell']) {
    try {
      const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pid = Number(String(out || '').trim().split(/\s+/).pop());
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, method: `wmi:${shell}` };
      }
    } catch {
      // Try next shell or fallback
    }
  }
  return null;
}

function spawnDetachedPatchWorker(jobSpec, paths) {
  ensureDir(paths.i18nDir);
  const specPath = path.join(paths.i18nDir, `job-${jobSpec.jobId}.json`);
  const specPayload = {
    ...jobSpec,
    cleanupSpecFile: true,
  };
  atomicWriteJson(specPath, specPayload);

  const nowIso = new Date().toISOString();
  atomicWriteJson(paths.i18nJobFile, {
    jobId: jobSpec.jobId,
    action: jobSpec.action,
    asarPath: jobSpec.asarPath,
    status: 'queued',
    phase: 'queued',
    message:
      jobSpec.action === 'apply'
        ? '已启动后台汉化进程，即将重启 Antigravity 写入补丁...'
        : '已启动后台还原进程，即将重启 Antigravity 恢复原版...',
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
    error: null,
    details: null,
  });

  let pid = null;
  if (process.platform === 'win32') {
    // Launch via WMI Win32_Process.Create so the worker runs completely outside Antigravity's
    // process tree and Windows Job Object (surviving Antigravity.exe termination).
    const wmi = spawnWindowsBreakaway(process.execPath, PATCH_WORKER_PATH, specPath, paths.i18nDir);
    if (wmi) {
      pid = wmi.pid;
    }
  }

  if (!pid) {
    const child = spawn(process.execPath, ['--no-warnings', PATCH_WORKER_PATH, '--job', specPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: paths.i18nDir,
    });
    child.unref();
    pid = child.pid || null;
  }

  return {
    ok: true,
    queued: true,
    jobId: jobSpec.jobId,
    action: jobSpec.action,
    pid,
    message:
      jobSpec.action === 'apply'
        ? '已启动后台汉化任务，Antigravity 将在约 3~5 秒内短暂重启生效'
        : '已启动后台还原任务，Antigravity 将在约 3~5 秒内短暂重启恢复原版',
  };
}

/**
 * Compile latest runtime bundle and trigger detached (or synchronous when skipProcessControl/sync) apply patch job.
 */
export async function triggerApplyPatch(params = {}, options = {}) {
  const paths = getDataPaths(options);
  const { bundlePath } = compileRuntimeBundle(options);
  const statusInfo = detectI18nStatus(options);

  if (statusInfo.status === 'not_found' || !statusInfo.asarPath) {
    throw new Error('未检测到 Antigravity 客户端安装目录，请先手动指定包含 resources/app.asar 的安装路径。');
  }

  if (statusInfo.status === 'patched_by_other' && !statusInfo.hasCleanBackup) {
    throw new Error(
      '检测到第三方汉化补丁，但未找到干净的原版 app.asar 备份，无法安全覆盖。请先还原原版或重新安装 Antigravity。'
    );
  }

  const jobId = `apply_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const jobSpec = {
    jobId,
    action: 'apply',
    dataDir: paths.dataDir,
    installDir: statusInfo.installDir,
    resourcesDir: statusInfo.resourcesDir,
    asarPath: statusInfo.asarPath,
    exePath: statusInfo.exePath,
    appVersion: statusInfo.appVersion,
    bundleFilePath: bundlePath,
    stateFilePath: paths.i18nStateFile,
    jobFilePath: paths.i18nJobFile,
    skipProcessControl: Boolean(params.skipProcessControl),
    relaunch: params.relaunch !== false,
  };

  if (params.sync === true || params.skipProcessControl === true) {
    return executePatchJob(jobSpec);
  }

  return spawnDetachedPatchWorker(jobSpec, paths);
}

/**
 * Trigger detached (or synchronous when skipProcessControl/sync) restore patch job.
 */
export async function triggerRestorePatch(params = {}, options = {}) {
  const paths = getDataPaths(options);
  const statusInfo = detectI18nStatus(options);

  if (statusInfo.status === 'not_found' || !statusInfo.asarPath) {
    throw new Error('未检测到 Antigravity 客户端安装目录，无法执行还原。');
  }

  if (!statusInfo.hasCleanBackup && statusInfo.status !== 'patched_by_console') {
    throw new Error('未找到可用的干净原版 app.asar 备份，无法还原原版。');
  }

  const jobId = `restore_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const jobSpec = {
    jobId,
    action: 'restore',
    dataDir: paths.dataDir,
    installDir: statusInfo.installDir,
    resourcesDir: statusInfo.resourcesDir,
    asarPath: statusInfo.asarPath,
    exePath: statusInfo.exePath,
    appVersion: statusInfo.appVersion,
    bundleFilePath: paths.i18nBundleFile,
    stateFilePath: paths.i18nStateFile,
    jobFilePath: paths.i18nJobFile,
    skipProcessControl: Boolean(params.skipProcessControl),
    relaunch: params.relaunch !== false,
  };

  if (params.sync === true || params.skipProcessControl === true) {
    return executePatchJob(jobSpec);
  }

  return spawnDetachedPatchWorker(jobSpec, paths);
}

/**
 * Unified dispatcher for the private MCP tool `app_i18n_manage`.
 */
export async function handleI18nAction(args = {}, options = {}) {
  const action = String(args?.action || '').trim();
  if (!action) {
    throw new Error('Missing required "action" parameter for app_i18n_manage.');
  }

  switch (action) {
    case 'status':
      return detectI18nStatus(options);

    case 'update_config': {
      let patch = args.patch ?? args.config;
      if (!patch || typeof patch !== 'object') {
        const rest = { ...args };
        delete rest.action;
        patch = rest;
      }
      return updateI18nConfig(patch, options);
    }

    case 'refresh_bundle':
      return refreshRuntimeBundle(options);

    case 'list_dict':
      return listDictionaryEntries(
        {
          query: args.query ?? '',
          source: args.source ?? 'all',
          scope: args.scope ?? 'all',
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 50,
        },
        options
      );

    case 'upsert_entry':
      return upsertCustomEntry(
        {
          en: args.en,
          zh: args.zh,
          scope: args.scope ?? 'ui',
          disabled: Boolean(args.disabled),
        },
        options
      );

    case 'delete_entry':
      return deleteCustomEntry(
        {
          en: args.en,
          scope: args.scope ?? 'ui',
        },
        options
      );

    case 'import_dict':
      return importDictionary(
        {
          rawJson: args.rawJson ?? args.data ?? args.json,
          target: args.target ?? 'community',
          mergeMode: args.mergeMode ?? 'merge',
        },
        options
      );

    case 'export_dict':
      return exportDictionary(
        {
          scope: args.scope ?? 'all',
        },
        options
      );

    case 'sync_community': {
      const url =
        typeof args.url === 'string' && args.url.trim()
          ? args.url.trim()
          : loadConfig(options).i18n?.communitySourceUrl || '';
      return syncCommunityDictionary({ url }, options);
    }

    case 'apply_patch':
      return triggerApplyPatch(args, options);

    case 'restore_patch':
      return triggerRestorePatch(args, options);

    default:
      throw new Error(`Unsupported app_i18n_manage action: "${action}"`);
  }
}

export { getMergedDictionary, compileRuntimeBundle };
