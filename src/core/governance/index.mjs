import path from 'node:path';
import { getAppDataDir, getConfigRoot } from '../paths.mjs';
import { previewAuthorizedFile, safeRealpath } from '../fs-utils.mjs';
import { scanEcosystem, clearEcosystemInventoryCache } from './scanner.mjs';
import {
  runGovernanceLint,
  computeGovernanceScore,
  computeBaselinePenalty,
  tokenizeKeywords,
  PILLAR_SPECS,
  CODE_SPECS,
} from './linters.mjs';
import {
  registerGovernanceCacheInvalidator,
  createHostSnapshot,
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

// Ensure all guardrail mutations immediately invalidate the 5s ecosystem inventory cache
registerGovernanceCacheInvalidator(clearEcosystemInventoryCache);

export {
  scanEcosystem,
  clearEcosystemInventoryCache,
  runGovernanceLint,
  computeGovernanceScore,
  computeBaselinePenalty,
  tokenizeKeywords,
  PILLAR_SPECS,
  CODE_SPECS,
  createHostSnapshot,
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

/**
 * Read-only, boundary-checked, symlink-safe, secret-blocking, redacted preview
 * of a rule/skill/manifest/hook file within authorized roots.
 */
export function previewGovernanceFile(filePath, projectDir, options = {}) {
  const rawRoots = [
    getConfigRoot(options),
    getAppDataDir(options),
    projectDir || options.projectDir || process.cwd(),
  ].filter(Boolean);
  const allowedRoots = [];
  for (const r of rawRoots) {
    const resolvedRoot = path.resolve(r);
    allowedRoots.push(resolvedRoot);
    const realRoot = safeRealpath(resolvedRoot);
    if (realRoot.toLowerCase() !== resolvedRoot.toLowerCase()) {
      allowedRoots.push(realRoot);
    }
  }

  return previewAuthorizedFile({
    filePath,
    allowedRoots,
    maxChars: 18000,
  });
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
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    case 'toggle_mcp': {
      const result = toggleGlobalMcpServer(args.serverName, Boolean(args.enabled), options);
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    case 'set_plugin_pin': {
      const result = setPluginPinned(args.pluginId, Boolean(args.pinned), options);
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    case 'set_item_category': {
      const result = setItemCategory(args.itemKey, args.category, options);
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    case 'set_lint_ignore': {
      const result = setLintFindingIgnored(args.findingId, Boolean(args.ignored), options);
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
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
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    case 'list_snapshots':
      return { snapshots: listSnapshots(options) };
    case 'preview_rollback':
      return previewRollback(args.snapshotId, options);
    case 'rollback_snapshot': {
      const result = rollbackSnapshot(args.snapshotId, options);
      return { result, overview: getGovernanceOverview({ projectDir }, { ...options, force: true }) };
    }
    default:
      throw new Error(`未知治理操作: ${action}`);
  }
}
