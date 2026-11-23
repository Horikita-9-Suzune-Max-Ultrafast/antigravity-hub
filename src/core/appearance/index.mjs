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
} from './library.mjs';

export {
  WALLPAPER_PRESETS,
  MAX_WALLPAPER_BYTES,
  listLibraryWallpapers,
  scanLocalFolderReadOnly,
  importWallpaperFromBase64,
  importWallpaperFromPath,
  deleteLibraryWallpaper,
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
  glassOpacity: 0.86, // 0.55 ~ 0.98
  fit: 'cover', // 'cover' | 'contain' | 'center'
  protectCodeReadability: true,
  rotationMode: 'off', // 'off' | 'startup' | 'interval'
  rotationMinutes: 30, // 15 | 30 | 60 | 240
  folderPath: '',
  updatedAt: null,
};

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
    glassOpacity: Number(clamp(src.glassOpacity, 0.55, 0.98, DEFAULT_APPEARANCE_STATE.glassOpacity).toFixed(2)),
    fit,
    protectCodeReadability: src.protectCodeReadability !== false,
    rotationMode,
    rotationMinutes: Math.round(clamp(src.rotationMinutes, 5, 1440, DEFAULT_APPEARANCE_STATE.rotationMinutes)),
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
  compileRuntimeAppearance(options, next);
  return next;
}

/**
 * Collect the unified wallpaper pool (library + read-only local folder).
 */
export function getWallpaperPool(state, options = {}) {
  const libItems = listLibraryWallpapers(options);
  const folderRes = state.folderPath ? scanLocalFolderReadOnly(state.folderPath) : { ok: true, items: [], skippedTooLarge: 0 };
  const pool = [...libItems, ...(folderRes.items || [])];
  return { libItems, folderRes, pool };
}

/**
 * Compile runtime-appearance.json consumed hot by the preload Fail-Open engine.
 */
export function compileRuntimeAppearance(options = {}, stateOverride = null) {
  const state = stateOverride || loadAppearanceState(options);
  const { appearanceRuntimeFile } = getDataPaths(options);
  const preset = getPresetById(state.presetId);
  const { pool } = getWallpaperPool(state, options);

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
    glassOpacity: state.glassOpacity,
    fit: state.fit,
    protectCodeReadability: state.protectCodeReadability,
    rotationMode: state.rotationMode,
    rotationMinutes: state.rotationMinutes,
    poolPaths: pool.map((p) => p.filePath),
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
  const { libItems, folderRes, pool } = getWallpaperPool(state, options);
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
      if (cur.activeWallpaperPath && path.basename(cur.activeWallpaperPath) === del.deleted) {
        saveAppearanceState({ activeWallpaperPath: '', mode: 'preset' }, options);
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
