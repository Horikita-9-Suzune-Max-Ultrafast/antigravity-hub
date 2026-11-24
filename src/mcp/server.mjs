import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDataPaths, formatDisplayPath } from '../core/paths.mjs';
import { atomicWriteJson, ensureDataDirs, readJsonSafe } from '../core/storage.mjs';
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
import { inspectContext, previewContextAsset } from '../core/context-inspector.mjs';
import { getTelemetryReport } from '../core/telemetry.mjs';
import { getQuotaSnapshot, calibrateQuotaGroup } from '../core/quota.mjs';
import { runDoctor, exportBackup, resetCircuitBreaker, repairLocalState } from '../core/doctor.mjs';
import { PopoutServerManager } from '../core/popout-server.mjs';
import { recordActiveSession, resolveTargetSession, getSessionProjectDir } from '../core/session-tracker.mjs';
import { listConversations } from '../core/transcript-parser.mjs';
import { handleI18nAction } from '../core/i18n/index.mjs';
import { handleGovernanceAction } from '../core/governance/index.mjs';
import { handleAppearanceAction } from '../core/appearance/index.mjs';
import { restartAntigravity } from '../core/client-restart.mjs';
import { checkForUpdate, applySelfUpdate } from '../core/self-update.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const APP_RESOURCE_URI = 'ui://context-cache/dashboard.html';
export const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';
export const SERVER_INFO = {
  name: 'context-cache-server',
  version: '1.5.4',
};

const APP_ONLY_META = { ui: { visibility: ['app'] } };

export const TOOL_DEFINITIONS = [
  // ==================== 5 Slim Model-Visible Tools ====================
  {
    name: 'ctx_open_monitor',
    title: 'Antigravity Hub',
    description: 'Open the modular Antigravity Hub (Context Monitor: breakdown, multi-agent TPS & cache, cross-session vault; and Antigravity Chinese Localization).',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Optional conversation ID to inspect' },
        projectDir: { type: 'string', description: 'Optional workspace directory' },
        module: { type: 'string', enum: ['monitor', 'governance', 'appearance', 'i18n'], description: 'Initial console module' },
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
          { type: 'aux_pane', title: 'Antigravity Hub' },
          { type: 'global', title: 'Antigravity Hub' },
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
    description: 'Private UI tool returning active context breakdown, deferred MCP tools, inventories, bloat attribution, and safe read-only redacted asset preview.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['breakdown', 'preview_asset'] },
        filePath: { type: 'string' },
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
        selectedFiles: { type: 'array', items: { type: 'string' } },
        selectedArtifacts: { type: 'array', items: { type: 'string' } },
        budgetPreset: { type: 'string', enum: ['compact', 'standard', 'full'] },
        budgetTokens: { type: 'number' },
        activeGoal: { type: 'string' },
        touchedFiles: { type: 'array', items: { type: 'string' } },
        artifacts: { type: 'array', items: { type: 'string' } },
        nextAction: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_config_manage',
    title: 'App: Manage Plugin Settings & Popout Window',
    description: 'Private UI tool for reading/updating plugin settings (including uiLanguage), syncing active session across views, safely restarting Antigravity, and controlling the optional 127.0.0.1 popout window.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'update', 'open_popout', 'close_popout', 'set_active_session', 'restart_antigravity', 'check_update', 'apply_update'] },
        patch: { type: 'object' },
        conversationId: { type: 'string' },
        projectDir: { type: 'string' },
        forceNew: { type: 'boolean' },
        force: { type: 'boolean' },
        theme: { type: 'string', enum: ['light', 'dark'] },
        dryRun: { type: 'boolean' },
        installDir: { type: 'string' },
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
  {
    name: 'app_i18n_manage',
    title: 'App: Manage Antigravity Chinese Localization',
    description: 'Private UI tool for detecting Antigravity install/patch state, managing layered localization dictionaries, immunity/brand rules, and triggering detached ASAR apply/restore jobs.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'update_config',
            'refresh_bundle',
            'list_dict',
            'upsert_entry',
            'delete_entry',
            'import_dict',
            'export_dict',
            'sync_community',
            'apply_patch',
            'restore_patch',
            'list_untranslated',
            'clear_untranslated',
          ],
        },
        patch: { type: 'object' },
        query: { type: 'string' },
        source: { type: 'string' },
        scope: { type: 'string' },
        page: { type: 'number' },
        pageSize: { type: 'number' },
        en: { type: 'string' },
        zh: { type: 'string' },
        disabled: { type: 'boolean' },
        rawJson: { type: 'string' },
        target: { type: 'string' },
        mergeMode: { type: 'string' },
        url: { type: 'string' },
        sync: { type: 'boolean' },
        skipProcessControl: { type: 'boolean' },
        relaunch: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_governance_manage',
    title: 'App: Manage Antigravity Ecosystem & Harness Governance',
    description: 'Private UI tool for scanning Effective Harness stack, offline MCP/Skill/Secret linting, guarded plugin/MCP toggles, profile switching, and host config snapshot rollback.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'overview',
            'lint',
            'preview_file',
            'toggle_plugin',
            'toggle_mcp',
            'set_plugin_pin',
            'set_item_category',
            'set_lint_ignore',
            'list_profiles',
            'save_profile',
            'delete_profile',
            'preview_profile',
            'apply_profile',
            'list_snapshots',
            'preview_rollback',
            'rollback_snapshot',
          ],
        },
        projectDir: { type: 'string' },
        filePath: { type: 'string' },
        pluginId: { type: 'string' },
        serverName: { type: 'string' },
        enabled: { type: 'boolean' },
        pinned: { type: 'boolean' },
        itemKey: { type: 'string' },
        category: { type: 'string' },
        findingId: { type: 'string' },
        ignored: { type: 'boolean' },
        profileId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        plugins: { type: 'object' },
        globalMcp: { type: 'object' },
        overrides: { type: 'object' },
        saveAsName: { type: 'string' },
        snapshotId: { type: 'string' },
      },
      additionalProperties: true,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_appearance_manage',
    title: 'App: Manage Antigravity Wallpaper & Appearance',
    description: 'Private UI tool for managing zero-intrusion hot-reload wallpapers, CSS gradient presets, read-only local folders, rotation, and emergency disable.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'update_config',
            'import_wallpaper',
            'delete_wallpaper',
            'scan_folder',
            'pick_folder',
            'next_wallpaper',
            'emergency_off',
          ],
        },
        patch: { type: 'object' },
        light: { type: 'boolean' },
        fileName: { type: 'string' },
        base64: { type: 'string' },
        absPath: { type: 'string' },
        activate: { type: 'boolean' },
        id: { type: 'string' },
        folderPath: { type: 'string' },
      },
      additionalProperties: true,
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
 * Auto-launch the native floating popout window once per Antigravity host lifecycle (keyed by parent PID).
 * Prevents duplicate popouts on MCP reconnects and respects user opt-out / test environment guards.
 */
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
    atomicWriteJson(stateFile, {
      ppid: hostPpid,
      pid: process.pid,
      launchedAt: new Date().toISOString(),
    });
  } catch {
    // Non-fatal; proceed fail-open
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

/**
 * Create a self-contained MCP request dispatcher (used by stdio server, popout server, and unit tests).
 */
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
  const popout = new PopoutServerManager({
    getHtml: () => readUiHtml(options),
    dataDir: options.dataDir || null,
    getActiveConversationId: () => {
      const target = resolveTargetSession(
        {
          followActive: true,
          fallbackProjectDir: defaultWorkspace,
        },
        options
      );
      return target.conversationId || null;
    },
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
          const requestedModule = ['monitor', 'governance', 'appearance', 'i18n'].includes(args.module)
            ? args.module
            : config.console?.defaultModule || 'monitor';
          const summaryText =
            `Antigravity Hub 已就绪：当前上下文 ${ctx.usedPercent}% (${Math.round(ctx.usedTokens / 1000)}K/${Math.round(ctx.limitTokens / 1000)}K)` +
            `，缓存命中 ${ctx.latestCacheHitRate.toFixed(1)}%，均速 ${ctx.avgTps.toFixed(1)} tok/s，预警 ${ctx.alerts.length} 项。`;
          return toolOk(summaryText, {
            initialModule: requestedModule,
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
          if (args.action === 'preview_asset') {
            let previewProjectDir = args.projectDir || '';
            if (!previewProjectDir) {
              if (args.conversationId) {
                previewProjectDir = getSessionProjectDir(args.conversationId, defaultWorkspace, options);
              } else {
                const target = resolveTargetSession(
                  {
                    followActive: args.followActive !== false,
                    sessions: listConversations({ ...options, limit: 1 }),
                    fallbackProjectDir: defaultWorkspace,
                  },
                  options
                );
                previewProjectDir = target.projectDir || defaultWorkspace;
              }
            }
            const preview = previewContextAsset(
              {
                filePath: args.filePath,
                projectDir: previewProjectDir,
              },
              options
            );
            return toolOk('ok', preview);
          }
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
          let resolvedConvId = args.conversationId || null;
          let resolvedTranscriptPath = '';
          if (!vaultProjectDir || args.action === 'capsule') {
            if (args.conversationId) {
              if (!vaultProjectDir) {
                vaultProjectDir = getSessionProjectDir(args.conversationId, defaultWorkspace, options);
              }
            } else {
              const target = resolveTargetSession(
                {
                  followActive: true,
                  sessions: listConversations({ ...options, limit: 1 }),
                  fallbackProjectDir: defaultWorkspace,
                },
                options
              );
              if (!vaultProjectDir) {
                vaultProjectDir = target.projectDir || defaultWorkspace;
              }
              if (!resolvedConvId && target.conversationId) {
                resolvedConvId = target.conversationId;
              }
              if (target.transcriptPath) {
                resolvedTranscriptPath = target.transcriptPath;
              }
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
                conversationId: resolvedConvId || undefined,
                transcriptPath: resolvedTranscriptPath || undefined,
                budgetPreset: args.budgetPreset,
                budgetTokens: args.budgetTokens,
                selectedDecisionIds: args.selectedDecisionIds,
                selectedFiles: args.selectedFiles,
                selectedArtifacts: args.selectedArtifacts,
                activeGoal: args.activeGoal,
                touchedFiles: args.touchedFiles,
                artifacts: args.artifacts,
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
              alwaysOnTop: cfg.popout?.alwaysOnTop !== false,
              theme: args.theme === 'dark' ? 'dark' : 'light',
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
          if (args.action === 'restart_antigravity') {
            const restartOpts = {
              ...options,
              dryRun: Boolean(args.dryRun),
            };
            if (typeof args.installDir === 'string' && args.installDir.trim()) {
              restartOpts.installDir = args.installDir.trim();
            }
            const res = restartAntigravity(restartOpts);
            return toolOk(res.message, res);
          }
          if (args.action === 'check_update') {
            const res = await checkForUpdate(options);
            return toolOk(res.ok ? 'checked' : (res.message || 'check_failed'), res);
          }
          if (args.action === 'apply_update') {
            try {
              await popout.stop();
            } catch {
              // best-effort release of floating window before directory swap
            }
            const res = await applySelfUpdate({
              ...options,
              force: Boolean(args.force),
            });
            return toolOk(res.message || res.status || 'done', res);
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

        case 'app_i18n_manage': {
          const res = await handleI18nAction(args, options);
          return toolOk('ok', res);
        }

        case 'app_governance_manage': {
          const res = handleGovernanceAction(args, options);
          return toolOk('ok', res);
        }

        case 'app_appearance_manage': {
          const res = await handleAppearanceAction(args, options);
          return toolOk('ok', res);
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
      scheduleStartupAutoPopout(options.startupAutoPopoutDelayMs ?? 1200);
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
      if (method === 'notifications/initialized') {
        scheduleStartupAutoPopout(options.startupAutoPopoutDelayMs ?? 800);
      }
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
    if (startupAutoLaunchTimer) {
      clearTimeout(startupAutoLaunchTimer);
      startupAutoLaunchTimer = null;
    }
    await popout.stop();
  }

  return { handleJsonRpc, callTool, close, popout };
}

/**
 * Start JSON-RPC 2.0 Stdio transport (supports both newline-delimited JSON and Content-Length framing).
 */
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
