import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir, getConfigRoot, formatDisplayPath } from '../paths.mjs';
import { redactText } from '../redact.mjs';
import { scanEcosystem } from './scanner.mjs';
import { runGovernanceLint } from './linters.mjs';
import {
  togglePluginEnabled,
  toggleGlobalMcpServer,
  listSnapshots,
  previewRollback,
  rollbackSnapshot,
  loadGovernancePreferences,
  setPluginPinned,
  setItemCategory,
  setLintFindingIgnored,
} from './guardrails.mjs';
import {
  listBuiltinProfiles,
  listProfiles,
  saveProfile,
  deleteProfile,
  previewProfileDiff,
  applyProfile,
} from './profiles.mjs';

export {
  scanEcosystem,
  runGovernanceLint,
  togglePluginEnabled,
  toggleGlobalMcpServer,
  listSnapshots,
  previewRollback,
  rollbackSnapshot,
  loadGovernancePreferences,
  setPluginPinned,
  setItemCategory,
  setLintFindingIgnored,
  listBuiltinProfiles,
  listProfiles,
  saveProfile,
  deleteProfile,
  previewProfileDiff,
  applyProfile,
};

function isAllowedPreviewPath(filePath, projectDir, options = {}) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath).toLowerCase();
  const roots = [
    getConfigRoot(options),
    getAppDataDir(options),
    projectDir || options.projectDir || process.cwd(),
  ]
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

/**
 * Read-only, redacted preview of a rule/skill/manifest/hook file within authorized roots.
 */
export function previewGovernanceFile(filePath, projectDir, options = {}) {
  if (!isAllowedPreviewPath(filePath, projectDir, options)) {
    throw new Error('拒绝预览超出工作区或 Antigravity 配置边界的文件');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('目标文件不存在');
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const MAX_CHARS = 18000;
  const truncated = raw.length > MAX_CHARS;
  const content = redactText(truncated ? raw.slice(0, MAX_CHARS) : raw);
  return {
    filePath,
    displayPath: formatDisplayPath(filePath),
    bytes: Buffer.byteLength(raw, 'utf8'),
    lines: raw ? raw.split(/\r?\n/).length : 0,
    truncated,
    content,
  };
}

export function getGovernanceOverview(params = {}, options = {}) {
  const ecosystem = scanEcosystem(params, options);
  const lint = runGovernanceLint(ecosystem, options);
  const builtinProfiles = listBuiltinProfiles(ecosystem, options);
  const profiles = listProfiles(options);
  const snapshots = listSnapshots(options);
  return {
    ecosystem,
    lint,
    builtinProfiles,
    profiles,
    snapshots,
  };
}

/**
 * Unified App-Only MCP action dispatcher for `app_governance_manage`.
 */
export function handleGovernanceAction(args = {}, options = {}) {
  const action = String(args.action || 'overview');
  const projectDir = args.projectDir || options.projectDir;

  switch (action) {
    case 'overview':
      return getGovernanceOverview({ projectDir }, options);
    case 'lint': {
      const eco = scanEcosystem({ projectDir }, options);
      return { lint: runGovernanceLint(eco, options) };
    }
    case 'preview_file':
      return previewGovernanceFile(args.filePath, projectDir, options);
    case 'toggle_plugin': {
      const result = togglePluginEnabled(args.pluginId, Boolean(args.enabled), options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'toggle_mcp': {
      const result = toggleGlobalMcpServer(args.serverName, Boolean(args.enabled), options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'set_plugin_pin': {
      const result = setPluginPinned(args.pluginId, Boolean(args.pinned), options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'set_item_category': {
      const result = setItemCategory(args.itemKey, args.category, options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'set_lint_ignore': {
      const result = setLintFindingIgnored(args.findingId, Boolean(args.ignored), options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'list_profiles':
      return { profiles: listProfiles(options) };
    case 'save_profile': {
      const saved = saveProfile(
        {
          id: args.profileId,
          name: args.name,
          description: args.description,
          plugins: args.plugins,
          globalMcp: args.globalMcp,
        },
        options
      );
      return { profile: saved, profiles: listProfiles(options) };
    }
    case 'delete_profile': {
      const deleted = deleteProfile(args.profileId, options);
      return { result: deleted, profiles: listProfiles(options) };
    }
    case 'preview_profile':
      return previewProfileDiff(args.profileId, { ...options, overrides: args.overrides });
    case 'apply_profile': {
      const result = applyProfile(args.profileId, {
        ...options,
        overrides: args.overrides,
        saveAsName: args.saveAsName,
      });
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    case 'list_snapshots':
      return { snapshots: listSnapshots(options) };
    case 'preview_rollback':
      return previewRollback(args.snapshotId, options);
    case 'rollback_snapshot': {
      const result = rollbackSnapshot(args.snapshotId, options);
      return { result, overview: getGovernanceOverview({ projectDir }, options) };
    }
    default:
      throw new Error(`未知治理操作: ${action}`);
  }
}
