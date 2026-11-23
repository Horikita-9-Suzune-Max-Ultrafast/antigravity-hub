import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, getHomeDir } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { readJsonSafe } from '../storage.mjs';
import { readAsarHeader, readAsarFile, lookupAsarEntry } from './asar.mjs';
import { getMergedDictionary } from './dictionary.mjs';

export const CONSOLE_META_PATH = 'dist/agy-console-i18n.meta.json';
export const CONSOLE_RUNTIME_PATH = 'dist/agy-console-i18n-runtime.js';
export const CONSOLE_MAIN_PATH = 'dist/agy-console-i18n-main.js';
export const THIRD_PARTY_META_PATH = 'dist/zh-cn-meta.json';
export const THIRD_PARTY_MAIN_PATH = 'dist/zh-cn-main.js';

export const BACKUP_CANDIDATES = [
  { name: 'app.asar.agy-console.bak', kind: 'console' },
  { name: 'app.asar.zh-cn.bak', kind: 'third_party' },
  { name: 'app.asar.bak', kind: 'generic' },
];

function getPlatformInstallCandidates(platform = process.platform, env = process.env) {
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(getHomeDir(), 'AppData', 'Local');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(localAppData, 'Programs', 'Antigravity'),
      path.join(localAppData, 'Antigravity'),
      path.join(programFiles, 'Antigravity'),
      path.join(programFilesX86, 'Antigravity')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents',
      path.join(getHomeDir(), 'Applications', 'Antigravity.app', 'Contents')
    );
  } else {
    candidates.push(
      '/opt/Antigravity',
      '/usr/lib/antigravity',
      '/usr/share/antigravity',
      path.join(getHomeDir(), '.local', 'share', 'Antigravity')
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Normalize a user-supplied or auto-detected candidate path to { installDir, resourcesDir, asarPath }.
 * Supports pointing to install root, .app bundle, resources dir, app.asar, or Antigravity.exe.
 */
function resolveInstallLayout(rawCandidate) {
  if (!rawCandidate || typeof rawCandidate !== 'string') return null;
  const trimmed = rawCandidate.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;

  let resolved;
  try {
    resolved = path.resolve(trimmed);
  } catch {
    return null;
  }
  if (!fs.existsSync(resolved)) return null;

  const stat = fs.statSync(resolved);
  let baseDir = stat.isFile() ? path.dirname(resolved) : resolved;

  // Handle direct app.asar or resources directory
  if (stat.isFile() && path.basename(resolved).toLowerCase() === 'app.asar') {
    const resourcesDir = path.dirname(resolved);
    const installDir = path.dirname(resourcesDir);
    return { installDir, resourcesDir, asarPath: resolved };
  }

  // Handle macOS .app bundle root -> Contents
  if (baseDir.toLowerCase().endsWith('.app')) {
    const contentsDir = path.join(baseDir, 'Contents');
    if (fs.existsSync(contentsDir)) {
      baseDir = contentsDir;
    }
  }

  // Handle pointing directly to resources / Resources folder
  const directAsar = path.join(baseDir, 'app.asar');
  if (fs.existsSync(directAsar) && fs.statSync(directAsar).isFile()) {
    return {
      installDir: path.dirname(baseDir),
      resourcesDir: baseDir,
      asarPath: directAsar,
    };
  }

  // Standard layout: <installDir>/resources/app.asar or <installDir>/Resources/app.asar
  for (const resName of ['resources', 'Resources']) {
    const resourcesDir = path.join(baseDir, resName);
    const asarPath = path.join(resourcesDir, 'app.asar');
    if (fs.existsSync(asarPath) && fs.statSync(asarPath).isFile()) {
      return { installDir: baseDir, resourcesDir, asarPath };
    }
  }

  // Check <baseDir>/Contents/Resources/app.asar just in case
  const macRes = path.join(baseDir, 'Contents', 'Resources');
  const macAsar = path.join(macRes, 'app.asar');
  if (fs.existsSync(macAsar) && fs.statSync(macAsar).isFile()) {
    return {
      installDir: path.join(baseDir, 'Contents'),
      resourcesDir: macRes,
      asarPath: macAsar,
    };
  }

  return null;
}

function findExecutablePath(installDir, platform = process.platform) {
  if (!installDir || !fs.existsSync(installDir)) return null;
  const candidates =
    platform === 'win32'
      ? [path.join(installDir, 'Antigravity.exe')]
      : platform === 'darwin'
        ? [
            path.join(installDir, 'MacOS', 'Antigravity'),
            path.join(installDir, 'Contents', 'MacOS', 'Antigravity'),
          ]
        : [
            path.join(installDir, 'antigravity'),
            path.join(installDir, 'Antigravity'),
          ];

  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return p;
    }
  }

  // Fallback scan on Windows for any Antigravity*.exe in installDir
  if (platform === 'win32') {
    try {
      const entries = fs.readdirSync(installDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && /^antigravity.*\.exe$/i.test(e.name)) {
          return path.join(installDir, e.name);
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function readAppVersion(installDir, resourcesDir, asarPath) {
  const versionFiles = [
    path.join(installDir, 'version'),
    path.join(resourcesDir, 'version'),
  ];
  for (const vf of versionFiles) {
    try {
      if (fs.existsSync(vf) && fs.statSync(vf).isFile()) {
        const txt = fs.readFileSync(vf, 'utf8').trim();
        if (txt) return txt.split(/\r?\n/)[0].trim();
      }
    } catch {
      // ignore unreadable version file
    }
  }

  // Fallback: read package.json inside app.asar
  try {
    const pkgBuf = readAsarFile(asarPath, 'package.json');
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Detect Antigravity client installation across Windows, macOS, and Linux.
 */
export function detectAntigravityInstall(options = {}) {
  const cfg = loadConfig(options);
  const explicitOverride =
    typeof options.installDir === 'string' && options.installDir.trim()
      ? options.installDir.trim()
      : cfg.i18n?.installDirOverride || '';

  if (explicitOverride) {
    const layout = resolveInstallLayout(explicitOverride);
    if (layout) {
      return {
        found: true,
        source: 'override',
        installDir: layout.installDir,
        resourcesDir: layout.resourcesDir,
        asarPath: layout.asarPath,
        exePath: findExecutablePath(layout.installDir, options.platform || process.platform),
        appVersion: readAppVersion(layout.installDir, layout.resourcesDir, layout.asarPath),
      };
    }
    return {
      found: false,
      source: 'override',
      installDir: explicitOverride,
      resourcesDir: null,
      asarPath: null,
      exePath: null,
      appVersion: null,
    };
  }

  if (options.skipSystemScan) {
    return {
      found: false,
      source: null,
      installDir: null,
      resourcesDir: null,
      asarPath: null,
      exePath: null,
      appVersion: null,
    };
  }

  const candidates = getPlatformInstallCandidates(options.platform || process.platform, options.env || process.env);
  for (const candidate of candidates) {
    const layout = resolveInstallLayout(candidate);
    if (layout) {
      return {
        found: true,
        source: 'auto',
        installDir: layout.installDir,
        resourcesDir: layout.resourcesDir,
        asarPath: layout.asarPath,
        exePath: findExecutablePath(layout.installDir, options.platform || process.platform),
        appVersion: readAppVersion(layout.installDir, layout.resourcesDir, layout.asarPath),
      };
    }
  }

  return {
    found: false,
    source: null,
    installDir: null,
    resourcesDir: null,
    asarPath: null,
    exePath: null,
    appVersion: null,
  };
}

function readAsarJsonEntrySafe(asarPath, relPath) {
  try {
    const buf = readAsarFile(asarPath, relPath);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Inspect an ASAR archive header for our Console i18n patch markers and third-party zh-cn markers.
 */
export function inspectAsarMarkers(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return {
      valid: false,
      hasConsolePatch: false,
      hasThirdPartyPatch: false,
      isCleanOriginal: false,
      consolePatchMeta: null,
      thirdPartyMeta: null,
      hasMainJs: false,
      hasPreloadJs: false,
      error: 'ASAR file does not exist.',
    };
  }

  try {
    const { header } = readAsarHeader(asarPath);

    const hasConsoleMeta = Boolean(lookupAsarEntry(header, CONSOLE_META_PATH));
    const hasConsoleRuntime = Boolean(lookupAsarEntry(header, CONSOLE_RUNTIME_PATH));
    const hasConsoleMain = Boolean(lookupAsarEntry(header, CONSOLE_MAIN_PATH));
    const hasThirdPartyMeta = Boolean(lookupAsarEntry(header, THIRD_PARTY_META_PATH));
    const hasThirdPartyMain = Boolean(lookupAsarEntry(header, THIRD_PARTY_MAIN_PATH));

    let consolePatchMeta = null;
    if (hasConsoleMeta) {
      consolePatchMeta = readAsarJsonEntrySafe(asarPath, CONSOLE_META_PATH) || {
        detectedBy: CONSOLE_META_PATH,
      };
    } else if (hasConsoleRuntime || hasConsoleMain) {
      consolePatchMeta = {
        detectedBy: hasConsoleRuntime ? CONSOLE_RUNTIME_PATH : CONSOLE_MAIN_PATH,
      };
    }

    let thirdPartyMeta = null;
    if (hasThirdPartyMeta) {
      thirdPartyMeta = readAsarJsonEntrySafe(asarPath, THIRD_PARTY_META_PATH) || {
        detectedBy: THIRD_PARTY_META_PATH,
      };
    } else if (hasThirdPartyMain) {
      thirdPartyMeta = { detectedBy: THIRD_PARTY_MAIN_PATH };
    }

    const hasConsolePatch = Boolean(consolePatchMeta);
    const hasThirdPartyPatch = Boolean(thirdPartyMeta);

    return {
      valid: true,
      hasConsolePatch,
      hasThirdPartyPatch,
      isCleanOriginal: !hasConsolePatch && !hasThirdPartyPatch,
      consolePatchMeta,
      thirdPartyMeta,
      hasMainJs: Boolean(lookupAsarEntry(header, 'dist/main.js')),
      hasPreloadJs: Boolean(lookupAsarEntry(header, 'dist/preload.js')),
    };
  } catch (err) {
    return {
      valid: false,
      hasConsolePatch: false,
      hasThirdPartyPatch: false,
      isCleanOriginal: false,
      consolePatchMeta: null,
      thirdPartyMeta: null,
      hasMainJs: false,
      hasPreloadJs: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Scan known app.asar backup files in resourcesDir and inspect each for cleanliness.
 */
export function scanBackups(resourcesDir) {
  if (!resourcesDir || !fs.existsSync(resourcesDir)) return [];
  const results = [];

  for (const candidate of BACKUP_CANDIDATES) {
    const filePath = path.join(resourcesDir, candidate.name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const markers = inspectAsarMarkers(filePath);
      const isoTime = new Date(stat.mtimeMs).toISOString();
      results.push({
        name: candidate.name,
        path: filePath,
        kind: candidate.kind,
        size: stat.size,
        mtime: isoTime,
        modifiedAt: isoTime,
        valid: markers.valid,
        isCleanOriginal: markers.valid && markers.isCleanOriginal,
        hasConsolePatch: markers.hasConsolePatch,
        hasThirdPartyPatch: markers.hasThirdPartyPatch,
      });
    } catch {
      // Ignore unreadable backup file
    }
  }

  return results;
}

/**
 * Compute full Antigravity localization status, backup health, config, and dictionary statistics.
 */
export function getI18nStatus(options = {}) {
  const paths = getDataPaths(options);
  const fullConfig = loadConfig(options);
  const state = readJsonSafe(paths.i18nStateFile, null);
  const lastJob = readJsonSafe(paths.i18nJobFile, null);

  let dictStats = null;
  try {
    dictStats = getMergedDictionary(options).stats;
  } catch {
    dictStats = {
      builtinCount: 0,
      communityCount: 0,
      customCount: 0,
      disabledCount: 0,
      totalActive: 0,
      patternCount: 0,
    };
  }

  const install = detectAntigravityInstall(options);
  if (!install.found) {
    return {
      status: 'not_found',
      installDir: install.installDir,
      resourcesDir: null,
      exePath: null,
      asarPath: null,
      appVersion: null,
      consolePatchMeta: null,
      thirdPartyMeta: null,
      backups: [],
      hasCleanBackup: false,
      state,
      lastJob,
      config: fullConfig.i18n,
      dictStats,
    };
  }

  const markers = inspectAsarMarkers(install.asarPath);
  const backups = scanBackups(install.resourcesDir);
  const hasCleanBackup = backups.some((b) => b.valid && b.isCleanOriginal);

  let status = 'unpatched';
  if (markers.hasConsolePatch) {
    const patchedVer = markers.consolePatchMeta?.appVersion || null;
    if (patchedVer && install.appVersion && patchedVer !== install.appVersion) {
      status = 'outdated_after_update';
    } else {
      status = 'patched_by_console';
    }
  } else if (markers.hasThirdPartyPatch) {
    status = 'patched_by_other';
  } else if (state?.patched === true) {
    // Previously patched by Console, now clean unpatched => official update overwrote app.asar
    status = 'outdated_after_update';
  } else {
    status = 'unpatched';
  }

  return {
    status,
    installDir: install.installDir,
    resourcesDir: install.resourcesDir,
    exePath: install.exePath,
    asarPath: install.asarPath,
    appVersion: install.appVersion,
    consolePatchMeta: markers.consolePatchMeta,
    thirdPartyMeta: markers.thirdPartyMeta,
    backups,
    hasCleanBackup,
    state,
    lastJob,
    config: fullConfig.i18n,
    dictStats,
  };
}
