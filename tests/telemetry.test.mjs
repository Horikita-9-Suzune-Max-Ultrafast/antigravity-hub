import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearTelemetryCache,
  evaluateAlerts,
  getTelemetryReport,
  queryCalls,
  recordHookTiming,
  resyncAllHistoricalTelemetry,
  syncConversationTelemetry,
} from '../src/core/telemetry.mjs';
import { closeIndexDb, rebuildIndex } from '../src/core/index-db.mjs';
import { getDataPaths } from '../src/core/paths.mjs';
import { readJsonSafe, readJsonlSafe } from '../src/core/storage.mjs';
import { loadConfig } from '../src/core/config.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTranscript(appDataDir, convId, steps) {
  const dir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  return filePath;
}

test('Streaming multi-tool calls compute full tool group span (hybrid_tool_split) and stop at boundary or toolCalls.length', () => {
  const root = makeTmpDir('cc-tps-multitool-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearTelemetryCache();
    const convId = 'conv-streaming-multitool';
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T01:00:00Z', content: 'Edit 3 files' },
      // 3 streaming tool calls: tool1 at +1s, tool2 at +5s, tool3 at +14s, plus extra non-tool step at +40s
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T01:00:02Z',
        model: 'gemini-4-neon-high',
        input_tokens: 2000,
        cache_read_tokens: 48000,
        output_tokens: 1400,
        thinking: 'Planning edits',
        content: '',
        tool_calls: [
          { name: 'read_file', args: { Path: 'a.mjs' } },
          { name: 'read_file', args: { Path: 'b.mjs' } },
          { name: 'edit_file', args: { Path: 'c.mjs' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', created_at: '2026-11-25T01:00:03Z', content: 'tool 1' },
      { step_index: 3, type: 'GENERIC', created_at: '2026-11-25T01:00:07Z', content: 'tool 2' },
      { step_index: 4, type: 'GENERIC', created_at: '2026-11-25T01:00:16Z', content: 'tool 3' },
      // Extra 4th GENERIC step must NOT be included (stopped at toolCalls.length === 3)
      { step_index: 5, type: 'GENERIC', created_at: '2026-11-25T01:00:42Z', content: 'unrelated' },
      // Second multi-tool call interrupted by USER_INPUT after 1 tool step
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T01:01:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 50000,
        output_tokens: 500,
        tool_calls: [
          { name: 'read_file', args: { Path: 'x.mjs' } },
          { name: 'read_file', args: { Path: 'y.mjs' } },
        ],
      },
      { step_index: 7, type: 'GENERIC', created_at: '2026-11-25T01:01:05Z', content: 'tool 1 done' },
      { step_index: 8, type: 'USER_INPUT', created_at: '2026-11-25T01:03:00Z', content: 'stop' },
    ];
    writeTranscript(appDataDir, convId, steps);

    const report = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    const s1 = report.calls.find((c) => c.stepIndex === 1);
    const s6 = report.calls.find((c) => c.stepIndex === 6);

    assert.equal(s1.timingSource, 'hybrid_tool_split');
    assert.equal(s1.durationMs, 14_000, 'Should span full 3-tool group (16s - 2s = 14000ms), not only steps[idx+1]');
    assert.equal(s1.effectiveTps, 100);

    assert.equal(s6.timingSource, 'hybrid_tool_split');
    assert.equal(s6.durationMs, 5_000, 'Should stop before USER_INPUT boundary (01:01:05 - 01:01:00 = 5000ms)');
    assert.equal(s6.effectiveTps, 100);
  } finally {
    closeIndexDb();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('No prev-delta spike, incremental tail recompute on tools & hook_ms, and calls.jsonl truth-source sync survive rebuildIndex', () => {
  const root = makeTmpDir('cc-tps-incremental-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearTelemetryCache();
    const convId = 'conv-inc-backfill';
    const baseMs = Date.parse('2026-11-25T02:00:00.000Z');

    // Sync 1: prev step is only 250ms before trailing PLANNER_RESPONSE (would have caused ~20,000 tok/s spike before!)
    const initialSteps = [
      { step_index: 0, type: 'USER_INPUT', created_at: new Date(baseMs).toISOString(), content: 'Go' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(baseMs + 250).toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 1500,
        cache_read_tokens: 40000,
        output_tokens: 4800,
        thinking: 'Long reasoning...',
        content: 'Calling 2 tools',
        tool_calls: [
          { name: 'read_file', args: { Path: 'a.mjs' } },
          { name: 'write_file', args: { Path: 'b.mjs' } },
        ],
      },
    ];
    const transcriptFile = writeTranscript(appDataDir, convId, initialSteps);

    const sync1 = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(sync1.syncedNew, 1);
    assert.equal(sync1.calls.length, 1);
    assert.equal(sync1.calls[0].timingSource, 'estimated', 'Must NOT use cur.tsMs - prev.tsMs');
    assert.ok(sync1.calls[0].effectiveTps <= 100, `Expected conservative fallback TPS, got ${sync1.calls[0].effectiveTps}`);
    assert.equal(sync1.calls[0].durationMs, 80_000);

    // Sync 2: tool step 1 arrives (+3s) -> upgrades estimated -> hybrid_tool_split and syncs calls.jsonl
    const tool1 = {
      step_index: 2,
      type: 'GENERIC',
      created_at: new Date(baseMs + 3_250).toISOString(),
      content: 'tool 1 result',
    };
    fs.appendFileSync(transcriptFile, JSON.stringify(tool1) + '\n', 'utf8');

    const sync2 = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(sync2.syncedNew, 0, 'Revised existing callUid must not increment syncedNew');
    assert.equal(sync2.syncedUpdated, 1);
    const afterTool1 = sync2.calls.find((c) => c.stepIndex === 1);
    assert.equal(afterTool1.timingSource, 'hybrid_tool_split');
    assert.equal(afterTool1.durationMs, 3_000);

    // Sync 3: tool step 2 arrives (+20s) -> durationMs shifts > 5% (3s -> 20s) and syncs calls.jsonl
    const tool2 = {
      step_index: 3,
      type: 'GENERIC',
      created_at: new Date(baseMs + 20_250).toISOString(),
      content: 'tool 2 result',
    };
    fs.appendFileSync(transcriptFile, JSON.stringify(tool2) + '\n', 'utf8');

    const sync3 = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(sync3.syncedNew, 0);
    assert.equal(sync3.syncedUpdated, 1);
    const afterTool2 = sync3.calls.find((c) => c.stepIndex === 1);
    assert.equal(afterTool2.timingSource, 'hybrid_tool_split');
    assert.equal(afterTool2.durationMs, 20_000);
    assert.equal(afterTool2.effectiveTps, 240);

    // Sync 4: PostInvocation hook_ms arrives (24_000ms) WITHOUT transcript file growth -> recomputes tail & upgrades to hook_ms
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 1, timestampMs: baseMs + 500 }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 1, timestampMs: baseMs + 24_500 }, { dataDir });

    const sync4 = syncConversationTelemetry({ conversationId: convId }, { dataDir, appDataDir });
    assert.equal(sync4.syncedNew, 0);
    assert.equal(sync4.syncedUpdated, 1);
    const afterHook = sync4.calls.find((c) => c.stepIndex === 1);
    assert.equal(afterHook.timingSource, 'hook_ms');
    assert.equal(afterHook.durationMs, 24_000);
    assert.equal(afterHook.effectiveTps, 200);

    // Verify calls.jsonl contains the revised records AND rebuildIndex() never resurrects the stale estimated record
    const paths = getDataPaths({ dataDir });
    const rawLines = readJsonlSafe(paths.callsLogFile);
    assert.ok(rawLines.length >= 4, `Expected revised records appended to calls.jsonl, got ${rawLines.length}`);
    assert.equal(rawLines[rawLines.length - 1].timingSource, 'hook_ms');
    assert.equal(rawLines[rawLines.length - 1].durationMs, 24_000);

    rebuildIndex({ dataDir });
    const rebuilt = queryCalls({ rootConversationId: convId }, { dataDir });
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].timingSource, 'hook_ms');
    assert.equal(rebuilt[0].durationMs, 24_000);
    assert.equal(rebuilt[0].effectiveTps, 200);
  } finally {
    closeIndexDb();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('USER_INPUT and SYSTEM_MESSAGE gaps are excluded from duration, estimated steps excluded from avgTps and low_tps_streak', () => {
  const root = makeTmpDir('cc-tps-usergap-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearTelemetryCache();
    const convId = 'conv-user-pause';
    const t0 = Date.parse('2026-11-25T03:00:00Z');
    // Real hook_ms for step 1: 4s, 400 tokens => 100 tok/s
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 1, timestampMs: t0 + 1_000 }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 1, timestampMs: t0 + 5_000 }, { dataDir });

    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T03:00:00Z', content: 'Hi' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T03:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 400,
        content: 'First real-timed answer',
      },
      // Step 2: followed by USER_INPUT 150s later -> MUST NOT become 0.7 tok/s!
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T03:00:10Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 10000,
        output_tokens: 105,
        content: 'Waiting on user...',
      },
      { step_index: 3, type: 'USER_INPUT', created_at: '2026-11-25T03:02:40Z', content: 'Back after 2.5 min' },
      // Step 4: followed by SYSTEM_MESSAGE 120s later -> MUST NOT become 0.5 tok/s!
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T03:02:45Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 11000,
        output_tokens: 60,
        content: 'Reply before system notice',
      },
      { step_index: 5, type: 'SYSTEM_MESSAGE', created_at: '2026-11-25T03:04:45Z', content: 'Idle notification' },
    ];
    writeTranscript(appDataDir, convId, steps);

    const report = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    const s1 = report.calls.find((c) => c.stepIndex === 1);
    const s2 = report.calls.find((c) => c.stepIndex === 2);
    const s4 = report.calls.find((c) => c.stepIndex === 4);

    assert.equal(s1.timingSource, 'hook_ms');
    assert.equal(s1.effectiveTps, 100);

    assert.equal(s2.timingSource, 'estimated', 'USER_INPUT pause must not be used as generation duration');
    assert.ok(s2.effectiveTps > 50, `Expected conservative ~60 tok/s, got ${s2.effectiveTps}`);

    assert.equal(s4.timingSource, 'estimated', 'SYSTEM_MESSAGE pause must not be used as generation duration');
    assert.ok(s4.effectiveTps > 50, `Expected conservative ~60 tok/s, got ${s4.effectiveTps}`);

    // avgTps must exclude 'estimated' steps when real-timed steps exist (so avgTps === 100.0, not diluted to ~80)
    assert.equal(report.summary.avgTps, 100);
    assert.equal(report.summary.byAgent[0].avgTps, 100);
    assert.equal(report.summary.byModel[0].avgTps, 100);

    // evaluateAlerts must exclude 'estimated' steps from low_tps_streak
    const config = loadConfig({ dataDir });
    const estLowCalls = [
      { agentType: 'main', agentTag: '主', stepIndex: 3, model: 'gemini-4-neon-high', contextTokens: 10000, cacheHitRate: 90, estimatedCostUsd: 0.01, timingSource: 'estimated', effectiveTps: 5 },
      { agentType: 'main', agentTag: '主', stepIndex: 2, model: 'gemini-4-neon-high', contextTokens: 10000, cacheHitRate: 90, estimatedCostUsd: 0.01, timingSource: 'estimated', effectiveTps: 6 },
      { agentType: 'main', agentTag: '主', stepIndex: 1, model: 'gemini-4-neon-high', contextTokens: 10000, cacheHitRate: 90, estimatedCostUsd: 0.01, timingSource: 'estimated', effectiveTps: 4 },
    ];
    const alertsForEst = evaluateAlerts(estLowCalls, config);
    assert.ok(!alertsForEst.some((a) => a.code === 'low_tps_streak'), 'Estimated steps must never trigger low_tps_streak');

    const realLowCalls = estLowCalls.map((c) => ({ ...c, timingSource: 'hook_ms' }));
    const alertsForReal = evaluateAlerts(realLowCalls, config);
    assert.ok(alertsForReal.some((a) => a.code === 'low_tps_streak'), 'Real-timed slow steps must trigger low_tps_streak');
  } finally {
    closeIndexDb();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Tightened hook_ms matching (<= 5s startMs, no endMs fallback) and minTranscriptSpanMs lower-bound guard', () => {
  const root = makeTmpDir('cc-tps-hookguard-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearTelemetryCache();
    const convId = 'conv-hook-guard';

    // Sample 1: starts 15s BEFORE step 1 and ends 500ms before step 1 -> old loose endMs / 30s window would steal it!
    const tS1Start = Date.parse('2026-11-25T04:00:00.000Z');
    const tS1End = Date.parse('2026-11-25T04:00:14.500Z');
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 1, timestampMs: tS1Start }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 1, timestampMs: tS1End }, { dataDir });

    // Sample 2: starts 8s AFTER step 1 (> 5s window) -> must NOT match step 1
    const tS2Start = Date.parse('2026-11-25T04:00:23.000Z');
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 2, timestampMs: tS2Start }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 2, timestampMs: tS2Start + 2_000 }, { dataDir });

    // Sample 3: mismatched short hookMs (1_500ms) right at step 2 start, while step 2's tool group spans 12_000ms
    const tStep2 = Date.parse('2026-11-25T04:01:00.000Z');
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 3, timestampMs: tStep2 + 200 }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 3, timestampMs: tStep2 + 1_700 }, { dataDir });

    // Sample 4: valid hookMs (9_200ms) right at step 6 start, where tool group spans 10_000ms (9200 >= 10000 - 2000)
    const tStep6 = Date.parse('2026-11-25T04:02:00.000Z');
    recordHookTiming({ conversationId: convId, phase: 'pre', invocationNum: 4, timestampMs: tStep6 + 300 }, { dataDir });
    recordHookTiming({ conversationId: convId, phase: 'post', invocationNum: 4, timestampMs: tStep6 + 9_500 }, { dataDir });

    const steps = [
      // Step 1 at 04:00:15Z: sample 1 endMs is 0.5s away (startMs 15s away), sample 2 startMs is 8s away -> neither should match!
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T04:00:15Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 10000,
        output_tokens: 300,
        content: 'Unmatched step',
      },
      // Step 2 at 04:01:00Z with 2 streaming tools spanning 12_000ms -> rejects 1_500ms hookMs, uses hybrid_tool_split (12_000ms)
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T04:01:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 10000,
        output_tokens: 1200,
        tool_calls: [
          { name: 'read_file', args: { Path: '1.mjs' } },
          { name: 'read_file', args: { Path: '2.mjs' } },
        ],
      },
      { step_index: 3, type: 'GENERIC', created_at: '2026-11-25T04:01:02Z', content: 't1' },
      { step_index: 4, type: 'GENERIC', created_at: '2026-11-25T04:01:12Z', content: 't2' },
      { step_index: 5, type: 'USER_INPUT', created_at: '2026-11-25T04:01:50Z', content: 'next' },
      // Step 6 at 04:02:00Z with 2 streaming tools spanning 10_000ms and valid hookMs 9_200ms -> accepts hook_ms
      {
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T04:02:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 10000,
        output_tokens: 920,
        tool_calls: [
          { name: 'read_file', args: { Path: '3.mjs' } },
          { name: 'read_file', args: { Path: '4.mjs' } },
        ],
      },
      { step_index: 7, type: 'GENERIC', created_at: '2026-11-25T04:02:04Z', content: 't3' },
      { step_index: 8, type: 'GENERIC', created_at: '2026-11-25T04:02:10Z', content: 't4' },
    ];
    writeTranscript(appDataDir, convId, steps);

    const report = getTelemetryReport({ conversationId: convId }, { dataDir, appDataDir });
    const s1 = report.calls.find((c) => c.stepIndex === 1);
    const s2 = report.calls.find((c) => c.stepIndex === 2);
    const s6 = report.calls.find((c) => c.stepIndex === 6);

    assert.notEqual(s1.timingSource, 'hook_ms', 'Must not steal loose endMs or >5s startMs sample');
    assert.equal(s1.timingSource, 'transcript_fallback');

    assert.equal(s2.timingSource, 'hybrid_tool_split', 'Must reject mismatched 1500ms hookMs when minTranscriptSpanMs=12000ms');
    assert.equal(s2.durationMs, 12_000);
    assert.equal(s2.effectiveTps, 100);

    assert.equal(s6.timingSource, 'hook_ms', 'Valid hookMs within 2s lower-bound tolerance must be accepted');
    assert.equal(s6.durationMs, 9_200);
    assert.equal(s6.effectiveTps, 100);
  } finally {
    closeIndexDb();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resyncAllHistoricalTelemetry reparses all local transcripts, clears stale cursors, preserves orphaned calls, compacts calls.jsonl, and rebuilds index', () => {
  const root = makeTmpDir('cc-tps-resync-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearTelemetryCache();
    const mainId = '11111111-2222-4333-8444-555555555555';
    const subId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const orphanId = '99999999-9999-4999-8999-999999999999';

    // Write local transcripts (main + subagent)
    writeTranscript(appDataDir, mainId, [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T05:00:00Z', content: 'Analyze' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T05:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 2000,
        cache_read_tokens: 30000,
        output_tokens: 1000,
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'Worker' } },
          { name: 'read_file', args: { Path: 'x.mjs' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-11-25T05:00:03Z',
        content: `Launched subagent conversationId: ${subId}`,
      },
      { step_index: 3, type: 'GENERIC', created_at: '2026-11-25T05:00:11Z', content: 'read done' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T05:00:20Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 31000,
        output_tokens: 120,
        content: 'Final reply before long user pause',
      },
      { step_index: 5, type: 'USER_INPUT', created_at: '2026-11-25T05:03:20Z', content: 'Thanks!' },
    ]);

    writeTranscript(appDataDir, subId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T05:00:04Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 5000,
        output_tokens: 600,
        tool_calls: [{ name: 'read_file', args: { Path: 'sub.mjs' } }],
      },
      { step_index: 2, type: 'GENERIC', created_at: '2026-11-25T05:00:10Z', content: 'sub tool done' },
    ]);

    // Seed stale/corrupted calls.jsonl (spike + false low TPS + duplicate lines + orphaned historical call)
    const paths = getDataPaths({ dataDir });
    fs.mkdirSync(paths.telemetryDir, { recursive: true });
    const badCalls = [
      // Duplicate older entry for mainId:1
      {
        callUid: `${mainId}:1`,
        conversationId: mainId,
        rootConversationId: mainId,
        agentType: 'main',
        agentTag: '主',
        stepIndex: 1,
        model: 'gemini-4-neon-high',
        createdAt: '2026-11-25T05:00:01Z',
        tsMs: Date.parse('2026-11-25T05:00:01Z'),
        durationMs: 200,
        timingSource: 'transcript_fallback',
        inputTokens: 2000,
        cacheReadTokens: 30000,
        outputTokens: 1000,
        contextTokens: 32000,
        thinkingTokensEst: 0,
        contentTokensEst: 1000,
        effectiveTps: 5000,
        cacheHitRate: 93.75,
        cacheDrop: false,
        estimatedCostUsd: 0.01,
        quotaGroup: 'gemini',
      },
      // Spike record (20,000 tok/s!) for mainId:1
      {
        callUid: `${mainId}:1`,
        conversationId: mainId,
        rootConversationId: mainId,
        agentType: 'main',
        agentTag: '主',
        stepIndex: 1,
        model: 'gemini-4-neon-high',
        createdAt: '2026-11-25T05:00:01Z',
        tsMs: Date.parse('2026-11-25T05:00:01Z'),
        durationMs: 50,
        timingSource: 'transcript_fallback',
        inputTokens: 2000,
        cacheReadTokens: 30000,
        outputTokens: 1000,
        contextTokens: 32000,
        thinkingTokensEst: 0,
        contentTokensEst: 1000,
        effectiveTps: 20000,
        cacheHitRate: 93.75,
        cacheDrop: false,
        estimatedCostUsd: 0.01,
        quotaGroup: 'gemini',
      },
      // False low-TPS record (0.67 tok/s from 180s USER_INPUT pause!) for mainId:4
      {
        callUid: `${mainId}:4`,
        conversationId: mainId,
        rootConversationId: mainId,
        agentType: 'main',
        agentTag: '主',
        stepIndex: 4,
        model: 'gemini-4-neon-high',
        createdAt: '2026-11-25T05:00:20Z',
        tsMs: Date.parse('2026-11-25T05:00:20Z'),
        durationMs: 180_000,
        timingSource: 'transcript_fallback',
        inputTokens: 1000,
        cacheReadTokens: 31000,
        outputTokens: 120,
        contextTokens: 32000,
        thinkingTokensEst: 0,
        contentTokensEst: 120,
        effectiveTps: 0.67,
        cacheHitRate: 96.88,
        cacheDrop: false,
        estimatedCostUsd: 0.005,
        quotaGroup: 'gemini',
      },
      // Orphaned historical call whose transcript was deleted -> MUST be preserved!
      {
        callUid: `${orphanId}:1`,
        conversationId: orphanId,
        rootConversationId: orphanId,
        agentType: 'main',
        agentTag: '主',
        stepIndex: 1,
        model: 'claude-4-sonnet',
        createdAt: '2026-11-20T01:00:00Z',
        tsMs: Date.parse('2026-11-20T01:00:00Z'),
        durationMs: 5000,
        timingSource: 'hook_ms',
        inputTokens: 500,
        cacheReadTokens: 4500,
        outputTokens: 300,
        contextTokens: 5000,
        thinkingTokensEst: 0,
        contentTokensEst: 300,
        effectiveTps: 60,
        cacheHitRate: 90,
        cacheDrop: false,
        estimatedCostUsd: 0.01,
        quotaGroup: 'claude',
      },
    ];
    fs.writeFileSync(paths.callsLogFile, badCalls.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');

    // Seed stale cursor for deleted conversation
    fs.writeFileSync(
      paths.cursorsFile,
      JSON.stringify({
        [orphanId]: { size: 9999, offset: 9999, subagents: [] },
        [mainId]: { size: 10, offset: 10, subagents: [] },
      }),
      'utf8'
    );

    const summary = resyncAllHistoricalTelemetry({ dataDir, appDataDir });

    assert.equal(summary.transcriptsScanned, 2);
    assert.equal(summary.reparsedCalls, 3);
    assert.equal(summary.orphanedPreserved, 1);
    assert.equal(summary.addedCalls, 1, 'subId:1 was added');
    assert.equal(summary.updatedCalls, 2, 'mainId:1 and mainId:4 were repaired');

    assert.equal(summary.before.rawLines, 4);
    assert.equal(summary.before.uniqueCalls, 3);
    assert.equal(summary.before.spikeCount, 1);
    assert.equal(summary.before.lowTpsCount, 1);

    assert.equal(summary.after.rawLines, 4, 'Compacted calls.jsonl must have 1 line per unique callUid');
    assert.equal(summary.after.uniqueCalls, 4);
    assert.equal(summary.after.spikeCount, 0);
    assert.equal(summary.after.lowTpsCount, 0);

    // Verify compacted calls.jsonl on disk
    const compacted = readJsonlSafe(paths.callsLogFile);
    assert.equal(compacted.length, 4);
    assert.ok(compacted.some((c) => c.callUid === `${orphanId}:1`), 'Orphaned historical call must be preserved');

    // Verify stale cursor cleared
    const cursors = readJsonSafe(paths.cursorsFile, {});
    assert.equal(cursors[orphanId], undefined, 'Stale cursor for deleted transcript must be removed');
    assert.ok(cursors[mainId], 'Active local transcript cursor must be refreshed');

    // Verify SQLite index was rebuilt with repaired values and subagent linkage
    const dbMainCalls = queryCalls({ rootConversationId: mainId }, { dataDir });
    assert.equal(dbMainCalls.length, 3, 'Main (2) + Sub1 (1) should be linked under mainId');
    const repairedMain1 = dbMainCalls.find((c) => c.callUid === `${mainId}:1`);
    const repairedMain4 = dbMainCalls.find((c) => c.callUid === `${mainId}:4`);
    const repairedSub1 = dbMainCalls.find((c) => c.callUid === `${subId}:1`);

    assert.equal(repairedMain1.timingSource, 'hybrid_tool_split');
    assert.equal(repairedMain1.durationMs, 10_000);
    assert.equal(repairedMain1.effectiveTps, 100);

    assert.equal(repairedMain4.timingSource, 'estimated');
    assert.equal(repairedMain4.effectiveTps, 60);

    assert.equal(repairedSub1.agentType, 'sub');
    assert.equal(repairedSub1.agentTag, '子1');
    assert.equal(repairedSub1.timingSource, 'hybrid_tool_split');
    assert.equal(repairedSub1.durationMs, 6_000);
    assert.equal(repairedSub1.effectiveTps, 100);

    const dbOrphanCalls = queryCalls({ rootConversationId: orphanId }, { dataDir });
    assert.equal(dbOrphanCalls.length, 1);
    assert.equal(dbOrphanCalls[0].effectiveTps, 60);
  } finally {
    closeIndexDb();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
