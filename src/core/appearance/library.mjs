import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getDataPaths, formatDisplayPath } from '../paths.mjs';

export const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg']);
export const MAX_WALLPAPER_BYTES = 15 * 1024 * 1024; // 15 MiB hard circuit breaker
const MAX_FOLDER_SCAN = 200;
const MAX_INLINE_RAW_BYTES = 128 * 1024; // 128 KiB cap for inline raw Base64 fallback
const THUMB_MAX_WIDTH = 320;
const MAX_THUMB_CACHE = 64;
const MAX_THUMB_CACHE_BYTES = 16 * 1024 * 1024; // 16 MiB strict total byte budget

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

  if (buf.length > MAX_INLINE_RAW_BYTES) {
    scheduleThumbGeneration(targetPath, options);
  }

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

  if (buf.length > MAX_INLINE_RAW_BYTES) {
    scheduleThumbGeneration(targetPath, options);
  }

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
  evictThumbCacheKey(target);
  return { ok: true, deleted: raw };
}

const THUMB_CACHE = new Map();
let thumbCacheTotalBytes = 0;
const PENDING_THUMB_JOBS = new Set();
let activeThumbJobs = 0;
const MAX_CONCURRENT_THUMB_JOBS = 2;

function evictThumbCacheKey(absPath) {
  const existing = THUMB_CACHE.get(absPath);
  if (!existing) return;
  thumbCacheTotalBytes = Math.max(0, thumbCacheTotalBytes - (existing.bytes || 0));
  THUMB_CACHE.delete(absPath);
}

function putThumbCache(absPath, entry) {
  const bytes = Buffer.byteLength(entry.uri, 'utf8');
  if (bytes > MAX_THUMB_CACHE_BYTES) return;
  evictThumbCacheKey(absPath);
  while (
    THUMB_CACHE.size >= MAX_THUMB_CACHE ||
    (THUMB_CACHE.size > 0 && thumbCacheTotalBytes + bytes > MAX_THUMB_CACHE_BYTES)
  ) {
    const oldestKey = THUMB_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    evictThumbCacheKey(oldestKey);
  }
  THUMB_CACHE.set(absPath, { ...entry, bytes });
  thumbCacheTotalBytes += bytes;
}

export function clearThumbCache() {
  THUMB_CACHE.clear();
  thumbCacheTotalBytes = 0;
}

export function getThumbCacheStats() {
  return {
    entries: THUMB_CACHE.size,
    totalBytes: thumbCacheTotalBytes,
    maxEntries: MAX_THUMB_CACHE,
    maxBytes: MAX_THUMB_CACHE_BYTES,
  };
}

function isInTmpDir(filePath) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const p = path.resolve(filePath).toLowerCase();
  return p === tmp || p.startsWith(`${tmp}${path.sep}`);
}

function hasResizableImageHeader(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const hdr = Buffer.alloc(8);
    try {
      const n = fs.readSync(fd, hdr, 0, 8, 0);
      if (n < 4) return false;
    } finally {
      fs.closeSync(fd);
    }
    // PNG magic: 89 50 4E 47
    if (hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4e && hdr[3] === 0x47) return true;
    // JPEG magic: FF D8 FF
    if (hdr[0] === 0xff && hdr[1] === 0xd8 && hdr[2] === 0xff) return true;
    return false;
  } catch {
    return false;
  }
}

function getDiskThumbPath(absPath, st, options = {}) {
  if (!options?.dataDir && isInTmpDir(absPath)) return null;
  const { dataDir } = getDataPaths(options);
  const thumbsDir = path.join(dataDir, 'runtime', 'thumbs');
  const hash = crypto
    .createHash('sha1')
    .update(`${path.resolve(absPath).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
  return { thumbsDir, thumbFile: path.join(thumbsDir, `${hash}.jpg`) };
}

function scheduleThumbGeneration(absPath, options = {}) {
  if (options?.skipAsyncThumb) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  if (activeThumbJobs >= MAX_CONCURRENT_THUMB_JOBS) return;
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return;
  }
  if (st.size <= MAX_INLINE_RAW_BYTES || st.size > MAX_WALLPAPER_BYTES) return;
  if (!hasResizableImageHeader(absPath)) return;

  const diskLoc = getDiskThumbPath(absPath, st, options);
  if (!diskLoc) return;
  if (fs.existsSync(diskLoc.thumbFile)) return;
  if (PENDING_THUMB_JOBS.has(diskLoc.thumbFile)) return;

  try {
    ensureDir(diskLoc.thumbsDir);
  } catch {
    return;
  }

  PENDING_THUMB_JOBS.add(diskLoc.thumbFile);
  activeThumbJobs++;
  const tmpOut = `${diskLoc.thumbFile}.tmp.${process.pid}.${Date.now()}.jpg`;

  const finish = () => {
    PENDING_THUMB_JOBS.delete(diskLoc.thumbFile);
    activeThumbJobs = Math.max(0, activeThumbJobs - 1);
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {
      // ignore
    }
  };

  if (process.platform === 'win32') {
    const escSrc = path.resolve(absPath).replace(/'/g, "''");
    const escDst = path.resolve(tmpOut).replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      `$img = [System.Drawing.Image]::FromFile('${escSrc}')`,
      'try {',
      `  $maxW = ${THUMB_MAX_WIDTH}`,
      '  $w = $img.Width; $h = $img.Height',
      '  if ($w -gt $maxW) { $nh = [Math]::Max(1, [int][Math]::Round($h * ($maxW / [double]$w))); $nw = $maxW } else { $nw = $w; $nh = $h }',
      '  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)',
      '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
      '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $g.DrawImage($img, 0, 0, $nw, $nh)',
      '  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1',
      '  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)',
      '  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]78)',
      `  $bmp.Save('${escDst}', $codec, $ep)`,
      '  $g.Dispose(); $bmp.Dispose()',
      '} finally { $img.Dispose() }',
    ].join('; ');

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 },
      (err) => {
        try {
          if (!err && fs.existsSync(tmpOut)) {
            const outSt = fs.statSync(tmpOut);
            if (outSt.size > 0 && outSt.size <= MAX_INLINE_RAW_BYTES) {
              fs.renameSync(tmpOut, diskLoc.thumbFile);
            }
          }
        } catch {
          // ignore
        } finally {
          finish();
        }
      }
    );
    child.unref?.();
    return;
  }

  const child = execFile(
    'sips',
    ['-Z', String(THUMB_MAX_WIDTH), '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', absPath, '--out', tmpOut],
    { timeout: 15_000 },
    (err) => {
      try {
        if (!err && fs.existsSync(tmpOut)) {
          const outSt = fs.statSync(tmpOut);
          if (outSt.size > 0 && outSt.size <= MAX_INLINE_RAW_BYTES) {
            fs.renameSync(tmpOut, diskLoc.thumbFile);
          }
        }
      } catch {
        // ignore
      } finally {
        finish();
      }
    }
  );
  child.unref?.();
}

/**
 * Generate a bounded lightweight data-URI thumbnail preview for UI cards.
 * - Strictly bounds memory cache by <= 16 MiB total bytes (LRU eviction).
 * - Uses <= 320px cached disk thumbnails under runtime/thumbs/ when available.
 * - Falls back to inline raw Base64 ONLY for small <= 128 KiB files; omits giant multi-MB raw Base64
 *   (UI uses thumbUrl `/api/wallpaper/<id>` and picks up resized thumbnail once ready).
 */
export function buildThumbDataUri(absPath, mime, options = {}) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (st.size <= 0 || st.size > MAX_WALLPAPER_BYTES) return null;

    const cached = THUMB_CACHE.get(absPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      // Refresh LRU position
      THUMB_CACHE.delete(absPath);
      THUMB_CACHE.set(absPath, cached);
      return cached.uri;
    }

    // 1. Check pre-generated lightweight <= 320px disk thumbnail
    const diskLoc = getDiskThumbPath(absPath, st, options);
    if (diskLoc && fs.existsSync(diskLoc.thumbFile)) {
      try {
        const thumbSt = fs.statSync(diskLoc.thumbFile);
        if (thumbSt.size > 0 && thumbSt.size <= MAX_INLINE_RAW_BYTES) {
          const b64 = fs.readFileSync(diskLoc.thumbFile).toString('base64');
          const uri = `data:image/jpeg;base64,${b64}`;
          putThumbCache(absPath, { mtimeMs: st.mtimeMs, size: st.size, uri });
          return uri;
        }
      } catch {
        // fall through
      }
    }

    // 2. Small files (<= 128 KiB): safe to inline directly without spawning resizer
    if (st.size <= MAX_INLINE_RAW_BYTES) {
      const b64 = fs.readFileSync(absPath).toString('base64');
      const uri = `data:${mime || 'image/png'};base64,${b64}`;
      putThumbCache(absPath, { mtimeMs: st.mtimeMs, size: st.size, uri });
      return uri;
    }

    // 3. Large files (> 128 KiB): NEVER inline multi-MB raw Base64 into status JSON;
    //    kick off non-blocking background thumbnail generation for subsequent renders.
    scheduleThumbGeneration(absPath, options);
    return null;
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
