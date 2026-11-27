import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectContext, previewContextAsset } from '../src/core/context-inspector.mjs';
import { getModelLimit, saveConfig } from '../src/core/config.mjs';
import { saveMemory } from '../src/core/vault.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Context Inspector aligns usedTokens with transcript, scans MCP deferred/eager, rules, skills, agents, and flags bloat', () => {
  const root = makeTmpDir('cc-inspector-');
  const dataDir = path.join(root, 'data');
  const appDataDir = path.join(root, 'antigravity');
  const configDir = path.join(root, 'config');
  const workspaceDir = path.join(root, 'workspace');

  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace Rules\nKeep modules clean and tested.\n'.repeat(20));

    // Create MCP deferred schemas (one heavy server >= 15K tokens)
    const heavyMcpDir = path.join(appDataDir, 'mcp', 'heavy-playwright');
    fs.mkdirSync(heavyMcpDir, { recursive: true });
    const bigSchema = JSON.stringify({ name: 'tool', description: 'Detailed schema documentation '.repeat(350) });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(heavyMcpDir, `tool_${i}.json`), bigSchema);
    }

    // Create plugin eager mcp_config + rules + skill + custom agent
    const pluginDir = path.join(configDir, 'plugins', 'context-cache');
    fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'skills', 'demo-skill'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'context-cache-server': { command: 'node', args: [] } } }));
    fs.writeFileSync(path.join(pluginDir, 'rules', 'AGENTS.md'), '# Slim rule\nUse ctx_open_monitor.\n');
    const skillPath = path.join(pluginDir, 'skills', 'demo-skill', 'SKILL.md');
    fs.writeFileSync(skillPath, '# Demo Skill\n' + 'Instructions for demo skill. '.repeat(120));
    fs.writeFileSync(path.join(pluginDir, 'agents', 'reviewer.md'), '# Reviewer\nReviews code carefully.\n');

    // Save a memory so SessionStart Compact Brief is counted
    saveMemory(
      { projectDir: workspaceDir, kind: 'decision', title: 'Zero runtime deps', summary: 'Use native Node 24 APIs.' },
      { dataDir }
    );

    // Create transcript with >75% context usage on a 200K model and a read_file call loading SKILL.md
    const convId = '11111111-1111-4111-8111-111111111111';
    const logDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, 'transcript.jsonl');
    const lines = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-22T01:00:00Z',
        content: 'Analyze context breakdown and bloat attribution',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-22T01:00:05Z',
        model: 'claude-4-sonnet',
        input_tokens: 18000,
        cache_read_tokens: 142000,
        output_tokens: 420,
        thinking: 'Checking skill file first.',
        content: 'Reading skill documentation.',
        tool_calls: [{ name: 'read_file', args: { Path: skillPath } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-11-22T01:00:06Z',
        content: 'Tool output line '.repeat(400),
      },
    ];
    fs.writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = inspectContext(
      { conversationId: convId, projectDir: workspaceDir },
      { dataDir, appDataDir, configDir }
    );

    assert.equal(result.conversationId, convId);
    assert.equal(result.model, 'claude-4-sonnet');
    assert.equal(result.limitTokens, 200000);
    assert.equal(result.usedTokens, 160000);
    assert.equal(result.freeTokens, 40000);
    assert.equal(result.usedPercent, 80.0);

    // Breakdown sum equals exact usedTokens
    const sumBreakdown = result.breakdown.reduce((s, b) => s + b.tokens, 0);
    assert.equal(sumBreakdown, result.usedTokens);

    // Deferred MCP scan discovered heavy-playwright with 12 tools >= 15K tokens
    assert.equal(result.deferred[0].count, '12 tools');
    assert.ok(result.deferred[0].tokens >= 15000);

    // Inventories contain MCP, Rules, Skills/Agents with enriched v1.5.4 metadata
    assert.equal(result.inventories.length, 3);
    const heavyItem = result.inventories[0].items.find((i) => i.name === 'heavy-playwright');
    assert.ok(heavyItem);
    assert.equal(heavyItem.kind, 'mcp_server');
    assert.equal(heavyItem.sourceLayer, 'global');
    assert.equal(heavyItem.filePath, heavyMcpDir);
    assert.equal(heavyItem.tools.length, 12);
    assert.equal(heavyItem.tools[0].deferred, true);
    assert.ok(heavyItem.tools[0].tokens > 0);

    const ownServer = result.inventories[0].items.find((i) => i.name === 'context-cache-server');
    assert.ok(ownServer);
    assert.equal(ownServer.sourceLayer, 'plugin');
    assert.equal(ownServer.tools.length, 5);
    assert.equal(ownServer.tools[0].deferred, false);

    const wsRule = result.inventories[1].items.find((i) => i.name.endsWith('AGENTS.md') && i.sourceLayer === 'workspace');
    assert.ok(wsRule);
    assert.equal(wsRule.kind, 'rule');
    assert.equal(wsRule.filePath, path.join(workspaceDir, 'AGENTS.md'));
    assert.ok(wsRule.tokens > 0 && wsRule.bytes > 0);

    const briefItem = result.inventories[1].items.find((i) => i.name === 'SessionStart Compact Brief');
    assert.ok(briefItem);
    assert.equal(briefItem.kind, 'brief');
    assert.equal(briefItem.sourceLayer, 'vault');
    assert.ok(briefItem.previewText && briefItem.previewText.includes('[CTX-BRIEF]'));

    const demoSkill = result.inventories[2].items.find((i) => i.name === 'demo-skill');
    assert.ok(demoSkill);
    assert.equal(demoSkill.kind, 'skill');
    assert.equal(demoSkill.sourceLayer, 'plugin');
    assert.equal(demoSkill.filePath, skillPath);

    const reviewerAgent = result.inventories[2].items.find((i) => i.name === 'reviewer');
    assert.ok(reviewerAgent);
    assert.equal(reviewerAgent.kind, 'agent');
    assert.equal(reviewerAgent.sourceLayer, 'plugin');
    assert.equal(reviewerAgent.filePath, path.join(pluginDir, 'agents', 'reviewer.md'));

    // Bloat attribution flags >75% and heavy MCP server
    assert.match(result.attribution, /80%/);
    assert.match(result.attribution, /heavy-playwright/);
    assert.ok(result.alerts.some((a) => a.code === 'context_high'));

    // Gemini models default to Antigravity's 512K effective ceiling (never 200K fallback)
    assert.equal(getModelLimit('gemini-4-hydrogen-medium'), 512000);
    assert.equal(getModelLimit('gemini-4-carbon-medium'), 512000);
    assert.equal(getModelLimit('gemini-future-codename'), 512000);

    // Custom user-configured limit is respected even when usedTokens exceeds it (never silently overwritten to 1M)
    saveConfig({ modelLimits: { 'claude-4': 128000 } }, { dataDir });
    const customRes = inspectContext(
      { conversationId: convId, projectDir: workspaceDir },
      { dataDir, appDataDir, configDir }
    );
    assert.equal(customRes.limitTokens, 128000);
    assert.equal(customRes.freeTokens, 0);
    assert.equal(customRes.usedPercent, 125.0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previewContextAsset enforces authorized path boundaries, blocks secret files, and redacts inline tokens', () => {
  const root = makeTmpDir('cc-preview-');
  const appDataDir = path.join(root, 'antigravity');
  const configDir = path.join(root, 'config');
  const workspaceDir = path.join(root, 'workspace');
  const outsideFile = path.join(root, 'outside-secret.md');

  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.mkdirSync(path.join(configDir, 'rules'), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const ruleFile = path.join(configDir, 'rules', 'AGENTS.md');
    fs.writeFileSync(
      ruleFile,
      '# Rule\nNever expose sk-proj-1234567890abcdefghijklmnop or Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh12345678\n'
    );
    const envFile = path.join(workspaceDir, '.env');
    fs.writeFileSync(envFile, 'API_KEY=sk-proj-secret1234567890abcdef\n');
    fs.writeFileSync(outsideFile, 'Outside content should never be readable');

    const opts = { appDataDir, configDir, projectDir: workspaceDir };

    // Authorized rule file -> readable and redacted
    const preview = previewContextAsset({ filePath: ruleFile, projectDir: workspaceDir }, opts);
    assert.equal(preview.redacted, true);
    assert.equal(preview.kind, 'rule');
    assert.equal(preview.sourceLayer, 'global');
    assert.ok(!preview.content.includes('sk-proj-1234567890abcdefghijklmnop'));
    assert.ok(!preview.content.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.match(preview.content, /\[REDACTED/);

    // Out-of-bounds file -> rejected
    assert.throws(() => previewContextAsset({ filePath: outsideFile, projectDir: workspaceDir }, opts), /拒绝读取/);

    // .env inside workspace -> blocked
    assert.throws(() => previewContextAsset({ filePath: envFile, projectDir: workspaceDir }, opts), /敏感凭据/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
