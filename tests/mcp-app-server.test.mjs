import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildUi } from '../src/ui/build-ui.mjs';
import { PopoutServerManager } from '../src/core/popout-server.mjs';

const SERVER_SCRIPT = path.resolve('src/mcp/server.mjs');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createJsonRpcClient(child) {
  let buf = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }, 8000);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

test('MCP App Stdio Server serves ui:// single-file HTML, exposes 5 model + 8 app-only tools, and handles all 13 tools cleanly', async () => {
  const root = makeTmpDir('cc-mcp-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');
  const workspaceDir = path.join(root, 'workspace');
  const uiOut = path.join(root, 'dashboard.html');

  fs.mkdirSync(workspaceDir, { recursive: true });
  await buildUi({ outPath: uiOut });

  const child = spawn(process.execPath, ['--no-warnings', SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      CONTEXT_CACHE_DATA_DIR: dataDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      CONTEXT_CACHE_WORKSPACE: workspaceDir,
      CONTEXT_CACHE_APP_HTML: uiOut,
    },
  });

  try {
    const client = createJsonRpcClient(child);

    // 1. initialize
    const initResp = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-harness', version: '1.0.0' },
    });
    assert.equal(initResp.result.serverInfo.name, 'context-cache-server');
    assert.equal(initResp.result.serverInfo.version, '1.5.5');
    assert.ok(initResp.result.capabilities.tools);
    assert.ok(initResp.result.capabilities.resources);
    client.notify('notifications/initialized', {});

    // 2. resources/list & resources/read
    const resList = await client.request('resources/list');
    assert.equal(resList.result.resources.length, 1);
    assert.equal(resList.result.resources[0].uri, 'ui://context-cache/dashboard.html');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal(resList.result.resources[0]._meta.ui.prefersBorder, false);

    const resRead = await client.request('resources/read', { uri: 'ui://context-cache/dashboard.html' });
    const html = resRead.result.contents[0].text;
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(html.length > 5000 && Buffer.byteLength(html, 'utf8') < 10 * 1024 * 1024);
    assert.ok(!/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html), 'UI HTML must have zero external script/link URLs');
    assert.ok(!html.includes('runLiveChangeDemo'), 'Formal UI must remove temporary preview demo controls');
    assert.match(html, /class="seg-tab hidden"[^>]*data-tab="quota"/, 'Quota tab must be hidden from user-facing UI');
    assert.ok(html.includes('globalLauncherView'), 'Left-sidebar floating launcher view must exist');
    assert.ok(html.includes('followToggleBtn'), 'Auto-follow toggle button must exist');
    assert.ok(html.includes('nativeTitleBar') && html.includes('winPinBtn'), 'Custom frameless titlebar and Always-on-Top pin button must exist');
    assert.ok(html.includes('nativeResizeHandles'), '8-direction resize handles must exist');
    assert.ok(html.includes('data:image/svg+xml'), 'Inline SVG brand favicon must exist');
    const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html);
    assert.ok(scriptMatch && scriptMatch[1].length > 1000, 'Inline script must exist');
    assert.doesNotThrow(() => new Function(scriptMatch[1]), 'Inline script must be syntactically valid JavaScript');

    // 3. tools/list — verify exact 5 model-visible + 10 app-only isolation
    const toolsResp = await client.request('tools/list');
    const tools = toolsResp.result.tools;
    assert.equal(tools.length, 15);

    const modelVisible = tools.filter((t) => t._meta?.ui?.visibility?.includes('model'));
    const appOnly = tools.filter((t) => JSON.stringify(t._meta?.ui?.visibility) === JSON.stringify(['app']));
    assert.equal(modelVisible.length, 5);
    assert.equal(appOnly.length, 10);
    assert.ok(appOnly.some((t) => t.name === 'app_i18n_manage'));
    assert.ok(appOnly.some((t) => t.name === 'app_governance_manage'));
    assert.ok(appOnly.some((t) => t.name === 'app_appearance_manage'));

    const openMon = tools.find((t) => t.name === 'ctx_open_monitor');
    assert.equal(openMon._meta.ui.resourceUri, 'ui://context-cache/dashboard.html');
    assert.deepEqual(
      openMon._meta['com.google.antigravity/ui'].entrypoints.map((e) => e.type),
      ['aux_pane', 'global']
    );

    // 4. Call all 5 model-visible tools
    const rOpen = await client.request('tools/call', { name: 'ctx_open_monitor', arguments: { tab: 'quota' } });
    assert.ok(!rOpen.result.isError);
    assert.ok(rOpen.result.structuredContent.context);
    assert.equal(rOpen.result.structuredContent.initialTab, 'context', 'Hidden quota tab should normalize to context');

    const rSave = await client.request('tools/call', {
      name: 'ctx_save',
      arguments: { kind: 'decision', title: 'MCP Dual Visibility', summary: 'Keep 7 UI tools app-only.', tags: ['mcp'] },
    });
    assert.ok(!rSave.result.isError);
    const savedId = rSave.result.structuredContent.id;

    const rBrief = await client.request('tools/call', { name: 'ctx_brief', arguments: {} });
    assert.ok(!rBrief.result.isError);
    assert.match(rBrief.result.content[0].text, /\[CTX-BRIEF\]/);

    const rSearch = await client.request('tools/call', { name: 'ctx_search', arguments: { query: 'Visibility' } });
    assert.ok(!rSearch.result.isError);
    assert.equal(rSearch.result.structuredContent.count, 1);

    const rDoctor = await client.request('tools/call', { name: 'ctx_doctor', arguments: { repair: false } });
    assert.ok(!rDoctor.result.isError);
    assert.ok(rDoctor.result.structuredContent.report);

    // 5. Call all 8 app-only tools
    const aCtx = await client.request('tools/call', { name: 'app_get_context_breakdown', arguments: {} });
    assert.ok(!aCtx.result.isError);
    assert.ok(Array.isArray(aCtx.result.structuredContent.breakdown));

    // v1.5.4: read-only redacted asset preview via app_get_context_breakdown(action='preview_asset')
    const wsRulePath = path.join(workspaceDir, 'AGENTS.md');
    fs.writeFileSync(wsRulePath, '# Workspace Rule\nToken: sk-proj-1234567890abcdefghijklmnop\n');
    const aPreviewOk = await client.request('tools/call', {
      name: 'app_get_context_breakdown',
      arguments: { action: 'preview_asset', filePath: wsRulePath, projectDir: workspaceDir },
    });
    assert.ok(!aPreviewOk.result.isError);
    assert.equal(aPreviewOk.result.structuredContent.redacted, true);
    assert.ok(!aPreviewOk.result.structuredContent.content.includes('sk-proj-1234567890abcdefghijklmnop'));
    assert.match(aPreviewOk.result.structuredContent.content, /\[REDACTED/);

    const outsidePath = path.join(root, 'outside.md');
    fs.writeFileSync(outsidePath, 'forbidden');
    const aPreviewDeny = await client.request('tools/call', {
      name: 'app_get_context_breakdown',
      arguments: { action: 'preview_asset', filePath: outsidePath, projectDir: workspaceDir },
    });
    assert.equal(aPreviewDeny.result.isError, true);

    const aCalls = await client.request('tools/call', { name: 'app_get_calls', arguments: {} });
    assert.ok(!aCalls.result.isError);
    assert.ok(Array.isArray(aCalls.result.structuredContent.calls));

    const aQuota = await client.request('tools/call', { name: 'app_get_quota', arguments: {} });
    assert.ok(!aQuota.result.isError);
    assert.equal(aQuota.result.structuredContent.groups.length, 3);

    const aCal = await client.request('tools/call', {
      name: 'app_calibrate_quota',
      arguments: { groupId: 'gemini', weeklyPct: 82, weeklyHrs: 120, h5Pct: 95, h5Mins: 240 },
    });
    assert.ok(!aCal.result.isError);
    assert.equal(aCal.result.structuredContent.groups.find((g) => g.id === 'gemini').weeklyPct, 82);

    const aVaultCap = await client.request('tools/call', {
      name: 'app_vault_manage',
      arguments: {
        action: 'capsule',
        budgetPreset: 'standard',
        activeGoal: 'Test Goal',
        nextAction: 'Test Next',
      },
    });
    assert.ok(!aVaultCap.result.isError);
    assert.match(aVaultCap.result.structuredContent.agentPayload, /\[CTX-CAPSULE\]/);
    assert.equal(aVaultCap.result.structuredContent.budgetPreset, 'standard');
    assert.equal(aVaultCap.result.structuredContent.budgetTokens, 1200);
    assert.equal(aVaultCap.result.structuredContent.activeGoal, 'Test Goal');
    assert.equal(aVaultCap.result.structuredContent.nextAction, 'Test Next');

    const aVaultArch = await client.request('tools/call', { name: 'app_vault_manage', arguments: { action: 'archive', id: savedId } });
    assert.ok(!aVaultArch.result.isError);
    assert.equal(aVaultArch.result.structuredContent.archived, true);

    const aCfgGet = await client.request('tools/call', { name: 'app_config_manage', arguments: { action: 'get' } });
    assert.ok(!aCfgGet.result.isError);
    assert.equal(aCfgGet.result.structuredContent.config.popout.enabled, false);
    assert.equal(aCfgGet.result.structuredContent.popoutStatus.running, false);

    const aCfgUpd = await client.request('tools/call', {
      name: 'app_config_manage',
      arguments: { action: 'update', patch: { pollIntervalSec: 10 } },
    });
    assert.equal(aCfgUpd.result.structuredContent.config.pollIntervalSec, 10);
    assert.equal(aCfgUpd.result.structuredContent.config.popout.autoLaunchFromSidebar, true);
    assert.equal(aCfgUpd.result.structuredContent.config.popout.alwaysOnTop, true);

    const aSyncSess = await client.request('tools/call', {
      name: 'app_config_manage',
      arguments: { action: 'set_active_session', conversationId: 'conv-sync-test-1' },
    });
    assert.ok(!aSyncSess.result.isError);
    assert.equal(aSyncSess.result.structuredContent.activeSession.conversationId, 'conv-sync-test-1');
    assert.equal(aSyncSess.result.structuredContent.activeSession.source, 'ui_sync');

    const aDoc = await client.request('tools/call', { name: 'app_doctor_action', arguments: { action: 'rebuild_index' } });
    assert.ok(!aDoc.result.isError);
    assert.ok(aDoc.result.structuredContent.rebuild);

    const fakeInstallDir = path.join(root, 'empty-antigravity');
    fs.mkdirSync(fakeInstallDir, { recursive: true });

    const aI18nStatus = await client.request('tools/call', {
      name: 'app_i18n_manage',
      arguments: { action: 'status', installDirOverride: fakeInstallDir },
    });
    assert.ok(!aI18nStatus.result.isError);
    assert.ok(aI18nStatus.result.structuredContent.status);

    const aI18nDict = await client.request('tools/call', {
      name: 'app_i18n_manage',
      arguments: { action: 'list_dict', installDirOverride: fakeInstallDir },
    });
    assert.ok(!aI18nDict.result.isError);
    assert.ok(Array.isArray(aI18nDict.result.structuredContent.items));

    const aI18nUpsert = await client.request('tools/call', {
      name: 'app_i18n_manage',
      arguments: {
        action: 'upsert_entry',
        installDirOverride: fakeInstallDir,
        en: 'Test Source',
        zh: '测试目标',
        scope: 'ui',
        disabled: false,
      },
    });
    assert.ok(!aI18nUpsert.result.isError);
    assert.ok(aI18nUpsert.result.structuredContent.ok !== false);

    const aI18nCfg = await client.request('tools/call', {
      name: 'app_i18n_manage',
      arguments: {
        action: 'update_config',
        installDirOverride: fakeInstallDir,
        patch: { enabled: false },
      },
    });
    assert.ok(!aI18nCfg.result.isError);
    assert.ok(aI18nCfg.result.structuredContent.config);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PopoutServerManager binds strictly to 127.0.0.1 with token auth, tracks heartbeat, and auto-stops on closing', async () => {
  let autoStopped = false;
  const mgr = new PopoutServerManager({
    getHtml: () => '<html><body>ok</body></html>',
    handleAppTool: async (name) => ({ structuredContent: { echoed: name } }),
    stopGraceMs: 120,
    onAutoStop: () => {
      autoStopped = true;
    },
  });

  assert.equal(mgr.getStatus().running, false);
  const st = await mgr.start();
  try {
    assert.equal(st.running, true);
    assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);

    // Without token -> 403
    const unauth = await fetch(`http://127.0.0.1:${st.port}/`);
    assert.equal(unauth.status, 403);

    // With valid token -> 200 HTML
    const okHtml = await fetch(st.url);
    assert.equal(okHtml.status, 200);
    assert.match(await okHtml.text(), /ok/);

    // Token-authenticated /api/tool dispatch
    const token = new URL(st.url).searchParams.get('token');
    const apiResp = await fetch(`http://127.0.0.1:${st.port}/api/tool?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'app_get_quota', arguments: {} }),
    });
    assert.equal(apiResp.status, 200);
    const json = await apiResp.json();
    assert.equal(json.structuredContent.echoed, 'app_get_quota');

    // Heartbeat registers live client
    const hbResp = await fetch(`http://127.0.0.1:${st.port}/api/popout/heartbeat?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(hbResp.status, 200);
    assert.equal(mgr.hasActiveClient(), true);

    // Closing last client triggers automatic stop after grace window
    const closeResp = await fetch(`http://127.0.0.1:${st.port}/api/popout/closing?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(closeResp.status, 200);
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(mgr.getStatus().running, false);
    assert.equal(autoStopped, true);
  } finally {
    const stopped = await mgr.stop();
    assert.equal(stopped.running, false);
    assert.equal(stopped.port, null);
  }
});

test('PopoutServerManager cancels pending stopTimer when start() is called inside grace window', async () => {
  let autoStopped = false;
  const mgr = new PopoutServerManager({
    getHtml: () => '<html><body>ok</body></html>',
    handleAppTool: async () => ({ structuredContent: {} }),
    stopGraceMs: 180,
    onAutoStop: () => {
      autoStopped = true;
    },
  });

  try {
    const st = await mgr.start();
    const token = new URL(st.url).searchParams.get('token');
    await fetch(`http://127.0.0.1:${st.port}/api/popout/heartbeat?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c1' }),
    });
    await fetch(`http://127.0.0.1:${st.port}/api/popout/closing?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c1' }),
    });

    // Re-open inside 180ms grace window: start() must cancel pending stopTimer
    await new Promise((r) => setTimeout(r, 40));
    const st2 = await mgr.start();
    assert.equal(st2.running, true);
    assert.equal(st2.port, st.port);

    // Wait past original grace window — server must still be alive
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(mgr.getStatus().running, true);
    assert.equal(autoStopped, false);
  } finally {
    await mgr.stop();
  }
});
