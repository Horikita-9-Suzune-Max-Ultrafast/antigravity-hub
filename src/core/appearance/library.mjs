import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getDataPaths, formatDisplayPath } from '../paths.mjs';

export const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg']);
export const MAX_WALLPAPER_BYTES = 15 * 1024 * 1024; // 15 MiB hard circuit breaker
const MAX_FOLDER_SCAN = 200;

export const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFileName(rawName) {
  const base = path.basename(String(rawName || 'wallpaper.png'));
  const ext = path.extname(base).toLowerCase();
  const safeExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '';
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]+/g, '_')
    .slice(0, 64) || 'wallpaper';
  return { stem, ext: safeExt };
}

function isInsideDir(targetPath, rootDir) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function listLibraryWallpapers(options = {}) {
  const { wallpapersDir } = getDataPaths(options);
  if (!fs.existsSync(wallpapersDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(wallpapersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) continue;
    const absPath = path.join(wallpapersDir, e.name);
    try {
      const stat = fs.statSync(absPath);
      if (stat.size <= 0 || stat.size > MAX_WALLPAPER_BYTES) continue;
      items.push({
        id: `lib:${e.name}`,
        name: e.name,
        source: 'library',
        ext,
        mime: EXT_MIME[ext] || 'image/png',
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        filePath: absPath,
        displayPath: formatDisplayPath(absPath),
      });
    } catch {
      // ignore unreadable file
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

/**
 * Strictly read-only scan of a user-provided local folder for valid static wallpapers.
 * Never mutates, renames, or deletes anything inside folderPath.
 */
export function scanLocalFolderReadOnly(folderPath) {
  const raw = String(folderPath || '').trim();
  if (!raw) return { ok: true, folderPath: '', exists: false, items: [], skippedTooLarge: 0 };
  const absDir = path.resolve(raw);
  if (!fs.existsSync(absDir)) {
    return { ok: false, folderPath: absDir, exists: false, items: [], skippedTooLarge: 0, error: '文件夹不存在' };
  }
  let stat;
  try {
    stat = fs.statSync(absDir);
  } catch (err) {
    return { ok: false, folderPath: absDir, exists: false, items: [], skippedTooLarge: 0, error: err.message };
  }
  if (!stat.isDirectory()) {
    return { ok: false, folderPath: absDir, exists: false, items: [], skippedTooLarge: 0, error: '目标路径不是文件夹' };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, folderPath: absDir, exists: true, items: [], skippedTooLarge: 0, error: `无读取权限: ${err.message}` };
  }

  const items = [];
  let skippedTooLarge = 0;
  for (const e of entries) {
    if (items.length >= MAX_FOLDER_SCAN) break;
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) continue;
    const absPath = path.join(absDir, e.name);
    try {
      const st = fs.statSync(absPath);
      if (st.size <= 0) continue;
      if (st.size > MAX_WALLPAPER_BYTES) {
        skippedTooLarge++;
        continue;
      }
      items.push({
        id: `dir:${crypto.createHash('sha1').update(absPath.toLowerCase()).digest('hex').slice(0, 12)}`,
        name: e.name,
        source: 'folder',
        ext,
        mime: EXT_MIME[ext] || 'image/png',
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        filePath: absPath,
        displayPath: formatDisplayPath(absPath),
      });
    } catch {
      // ignore unreadable entry
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    folderPath: absDir,
    displayFolderPath: formatDisplayPath(absDir),
    exists: true,
    items,
    skippedTooLarge,
  };
}

/**
 * Import a static wallpaper from base64 data (UI file picker) into ~/.context-cache/wallpapers/.
 */
export function importWallpaperFromBase64({ fileName, base64 }, options = {}) {
  const { stem, ext } = sanitizeFileName(fileName);
  if (!ext) {
    throw new Error('仅支持静态图片格式：.png / .jpg / .jpeg / .webp / .avif / .svg');
  }
  const cleanB64 = String(base64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
  if (!cleanB64) throw new Error('图片内容为空');

  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length === 0) throw new Error('图片解码后为空');
  if (buf.length > MAX_WALLPAPER_BYTES) {
    throw new Error(`单张壁纸体积超出安全上限（最大 15 MiB，当前 ${(buf.length / (1024 * 1024)).toFixed(1)} MiB）`);
  }

  const { wallpapersDir } = getDataPaths(options);
  ensureDir(wallpapersDir);

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  const finalName = `${stem}-${hash}${ext}`;
  const targetPath = path.join(wallpapersDir, finalName);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, targetPath);

  return {
    id: `lib:${finalName}`,
    name: finalName,
    source: 'library',
    ext,
    mime: EXT_MIME[ext] || 'image/png',
    bytes: buf.length,
    filePath: targetPath,
    displayPath: formatDisplayPath(targetPath),
  };
}

/**
 * Import a static wallpaper by copying from a local path into ~/.context-cache/wallpapers/.
 */
export function importWallpaperFromPath(absPath, options = {}) {
  const src = path.resolve(String(absPath || ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error('源图片文件不存在');
  }
  const { stem, ext } = sanitizeFileName(src);
  if (!ext) {
    throw new Error('仅支持静态图片格式：.png / .jpg / .jpeg / .webp / .avif / .svg');
  }
  const stat = fs.statSync(src);
  if (stat.size <= 0 || stat.size > MAX_WALLPAPER_BYTES) {
    throw new Error(`单张壁纸体积超出安全上限（最大 15 MiB）`);
  }
  const buf = fs.readFileSync(src);
  const { wallpapersDir } = getDataPaths(options);
  ensureDir(wallpapersDir);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  const finalName = `${stem}-${hash}${ext}`;
  const targetPath = path.join(wallpapersDir, finalName);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, targetPath);

  return {
    id: `lib:${finalName}`,
    name: finalName,
    source: 'library',
    ext,
    mime: EXT_MIME[ext] || 'image/png',
    bytes: buf.length,
    filePath: targetPath,
    displayPath: formatDisplayPath(targetPath),
  };
}

/**
 * Delete a wallpaper strictly inside ~/.context-cache/wallpapers/. Never touches external folders.
 */
export function deleteLibraryWallpaper(fileNameOrId, options = {}) {
  const { wallpapersDir } = getDataPaths(options);
  const raw = String(fileNameOrId || '').replace(/^lib:/, '');
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error('非法壁纸文件名，已拦截删除操作');
  }
  const target = path.resolve(wallpapersDir, raw);
  if (!isInsideDir(target, wallpapersDir)) {
    throw new Error('拒绝删除壁纸库目录以外的任何文件');
  }
  if (!fs.existsSync(target)) {
    throw new Error('目标壁纸不存在');
  }
  fs.unlinkSync(target);
  return { ok: true, deleted: raw };
}

const THUMB_CACHE = new Map();
const MAX_THUMB_CACHE = 64;

/**
 * Generate a data-URI thumbnail preview for UI cards with (mtimeMs, size) memory caching.
 */
export function buildThumbDataUri(absPath, mime) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (st.size <= 0 || st.size > 8 * 1024 * 1024) return null;
    const cached = THUMB_CACHE.get(absPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.uri;
    }
    const b64 = fs.readFileSync(absPath).toString('base64');
    const uri = `data:${mime || 'image/png'};base64,${b64}`;
    if (THUMB_CACHE.size >= MAX_THUMB_CACHE) {
      const oldestKey = THUMB_CACHE.keys().next().value;
      if (oldestKey !== undefined) THUMB_CACHE.delete(oldestKey);
    }
    THUMB_CACHE.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, uri });
    return uri;
  } catch {
    return null;
  }
}

/**
 * Open a native OS folder picker dialog without blocking the Node.js event loop.
 * Strictly returns the chosen directory path; never mutates any files.
 */
export function pickLocalFolderNative(initialPath = '') {
  return new Promise((resolve) => {
    const startDir = String(initialPath || '').trim();
    const safeInitial = startDir && fs.existsSync(startDir) ? path.resolve(startDir) : '';

    if (process.platform === 'win32') {
      const escapedInit = safeInitial.replace(/'/g, "''");
      const psScript = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.StartPosition = "Manual"',
        '$owner.Location = New-Object System.Drawing.Point(-32000, -32000)',
        '$owner.Size = New-Object System.Drawing.Size(1, 1)',
        '$owner.ShowInTaskbar = $false',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dlg.Description = "选择本地壁纸文件夹（严格只读）"',
        '$dlg.ShowNewFolderButton = $false',
        escapedInit ? `$dlg.SelectedPath = '${escapedInit}'` : '',
        '$owner.Show()',
        '$res = $dlg.ShowDialog($owner)',
        '$owner.Close()',
        '$owner.Dispose()',
        'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
      ]
        .filter(Boolean)
        .join('; ');

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript],
        { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false, canceled: false, folderPath: '', error: `无法打开系统文件夹选择框: ${err.message}` });
            return;
          }
          const picked = String(stdout || '').trim();
          if (!picked) {
            resolve({ ok: true, canceled: true, folderPath: '' });
            return;
          }
          resolve({ ok: true, canceled: false, folderPath: picked });
        }
      );
      return;
    }

    if (process.platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "选择本地壁纸文件夹")'],
        { timeout: 180000 },
        (err, stdout) => {
          if (err) {
            if (/User canceled|-128/i.test(String(err.message || ''))) {
              resolve({ ok: true, canceled: true, folderPath: '' });
              return;
            }
            resolve({ ok: false, canceled: false, folderPath: '', error: err.message });
            return;
          }
          const picked = String(stdout || '').trim().replace(/\/+$/, '');
          resolve({ ok: true, canceled: !picked, folderPath: picked });
        }
      );
      return;
    }

    execFile(
      'zenity',
      ['--file-selection', '--directory', '--title=选择本地壁纸文件夹'],
      { timeout: 180000 },
      (err, stdout) => {
        if (err) {
          if (err.code === 1) {
            resolve({ ok: true, canceled: true, folderPath: '' });
            return;
          }
          resolve({ ok: false, canceled: false, folderPath: '', error: '当前环境不支持原生目录选择框，请直接输入路径' });
          return;
        }
        const picked = String(stdout || '').trim();
        resolve({ ok: true, canceled: !picked, folderPath: picked });
      }
    );
  });
}
