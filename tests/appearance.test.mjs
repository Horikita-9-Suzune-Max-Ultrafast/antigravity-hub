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
  compileRuntimeAppearance,
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
    assert.equal(WALLPAPER_PRESETS.length, 0);

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
    const imgPath = path.join(env.folderDir, 'mountain.png');
    saveAppearanceState({ enabled: true, mode: 'image', activeWallpaperPath: imgPath }, env.options);
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
    assert.equal(appRes.config.mode, 'image');
    assert.equal(appRes.config.preset, null);
    assert.equal(appRes.config.activeWallpaperPath, imgPath);

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

test('Lightweight update_config skips full status payload, clamps saturation, and delete cleans theme bindings', () => {
  const env = makeTempEnv();
  try {
    const imp = importWallpaperFromBase64({ fileName: 'night.png', base64: TINY_PNG_B64 }, env.options);

    // Bind dark & light + test lightweight update_config
    const lightRes = handleAppearanceAction(
      {
        action: 'update_config',
        light: true,
        patch: {
          enabled: true,
          mode: 'image',
          separateThemeWallpapers: true,
          darkWallpaperPath: imp.filePath,
          saturation: 199,
          scrimOpacity: 0.35,
        },
      },
      env.options
    );
    assert.equal(lightRes.ok, true);
    assert.equal(lightRes.status, undefined, 'light mode should omit heavy status/library payload');
    assert.equal(lightRes.state.saturation, 160, 'saturation should clamp to max 160');
    assert.equal(lightRes.state.scrimOpacity, 0.35);

    // Deleting a wallpaper bound to dark theme must clear darkWallpaperPath & disable separateThemeWallpapers
    const delRes = handleAppearanceAction({ action: 'delete_wallpaper', id: imp.id }, env.options);
    assert.equal(delRes.ok, true);
    assert.equal(delRes.status.state.darkWallpaperPath, '');
    assert.equal(delRes.status.state.separateThemeWallpapers, false);
  } finally {
    env.cleanup();
  }
});

test('Renderer & main runtime scripts wire real-time appearance push, scrimOpacity, and saturation', () => {
  const env = makeTempEnv();
  try {
    const { i18nBundleFile, i18nDir } = getDataPaths(env.options);
    fs.mkdirSync(i18nDir, { recursive: true });
    fs.writeFileSync(i18nBundleFile, JSON.stringify({ version: 1, ui: {}, menu: {}, patterns: [] }));

    const rendererSrc = buildRendererRuntimeSource(null, i18nBundleFile);
    assert.ok(rendererSrc.includes('agy-hub:appearance-push'), 'renderer must subscribe to real-time push');
    assert.ok(rendererSrc.includes('saturate('), 'renderer must apply saturation filter');
    assert.ok(rendererSrc.includes('linear-gradient(rgba('), 'renderer must apply scrimOpacity overlay');
    assert.doesNotThrow(() => new Function(rendererSrc));

    const mainSrc = buildMainRuntimeSource(null, i18nBundleFile);
    assert.ok(mainSrc.includes('agy-hub:appearance-push'), 'main runtime must broadcast appearance push');
    assert.ok(mainSrc.includes('webContents.getAllWebContents'), 'main runtime must broadcast to WebContentsView via webContents.getAllWebContents');
    assert.doesNotThrow(() => new Function(mainSrc));
  } finally {
    env.cleanup();
  }
});

test('Rotation source filtering, library subset selection, 1-min custom interval, and dual-buffer crossfade', () => {
  const env = makeTempEnv();
  try {
    const lib1 = importWallpaperFromBase64({ fileName: 'alpha.png', base64: TINY_PNG_B64 }, env.options);
    const lib2 = importWallpaperFromBase64({ fileName: 'beta.png', base64: TINY_PNG_B64 }, env.options);

    // Custom 1-minute interval + library-only subset
    const saved = saveAppearanceState(
      {
        enabled: true,
        mode: 'image',
        folderPath: env.folderDir,
        rotationMode: 'interval',
        rotationMinutes: 1,
        rotationSource: 'library',
        rotationLibrarySelection: [lib1.id],
      },
      env.options
    );
    assert.equal(saved.rotationMinutes, 1, 'should allow 1-minute custom interval');
    assert.equal(saved.rotationSource, 'library');

    let status = handleAppearanceAction({ action: 'status' }, env.options);
    assert.equal(status.selectedLibraryCount, 1);
    assert.equal(status.poolCount, 1, 'library-only mode with 1 selected item should yield poolCount=1');

    // Switch to folder-only
    saveAppearanceState({ rotationSource: 'folder' }, env.options);
    status = handleAppearanceAction({ action: 'status' }, env.options);
    assert.equal(status.poolCount, 2, 'folder-only mode should use the 2 folder images');

    // Switch to all (1 selected library + 2 folder = 3)
    saveAppearanceState({ rotationSource: 'all' }, env.options);
    status = handleAppearanceAction({ action: 'status' }, env.options);
    assert.equal(status.poolCount, 3);

    // Deleting lib1 should prune it from rotationLibrarySelection
    const del = handleAppearanceAction({ action: 'delete_wallpaper', id: lib1.id }, env.options);
    assert.deepEqual(del.status.state.rotationLibrarySelection, []);
    assert.equal(del.status.selectedLibraryCount, 0);
    assert.equal(del.status.poolCount, 2);

    // Null selection restores all remaining library items (lib2)
    saveAppearanceState({ rotationLibrarySelection: null, rotationSource: 'library' }, env.options);
    status = handleAppearanceAction({ action: 'status' }, env.options);
    assert.equal(status.selectedLibraryCount, 1);
    assert.equal(status.poolCount, 1);

    // Dual-buffer pre-decoded crossfade in renderer runtime
    const { i18nBundleFile, i18nDir } = getDataPaths(env.options);
    fs.mkdirSync(i18nDir, { recursive: true });
    fs.writeFileSync(i18nBundleFile, JSON.stringify({ version: 1, ui: {}, menu: {}, patterns: [] }));
    const rendererSrc = buildRendererRuntimeSource(null, i18nBundleFile);
    assert.ok(rendererSrc.includes('CROSSFADE_MS = 450'), 'renderer must configure 450ms crossfade');
    assert.ok(rendererSrc.includes('preloadAndDecode'), 'renderer must pre-decode image before crossfade');
    assert.ok(rendererSrc.includes('data-wp-slot'), 'renderer must manage dual A/B wallpaper slots');
    assert.doesNotThrow(() => new Function(rendererSrc));
  } finally {
    env.cleanup();
  }
});

test('Legacy gradient preset configs silently fall back to first local wallpaper or disabled state', () => {
  const env = makeTempEnv();
  try {
    const { appearanceStateFile } = getDataPaths(env.options);
    fs.mkdirSync(path.dirname(appearanceStateFile), { recursive: true });

    // 1. Legacy preset mode with empty library -> silently disables wallpaper
    fs.writeFileSync(
      appearanceStateFile,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'preset',
        presetId: 'aurora-mist',
        activeWallpaperPath: '',
        rotationSource: 'preset',
      }),
      'utf8'
    );
    const loadedEmpty = loadAppearanceState(env.options);
    assert.equal(loadedEmpty.enabled, false);
    assert.equal(loadedEmpty.mode, 'image');
    assert.equal(loadedEmpty.presetId, '');
    assert.equal(loadedEmpty.activeWallpaperPath, '');
    assert.equal(loadedEmpty.rotationSource, 'all');

    const compiledEmpty = compileRuntimeAppearance(env.options, {
      enabled: true,
      mode: 'preset',
      presetId: 'nebula-dusk',
    });
    assert.equal(compiledEmpty.payload.enabled, false);
    assert.equal(compiledEmpty.payload.mode, 'image');
    assert.equal(compiledEmpty.payload.preset, null);
    assert.equal(compiledEmpty.payload.activeWallpaperPath, '');

    // 2. Legacy activeWallpaper / theme bindings pointing to deleted preset IDs with empty library -> disabled
    fs.writeFileSync(
      appearanceStateFile,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'image',
        activeWallpaper: 'minimal-paper',
        separateThemeWallpapers: true,
        darkWallpaperPath: 'aurora-mist',
        lightWallpaperPath: 'preset:nebula-dusk',
      }),
      'utf8'
    );
    const loadedThemeEmpty = loadAppearanceState(env.options);
    assert.equal(loadedThemeEmpty.enabled, false);
    assert.equal(loadedThemeEmpty.separateThemeWallpapers, false);
    assert.equal(loadedThemeEmpty.darkWallpaperPath, '');
    assert.equal(loadedThemeEmpty.lightWallpaperPath, '');
    assert.equal(loadedThemeEmpty.activeWallpaperPath, '');

    // 3. Import local wallpapers -> legacy preset config silently falls back to first local wallpaper
    const lib1 = importWallpaperFromBase64({ fileName: 'first.png', base64: TINY_PNG_B64 }, env.options);
    fs.writeFileSync(
      appearanceStateFile,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'preset',
        presetId: 'aurora-mist',
        activeWallpaperPath: '',
      }),
      'utf8'
    );
    const loadedWithLib = loadAppearanceState(env.options);
    assert.equal(loadedWithLib.enabled, true);
    assert.equal(loadedWithLib.mode, 'image');
    assert.equal(loadedWithLib.presetId, '');
    assert.equal(loadedWithLib.activeWallpaperPath, lib1.filePath);

    const compiledWithLib = compileRuntimeAppearance(env.options);
    assert.equal(compiledWithLib.payload.enabled, true);
    assert.equal(compiledWithLib.payload.preset, null);
    assert.equal(compiledWithLib.payload.activeWallpaperPath, lib1.filePath);

    // 4. Legacy dark/light preset bindings with local library -> fall back to first local wallpaper
    fs.writeFileSync(
      appearanceStateFile,
      JSON.stringify({
        version: 1,
        enabled: true,
        mode: 'image',
        separateThemeWallpapers: true,
        darkWallpaperPath: 'aurora-mist',
        lightWallpaperPath: 'nebula-dusk',
      }),
      'utf8'
    );
    const loadedThemeWithLib = loadAppearanceState(env.options);
    assert.equal(loadedThemeWithLib.enabled, true);
    assert.equal(loadedThemeWithLib.separateThemeWallpapers, true);
    assert.equal(loadedThemeWithLib.darkWallpaperPath, lib1.filePath);
    assert.equal(loadedThemeWithLib.lightWallpaperPath, lib1.filePath);

    // 5. Status reports empty presets list, and deleting last active wallpaper disables cleanly (no preset mode)
    saveAppearanceState({ enabled: true, mode: 'image', activeWallpaperPath: lib1.filePath, separateThemeWallpapers: false, darkWallpaperPath: '', lightWallpaperPath: '' }, env.options);
    const st = handleAppearanceAction({ action: 'status' }, env.options);
    assert.deepEqual(st.presets, []);

    const delLast = handleAppearanceAction({ action: 'delete_wallpaper', id: lib1.id }, env.options);
    assert.equal(delLast.ok, true);
    assert.equal(delLast.status.state.mode, 'image');
    assert.equal(delLast.status.state.activeWallpaperPath, '');
    assert.equal(delLast.status.state.enabled, false);
  } finally {
    env.cleanup();
  }
});
