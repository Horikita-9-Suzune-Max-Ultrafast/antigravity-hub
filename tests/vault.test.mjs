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

test('Handoff Capsule v1.5.4 aggregates Vault + Transcript + live Git changes/commits and supports compact/standard/full budgets with custom filtering', () => {
  const root = makeTmpDir('cc-capsule-v154-');
  const dataDir = path.join(root, 'vault-data');
  const appDataDir = path.join(root, 'antigravity');
  const repoDir = path.join(root, 'repo');

  try {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'Test User'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'src', 'index.mjs'), 'export const v = 1;\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'feat: initial scaffold'], repoDir);

    fs.writeFileSync(path.join(repoDir, 'src', 'index.mjs'), 'export const v = 2;\n');
    git(['commit', '-am', 'fix: handle edge case'], repoDir);

    // Live Git changes: M (modified), A (staged added), ? (untracked)
    fs.writeFileSync(path.join(repoDir, 'src', 'index.mjs'), 'export const v = 3;\n');
    fs.writeFileSync(path.join(repoDir, 'src', 'staged.mjs'), 'export const s = true;\n');
    git(['add', 'src/staged.mjs'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'src', 'untracked.mjs'), 'export const u = true;\n');

    // Save 6 detailed decisions in Vault
    const savedIds = [];
    for (let i = 1; i <= 6; i++) {
      const m = saveMemory(
        {
          projectDir: repoDir,
          kind: i % 2 === 0 ? 'pitfall' : 'decision',
          title: `Decision #${i}: Maintain strict boundary and zero runtime dependencies`,
          summary: `Detailed rationale for item ${i} explaining why native Node APIs and deterministic redaction are mandatory across all modules. `.repeat(2),
          tags: ['v1.5.4'],
        },
        { dataDir }
      );
      savedIds.push(m.id);
    }

    // Create active transcript.jsonl + Artifact file in brain/<convId>/
    const convId = '22222222-2222-4222-8222-222222222222';
    const brainDir = path.join(appDataDir, 'brain', convId);
    const logDir = path.join(brainDir, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const artifactPath = path.join(brainDir, 'v1.5.4-plan.md');
    fs.writeFileSync(artifactPath, '# v1.5.4 Plan\n');

    const transcriptPath = path.join(logDir, 'transcript.jsonl');
    const transcriptSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-24T10:00:00Z',
        content: '<USER_REQUEST>升级交接胶囊支持三源聚合与三档预算</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T10:00:05Z',
        model: 'gemini-4-neon-high',
        tool_calls: [
          { name: 'edit_file', args: { Path: path.join(repoDir, 'src', 'index.mjs') } },
          { name: 'write_file', args: { Path: path.join(repoDir, 'src', 'from-transcript.mjs') } },
          {
            name: 'write_file',
            args: {
              Path: artifactPath,
              ArtifactMetadata: { Summary: 'Plan', UserFacing: true, RequestFeedback: false },
            },
          },
        ],
      },
    ];
    fs.writeFileSync(transcriptPath, transcriptSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    // 1. Compact vs Standard vs Full budgets
    const compact = buildHandoffCapsule(
      { projectDir: repoDir, conversationId: convId, budgetPreset: 'compact' },
      { dataDir, appDataDir }
    );
    const standard = buildHandoffCapsule(
      { projectDir: repoDir, conversationId: convId, budgetPreset: 'standard' },
      { dataDir, appDataDir }
    );
    const full = buildHandoffCapsule(
      { projectDir: repoDir, conversationId: convId, budgetPreset: 'full' },
      { dataDir, appDataDir }
    );

    assert.equal(compact.budgetPreset, 'compact');
    assert.equal(compact.budgetTokens, 500);
    assert.ok(compact.tokens <= 500);

    assert.equal(standard.budgetPreset, 'standard');
    assert.equal(standard.budgetTokens, 1200);
    assert.ok(standard.tokens <= 1200);
    assert.ok(standard.tokens > compact.tokens, 'standard tier should retain richer context than compact');

    assert.equal(full.budgetPreset, 'full');
    assert.equal(full.budgetTokens, 2500);
    assert.ok(full.tokens <= 2500);

    // 2. Verify 3-source aggregation in standard tier
    assert.equal(standard.activeGoal, '升级交接胶囊支持三源聚合与三档预算');
    assert.equal(standard.recentCommits.length, 2);
    assert.equal(standard.recentCommits[0].subject, 'fix: handle edge case');
    assert.equal(standard.recentCommits[1].subject, 'feat: initial scaffold');
    assert.ok(standard.fileItems.some((f) => f.path === 'src/index.mjs' && f.status === 'M' && f.source === 'git+transcript'));
    assert.ok(standard.fileItems.some((f) => f.path === 'src/staged.mjs' && f.status === 'A'));
    assert.ok(standard.fileItems.some((f) => f.path === 'src/untracked.mjs' && f.status === '?'));
    assert.ok(standard.fileItems.some((f) => f.path === 'src/from-transcript.mjs' && f.source === 'transcript'));
    assert.ok(standard.artifactItems.some((a) => a.name === 'v1.5.4-plan.md'));
    assert.match(standard.agentPayload, /- Recent Commits:/);
    assert.match(standard.agentPayload, /- Artifacts:/);

    // 3. Verify custom activeGoal, nextAction, and selective filtering
    const custom = buildHandoffCapsule(
      {
        projectDir: repoDir,
        conversationId: convId,
        budgetPreset: 'standard',
        activeGoal: '自定义交接目标',
        nextAction: '直接执行阶段 2 前端联调',
        selectedDecisionIds: [savedIds[0]],
        selectedFiles: ['src/index.mjs'],
        selectedArtifacts: [artifactPath],
      },
      { dataDir, appDataDir }
    );
    assert.equal(custom.activeGoal, '自定义交接目标');
    assert.equal(custom.nextAction, '直接执行阶段 2 前端联调');
    assert.equal(custom.decisions.filter((d) => d.checked).length, 1);
    assert.deepEqual(custom.touchedFiles, ['src/index.mjs']);
    assert.equal(custom.artifacts.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
