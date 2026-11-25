import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordHookTiming, getTelemetryReport, formatUserMarkdownBanner } from '../src/core/telemetry.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Telemetry merges main + invoke_subagent transcripts, computes dual-source TPS, cache drop reasons, pricing, and 4 alert classes', () => {
  const root = makeTmpDir('cc-telemetry-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');

  try {
    const mainId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sub1Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const mainDir = path.join(appDataDir, 'brain', mainId, '.system_generated', 'logs');
    const subDir = path.join(appDataDir, 'brain', sub1Id, '.system_generated', 'logs');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    // Record exact hook_ms timing for step 1 (4000ms)
    const t0 = Date.parse('2026-11-22T02:00:00Z');
    recordHookTiming({ conversationId: mainId, phase: 'pre', invocationNum: 1, timestampMs: t0 }, { dataDir });
    recordHookTiming({ conversationId: mainId, phase: 'post', invocationNum: 1, timestampMs: t0 + 4000 }, { dataDir });

    const mainSteps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-22T02:00:00Z', content: 'Run analysis' },
      // Step 1: exact hook_ms (4s), 400 output -> 100 tok/s, high cache
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T02:00:02Z',
        model: 'gemini-4-neon-high',
        input_tokens: 4000,
        cache_read_tokens: 76000,
        output_tokens: 400,
        thinking: 'A'.repeat(100),
        content: 'B'.repeat(300),
        tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Explorer' } }],
      },
      // Step 2: tool result returning subagent conversationId
      {
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-11-22T02:00:06Z',
        content: `Launched subagent with conversationId: ${sub1Id}`,
      },
      // Step 3: 7 minutes later -> idle_ttl_expired cache drop (95% -> 20%) + ttft_ms compatibility + slow speed
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T02:07:10Z',
        model: 'gemini-4-neon-high',
        input_tokens: 64000,
        cache_read_tokens: 16000,
        output_tokens: 100,
        ttft_ms: 850,
        thinking: 'Thinking deeply...',
        content: 'Done.',
      },
      { step_index: 4, type: 'GENERIC', created_at: '2026-11-22T02:07:20Z', content: 'ok' },
      // Step 5: model_changed drop + slow speed
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T02:07:30Z',
        model: 'claude-4-sonnet',
        input_tokens: 160000,
        cache_read_tokens: 0,
        output_tokens: 80,
        thinking: '',
        content: 'Switched model.',
      },
      { step_index: 6, type: 'GENERIC', created_at: '2026-11-22T02:07:40Z', content: 'ok' },
      // Step 7: slow speed #3 in a row (< 15 tok/s) -> triggers low_tps_streak alert
      {
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T02:07:50Z',
        model: 'claude-4-sonnet',
        input_tokens: 10000,
        cache_read_tokens: 155000,
        output_tokens: 90,
        thinking: '',
        content: 'Final check.',
      },
      { step_index: 8, type: 'GENERIC', created_at: '2026-11-22T02:08:00Z', content: 'end' },
    ];
    fs.writeFileSync(path.join(mainDir, 'transcript.jsonl'), mainSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    // Subagent transcript with high context (>= 100K -> triggers subagent_burst alert)
    const subSteps = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T02:00:08Z',
        model: 'gemini-4-neon-high',
        input_tokens: 12000,
        cache_read_tokens: 105000,
        output_tokens: 600,
        thinking: 'Sub thinking',
        content: 'Sub result',
      },
      { step_index: 2, type: 'GENERIC', created_at: '2026-11-22T02:00:18Z', content: 'sub done' },
    ];
    fs.writeFileSync(path.join(subDir, 'transcript.jsonl'), subSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    const report = getTelemetryReport({ conversationId: mainId }, { dataDir, appDataDir });

    // Main (4 steps) + Sub1 (1 step) = 5 merged calls
    assert.equal(report.totalCallsCount, 5);
    assert.equal(report.subagents.length, 1);
    assert.equal(report.subagents[0].tag, '子1');

    const step1 = report.calls.find((c) => c.agentTag === '主' && c.stepIndex === 1);
    assert.equal(step1.timingSource, 'hook_ms');
    assert.equal(step1.durationMs, 4000);
    assert.equal(step1.effectiveTps, 100);
    assert.ok(step1.thinkingTokensEst > 0 && step1.contentTokensEst > 0);
    assert.equal(step1.thinkingTokensEst + step1.contentTokensEst, step1.outputTokens);

    const step3 = report.calls.find((c) => c.agentTag === '主' && c.stepIndex === 3);
    assert.equal(step3.cacheDrop, true);
    assert.equal(step3.dropReason, 'idle_ttl_expired');
    assert.equal(step3.ttftMs, 850);

    const step5 = report.calls.find((c) => c.agentTag === '主' && c.stepIndex === 5);
    assert.equal(step5.cacheDrop, true);
    assert.equal(step5.dropReason, 'model_changed');

    const subCall = report.calls.find((c) => c.agentTag === '子1');
    assert.equal(subCall.agentType, 'sub');
    assert.equal(subCall.contextTokens, 117000);
    assert.ok(subCall.estimatedCostUsd > 0);

    // Filter test: onlyDrop
    const dropsOnly = getTelemetryReport({ conversationId: mainId, onlyDrop: true }, { dataDir, appDataDir });
    assert.equal(dropsOnly.calls.length, 2);

    // Filter test: agentFilter = 'sub'
    const subOnly = getTelemetryReport({ conversationId: mainId, agentFilter: 'sub' }, { dataDir, appDataDir });
    assert.equal(subOnly.calls.length, 1);
    assert.equal(subOnly.calls[0].agentTag, '子1');

    // All 4 alert classes triggered!
    const alertCodes = new Set(report.alerts.map((a) => a.code));
    assert.ok(alertCodes.has('context_high'), 'Expected context_high alert');
    assert.ok(alertCodes.has('cache_drop'), 'Expected cache_drop alert');
    assert.ok(alertCodes.has('subagent_burst'), 'Expected subagent_burst alert');
    assert.ok(alertCodes.has('low_tps_streak'), 'Expected low_tps_streak alert');

    // Single-line banner formatting
    const banner = formatUserMarkdownBanner(step1);
    assert.match(banner, /^⚡ 100\.0 tok\/s \| Cache 95\.0%/);
    assert.ok(!banner.includes('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hook timing matches startMs 1-to-1 and never steals previous step endMs within the same second', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-timing-collision-'));
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');
  const convId = 'conv-same-sec-collision';
  const convDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(convDir, { recursive: true });

  try {
    // Step 1 starts at 12:39:52.772Z and ends at 12:39:57.538Z (4766ms).
    // Step 2 starts in the SAME second at 12:39:57.674Z and ends at 12:40:22.600Z (24926ms).
    // Transcript created_at is truncated to whole seconds (12:39:52Z and 12:39:57Z).
    const tPrevStart = Date.parse('2026-11-22T12:39:52.772Z');
    const tPrevEnd = Date.parse('2026-11-22T12:39:57.538Z');
    const tCurStart = Date.parse('2026-11-22T12:39:57.674Z');
    const tCurEnd = Date.parse('2026-11-22T12:40:22.600Z');

    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 3, timestampMs: tPrevStart }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 3, timestampMs: tPrevEnd }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 4, timestampMs: tCurStart }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 4, timestampMs: tCurEnd }, { dataDir });

    const steps = [
      {
        step_index: 99,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T12:39:52Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 1000,
        cache_read_tokens: 99000,
        output_tokens: 164,
        content: 'tool step',
      },
      {
        step_index: 102,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T12:39:57Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 2161,
        cache_read_tokens: 100401,
        output_tokens: 3452,
        thinking: 'Think',
        content: 'Final answer',
      },
    ];
    fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n');

    const report = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    const s99 = report.calls.find((c) => c.stepIndex === 99);
    const s102 = report.calls.find((c) => c.stepIndex === 102);

    assert.equal(s99.durationMs, 4766);
    assert.equal(s102.durationMs, 24926);
    assert.ok(s102.effectiveTps > 130 && s102.effectiveTps < 145, `Expected ~138.5 tok/s, got ${s102.effectiveTps}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
