import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from '../storage.mjs';

export const ELECTRON_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB (4194304)
const MAX_HEADER_BYTES = 256 * 1024 * 1024; // 256 MiB safety guard
const STREAM_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB streaming copy buffer

/**
 * Normalize an ASAR internal POSIX path.
 */
export function normalizeAsarPath(relPath) {
  if (typeof relPath !== 'string') return '';
  const cleaned = relPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!cleaned) return '';
  const parts = cleaned.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`Invalid ASAR relative path: "${relPath}"`);
    }
  }
  return parts.join('/');
}

/**
 * Lookup an entry node inside a parsed ASAR header tree.
 */
export function lookupAsarEntry(header, relPath) {
  if (!header || typeof header !== 'object' || !header.files) return null;
  const normalized = normalizeAsarPath(relPath);
  if (!normalized) return header;
  const parts = normalized.split('/');
  let node = header;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !node.files || !Object.hasOwn(node.files, part)) {
      return null;
    }
    node = node.files[part];
  }
  return node;
}

/**
 * Read exact byte length from an open file descriptor at a given file offset.
 */
function readExactSync(fd, buffer, length, position) {
  let bytesReadTotal = 0;
  while (bytesReadTotal < length) {
    const n = fs.readSync(
      fd,
      buffer,
      bytesReadTotal,
      length - bytesReadTotal,
      position + bytesReadTotal
    );
    if (n <= 0) {
      throw new Error(
        `Unexpected EOF while reading ASAR at offset ${position + bytesReadTotal} (expected ${length} bytes, got ${bytesReadTotal}).`
      );
    }
    bytesReadTotal += n;
  }
}

/**
 * Write full buffer slice to an open file descriptor.
 */
function writeAllSync(fd, buffer, length = buffer.length) {
  let writtenTotal = 0;
  while (writtenTotal < length) {
    const n = fs.writeSync(fd, buffer, writtenTotal, length - writtenTotal);
    if (n <= 0) {
      throw new Error(`Short write while writing ASAR (${writtenTotal}/${length} bytes).`);
    }
    writtenTotal += n;
  }
}

/**
 * Encode an ASAR JSON header using Chromium Pickle framing.
 * Layout:
 *   [0..3]  uint32LE = 4 (size pickle payload size)
 *   [4..7]  uint32LE = headerPickleTotalSize
 *   [8..11] uint32LE = headerPayloadSize (= 4 + alignedJsonLen)
 *   [12..15] uint32LE = jsonByteLength
 *   [16..]  UTF-8 JSON bytes + 0..3 zero alignment bytes
 */
export function encodeAsarHeader(headerObj) {
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const headerPayloadSize = 4 + jsonBuf.length + pad;
  const headerPickleTotalSize = 4 + headerPayloadSize;
  const out = Buffer.alloc(8 + headerPickleTotalSize);

  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleTotalSize, 4);
  out.writeUInt32LE(headerPayloadSize, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(out, 16);
  return out;
}

/**
 * Read and parse the Chromium Pickle JSON header of an ASAR archive.
 */
export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 16) {
      throw new Error(`Invalid ASAR archive (too small: ${stat.size} bytes): ${asarPath}`);
    }

    const sizePickleBuf = Buffer.allocUnsafe(8);
    readExactSync(fd, sizePickleBuf, 8, 0);
    const sizePicklePayloadSize = sizePickleBuf.readUInt32LE(0);
    const headerPickleSize = sizePickleBuf.readUInt32LE(4);

    if (sizePicklePayloadSize < 4 || sizePicklePayloadSize > 64) {
      throw new Error(`Invalid ASAR size pickle payload size: ${sizePicklePayloadSize}`);
    }
    const headerStart = 4 + sizePicklePayloadSize;
    if (
      headerPickleSize < 8 ||
      headerPickleSize > MAX_HEADER_BYTES ||
      headerStart + headerPickleSize > stat.size
    ) {
      throw new Error(`Invalid ASAR header pickle size: ${headerPickleSize}`);
    }

    const headerPickleBuf = Buffer.allocUnsafe(headerPickleSize);
    readExactSync(fd, headerPickleBuf, headerPickleSize, headerStart);
    const headerPayloadSize = headerPickleBuf.readUInt32LE(0);
    const jsonByteLen = headerPickleBuf.readUInt32LE(4);

    if (8 + jsonByteLen > headerPickleBuf.length || 4 + jsonByteLen > headerPayloadSize) {
      throw new Error(
        `Corrupt ASAR header pickle (jsonByteLen=${jsonByteLen}, payloadSize=${headerPayloadSize}, pickleSize=${headerPickleSize}).`
      );
    }

    const jsonText = headerPickleBuf.subarray(8, 8 + jsonByteLen).toString('utf8');
    let header;
    try {
      header = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`Failed to parse ASAR header JSON: ${err.message}`);
    }

    if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
      throw new Error('Invalid ASAR header root: missing "files" directory object.');
    }

    return {
      header,
      headerSize: headerPickleSize,
      dataOffset: headerStart + headerPickleSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check whether a file entry exists inside an ASAR archive.
 */
export function hasAsarFile(asarPath, relPath) {
  try {
    if (!asarPath || !fs.existsSync(asarPath)) return false;
    const { header } = readAsarHeader(asarPath);
    const entry = lookupAsarEntry(header, relPath);
    return Boolean(entry && !entry.files);
  } catch {
    return false;
  }
}

/**
 * Read a single file's bytes from an ASAR archive without loading the whole archive.
 */
export function readAsarFile(asarPath, relPath) {
  const { header, dataOffset } = readAsarHeader(asarPath);
  const normalized = normalizeAsarPath(relPath);

  let currentPath = normalized;
  let entry = lookupAsarEntry(header, currentPath);
  let linkDepth = 0;
  while (entry && typeof entry.link === 'string') {
    if (++linkDepth > 8) {
      throw new Error(`Symlink loop detected in ASAR for "${relPath}"`);
    }
    const baseDir = path.posix.dirname(currentPath);
    currentPath = normalizeAsarPath(
      baseDir === '.' ? entry.link : path.posix.normalize(path.posix.join(baseDir, entry.link))
    );
    entry = lookupAsarEntry(header, currentPath);
  }

  if (!entry) {
    throw new Error(`File not found in ASAR: "${relPath}"`);
  }
  if (entry.files) {
    throw new Error(`ASAR entry is a directory, not a file: "${relPath}"`);
  }
  if (entry.unpacked === true) {
    const unpackedPath = path.join(`${asarPath}.unpacked`, ...currentPath.split('/'));
    if (fs.existsSync(unpackedPath)) {
      return fs.readFileSync(unpackedPath);
    }
    throw new Error(`ASAR entry is unpacked and missing on disk: "${currentPath}"`);
  }

  const size = Number(entry.size);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Invalid size for ASAR entry "${currentPath}": ${entry.size}`);
  }
  if (size === 0) return Buffer.alloc(0);

  const offsetNum = Number(entry.offset);
  if (!Number.isFinite(offsetNum) || offsetNum < 0) {
    throw new Error(`Invalid offset for ASAR entry "${currentPath}": ${entry.offset}`);
  }

  const fd = fs.openSync(asarPath, 'r');
  try {
    const out = Buffer.allocUnsafe(size);
    readExactSync(fd, out, size, dataOffset + offsetNum);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compute Electron ASAR file integrity metadata (SHA-256 + 4 MiB block hashes).
 */
export function computeElectronIntegrity(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(String(input ?? ''), 'utf8');

  const fullHash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];

  if (buf.length === 0) {
    blocks.push(fullHash);
  } else {
    for (let pos = 0; pos < buf.length; pos += ELECTRON_INTEGRITY_BLOCK_SIZE) {
      const end = Math.min(pos + ELECTRON_INTEGRITY_BLOCK_SIZE, buf.length);
      const blockHash = crypto
        .createHash('sha256')
        .update(buf.subarray(pos, end))
        .digest('hex');
      blocks.push(blockHash);
    }
  }

  return {
    algorithm: 'SHA256',
    hash: fullHash,
    blockSize: ELECTRON_INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

function normalizeSetEntries(setInput) {
  const map = new Map();
  if (!setInput) return map;
  const entries = setInput instanceof Map ? setInput.entries() : Object.entries(setInput);
  for (const [rawKey, rawVal] of entries) {
    const key = normalizeAsarPath(rawKey);
    if (!key) continue;
    if (Buffer.isBuffer(rawVal)) {
      map.set(key, rawVal);
    } else if (rawVal instanceof Uint8Array) {
      map.set(key, Buffer.from(rawVal.buffer, rawVal.byteOffset, rawVal.byteLength));
    } else if (typeof rawVal === 'string') {
      map.set(key, Buffer.from(rawVal, 'utf8'));
    } else {
      throw new Error(`Unsupported buffer value for ASAR entry "${key}".`);
    }
  }
  return map;
}

function normalizeRemoveSet(removeInput) {
  const out = new Set();
  if (!removeInput) return out;
  for (const rawKey of removeInput) {
    const key = normalizeAsarPath(rawKey);
    if (key) out.add(key);
  }
  return out;
}

function deleteEntryFromTree(root, relPath) {
  const parts = relPath.split('/');
  const stack = [];
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!node.files || !Object.hasOwn(node.files, part)) return false;
    stack.push({ parent: node, key: part });
    node = node.files[part];
  }
  const leaf = parts[parts.length - 1];
  if (!node.files || !Object.hasOwn(node.files, leaf)) return false;
  delete node.files[leaf];

  // Clean up empty intermediate directories created by removal (never touch root)
  for (let i = stack.length - 1; i >= 0; i--) {
    const { parent, key } = stack[i];
    const dir = parent.files[key];
    if (dir && dir.files && Object.keys(dir.files).length === 0 && !dir.unpacked) {
      delete parent.files[key];
    } else {
      break;
    }
  }
  return true;
}

function upsertEntryPlaceholderInTree(root, relPath, buf) {
  const parts = relPath.split('/');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!node.files) node.files = {};
    if (!Object.hasOwn(node.files, part) || !node.files[part].files) {
      node.files[part] = { files: {} };
    }
    node = node.files[part];
  }
  if (!node.files) node.files = {};
  const leaf = parts[parts.length - 1];
  const prev = node.files[leaf];
  const nextEntry = {
    size: buf.length,
    offset: '0',
    integrity: computeElectronIntegrity(buf),
  };
  if (prev && prev.executable === true) {
    nextEntry.executable = true;
  }
  node.files[leaf] = nextEntry;
}

function atomicRenameSync(tmpPath, destPath) {
  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    // On Windows, a brief antivirus/indexer handle can cause EPERM/EBUSY on rename
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
      let lastErr = err;
      for (let attempt = 0; attempt < 5; attempt++) {
        // Brief synchronous backoff using Atomics.wait on a private buffer
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1));
        try {
          fs.renameSync(tmpPath, destPath);
          return;
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
      throw lastErr;
    }
    throw err;
  }
}

/**
 * Streamingly patch an ASAR archive into destAsarPath (supports destAsarPath === srcAsarPath).
 * Preserves unpacked, executable, and link entries verbatim.
 * Untouched file payloads are streamed directly from srcAsarPath using a fixed 2 MiB buffer.
 */
export function patchAsarStreaming(srcAsarPath, destAsarPath, { set, remove } = {}) {
  const { header: srcHeader, dataOffset: srcDataOffset } = readAsarHeader(srcAsarPath);
  const newHeader = structuredClone(srcHeader);
  const setMap = normalizeSetEntries(set);
  const removeSet = normalizeRemoveSet(remove);

  for (const relPath of removeSet) {
    if (!setMap.has(relPath)) {
      deleteEntryFromTree(newHeader, relPath);
    }
  }

  for (const [relPath, buf] of setMap.entries()) {
    upsertEntryPlaceholderInTree(newHeader, relPath, buf);
  }

  const writePlan = [];
  let nextOffset = 0n;
  let fileCount = 0;

  function walkAndPlan(node, prefix) {
    if (!node || typeof node !== 'object' || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        walkAndPlan(child, rel);
        continue;
      }
      // Preserve symlinks verbatim
      if (typeof child.link === 'string') {
        continue;
      }
      // Preserve unpacked entries verbatim (payload lives in app.asar.unpacked)
      if (child.unpacked === true) {
        continue;
      }

      fileCount++;
      if (setMap.has(rel)) {
        const buf = setMap.get(rel);
        child.size = buf.length;
        child.offset = String(nextOffset);
        child.integrity = computeElectronIntegrity(buf);
        if (buf.length > 0) {
          writePlan.push({ kind: 'buffer', buffer: buf, size: buf.length });
          nextOffset += BigInt(buf.length);
        }
      } else {
        const size = Number(child.size);
        const origRelOffset = BigInt(child.offset || '0');
        const origAbsOffset = BigInt(srcDataOffset) + origRelOffset;
        child.offset = String(nextOffset);
        if (size > 0) {
          const prev = writePlan[writePlan.length - 1];
          if (prev && prev.kind === 'copy' && prev.srcOffset + BigInt(prev.size) === origAbsOffset) {
            // Coalesce contiguous untouched ranges for high-throughput streaming I/O
            prev.size += size;
          } else {
            writePlan.push({ kind: 'copy', srcOffset: origAbsOffset, size });
          }
          nextOffset += BigInt(size);
        }
      }
    }
  }

  walkAndPlan(newHeader, '');

  const encodedHeader = encodeAsarHeader(newHeader);
  const destDir = path.dirname(path.resolve(destAsarPath));
  ensureDir(destDir);
  const tmpPath = path.join(
    destDir,
    `.${path.basename(destAsarPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );

  let srcFd = null;
  let dstFd = null;
  try {
    srcFd = fs.openSync(srcAsarPath, 'r');
    dstFd = fs.openSync(tmpPath, 'w');

    writeAllSync(dstFd, encodedHeader);

    const copyBuf = Buffer.allocUnsafe(STREAM_CHUNK_SIZE);
    for (const seg of writePlan) {
      if (seg.kind === 'buffer') {
        writeAllSync(dstFd, seg.buffer, seg.size);
      } else {
        let remaining = seg.size;
        let readPos = Number(seg.srcOffset);
        while (remaining > 0) {
          const chunkLen = Math.min(remaining, STREAM_CHUNK_SIZE);
          readExactSync(srcFd, copyBuf, chunkLen, readPos);
          writeAllSync(dstFd, copyBuf, chunkLen);
          readPos += chunkLen;
          remaining -= chunkLen;
        }
      }
    }

    try {
      fs.fsyncSync(dstFd);
    } catch {
      // fsync may fail on certain virtual filesystems; ignore best-effort
    }

    // Close BOTH descriptors before rename (required on Windows for in-place replacement)
    fs.closeSync(dstFd);
    dstFd = null;
    fs.closeSync(srcFd);
    srcFd = null;

    atomicRenameSync(tmpPath, destAsarPath);

    return {
      destAsarPath,
      fileCount,
      headerBytes: encodedHeader.length,
      totalPayloadBytes: Number(nextOffset),
    };
  } catch (err) {
    if (dstFd !== null) {
      try { fs.closeSync(dstFd); } catch { /* ignore */ }
    }
    if (srcFd !== null) {
      try { fs.closeSync(srcFd); } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Build a fresh ASAR archive from a Map or plain object of entries (helper for unit tests).
 * Entry values may be:
 *   - Buffer | Uint8Array | string
 *   - { content?: Buffer|string, executable?: boolean, unpacked?: boolean, size?: number, link?: string }
 */
export function buildAsarFromMap(destAsarPath, entriesMap) {
  const root = { files: {} };
  const buffers = [];
  let nextOffset = 0n;
  let fileCount = 0;

  const entries = entriesMap instanceof Map ? entriesMap.entries() : Object.entries(entriesMap || {});
  for (const [rawKey, rawVal] of entries) {
    const relPath = normalizeAsarPath(rawKey);
    if (!relPath) continue;
    const parts = relPath.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!Object.hasOwn(node.files, part) || !node.files[part].files) {
        node.files[part] = { files: {} };
      }
      node = node.files[part];
    }
    const leaf = parts[parts.length - 1];

    if (
      rawVal &&
      typeof rawVal === 'object' &&
      !Buffer.isBuffer(rawVal) &&
      !(rawVal instanceof Uint8Array)
    ) {
      if (typeof rawVal.link === 'string') {
        node.files[leaf] = { link: rawVal.link };
        continue;
      }
      if (rawVal.unpacked === true) {
        const meta = {
          size: Number(rawVal.size ?? (rawVal.content ? Buffer.byteLength(rawVal.content) : 0)),
          unpacked: true,
        };
        if (rawVal.executable === true) meta.executable = true;
        if (rawVal.integrity) meta.integrity = rawVal.integrity;
        node.files[leaf] = meta;
        continue;
      }
      const buf = Buffer.isBuffer(rawVal.content)
        ? rawVal.content
        : rawVal.content instanceof Uint8Array
          ? Buffer.from(rawVal.content.buffer, rawVal.content.byteOffset, rawVal.content.byteLength)
          : Buffer.from(String(rawVal.content ?? ''), 'utf8');
      const entry = {
        size: buf.length,
        offset: String(nextOffset),
        integrity: computeElectronIntegrity(buf),
      };
      if (rawVal.executable === true) entry.executable = true;
      node.files[leaf] = entry;
      if (buf.length > 0) {
        buffers.push(buf);
        nextOffset += BigInt(buf.length);
      }
      fileCount++;
    } else {
      const buf = Buffer.isBuffer(rawVal)
        ? rawVal
        : rawVal instanceof Uint8Array
          ? Buffer.from(rawVal.buffer, rawVal.byteOffset, rawVal.byteLength)
          : Buffer.from(String(rawVal ?? ''), 'utf8');
      node.files[leaf] = {
        size: buf.length,
        offset: String(nextOffset),
        integrity: computeElectronIntegrity(buf),
      };
      if (buf.length > 0) {
        buffers.push(buf);
        nextOffset += BigInt(buf.length);
      }
      fileCount++;
    }
  }

  const encodedHeader = encodeAsarHeader(root);
  const destDir = path.dirname(path.resolve(destAsarPath));
  ensureDir(destDir);
  const tmpPath = path.join(
    destDir,
    `.${path.basename(destAsarPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );

  let dstFd = null;
  try {
    dstFd = fs.openSync(tmpPath, 'w');
    writeAllSync(dstFd, encodedHeader);
    for (const buf of buffers) {
      writeAllSync(dstFd, buf);
    }
    try {
      fs.fsyncSync(dstFd);
    } catch {
      // ignore best-effort fsync
    }
    fs.closeSync(dstFd);
    dstFd = null;
    atomicRenameSync(tmpPath, destAsarPath);

    return {
      destAsarPath,
      fileCount,
      headerBytes: encodedHeader.length,
      totalPayloadBytes: Number(nextOffset),
    };
  } catch (err) {
    if (dstFd !== null) {
      try { fs.closeSync(dstFd); } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}
