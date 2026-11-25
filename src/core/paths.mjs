import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve home directory safely across Windows/POSIX.
 */
export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * Resolve external truth-source data directory.
 * Defaults to %USERPROFILE%\.context-cache (or $HOME/.context-cache).
 * Overridable via options.dataDir or CONTEXT_CACHE_DATA_DIR env var.
 */
export function getDataDir(options = {}) {
  const raw = options.dataDir || process.env.CONTEXT_CACHE_DATA_DIR || path.join(getHomeDir(), '.context-cache');
  return path.resolve(raw);
}

/**
 * Resolve Antigravity app data root (~/.gemini/antigravity by default).
 */
export function getAppDataDir(options = {}) {
  const raw = options.appDataDir || process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(getHomeDir(), '.gemini', 'antigravity');
  return path.resolve(raw);
}

/**
 * Resolve Antigravity config root (~/.gemini/config by default).
 */
export function getConfigRoot(options = {}) {
  const raw = options.configDir || process.env.ANTIGRAVITY_CONFIG_DIR || path.join(getHomeDir(), '.gemini', 'config');
  return path.resolve(raw);
}

/**
 * Resolve deployed plugin directory (~/.gemini/config/plugins/context-cache).
 */
export function getPluginDeployDir(options = {}) {
  const raw = options.pluginDir || process.env.CONTEXT_CACHE_PLUGIN_DIR || path.join(getConfigRoot(options), 'plugins', 'context-cache');
  return path.resolve(raw);
}

/**
 * Resolve all standard subdirectories inside dataDir.
 */
export function getDataPaths(options = {}) {
  const dataDir = getDataDir(options);
  return {
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    dbFile: path.join(dataDir, 'index.sqlite'),
    projectsDir: path.join(dataDir, 'projects'),
    telemetryDir: path.join(dataDir, 'telemetry'),
    callsLogFile: path.join(dataDir, 'telemetry', 'calls.jsonl'),
    cursorsFile: path.join(dataDir, 'telemetry', 'cursors.json'),
    timingsFile: path.join(dataDir, 'telemetry', 'timings.json'),
    activeSessionFile: path.join(dataDir, 'telemetry', 'active-session.json'),
    sessionsRegistryFile: path.join(dataDir, 'telemetry', 'sessions-registry.json'),
    diagnosticsDir: path.join(dataDir, 'diagnostics'),
    driftLogFile: path.join(dataDir, 'diagnostics', 'schema-drift.jsonl'),
    circuitFile: path.join(dataDir, 'diagnostics', 'circuit.json'),
    exportsDir: path.join(dataDir, 'exports'),
    i18nDir: path.join(dataDir, 'i18n'),
    i18nStateFile: path.join(dataDir, 'i18n', 'state.json'),
    i18nCommunityDictFile: path.join(dataDir, 'i18n', 'community-dict.json'),
    i18nCustomDictFile: path.join(dataDir, 'i18n', 'custom-dict.json'),
    i18nBundleFile: path.join(dataDir, 'i18n', 'runtime-bundle.json'),
    i18nJobFile: path.join(dataDir, 'i18n', 'last-job.json'),
    i18nUntranslatedFile: path.join(dataDir, 'i18n', 'untranslated.json'),
    governanceDir: path.join(dataDir, 'governance'),
    governanceProfilesFile: path.join(dataDir, 'governance', 'profiles.json'),
    governancePrefsFile: path.join(dataDir, 'governance', 'preferences.json'),
    governanceDisabledMcpFile: path.join(dataDir, 'governance', 'disabled-mcp.json'),
    governanceAuditLog: path.join(dataDir, 'governance', 'audit.jsonl'),
    hostBackupsDir: path.join(dataDir, 'backups', 'host-config'),
    hostBackupsIndexFile: path.join(dataDir, 'backups', 'host-config', 'index.json'),
    appearanceDir: path.join(dataDir, 'appearance'),
    wallpapersDir: path.join(dataDir, 'wallpapers'),
    appearanceStateFile: path.join(dataDir, 'appearance', 'state.json'),
    appearanceRuntimeFile: path.join(dataDir, 'appearance', 'runtime-appearance.json'),
    reviewsDir: path.join(dataDir, 'reviews'),
    runtimeDir: path.join(dataDir, 'runtime'),
    hostExeCacheDir: path.join(dataDir, 'runtime', 'host-bin'),
    localPluginsDir: path.join(dataDir, 'local-plugins'), // Reserved for v1.7.0 R10
  };
}

/**
 * Resolve all candidate Antigravity product directories (2.0, CLI, IDE).
 */
export function getCandidateAppDataDirs(options = {}) {
  const primary = getAppDataDir(options);
  const dirs = [primary];
  if (!options.appDataDir && !process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const geminiRoot = path.join(getHomeDir(), '.gemini');
    for (const variant of ['antigravity-cli', 'antigravity-ide']) {
      const candidate = path.join(geminiRoot, variant);
      if (!dirs.includes(candidate) && fs.existsSync(candidate)) {
        dirs.push(candidate);
      }
    }
  }
  return dirs;
}

/**
 * Locate a conversation's transcript.jsonl file given its conversationId.
 */
export function findTranscriptPath(conversationId, options = {}) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const safeId = path.basename(conversationId);
  if (!safeId || safeId === '.' || safeId === '..') return null;

  for (const appDir of getCandidateAppDataDirs(options)) {
    const p1 = path.join(appDir, 'brain', safeId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(appDir, 'brain', safeId, 'transcript.jsonl');
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

/**
 * Display path with %USERPROFILE% / ~ shorthand for UI readability.
 */
export function formatDisplayPath(absPath) {
  if (!absPath) return '';
  const home = getHomeDir();
  if (absPath.toLowerCase().startsWith(home.toLowerCase())) {
    const rel = absPath.slice(home.length);
    return process.platform === 'win32' ? `%USERPROFILE%${rel}` : `~${rel}`;
  }
  return absPath;
}
