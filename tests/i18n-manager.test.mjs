import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getMergedDictionary,
  listDictionaryEntries,
  upsertCustomEntry,
  importDictionary,
  exportDictionary,
  compileRuntimeBundle,
  saveCommunityDictionary,
} from '../src/core/i18n/dictionary.mjs';
import { getI18nStatus } from '../src/core/i18n/detector.mjs';
import { executePatchJob } from '../src/core/i18n/patch-worker.mjs';
import { buildAsarFromMap, hasAsarFile, readAsarFile } from '../src/core/i18n/asar.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSyntheticAsar(asarPath, { versionLabel = '1.0.0', extraFiles = {} } = {}) {
  buildAsarFromMap(asarPath, {
    'dist/preload.js': `/* preload ${versionLabel} */\nconsole.log("preload");\n`,
    'dist/main.js': `/* main ${versionLabel} */\nconsole.log("main");\n`,
    'package.json': JSON.stringify({ name: 'antigravity', version: versionLabel }),
    ...extraFiles,
  });
}

test('3-layer dictionary precedence, disabled exclusion, pagination, import/export, and compileRuntimeBundle', () => {
  const root = makeTmpDir('cc-i18n-dict-');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const opts = { dataDir };

  try {
    // 1. Seed community layer overriding a builtin key (or adding a new one)
    saveCommunityDictionary(
      {
        ui: {
          Settings: '社区设置',
          'Community Only': '仅社区词条',
          'Disabled By Custom': '将被禁用',
        },
        menu: {
          File: '社区文件',
        },
      },
      opts
    );

    // 2. Custom layer overrides community & builtin, and disables one entry
    upsertCustomEntry({ en: 'Settings', zh: '自定义设置', scope: 'ui', disabled: false }, opts);
    upsertCustomEntry({ en: 'Disabled By Custom', zh: '不应出现', scope: 'ui', disabled: true }, opts);
    upsertCustomEntry({ en: 'Custom Only', zh: '仅自定义', scope: 'menu', disabled: false }, opts);

    const merged = getMergedDictionary(opts);
    assert.equal(merged.ui.Settings, '自定义设置', 'custom > community > builtin');
    assert.equal(merged.ui['Community Only'], '仅社区词条');
    assert.equal(merged.menu.File, '社区文件');
    assert.equal(merged.menu['Custom Only'], '仅自定义');
    assert.equal('Disabled By Custom' in merged.ui, false, 'disabled entry must be excluded from merged dict');

    // 3. Search & pagination
    const page1 = listDictionaryEntries({ query: '自定义', source: 'custom', scope: 'all', page: 1, pageSize: 1 }, opts);
    assert.equal(page1.items.length, 1);
    assert.ok(page1.total >= 2);

    // 4. Flat & grouped JSON export/import
    const flatExport = exportDictionary({ scope: 'ui' }, opts);
    assert.equal(flatExport.ui.Settings, '自定义设置');

    const groupedExport = exportDictionary({ format: 'grouped' }, opts);
    assert.ok(groupedExport.ui && groupedExport.menu);

    const importFlatRes = importDictionary(
      { rawJson: { 'Imported Flat': '导入扁平' }, target: 'custom', mergeMode: 'merge' },
      opts
    );
    assert.ok(importFlatRes && importFlatRes.stats);

    const importGroupedRes = importDictionary(
      {
        rawJson: { ui: { 'Imported Grouped UI': '导入分组UI' }, menu: { 'Imported Grouped Menu': '导入分组菜单' } },
        target: 'custom',
        mergeMode: 'merge',
      },
      opts
    );
    assert.ok(importGroupedRes && importGroupedRes.stats);

    // 5. compileRuntimeBundle
    const compiled = compileRuntimeBundle(opts);
    const bundle = compiled.bundle || compiled;
    assert.ok(bundle.ui && bundle.menu);
    assert.equal(bundle.ui.Settings, '自定义设置');
    assert.equal(bundle.ui['Imported Flat'], '导入扁平');
    assert.equal(bundle.menu['Imported Grouped Menu'], '导入分组菜单');
    assert.equal('Disabled By Custom' in bundle.ui, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('4-state detector and executePatchJob apply/restore/update/third-party-base lifecycle', async () => {
  const root = makeTmpDir('cc-i18n-patch-');
  const dataDir = path.join(root, 'data');
  const installDir = path.join(root, 'Antigravity');
  const resourcesDir = path.join(installDir, 'resources');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const versionFile = path.join(installDir, 'version');
  const appAsar = path.join(resourcesDir, 'app.asar');
  const consoleBak = path.join(resourcesDir, 'app.asar.agy-console.bak');

  try {
    // State 1: unpatched -> apply -> patched_by_console -> restore -> unpatched
    fs.writeFileSync(versionFile, '1.2.3\n', 'utf8');
    makeSyntheticAsar(appAsar, { versionLabel: '1.2.3' });

    const stUnpatched = getI18nStatus({ installDir, dataDir });
    assert.equal(stUnpatched.status, 'unpatched');

    const applyRes = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath: appAsar,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(applyRes.ok, true);
    assert.equal(fs.existsSync(consoleBak), true, 'must create clean app.asar.agy-console.bak');
    assert.equal(hasAsarFile(consoleBak, 'dist/agy-console-i18n.meta.json'), false, 'backup must be clean');

    const stPatched = getI18nStatus({ installDir, dataDir });
    assert.equal(stPatched.status, 'patched_by_console');

    const restoreRes = await executePatchJob({
      action: 'restore',
      installDir,
      resourcesDir,
      asarPath: appAsar,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(restoreRes.ok, true);

    const stRestored = getI18nStatus({ installDir, dataDir });
    assert.equal(stRestored.status, 'unpatched');

    // State 2: patched_by_console + overwrite app.asar with new clean ASAR -> outdated_after_update
    await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath: appAsar,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    fs.writeFileSync(versionFile, '1.2.4\n', 'utf8');
    makeSyntheticAsar(appAsar, { versionLabel: '1.2.4' });

    const stOutdated = getI18nStatus({ installDir, dataDir });
    assert.equal(stOutdated.status, 'outdated_after_update');

    // State 3: patched_by_other (synthetic dist/zh-cn-meta.json + clean app.asar.zh-cn.bak)
    if (fs.existsSync(consoleBak)) fs.unlinkSync(consoleBak);
    const zhCnBak = path.join(resourcesDir, 'app.asar.zh-cn.bak');
    makeSyntheticAsar(zhCnBak, { versionLabel: '1.2.4-clean' });
    makeSyntheticAsar(appAsar, {
      versionLabel: '1.2.4-third-party',
      extraFiles: {
        'dist/zh-cn-meta.json': JSON.stringify({ patchedBy: 'zh-cn' }),
      },
    });

    const stOther = getI18nStatus({ installDir, dataDir });
    assert.equal(stOther.status, 'patched_by_other');

    const applyOverOther = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath: appAsar,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(applyOverOther.ok, true);
    assert.equal(hasAsarFile(appAsar, 'dist/zh-cn-meta.json'), false, 'must build from clean zh-cn.bak, not third-party app.asar');
    assert.equal(
      JSON.parse(readAsarFile(appAsar, 'package.json').toString('utf8')).version,
      '1.2.4-clean',
      'must use clean app.asar.zh-cn.bak as base'
    );
    assert.equal(hasAsarFile(consoleBak, 'dist/zh-cn-meta.json'), false, 'must NEVER back up third-party patched app.asar as clean original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
