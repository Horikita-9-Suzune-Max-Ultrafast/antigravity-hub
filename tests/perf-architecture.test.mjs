import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PopoutServerManager } from '../src/core/popout-server.mjs';
import { getGitContext, clearGitContextCache } from '../src/core/git-context.mjs';
import { listConversations, clearTranscriptCache } from '../src/core/transcript-parser.mjs';
import {
  syncConversationTelemetry,
  getTelemetryReport,
  clearTelemetryCache,
} from '../src/core/telemetry.mjs';
import { withIndexDb, closeIndexDb } from '../src/core/index-db.mjs';
import {
  buildThumbDataUri,
  getAppearanceStatus,
  getThumbCacheStats,
  clearThumbCache,
  saveAppearanceState,
  loadAppearanceState,
  handleAppearanceAction,
  compileRuntimeAppearance,
} from '../src/core/appearance/index.mjs';
import {
  buildRendererRuntimeSource,
  buildMainRuntimeSource,
} from '../src/core/i18n/payload-templates.mjs';
import { getDataPaths } from '../src/core/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# hello\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('Bundle slimming: dist/dashboard.html < 750 KB and strips unused zod/v4/locales bloat', () => {
  const htmlPath = path.join(ROOT_DIR, 'dist', 'dashboard.html');
  assert.ok(fs.existsSync(htmlPath), 'dist/dashboard.html must exist (run npm run build:ui)');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');

  assert.ok(
    bytes < 750_000,
    `Expected dist/dashboard.html to be < 750,000 B (baseline 1,004,627 B), got ${bytes} B`
  );
  // Ensure non-English zod/v4/locales strings were stubbed out
  for (const snippet of [
    'Entrada inválida',
    'Ungültige Eingabe',
    'Entrée invalide',
    '無効な入力',
    'Неверный ввод',
  ]) {
    assert.equal(
      html.includes(snippet),
      false,
      `dist/dashboard.html must not contain unused zod locale string: ${snippet}`
    );
  }
});

test('CSS GPU & compositor guarantees: zero backdrop-filter, zero infinite 60fps animations, closed modals display:none', () => {
  const cssPath = path.join(ROOT_DIR, 'src', 'ui', 'styles.css');
  const htmlPath = path.join(ROOT_DIR, 'dist', 'dashboard.html');
  const css = fs.readFileSync(cssPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Zero backdrop-filter in both source CSS and built HTML
  assert.equal(/backdrop-filter\s*:/i.test(css), false, 'styles.css must contain zero backdrop-filter rules');
  assert.equal(/backdrop-filter\s*:/i.test(html), false, 'dist/dashboard.html must contain zero backdrop-filter rules');

  // Zero infinite 60fps animations / pulseRing in styles.css
  assert.equal(/\binfinite\b/i.test(css), false, 'styles.css must contain zero infinite animations');
  assert.equal(/pulseRing/.test(css), false, 'styles.css must not contain legacy @keyframes pulseRing');

  // Closed .modal-backdrop uses display: none; open [data-open="true"] uses display: flex
  const closedBackdropMatch = css.match(/\.modal-backdrop\s*\{[^}]*\}/);
  assert.ok(closedBackdropMatch, '.modal-backdrop rule must exist in styles.css');
  assert.ok(
    /display\s*:\s*none\s*;/i.test(closedBackdropMatch[0]),
    '.modal-backdrop closed state must use display: none'
  );

  const openBackdropMatch = css.match(/\.modal-backdrop\[data-open="true"\]\s*\{[^}]*\}/);
  assert.ok(openBackdropMatch, '.modal-backdrop[data-open="true"] rule must exist in styles.css');
  assert.ok(
    /display\s*:\s*flex\s*;/i.test(openBackdropMatch[0]),
    '.modal-backdrop[data-open="true"] must use display: flex'
  );

  // Reduced-motion safeguard present
  assert.ok(
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(css),
    'styles.css must include @media (prefers-reduced-motion: reduce)'
  );

  // App JS removes forced sync reflow in pulseEl and wires popout close sync
  const appJs = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ui', 'app.mjs'), 'utf8');
  assert.equal(/void\s+\w+\.offsetWidth/.test(appJs), false, 'app.mjs must not trigger forced synchronous offsetWidth reflow');
  assert.ok(appJs.includes('exitGlobalLauncherMode'), 'app.mjs must auto-exit launcher mode when popout closes');
  assert.ok(appJs.includes('userClosed'), 'app.mjs must respect popoutStatus.userClosed');
});

test('PopoutServerManager: immediate close & host exit transition without 3s/18s lag + /api/wallpaper/:id security', async () => {
  const tmpDir = makeTmpDir('cc-popout-arch-');
  const wpFile = path.join(tmpDir, 'sample.png');
  // Valid minimal PNG header + bytes
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(wpFile, pngBytes);

  const mgr = new PopoutServerManager({
    getHtml: () => '<!doctype html><html><body>ok</body></html>',
    handleAppTool: async () => ({ ok: true }),
    resolveWallpaper: (id) => (id === 'lib:sample.png' ? { filePath: wpFile, mime: 'image/png' } : null),
    stopGraceMs: 400,
  });

  try {
    const started = await mgr.start();
    assert.equal(started.running, true);
    assert.equal(started.windowOpen, true);
    assert.equal(started.serverListening, true);
    assert.equal(started.userClosed, false);
    const token = mgr.token;
    const baseUrl = `http://127.0.0.1:${started.port}`;

    // Verify /api/wallpaper/:id auth, traversal rejection, and streaming headers
    const noTokenRes = await fetch(`${baseUrl}/api/wallpaper/${encodeURIComponent('lib:sample.png')}`);
    assert.equal(noTokenRes.status, 403);

    const traversalRes = await fetch(`${baseUrl}/api/wallpaper/${encodeURIComponent('..%2Fsecret.png')}?token=${token}`);
    assert.equal(traversalRes.status, 400);

    const missingRes = await fetch(`${baseUrl}/api/wallpaper/${encodeURIComponent('lib:missing.png')}?token=${token}`);
    assert.equal(missingRes.status, 404);

    const okWpRes = await fetch(`${baseUrl}/api/wallpaper/${encodeURIComponent('lib:sample.png')}?token=${token}`);
    assert.equal(okWpRes.status, 200);
    assert.equal(okWpRes.headers.get('content-type'), 'image/png');
    assert.equal(okWpRes.headers.get('cache-control'), 'private, max-age=300');
    assert.equal(okWpRes.headers.get('x-content-type-options'), 'nosniff');
    const streamedBuf = Buffer.from(await okWpRes.arrayBuffer());
    assert.deepEqual(streamedBuf, pngBytes);

    // Heartbeat registers an active client
    const hbRes = await fetch(`${baseUrl}/api/popout/heartbeat?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'win-1' }),
    });
    assert.equal(hbRes.status, 200);
    assert.equal(mgr.getStatus().activeClients, 1);

    // Closing must IMMEDIATELY flip windowOpen:false, running:false, userClosed:true (0ms delay)
    const tClose = Date.now();
    const closeRes = await fetch(`${baseUrl}/api/popout/closing?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'win-1' }),
    });
    assert.equal(closeRes.status, 200);
    const statusAfterClose = mgr.getStatus();
    const elapsedMs = Date.now() - tClose;
    assert.ok(elapsedMs < 1000, `closing transition took too long: ${elapsedMs}ms`);
    assert.equal(statusAfterClose.windowOpen, false);
    assert.equal(statusAfterClose.running, false);
    assert.equal(statusAfterClose.userClosed, true);
    assert.equal(statusAfterClose.activeClients, 0);

    // Re-start and verify simulated WebView2 dead-PID host exit clears everything immediately
    await mgr.start();
    mgr.hostMode = 'webview2';
    mgr.hostPid = 999999999; // guaranteed non-existent PID
    mgr.hostStartedAt = Date.now();
    mgr.activeClients.set('win-2', Date.now());
    const afterDeadPid = mgr.getStatus();
    assert.equal(afterDeadPid.windowOpen, false);
    assert.equal(afterDeadPid.running, false);
    assert.equal(afterDeadPid.userClosed, true);
    assert.equal(afterDeadPid.hostMode, 'none');
    assert.equal(afterDeadPid.activeClients, 0);
  } finally {
    await mgr.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Backend caching, true incremental telemetry, bounded thumbnails, SQLite pooling, and appearance.lowPowerMode', () => {
  const root = makeTmpDir('cc-backend-arch-');
  const repoDir = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    // 1. Git context caching
    makeFakeGitRepo(repoDir);
    clearGitContextCache();
    const g1 = getGitContext(repoDir);
    assert.equal(g1.isGitRepo, true);
    const tWarmStart = performance.now();
    const g2 = getGitContext(repoDir);
    const warmGitMs = performance.now() - tWarmStart;
    assert.deepEqual(g2, g1);
    assert.ok(warmGitMs < 50, `Expected warm getGitContext() cache hit < 50ms, got ${warmGitMs.toFixed(2)}ms`);

    // 2. Transcript LRU cache + single-pass listConversations + true incremental telemetry
    clearTranscriptCache();
    clearTelemetryCache();
    const convId = '11111111-1111-4111-8111-111111111111';
    const convDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    const transcriptFile = path.join(convDir, 'transcript.jsonl');

    const step0 = { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z', content: 'Hello' };
    const step1 = {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T10:00:02Z',
      model: 'gemini-4-neon-high',
      input_tokens: 1000,
      cache_read_tokens: 4000,
      output_tokens: 200,
      content: 'First reply',
    };
    fs.writeFileSync(transcriptFile, `${JSON.stringify(step0)}\n${JSON.stringify(step1)}\n`, 'utf8');

    const list1 = listConversations({ appDataDir, limit: 1 });
    assert.equal(list1.length, 1);
    assert.equal(list1[0].conversationId, convId);
    const list2 = listConversations({ appDataDir, limit: 1 });
    assert.equal(list2.length, 1);
    assert.equal(list2[0].conversationId, convId);

    // Initial telemetry sync
    const sync1 = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(sync1.conversationId, convId);
    assert.equal(sync1.syncedNew, 1);

    // Repeat sync with no new bytes must sync 0 new calls
    const syncNoop = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(syncNoop.syncedNew, 0);

    // Append 1 new step -> incremental sync processes ONLY the newly appended call (syncedNew === 1)
    const step2 = {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T10:00:08Z',
      model: 'gemini-4-neon-high',
      input_tokens: 1200,
      cache_read_tokens: 4800,
      output_tokens: 150,
      content: 'Second reply',
    };
    fs.appendFileSync(transcriptFile, `${JSON.stringify(step2)}\n`, 'utf8');
    const syncInc = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(syncInc.conversationId, convId);
    assert.equal(syncInc.syncedNew, 1, 'Appending 1 step must incrementally upsert only 1 new call');
    assert.equal(syncInc.calls.length, 2);

    // Repeated getTelemetryReport() hits 1.5s TTL cache
    const rep1 = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(rep1.calls.length, 2);
    const tRepStart = performance.now();
    const rep2 = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    const repWarmMs = performance.now() - tRepStart;
    assert.equal(rep2.calls.length, 2);
    assert.ok(repWarmMs < 50, `Expected cached getTelemetryReport() < 50ms, got ${repWarmMs.toFixed(2)}ms`);

    // 3. SQLite pooled connection reuse + clean closeIndexDb()
    let dbRef1 = null;
    let dbRef2 = null;
    withIndexDb({ dataDir, keepOpen: true }, (db) => {
      dbRef1 = db;
    });
    withIndexDb({ dataDir, keepOpen: true }, (db) => {
      dbRef2 = db;
    });
    assert.strictEqual(dbRef1, dbRef2, 'withIndexDb({ keepOpen: true }) must reuse the pooled SQLite handle');
    closeIndexDb();

    // 4. Bounded wallpaper thumbnails: > 2 MiB file must NOT emit raw multi-MB Base64
    clearThumbCache();
    const { wallpapersDir } = getDataPaths({ dataDir });
    fs.mkdirSync(wallpapersDir, { recursive: true });
    const hugeImgPath = path.join(wallpapersDir, 'huge-4k.png');
    // Write a 2.2 MiB dummy file (not valid PNG header so background resizer won't spawn)
    const hugeBuf = Buffer.alloc(2.2 * 1024 * 1024, 0x41);
    fs.writeFileSync(hugeImgPath, hugeBuf);

    const thumbUri = buildThumbDataUri(hugeImgPath, 'image/png', { dataDir, skipAsyncThumb: true });
    assert.equal(thumbUri, null, 'buildThumbDataUri must NOT inline raw Base64 for > 128 KiB images');

    const status = getAppearanceStatus({ dataDir });
    const statusJsonBytes = Buffer.byteLength(JSON.stringify(status), 'utf8');
    assert.ok(
      statusJsonBytes < 50_000,
      `getAppearanceStatus() JSON must stay bounded (< 50 KB), got ${statusJsonBytes} B`
    );
    const hugeEntry = status.library.find((it) => it.name === 'huge-4k.png');
    assert.ok(hugeEntry, 'huge-4k.png should appear in library list');
    assert.equal(hugeEntry.thumb, null);
    assert.equal(hugeEntry.thumbUrl, `/api/wallpaper/${encodeURIComponent(hugeEntry.id)}`);

    const thumbStats = getThumbCacheStats();
    assert.ok(thumbStats.maxBytes <= 16 * 1024 * 1024, 'THUMB_CACHE budget must be <= 16 MiB');

    // 5. appearance.lowPowerMode defaults to false, persists true cleanly, and compiles to runtime JSON
    const initialApp = loadAppearanceState({ dataDir });
    assert.equal(initialApp.lowPowerMode, false);

    const upd = handleAppearanceAction(
      { action: 'update_config', patch: { enabled: true, lowPowerMode: true }, light: true },
      { dataDir }
    );
    assert.equal(upd.ok, true);
    assert.equal(upd.state.lowPowerMode, true);

    const reloaded = loadAppearanceState({ dataDir });
    assert.equal(reloaded.lowPowerMode, true);

    const runtimeCfg = compileRuntimeAppearance({ dataDir });
    assert.equal(runtimeCfg.payload.lowPowerMode, true);

    saveAppearanceState({ lowPowerMode: false }, { dataDir });
    assert.equal(loadAppearanceState({ dataDir }).lowPowerMode, false);
  } finally {
    closeIndexDb();
    clearThumbCache();
    clearGitContextCache();
    clearTranscriptCache();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('payload-templates.mjs: time-guarded rotation, NodeFilter.FILTER_REJECT, processedAttrNodes.has, isMutating/takeRecords, and lowPowerMode', async () => {
  const root = makeTmpDir('cc-payload-arch-');
  const dataDir = path.join(root, 'data');
  try {
    const { i18nBundleFile, i18nDir } = getDataPaths({ dataDir });
    fs.mkdirSync(i18nDir, { recursive: true });
    fs.writeFileSync(i18nBundleFile, JSON.stringify({ version: 1, ui: { Settings: '设置' }, menu: {}, patterns: [] }));

    const rendererSrc = buildRendererRuntimeSource(null, i18nBundleFile);
    const mainSrc = buildMainRuntimeSource(null, i18nBundleFile);

    // Static architectural checks on generated injected payloads
    assert.ok(rendererSrc.includes('isIntervalRotationDue'), 'renderer must time-guard interval rotation');
    assert.ok(rendererSrc.includes('needIntervalTick = isIntervalRotationDue'), 'needIntervalTick must use time-guard');
    assert.ok(rendererSrc.includes('NodeFilter.FILTER_REJECT'), 'TreeWalker must prune subtrees with NodeFilter.FILTER_REJECT');
    assert.ok(rendererSrc.includes('processedAttrNodes.has('), 'processElementAttrs must check processedAttrNodes.has');
    assert.ok(rendererSrc.includes('isMutating = true'), 'renderer must guard own mutations with isMutating');
    assert.ok(rendererSrc.includes('takeRecords()'), 'renderer must drain own MutationObserver records with takeRecords()');
    assert.ok(rendererSrc.includes('lowPowerMode'), 'wallpaper runtime must handle cfg.lowPowerMode');
    assert.ok(rendererSrc.includes("removeProperty('filter')"), 'wallpaper runtime must omit filter when blur=0 & sat=100');
    assert.ok(mainSrc.includes('fs.promises.readFile'), 'main IPC read-wallpaper must use async fs.promises.readFile');
    assert.ok(mainSrc.includes('new Uint8Array('), 'main IPC read-wallpaper must transfer Uint8Array bytes');

    // Synthetic DOM runtime test for lowPowerMode + filter omission + interval rotation time-guard
    const imgPath = path.join(root, 'bg.png');
    fs.writeFileSync(
      imgPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const { appearanceRuntimeFile } = getDataPaths({ dataDir });
    fs.mkdirSync(path.dirname(appearanceRuntimeFile), { recursive: true });
    fs.writeFileSync(
      appearanceRuntimeFile,
      JSON.stringify({
        enabled: true,
        mode: 'image',
        activeWallpaperPath: imgPath,
        opacity: 0.65,
        blurPx: 0,
        saturation: 100,
        scrimOpacity: 0.4,
        fit: 'cover',
        lowPowerMode: true,
        rotationMode: 'interval',
        rotationMinutes: 30,
        pool: [imgPath],
      }),
      'utf8'
    );

    const createdNodes = new Map();
    function makeStyleStore() {
      const props = new Map();
      return {
        props,
        setProperty(k, v) {
          props.set(k, String(v));
        },
        removeProperty(k) {
          props.delete(k);
        },
        getPropertyValue(k) {
          return props.get(k) || '';
        },
        backgroundImage: '',
      };
    }
    function makeMockEl(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        id: '',
        dataset: {},
        attrs: new Map(),
        children: [],
        parentNode: null,
        style: makeStyleStore(),
        setAttribute(k, v) {
          this.attrs.set(k, String(v));
          if (k === 'id') {
            this.id = String(v);
            createdNodes.set(this.id, this);
          }
        },
        getAttribute(k) {
          return this.attrs.get(k) ?? null;
        },
        hasAttribute(k) {
          return this.attrs.has(k);
        },
        appendChild(child) {
          child.parentNode = this;
          this.children.push(child);
          if (child.id) createdNodes.set(child.id, child);
          return child;
        },
        removeChild(child) {
          this.children = this.children.filter((c) => c !== child);
          if (child.id) createdNodes.delete(child.id);
        },
        querySelector(sel) {
          const m = sel.match(/\[data-wp-slot="(\d+)"\]/);
          if (m) return this.children.find((c) => c.getAttribute('data-wp-slot') === m[1]) || null;
          return null;
        },
        matches: () => false,
        closest: () => null,
      };
      return el;
    }

    const docEl = makeMockEl('html');
    const bodyEl = makeMockEl('body');
    const mockDocument = {
      documentElement: docEl,
      body: bodyEl,
      readyState: 'complete',
      hidden: false,
      title: 'Antigravity',
      createElement: (tag) => makeMockEl(tag),
      getElementById: (id) => createdNodes.get(id) || null,
      addEventListener() {},
      removeEventListener() {},
      createTreeWalker: () => ({ nextNode: () => null }),
    };

    const handlers = new Map();
    const mockMainRequire = (mod) => {
      if (mod === 'fs') return fs;
      if (mod === 'path') return path;
      if (mod === 'electron') {
        return {
          ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
          Menu: { buildFromTemplate: (t) => t },
        };
      }
      throw new Error(`unexpected main require: ${mod}`);
    };
    delete globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__;
    new Function('require', mainSrc)(mockMainRequire);
    delete globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__;

    const mockIpcRenderer = {
      invoke: (ch, ...args) => Promise.resolve(handlers.get(ch)(null, ...args)),
      on() {},
    };
    const mockRendererRequire = (mod) => {
      if (mod === 'electron') return { ipcRenderer: mockIpcRenderer };
      throw new Error(`unexpected renderer require: ${mod}`);
    };
    const mockWindow = {
      document: mockDocument,
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 24)', color: 'rgb(240, 240, 240)' }),
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      URL: { createObjectURL: () => 'blob:mock-wp-1', revokeObjectURL() {} },
    };

    // Execute renderer runtime in isolated scope
    const fn = new Function(
      'window',
      'document',
      'require',
      'MutationObserver',
      'NodeFilter',
      'Blob',
      'Image',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      rendererSrc
    );
    fn(
      mockWindow,
      mockDocument,
      mockRendererRequire,
      class {
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
      { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
      Blob,
      undefined,
      (cb) => {
        cb();
        return 1;
      },
      () => {}
    );

    // Wait briefly for async IPC invoke promise chain to settle
    await new Promise((r) => setTimeout(r, 80));

    const layer = createdNodes.get('agy-hub-wallpaper-layer');
    assert.ok(layer, 'Wallpaper layer should be created by renderer runtime');
    assert.equal(
      layer.style.getPropertyValue('mix-blend-mode'),
      'normal',
      'lowPowerMode: true must force mix-blend-mode: normal'
    );
    assert.ok(
      Number(layer.style.getPropertyValue('opacity')) <= 0.22,
      `lowPowerMode: true must cap opacity <= 0.22, got ${layer.style.getPropertyValue('opacity')}`
    );
    assert.equal(
      layer.style.props.has('filter'),
      false,
      'blurPx === 0 && saturation === 100 must omit CSS filter property'
    );
    assert.equal(
      layer.style.getPropertyValue('will-change'),
      'opacity',
      'when filter is omitted, will-change should only be opacity'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
