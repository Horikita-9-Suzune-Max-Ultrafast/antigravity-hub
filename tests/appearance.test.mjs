import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAX_WALLPAPER_BYTES,
  WALLPAPER_PRESETS,
  importWallpaperFromBase64,
  deleteLibraryWallpaper,
  scanLocalFolderReadOnly,
  saveAppearanceState,
  loadAppearanceState,
  pickNextWallpaper,
  emergencyDisableWallpaper,
  handleAppearanceAction,
} from '../src/core/appearance/index.mjs';
import { buildRendererRuntimeSource, buildMainRuntimeSource } from '../src/core/i18n/payload-templates.mjs';
import { getDataPaths } from '../src/core/paths.mjs';

// Minimal 1x1 transparent PNG base64
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhub-wp-test-'));
  const dataDir = path.join(root, 'data');
  const folderDir = path.join(root, 'user-wallpapers');
  fs.mkdirSync(folderDir, { recursive: true });
  fs.writeFileSync(path.join(folderDir, 'mountain.png'), Buffer.from(TINY_PNG_B64, 'base64'));
  fs.writeFileSync(path.join(folderDir, 'ocean.webp'), Buffer.from(TINY_PNG_B64, 'base64'));
  fs.writeFileSync(path.join(folderDir, 'video-ignored.mp4'), Buffer.from('fake-mp4'));
  return {
    root,
    folderDir,
    options: { dataDir },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Wallpaper library enforces format whitelist, 15 MiB circuit breaker, and safe deletion bounds', () => {
  const env = makeTempEnv();
  try {
    assert.equal(WALLPAPER_PRESETS.length, 3);

    // Reject video/unsupported format
    assert.throws(
      () => importWallpaperFromBase64({ fileName: 'clip.mp4', base64: TINY_PNG_B64 }, env.options),
      /仅支持静态图片/
    );

    // Reject > 15 MiB image
    const hugeBuf = Buffer.alloc(MAX_WALLPAPER_BYTES + 16, 1);
    assert.throws(
      () => importWallpaperFromBase64({ fileName: 'huge.png', base64: hugeBuf.toString('base64') }, env.options),
      /15 MiB/
    );

    // Valid import
    const imported = importWallpaperFromBase64({ fileName: 'desk.png', base64: TINY_PNG_B64 }, env.options);
    assert.ok(fs.existsSync(imported.filePath));

    // Path traversal deletion MUST be rejected
    assert.throws(() => deleteLibraryWallpaper('../escape.png', env.options), /非法/);

    // Valid deletion inside library
    const del = deleteLibraryWallpaper(imported.id, env.options);
    assert.equal(del.ok, true);
    assert.equal(fs.existsSync(imported.filePath), false);
  } finally {
    env.cleanup();
  }
});

test('Read-only local folder scan, rotation, runtime JSON compile, and CLI emergency off', () => {
  const env = makeTempEnv();
  try {
    const beforeFiles = fs.readdirSync(env.folderDir).sort();
    const scan = scanLocalFolderReadOnly(env.folderDir);
    assert.equal(scan.ok, true);
    assert.equal(scan.items.length, 2, 'should include png & webp and ignore mp4');
    assert.deepEqual(fs.readdirSync(env.folderDir).sort(), beforeFiles, 'user folder must remain strictly untouched');

    // Bind folder & pick next wallpaper
    saveAppearanceState({ enabled: true, mode: 'image', folderPath: env.folderDir, rotationMode: 'interval', rotationMinutes: 15 }, env.options);
    const picked1 = pickNextWallpaper(env.options);
    assert.equal(picked1.ok, true);
    const picked2 = pickNextWallpaper(env.options);
    assert.notEqual(picked2.chosen.filePath, picked1.chosen.filePath, 'rotation should pick a distinct wallpaper');

    // Verify runtime-appearance.json compiled cleanly
    const { appearanceRuntimeFile } = getDataPaths(env.options);
    const runtimeJson = JSON.parse(fs.readFileSync(appearanceRuntimeFile, 'utf8'));
    assert.equal(runtimeJson.enabled, true);
    assert.equal(runtimeJson.poolPaths.length, 2);

    // CLI emergency off escape hatch
    const cliPath = path.resolve('bin', 'ctx.mjs');
    const out = execFileSync(
      process.execPath,
      ['--no-warnings', cliPath, 'wallpaper', 'off', '--data-dir', env.options.dataDir, '--json'],
      { encoding: 'utf8' }
    );
    const res = JSON.parse(out);
    assert.equal(res.ok, true);
    assert.equal(loadAppearanceState(env.options).enabled, false);

    // Action dispatcher smoke check
    const st = handleAppearanceAction({ action: 'status' }, env.options);
    assert.equal(st.state.enabled, false);
    const em = emergencyDisableWallpaper(env.options);
    assert.equal(em.ok, true);
  } finally {
    env.cleanup();
  }
});

test('Extended fail-open renderer & main runtime scripts execute IPC handlers cleanly', () => {
  const env = makeTempEnv();
  try {
    saveAppearanceState({ enabled: true, mode: 'preset', presetId: 'aurora-mist' }, env.options);
    const { i18nBundleFile, i18nDir } = getDataPaths(env.options);
    fs.mkdirSync(i18nDir, { recursive: true });
    fs.writeFileSync(i18nBundleFile, JSON.stringify({ version: 1, ui: { Hello: '你好' }, menu: {}, patterns: [] }));

    const rendererSrc = buildRendererRuntimeSource(null, i18nBundleFile);
    assert.ok(rendererSrc.includes('__AGY_HUB_APPEARANCE_LOADED__'));
    assert.doesNotThrow(() => new Function(rendererSrc), 'renderer runtime with appearance engine must parse cleanly');

    const mainSrc = buildMainRuntimeSource(null, i18nBundleFile);
    const handlers = new Map();
    const mockRequire = (mod) => {
      if (mod === 'fs') return fs;
      if (mod === 'path') return path;
      if (mod === 'electron') {
        return {
          ipcMain: {
            handle(channel, fn) {
              handlers.set(channel, fn);
            },
          },
          Menu: { buildFromTemplate: (t) => t },
        };
      }
      throw new Error(`unexpected require: ${mod}`);
    };

    delete globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__;
    new Function('require', mainSrc)(mockRequire);
    delete globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__;

    const bundleRes = handlers.get('agy-hub:get-i18n-bundle')(null, -1);
    assert.equal(bundleRes.changed, true);
    assert.equal(bundleRes.bundle.ui.Hello, '你好');

    const appRes = handlers.get('agy-hub:get-appearance')(null, -1);
    assert.equal(appRes.changed, true);
    assert.equal(appRes.config.enabled, true);
    assert.equal(appRes.config.preset.id, 'aurora-mist');

    const imgPath = path.join(env.folderDir, 'mountain.png');
    const imgRes = handlers.get('agy-hub:read-wallpaper')(null, imgPath);
    assert.equal(imgRes.ok, true);
    assert.equal(imgRes.mime, 'image/png');
    assert.ok(imgRes.base64.length > 10);

    const recRes = handlers.get('agy-hub:record-untranslated')(null, ['Sample Untranslated UI']);
    assert.equal(recRes.ok, true);
    assert.equal(recRes.added, 1);
  } finally {
    env.cleanup();
  }
});
