import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { getPluginDeployDir, PACKAGE_ROOT } from './paths.mjs';

export const GITHUB_REPO = 'Horikita-9-Suzune-Max-Ultrafast/antigravity-hub';
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

const MAX_ZIP_BYTES = 15 * 1024 * 1024; // 15 MiB
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_TOTAL_EXTRACTED_BYTES = 30 * 1024 * 1024; // 30 MiB
const MAX_ZIP_ENTRIES = 500;
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Read current plugin version from package.json (fallback to 1.5.4).
 */
export function getCurrentPluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // ignore
  }
  return '1.5.4';
}

/**
 * Parse a semver string like "v1.5.4" or "1.6.0-beta.1".
 */
export function parseSemver(raw) {
  const clean = String(raw || '').trim().replace(/^v/i, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    normalized: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
  };
}

/**
 * Compare two semantic versions.
 * Returns 1 if a > b, -1 if a < b, 0 if equal or unparseable.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1; // release > prerelease
  if (!pb.prerelease) return -1;
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

/**
 * Validate that a release download URL stays strictly within GitHub's official release domains.
 */
export function isAllowedReleaseAssetUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) return false;
    if (host === 'github.com') {
      const expectedPrefix = `/${GITHUB_REPO}/releases/download/`.toLowerCase();
      if (!u.pathname.toLowerCase().startsWith(expectedPrefix)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a standard "<64-hex>  <filename>" sha256 file.
 */
export function parseSha256Text(text) {
  const m = String(text || '').trim().match(/^([0-9a-fA-F]{64})\b/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Zero-dependency, Zip-Slip & Zip-Bomb protected ZIP extractor (Store + Deflate).
 */
export function extractZipSafe(zipBuffer, destDir) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  if (buf.length < 22) {
    throw new Error('Invalid ZIP archive: too small');
  }

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  const minEocdOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minEocdOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: EOCD not found');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP archive exceeds max entry limit (${MAX_ZIP_ENTRIES})`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error('Invalid ZIP archive: central directory out of bounds');
  }

  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });
  const destPrefix = resolvedDest.endsWith(path.sep) ? resolvedDest : resolvedDest + path.sep;

  let ptr = cdOffset;
  let totalExtractedBytes = 0;
  const extractedFiles = [];

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: corrupted central directory header');
    }

    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const expectedCrc = buf.readUInt32LE(ptr + 16);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const fileNameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const externalAttrs = buf.readUInt32LE(ptr + 38);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const rawName = buf.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');
    ptr += 46 + fileNameLen + extraLen + commentLen;

    // Reject symlinks (UNIX mode 0120000 in upper 16 bits of externalAttrs)
    const unixMode = (externalAttrs >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new Error(`ZIP archive contains disallowed symlink entry: ${rawName}`);
    }

    // Strict Zip-Slip validation
    if (!rawName || rawName.includes('\0') || rawName.startsWith('/') || rawName.startsWith('\\') || /^[A-Za-z]:/.test(rawName)) {
      throw new Error(`Unsafe ZIP entry path rejected: ${rawName}`);
    }
    const normalizedRel = rawName.replace(/\\/g, '/');
    const segments = normalizedRel.split('/');
    if (segments.some((seg) => seg === '..')) {
      throw new Error(`Zip-Slip traversal rejected: ${rawName}`);
    }

    const targetPath = path.resolve(resolvedDest, normalizedRel);
    if (targetPath !== resolvedDest && !targetPath.startsWith(destPrefix)) {
      throw new Error(`Zip-Slip resolved outside destination: ${rawName}`);
    }

    const isDir = normalizedRel.endsWith('/');
    if (isDir) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (uncompressedSize > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`ZIP entry exceeds single file limit: ${rawName}`);
    }
    totalExtractedBytes += uncompressedSize;
    if (totalExtractedBytes > MAX_TOTAL_EXTRACTED_BYTES) {
      throw new Error(`ZIP archive exceeds total extracted size limit (${MAX_TOTAL_EXTRACTED_BYTES} bytes)`);
    }

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local file header for ${rawName}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`ZIP entry data truncated: ${rawName}`);
    }

    const compressedData = buf.subarray(dataStart, dataEnd);
    let content;
    if (compressionMethod === 0) {
      content = compressedData;
    } else if (compressionMethod === 8) {
      content = zlib.inflateRawSync(compressedData, { maxOutputLength: MAX_SINGLE_FILE_BYTES });
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${rawName}`);
    }

    if (content.length !== uncompressedSize) {
      throw new Error(`ZIP entry size mismatch for ${rawName}`);
    }
    if (typeof zlib.crc32 === 'function') {
      const actualCrc = zlib.crc32(content) >>> 0;
      if (actualCrc !== expectedCrc) {
        throw new Error(`ZIP entry CRC32 mismatch for ${rawName}`);
      }
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
    extractedFiles.push(normalizedRel);
  }

  return { fileCount: extractedFiles.length, totalExtractedBytes, files: extractedFiles };
}

/**
 * Fetch helper with timeout and redirect host validation.
 */
async function safeFetch(url, { fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS, headers = {}, validateUrl = null } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API unavailable in current runtime');
  }
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': `antigravity-hub/${getCurrentPluginVersion()}`,
      ...headers,
    },
  });
  if (validateUrl && res.url && !validateUrl(res.url)) {
    throw new Error(`Redirected URL blocked by domain allowlist: ${res.url}`);
  }
  return res;
}

/**
 * Read-only check against GitHub Releases API for the latest Antigravity Hub version.
 */
export async function checkForUpdate(options = {}) {
  const currentVersion = String(options.currentVersion || getCurrentPluginVersion()).replace(/^v/i, '');
  const apiUrl = options.apiUrl || RELEASES_API_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) || CHECK_TIMEOUT_MS;

  try {
    const res = await safeFetch(apiUrl, {
      fetchImpl,
      timeoutMs,
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        error: 'rate_limited',
        message: 'GitHub API rate limit reached; please retry later or open Releases directly.',
        currentVersion,
        releaseUrl: RELEASES_PAGE_URL,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: 'http_error',
        message: `GitHub API returned HTTP ${res.status}`,
        currentVersion,
        releaseUrl: RELEASES_PAGE_URL,
      };
    }

    const data = await res.json();
    const rawTag = String(data?.tag_name || data?.name || '').trim();
    const parsedLatest = parseSemver(rawTag);
    if (!parsedLatest) {
      return {
        ok: false,
        error: 'invalid_release',
        message: `Unable to parse latest release version from "${rawTag}"`,
        currentVersion,
        releaseUrl: data?.html_url || RELEASES_PAGE_URL,
      };
    }

    const latestVersion = parsedLatest.normalized;
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    const zipAssetRaw = assets.find((a) => /^context-cache-v[\d.]+(?:-[0-9A-Za-z.-]+)?-plugin\.zip$/i.test(String(a?.name || '')));
    const shaAssetRaw = zipAssetRaw
      ? assets.find((a) => String(a?.name || '').toLowerCase() === `${zipAssetRaw.name}.sha256`.toLowerCase())
      : null;

    const zipAsset = zipAssetRaw && isAllowedReleaseAssetUrl(zipAssetRaw.browser_download_url)
      ? {
          name: zipAssetRaw.name,
          url: zipAssetRaw.browser_download_url,
          size: Number(zipAssetRaw.size || 0),
        }
      : null;
    const shaAsset = shaAssetRaw && isAllowedReleaseAssetUrl(shaAssetRaw.browser_download_url)
      ? {
          name: shaAssetRaw.name,
          url: shaAssetRaw.browser_download_url,
          size: Number(shaAssetRaw.size || 0),
        }
      : null;

    const rawBody = String(data?.body || '').trim();
    const notes = rawBody.length > 1800 ? `${rawBody.slice(0, 1800)}\n...` : rawBody;

    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
      releaseUrl: data?.html_url || `${RELEASES_PAGE_URL}/tag/v${latestVersion}`,
      publishedAt: data?.published_at || '',
      notes,
      zipAsset,
      shaAsset,
      canAutoUpdate: Boolean(zipAsset && shaAsset),
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout/i.test(String(err?.message || ''));
    return {
      ok: false,
      error: isTimeout ? 'network_timeout' : 'network_error',
      message: isTimeout
        ? 'Checking GitHub Releases timed out. Please retry or download manually from GitHub.'
        : (err?.message || String(err)),
      currentVersion,
      releaseUrl: RELEASES_PAGE_URL,
    };
  }
}

/**
 * Download, SHA-256 verify, safely extract, and atomically swap the deployed plugin directory.
 * Never touches %USERPROFILE%\.context-cache user data and rolls back automatically on swap error.
 */
export async function applySelfUpdate(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const targetPluginDir = path.resolve(options.pluginDir || getPluginDeployDir(options));
  const check = options.releaseInfo || (await checkForUpdate(options));

  if (!check.ok) {
    return {
      ok: false,
      status: 'check_failed',
      error: check.error,
      message: check.message,
      releaseUrl: check.releaseUrl || RELEASES_PAGE_URL,
    };
  }

  if (!check.hasUpdate && !options.force) {
    return {
      ok: true,
      status: 'up_to_date',
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
      message: `Already on latest version v${check.currentVersion}.`,
    };
  }

  if (!check.zipAsset || !check.shaAsset) {
    return {
      ok: false,
      status: 'missing_verification_assets',
      error: 'missing_sha256_asset',
      message: 'Release is missing its .sha256 checksum asset; automatic install is refused for safety. Please download manually.',
      releaseUrl: check.releaseUrl,
    };
  }

  if (!isAllowedReleaseAssetUrl(check.zipAsset.url) || !isAllowedReleaseAssetUrl(check.shaAsset.url)) {
    return {
      ok: false,
      status: 'blocked_url',
      error: 'url_not_allowed',
      message: 'Download URL failed GitHub release domain allowlist check.',
      releaseUrl: check.releaseUrl,
    };
  }

  // 1. Download & parse .sha256 checksum
  let expectedSha256;
  try {
    const shaRes = await safeFetch(check.shaAsset.url, {
      fetchImpl,
      timeoutMs: Number(options.timeoutMs) || CHECK_TIMEOUT_MS,
      validateUrl: isAllowedReleaseAssetUrl,
    });
    if (!shaRes.ok) {
      return {
        ok: false,
        status: 'download_failed',
        error: 'sha_download_failed',
        message: `Failed to download checksum file (HTTP ${shaRes.status}).`,
        releaseUrl: check.releaseUrl,
      };
    }
    expectedSha256 = parseSha256Text(await shaRes.text());
    if (!expectedSha256) {
      return {
        ok: false,
        status: 'invalid_checksum',
        error: 'invalid_sha256_format',
        message: 'Checksum file format is invalid.',
        releaseUrl: check.releaseUrl,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'download_failed',
      error: 'sha_download_error',
      message: err?.message || String(err),
      releaseUrl: check.releaseUrl,
    };
  }

  // 2. Download plugin zip & enforce SHA-256 match
  let zipBuffer;
  try {
    const zipRes = await safeFetch(check.zipAsset.url, {
      fetchImpl,
      timeoutMs: Number(options.downloadTimeoutMs) || DOWNLOAD_TIMEOUT_MS,
      validateUrl: isAllowedReleaseAssetUrl,
    });
    if (!zipRes.ok) {
      return {
        ok: false,
        status: 'download_failed',
        error: 'zip_download_failed',
        message: `Failed to download plugin bundle (HTTP ${zipRes.status}).`,
        releaseUrl: check.releaseUrl,
      };
    }
    const ab = await zipRes.arrayBuffer();
    zipBuffer = Buffer.from(ab);
    if (zipBuffer.length === 0 || zipBuffer.length > MAX_ZIP_BYTES) {
      return {
        ok: false,
        status: 'download_failed',
        error: 'zip_size_invalid',
        message: `Downloaded bundle size (${zipBuffer.length} bytes) exceeds allowed bounds.`,
        releaseUrl: check.releaseUrl,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'download_failed',
      error: 'zip_download_error',
      message: err?.message || String(err),
      releaseUrl: check.releaseUrl,
    };
  }

  const actualSha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  if (actualSha256 !== expectedSha256) {
    return {
      ok: false,
      status: 'verification_failed',
      error: 'sha256_mismatch',
      message: `SHA-256 verification failed (expected ${expectedSha256.slice(0, 12)}..., got ${actualSha256.slice(0, 12)}...). Update aborted.`,
      releaseUrl: check.releaseUrl,
    };
  }

  // 3. Extract safely to sibling staging directory
  const parentDir = path.dirname(targetPluginDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const stagingRoot = path.join(parentDir, `.context-cache-staging-${stamp}`);
  const backupDir = path.join(parentDir, `.context-cache-prev-${stamp}`);

  try {
    extractZipSafe(zipBuffer, stagingRoot);

    const candidateNested = path.join(stagingRoot, 'context-cache');
    const extractedPluginDir = fs.existsSync(path.join(candidateNested, 'plugin.json'))
      ? candidateNested
      : fs.existsSync(path.join(stagingRoot, 'plugin.json'))
        ? stagingRoot
        : null;

    if (!extractedPluginDir) {
      throw new Error('Extracted bundle is missing plugin.json');
    }
    if (!fs.existsSync(path.join(extractedPluginDir, 'src', 'mcp', 'server.mjs'))) {
      throw new Error('Extracted bundle is missing src/mcp/server.mjs');
    }
    if (fs.existsSync(path.join(extractedPluginDir, 'node_modules'))) {
      throw new Error('Extracted bundle unexpectedly contains node_modules');
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(extractedPluginDir, 'plugin.json'), 'utf8'));
    if (manifest?.name !== 'context-cache') {
      throw new Error(`Unexpected plugin name in bundle: ${manifest?.name}`);
    }

    // 4. Atomic directory swap with automatic rollback on error (e.g., Windows file lock)
    const hadExisting = fs.existsSync(targetPluginDir);
    const renameFn = options.renameSyncImpl || fs.renameSync;
    let movedOldToBackup = false;

    try {
      if (hadExisting) {
        renameFn(targetPluginDir, backupDir);
        movedOldToBackup = true;
      }
      renameFn(extractedPluginDir, targetPluginDir);
    } catch (swapErr) {
      // Roll back immediately if swap failed mid-way
      if (movedOldToBackup && !fs.existsSync(targetPluginDir) && fs.existsSync(backupDir)) {
        try {
          fs.renameSync(backupDir, targetPluginDir);
        } catch {
          // best-effort rollback
        }
      }
      const code = swapErr?.code || '';
      const isLock = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      return {
        ok: false,
        status: 'swap_failed',
        error: isLock ? 'windows_file_lock' : 'swap_error',
        message: isLock
          ? 'Plugin files are currently locked by a running process. Rolled back cleanly; close the floating window or extract the Release zip manually.'
          : (swapErr?.message || String(swapErr)),
        rolledBack: true,
        releaseUrl: check.releaseUrl,
      };
    }

    // 5. Best-effort cleanup of backup & staging directories
    try {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    } catch {
      // ignore leftover backup cleanup failure
    }

    return {
      ok: true,
      status: 'updated',
      previousVersion: check.currentVersion,
      updatedVersion: manifest.version || check.latestVersion,
      sha256: actualSha256,
      targetPluginDir,
      requiresRestart: true,
      releaseUrl: check.releaseUrl,
      message: `Updated Antigravity Hub to v${manifest.version || check.latestVersion} (SHA-256 verified). Restart Antigravity to take effect.`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'extract_failed',
      error: 'extract_error',
      message: err?.message || String(err),
      releaseUrl: check.releaseUrl,
    };
  } finally {
    try {
      if (fs.existsSync(stagingRoot)) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
