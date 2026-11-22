import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectContext } from '../src/core/context-inspector.mjs';
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

    // Inventories contain MCP, Rules, Skills/Agents
    assert.equal(result.inventories.length, 3);
    assert.ok(result.inventories[0].items.some((i) => i.name === 'heavy-playwright'));
    assert.ok(result.inventories[1].items.some((i) => i.name === 'SessionStart Compact Brief'));
    assert.ok(result.inventories[2].items.some((i) => i.name === 'demo-skill'));
    assert.ok(result.inventories[2].items.some((i) => i.name === 'reviewer'));

    // Bloat attribution flags >75% and heavy MCP server
    assert.match(result.attribution, /80%/);
    assert.match(result.attribution, /heavy-playwright/);
    assert.ok(result.alerts.some((a) => a.code === 'context_high'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
