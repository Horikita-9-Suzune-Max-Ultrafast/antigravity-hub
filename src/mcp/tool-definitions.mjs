import { VALID_CONSOLE_MODULES } from '../core/config.mjs';
import { APP_REVIEW_TOOL_DEF } from './handlers/review.mjs';

export const APP_RESOURCE_URI = 'ui://context-cache/dashboard.html';
export const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';

const APP_ONLY_META = { ui: { visibility: ['app'] } };

export const TOOL_DEFINITIONS = [
  // ==================== 5 Slim Model-Visible Tools ====================
  {
    name: 'ctx_open_monitor',
    title: 'Antigravity Hub',
    description:
      'Open the modular Antigravity Hub (Context Monitor, Local Code Review, Ecosystem Governance, Wallpaper, and Client Localization).',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Optional conversation ID to inspect' },
        projectDir: { type: 'string', description: 'Optional workspace directory' },
        module: { type: 'string', enum: [...VALID_CONSOLE_MODULES], description: 'Initial console module' },
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

  // ==================== 11 App-Only Private Tools (0 LLM Tokens) ====================
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
        lastRev: { type: 'string' },
        force: { type: 'boolean' },
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
        lastRev: { type: 'string' },
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
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    description: 'Private UI tool for reading/updating plugin settings, syncing active session, restarting Antigravity, and controlling the 127.0.0.1 popout window.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'get', 'update', 'open_popout', 'close_popout',
            'set_active_session', 'restart_antigravity', 'check_update', 'apply_update',
          ],
        },
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
    description: 'Private UI tool for Antigravity localization status, dictionaries, immunity/brand rules, and ASAR apply/restore jobs.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'update_config', 'refresh_bundle', 'list_dict',
            'upsert_entry', 'delete_entry', 'import_dict', 'export_dict',
            'sync_community', 'apply_patch', 'restore_patch',
            'list_untranslated', 'clear_untranslated',
          ],
        },
      },
      additionalProperties: true,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_governance_manage',
    title: 'App: Manage Antigravity Ecosystem & Harness Governance',
    description: 'Private UI tool for scanning Effective Harness stack, 4-pillar offline linting, guarded toggles, profiles, and snapshots.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'overview', 'lint', 'preview_file', 'toggle_plugin', 'toggle_mcp',
            'set_plugin_pin', 'set_item_category', 'set_lint_ignore',
            'list_profiles', 'save_profile', 'delete_profile', 'preview_profile',
            'apply_profile', 'list_snapshots', 'preview_rollback', 'rollback_snapshot',
          ],
        },
      },
      additionalProperties: true,
    },
    _meta: APP_ONLY_META,
  },
  {
    name: 'app_appearance_manage',
    title: 'App: Manage Antigravity Wallpaper & Appearance',
    description: 'Private UI tool for managing zero-intrusion hot-reload wallpapers, local folders, rotation, and emergency disable.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'update_config', 'import_wallpaper', 'delete_wallpaper',
            'scan_folder', 'pick_folder', 'next_wallpaper', 'emergency_off',
          ],
        },
      },
      additionalProperties: true,
    },
    _meta: APP_ONLY_META,
  },
  APP_REVIEW_TOOL_DEF,
];
