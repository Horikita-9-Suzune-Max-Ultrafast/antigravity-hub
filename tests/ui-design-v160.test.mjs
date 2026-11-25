import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

import {
  App,
  PostMessageTransport,
  LATEST_PROTOCOL_VERSION,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  getDocumentTheme,
} from '../src/ui/core/mcp-app-client.mjs';
import { createRpcClient } from '../src/ui/core/rpc.mjs';
import { createUiState, MINI_BAR_DEFAULT_ORDER } from '../src/ui/core/store.mjs';
import {
  ICON_SPRITE_HTML,
  renderBrandMark,
  renderIcon,
  computeBrandHealthState,
} from '../src/ui/components/icons.mjs';
import {
  bindNativeDragSurface,
  computeMiniBarFitPlan,
  estimateChipWidthPx,
  createNativeChromeModule,
} from '../src/ui/modules/native-chrome.mjs';
import { createMonitorCallsModule } from '../src/ui/modules/monitor-calls.mjs';
import { buildUi, MAX_UI_BUNDLE_BYTES } from '../src/ui/build-ui.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

test('styles.css: Radix 12-step Light/Dark tokens, zero undefined vars, zero 13px/backdrop-filter/infinite/middle-dot/layout-transitions', () => {
  const cssPath = path.join(ROOT_DIR, 'src', 'ui', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  // 1. Required Radix tokens & semantic variables formally defined
  for (const token of [
    '--slate-1:', '--slate-2:', '--slate-3:', '--slate-6:', '--slate-11:', '--slate-12:',
    '--blue-9:', '--green-9:', '--amber-9:', '--red-9:',
    '--muted:', '--popover:', '--background:', '--card:', '--border:', '--error:',
    '--r-xs:', '--r-sm:', '--r-md:', '--r-lg:', '--r-full:',
    '--ease-out:', '--dur-fast:', '--dur-base:',
  ]) {
    assert.ok(css.includes(token), `styles.css must define ${token}`);
  }
  assert.ok(css.includes('cubic-bezier(0.16, 1, 0.3, 1)'), 'styles.css must use cubic-bezier(0.16, 1, 0.3, 1)');
  assert.ok(css.includes('html[data-theme="dark"]'), 'styles.css must define dark theme tokens');

  // 2. Zero forbidden patterns
  assert.equal(/var\(\s*--danger\b/i.test(css), false, 'styles.css must have zero var(--danger) references');
  assert.equal(/backdrop-filter\s*:/i.test(css), false, 'styles.css must have zero backdrop-filter rules');
  assert.equal(/\binfinite\b/i.test(css), false, 'styles.css must have zero infinite animations');
  assert.equal(/pulseRing/.test(css), false, 'styles.css must not contain legacy pulseRing');
  assert.equal(/font-size\s*:\s*13px\b/i.test(css), false, 'styles.css must have zero 13px font sizes');
  assert.equal(css.includes('\u00b7'), false, 'styles.css must contain zero middle-dot (\\u00b7) characters');

  // 3. Strictly 4 font sizes (12px, 14px, 16px, 28px)
  const fontSizes = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((m) => Number(m[1]));
  assert.ok(fontSizes.length > 0, 'Expected font-size declarations');
  for (const sz of fontSizes) {
    assert.ok([12, 14, 16, 28].includes(sz), `Unexpected font-size ${sz}px; allowed scale is 12/14/16/28px`);
  }

  // 4. Zero layout-property transitions (width, height, top, left, margin, padding, grid-template-rows)
  const transitions = [...css.matchAll(/transition\s*:\s*([^;]+);/gi)].map((m) => m[1]);
  for (const trVal of transitions) {
    assert.equal(
      /\b(width|height|top|left|right|bottom|margin|padding|grid-template-rows)\b/i.test(trVal),
      false,
      `Disallowed layout property in CSS transition: "${trVal}"`
    );
  }

  // 5. Perf-architecture compatibility selectors
  assert.match(css, /\.modal-backdrop\s*\{[^}]*display\s*:\s*none\s*;/s);
  assert.match(css, /\.modal-backdrop\[data-open="true"\]\s*\{[^}]*display\s*:\s*flex\s*;/s);
  assert.match(css, /\.agy-select-menu\[data-fixed="true"\]\s*\{[^}]*position\s*:\s*fixed\s*;/s);
  assert.match(css, /\.calls-table\[data-layout-mode="card"\]\s*\{[^}]*display\s*:\s*block\s*;/s);
  assert.match(css, /\.calls-table\[data-model-mode="short"\]\s+\.col-model-full\s*\{[^}]*display\s*:\s*none\s*;/s);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i);

  // 6. New v1.6.0 UI surfaces: #orbView (48x48), 5-module topbar, .review-*, .gov-pillars-*
  assert.match(css, /\.orb-view\s*\{[^}]*width\s*:\s*48px\s*;[^}]*height\s*:\s*48px\s*;/s);
  assert.match(css, /\.console-top-switcher\s*\{[^}]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s);
  assert.ok(css.includes('.review-finding-card'), 'styles.css must define .review-* styles');
  assert.ok(css.includes('.gov-pillars-grid'), 'styles.css must define 4-pillar governance mini-bar styles');
  assert.ok(css.includes('.gov-pillar-bar-fill'), 'styles.css must define .gov-pillar-bar-fill');
});

test('Zero middle-dot (\\u00b7) across all newly created/modified UI files and brand SVG logo check', () => {
  const ownedFiles = [
    'plugin/assets/logo.svg',
    'src/ui/styles.css',
    'src/ui/build-ui.mjs',
    'src/ui/core/mcp-app-client.mjs',
    'src/ui/core/store.mjs',
    'src/ui/core/dom.mjs',
    'src/ui/core/rpc.mjs',
    'src/ui/components/custom-select.mjs',
    'src/ui/components/modal.mjs',
    'src/ui/components/icons.mjs',
    'src/ui/modules/monitor-context.mjs',
    'src/ui/modules/monitor-calls.mjs',
    'src/ui/modules/monitor-vault.mjs',
    'src/ui/modules/settings-module.mjs',
    'src/ui/modules/native-chrome.mjs',
  ];
  for (const rel of ownedFiles) {
    const src = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
    assert.equal(src.includes('\u00b7'), false, `${rel} must not contain raw middle-dot character`);
  }

  // Brand logo SVG checks
  const logoSvg = fs.readFileSync(path.join(ROOT_DIR, 'plugin/assets/logo.svg'), 'utf8');
  assert.ok(logoSvg.includes('viewBox="0 0 128 128"'));
  assert.ok(logoSvg.includes('#0090FF'), 'logo.svg must use Radix Blue 9 primary brand fill');
  assert.equal(logoSvg.includes('<circle'), false, 'New prism logo must remove legacy floating dot');

  // Icon sprite & optical sizing checks
  assert.ok(ICON_SPRITE_HTML.includes('id="hub-logo-mark"'));
  assert.ok(ICON_SPRITE_HTML.includes('id="hub-logo-sm"'));
  assert.ok(ICON_SPRITE_HTML.includes('stroke-width="1.75"'));
  assert.ok(renderBrandMark({ size: 18 }).includes('#hub-logo-sm'));
  assert.ok(renderBrandMark({ size: 24 }).includes('#hub-logo-mark'));
  assert.ok(renderBrandMark({ size: 16, live: false }).includes('data-static="true"'));
  assert.ok(renderIcon('close', { size: 14 }).includes('#ico-close'));

  // Cross-model brand health state (Gemini KV + Claude/GPT context & cache drop)
  assert.equal(
    computeBrandHealthState({ model: 'gemini-4-neon', usedPercent: 20, totalCallsCount: 5 }, {}, { visible: true, state: 'warn' }),
    'warn'
  );
  assert.equal(
    computeBrandHealthState({ model: 'claude-4-sonnet', usedPercent: 78, totalCallsCount: 4 }, { alerts: { contextWarningPct: 75 } }, { visible: false }),
    'warn'
  );
  assert.equal(
    computeBrandHealthState({ model: 'gpt-5', usedPercent: 93, totalCallsCount: 6 }, { alerts: { contextWarningPct: 75 } }, { visible: false }),
    'danger'
  );
  assert.equal(
    computeBrandHealthState({ model: 'claude-4-opus', usedPercent: 30, usedTokens: 40000, totalCallsCount: 4, latestCacheHitRate: 20 }, { alerts: { cacheDropThresholdPct: 50 } }, { visible: false }),
    'danger'
  );
  assert.equal(
    computeBrandHealthState({ model: 'claude-4-sonnet', usedPercent: 35, usedTokens: 40000, totalCallsCount: 4, latestCacheHitRate: 92 }, { alerts: { contextWarningPct: 75, cacheDropThresholdPct: 50 } }, { visible: false }),
    'safe'
  );
});

test('mcp-app-client.mjs: full SEP-1865 handshake, tools/call, ui/* methods, ping/teardown, notifications & theme sync under mock postMessage host', async () => {
  const clientSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/ui/core/mcp-app-client.mjs'), 'utf8');
  assert.equal(clientSrc.includes('max-content'), false, 'mcp-app-client must not perform legacy max-content reflow');
  assert.equal(/zod/i.test(clientSrc), false, 'mcp-app-client must have zero zod references');

  // Minimal mock window/document for postMessage + theme helpers
  const listeners = new Set();
  const mockWindow = {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  };
  const hostSentToClient = (data) => {
    for (const fn of [...listeners]) {
      fn({ data, source: mockHost });
    }
  };

  const hostReceived = [];
  const mockHost = {
    postMessage(msg) {
      hostReceived.push(msg);
      if (msg.method === 'ui/initialize') {
        queueMicrotask(() => {
          hostSentToClient({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              hostInfo: { name: 'Antigravity', version: '2.0.0' },
              hostCapabilities: { message: { text: {} }, updateModelContext: { text: {} }, openLinks: {} },
              hostContext: { theme: 'dark', styles: { variables: { '--color-background-primary': '#111113' } } },
            },
          });
        });
      } else if (msg.method === 'tools/call') {
        queueMicrotask(() => {
          hostSentToClient({
            jsonrpc: '2.0',
            id: msg.id,
            result: { structuredContent: { ok: true, echoed: msg.params } },
          });
        });
      } else if (
        msg.method === 'ui/message' ||
        msg.method === 'ui/update-model-context' ||
        msg.method === 'ui/open-link' ||
        msg.method === 'com.google.antigravity/toggle-aux-pane'
      ) {
        queueMicrotask(() => {
          hostSentToClient({ jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } });
        });
      }
    },
  };

  const transport = new PostMessageTransport(mockHost, mockHost, mockWindow);
  const app = new App({ name: 'Antigravity Hub', version: '1.6.0' }, {});

  const events = [];
  app.ontoolinput = (p) => events.push({ type: 'toolinput', p });
  app.ontoolinputpartial = (p) => events.push({ type: 'toolinputpartial', p });
  app.ontoolresult = (p) => events.push({ type: 'toolresult', p });
  app.ontoolcancelled = (p) => events.push({ type: 'toolcancelled', p });
  app.onhostcontextchanged = (p) => events.push({ type: 'hostcontextchanged', p });

  let teardownCalled = false;
  app.onteardown = async () => {
    teardownCalled = true;
    return {};
  };

  await app.connect(transport);
  assert.equal(app.getHostVersion().name, 'Antigravity');
  assert.equal(app.getHostContext().theme, 'dark');
  assert.equal(Boolean(app.getHostCapabilities().message), true);
  assert.ok(hostReceived.some((m) => m.method === 'ui/initialize' && m.params.protocolVersion === '2026-01-26'));
  assert.ok(hostReceived.some((m) => m.method === 'ui/notifications/initialized'));

  // Outbound calls
  const toolRes = await app.callServerTool({ name: 'app_review_manage', arguments: { action: 'status' } });
  assert.equal(toolRes.structuredContent.ok, true);
  assert.equal(toolRes.structuredContent.echoed.name, 'app_review_manage');

  const msgRes = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Fix issue' }] });
  assert.equal(msgRes.method, 'ui/message');

  const ctxRes = await app.updateModelContext({ content: [{ type: 'text', text: 'capsule' }] });
  assert.equal(ctxRes.method, 'ui/update-model-context');

  const linkRes = await app.openLink({ url: 'https://example.com' });
  assert.equal(linkRes.method, 'ui/open-link');

  const customRes = await app.request({ method: 'com.google.antigravity/toggle-aux-pane', params: { open: true } });
  assert.equal(customRes.method, 'com.google.antigravity/toggle-aux-pane');

  // Inbound notifications
  hostSentToClient({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { module: 'review' } } });
  hostSentToClient({ jsonrpc: '2.0', method: 'ui/notifications/tool-input-partial', params: { arguments: { module: 'rev' } } });
  hostSentToClient({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { ready: true } } });
  hostSentToClient({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: 'user action' } });
  hostSentToClient({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', locale: 'zh-CN' } });

  assert.equal(events.length, 5);
  assert.equal(events[3].type, 'toolcancelled');
  assert.equal(events[3].p.reason, 'user action');
  assert.equal(app.getHostContext().theme, 'light');
  assert.equal(app.getHostContext().locale, 'zh-CN');

  // Inbound host requests: ping & ui/resource-teardown
  hostSentToClient({ jsonrpc: '2.0', id: 901, method: 'ping', params: {} });
  hostSentToClient({ jsonrpc: '2.0', id: 902, method: 'ui/resource-teardown', params: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(hostReceived.some((m) => m.id === 901 && m.result && typeof m.result === 'object'));
  assert.equal(teardownCalled, true);
  assert.ok(hostReceived.some((m) => m.id === 902 && m.result && typeof m.result === 'object'));

  // Style helpers on synthetic document
  const styleProps = new Map();
  const attrs = new Map();
  const classes = new Set();
  const headChildren = [];
  const prevDoc = globalThis.document;
  globalThis.document = {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: (k) => attrs.get(k) ?? null,
      classList: {
        toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      style: {
        colorScheme: '',
        setProperty: (k, v) => styleProps.set(k, v),
      },
    },
    head: { appendChild: (el) => headChildren.push(el) },
    getElementById: (id) => headChildren.find((c) => c.id === id) || null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
  };
  try {
    applyDocumentTheme('dark');
    assert.equal(getDocumentTheme(), 'dark');
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.equal(classes.has('dark'), true);
    applyHostStyleVariables({ '--color-background-primary': '#111113', ignored: 'nope' });
    assert.equal(styleProps.get('--color-background-primary'), '#111113');
    assert.equal(styleProps.has('ignored'), false);
    applyHostFonts('@font-face { font-family: Test; }');
    applyHostFonts('@font-face { font-family: Dup; }');
    assert.equal(headChildren.length, 1);
  } finally {
    globalThis.document = prevDoc;
  }

  await app.close();
  assert.equal(listeners.size, 0);
});

test('native-chrome.mjs: 4px drag threshold gesture machine & zero-reflow mini-bar chip fitter', async () => {
  // 1. 4px drag threshold gesture state machine
  const winListeners = new Map();
  const mockWin = {
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { winListeners.get(t)?.delete(fn); },
    emit(t, ev) { for (const fn of [...(winListeners.get(t) || [])]) fn(ev); },
  };
  const elListeners = new Map();
  const mockEl = {
    addEventListener(t, fn) {
      if (!elListeners.has(t)) elListeners.set(t, new Set());
      elListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) { elListeners.get(t)?.delete(fn); },
    emit(t, ev) { for (const fn of [...(elListeners.get(t) || [])]) fn(ev); },
  };

  let drags = 0;
  let singles = 0;
  let doubles = 0;
  let menus = 0;
  const unbind = bindNativeDragSurface(mockEl, {
    ignoreSelector: 'button',
    thresholdPx: 4,
    singleClickDelayMs: 25,
    hostWindow: mockWin,
    onDragStart: () => { drags++; },
    onSingleClick: () => { singles++; },
    onDoubleClick: () => { doubles++; },
    onContextMenu: () => { menus++; },
  });

  // Sub-4px jitter + click -> no drag, triggers single click
  mockEl.emit('pointerdown', { button: 0, screenX: 100, screenY: 100, target: {} });
  mockWin.emit('pointermove', { screenX: 102, screenY: 101 });
  mockWin.emit('pointerup', {});
  mockEl.emit('click', { target: {} });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(drags, 0);
  assert.equal(singles, 1);

  // Double click cancels pending single click
  mockEl.emit('click', { target: {} });
  mockEl.emit('dblclick', { target: {}, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(singles, 1);
  assert.equal(doubles, 1);

  // >= 4px movement triggers drag immediately and suppresses click
  mockEl.emit('pointerdown', { button: 0, screenX: 100, screenY: 100, target: {} });
  mockWin.emit('pointermove', { screenX: 105, screenY: 100 });
  mockWin.emit('pointerup', {});
  mockEl.emit('click', { target: {} });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(drags, 1);
  assert.equal(singles, 1);

  // Right click triggers context menu
  mockEl.emit('contextmenu', { preventDefault() {} });
  assert.equal(menus, 1);
  unbind();

  // 2. Zero-reflow mini-bar fit planner
  const chips = [
    { mod: 'context', available: true, text: '18.4%' },
    { mod: 'cache', available: true, text: '96% 缓存' },
    { mod: 'kv', available: true, text: '12:40' },
    { mod: 'tps', available: true, text: '48.2 t/s' },
    { mod: 'model', available: true, text: 'gemini-4-hydrogen-high', shortText: '4-hydro-H' },
  ];

  // Wide container -> all 5 chips visible with full model name
  const widePlan = computeMiniBarFitPlan({ chips, availWidth: 520 });
  for (const mod of MINI_BAR_DEFAULT_ORDER) {
    assert.equal(widePlan.get(mod).visible, true, `Expected ${mod} visible at 520px`);
  }
  assert.equal(widePlan.get('model').useShortModel, false);

  // Medium container -> switches model to compact short name before hiding any chip
  const medWidth =
    estimateChipWidthPx('18.4%') +
    estimateChipWidthPx('96% 缓存') +
    estimateChipWidthPx('12:40', { hasDot: true }) +
    estimateChipWidthPx('48.2 t/s') +
    estimateChipWidthPx('4-hydro-H') +
    24;
  const medPlan = computeMiniBarFitPlan({ chips, availWidth: medWidth });
  assert.equal(medPlan.get('model').visible, true);
  assert.equal(medPlan.get('model').useShortModel, true);

  // Narrow container -> hides trailing chips from right to left, preserves highest priority left chips
  const narrowPlan = computeMiniBarFitPlan({ chips, availWidth: 165 });
  assert.equal(narrowPlan.get('context').visible, true);
  assert.equal(narrowPlan.get('cache').visible, true);
  assert.equal(narrowPlan.get('model').visible, false);

  // 3. Host sizemove message pauses polling/animations & persists geometry on release
  const st = createUiState();
  let sizeMoveFlag = null;
  const savedPatches = [];
  const chrome = createNativeChromeModule({
    state: st,
    tr: (k) => k,
    getUiLang: () => 'zh-CN',
    isNativePopout: true,
    persistConfigPatch: async (p) => { savedPatches.push(p); },
    showToast: () => {},
    onSizeMoveChange: (active) => { sizeMoveFlag = active; },
    postMsg: () => {},
  });
  chrome.handleHostMessage({ type: 'host:sizemove', active: true });
  assert.equal(st.sizeMoveActive, true);
  assert.equal(sizeMoveFlag, true);
  chrome.handleHostMessage({
    type: 'host:sizemove',
    active: false,
    mode: 'console',
    logicalWidth: 520,
    logicalHeight: 740,
    x: 1000,
    y: 80,
  });
  assert.equal(st.sizeMoveActive, false);
  assert.equal(savedPatches.length, 1);
  assert.equal(savedPatches[0].popout.size, '520x740');
});

test('rpc.mjs & monitor-calls.mjs: lastRev short-circuit, concurrent deduplication & in-place row expand', async () => {
  // 1. RPC lastRev short-circuit & concurrent dedupe
  let rpcCalls = 0;
  const fakeApp = {
    async callServerTool({ name, arguments: args }) {
      rpcCalls++;
      await new Promise((r) => setTimeout(r, 10));
      if (args.lastRev === 'rev-abc123') {
        return { structuredContent: { unchanged: true, rev: 'rev-abc123' } };
      }
      return { structuredContent: { rev: 'rev-abc123', usedPercent: 42.5, tool: name } };
    },
  };
  const rpc = createRpcClient({ getMcpApp: () => fakeApp });

  // Concurrent identical reads dedupe to 1 call
  const [r1, r2] = await Promise.all([
    rpc.callAppTool('app_get_context_breakdown', { followActive: true }, { useRevCache: true }),
    rpc.callAppTool('app_get_context_breakdown', { followActive: true }, { useRevCache: true }),
  ]);
  assert.equal(rpcCalls, 1);
  assert.equal(r1.rev, 'rev-abc123');
  assert.equal(r2.usedPercent, 42.5);

  // Subsequent poll sends lastRev and gets cached data back with unchanged: true
  const r3 = await rpc.callAppTool('app_get_context_breakdown', { followActive: true }, { useRevCache: true });
  assert.equal(rpcCalls, 2);
  assert.equal(r3.unchanged, true);
  assert.equal(r3.usedPercent, 42.5);

  rpc.invalidateRev();
  assert.equal(rpc.getCachedRevCount(), 0);

  // 2. Monitor calls in-place expand/collapse (no tbody.innerHTML rewrite on expand)
  const st = createUiState();
  st.callsData = {
    totalCallsCount: 1,
    calls: [
      {
        callUid: 'c-1',
        agentType: 'main',
        agentTag: '主',
        stepIndex: 1,
        model: 'gemini-4-neon-high',
        effectiveTps: 65.2,
        durationMs: 2400,
        ttftMs: 400,
        contextTokens: 20000,
        thinkingTokensEst: 300,
        contentTokensEst: 700,
        cacheReadTokens: 18000,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheHitRate: 90,
        estimatedCostUsd: 0.012,
        timingSource: 'hook_ms',
        cacheDrop: false,
      },
    ],
    summary: { byAgent: [], byModel: [] },
  };

  let innerHtmlWrites = 0;
  let insertedAnatomy = [];
  const fakeRow = {
    dataset: { callId: 'c-1', expanded: 'false' },
    insertAdjacentHTML(pos, html) {
      insertedAnatomy.push({ pos, html });
    },
  };
  const fakeTbody = {
    set innerHTML(_v) { innerHtmlWrites++; },
    querySelectorAll(sel) {
      if (sel.includes('call-anatomy-row')) {
        return insertedAnatomy.map((_, i) => ({ remove() { insertedAnatomy.splice(i, 1); } }));
      }
      if (sel.includes('tr.call-row')) return [fakeRow];
      return [];
    },
  };
  const prevDoc = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (id === 'callsTbody') return fakeTbody;
      return null;
    },
  };
  try {
    const callsMod = createMonitorCallsModule({
      state: st,
      tr: (k) => k,
      getUiLang: () => 'zh-CN',
      callAppTool: async () => st.callsData,
      renderCallsSelects: () => {},
      positionIndicator: () => {},
    });
    callsMod.toggleCallExpand('c-1');
    assert.equal(innerHtmlWrites, 0, 'toggleCallExpand must NOT rewrite tbody.innerHTML');
    assert.equal(fakeRow.dataset.expanded, 'true');
    assert.equal(insertedAnatomy.length, 1);
    assert.equal(insertedAnatomy[0].pos, 'afterend');
    assert.ok(insertedAnatomy[0].html.includes('call-anatomy-row'));

    callsMod.toggleCallExpand('c-1');
    assert.equal(fakeRow.dataset.expanded, 'false');
    assert.equal(insertedAnatomy.length, 0);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('esbuild bundle gate: new modular architecture bundles with 0 zod bytes and buildUi() <= 475 KiB (486,400 B)', async () => {
  // 1. Real esbuild bundle of the entire new modular core + components + modules
  const virtualEntry = `
    export * from './src/ui/core/mcp-app-client.mjs';
    export * from './src/ui/core/store.mjs';
    export * from './src/ui/core/dom.mjs';
    export * from './src/ui/core/rpc.mjs';
    export * from './src/ui/components/icons.mjs';
    export * from './src/ui/components/custom-select.mjs';
    export * from './src/ui/components/modal.mjs';
    export * from './src/ui/modules/monitor-context.mjs';
    export * from './src/ui/modules/monitor-calls.mjs';
    export * from './src/ui/modules/monitor-vault.mjs';
    export * from './src/ui/modules/settings-module.mjs';
    export * from './src/ui/modules/native-chrome.mjs';
  `;
  const modBuild = await esbuild.build({
    stdin: { contents: virtualEntry, resolveDir: ROOT_DIR, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
  });
  const modCode = modBuild.outputFiles[0].text;
  const modBytes = Buffer.byteLength(modCode, 'utf8');
  assert.equal(/zod/i.test(modCode), false, 'Bundled new UI modules must contain 0 bytes of zod');
  assert.ok(modBytes < 140_000, `Expected minified new modular layer < 140 KiB, got ${modBytes} B`);

  // 2. Full single-file HTML build via build-ui.mjs (in-memory, write: false)
  const built = await buildUi({ write: false });
  assert.ok(
    built.byteSize <= MAX_UI_BUNDLE_BYTES,
    `Expected full dashboard.html <= ${MAX_UI_BUNDLE_BYTES} B (475 KiB), got ${built.byteSize} B (${(built.byteSize / 1024).toFixed(1)} KiB)`
  );
  assert.ok(built.cssBytes < 80_000, `Expected minified Radix CSS < 80 KiB, got ${built.cssBytes} B`);
});
