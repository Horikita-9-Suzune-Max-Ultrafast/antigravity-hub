import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  saveMemory,
  searchMemories,
  archiveMemory,
  buildCompactBrief,
  buildHandoffCapsule,
} from '../src/core/vault.mjs';
import { rebuildIndex } from '../src/core/index-db.mjs';
import { getDataPaths } from '../src/core/paths.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

test('Vault stores redacted Markdown truth outside Git repo, survives SQLite deletion via FTS5 rebuild, tracks HEAD staleness, and enforces <500t capsule', () => {
  const root = makeTmpDir('cc-vault-');
  const dataDir = path.join(root, 'external-vault');
  const repoDir = path.join(root, 'business-repo');

  try {
    fs.mkdirSync(repoDir, { recursive: true });
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Test User'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'app.js'), 'console.log("v1");\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'init'], repoDir);

    // Save memory containing sensitive credentials -> must be redacted before disk write
    const m1 = saveMemory(
      {
        projectDir: repoDir,
        kind: 'decision',
        title: 'Use native SQLite FTS5 with token sk-proj-1234567890abcdefghij',
        summary: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh12345678 must never leak.',
        tags: ['storage', 'security'],
      },
      { dataDir }
    );
    const m2 = saveMemory(
      {
        projectDir: repoDir,
        kind: 'working_state',
        title: 'Implementing Context Vault',
        summary: 'Next step is running full automated verification.',
        tags: ['progress'],
      },
      { dataDir }
    );

    // 1. Target Git repo has ZERO file pollution
    assert.equal(git(['status', '--porcelain'], repoDir), '');

    // 2. Markdown truth source is redacted
    const mdRaw = fs.readFileSync(m1.filePath, 'utf8');
    assert.ok(!mdRaw.includes('sk-proj-1234567890abcdefghij'));
    assert.ok(!mdRaw.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.match(mdRaw, /\[REDACTED/);

    // 3. Delete SQLite index completely and verify lossless rebuild + FTS5 search
    const { dbFile } = getDataPaths({ dataDir });
    for (const sfx of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbFile + sfx)) fs.unlinkSync(dbFile + sfx);
    }
    assert.equal(fs.existsSync(dbFile), false);

    const rebuilt = rebuildIndex({ dataDir });
    assert.equal(rebuilt.memoriesIndexed, 2);

    const hits = searchMemories({ projectDir: repoDir, query: 'FTS5' }, { dataDir });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, m1.id);

    // 4. Advance Git HEAD by +2 commits -> Compact Brief must report staleness & stay < 500 tokens
    fs.writeFileSync(path.join(repoDir, 'app.js'), 'console.log("v2");\n');
    git(['commit', '-am', 'feat: v2'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'app.js'), 'console.log("v3");\n');
    git(['commit', '-am', 'feat: v3'], repoDir);

    const brief = buildCompactBrief({ projectDir: repoDir }, { dataDir });
    assert.ok(brief.tokens > 0 && brief.tokens < 500);
    assert.equal(brief.commitsAhead, 2);
    assert.match(brief.text, /stale=\+2commits/);

    // 5. Handoff Capsule dual-view stays strictly < 500 tokens
    const capsule = buildHandoffCapsule(
      {
        projectDir: repoDir,
        touchedFiles: ['app.js'],
      },
      { dataDir }
    );
    assert.ok(capsule.tokens > 0 && capsule.tokens < 500);
    assert.match(capsule.agentPayload, /^\[CTX-CAPSULE\]/);
    assert.equal(capsule.decisions.length, 1);

    // 6. Soft archive hides from active list while preserving Markdown truth file on disk
    const arch = archiveMemory(m2.id, { dataDir });
    assert.equal(arch.archived, true);
    assert.equal(fs.existsSync(m2.filePath), true);
    const activeAfter = searchMemories({ projectDir: repoDir, query: 'Implementing' }, { dataDir });
    assert.equal(activeAfter.length, 0);

    // Double-check target business repo is STILL 100% clean
    assert.equal(git(['status', '--porcelain'], repoDir), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
