import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataPaths } from '../src/core/paths.mjs';
import { readJsonlSafe } from '../src/core/storage.mjs';
import { getCircuitState } from '../src/adapters/antigravity/circuit-breaker.mjs';
import { saveMemory, listMemories } from '../src/core/vault.mjs';

const HOOK_SCRIPT = path.resolve('src/adapters/antigravity/hook.mjs');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runHook(event, stdinStr, envExtra = {}) {
  return spawnSync(process.execPath, ['--no-warnings', HOOK_SCRIPT, '--event', event], {
    input: stdinStr,
    encoding: 'utf8',
    timeout: 6000,
    windowsHide: true,
    env: { ...process.env, ...envExtra },
  });
}

test('Hook adapter fails open ({}, exit 0) on truncated JSON, normalizes snake_case drift with redaction, renders user_markdown, and trips circuit breaker after 3 errors', () => {
  const root = makeTmpDir('cc-hook-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const env = {
    CONTEXT_CACHE_DATA_DIR: dataDir,
    ANTIGRAVITY_APP_DATA_DIR: appDataDir,
  };

  try {
    // 1. Truncated / malformed JSON -> must return {} with exit code 0 and log redacted drift
    const badRes = runHook('PreInvocation', '{"conversationId": "abc", "apiKey": "sk-proj-secret12345678901234567890"', env);
    assert.equal(badRes.status, 0);
    assert.deepEqual(JSON.parse(badRes.stdout.trim()), {});

    const paths = getDataPaths({ dataDir });
    const drift1 = readJsonlSafe(paths.driftLogFile);
    assert.ok(drift1.length >= 1);
    assert.ok(!JSON.stringify(drift1).includes('sk-proj-secret12345678901234567890'));

    // 2. Full snake_case migrated payload + unknown future field + secret -> normalized cleanly & drift redacted
    saveMemory(
      { projectDir: workspaceDir, kind: 'decision', title: 'Keep hooks fail-open', summary: 'Never crash Antigravity loop.' },
      { dataDir }
    );
    const snakePayload = JSON.stringify({
      conversation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspace_paths: [workspaceDir],
      hook_event_name: 'SessionStart',
      future_host_field: 'v99-value',
      auth_token: 'Bearer super_secret_token_999999999',
    });
    const snakeRes = runHook('SessionStart', snakePayload, env);
    assert.equal(snakeRes.status, 0);
    const snakeJson = JSON.parse(snakeRes.stdout.trim());
    assert.ok(Array.isArray(snakeJson.injectSteps) && snakeJson.injectSteps.length === 1);
    assert.match(snakeJson.injectSteps[0].systemMessage.systemMessage, /\[CTX-BRIEF\]/);

    const drift2 = readJsonlSafe(paths.driftLogFile);
    assert.ok(drift2.some((d) => Array.isArray(d.reasons) && d.reasons.some((r) => r.startsWith('snake_case_fallback'))));
    assert.ok(!JSON.stringify(drift2).includes('super_secret_token_999999999'));

    // 3. PreInvocation + PostInvocation -> zero-token single-line user_markdown banner (systemMessage: "")
    const convId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const tDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(tDir, { recursive: true });
    const tPath = path.join(tDir, 'transcript.jsonl');
    fs.writeFileSync(
      tPath,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: new Date().toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 2500,
        cache_read_tokens: 74500,
        output_tokens: 268,
        thinking: 'ok',
        content: 'done',
      }) + '\n'
    );

    const preRes = runHook('PreInvocation', JSON.stringify({ conversationId: convId, invocationNum: 1 }), env);
    assert.equal(preRes.status, 0);
    assert.deepEqual(JSON.parse(preRes.stdout.trim()), {});

    const postRes = runHook('PostInvocation', JSON.stringify({ conversationId: convId, transcriptPath: tPath, invocationNum: 1 }), env);
    assert.equal(postRes.status, 0);
    const postJson = JSON.parse(postRes.stdout.trim());
    assert.equal(postJson.injectSteps[0].systemMessage.systemMessage, '');
    assert.match(postJson.injectSteps[0].systemMessage.metadata.user_markdown, /^⚡ /);

    // 4. Stop with continuationActive: true does NOT write checkpoint; continuationActive: false DOES write checkpoint
    const stopSkip = runHook(
      'Stop',
      JSON.stringify({ conversationId: convId, transcriptPath: tPath, cwd: workspaceDir, continuationActive: true }),
      env
    );
    assert.equal(stopSkip.status, 0);
    assert.deepEqual(JSON.parse(stopSkip.stdout.trim()), {});
    assert.equal(listMemories({ projectDir: workspaceDir, kind: 'checkpoint' }, { dataDir }).length, 0);

    const stopSave = runHook(
      'Stop',
      JSON.stringify({
        conversationId: convId,
        transcriptPath: tPath,
        cwd: workspaceDir,
        continuationActive: false,
        terminationReason: 'NO_TOOL_CALL',
        lastUserInput: 'Verify hook resilience',
      }),
      env
    );
    assert.equal(stopSave.status, 0);
    assert.deepEqual(JSON.parse(stopSave.stdout.trim()), {});
    assert.equal(listMemories({ projectDir: workspaceDir, kind: 'checkpoint' }, { dataDir }).length, 1);

    // 5. Circuit breaker opens after 3 consecutive forced errors and still returns {} with exit code 0
    for (let i = 0; i < 3; i++) {
      const errRes = runHook('PreInvocation', '{}', { ...env, CONTEXT_CACHE_FORCE_HOOK_ERROR: '1' });
      assert.equal(errRes.status, 0);
      assert.deepEqual(JSON.parse(errRes.stdout.trim()), {});
    }
    const cb = getCircuitState({ dataDir });
    assert.equal(cb.state, 'OPEN');
    assert.equal(cb.failures, 3);

    // While OPEN, even a normal SessionStart returns {} immediately (fast Fail-Open)
    const openRes = runHook('SessionStart', JSON.stringify({ conversationId: convId, cwd: workspaceDir }), env);
    assert.equal(openRes.status, 0);
    assert.deepEqual(JSON.parse(openRes.stdout.trim()), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
