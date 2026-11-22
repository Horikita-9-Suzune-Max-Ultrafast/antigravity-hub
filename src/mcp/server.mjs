import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDataPaths, formatDisplayPath } from '../core/paths.mjs';
import { loadConfig, saveConfig } from '../core/config.mjs';
import { getGitContext } from '../core/git-context.mjs';
import { rebuildIndex } from '../core/index-db.mjs';
import {
  saveMemory,
  archiveMemory,
  listMemories,
  searchMemories,
  buildCompactBrief,
  buildHandoffCapsule,
} from '../core/vault.mjs';
import { inspectContext } from '../core/context-inspector.mjs';
import { getTelemetryReport } from '../core/telemetry.mjs';
import { getQuotaSnapshot, calibrateQuotaGroup } from '../core/quota.mjs';
import { runDoctor, exportBackup, resetCircuitBreaker, repairLocalState } from '../core/doctor.mjs';
import { PopoutServerManager } from '../core/popout-server.mjs';
import { recordActiveSession, resolveTargetSession, getSessionProjectDir } from '../core/session-tracker.mjs';
import { listConversations } from '../core/transcript-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const APP_RESOURCE_URI = 'ui://context-cache/dashboard.html';
export const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';
export const SERVER_INFO = {
  name: 'context-cache-server',
  version: '1.1.0',
};

const APP_ONLY_META = { ui: { visibility: ['app'] } };

export const TOOL_DEFINITIONS = [
  // ==================== 5 Slim Model-Visible Tools ====================
  {
    name: 'ctx_open_monitor',
    title: 'Context & Telemetry Monitor',
    description: 'Open the native Context Cache & Telemetry console (context breakdown, multi-agent TPS & cache monitoring, cross-session vault).',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Optional conversation ID to inspect' },
        projectDir: { type: 'string', description: 'Optional workspace directory' },
        tab: { type: 'string', enum: ['context', 'calls', 'vault', 'settings'], description: 'Initial view tab' },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: {
        resourceUri: APP_RESOURCE_URI,
        visibility: ['model', 'app'],
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Context & Telemetry' },
          { type: 'global', title: 'Context Monitor' },
        ],
      },
    },
  },
  {
    name: 'ctx_brief',
    title: 'Get Project Context Brief',
    description: 'Return a compact (<500 tokens) cross-session project brief with Git branch/HEAD staleness info.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Workspace or repository path' },
        budgetTokens: { type: 'number', description: 'Optional token budget (max 490)' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'ctx_save',
    title: 'Save Cross-Session Memory',
    description: 'Persist a redacted project decision, architecture note, working state, or pitfall to the external Context Vault.',
    inputSchema: {
      type: 'object',
      required: ['title', 'summary'],
      properties: {
        kind: { type: 'string', enum: ['working_state', 'decision', 'architecture', 'pitfall', 'checkpoint'] },
        title: { type: 'string', description: 'Concise title' },
        summary: { type: 'string', description: 'Key conclusion, rationale, or constraint' },
        tags: { type: 'array', items: { type: 'string' } },
        projectDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'ctx_search',
    title: 'Search Cross-Session Vault',
    description: 'Full-text search (FTS5) project memories across sessions.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['all', 'working_state', 'decision', 'architecture', 'pitfall', 'checkpoint'] },
        projectDir: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'ctx_doctor',
    title: 'Run Plugin Health Diagnostics',
    description: 'Check external truth source, SQLite FTS5 index, hook contract drift, circuit breaker, and optionally repair.',
    inputSchema: {
      type: 'object',
      properties: {
        repair: { type: 'boolean', description: 'Rebuild SQLite index and reset circuit breaker if true' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },

  // ==================== 7 App-Only Private Tools (0 LLM Tokens) ====================
  {
    name: 'app_get_context_breakdown',
    title: 'App: Get Context Breakdown',
    description: 'Private UI tool returning active context breakdown, deferred MCP tools, inventories, and bloat attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        followActive: { type: 'boolean' },
        projectDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_get_calls',
    title: 'App: Get Multi-Agent Call Telemetry',
    description: 'Private UI tool returning main and subagent step calls, TPS, cache drop attribution, and summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        followActive: { type: 'boolean' },
        agentFilter: { type: 'string', enum: ['all', 'main', 'sub'] },
        modelFilter: { type: 'string' },
        onlyDrop: { type: 'boolean' },
        force: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_get_quota',
    title: 'App: Get Quota Windows',
    description: 'Private UI tool returning 5h/7d sliding window usage and calibrated remaining quotas per model group.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_calibrate_quota',
    title: 'App: Calibrate Quota Baseline',
    description: 'Private UI tool to store user-calibrated remaining quota baseline and reset window.',
    inputSchema: {
      type: 'object',
      required: ['groupId'],
      properties: {
        groupId: { type: 'string' },
        weeklyPct: { type: 'number' },
        weeklyHrs: { type: 'number' },
        h5Pct: { type: 'number' },
        h5Mins: { type: 'number' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_vault_manage',
    title: 'App: Manage Context Vault & Handoff Capsule',
    description: 'Private UI tool for listing, searching, saving, archiving memories and building dual-view handoff capsules.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'archive', 'capsule'] },
        conversationId: { type: 'string' },
        projectDir: { type: 'string' },
        query: { type: 'string' },
        kind: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        selectedDecisionIds: { type: 'array', items: { type: 'string' } },
        activeGoal: { type: 'string' },
        touchedFiles: { type: 'array', items: { type: 'string' } },
        nextAction: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_config_manage',
    title: 'App: Manage Plugin Settings & Popout Window',
    description: 'Private UI tool for reading/updating plugin settings, syncing active session across views, and controlling the optional 127.0.0.1 popout window.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'update', 'open_popout', 'close_popout', 'set_active_session'] },
        patch: { type: 'object' },
        conversationId: { type: 'string' },
        projectDir: { type: 'string' },
        forceNew: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_doctor_action',
    title: 'App: Run Doctor Maintenance Action',
    description: 'Private UI tool for diagnostics, SQLite FTS5 index rebuild, sanitized backup export, and circuit reset.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['diagnose', 'rebuild_index', 'export_backup', 'reset_circuit', 'repair'] },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
];

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
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, 'utf8');
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>Context Cache</title></head><body><div style="font-family:system-ui,sans-serif;padding:24px;"><h3>UI 尚未构建</h3><p>请在源码目录执行 <code>npm run build:ui</code> 或 <code>npm run deploy</code>。</p></div></body></html>`;
}

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function toolErr(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message || 'Unknown error') }],
  };
}

/**
 * Create a self-contained MCP request dispatcher (used by stdio server, popout server, and unit tests).
 */
export function createMcpDispatcher(options = {}) {
  const defaultWorkspace = options.projectDir || process.env.CONTEXT_CACHE_WORKSPACE || process.cwd();
  const popout = new PopoutServerManager({
    getHtml: () => readUiHtml(options),
    handleAppTool: async (name, args) => {
      const res = await callTool(name, args);
      return res;
    },
    onAutoStop: () => {
      try {
        saveConfig({ popout: { enabled: false } }, options);
      } catch {
        // ignore config write error on shutdown
      }
    },
  });

  async function callTool(name, rawArgs = {}, rpcMeta = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const meta = rpcMeta && typeof rpcMeta === 'object' ? rpcMeta : {};
    const projectDir = args.projectDir || defaultWorkspace;

    try {
      switch (name) {
        case 'ctx_open_monitor': {
          const explicitConvId = String(args.conversationId || meta.conversationId || meta.sessionId || '').trim() || null;
          if (explicitConvId) {
            recordActiveSession(
              {
                conversationId: explicitConvId,
                projectDir: args.projectDir || '',
                source: 'tool',
                event: 'ctx_open_monitor',
              },
              options
            );
          }
          const ctx = inspectContext(
            {
              conversationId: explicitConvId || undefined,
              followActive: !explicitConvId,
              projectDir,
              explicitProjectDir: args.projectDir || '',
            },
            options
          );
          const config = loadConfig(options);
          const requestedTab = args.tab === 'quota' ? 'context' : args.tab || 'context';
          const summaryText =
            `Context Monitor 已就绪：当前上下文 ${ctx.usedPercent}% (${Math.round(ctx.usedTokens / 1000)}K/${Math.round(ctx.limitTokens / 1000)}K)` +
            `，缓存命中 ${ctx.latestCacheHitRate.toFixed(1)}%，均速 ${ctx.avgTps.toFixed(1)} tok/s，预警 ${ctx.alerts.length} 项。`;
          return toolOk(summaryText, {
            initialTab: requestedTab,
            explicitConversationId: Boolean(explicitConvId),
            context: ctx,
            config,
            popoutStatus: popout.getStatus(),
          });
        }

        case 'ctx_brief': {
          const brief = buildCompactBrief(
            { projectDir, budgetTokens: args.budgetTokens },
            options
          );
          const text = brief.text || `[CTX-BRIEF] project=${brief.git.projectName} branch=${brief.git.branch}@${brief.git.head} (no saved memories yet)`;
          return toolOk(text, brief);
        }

        case 'ctx_save': {
          const saved = saveMemory(
            {
              projectDir,
              kind: args.kind || 'decision',
              title: args.title,
              summary: args.summary,
              tags: args.tags,
            },
            options
          );
          return toolOk(`已写入记忆 [${saved.kind}] ${saved.title} (${saved.id})`, saved);
        }

        case 'ctx_search': {
          const items = searchMemories(
            {
              projectDir,
              query: args.query,
              kind: args.kind || 'all',
              limit: args.limit || 20,
            },
            options
          );
          const text = items.length
            ? items.map((m) => `- [${m.kind}] ${m.title} (${m.branch}@${m.head}): ${m.summary.slice(0, 120)}`).join('\n')
            : `未找到匹配 "${args.query}" 的项目记忆。`;
          return toolOk(text, { query: args.query, count: items.length, items });
        }

        case 'ctx_doctor': {
          const data = args.repair ? repairLocalState(options) : { report: runDoctor(options) };
          const rep = data.report;
          const text = `Doctor 状态：${rep.healthy ? '健康' : '需关注'} | 漂移 ${rep.drift.count} | 熔断 ${rep.circuit.state} | 记忆 ${rep.index.dbMemories}/${rep.index.truthMemories}`;
          return toolOk(text, data);
        }

        case 'app_get_context_breakdown': {
          const followActive = args.followActive !== false && !args.conversationId;
          const ctx = inspectContext(
            {
              conversationId: args.conversationId || undefined,
              followActive,
              projectDir,
              explicitProjectDir: args.projectDir || '',
            },
            options
          );
          return toolOk('ok', ctx);
        }

        case 'app_get_calls': {
          let resolvedConvId = args.conversationId || undefined;
          let resolvedTranscript = undefined;
          if (!resolvedConvId && args.followActive !== false) {
            const target = resolveTargetSession(
              {
                followActive: true,
                sessions: listConversations({ ...options, limit: 1 }),
                fallbackProjectDir: defaultWorkspace,
              },
              options
            );
            resolvedConvId = target.conversationId || undefined;
            resolvedTranscript = target.transcriptPath || undefined;
          }
          const report = getTelemetryReport(
            {
              conversationId: resolvedConvId,
              transcriptPath: resolvedTranscript,
              agentFilter: args.agentFilter || 'all',
              modelFilter: args.modelFilter || 'all',
              onlyDrop: Boolean(args.onlyDrop),
              force: Boolean(args.force),
            },
            options
          );
          return toolOk('ok', report);
        }

        case 'app_get_quota': {
          const snapshot = getQuotaSnapshot({}, options);
          return toolOk('ok', snapshot);
        }

        case 'app_calibrate_quota': {
          const snapshot = calibrateQuotaGroup(args, options);
          return toolOk('ok', snapshot);
        }

        case 'app_vault_manage': {
          const paths = getDataPaths(options);
          let vaultProjectDir = args.projectDir || '';
          if (!vaultProjectDir) {
            if (args.conversationId) {
              vaultProjectDir = getSessionProjectDir(args.conversationId, defaultWorkspace, options);
            } else {
              const target = resolveTargetSession(
                {
                  followActive: true,
                  sessions: listConversations({ ...options, limit: 1 }),
                  fallbackProjectDir: defaultWorkspace,
                },
                options
              );
              vaultProjectDir = target.projectDir || defaultWorkspace;
            }
          }
          const git = getGitContext(vaultProjectDir);
          const storagePath = formatDisplayPath(path.join(paths.projectsDir, git.projectId));

          if (args.action === 'list') {
            const items = args.query
              ? searchMemories({ projectDir: vaultProjectDir, query: args.query, kind: args.kind || 'all', limit: 60 }, options)
              : listMemories({ projectDir: vaultProjectDir, kind: args.kind || 'all', limit: 60 }, options);
            const brief = buildCompactBrief({ projectDir: vaultProjectDir }, options);
            return toolOk('ok', {
              items,
              git,
              storagePath,
              commitsAhead: brief.commitsAhead,
              staleCount: brief.staleCount,
            });
          }
          if (args.action === 'save') {
            const saved = saveMemory(
              {
                projectDir: vaultProjectDir,
                kind: args.kind || 'decision',
                title: args.title,
                summary: args.summary,
                tags: args.tags || ['manual'],
              },
              options
            );
            return toolOk('saved', { saved, items: listMemories({ projectDir: vaultProjectDir, limit: 60 }, options), git, storagePath });
          }
          if (args.action === 'archive') {
            const res = archiveMemory(args.id, options);
            return toolOk('archived', { ...res, items: listMemories({ projectDir: vaultProjectDir, limit: 60 }, options), git, storagePath });
          }
          if (args.action === 'capsule') {
            const capsule = buildHandoffCapsule(
              {
                projectDir: vaultProjectDir,
                selectedDecisionIds: args.selectedDecisionIds,
                activeGoal: args.activeGoal,
                touchedFiles: args.touchedFiles,
                nextAction: args.nextAction,
              },
              options
            );
            return toolOk('ok', capsule);
          }
          return toolErr(`Unsupported vault action: ${args.action}`);
        }

        case 'app_config_manage': {
          if (args.action === 'get') {
            return toolOk('ok', { config: loadConfig(options), popoutStatus: popout.getStatus() });
          }
          if (args.action === 'update') {
            const next = saveConfig(args.patch || {}, options);
            if (args.patch?.popout && Object.prototype.hasOwnProperty.call(args.patch.popout, 'enabled') && !next.popout?.enabled) {
              await popout.stop();
            }
            return toolOk('updated', { config: next, popoutStatus: popout.getStatus() });
          }
          if (args.action === 'open_popout') {
            const cfg = loadConfig(options);
            if (!cfg.popout?.enabled) {
              saveConfig({ popout: { enabled: true } }, options);
            }
            const status = await popout.launchWindow({
              size: cfg.popout?.size || '460x720',
              position: cfg.popout?.position || null,
              forceNew: Boolean(args.forceNew),
            });
            return toolOk('launched', { config: loadConfig(options), popoutStatus: status });
          }
          if (args.action === 'close_popout') {
            const status = await popout.stop();
            const next = saveConfig({ popout: { enabled: false } }, options);
            return toolOk('closed', { config: next, popoutStatus: status });
          }
          if (args.action === 'set_active_session') {
            const convId = String(args.conversationId || '').trim();
            if (!convId) {
              return toolErr('conversationId is required for set_active_session');
            }
            const activeSession = recordActiveSession(
              {
                conversationId: convId,
                projectDir: args.projectDir || '',
                source: 'ui_sync',
                event: 'ui_select',
              },
              options
            );
            return toolOk('synced', { activeSession });
          }
          return toolErr(`Unsupported config action: ${args.action}`);
        }

        case 'app_doctor_action': {
          if (args.action === 'diagnose') {
            return toolOk('ok', { report: runDoctor(options) });
          }
          if (args.action === 'rebuild_index') {
            const rebuild = rebuildIndex(options);
            return toolOk('rebuilt', { rebuild, report: runDoctor(options) });
          }
          if (args.action === 'export_backup') {
            const exported = exportBackup(options);
            return toolOk('exported', { exported, report: runDoctor(options) });
          }
          if (args.action === 'reset_circuit') {
            const circuit = resetCircuitBreaker(options);
            return toolOk('reset', { circuit, report: runDoctor(options) });
          }
          if (args.action === 'repair') {
            return toolOk('repaired', repairLocalState(options));
          }
          return toolErr(`Unsupported doctor action: ${args.action}`);
        }

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
      return reply({
        protocolVersion: clientVer,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }

    if (method === 'ping') {
      return reply({});
    }

    if (method === 'resources/list') {
      return reply({
        resources: [
          {
            uri: APP_RESOURCE_URI,
            name: 'Context Cache & Telemetry Monitor',
            description: 'Single-file Antigravity native MCP App dashboard for context inspection, multi-agent TPS, quota windows, and cross-session vault.',
            mimeType: APP_RESOURCE_MIME,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      });
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri !== APP_RESOURCE_URI) {
        return replyError(-32002, `Resource not found: ${uri}`);
      }
      const html = readUiHtml(options);
      return reply({
        contents: [
          {
            uri: APP_RESOURCE_URI,
            mimeType: APP_RESOURCE_MIME,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      });
    }

    if (method === 'tools/list') {
      return reply({ tools: TOOL_DEFINITIONS });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const toolMeta = params?._meta || {};
      const result = await callTool(toolName, toolArgs, toolMeta);
      return reply(result);
    }

    return replyError(-32601, `Method not found: ${method}`);
  }

  async function close() {
    await popout.stop();
  }

  return { handleJsonRpc, callTool, close, popout };
}

/**
 * Start JSON-RPC 2.0 Stdio transport (supports both newline-delimited JSON and Content-Length framing).
 */
export function startStdioServer(options = {}) {
  const dispatcher = createMcpDispatcher(options);
  let buffer = Buffer.alloc(0);
  let useContentLength = false;

  const writeResponse = (resp) => {
    if (!resp) return;
    const json = JSON.stringify(resp);
    if (useContentLength) {
      const bytes = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
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
    const resp = await dispatcher.handleJsonRpc(parsed);
    writeResponse(resp);
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      // Skip leading CR/LF whitespace
      let start = 0;
      while (start < buffer.length && (buffer[start] === 0x0d || buffer[start] === 0x0a)) start++;
      if (start > 0) buffer = buffer.subarray(start);
      if (buffer.length === 0) break;

      const prefix = buffer.subarray(0, Math.min(32, buffer.length)).toString('ascii');
      if (/^Content-Length:/i.test(prefix)) {
        useContentLength = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerStr = buffer.subarray(0, headerEnd).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(headerStr);
        if (!m) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(m[1]);
        const totalNeed = headerEnd + 4 + len;
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
