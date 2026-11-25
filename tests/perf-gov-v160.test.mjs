import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import {
  scanEcosystem,
  runGovernanceLint,
  computeGovernanceScore,
  computeBaselinePenalty,
  tokenizeKeywords,
  previewGovernanceFile,
  clearEcosystemInventoryCache,
  createHostSnapshot,
} from '../src/core/governance/index.mjs';
import { scanWorkspaceLocalPlugins } from '../src/core/ecosystem-inventory.mjs';
import {
  clearTranscriptCache,
  getTranscriptAnalysis,
  getTranscriptParseStats,
  resetTranscriptParseStats,
  listConversations,
} from '../src/core/transcript-parser.mjs';
import { inspectContext, clearContextInspectorCache } from '../src/core/context-inspector.mjs';
import {
  clearGitContextCache,
  getGitContext,
  getGitSpawnCount,
  resetGitSpawnCount,
} from '../src/core/git-context.mjs';
import {
  clearTelemetryCache,
  getTelemetryReport,
  syncConversationTelemetry,
  calcWeightedAvgTps,
  formatUserMarkdownBanner,
} from '../src/core/telemetry.mjs';
import {
  clearNativeStepMetricsCache,
  loadNativeStepMetrics,
} from '../src/core/native-step-metrics.mjs';
import { closeIndexDb, upsertCallRow, withIndexDb } from '../src/core/index-db.mjs';
import { getDataPaths } from '../src/core/paths.mjs';
import { getQuotaSnapshot } from '../src/core/quota.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeFieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function encodeFieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeProtoTimestamp(ms) {
  const sec = Math.floor(ms / 1000);
  const nanos = Math.round((ms % 1000) * 1_000_000);
  return Buffer.concat([encodeFieldVarint(1, sec), encodeFieldVarint(2, nanos)]);
}

function buildNativeStepBlob({ createdAtMs, firstTokenAtMs, completedAtMs, thinkingTokens, contentTokens }) {
  const usageBuf = Buffer.concat([
    encodeFieldVarint(3, thinkingTokens + contentTokens),
    encodeFieldVarint(9, thinkingTokens),
    encodeFieldVarint(10, contentTokens),
  ]);
  return Buffer.concat([
    encodeFieldBytes(1, encodeProtoTimestamp(createdAtMs)),
    encodeFieldBytes(6, encodeProtoTimestamp(firstTokenAtMs)),
    encodeFieldBytes(7, encodeProtoTimestamp(completedAtMs)),
    encodeFieldBytes(9, usageBuf),
  ]);
}

test('§4.2 4-pillar continuous scoring satisfies TC-01 through TC-05 mathematical benchmarks', () => {
  // TC-01: Clean environment (0 findings, baseline 5,200 tokens <= 8K) -> 100 (A)
  const tc01 = computeGovernanceScore([], 5200);
  assert.equal(tc01.pillars.security.score, 30);
  assert.equal(tc01.pillars.integrity.score, 25);
  assert.equal(tc01.pillars.efficiency.score, 25);
  assert.equal(tc01.pillars.hygiene.score, 20);
  assert.equal(tc01.scoreExact, 100);
  assert.equal(tc01.score, 100);
  assert.equal(tc01.grade, 'A');

  // TC-02: 1 own SECRET_* in mcp_config.json, baseline 6,000 -> 9.99 + 25 + 25 + 20 = 79.99 -> 80 (B), impactPts = +20.0
  const tc02Finding = {
    id: 'SECRET_OPENAI_ANTHROPIC_KEY::mcp::mcp_config.json:1',
    code: 'SECRET_OPENAI_ANTHROPIC_KEY',
    severity: 'error',
    isPluginManaged: false,
    ignored: false,
  };
  const tc02 = computeGovernanceScore([tc02Finding], 6000);
  assert.equal(tc02.pillars.security.score, 9.99);
  assert.equal(tc02.scoreExact, 79.99);
  assert.equal(tc02.score, 80);
  assert.equal(tc02.grade, 'B');
  assert.equal(tc02.impactById.get(tc02Finding.id), 20.0);

  // TC-03: Heavy third-party plugin suite (20 plugin SKILL_LONG_DESC + 4 plugin SKILL_SHADOWED, baseline 12,000t)
  // Verifies 1/sqrt(k) diminishing + 0.35 plugin ownershipFactor + B(12000) eliminates 0-score cliff -> Grade B
  const tc03Findings = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `SKILL_LONG_DESC::sk-${String(i).padStart(2, '0')}`,
      code: 'SKILL_LONG_DESC',
      severity: 'info',
      isPluginManaged: true,
      ignored: false,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `SKILL_SHADOWED::sh-${i}`,
      code: 'SKILL_SHADOWED',
      severity: 'warn',
      isPluginManaged: true,
      ignored: false,
    })),
  ];
  const tc03 = computeGovernanceScore(tc03Findings, 12000);
  assert.equal(tc03.pillars.security.score, 30);
  assert.equal(tc03.pillars.integrity.score, 25);
  assert.ok(tc03.pillars.efficiency.score > 16.5 && tc03.pillars.efficiency.score < 18.0);
  assert.ok(tc03.pillars.hygiene.score > 15.0 && tc03.pillars.hygiene.score < 16.5);
  assert.equal(tc03.grade, 'B');
  assert.ok(tc03.score >= 86 && tc03.score <= 89, `Expected TC-03 score in [86,89], got ${tc03.score}`);
  assert.ok(computeBaselinePenalty(8000) === 0 && computeBaselinePenalty(12000) > 1.2 && computeBaselinePenalty(40000) > 14);

  // TC-04: 1 deferred 28,000t MCP (eager=0), baseline 6,500t -> 30 + 25 + 23.67 + 20 = 98.67 -> 99 (A)
  const tc04Finding = {
    id: 'MCP_HEAVY_SCHEMA::big-deferred',
    code: 'MCP_HEAVY_SCHEMA',
    severity: 'info',
    isPluginManaged: false,
    ignored: false,
    meta: { deferred: true },
  };
  const tc04 = computeGovernanceScore([tc04Finding], 6500);
  assert.equal(tc04.pillars.efficiency.score, 23.67);
  assert.equal(tc04.scoreExact, 98.67);
  assert.equal(tc04.score, 99);
  assert.equal(tc04.grade, 'A');

  // TC-05: 1 own secret + 1 own broken target + 1 plugin shadowed + 2 plugin broken links -> ignore 1 plugin broken link
  const tc05Findings = [
    { id: 'sec-1', code: 'SECRET_OPENAI_ANTHROPIC_KEY', severity: 'error', isPluginManaged: false, ignored: false },
    { id: 'mcp-1', code: 'MCP_BROKEN_TARGET', severity: 'error', isPluginManaged: false, ignored: false },
    { id: 'sh-1', code: 'SKILL_SHADOWED', severity: 'warn', isPluginManaged: true, ignored: false },
    { id: 'bl-1', code: 'SKILL_BROKEN_LINK', severity: 'warn', isPluginManaged: true, ignored: false },
    { id: 'bl-2', code: 'SKILL_BROKEN_LINK', severity: 'warn', isPluginManaged: true, ignored: false },
  ];
  const before = computeGovernanceScore(tc05Findings, 4000);
  assert.equal(before.pillars.integrity.score, 8.14);

  const afterIgnore = computeGovernanceScore(
    tc05Findings.map((f) => (f.id === 'bl-2' ? { ...f, ignored: true } : f)),
    4000
  );
  assert.equal(afterIgnore.pillars.integrity.score, 9.83);
  assert.ok(afterIgnore.scoreExact - before.scoreExact > 1.65);
  assert.ok(afterIgnore.score > before.score, 'Integer score must strictly rise after ignoring 1 plugin broken link');

  // Unignoring restores exact score losslessly
  const restored = computeGovernanceScore(tc05Findings, 4000);
  assert.equal(restored.score, before.score);
  assert.equal(restored.scoreExact, before.scoreExact);
});

test('§4.1 & §4.2 Vault .md / events.jsonl / hooks.json secret audit, [REDACTED] same-line bypass fix, RULE_OVERSIZED, deferred MCP & CJK bigram overlap', () => {
  const root = makeTmpDir('cc-gov-v160-');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const appDataDir = path.join(root, 'app');
  const projectDir = path.join(root, 'workspace');

  try {
    clearEcosystemInventoryCache();
    fs.mkdirSync(path.join(dataDir, 'projects', 'proj-1', 'memories'), { recursive: true });
    fs.mkdirSync(path.join(configDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(configDir, 'skills', 'zh-a'), { recursive: true });
    fs.mkdirSync(path.join(configDir, 'skills', 'zh-b'), { recursive: true });
    fs.mkdirSync(path.join(appDataDir, 'mcp', 'lazy-pool'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.agents'), { recursive: true });

    const vaultKey = `sk-proj-${'Z'.repeat(28)}`;
    const eventsKey = `ghp_${'Q'.repeat(28)}`;
    const hookKey = `AKIA${'1'.repeat(16)}`;
    const sameLineKey = `AIza${'B'.repeat(32)}`;

    // 1. Vault memories/*.md secret
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'proj-1', 'memories', 'mem_secret.md'),
      `---\nid: "mem_1"\nproject_id: "proj-1"\n---\nToken leaked: ${vaultKey}\n`,
      'utf8'
    );
    // 2. Vault events.jsonl secret
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'proj-1', 'events.jsonl'),
      JSON.stringify({ event: 'note', detail: `token=${eventsKey}` }) + '\n',
      'utf8'
    );
    // 3. hooks.json secret
    fs.writeFileSync(
      path.join(configDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `curl -H "${hookKey}"`, timeout: 20 }] }],
        },
      }),
      'utf8'
    );
    // 4. [REDACTED] + unredacted secret on the SAME line + oversized rule (> 3000 tokens)
    const bigRuleBody = 'Keep architecture clean and modular without regressions.\n'.repeat(400);
    fs.writeFileSync(
      path.join(configDir, 'rules', 'BIG_RULE.md'),
      `OLD=[REDACTED_KEY] NEW=${sameLineKey}\n${bigRuleBody}`,
      'utf8'
    );

    // 5. Deferred MCP >= 25,000 tokens (eager=0)
    fs.writeFileSync(
      path.join(configDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { 'lazy-pool': { command: 'node', args: [] } } }),
      'utf8'
    );
    const bigTool = JSON.stringify({ name: 'heavy_op', description: 'Detailed schema payload '.repeat(600) });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(appDataDir, 'mcp', 'lazy-pool', `t${i}.json`), bigTool, 'utf8');
    }

    // 6. Bilingual CJK skills with >= 0.58 Bigram overlap
    fs.writeFileSync(
      path.join(configDir, 'skills', 'zh-a', 'SKILL.md'),
      '---\nname: zh-a\ndescription: 当用户需要数据库索引优化、慢查询性能分析与执行计划诊断时使用\n---\n# A\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(configDir, 'skills', 'zh-b', 'SKILL.md'),
      '---\nname: zh-b\ndescription: 支持数据库索引优化、慢查询性能分析与执行计划诊断报告\n---\n# B\n',
      'utf8'
    );

    // 7. v1.7.0 R10 workspace local plugins hook
    fs.writeFileSync(
      path.join(projectDir, '.agents', 'plugins.json'),
      JSON.stringify({ plugins: { 'ws-helper': { displayName: 'Workspace Helper', enabled: true } } }),
      'utf8'
    );

    const opts = { dataDir, configDir, appDataDir, projectDir };
    const eco = scanEcosystem({ projectDir }, opts);

    // Verify deferred MCP is NOT counted in estimatedBaselineTokens!
    const lazySrv = eco.mcpServers.find((m) => m.name === 'lazy-pool');
    assert.equal(lazySrv.mode, 'deferred');
    assert.equal(lazySrv.eagerTokens, 0);
    assert.ok(lazySrv.deferredTokens >= 25000);
    assert.equal(eco.summary.breakdownTokens.mcpEager, 0);
    assert.ok(eco.summary.estimatedBaselineTokens < 20000, 'Deferred MCP must not inflate baseline tokens');

    // Verify v1.7.0 R10 workspace local plugins hook & snapshot path-hash uniqueness
    const wsLocal = scanWorkspaceLocalPlugins(projectDir);
    assert.equal(wsLocal.exists, true);
    assert.equal(wsLocal.plugins.length, 1);
    assert.equal(wsLocal.plugins[0].scope, 'workspace');

    const snap = createHostSnapshot(
      [path.join(configDir, 'config.json'), path.join(projectDir, '.agents', 'plugins.json')],
      'r10-multi-path',
      opts
    );
    assert.equal(snap.files.length, 2);

    const lint = runGovernanceLint(eco, opts);
    assert.ok(lint.grade && ['A', 'B', 'C', 'D'].includes(lint.grade));
    assert.ok(lint.pillars.security && lint.pillars.integrity && lint.pillars.efficiency && lint.pillars.hygiene);

    // Secret findings must catch Vault .md, events.jsonl, hooks.json, AND same-line post-[REDACTED] key
    const secretTargets = lint.findings.filter((f) => f.category === 'secret').map((f) => f.target);
    assert.ok(secretTargets.some((t) => t.includes('mem_secret.md')), 'Must detect secret in Vault memories/*.md');
    assert.ok(secretTargets.some((t) => t.includes('记忆事件日志')), 'Must detect secret in Vault events.jsonl');
    assert.ok(secretTargets.some((t) => t.includes('hooks.json')), 'Must detect secret in hooks.json');
    assert.ok(secretTargets.some((t) => t.includes('BIG_RULE.md')), 'Must detect secret after [REDACTED] on same line');

    // Ensure ZERO raw secret leaks in findings
    const serialized = JSON.stringify(lint.findings);
    for (const rawSecret of [vaultKey, eventsKey, hookKey, sameLineKey]) {
      assert.ok(!serialized.includes(rawSecret), 'Raw secret must never appear in lint output');
    }

    // RULE_OVERSIZED triggered
    assert.ok(lint.findings.some((f) => f.code === 'RULE_OVERSIZED' && f.pillar === 'efficiency'));

    // Deferred heavy MCP flagged as info (not warn)
    const heavyDeferred = lint.findings.find((f) => f.code === 'MCP_HEAVY_SCHEMA' && f.target === 'lazy-pool');
    assert.ok(heavyDeferred);
    assert.equal(heavyDeferred.severity, 'info');

    // CJK Bigram tokenizer + SKILL_TRIGGER_OVERLAP
    const kws = tokenizeKeywords('当用户需要数据库索引优化');
    assert.ok(kws.has('数据') && kws.has('索引') && !kws.has('当用'), 'CJK bigrams must exclude stop phrases');
    assert.ok(lint.findings.some((f) => f.code === 'SKILL_TRIGGER_OVERLAP'), 'Must detect Chinese skill overlap >= 0.58');

    // Every active finding has counterfactual +impactPts >= 0.1
    for (const f of lint.findings) {
      assert.ok(typeof f.impactPts === 'number' && f.impactPts >= 0.1);
    }

    // previewGovernanceFile blocks .env files
    const envFile = path.join(projectDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=123\n', 'utf8');
    assert.throws(() => previewGovernanceFile(envFile, projectDir, opts), /敏感凭据/);
  } finally {
    clearEcosystemInventoryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§1.3 Incremental transcript parsing avoids full re-reads on append and resets cleanly on truncation; rev digest tracks state', () => {
  const root = makeTmpDir('cc-inc-transcript-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');
  const configDir = path.join(root, 'config');
  const projectDir = path.join(root, 'ws');

  try {
    clearTranscriptCache();
    clearContextInspectorCache();
    clearTelemetryCache();
    resetTranscriptParseStats();

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Create one enabled and one disabled plugin to verify disabled plugin exclusion in inspectContext
    const disDir = path.join(configDir, 'plugins', 'disabled-heavy');
    fs.mkdirSync(path.join(disDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(disDir, 'plugin.json'), JSON.stringify({ name: 'disabled-heavy' }));
    fs.writeFileSync(path.join(disDir, 'rules', 'HEAVY.md'), 'Disabled plugin rule content '.repeat(100));
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ plugins: { 'disabled-heavy': { enabled: false } } })
    );

    const convId = '55555555-5555-4555-8555-555555555555';
    const logDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const tPath = path.join(logDir, 'transcript.jsonl');

    const step0 = { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T10:00:00Z', content: 'Hello world' };
    const step1 = {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-25T10:00:02Z',
      model: 'gemini-4-neon-high',
      input_tokens: 2000,
      cache_read_tokens: 18000,
      output_tokens: 250,
      content: 'First reply',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(projectDir, 'a.mjs') } }],
    };
    fs.writeFileSync(tPath, JSON.stringify(step0) + '\n' + JSON.stringify(step1) + '\n', 'utf8');

    const a1 = getTranscriptAnalysis(tPath);
    assert.equal(a1.steps.length, 2);
    assert.equal(getTranscriptParseStats().fullReads, 1);
    assert.equal(getTranscriptParseStats().incrementalReads, 0);

    const opts = { dataDir, appDataDir, configDir, projectDir };
    const ctx1 = inspectContext({ conversationId: convId, projectDir }, opts);
    const tel1 = getTelemetryReport({ conversationId: convId }, opts);
    assert.match(ctx1.rev, /^[0-9a-f]{12}$/);
    assert.match(tel1.rev, /^[0-9a-f]{12}$/);
    // Disabled plugin rule MUST NOT appear in active Memory & Rules inventory
    assert.ok(!ctx1.inventories[1].items.some((i) => i.name.includes('HEAVY.md')));

    // Deterministic rev on unchanged second call
    const ctx1Again = inspectContext({ conversationId: convId, projectDir }, opts);
    assert.equal(ctx1Again.rev, ctx1.rev);

    // Append new step -> MUST trigger incremental read (fullReads stays 1!)
    const step2 = {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-25T10:00:04Z',
      content: 'Tool result output payload '.repeat(20),
    };
    const step3 = {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-25T10:00:08Z',
      model: 'gemini-4-neon-high',
      input_tokens: 3000,
      cache_read_tokens: 22000,
      output_tokens: 300,
      content: 'Second reply',
    };
    fs.appendFileSync(tPath, JSON.stringify(step2) + '\n' + JSON.stringify(step3) + '\n', 'utf8');

    const a2 = getTranscriptAnalysis(tPath);
    assert.equal(a2.steps.length, 4);
    assert.equal(getTranscriptParseStats().fullReads, 1, 'Appending must NOT trigger full re-read from byte 0');
    assert.equal(getTranscriptParseStats().incrementalReads, 1, 'Appending must use byte-offset incremental read');
    assert.equal(a2.acc.latestPlanner.stepIndex, 3);
    assert.ok(a2.acc.toolOutputTokens > a1.acc.toolOutputTokens);

    const ctx2 = inspectContext({ conversationId: convId, projectDir }, opts);
    assert.notEqual(ctx2.rev, ctx1.rev, 'rev must change when transcript advances');
    assert.equal(ctx2.usedTokens, 25000);

    // Truncate file -> cleanly resets and performs a full read
    fs.writeFileSync(tPath, JSON.stringify(step0) + '\n', 'utf8');
    const a3 = getTranscriptAnalysis(tPath);
    assert.equal(a3.steps.length, 1);
    assert.equal(getTranscriptParseStats().fullReads, 2);

    // listConversations 2.5s cache returns stable results
    const convs1 = listConversations({ appDataDir });
    const convs2 = listConversations({ appDataDir });
    assert.deepEqual(convs1, convs2);
  } finally {
    closeIndexDb();
    clearTranscriptCache();
    clearContextInspectorCache();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§1.3 getGitContext converges 5 spawns to 1 single git call and hits cache with 0 spawns', () => {
  const root = makeTmpDir('cc-git-1spawn-');
  const repoDir = path.join(root, 'repo');
  const subDir = path.join(repoDir, 'src', 'nested');

  try {
    fs.mkdirSync(subDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/context-cache.git'], {
      cwd: repoDir,
      stdio: 'ignore',
      windowsHide: true,
    });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# hello\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });

    clearGitContextCache();
    resetGitSpawnCount();

    // First call from nested subdirectory -> resolves .git & origin via fs, invokes git EXACTLY ONCE
    const ctx1 = getGitContext(subDir);
    assert.equal(getGitSpawnCount(), 1, `Expected exactly 1 git spawn, got ${getGitSpawnCount()}`);
    assert.equal(ctx1.isGitRepo, true);
    assert.equal(ctx1.branch, 'main');
    assert.equal(ctx1.dirty, false);
    assert.equal(ctx1.remoteOrigin, 'https://github.com/example/context-cache.git');
    assert.match(ctx1.head, /^[0-9a-f]{7}$/);

    // Second call hits cache -> 0 additional spawns
    const ctx2 = getGitContext(subDir);
    assert.equal(getGitSpawnCount(), 1);
    assert.equal(ctx2.projectId, ctx1.projectId);

    // Non-git directory -> 0 git spawns
    const nonGitDir = path.join(root, 'not-a-repo');
    fs.mkdirSync(nonGitDir, { recursive: true });
    const ctxNoGit = getGitContext(nonGitDir);
    assert.equal(getGitSpawnCount(), 1);
    assert.equal(ctxNoGit.isGitRepo, false);
  } finally {
    clearGitContextCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§1.3 Native SQLite incremental decoding (idx > maxIdx), cursors 64-LRU pruning, quota >2000 calls, weighted TPS & 0 middots', () => {
  const root = makeTmpDir('cc-perf-misc-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'app');

  try {
    clearNativeStepMetricsCache();
    clearTelemetryCache();

    // 1. Native step metrics incremental decoding when new rows arrive
    const convId = 'conv-native-inc';
    const convDbDir = path.join(appDataDir, 'conversations');
    fs.mkdirSync(convDbDir, { recursive: true });
    const dbPath = path.join(convDbDir, `${convId}.db`);
    const baseMs = Date.parse('2026-11-25T11:00:00.000Z');

    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);');
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(
      1,
      buildNativeStepBlob({
        createdAtMs: baseMs,
        firstTokenAtMs: baseMs + 500,
        completedAtMs: baseMs + 2500,
        thinkingTokens: 100,
        contentTokens: 200,
      })
    );
    db.close();

    const m1 = loadNativeStepMetrics(convId, { appDataDir });
    assert.equal(m1.size, 1);
    assert.equal(m1.get(1).ttftMs, 500);

    // Append step 2 to native DB -> incremental query fetches idx > 1 and merges cleanly
    const db2 = new DatabaseSync(dbPath);
    db2.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(
      2,
      buildNativeStepBlob({
        createdAtMs: baseMs + 5000,
        firstTokenAtMs: baseMs + 5400,
        completedAtMs: baseMs + 8400,
        thinkingTokens: 150,
        contentTokens: 350,
      })
    );
    db2.close();

    const m2 = loadNativeStepMetrics(convId, { appDataDir });
    assert.equal(m2.size, 2);
    assert.equal(m2.get(1).ttftMs, 500);
    assert.equal(m2.get(2).ttftMs, 400);
    assert.equal(m2.get(2).thinkingTokens, 150);

    // 2. cursors.json 64-session LRU pruning
    const paths = getDataPaths({ dataDir });
    fs.mkdirSync(paths.telemetryDir, { recursive: true });
    const seedCursors = {};
    for (let i = 0; i < 70; i++) {
      seedCursors[`old-conv-${i}`] = {
        size: 10,
        offset: 10,
        updatedAt: new Date(baseMs - (100 - i) * 1000).toISOString(),
        subagents: [],
      };
    }
    fs.writeFileSync(paths.cursorsFile, JSON.stringify(seedCursors), 'utf8');

    const freshConv = 'fresh-conv-lru';
    const tDir = path.join(appDataDir, 'brain', freshConv, '.system_generated', 'logs');
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(
      path.join(tDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(baseMs).toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 120,
        content: 'ok',
      }) + '\n',
      'utf8'
    );
    syncConversationTelemetry({ conversationId: freshConv }, { dataDir, appDataDir });
    const prunedCursors = JSON.parse(fs.readFileSync(paths.cursorsFile, 'utf8'));
    assert.equal(Object.keys(prunedCursors).length, 64, 'cursors.json must prune to 64 newest sessions');
    assert.ok(freshConv in prunedCursors);
    assert.ok(!('old-conv-0' in prunedCursors), 'Oldest cursor entry should be evicted');

    // 3. quota.mjs removes 2000-row hard truncation (inserts 2050 calls and verifies all 2050 counted)
    const nowMs = baseMs + 10_000;
    withIndexDb({ dataDir }, (idxDb) => {
      idxDb.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < 2050; i++) {
        upsertCallRow(idxDb, {
          callUid: `qbulk:${i}`,
          conversationId: 'qbulk',
          rootConversationId: 'qbulk',
          agentType: 'main',
          agentTag: '主',
          stepIndex: i,
          model: 'gemini-4-neon-high',
          createdAt: new Date(nowMs - i * 1000).toISOString(),
          tsMs: nowMs - i * 1000,
          durationMs: 1000,
          timingSource: 'hook_ms',
          inputTokens: 100,
          cacheReadTokens: 0,
          outputTokens: 10,
          contextTokens: 100,
          thinkingTokensEst: 0,
          contentTokensEst: 10,
          effectiveTps: 10,
          cacheHitRate: 0,
          estimatedCostUsd: 0.0001,
          quotaGroup: 'gemini',
        });
      }
      idxDb.exec('COMMIT');
    });
    const qSnap = getQuotaSnapshot({ nowMs }, { dataDir });
    const gemGroup = qSnap.groups.find((g) => g.id === 'gemini');
    assert.ok(gemGroup.localCalls7d >= 2050, `Expected >= 2050 calls without 2000 cap, got ${gemGroup.localCalls7d}`);

    // 4. calcWeightedAvgTps & formatUserMarkdownBanner without middot
    const weighted = calcWeightedAvgTps([
      { timingSource: 'hook_ms', outputTokens: 1000, durationMs: 10_000, effectiveTps: 100 },
      { timingSource: 'estimated', outputTokens: 10, durationMs: 10_000, effectiveTps: 1 },
    ]);
    assert.equal(weighted, 100);
    const banner = formatUserMarkdownBanner({
      effectiveTps: 80,
      timingSource: 'hook_ms',
      cacheHitRate: 92,
      cacheReadTokens: 9200,
      contextTokens: 10000,
      inputTokens: 800,
      outputTokens: 200,
      estimatedCostUsd: 0.01,
      cacheDrop: true,
      dropReason: 'idle_ttl_expired',
    });
    assert.ok(!banner.includes('\u00b7'), 'Banner must not contain middot');
    assert.ok(banner.includes(' | '));

    // 5. Verify 0 middot (\u00b7) across all backend src/core & src/adapters files
    const checkDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) checkDir(full);
        else if (e.name.endsWith('.mjs')) {
          const text = fs.readFileSync(full, 'utf8');
          assert.equal(text.includes('\u00b7'), false, `${full} must not contain middot \\u00b7`);
        }
      }
    };
    checkDir(path.resolve('src', 'core'));
    checkDir(path.resolve('src', 'adapters'));
  } finally {
    closeIndexDb();
    clearNativeStepMetricsCache();
    clearTelemetryCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
