import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAsarFromMap,
  readAsarHeader,
  readAsarFile,
  hasAsarFile,
  lookupAsarEntry,
  computeElectronIntegrity,
  patchAsarStreaming,
} from '../src/core/i18n/asar.mjs';
import {
  injectMarkerBlock,
  stripMarkerBlock,
} from '../src/core/i18n/payload-templates.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ASAR build, read, lookup, and >4MiB Electron integrity', () => {
  const root = makeTmpDir('cc-asar-');
  try {
    const asarPath = path.join(root, 'test.asar');
    const preloadBuf = Buffer.from('console.log("preload");\n', 'utf8');
    const largeBuf = Buffer.alloc(4 * 1024 * 1024 + 128, 0x61); // > 4 MiB -> 2 blocks

    const integrityLarge = computeElectronIntegrity(largeBuf);
    assert.equal(integrityLarge.algorithm, 'SHA256');
    assert.equal(integrityLarge.blockSize, 4 * 1024 * 1024);
    assert.equal(integrityLarge.blocks.length, 2);
    assert.match(integrityLarge.hash, /^[0-9a-f]{64}$/);

    buildAsarFromMap(asarPath, {
      'dist/preload.js': preloadBuf,
      'dist/large.bin': largeBuf,
      'bin/tool.sh': { content: '#!/bin/sh\necho hi\n', executable: true },
      'native/addon.node': { unpacked: true, size: 42 },
    });

    const { header } = readAsarHeader(asarPath);
    assert.equal(hasAsarFile(asarPath, 'dist/preload.js'), true);
    assert.equal(hasAsarFile(asarPath, 'dist/missing.js'), false);

    const readPreload = readAsarFile(asarPath, 'dist/preload.js');
    assert.deepEqual(readPreload, preloadBuf);

    const readLarge = readAsarFile(asarPath, 'dist/large.bin');
    assert.deepEqual(readLarge, largeBuf);

    const toolEntry = lookupAsarEntry(header, 'bin/tool.sh');
    assert.equal(toolEntry.executable, true);

    const unpackedEntry = lookupAsarEntry(header, 'native/addon.node');
    assert.equal(unpackedEntry.unpacked, true);
    assert.equal(unpackedEntry.size, 42);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('patchAsarStreaming modifies, adds, preserves untouched bytes & metadata, and recomputes integrity', () => {
  const root = makeTmpDir('cc-asar-patch-');
  try {
    const srcAsar = path.join(root, 'src.asar');
    const destAsar = path.join(root, 'dest.asar');

    const origPreload = Buffer.from('/* orig preload */\n', 'utf8');
    const untouched = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x42]);
    const execScript = Buffer.from('#!/bin/sh\nexit 0\n', 'utf8');

    buildAsarFromMap(srcAsar, {
      'dist/preload.js': origPreload,
      'dist/untouched.bin': untouched,
      'bin/run.sh': { content: execScript, executable: true },
      'native/mod.node': { unpacked: true, size: 128 },
    });

    const newPreload = Buffer.from('/* patched preload */\nconsole.log(1);\n', 'utf8');
    const metaJson = Buffer.from(JSON.stringify({ version: 1, patchedBy: 'agy-console' }), 'utf8');

    patchAsarStreaming(srcAsar, destAsar, {
      set: {
        'dist/preload.js': newPreload,
        'dist/agy-console-i18n.meta.json': metaJson,
      },
    });

    assert.deepEqual(readAsarFile(destAsar, 'dist/preload.js'), newPreload);
    assert.deepEqual(readAsarFile(destAsar, 'dist/agy-console-i18n.meta.json'), metaJson);
    assert.deepEqual(readAsarFile(destAsar, 'dist/untouched.bin'), untouched);
    assert.deepEqual(readAsarFile(destAsar, 'bin/run.sh'), execScript);

    const { header } = readAsarHeader(destAsar);
    const preloadEntry = lookupAsarEntry(header, 'dist/preload.js');
    assert.equal(preloadEntry.size, newPreload.length);
    assert.deepEqual(preloadEntry.integrity, computeElectronIntegrity(newPreload));

    const metaEntry = lookupAsarEntry(header, 'dist/agy-console-i18n.meta.json');
    assert.equal(metaEntry.size, metaJson.length);
    assert.deepEqual(metaEntry.integrity, computeElectronIntegrity(metaJson));

    const runEntry = lookupAsarEntry(header, 'bin/run.sh');
    assert.equal(runEntry.executable, true);

    const unpackedEntry = lookupAsarEntry(header, 'native/mod.node');
    assert.equal(unpackedEntry.unpacked, true);
    assert.equal(unpackedEntry.size, 128);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injectMarkerBlock and stripMarkerBlock are idempotent and restore original cleanly', () => {
  const original = 'const a = 1;\nexport default a;\n';
  const snippet = 'console.log("injected");';

  const once = injectMarkerBlock(original, 'TEST_MARKER', snippet);
  assert.ok(once.includes('TEST_MARKER'));
  assert.ok(once.includes(snippet));

  const twice = injectMarkerBlock(once, 'TEST_MARKER', snippet);
  assert.equal(twice, once, 'Calling injectMarkerBlock twice must not duplicate markers');

  const stripped = stripMarkerBlock(twice, 'TEST_MARKER');
  assert.equal(stripped, original, 'stripMarkerBlock must restore original source cleanly');
});
