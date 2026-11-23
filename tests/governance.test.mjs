import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scanEcosystem,
  runGovernanceLint,
  togglePluginEnabled,
  toggleGlobalMcpServer,
  saveProfile,
  previewProfileDiff,
  applyProfile,
  listSnapshots,
  previewRollback,
  rollbackSnapshot,
  previewGovernanceFile,
  handleGovernanceAction,
} from '../src/core/governance/index.mjs';
import { evaluateAlerts } from '../src/core/telemetry.mjs';
import { loadConfig } from '../src/core/config.mjs';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhub-gov-test-'));
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'gemini-config');
  const appDataDir = path.join(root, 'gemini-app');
  const projectDir = path.join(root, 'workspace');

  fs.mkdirSync(path.join(configDir, 'plugins', 'context-cache'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'plugins', 'demo-plugin', 'skills', 'dup-skill'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'plugins', 'demo-plugin', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.agents', 'skills', 'dup-skill'), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, 'mcp', 'demo-plugin_srv'), { recursive: true });

  // Host config.json with extra keys that MUST be preserved intact
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        plugins: {
          'demo-plugin': { installedFrom: { id: 'official/demo', version: '1.0.0' } },
        },
        sidecars: { keepMe: true },
        userSettings: { theme: 'dark' },
      },
      null,
      2
    )
  );

  // Global mcp_config.json with one active server
  fs.writeFileSync(
    path.join(configDir, 'mcp_config.json'),
    JSON.stringify(
      {
        mcpServers: {
          'local-sqlite': {
            command: 'node',
            args: ['/nonexistent/broken-server.mjs'],
          },
        },
      },
      null,
      2
    )
  );

  // Plugin manifests
  fs.writeFileSync(
    path.join(configDir, 'plugins', 'context-cache', 'plugin.json'),
    JSON.stringify({ name: 'context-cache', displayName: 'Antigravity Hub', version: '1.4.0' })
  );
  fs.writeFileSync(
    path.join(configDir, 'plugins', 'demo-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo-plugin', displayName: 'Demo Plugin', version: '1.0.0' })
  );
  fs.writeFileSync(
    path.join(configDir, 'plugins', 'demo-plugin', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['index.mjs'] } } })
  );

  // Duplicate skill (workspace overrides plugin) + broken link in plugin skill
  fs.writeFileSync(
    path.join(projectDir, '.agents', 'skills', 'dup-skill', 'SKILL.md'),
    '---\nname: dup-skill\ndescription: Workspace override skill for testing priority.\n---\n# Workspace Skill\n'
  );
  fs.writeFileSync(
    path.join(configDir, 'plugins', 'demo-plugin', 'skills', 'dup-skill', 'SKILL.md'),
    '---\nname: dup-skill\ndescription: Plugin shadowed skill.\n---\nSee [missing](references/missing.md)\n'
  );

  // Rule with a fake secret to verify Secret Auditor (#10) redacts and flags it
  const fakeKey = `sk-test-${'A'.repeat(24)}`;
  fs.writeFileSync(
    path.join(configDir, 'plugins', 'demo-plugin', 'rules', 'AGENTS.md'),
    `# Demo Rule\nAPI_KEY=${fakeKey}\n`
  );

  return {
    root,
    options: { dataDir, configDir, appDataDir, projectDir },
    fakeKey,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Effective Harness scan (#1) + three-in-one offline linter (#8, #9, #10)', () => {
  const env = makeTempEnv();
  try {
    const eco = scanEcosystem({ projectDir: env.options.projectDir }, env.options);
    assert.equal(eco.plugins.length, 2);
    assert.equal(eco.summary.skillsShadowed, 1);

    const pluginSkill = eco.skills.find((s) => s.scope === 'plugin' && s.name === 'dup-skill');
    assert.ok(pluginSkill.shadowedBy, 'plugin skill should be shadowed by workspace skill');

    const lint = runGovernanceLint(eco, env.options);
    assert.ok(lint.findings.some((f) => f.code === 'MCP_BROKEN_TARGET'), 'should flag broken MCP script target');
    assert.ok(lint.findings.some((f) => f.code === 'SKILL_SHADOWED'), 'should flag shadowed skill');
    assert.ok(lint.findings.some((f) => f.code === 'SKILL_BROKEN_LINK'), 'should flag broken skill link');

    const secretFinding = lint.findings.find((f) => f.category === 'secret');
    assert.ok(secretFinding, 'should detect plaintext secret in rule');
    assert.ok(!secretFinding.message.includes(env.fakeKey), 'secret finding must be redacted and never leak raw key');

    // File preview must also redact secrets and reject out-of-bounds paths
    const ruleFile = path.join(env.options.configDir, 'plugins', 'demo-plugin', 'rules', 'AGENTS.md');
    const preview = previewGovernanceFile(ruleFile, env.options.projectDir, env.options);
    assert.ok(!preview.content.includes(env.fakeKey), 'preview must redact raw secret');
    assert.throws(() => previewGovernanceFile(path.join(os.tmpdir(), 'outside.txt'), env.options.projectDir, env.options));
  } finally {
    env.cleanup();
  }
});

test('Five-layer guardrails: self-protection, atomic toggle, MCP staging, profiles & rollback', () => {
  const env = makeTempEnv();
  try {
    // 1. Self-protection: disabling context-cache MUST fail
    assert.throws(() => togglePluginEnabled('context-cache', false, env.options), /受保护/);

    // 2. Toggle demo-plugin off and verify unrelated config.json keys remain intact
    const res1 = togglePluginEnabled('demo-plugin', false, env.options);
    assert.equal(res1.ok, true);
    assert.ok(res1.snapshotId);

    const cfgAfter = JSON.parse(fs.readFileSync(path.join(env.options.configDir, 'config.json'), 'utf8'));
    assert.equal(cfgAfter.plugins['demo-plugin'].enabled, false);
    assert.equal(cfgAfter.plugins['demo-plugin'].installedFrom.version, '1.0.0');
    assert.deepEqual(cfgAfter.sidecars, { keepMe: true });
    assert.deepEqual(cfgAfter.userSettings, { theme: 'dark' });

    // 3. Toggle global MCP off -> moved to disabled-mcp.json without dirty fields in mcp_config.json
    const res2 = toggleGlobalMcpServer('local-sqlite', false, env.options);
    assert.equal(res2.ok, true);
    const mcpAfterDisable = JSON.parse(fs.readFileSync(path.join(env.options.configDir, 'mcp_config.json'), 'utf8'));
    assert.equal('local-sqlite' in mcpAfterDisable.mcpServers, false);

    // Save current (minimal) state as a profile
    const savedProf = saveProfile({ name: 'Lite Mode', description: 'Minimal' }, env.options);
    assert.equal(savedProf.plugins['context-cache'], true);
    assert.equal(savedProf.plugins['demo-plugin'], false);

    // Restore global MCP and demo-plugin
    toggleGlobalMcpServer('local-sqlite', true, env.options);
    togglePluginEnabled('demo-plugin', true, env.options);

    // Preview & apply profile
    const diff = previewProfileDiff(savedProf.id, env.options);
    assert.equal(diff.totalChanges, 2);
    const applied = applyProfile(savedProf.id, env.options);
    assert.equal(applied.ok, true);
    assert.equal(applied.changed, 2);

    // Rollback to baseline snapshot restores original config.json
    const snaps = listSnapshots(env.options);
    const baseline = snaps.find((s) => s.baseline);
    assert.ok(baseline, 'baseline snapshot should exist');
    const rbPreview = previewRollback(baseline.id, env.options);
    assert.ok(rbPreview.diffs.length >= 1);

    const rb = rollbackSnapshot(baseline.id, env.options);
    assert.equal(rb.ok, true);
    const cfgRestored = JSON.parse(fs.readFileSync(path.join(env.options.configDir, 'config.json'), 'utf8'));
    assert.equal(cfgRestored.plugins['demo-plugin'].enabled, undefined);
  } finally {
    env.cleanup();
  }
});

test('CLI escape hatch (ctx gov status / snapshots / rollback) & MCP action dispatcher', () => {
  const env = makeTempEnv();
  try {
    togglePluginEnabled('demo-plugin', false, env.options);
    const cliPath = path.resolve('bin', 'ctx.mjs');
    const outStatus = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        cliPath,
        'gov',
        'status',
        '--data-dir',
        env.options.dataDir,
        '--config-dir',
        env.options.configDir,
        '--app-data-dir',
        env.options.appDataDir,
        '--project',
        env.options.projectDir,
        '--json',
      ],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(outStatus);
    assert.equal(parsed.ecosystem.plugins.length, 2);

    const outRollback = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        cliPath,
        'gov',
        'rollback',
        '--data-dir',
        env.options.dataDir,
        '--config-dir',
        env.options.configDir,
        '--json',
      ],
      { encoding: 'utf8' }
    );
    const rb = JSON.parse(outRollback);
    assert.equal(rb.ok, true);

    const ov = handleGovernanceAction({ action: 'overview', projectDir: env.options.projectDir }, env.options);
    assert.ok(ov.ecosystem && ov.lint);
  } finally {
    env.cleanup();
  }
});

test('Telemetry read-only cache hygiene checks: long-context media drop & micro-step streak', () => {
  const cfg = loadConfig();
  const calls = [
    {
      agentType: 'main',
      agentTag: '主',
      stepIndex: 10,
      model: 'gemini-4',
      contextTokens: 165000,
      outputTokens: 120,
      effectiveTps: 40,
      cacheHitRate: 12,
      cacheDrop: true,
      dropReason: 'prefix_mutated_unknown',
      estimatedCostUsd: 0.1,
      toolCallCount: 1,
      hasMedia: true,
    },
    ...Array.from({ length: 5 }, (_, idx) => ({
      agentType: 'main',
      agentTag: '主',
      stepIndex: 9 - idx,
      model: 'gemini-4',
      contextTokens: 155000,
      outputTokens: 100,
      effectiveTps: 45,
      cacheHitRate: 95,
      cacheDrop: false,
      estimatedCostUsd: 0.05,
      toolCallCount: 1,
      hasMedia: false,
    })),
  ];

  const alerts = evaluateAlerts(calls, cfg, 20);
  assert.ok(alerts.some((a) => a.code === 'long_ctx_media_cache_risk'), 'should warn on long-context media cache drop');
  assert.ok(alerts.some((a) => a.code === 'micro_step_streak'), 'should hint on consecutive micro-steps');
});
