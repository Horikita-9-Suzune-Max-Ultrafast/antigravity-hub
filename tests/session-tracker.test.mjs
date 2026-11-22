import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectContext } from '../src/core/context-inspector.mjs';
import { recordActiveSession } from '../src/core/session-tracker.mjs';
import { handleHookEvent } from '../src/adapters/antigravity/hook.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTranscript(appDataDir, convId, promptText, model, tokens, mtimeMs) {
  const logDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const tPath = path.join(logDir, 'transcript.jsonl');
  const lines = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: new Date(mtimeMs - 5000).toISOString(),
      content: promptText,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: new Date(mtimeMs).toISOString(),
      model,
      input_tokens: Math.round(tokens * 0.2),
      cache_read_tokens: Math.round(tokens * 0.8),
      output_tokens: 300,
      content: 'Done.',
    },
  ];
  fs.writeFileSync(tPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const sec = mtimeMs / 1000;
  fs.utimesSync(tPath, sec, sec);
  return tPath;
}

test('Session tracker follows active conversation across 3 conversations, switches workspace rules/git, and supports cross-view sync & pinning', async () => {
  const root = makeTmpDir('cc-session-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');
  const configDir = path.join(root, 'config');
  const projA = path.join(root, 'project-alpha');
  const projB = path.join(root, 'project-beta');

  try {
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projA, 'AGENTS.md'), '# Alpha Rules\nAlpha workspace guidance.\n');
    fs.writeFileSync(path.join(projB, 'AGENTS.md'), '# Beta Rules\nBeta workspace guidance.\n');

    const conv1 = '11111111-1111-4111-8111-111111111111';
    const conv2 = '22222222-2222-4222-8222-222222222222';
    const conv3 = '33333333-3333-4333-8333-333333333333';

    const t0 = Date.now() - 60_000;
    const tPath1 = writeTranscript(appDataDir, conv1, 'Conversation 1 in Alpha', 'gemini-4-neon-high', 40_000, t0);
    const tPath2 = writeTranscript(appDataDir, conv2, 'Conversation 2 in Beta', 'claude-4-sonnet', 80_000, t0 + 10_000);

    const opts = { dataDir, appDataDir, configDir };

    // 1. Before any hooks, auto-follow picks newest transcript (conv2)
    const r0 = inspectContext({ followActive: true, projectDir: projA }, opts);
    assert.equal(r0.conversationId, conv2);
    assert.equal(r0.followResolvedBy, 'transcript');

    // 2. Hook fires PreInvocation for conv1 in projA -> auto-follow immediately switches to conv1 + projA
    await handleHookEvent(
      {
        conversationId: conv1,
        cwd: projA,
        transcriptPath: tPath1,
        hookEventName: 'PreInvocation',
        invocationNum: 1,
      },
      'PreInvocation',
      { ...opts, nowMs: t0 + 20_000 }
    );

    const r1 = inspectContext({ followActive: true, projectDir: projB }, opts);
    assert.equal(r1.conversationId, conv1);
    assert.equal(r1.followResolvedBy, 'hook');
    assert.equal(path.resolve(r1.projectDir), path.resolve(projA));
    assert.ok(r1.inventories[1].items.some((i) => i.name.includes('project-alpha/AGENTS.md')));

    // 3. Hook fires PreInvocation for conv2 in projB -> auto-follow switches to conv2 + projB
    await handleHookEvent(
      {
        conversationId: conv2,
        cwd: projB,
        transcriptPath: tPath2,
        hookEventName: 'PreInvocation',
        invocationNum: 2,
      },
      'PreInvocation',
      { ...opts, nowMs: t0 + 30_000 }
    );

    const r2 = inspectContext({ followActive: true, projectDir: projA }, opts);
    assert.equal(r2.conversationId, conv2);
    assert.equal(path.resolve(r2.projectDir), path.resolve(projB));
    assert.ok(r2.inventories[1].items.some((i) => i.name.includes('project-beta/AGENTS.md')));

    // 4. Cross-view UI sync picks conv1 -> other open views auto-follow conv1 + projA
    recordActiveSession(
      { conversationId: conv1, source: 'ui_sync', event: 'ui_select', updatedAtMs: t0 + 40_000 },
      opts
    );
    const rSync = inspectContext({ followActive: true, projectDir: projB }, opts);
    assert.equal(rSync.conversationId, conv1);
    assert.equal(rSync.followResolvedBy, 'ui_sync');
    assert.equal(path.resolve(rSync.projectDir), path.resolve(projA));

    // 5. Brand new conv3 triggers SessionStart (no transcript file yet) -> auto-follow tracks conv3 & surfaces it in sessions
    await handleHookEvent(
      {
        conversationId: conv3,
        cwd: projB,
        hookEventName: 'SessionStart',
      },
      'SessionStart',
      { ...opts, nowMs: t0 + 50_000 }
    );
    const r3 = inspectContext({ followActive: true, projectDir: projA }, opts);
    assert.equal(r3.conversationId, conv3);
    assert.equal(path.resolve(r3.projectDir), path.resolve(projB));
    assert.ok(r3.sessions.some((s) => s.id === conv3));

    // 6. Explicit pinned conversationId stays pinned to conv1 even though conv3 is newest
    const rPinned = inspectContext({ conversationId: conv1, followActive: false, projectDir: projB }, opts);
    assert.equal(rPinned.conversationId, conv1);
    assert.equal(rPinned.followResolvedBy, 'explicit');
    assert.equal(path.resolve(rPinned.projectDir), path.resolve(projA));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
