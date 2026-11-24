import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, sanitizeConfig, VALID_UI_LANGUAGES } from '../src/core/config.mjs';
import { restartAntigravity, executeRestartWorker } from '../src/core/client-restart.mjs';
import { restartAntigravity as restartFromI18n } from '../src/core/i18n/index.mjs';
import { createMcpDispatcher, SERVER_INFO } from '../src/mcp/server.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeInstall(root) {
  const installDir = path.join(root, 'Antigravity');
  const resourcesDir = path.join(installDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  const asarPath = path.join(resourcesDir, 'app.asar');
  fs.writeFileSync(asarPath, 'FAKE-ASAR-PAYLOAD-DO-NOT-TOUCH', 'utf8');
  const exeName = process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity';
  const exePath = path.join(installDir, exeName);
  fs.writeFileSync(exePath, 'fake-binary', 'utf8');
  return { installDir, resourcesDir, asarPath, exePath };
}

test('config uiLanguage defaults, validation, persistence, defaultModule, and prototype pollution guard', () => {
  const root = makeTmpDir('cc-cfg-lang-');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const opts = { dataDir };

  try {
    assert.deepEqual(VALID_UI_LANGUAGES, ['zh-CN', 'en']);

    // Default is zh-CN
    const initial = loadConfig(opts);
    assert.equal(initial.uiLanguage, 'zh-CN');

    // Persist en
    const savedEn = saveConfig({ uiLanguage: 'en' }, opts);
    assert.equal(savedEn.uiLanguage, 'en');
    assert.equal(loadConfig(opts).uiLanguage, 'en');

    // Persist zh-CN
    const savedZh = saveConfig({ uiLanguage: 'zh-CN' }, opts);
    assert.equal(savedZh.uiLanguage, 'zh-CN');
    assert.equal(loadConfig(opts).uiLanguage, 'zh-CN');

    // Invalid values fall back to zh-CN
    for (const bad of ['fr', '', null, 123, {}, []]) {
      assert.equal(sanitizeConfig({ uiLanguage: bad }).uiLanguage, 'zh-CN');
    }
    assert.equal(sanitizeConfig({ uiLanguage: 'EN' }).uiLanguage, 'en');

    // console.defaultModule allows all 4 modules
    for (const mod of ['monitor', 'governance', 'appearance', 'i18n']) {
      assert.equal(sanitizeConfig({ console: { defaultModule: mod } }).console.defaultModule, mod);
    }
    assert.equal(sanitizeConfig({ console: { defaultModule: 'unknown' } }).console.defaultModule, 'monitor');

    // Prototype pollution guard
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"uiLanguage":"en"}');
    const clean = sanitizeConfig(malicious);
    assert.equal(clean.uiLanguage, 'en');
    assert.equal(({}).polluted, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restartAntigravity safe failure, dryRun, mocked detached spawn, and zero ASAR mutation', async () => {
  assert.equal(restartFromI18n, restartAntigravity, 'i18n/index.mjs should re-export restartAntigravity');

  const root = makeTmpDir('cc-restart-');
  const dataDir = path.join(root, 'data');
  const emptyDir = path.join(root, 'empty-dir');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  try {
    // 1. Safe failure when executable not found (empty override)
    const missing = restartAntigravity({ dataDir, installDir: emptyDir, skipSystemScan: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'not_found');
    assert.equal(missing.queued, false);
    assert.equal(missing.exePath, null);
    assert.ok(missing.error && missing.message);

    // 2. Dry-run with fake install
    const fake = makeFakeInstall(root);
    const asarBefore = fs.readFileSync(fake.asarPath, 'utf8');

    const dry = restartAntigravity({ dataDir, installDir: fake.installDir, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.status, 'dry_run');
    assert.equal(dry.dryRun, true);
    assert.equal(dry.queued, false);
    assert.equal(dry.exePath, fake.exePath);
    assert.equal(fs.readFileSync(fake.asarPath, 'utf8'), asarBefore, 'dryRun must not touch app.asar');

    // 3. Mocked detached spawn (never kills real IDE)
    let capturedSpec = null;
    const queued = restartAntigravity({
      dataDir,
      installDir: fake.installDir,
      waitBeforeKillMs: 250,
      spawnWorker: (spec) => {
        capturedSpec = spec;
        return { pid: 424242, method: 'mock:wmi' };
      },
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.queued, true);
    assert.equal(queued.pid, 424242);
    assert.equal(queued.method, 'mock:wmi');
    assert.equal(queued.exePath, fake.exePath);
    assert.equal(capturedSpec?.exePath, fake.exePath);
    assert.equal(capturedSpec?.waitBeforeKillMs, 250);
    assert.equal(fs.readFileSync(fake.asarPath, 'utf8'), asarBefore, 'restart must never modify app.asar');
    assert.equal(
      fs.existsSync(path.join(dataDir, 'i18n', 'i18n-job.json')),
      false,
      'plain restart must not write i18n-job.json'
    );

    // 4. executeRestartWorker safety checks
    const badWorker = await executeRestartWorker({ exePath: path.join(root, 'missing.exe') });
    assert.equal(badWorker.ok, false);
    assert.equal(badWorker.status, 'not_found');

    const skippedWorker = await executeRestartWorker({ exePath: fake.exePath, skipProcessControl: true });
    assert.equal(skippedWorker.ok, true);
    assert.equal(skippedWorker.status, 'skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP app_config_manage handles uiLanguage persistence, restart_antigravity, and v1.5.3 version', async () => {
  const root = makeTmpDir('cc-mcp-cfg-');
  const dataDir = path.join(root, 'data');
  const emptyDir = path.join(root, 'missing-install');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  const fake = makeFakeInstall(root);

  const dispatcher = createMcpDispatcher({ dataDir, projectDir: root });
  try {
    assert.equal(SERVER_INFO.version, '1.5.3');

    // Default config get
    const rGet = await dispatcher.callTool('app_config_manage', { action: 'get' });
    assert.ok(!rGet.isError);
    assert.equal(rGet.structuredContent.config.uiLanguage, 'zh-CN');

    // Update uiLanguage -> en
    const rEn = await dispatcher.callTool('app_config_manage', {
      action: 'update',
      patch: { uiLanguage: 'en' },
    });
    assert.ok(!rEn.isError);
    assert.equal(rEn.structuredContent.config.uiLanguage, 'en');

    // Invalid uiLanguage -> falls back to zh-CN
    const rBad = await dispatcher.callTool('app_config_manage', {
      action: 'update',
      patch: { uiLanguage: 'ja-JP' },
    });
    assert.ok(!rBad.isError);
    assert.equal(rBad.structuredContent.config.uiLanguage, 'zh-CN');

    // restart_antigravity with nonexistent installDir -> safe failure
    const rMiss = await dispatcher.callTool('app_config_manage', {
      action: 'restart_antigravity',
      installDir: emptyDir,
      dryRun: true,
    });
    assert.ok(!rMiss.isError);
    assert.equal(rMiss.structuredContent.ok, false);
    assert.equal(rMiss.structuredContent.status, 'not_found');

    // restart_antigravity with fake installDir + dryRun -> ok
    const rDry = await dispatcher.callTool('app_config_manage', {
      action: 'restart_antigravity',
      installDir: fake.installDir,
      dryRun: true,
    });
    assert.ok(!rDry.isError);
    assert.equal(rDry.structuredContent.ok, true);
    assert.equal(rDry.structuredContent.status, 'dry_run');
    assert.equal(rDry.structuredContent.exePath, fake.exePath);
  } finally {
    await dispatcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
