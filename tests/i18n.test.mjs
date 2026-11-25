import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSOLE_META_PATH,
  detectAntigravityInstall,
  getI18nStatus,
  scanBackups,
  inspectAsarMarkers,
} from '../src/core/i18n/detector.mjs';
import { executePatchJob } from '../src/core/i18n/patch-worker.mjs';
import { buildAsarFromMap, hasAsarFile, readAsarFile } from '../src/core/i18n/asar.mjs';
import { createI18nModule } from '../src/ui/modules/i18n-module.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSyntheticAsar(asarPath, { version = '2.35.1', includePackageJson = true, extraFiles = {} } = {}) {
  const files = {
    'dist/preload.js': `/* preload ${version ?? 'no-pkg'} */\nconsole.log("preload");\n`,
    'dist/main.js': `/* main ${version ?? 'no-pkg'} */\nconsole.log("main");\n`,
    ...extraFiles,
  };
  if (includePackageJson) {
    files['package.json'] = JSON.stringify({ name: 'antigravity', version });
  }
  buildAsarFromMap(asarPath, files);
}

function createFakeInstall(root, { appVersion = '2.35.1', electronVersion = '34.2.0', includePackageJson = true } = {}) {
  const dataDir = path.join(root, 'data');
  const installDir = path.join(root, 'Antigravity');
  const resourcesDir = path.join(installDir, 'resources');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const versionFile = path.join(installDir, 'version');
  if (electronVersion != null) {
    fs.writeFileSync(versionFile, `${electronVersion}\n`, 'utf8');
  }
  const asarPath = path.join(resourcesDir, 'app.asar');
  makeSyntheticAsar(asarPath, { version: appVersion, includePackageJson });

  return { dataDir, installDir, resourcesDir, asarPath, versionFile };
}

test('version detection prioritizes app.asar package.json over Electron version file and falls back when package.json is absent', () => {
  const root = makeTmpDir('cc-i18n-ver-');
  try {
    const { dataDir, installDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.1',
      electronVersion: '34.2.0',
    });

    const detected = detectAntigravityInstall({ installDir, dataDir });
    assert.equal(detected.found, true);
    assert.equal(detected.appVersion, '2.35.1', 'appVersion must come from app.asar package.json first');
    assert.equal(detected.electronVersion, '34.2.0', 'electronVersion must come from installDir/version');

    const status = getI18nStatus({ installDir, dataDir });
    assert.equal(status.appVersion, '2.35.1');
    assert.equal(status.electronVersion, '34.2.0');
    assert.equal(status.status, 'unpatched');
    assert.equal(status.hasCleanBackup, false);
    assert.equal(status.hasMatchingCleanBackup, false);

    // Fallback: when package.json is missing from app.asar, appVersion falls back to version file
    makeSyntheticAsar(asarPath, { includePackageJson: false });
    const detectedFallback = detectAntigravityInstall({ installDir, dataDir });
    assert.equal(detectedFallback.appVersion, '34.2.0');
    assert.equal(detectedFallback.electronVersion, '34.2.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performApply records both appVersion and electronVersion in meta and state.json', async () => {
  const root = makeTmpDir('cc-i18n-apply-meta-');
  try {
    const { dataDir, installDir, resourcesDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.1',
      electronVersion: '34.2.0',
    });

    const res = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(res.ok, true);

    const meta = JSON.parse(readAsarFile(asarPath, CONSOLE_META_PATH).toString('utf8'));
    assert.equal(meta.appVersion, '2.35.1');
    assert.equal(meta.electronVersion, '34.2.0');

    const statePath = path.join(dataDir, 'i18n', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.appVersion, '2.35.1');
    assert.equal(state.patchedAppVersion, '2.35.1');
    assert.equal(state.electronVersion, '34.2.0');

    const status = getI18nStatus({ installDir, dataDir });
    assert.equal(status.status, 'patched_by_console');
    assert.equal(status.appVersion, '2.35.1');
    assert.equal(status.electronVersion, '34.2.0');
    assert.equal(status.hasCleanBackup, true);
    assert.equal(status.hasMatchingCleanBackup, true);
    assert.equal(status.backups.length, 1);
    assert.equal(status.backups[0].appVersion, '2.35.1');
    assert.equal(status.backups[0].matchesCurrentVersion, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy pre-v1.5.5 metadata storing electronVersion as appVersion does not trigger false outdated_after_update', () => {
  const root = makeTmpDir('cc-i18n-legacy-meta-');
  try {
    const { dataDir, installDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.1',
      electronVersion: '34.2.0',
    });

    // Legacy pre-v1.5.5 patch wrote Electron version '34.2.0' into consolePatchMeta.appVersion
    makeSyntheticAsar(asarPath, {
      version: '2.35.1',
      extraFiles: {
        [CONSOLE_META_PATH]: JSON.stringify({
          engine: 'agy-console-i18n',
          patchVersion: '1.0.0',
          patchedAt: '2026-01-01T00:00:00.000Z',
          appVersion: '34.2.0',
        }),
      },
    });

    const legacyStatus = getI18nStatus({ installDir, dataDir });
    assert.equal(legacyStatus.appVersion, '2.35.1');
    assert.equal(legacyStatus.electronVersion, '34.2.0');
    assert.equal(
      legacyStatus.status,
      'patched_by_console',
      'legacy electronVersion metadata must be treated as patched_by_console, not outdated_after_update'
    );

    // Genuinely older appVersion (neither current appVersion nor electronVersion) still triggers outdated_after_update
    makeSyntheticAsar(asarPath, {
      version: '2.35.2',
      extraFiles: {
        [CONSOLE_META_PATH]: JSON.stringify({
          engine: 'agy-console-i18n',
          patchVersion: '1.0.0',
          patchedAt: '2026-01-01T00:00:00.000Z',
          appVersion: '2.35.1',
          electronVersion: '34.2.0',
        }),
      },
    });

    const staleMetaStatus = getI18nStatus({ installDir, dataDir });
    assert.equal(staleMetaStatus.status, 'outdated_after_update');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale .bak detection sets matchesCurrentVersion=false and hasMatchingCleanBackup=false after official update', async () => {
  const root = makeTmpDir('cc-i18n-stale-status-');
  try {
    const { dataDir, installDir, resourcesDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.1',
      electronVersion: '34.2.0',
    });

    const applyRes = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(applyRes.ok, true);

    // Official update replaces app.asar with clean v2.35.2 while old v2.35.1 .bak remains
    makeSyntheticAsar(asarPath, { version: '2.35.2' });

    const status = getI18nStatus({ installDir, dataDir });
    assert.equal(status.status, 'outdated_after_update');
    assert.equal(status.appVersion, '2.35.2');
    assert.equal(status.hasCleanBackup, true, 'hasCleanBackup stays true for backward compatibility');
    assert.equal(status.hasMatchingCleanBackup, false, 'hasMatchingCleanBackup must be false for stale .bak');
    assert.equal(status.backups.length, 1);
    assert.equal(status.backups[0].appVersion, '2.35.1');
    assert.equal(status.backups[0].matchesCurrentVersion, false);

    // When currentAppVersion is unavailable, scanBackups treats valid backups as matching
    const unversionedScan = scanBackups(resourcesDir, null);
    assert.equal(unversionedScan[0].matchesCurrentVersion, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performRestore refuses to overwrite an already clean original app.asar after official update', async () => {
  const root = makeTmpDir('cc-i18n-guard-clean-');
  try {
    const { dataDir, installDir, resourcesDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.1',
      electronVersion: '34.2.0',
    });

    await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });

    // Official update overwrites app.asar with clean v2.35.2
    makeSyntheticAsar(asarPath, { version: '2.35.2' });

    const restoreRes = await executePatchJob({
      action: 'restore',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(restoreRes.ok, false);
    assert.match(restoreRes.error, /当前 app\.asar 已是干净原版，已阻止还原以防误覆盖降级/);

    // Verify app.asar was NOT downgraded to v2.35.1
    const pkg = JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8'));
    assert.equal(pkg.version, '2.35.2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performRestore refuses stale .bak downgrade: falls back to marker_strip for Console-only patch, prefers matching .bak, and blocks third-party mismatch', async () => {
  const root = makeTmpDir('cc-i18n-guard-mismatch-');
  try {
    const { dataDir, installDir, resourcesDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.2',
      electronVersion: '34.2.0',
    });
    const consoleBak = path.join(resourcesDir, 'app.asar.agy-console.bak');
    const genericBak = path.join(resourcesDir, 'app.asar.bak');

    // Apply patch on v2.35.2
    const applyRes = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(applyRes.ok, true);

    // Replace console backup with a stale v2.35.1 clean backup
    makeSyntheticAsar(consoleBak, { version: '2.35.1' });

    // Case 1: Only Console patch exists + only mismatched backup -> must NOT copy v2.35.1 .bak; must use marker_strip
    const stripRes = await executePatchJob({
      action: 'restore',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(stripRes.ok, true);
    assert.equal(stripRes.details.method, 'marker_strip');
    assert.equal(stripRes.details.restoredFrom, null);
    assert.equal(JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8')).version, '2.35.2');
    assert.equal(inspectAsarMarkers(asarPath).isCleanOriginal, true);
    assert.equal(hasAsarFile(asarPath, CONSOLE_META_PATH), false);

    // Case 2: Console backup is stale v2.35.1, but generic app.asar.bak matches v2.35.2 -> must prefer matching backup
    await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    makeSyntheticAsar(consoleBak, { version: '2.35.1' });
    makeSyntheticAsar(genericBak, { version: '2.35.2' });

    const matchRestoreRes = await executePatchJob({
      action: 'restore',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(matchRestoreRes.ok, true);
    assert.equal(matchRestoreRes.details.method, 'backup_restore');
    assert.equal(path.basename(matchRestoreRes.details.restoredFrom), 'app.asar.bak');
    assert.equal(JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8')).version, '2.35.2');

    // Case 3: Third-party patched v2.35.2 + only stale v2.35.1 backup -> must throw anti-downgrade error
    fs.unlinkSync(genericBak);
    makeSyntheticAsar(asarPath, {
      version: '2.35.2',
      extraFiles: {
        'dist/zh-cn-meta.json': JSON.stringify({ tool: 'third-party' }),
      },
    });
    const blockedRes = await executePatchJob({
      action: 'restore',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(blockedRes.ok, false);
    assert.match(blockedRes.error, /不匹配.*阻止还原以防误覆盖降级/);
    assert.equal(JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8')).version, '2.35.2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performApply refuses stale .bak downgrade: falls through to repatch_without_backup for Console-only patch and blocks third-party mismatch', async () => {
  const root = makeTmpDir('cc-i18n-apply-guard-');
  try {
    const { dataDir, installDir, resourcesDir, asarPath } = createFakeInstall(root, {
      appVersion: '2.35.2',
      electronVersion: '34.2.0',
    });
    const consoleBak = path.join(resourcesDir, 'app.asar.agy-console.bak');

    // Initial clean apply on v2.35.2
    const initialApply = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(initialApply.ok, true);

    // Replace console backup with a stale v2.35.1 clean backup
    makeSyntheticAsar(consoleBak, { version: '2.35.1' });

    // Case 1: Re-applying over Console-patched v2.35.2 with only stale v2.35.1 .bak must NOT downgrade;
    // it must fall through to repatch_without_backup and preserve v2.35.2.
    const repatchRes = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(repatchRes.ok, true);
    assert.equal(repatchRes.details.backupSource, 'repatch_without_backup');
    assert.equal(repatchRes.details.backupPath, null);
    assert.equal(JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8')).version, '2.35.2');
    // Stale backup must not be overwritten with patched asar either
    assert.equal(inspectAsarMarkers(consoleBak).isCleanOriginal, true);

    // Case 2: Applying over third-party patched v2.35.2 with only stale v2.35.1 .bak must throw anti-downgrade error
    makeSyntheticAsar(asarPath, {
      version: '2.35.2',
      extraFiles: {
        'dist/zh-cn-meta.json': JSON.stringify({ tool: 'third-party' }),
      },
    });
    const blockedApply = await executePatchJob({
      action: 'apply',
      installDir,
      resourcesDir,
      asarPath,
      dataDir,
      skipProcessControl: true,
      relaunch: false,
    });
    assert.equal(blockedApply.ok, false);
    assert.match(blockedApply.error, /不匹配.*阻止替换以防误覆盖降级/);
    assert.equal(JSON.parse(readAsarFile(asarPath, 'package.json').toString('utf8')).version, '2.35.2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('i18n UI module shows appVersion + Electron tooltip, 旧版备份 badge, and locks restore/replace buttons on outdated/mismatched backups', async () => {
  const elements = new Map();
  const makeEl = (id) => {
    const attrs = new Map();
    const classes = new Set();
    const el = {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      title: '',
      disabled: false,
      value: '',
      dataset: {},
      classList: {
        toggle: (cls, force) => (force ? classes.add(cls) : classes.delete(cls)),
        contains: (cls) => classes.has(cls),
      },
      removeAttribute: (k) => {
        attrs.delete(k);
        if (k === 'title') el.title = '';
      },
      addEventListener: () => {},
    };
    elements.set(id, el);
    return el;
  };

  for (const id of [
    'i18nHeaderStatusPill',
    'i18nStatusPill',
    'i18nAppVersion',
    'i18nStatusTitle',
    'i18nStatusDesc',
    'i18nApplyBtn',
    'i18nRestoreBtn',
    'i18nBackupsList',
    'i18nBackupCountBadge',
    'i18nLastJobBadge',
    'i18nLastJobBox',
    'i18nThirdPartyPlanCard',
    'i18nThirdPartyPlanDesc',
    'i18nReplaceThirdPartyBtn',
    'i18nRestoreFromThirdPartyBtn',
  ]) {
    makeEl(id);
  }

  const prevDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  try {
    let mockStatus = {
      status: 'outdated_after_update',
      appVersion: '2.35.2',
      electronVersion: '34.2.0',
      hasCleanBackup: true,
      hasMatchingCleanBackup: false,
      backups: [
        {
          name: 'app.asar.agy-console.bak',
          path: '/fake/app.asar.agy-console.bak',
          valid: true,
          isCleanOriginal: true,
          appVersion: '2.35.1',
          matchesCurrentVersion: false,
          size: 1024 * 1024,
          mtime: '2026-01-01T00:00:00.000Z',
        },
      ],
      config: {},
    };

    const mod = createI18nModule({
      callAppTool: async () => mockStatus,
      esc: (s) => String(s ?? ''),
      showToast: () => {},
      openModal: () => {},
      closeModal: () => {},
      positionIndicator: () => {},
      renderCustomSelect: () => {},
    });

    await mod.loadStatus(false);

    assert.equal(elements.get('i18nAppVersion').textContent, 'Antigravity v2.35.2');
    assert.match(elements.get('i18nAppVersion').title, /Electron v34\.2\.0/);
    assert.match(elements.get('i18nBackupsList').innerHTML, /v2\.35\.1/);
    assert.match(elements.get('i18nBackupsList').innerHTML, /旧版备份/);
    assert.equal(elements.get('i18nRestoreBtn').disabled, true);
    assert.match(elements.get('i18nRestoreBtn').title, /降级/);

    // Case: patched_by_console with mismatched backup -> still disabled with mismatch tooltip
    mockStatus = { ...mockStatus, status: 'patched_by_console', hasMatchingCleanBackup: false };
    await mod.loadStatus(false);
    assert.equal(elements.get('i18nRestoreBtn').disabled, true);
    assert.match(elements.get('i18nRestoreBtn').title, /不匹配/);

    // Case: patched_by_console with matching clean backup -> enabled
    mockStatus = {
      ...mockStatus,
      status: 'patched_by_console',
      hasMatchingCleanBackup: true,
      backups: [{ ...mockStatus.backups[0], appVersion: '2.35.2', matchesCurrentVersion: true }],
    };
    await mod.loadStatus(false);
    assert.equal(elements.get('i18nRestoreBtn').disabled, false);
    assert.doesNotMatch(elements.get('i18nBackupsList').innerHTML, /旧版备份/);
    assert.match(elements.get('i18nBackupsList').innerHTML, /v2\.35\.2/);

    // Case: patched_by_other with only stale mismatched backup -> both tpReplaceBtn & tpRestoreBtn & applyBtn locked
    mockStatus = {
      ...mockStatus,
      status: 'patched_by_other',
      hasCleanBackup: true,
      hasMatchingCleanBackup: false,
      backups: [{ ...mockStatus.backups[0], appVersion: '2.35.1', matchesCurrentVersion: false }],
    };
    await mod.loadStatus(false);
    assert.equal(elements.get('i18nReplaceThirdPartyBtn').disabled, true);
    assert.match(elements.get('i18nReplaceThirdPartyBtn').title, /不匹配.*降级/);
    assert.equal(elements.get('i18nRestoreFromThirdPartyBtn').disabled, true);
    assert.match(elements.get('i18nThirdPartyPlanDesc').textContent, /旧版原版备份.*不匹配/);
    assert.equal(elements.get('i18nApplyBtn').disabled, true);
  } finally {
    globalThis.document = prevDocument;
  }
});
