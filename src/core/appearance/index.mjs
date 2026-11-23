import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths } from '../paths.mjs';
import { getI18nStatus } from '../i18n/index.mjs';
import { WALLPAPER_PRESETS, getPresetById } from './presets.mjs';
import {
  MAX_WALLPAPER_BYTES,
  listLibraryWallpapers,
  scanLocalFolderReadOnly,
  importWallpaperFromBase64,
  importWallpaperFromPath,
  deleteLibraryWallpaper,
  buildThumbDataUri,
  pickLocalFolderNative,
} from './library.mjs';

export {
  WALLPAPER_PRESETS,
  MAX_WALLPAPER_BYTES,
  listLibraryWallpapers,
  scanLocalFolderReadOnly,
  importWallpaperFromBase64,
  importWallpaperFromPath,
  deleteLibraryWallpaper,
  pickLocalFolderNative,
};

export const DEFAULT_APPEARANCE_STATE = {
  version: 1,
  enabled: false,
  mode: 'preset', // 'preset' | 'image'
  presetId: 'aurora-mist',
  activeWallpaperPath: '',
  separateThemeWallpapers: false,
  darkWallpaperPath: '',
  lightWallpaperPath: '',
  opacity: 0.24, // 0.05 ~ 0.85
  blurPx: 2, // 0 ~ 24
  scrimOpacity: 0.42, // 0 ~ 0.85
  saturation: 100, // 0 ~ 160
  glassOpacity: 0.86, // legacy compatibility
  fit: 'cover', // 'cover' | 'contain' | 'center'
  protectCodeReadability: true,
  rotationMode: 'off', // 'off' | 'startup' | 'interval'
  rotationMinutes: 30, // 1 ~ 1440
  rotationSource: 'all', // 'all' | 'library' | 'folder'
  rotationLibrarySelection: null, // null = all library items; string[] = explicit library item IDs
  folderPath: '',
  updatedAt: null,
};

const VISUAL_ONLY_KEYS = new Set([
  'opacity',
  'blurPx',
  'scrimOpacity',
  'saturation',
  'glassOpacity',
  'fit',
  'protectCodeReadability',
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function writeAtomicJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const body = `${JSON.stringify(obj, null, 2)}\n`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function normalizeAppearanceState(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = src.mode === 'image' ? 'image' : 'preset';
  const fit = ['cover', 'contain', 'center'].includes(src.fit) ? src.fit : 'cover';
  const rotationMode = ['off', 'startup', 'interval'].includes(src.rotationMode) ? src.rotationMode : 'off';
  const rotationSource = ['all', 'library', 'folder'].includes(src.rotationSource) ? src.rotationSource : 'all';
  const rotationLibrarySelection = Array.isArray(src.rotationLibrarySelection)
    ? Array.from(
        new Set(
          src.rotationLibrarySelection
            .map((v) => String(v || '').trim())
            .filter(Boolean)
        )
      )
    : null;
  const preset = getPresetById(src.presetId);

  return {
    version: 1,
    enabled: Boolean(src.enabled),
    mode,
    presetId: preset.id,
    activeWallpaperPath: typeof src.activeWallpaperPath === 'string' ? src.activeWallpaperPath.trim() : '',
    separateThemeWallpapers: Boolean(src.separateThemeWallpapers),
    darkWallpaperPath: typeof src.darkWallpaperPath === 'string' ? src.darkWallpaperPath.trim() : '',
    lightWallpaperPath: typeof src.lightWallpaperPath === 'string' ? src.lightWallpaperPath.trim() : '',
    opacity: Number(clamp(src.opacity, 0.05, 0.85, DEFAULT_APPEARANCE_STATE.opacity).toFixed(2)),
    blurPx: Math.round(clamp(src.blurPx, 0, 24, DEFAULT_APPEARANCE_STATE.blurPx)),
    scrimOpacity: Number(clamp(src.scrimOpacity, 0, 0.85, DEFAULT_APPEARANCE_STATE.scrimOpacity).toFixed(2)),
    saturation: Math.round(clamp(src.saturation, 0, 160, DEFAULT_APPEARANCE_STATE.saturation)),
    glassOpacity: Number(clamp(src.glassOpacity, 0.55, 0.98, DEFAULT_APPEARANCE_STATE.glassOpacity).toFixed(2)),
    fit,
    protectCodeReadability: src.protectCodeReadability !== false,
    rotationMode,
    rotationMinutes: Math.round(clamp(src.rotationMinutes, 1, 1440, DEFAULT_APPEARANCE_STATE.rotationMinutes)),
    rotationSource,
    rotationLibrarySelection,
    folderPath: typeof src.folderPath === 'string' ? src.folderPath.trim() : '',
    updatedAt: src.updatedAt || null,
  };
}

export function loadAppearanceState(options = {}) {
  const { appearanceStateFile } = getDataPaths(options);
  try {
    if (!fs.existsSync(appearanceStateFile)) return normalizeAppearanceState(DEFAULT_APPEARANCE_STATE);
    const raw = fs.readFileSync(appearanceStateFile, 'utf8');
    if (!raw.trim()) return normalizeAppearanceState(DEFAULT_APPEARANCE_STATE);
    return normalizeAppearanceState(JSON.parse(raw));
  } catch {
    return normalizeAppearanceState(DEFAULT_APPEARANCE_STATE);
  }
}

export function saveAppearanceState(patch = {}, options = {}) {
  const current = loadAppearanceState(options);
  const next = normalizeAppearanceState({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  const { appearanceStateFile } = getDataPaths(options);
  writeAtomicJson(appearanceStateFile, next);
  const patchKeys = Object.keys(patch || {});
  const isVisualOnly = patchKeys.length > 0 && patchKeys.every((k) => VISUAL_ONLY_KEYS.has(k));
  compileRuntimeAppearance(options, next, { skipPoolScan: isVisualOnly });
  return next;
}

/**
 * Collect the rotation wallpaper pool respecting rotationSource & rotationLibrarySelection.
 */
export function getWallpaperPool(state, options = {}) {
  const libItems = listLibraryWallpapers(options);
  let selectedLibItems = libItems;
  if (Array.isArray(state.rotationLibrarySelection)) {
    const selSet = new Set(state.rotationLibrarySelection);
    selectedLibItems = libItems.filter(
      (it) => selSet.has(it.id) || selSet.has(it.name) || selSet.has(it.filePath)
    );
  }
  const folderRes = state.folderPath
    ? scanLocalFolderReadOnly(state.folderPath)
    : { ok: true, items: [], skippedTooLarge: 0 };
  const folderItems = folderRes.items || [];

  let pool;
  if (state.rotationSource === 'library') {
    pool = [...selectedLibItems];
  } else if (state.rotationSource === 'folder') {
    pool = [...folderItems];
  } else {
    pool = [...selectedLibItems, ...folderItems];
  }
  return { libItems, selectedLibItems, folderRes, pool };
}

function readCachedPoolPaths(runtimeFile) {
  try {
    if (!fs.existsSync(runtimeFile)) return null;
    const raw = fs.readFileSync(runtimeFile, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.poolPaths) ? parsed.poolPaths : null;
  } catch {
    return null;
  }
}

/**
 * Compile runtime-appearance.json consumed hot by the preload Fail-Open engine.
 */
export function compileRuntimeAppearance(options = {}, stateOverride = null, compileOpts = {}) {
  const state = stateOverride || loadAppearanceState(options);
  const { appearanceRuntimeFile } = getDataPaths(options);
  const preset = getPresetById(state.presetId);
  let poolPaths = compileOpts.skipPoolScan ? readCachedPoolPaths(appearanceRuntimeFile) : null;
  if (!poolPaths) {
    const { pool } = getWallpaperPool(state, options);
    poolPaths = pool.map((p) => p.filePath);
  }

  const payload = {
    version: 1,
    compiledAt: new Date().toISOString(),
    enabled: state.enabled,
    mode: state.mode,
    preset: {
      id: preset.id,
      darkCss: preset.darkCss,
      lightCss: preset.lightCss,
    },
    activeWallpaperPath: state.activeWallpaperPath,
    separateThemeWallpapers: state.separateThemeWallpapers,
    darkWallpaperPath: state.darkWallpaperPath,
    lightWallpaperPath: state.lightWallpaperPath,
    opacity: state.opacity,
    blurPx: state.blurPx,
    scrimOpacity: state.scrimOpacity,
    saturation: state.saturation,
    glassOpacity: state.glassOpacity,
    fit: state.fit,
    protectCodeReadability: state.protectCodeReadability,
    rotationMode: state.rotationMode,
    rotationMinutes: state.rotationMinutes,
    rotationSource: state.rotationSource,
    poolPaths,
    maxBytes: MAX_WALLPAPER_BYTES,
  };

  writeAtomicJson(appearanceRuntimeFile, payload);
  return { runtimeFile: appearanceRuntimeFile, payload };
}

/**
 * Emergency kill-switch (UI or CLI): immediately disables wallpaper in runtime JSON (<50ms hot revert).
 */
export function emergencyDisableWallpaper(options = {}) {
  const next = saveAppearanceState({ enabled: false }, options);
  return {
    ok: true,
    enabled: false,
    state: next,
    message: '已紧急关闭外观壁纸（渲染进程将在 1~2 秒内自动清除注入样式，无需重启客户端）',
  };
}

/**
 * Pick next distinct wallpaper from the unified pool (library + read-only local folder).
 */
export function pickNextWallpaper(options = {}) {
  const state = loadAppearanceState(options);
  const { pool } = getWallpaperPool(state, options);
  if (pool.length === 0) {
    throw new Error('壁纸库与只读文件夹中均暂无可用图片，请先导入图片或选择壁纸文件夹');
  }
  const candidates = pool.filter((p) => p.filePath !== state.activeWallpaperPath);
  const chosen = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : pool[0];
  const next = saveAppearanceState(
    {
      enabled: true,
      mode: 'image',
      activeWallpaperPath: chosen.filePath,
    },
    options
  );
  return {
    ok: true,
    chosen,
    state: next,
    message: `已切换壁纸：${chosen.name}`,
  };
}

export function getAppearanceStatus(options = {}) {
  const state = loadAppearanceState(options);
  const { libItems, selectedLibItems, folderRes, pool } = getWallpaperPool(state, options);
  let runtimePatched = false;
  let i18nPatchStatus = 'unknown';
  try {
    const i18nSt = getI18nStatus(options);
    i18nPatchStatus = i18nSt?.status || 'unknown';
    runtimePatched = i18nSt?.status === 'patched_by_console';
  } catch {
    // ignore
  }

  return {
    state,
    runtimePatched,
    i18nPatchStatus,
    presets: WALLPAPER_PRESETS,
    library: libItems.map((it) => ({
      ...it,
      thumb: buildThumbDataUri(it.filePath, it.mime),
    })),
    folder: {
      ok: folderRes.ok,
      folderPath: state.folderPath,
      exists: Boolean(folderRes.exists),
      count: (folderRes.items || []).length,
      skippedTooLarge: folderRes.skippedTooLarge || 0,
      error: folderRes.error || null,
      sample: (folderRes.items || []).slice(0, 12).map((it) => ({
        id: it.id,
        name: it.name,
        bytes: it.bytes,
        filePath: it.filePath,
        displayPath: it.displayPath,
      })),
    },
    selectedLibraryCount: selectedLibItems.length,
    poolCount: pool.length,
  };
}

export function handleAppearanceAction(args = {}, options = {}) {
  const action = String(args.action || 'status');
  switch (action) {
    case 'status':
      return getAppearanceStatus(options);
    case 'update_config': {
      const next = saveAppearanceState(args.patch || {}, options);
      if (args.light) {
        return { ok: true, state: next };
      }
      return { ok: true, state: next, status: getAppearanceStatus(options) };
    }
    case 'import_wallpaper': {
      const imported = args.absPath
        ? importWallpaperFromPath(args.absPath, options)
        : importWallpaperFromBase64({ fileName: args.fileName, base64: args.base64 }, options);
      if (args.activate !== false) {
        saveAppearanceState({ enabled: true, mode: 'image', activeWallpaperPath: imported.filePath }, options);
      } else {
        compileRuntimeAppearance(options);
      }
      return { ok: true, imported, status: getAppearanceStatus(options) };
    }
    case 'delete_wallpaper': {
      const del = deleteLibraryWallpaper(args.id || args.fileName, options);
      const cur = loadAppearanceState(options);
      const cleanupPatch = {};
      if (cur.activeWallpaperPath && path.basename(cur.activeWallpaperPath) === del.deleted) {
        cleanupPatch.activeWallpaperPath = '';
        cleanupPatch.mode = 'preset';
      }
      if (cur.darkWallpaperPath && path.basename(cur.darkWallpaperPath) === del.deleted) {
        cleanupPatch.darkWallpaperPath = '';
      }
      if (cur.lightWallpaperPath && path.basename(cur.lightWallpaperPath) === del.deleted) {
        cleanupPatch.lightWallpaperPath = '';
      }
      if (Array.isArray(cur.rotationLibrarySelection)) {
        const nextSel = cur.rotationLibrarySelection.filter(
          (entry) => entry !== `lib:${del.deleted}` && entry !== del.deleted && path.basename(entry) !== del.deleted
        );
        if (nextSel.length !== cur.rotationLibrarySelection.length) {
          cleanupPatch.rotationLibrarySelection = nextSel;
        }
      }
      if (Object.keys(cleanupPatch).length > 0) {
        const nextDark = cleanupPatch.darkWallpaperPath !== undefined ? cleanupPatch.darkWallpaperPath : cur.darkWallpaperPath;
        const nextLight = cleanupPatch.lightWallpaperPath !== undefined ? cleanupPatch.lightWallpaperPath : cur.lightWallpaperPath;
        if (!nextDark && !nextLight && cur.separateThemeWallpapers) {
          cleanupPatch.separateThemeWallpapers = false;
        }
        saveAppearanceState(cleanupPatch, options);
      } else {
        compileRuntimeAppearance(options);
      }
      return { ok: true, deleted: del.deleted, status: getAppearanceStatus(options) };
    }
    case 'scan_folder': {
      const folderPath = String(args.folderPath ?? '').trim();
      const scan = scanLocalFolderReadOnly(folderPath);
      if (!folderPath || scan.ok) {
        saveAppearanceState({ folderPath }, options);
      }
      return { ok: scan.ok, scan, status: getAppearanceStatus(options) };
    }
    case 'pick_folder': {
      const cur = loadAppearanceState(options);
      const initialPath = String(args.initialPath ?? cur.folderPath ?? '').trim();
      const autoSave = args.autoSave !== false;
      return pickLocalFolderNative(initialPath).then((picked) => {
        if (!picked.ok || picked.canceled) {
          return {
            ok: picked.ok,
            canceled: Boolean(picked.canceled),
            folderPath: '',
            error: picked.error || null,
          };
        }
        const scan = scanLocalFolderReadOnly(picked.folderPath);
        if (autoSave && scan.ok) {
          saveAppearanceState({ folderPath: picked.folderPath }, options);
        }
        return {
          ok: scan.ok,
          canceled: false,
          folderPath: picked.folderPath,
          scan,
          status: getAppearanceStatus(options),
        };
      });
    }
    case 'next_wallpaper': {
      const res = pickNextWallpaper(options);
      return { ...res, status: getAppearanceStatus(options) };
    }
    case 'emergency_off': {
      const res = emergencyDisableWallpaper(options);
      return { ...res, status: getAppearanceStatus(options) };
    }
    default:
      throw new Error(`未知外观壁纸操作: ${action}`);
  }
}
