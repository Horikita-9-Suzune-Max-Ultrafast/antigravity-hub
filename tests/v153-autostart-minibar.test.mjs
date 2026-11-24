import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  VALID_MINI_BAR_MODULES,
  sanitizeConfig,
  saveConfig,
} from '../src/core/config.mjs';
import { maybeAutoLaunchPopoutOnStartup } from '../src/mcp/server.mjs';

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
