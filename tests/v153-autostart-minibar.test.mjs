import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_CONFIG,
  VALID_MINI_BAR_MODULES,
  sanitizeConfig,
  saveConfig,
} from '../src/core/config.mjs';
import { maybeAutoLaunchPopoutOnStartup } from '../src/mcp/server.mjs';
import {
  ensureCompiledWinHostExe,
  extractHostCSharpSource,
  findWindowsCscCompiler,
} from '../src/core/popout-server.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('v1.5.3 config defaults & sanitization for startup popout, mini bar, and Gemini KV cache', () => {
  const def = sanitizeConfig({});
  assert.equal(def.popout.autoLaunchOnStartup, true);
  assert.equal(def.popout.miniBarPreset, 'standard');
  assert.deepEqual(def.popout.miniBarModules, VALID_MINI_BAR_MODULES);
  assert.equal(def.popout.miniBarCustomWidth, null);
  assert.equal(def.kvCache.enabled, true);
  assert.equal(def.kvCache.ttlMinutes, 15);

  const custom = sanitizeConfig({
    popout: {
      autoLaunchOnStartup: false,
      miniBarPreset: 'invalid_preset',
      miniBarModules: ['model', 'tps', 'model', 'bogus'],
      miniBarCustomWidth: 380,
    },
    kvCache: {
      enabled: false,
      ttlMinutes: 999,
    },
  });
  assert.equal(custom.popout.autoLaunchOnStartup, false);
  assert.equal(custom.popout.miniBarPreset, 'standard');
  assert.deepEqual(custom.popout.miniBarModules, ['model', 'tps', 'context', 'cache', 'kv']);
  assert.equal(custom.popout.miniBarCustomWidth, 380);
  assert.equal(custom.kvCache.enabled, false);
  assert.equal(custom.kvCache.ttlMinutes, 60);
  assert.equal(DEFAULT_CONFIG.popout.autoLaunchOnStartup, true);
});

test('v1.5.3 startup auto-popout launches once per host ppid and respects opt-out / env guard', async () => {
  const dataDir = makeTempDir('ctx-autostart-');
  let launches = 0;
  const fakePopout = {
    hasActiveClient: () => false,
    launchWindow: async (opts) => {
      launches += 1;
      return { running: true, launched: true, ...opts };
    },
  };

  try {
    // Env guard blocks auto-launch
    const blocked = await maybeAutoLaunchPopoutOnStartup({
      popout: fakePopout,
      options: { dataDir, enableStartupAutoPopout: true },
      ppid: 11111,
      env: { CONTEXT_CACHE_DISABLE_AUTOSTART: '1' },
    });
    assert.equal(blocked.launched, false);
    assert.equal(blocked.reason, 'disabled_by_env');

    // First launch for host ppid 11111 succeeds
    const first = await maybeAutoLaunchPopoutOnStartup({
      popout: fakePopout,
      options: { dataDir, enableStartupAutoPopout: true },
      ppid: 11111,
      env: {},
    });
    assert.equal(first.launched, true);
    assert.equal(launches, 1);

    // Second launch for same host ppid 11111 is deduplicated
    const dup = await maybeAutoLaunchPopoutOnStartup({
      popout: fakePopout,
      options: { dataDir, enableStartupAutoPopout: true },
      ppid: 11111,
      env: {},
    });
    assert.equal(dup.launched, false);
    assert.equal(dup.reason, 'already_launched_for_host_pid');
    assert.equal(launches, 1);

    // New host ppid 22222 (after Antigravity restart) launches again
    const nextRun = await maybeAutoLaunchPopoutOnStartup({
      popout: fakePopout,
      options: { dataDir, enableStartupAutoPopout: true },
      ppid: 22222,
      env: {},
    });
    assert.equal(nextRun.launched, true);
    assert.equal(launches, 2);

    // User opt-out in config skips launch
    saveConfig({ popout: { autoLaunchOnStartup: false } }, { dataDir });
    const optedOut = await maybeAutoLaunchPopoutOnStartup({
      popout: fakePopout,
      options: { dataDir, enableStartupAutoPopout: true },
      ppid: 33333,
      env: {},
    });
    assert.equal(optedOut.launched, false);
    assert.equal(optedOut.reason, 'disabled_in_config');
    assert.equal(launches, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('v1.6.0 win-floating-host.ps1 implements native 60-240Hz DWM interaction, tri-state Orb geometry, and CLI Main entry', () => {
  const hostScriptPath = path.resolve('src/core/win-floating-host.ps1');
  const hostSrc = fs.readFileSync(hostScriptPath, 'utf8');
  const popoutSrc = fs.readFileSync(path.resolve('src/core/popout-server.mjs'), 'utf8');

  // Must not contain literal middle-dot (\u00b7)
  assert.equal(hostSrc.includes('\u00b7'), false, 'win-floating-host.ps1 must not contain middle-dot character');
  assert.equal(popoutSrc.includes('\u00b7'), false, 'popout-server.mjs must not contain middle-dot character');

  // Legacy polling timer & 16ms frame-drop throttle must be completely removed
  assert.equal(hostSrc.includes('_interactTimer'), false, '_interactTimer must be removed');
  assert.equal(hostSrc.includes('OnInteractTick'), false, 'OnInteractTick must be removed');
  assert.equal(hostSrc.includes('RESIZE_BOUNDS_MIN_INTERVAL_MS'), false, '16ms resize throttle must be removed');

  // Native Win32 DWM & cross-thread capture release
  for (const token of [
    'BeginNativeNcInteraction',
    'WindowFromPoint',
    'AttachThreadInput',
    'WM_CANCELMODE',
    'WM_NCLBUTTONDOWN',
    'MakePointsLParam',
    'ICoreWebView2Controller2',
    'put_DefaultBackgroundColor',
    'WM_GETMINMAXINFO',
    'WM_DPICHANGED',
    'WM_ENTERSIZEMOVE',
    'WM_EXITSIZEMOVE',
    'host:sizemove',
    'host:state',
    'host:dpi',
    'host:action',
  ]) {
    assert.ok(hostSrc.includes(token), `win-floating-host.ps1 missing native DWM primitive: ${token}`);
  }

  // Tri-state geometry & 48px Orb state machine (never FormWindowState.Minimized)
  assert.equal(hostSrc.includes('FormWindowState.Minimized'), false, 'must never enter FormWindowState.Minimized');
  assert.ok(hostSrc.includes('cp.Style &= ~WS_MINIMIZEBOX'), 'CreateParams must strip WS_MINIMIZEBOX');
  for (const token of [
    'enum WindowMode',
    '_sharedWidth',
    'CreateEllipticRgn',
    'SetWindowRgn',
    'DWMWCP_DONOTROUND',
    'mode:console',
    'mode:minibar',
    'mode:orb',
    'setwidth:',
    'orb:menu',
    'orb:tip:',
    'ContextMenuStrip',
    'ToolTip',
    'MIN_SHARED_LOGICAL_WIDTH = 360',
    'ORB_LOGICAL_PX = 48',
  ]) {
    assert.ok(hostSrc.includes(token), `win-floating-host.ps1 missing tri-state/Orb contract: ${token}`);
  }

  // Standalone CLI entry point for compiled .exe
  const csharp = extractHostCSharpSource(hostScriptPath);
  assert.ok(csharp && csharp.length > 5000, 'extractHostCSharpSource must extract embedded C# block');
  assert.ok(csharp.includes('[STAThread]'), 'Main must carry [STAThread] for WinForms/WebView2 COM');
  assert.ok(csharp.includes('public static int Main(string[] args)'), 'Main(string[] args) entry point required');
  for (const flag of ['"Url"', '"Width"', '"Height"', '"PosX"', '"PosY"', '"TopMost"', '"Theme"', '"UserDataDir"']) {
    assert.ok(csharp.includes(flag), `CLI parser must support ${flag}`);
  }
});

test('v1.6.0 ensureCompiledWinHostExe compiles cached .exe, hits cache <5ms, cleans stale hashes, and respects env fallback', () => {
  const dataDir = makeTempDir('ctx-host-cache-');
  const failDataDir = makeTempDir('ctx-host-failopen-');
  try {
    // 1. CONTEXT_CACHE_NO_COMPILED_HOST=1 disables compilation cleanly
    const disabledExe = ensureCompiledWinHostExe({
      dataDir,
      env: { ...process.env, CONTEXT_CACHE_NO_COMPILED_HOST: '1' },
    });
    assert.equal(disabledExe, null);

    // 2. Fail-Open when compiler path is missing or invalid
    const missingCsc = ensureCompiledWinHostExe({
      dataDir: failDataDir,
      cscPath: path.join(failDataDir, 'nonexistent-csc.exe'),
    });
    assert.equal(missingCsc, null);

    if (process.platform !== 'win32') {
      return;
    }

    // 3. Explicit .NET Framework 4 csc.exe discovery on Windows
    const cscExe = findWindowsCscCompiler();
    assert.ok(cscExe && fs.existsSync(cscExe), 'Windows must locate built-in .NET Framework 4 csc.exe');

    // Pre-seed a stale old-hash binary to verify automatic cleanup
    const cacheDir = path.join(dataDir, 'runtime', 'host-bin');
    fs.mkdirSync(cacheDir, { recursive: true });
    const staleExe = path.join(cacheDir, 'floating-host-000000000000.exe');
    fs.writeFileSync(staleExe, Buffer.alloc(8192, 0x41));
    assert.equal(fs.existsSync(staleExe), true);

    // 4. First-run compilation produces floating-host-<hash12>.exe and cleans old hash
    const compiledExe = ensureCompiledWinHostExe({ dataDir });
    assert.ok(compiledExe, 'ensureCompiledWinHostExe must succeed on Windows');
    assert.match(path.basename(compiledExe), /^floating-host-[0-9a-f]{12}\.exe$/);
    assert.equal(path.dirname(compiledExe), cacheDir);
    assert.equal(fs.existsSync(compiledExe), true);
    assert.ok(fs.statSync(compiledExe).size > 4096, 'compiled .exe must exceed 4096 bytes');
    assert.equal(fs.existsSync(staleExe), false, 'stale hash .exe must be automatically cleaned up');

    // 5. Verify compiled .exe executes cleanly and preserves stderr/exit code pipeline
    const probe = spawnSync(compiledExe, [], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    assert.equal(probe.status, 1);
    assert.match(probe.stderr || '', /HOST_ERR:Missing required -Url/);

    // 6. Second call hits cache in <5ms
    const t0 = performance.now();
    const cachedExe = ensureCompiledWinHostExe({ dataDir });
    const elapsedMs = performance.now() - t0;
    assert.equal(cachedExe, compiledExe);
    assert.ok(elapsedMs < 5, `cache hit expected <5ms, got ${elapsedMs.toFixed(2)}ms`);

    // 7. Cache hit path also cleans newly planted stale hash files
    const staleExe2 = path.join(cacheDir, 'floating-host-deadbeef1234.exe');
    fs.writeFileSync(staleExe2, Buffer.alloc(8192, 0x42));
    const cachedExe2 = ensureCompiledWinHostExe({ dataDir });
    assert.equal(cachedExe2, compiledExe);
    assert.equal(fs.existsSync(staleExe2), false, 'stale hash .exe must be removed on cache hit too');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(failDataDir, { recursive: true, force: true });
  }
});
