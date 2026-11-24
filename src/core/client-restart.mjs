import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectAntigravityInstall } from './i18n/detector.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_WAIT_BEFORE_KILL_MS = 800;
const DEFAULT_EXIT_TIMEOUT_MS = 6000;
const DEFAULT_POST_KILL_WAIT_MS = 400;
const POLL_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExecutableFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function spawnWindowsBreakaway(nodeExe, workerPath, argsList, cwd) {
  const quoteCmd = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const cmdParts = [quoteCmd(nodeExe), '--no-warnings', quoteCmd(workerPath), ...argsList.map(quoteCmd)];
  const cmdLine = cmdParts.join(' ');
  const psEscape = (s) => String(s).replace(/'/g, "''");
  const psScript = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly',
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

function terminateAntigravityProcess(exePath) {
  const platform = process.platform;
  const exeName = exePath ? path.basename(exePath) : platform === 'win32' ? 'Antigravity.exe' : 'Antigravity';
  try {
    if (platform === 'win32') {
      // Never pass /T (tree kill) so detached helper workers are never terminated.
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
    // Process may already be closed or not running
  }
}

function isProcessRunning(exeName) {
  if (!exeName || /["'\r\n]/.test(exeName)) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return String(out || '').toLowerCase().includes(exeName.toLowerCase());
    }
    execFileSync('pgrep', ['-x', exeName], {
      stdio: 'ignore',
      timeout: 4000,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(exeName, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || DEFAULT_EXIT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (!isProcessRunning(exeName)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isProcessRunning(exeName);
}

function relaunchAntigravityProcess(exePath) {
  if (!isExecutableFile(exePath)) return false;
  const cwd = path.dirname(exePath);
  if (process.platform === 'win32') {
    const psEscape = (s) => String(s).replace(/'/g, "''");
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
        // Fallback to next shell or direct spawn
      }
    }
  }
  try {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute the restart sequence (intended to run inside the detached worker process).
 * Never touches app.asar or any i18n state/backup files.
 */
export async function executeRestartWorker(spec = {}) {
  const exePath = typeof spec.exePath === 'string' ? spec.exePath.trim() : '';
  if (!isExecutableFile(exePath)) {
    return {
      ok: false,
      status: 'not_found',
      relaunched: false,
      exePath: null,
      message: '未找到有效的 Antigravity 可执行文件，无法重启。',
    };
  }

  if (spec.skipProcessControl) {
    return {
      ok: true,
      status: 'skipped',
      relaunched: false,
      exePath,
      message: '已跳过进程控制（测试模式）。',
    };
  }

  const waitBeforeKillMs =
    spec.waitBeforeKillMs === undefined
      ? DEFAULT_WAIT_BEFORE_KILL_MS
      : Math.max(0, Number(spec.waitBeforeKillMs) || 0);
  if (waitBeforeKillMs > 0) {
    await sleep(waitBeforeKillMs);
  }

  const exeName = path.basename(exePath);
  terminateAntigravityProcess(exePath);
  await waitForProcessExit(exeName, spec.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);

  const postKillWaitMs =
    spec.postKillWaitMs === undefined
      ? DEFAULT_POST_KILL_WAIT_MS
      : Math.max(0, Number(spec.postKillWaitMs) || 0);
  if (postKillWaitMs > 0) {
    await sleep(postKillWaitMs);
  }

  const relaunched = relaunchAntigravityProcess(exePath);
  return {
    ok: relaunched,
    status: relaunched ? 'relaunched' : 'relaunch_failed',
    relaunched,
    exePath,
    message: relaunched ? 'Antigravity 已重新启动' : '重新启动 Antigravity 失败，请手动启动客户端。',
  };
}

/**
 * Safely trigger a detached Antigravity client restart without touching app.asar.
 * Uses Windows WMI Win32_Process.Create breakaway so the restart worker survives Antigravity.exe exit.
 */
export function restartAntigravity(options = {}) {
  let exePath = null;
  let installDir = typeof options.installDir === 'string' && options.installDir.trim()
    ? options.installDir.trim()
    : null;

  if (typeof options.exePath === 'string' && options.exePath.trim()) {
    const resolvedExe = path.resolve(options.exePath.trim());
    if (isExecutableFile(resolvedExe)) {
      exePath = resolvedExe;
      installDir = installDir || path.dirname(resolvedExe);
    }
  } else {
    const install = detectAntigravityInstall(options);
    installDir = install.installDir || installDir;
    if (install.found && isExecutableFile(install.exePath)) {
      exePath = install.exePath;
    }
  }

  if (!exePath) {
    const msg = '未检测到 Antigravity 客户端可执行文件，请在设置或汉化模块中确认安装路径。';
    return {
      ok: false,
      status: 'not_found',
      queued: false,
      pid: null,
      method: null,
      exePath: null,
      installDir,
      error: msg,
      message: msg,
    };
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run',
      queued: false,
      dryRun: true,
      pid: null,
      method: 'dry_run',
      exePath,
      installDir,
      message: '已校验 Antigravity 客户端路径（dry-run 模式，未触发重启）',
    };
  }

  const spec = {
    exePath,
    waitBeforeKillMs:
      options.waitBeforeKillMs === undefined
        ? DEFAULT_WAIT_BEFORE_KILL_MS
        : Math.max(0, Number(options.waitBeforeKillMs) || 0),
    postKillWaitMs:
      options.postKillWaitMs === undefined
        ? DEFAULT_POST_KILL_WAIT_MS
        : Math.max(0, Number(options.postKillWaitMs) || 0),
    cleanupSpecFile: true,
  };

  if (typeof options.spawnWorker === 'function') {
    const spawned = options.spawnWorker(spec) || {};
    const pid = Number.isFinite(Number(spawned.pid)) ? Number(spawned.pid) : null;
    return {
      ok: true,
      status: 'queued',
      queued: true,
      pid,
      method: spawned.method || 'custom',
      exePath,
      installDir,
      message: '已启动后台重启任务，Antigravity 将在数秒内重新启动',
    };
  }

  const tmpDir = os.tmpdir();
  const specPath = path.join(
    tmpDir,
    `agy-restart-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`
  );
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  let pid = null;
  let method = null;
  if (process.platform === 'win32') {
    const wmi = spawnWindowsBreakaway(process.execPath, __filename, ['--spec', specPath], tmpDir);
    if (wmi) {
      pid = wmi.pid;
      method = wmi.method;
    }
  }

  if (!pid) {
    try {
      const child = spawn(process.execPath, ['--no-warnings', __filename, '--spec', specPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: tmpDir,
      });
      child.unref();
      pid = child.pid || null;
      method = 'spawn:detached';
    } catch (err) {
      try {
        if (fs.existsSync(specPath)) fs.unlinkSync(specPath);
      } catch {
        // ignore cleanup error
      }
      const msg = `启动后台重启进程失败：${err?.message || String(err)}`;
      return {
        ok: false,
        status: 'spawn_failed',
        queued: false,
        pid: null,
        method: null,
        exePath,
        installDir,
        error: msg,
        message: msg,
      };
    }
  }

  return {
    ok: true,
    status: 'queued',
    queued: true,
    pid,
    method,
    exePath,
    installDir,
    message: '已启动后台重启任务，Antigravity 将在数秒内重新启动',
  };
}

// CLI Entrypoint: node client-restart.mjs --spec <spec.json>
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  (async () => {
    const idx = process.argv.indexOf('--spec');
    const specPath = idx >= 0 ? process.argv[idx + 1] : null;
    if (!specPath || !fs.existsSync(specPath)) {
      process.stderr.write('Usage: node client-restart.mjs --spec <spec.json>\n');
      process.exit(2);
    }

    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`Failed to read restart spec: ${err.message}\n`);
      process.exit(2);
    }

    try {
      const result = await executeRestartWorker(spec);
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      try {
        if (spec?.cleanupSpecFile && fs.existsSync(specPath)) {
          fs.unlinkSync(specPath);
        }
      } catch {
        // ignore cleanup error
      }
    }
  })();
}
