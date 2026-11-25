import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDataPaths } from '../core/paths.mjs';
import { atomicWriteJson, ensureDataDirs, readJsonSafe } from '../core/storage.mjs';
import { loadConfig, saveConfig } from '../core/config.mjs';
import { PopoutServerManager } from '../core/popout-server.mjs';
import { resolveTargetSession } from '../core/session-tracker.mjs';
import { handleOpenMonitor, handleGetContextBreakdown } from './handlers/context.mjs';
import { handleGetCalls, handleGetQuota, handleCalibrateQuota } from './handlers/telemetry.mjs';
import { handleCtxBrief, handleCtxSave, handleCtxSearch, handleVaultManage } from './handlers/vault.mjs';
import { handleConfigManage } from './handlers/config.mjs';
import { handleCtxDoctor, handleDoctorAction } from './handlers/doctor.mjs';
import { handleI18nManage, handleGovernanceManage, handleAppearanceManage } from './handlers/extensions.mjs';
import { dispatchReviewTool } from './handlers/review.mjs';
import { APP_RESOURCE_URI, APP_RESOURCE_MIME, TOOL_DEFINITIONS } from './tool-definitions.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export { APP_RESOURCE_URI, APP_RESOURCE_MIME, TOOL_DEFINITIONS };
export const SERVER_INFO = {
  name: 'context-cache-server',
  version: '1.6.0',
};

const WALLPAPER_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

const MAX_WALLPAPER_STREAM_BYTES = 15 * 1024 * 1024;
const uiHtmlCache = new Map();
const MAX_UI_HTML_CACHE = 4;

function resolveUiHtmlPath(options = {}) {
  const candidates = [
    options.uiHtmlPath,
    process.env.CONTEXT_CACHE_APP_HTML,
    path.join(ROOT_DIR, 'dist', 'dashboard.html'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1];
}

function readUiHtml(options = {}) {
  const htmlPath = resolveUiHtmlPath(options);
  try {
    const stat = fs.statSync(htmlPath);
    const cached = uiHtmlCache.get(htmlPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.html;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (uiHtmlCache.size >= MAX_UI_HTML_CACHE && !uiHtmlCache.has(htmlPath)) {
      const oldestKey = uiHtmlCache.keys().next().value;
      if (oldestKey !== undefined) uiHtmlCache.delete(oldestKey);
    }
    uiHtmlCache.set(htmlPath, { mtimeMs: stat.mtimeMs, size: stat.size, html });
    return html;
  } catch {
    uiHtmlCache.delete(htmlPath);
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>Context Cache</title></head><body><div style="font-family:system-ui,sans-serif;padding:24px;"><h3>UI 尚未构建</h3><p>请在源码目录执行 <code>npm run build:ui</code> 或 <code>npm run deploy</code>。</p></div></body></html>`;
  }
}

function resolveSafeWallpaper(rawId, options = {}) {
  const id = String(rawId || '').trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) return null;
  const fileName = id.startsWith('lib:') ? id.slice(4) : id;
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || fileName.includes('\0')) {
    return null;
  }
  const mime = WALLPAPER_MIME_BY_EXT[path.extname(fileName).toLowerCase()];
  if (!mime) return null;

  const { wallpapersDir } = getDataPaths(options);
  const resolvedRoot = path.resolve(wallpapersDir);
  const targetPath = path.resolve(resolvedRoot, fileName);
  const rel = path.relative(resolvedRoot, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  try {
    if (!fs.existsSync(targetPath)) return null;
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(targetPath);
    const realRel = path.relative(realRoot, realTarget);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    const stat = fs.statSync(realTarget);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WALLPAPER_STREAM_BYTES) return null;
    return { filePath: realTarget, mime };
  } catch {
    return null;
  }
}

function toolErr(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message || 'Unknown error') }],
  };
}

export async function maybeAutoLaunchPopoutOnStartup({
  popout,
  options = {},
  ppid = process.ppid,
  env = process.env,
} = {}) {
  if (!popout || options.enableStartupAutoPopout !== true) {
    return { launched: false, reason: 'disabled_by_option' };
  }
  if (env?.CONTEXT_CACHE_DISABLE_AUTOSTART === '1' || env?.NODE_TEST_CONTEXT) {
    return { launched: false, reason: 'disabled_by_env' };
  }
  const cfg = loadConfig(options);
  if (cfg.popout?.autoLaunchOnStartup === false) {
    return { launched: false, reason: 'disabled_in_config' };
  }
  if (typeof popout.hasActiveClient === 'function' && popout.hasActiveClient()) {
    return { launched: false, reason: 'already_active' };
  }

  const paths = ensureDataDirs(options);
  const stateFile = path.join(paths.dataDir, 'autostart-state.json');
  const hostPpid = Number(ppid) || 0;
  const prev = readJsonSafe(stateFile, null);
  if (hostPpid > 0 && prev && Number(prev.ppid) === hostPpid) {
    return { launched: false, reason: 'already_launched_for_host_pid' };
  }

  try {
    atomicWriteJson(stateFile, { ppid: hostPpid, pid: process.pid, launchedAt: new Date().toISOString() });
  } catch {
    /* fail-open */
  }

  try {
    if (!cfg.popout?.enabled) {
      saveConfig({ popout: { enabled: true } }, options);
    }
    const status = await popout.launchWindow({
      size: cfg.popout?.size || '460x720',
      position: cfg.popout?.position || null,
      alwaysOnTop: cfg.popout?.alwaysOnTop !== false,
    });
    return { launched: true, reason: 'launched', status };
  } catch (err) {
    return { launched: false, reason: 'launch_failed', error: String(err?.message || err) };
  }
}

export function createMcpDispatcher(options = {}) {
  let startupAutoLaunchTimer = null;
  let startupAutoLaunchTriggered = false;

  const scheduleStartupAutoPopout = (delayMs = 1000) => {
    if (startupAutoLaunchTriggered || options.enableStartupAutoPopout !== true) return;
    startupAutoLaunchTriggered = true;
    startupAutoLaunchTimer = setTimeout(() => {
      startupAutoLaunchTimer = null;
      void maybeAutoLaunchPopoutOnStartup({ popout, options }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
    startupAutoLaunchTimer.unref?.();
  };

  const defaultWorkspace = options.projectDir || process.env.CONTEXT_CACHE_WORKSPACE || process.cwd();
  const ACTIVE_CONV_TTL_MS = 6_500;
  let activeConvCache = { value: null, expiresAt: 0 };

  const getCachedActiveConversationId = () => {
    const now = Date.now();
    if (now < activeConvCache.expiresAt) return activeConvCache.value;
    const target = resolveTargetSession({ followActive: true, fallbackProjectDir: defaultWorkspace }, options);
    const convId = target.conversationId || null;
    activeConvCache = { value: convId, expiresAt: now + ACTIVE_CONV_TTL_MS };
    return convId;
  };

  const invalidateActiveConvCache = (nextConvId = undefined) => {
    activeConvCache =
      nextConvId !== undefined
        ? { value: nextConvId || null, expiresAt: Date.now() + ACTIVE_CONV_TTL_MS }
        : { value: null, expiresAt: 0 };
  };

  const popout = new PopoutServerManager({
    getHtml: () => readUiHtml(options),
    dataDir: options.dataDir || null,
    getActiveConversationId: getCachedActiveConversationId,
    resolveWallpaper: (id) => resolveSafeWallpaper(id, options),
    handleAppTool: async (name, args) => callTool(name, args),
    onAutoStop: () => {
      try {
        saveConfig({ popout: { enabled: false } }, options);
      } catch {
        /* ignore config write error on shutdown */
      }
    },
  });

  async function callTool(name, rawArgs = {}, rpcMeta = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const meta = rpcMeta && typeof rpcMeta === 'object' ? rpcMeta : {};
    const projectDir = args.projectDir || defaultWorkspace;
    const ctx = { meta, projectDir, defaultWorkspace, options, popout, invalidateActiveConvCache };

    try {
      switch (name) {
        case 'ctx_open_monitor':
          return handleOpenMonitor(args, ctx);
        case 'ctx_brief':
          return handleCtxBrief(args, ctx);
        case 'ctx_save':
          return handleCtxSave(args, ctx);
        case 'ctx_search':
          return handleCtxSearch(args, ctx);
        case 'ctx_doctor':
          return await handleCtxDoctor(args, options);
        case 'app_get_context_breakdown':
          return handleGetContextBreakdown(args, ctx);
        case 'app_get_calls':
          return handleGetCalls(args, ctx);
        case 'app_get_quota':
          return handleGetQuota(options);
        case 'app_calibrate_quota':
          return handleCalibrateQuota(args, options);
        case 'app_vault_manage':
          return handleVaultManage(args, ctx);
        case 'app_config_manage':
          return await handleConfigManage(args, ctx);
        case 'app_doctor_action':
          return await handleDoctorAction(args, options);
        case 'app_i18n_manage':
          return await handleI18nManage(args, options);
        case 'app_governance_manage':
          return handleGovernanceManage(args, options);
        case 'app_appearance_manage':
          return await handleAppearanceManage(args, options);
        case 'app_review_manage':
          return await dispatchReviewTool(args, { ...options, defaultWorkspace });
        default:
          return toolErr(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return toolErr(err?.message || String(err));
    }
  }

  async function handleJsonRpc(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const replyError = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

    if (method === 'initialize') {
      const clientVer = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
      scheduleStartupAutoPopout(options.startupAutoPopoutDelayMs ?? 1200);
      return reply({
        protocolVersion: clientVer,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      if (method === 'notifications/initialized') scheduleStartupAutoPopout(options.startupAutoPopoutDelayMs ?? 800);
      return null;
    }
    if (method === 'ping') return reply({});
    if (method === 'resources/list') {
      return reply({
        resources: [
          {
            uri: APP_RESOURCE_URI,
            name: 'Context Cache & Telemetry Monitor',
            description: 'Single-file Antigravity native MCP App dashboard for context inspection, code review, governance, wallpaper, and localization.',
            mimeType: APP_RESOURCE_MIME,
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      });
    }
    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri !== APP_RESOURCE_URI) return replyError(-32002, `Resource not found: ${uri}`);
      return reply({
        contents: [
          {
            uri: APP_RESOURCE_URI,
            mimeType: APP_RESOURCE_MIME,
            text: readUiHtml(options),
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      });
    }
    if (method === 'tools/list') return reply({ tools: TOOL_DEFINITIONS });
    if (method === 'tools/call') {
      return reply(await callTool(params?.name, params?.arguments || {}, params?._meta || {}));
    }
    return replyError(-32601, `Method not found: ${method}`);
  }

  async function close() {
    if (startupAutoLaunchTimer) {
      clearTimeout(startupAutoLaunchTimer);
      startupAutoLaunchTimer = null;
    }
    await popout.stop();
  }

  return { handleJsonRpc, callTool, close, popout };
}

export function startStdioServer(options = {}) {
  const dispatcher = createMcpDispatcher({
    ...options,
    enableStartupAutoPopout: options.enableStartupAutoPopout !== false,
  });
  let buffer = Buffer.alloc(0);
  let useContentLength = false;

  const writeResponse = (resp) => {
    if (!resp) return;
    const json = JSON.stringify(resp);
    if (useContentLength) {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      process.stdout.write(json + '\n');
    }
  };

  const processMessage = async (rawStr) => {
    const trimmed = rawStr.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    writeResponse(await dispatcher.handleJsonRpc(parsed));
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      let start = 0;
      while (start < buffer.length && (buffer[start] === 0x0d || buffer[start] === 0x0a)) start++;
      if (start > 0) buffer = buffer.subarray(start);
      if (buffer.length === 0) break;

      const prefix = buffer.subarray(0, Math.min(32, buffer.length)).toString('ascii');
      if (/^Content-Length:/i.test(prefix)) {
        useContentLength = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const m = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
        if (!m) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const totalNeed = headerEnd + 4 + Number(m[1]);
        if (buffer.length < totalNeed) break;
        const body = buffer.subarray(headerEnd + 4, totalNeed).toString('utf8');
        buffer = buffer.subarray(totalNeed);
        void processMessage(body);
      } else {
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) break;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        void processMessage(line);
      }
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    drainBuffer();
  });

  const shutdown = async () => {
    await dispatcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.resume();

  return dispatcher;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  startStdioServer();
}
