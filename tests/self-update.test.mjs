import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  compareSemver,
  isAllowedReleaseAssetUrl,
  extractZipSafe,
  checkForUpdate,
  applySelfUpdate,
  GITHUB_REPO,
} from '../src/core/self-update.mjs';

/**
 * Minimal pure-Node ZIP builder (Deflate/Store) for self-contained unit tests.
 */
function buildTestZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '', 'utf8');
    const useDeflate = entry.deflate !== false && rawBuf.length > 0;
    const compBuf = useDeflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = useDeflate ? 8 : 0;
    const crc = zlib.crc32(rawBuf) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compBuf.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, compBuf);
    centralParts.push(central);
    offset += local.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function makeValidBundleZip(version = '1.5.5') {
  return buildTestZip([
    {
      name: 'context-cache/plugin.json',
      content: JSON.stringify({ name: 'context-cache', version }, null, 2),
    },
    {
      name: 'context-cache/src/mcp/server.mjs',
      content: `export const VERSION = '${version}';\n`,
    },
  ]);
}

test('compareSemver and release download domain allowlist', () => {
  assert.equal(compareSemver('1.5.5', '1.5.4'), 1);
  assert.equal(compareSemver('v1.5.4', '1.5.4'), 0);
  assert.equal(compareSemver('1.5.4', '1.5.5'), -1);
  assert.equal(compareSemver('1.6.0', '1.6.0-beta.1'), 1);

  assert.equal(
    isAllowedReleaseAssetUrl(`https://github.com/${GITHUB_REPO}/releases/download/v1.5.5/context-cache-v1.5.5-plugin.zip`),
    true
  );
  assert.equal(isAllowedReleaseAssetUrl('https://objects.githubusercontent.com/github-production-release-asset/123'), true);
  assert.equal(isAllowedReleaseAssetUrl(`http://github.com/${GITHUB_REPO}/releases/download/v1.5.5/a.zip`), false);
  assert.equal(isAllowedReleaseAssetUrl('https://github.com/evil/repo/releases/download/v1.5.5/a.zip'), false);
  assert.equal(isAllowedReleaseAssetUrl('https://evil.example.com/context-cache.zip'), false);
});

test('checkForUpdate detects newer release, up-to-date state, and timeout fallback', async () => {
  const zipUrl = `https://github.com/${GITHUB_REPO}/releases/download/v1.5.5/context-cache-v1.5.5-plugin.zip`;
  const shaUrl = `${zipUrl}.sha256`;

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    json: async () => ({
      tag_name: 'v1.5.5',
      html_url: `https://github.com/${GITHUB_REPO}/releases/tag/v1.5.5`,
      published_at: '2026-11-25T00:00:00Z',
      body: 'Release highlights',
      assets: [
        { name: 'context-cache-v1.5.5-plugin.zip', browser_download_url: zipUrl, size: 1234 },
        { name: 'context-cache-v1.5.5-plugin.zip.sha256', browser_download_url: shaUrl, size: 96 },
      ],
    }),
  });

  const newer = await checkForUpdate({ currentVersion: '1.5.4', fetchImpl: mockFetch });
  assert.equal(newer.ok, true);
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.latestVersion, '1.5.5');
  assert.equal(newer.canAutoUpdate, true);

  const same = await checkForUpdate({ currentVersion: '1.5.5', fetchImpl: mockFetch });
  assert.equal(same.ok, true);
  assert.equal(same.hasUpdate, false);

  const timedOut = await checkForUpdate({
    currentVersion: '1.5.4',
    fetchImpl: async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    },
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, 'network_timeout');
});

test('extractZipSafe blocks Zip-Slip traversal entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-zipslip-'));
  try {
    const evilZip = buildTestZip([{ name: '../escaped.txt', content: 'pwned' }]);
    assert.throws(() => extractZipSafe(evilZip, path.join(tmp, 'dest')), /Zip-Slip|Unsafe ZIP/i);
    assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applySelfUpdate rejects tampered zip on SHA-256 mismatch without touching plugin dir', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sha-'));
  const pluginDir = path.join(tmp, 'context-cache');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'context-cache', version: '1.5.4' }));

  const zipBuf = makeValidBundleZip('1.5.5');
  const wrongSha = '0'.repeat(64);
  const zipUrl = `https://github.com/${GITHUB_REPO}/releases/download/v1.5.5/context-cache-v1.5.5-plugin.zip`;
  const shaUrl = `${zipUrl}.sha256`;

  const fetchImpl = async (url) => {
    if (url === shaUrl) return { ok: true, status: 200, url, text: async () => `${wrongSha}  context-cache-v1.5.5-plugin.zip\n` };
    if (url === zipUrl) return { ok: true, status: 200, url, arrayBuffer: async () => zipBuf };
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const res = await applySelfUpdate({
      pluginDir,
      fetchImpl,
      releaseInfo: {
        ok: true,
        currentVersion: '1.5.4',
        latestVersion: '1.5.5',
        hasUpdate: true,
        releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v1.5.5`,
        zipAsset: { name: 'context-cache-v1.5.5-plugin.zip', url: zipUrl, size: zipBuf.length },
        shaAsset: { name: 'context-cache-v1.5.5-plugin.zip.sha256', url: shaUrl, size: 96 },
        canAutoUpdate: true,
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'sha256_mismatch');
    const kept = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(kept.version, '1.5.4');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applySelfUpdate performs atomic directory swap and rolls back cleanly on Windows EBUSY lock', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swap-'));
  const pluginDir = path.join(tmp, 'context-cache');
  fs.mkdirSync(path.join(pluginDir, 'src', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'context-cache', version: '1.5.4' }));
  fs.writeFileSync(path.join(pluginDir, 'src', 'mcp', 'server.mjs'), '// old\n');

  const zipBuf = makeValidBundleZip('1.5.5');
  const realSha = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const zipUrl = `https://github.com/${GITHUB_REPO}/releases/download/v1.5.5/context-cache-v1.5.5-plugin.zip`;
  const shaUrl = `${zipUrl}.sha256`;

  const releaseInfo = {
    ok: true,
    currentVersion: '1.5.4',
    latestVersion: '1.5.5',
    hasUpdate: true,
    releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v1.5.5`,
    zipAsset: { name: 'context-cache-v1.5.5-plugin.zip', url: zipUrl, size: zipBuf.length },
    shaAsset: { name: 'context-cache-v1.5.5-plugin.zip.sha256', url: shaUrl, size: 96 },
    canAutoUpdate: true,
  };

  const fetchImpl = async (url) => {
    if (url === shaUrl) return { ok: true, status: 200, url, text: async () => `${realSha}  context-cache-v1.5.5-plugin.zip\n` };
    if (url === zipUrl) return { ok: true, status: 200, url, arrayBuffer: async () => zipBuf };
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // 1. Simulate EBUSY on second rename -> must roll back to v1.5.4 intact
    let calls = 0;
    const lockedRes = await applySelfUpdate({
      pluginDir,
      fetchImpl,
      releaseInfo,
      renameSyncImpl: (src, dst) => {
        calls += 1;
        if (calls === 2) {
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return fs.renameSync(src, dst);
      },
    });
    assert.equal(lockedRes.ok, false);
    assert.equal(lockedRes.error, 'windows_file_lock');
    assert.equal(lockedRes.rolledBack, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).version, '1.5.4');

    // 2. Normal atomic swap -> upgrades cleanly to v1.5.5
    const okRes = await applySelfUpdate({ pluginDir, fetchImpl, releaseInfo });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.status, 'updated');
    assert.equal(okRes.updatedVersion, '1.5.5');
    assert.equal(okRes.requiresRestart, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')).version, '1.5.5');
    assert.match(fs.readFileSync(path.join(pluginDir, 'src', 'mcp', 'server.mjs'), 'utf8'), /1\.5\.5/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
