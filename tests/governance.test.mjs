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
  setPluginPinned,
  setItemCategory,
  listBuiltinProfiles,
  listProfiles,
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

    // Built-in presets resolve dynamically, preview diff accurately, and protect context-cache
    const ovWithBuiltins = handleGovernanceAction({ action: 'overview', projectDir: env.workspaceDir }, env.options);
    assert.ok(Array.isArray(ovWithBuiltins.builtinProfiles) && ovWithBuiltins.builtinProfiles.length >= 4);
    const minDiff = previewProfileDiff('builtin:minimal-chat', env.options);
    assert.equal(minDiff.profile.builtin, true);
    assert.equal(minDiff.profile.plugins['context-cache'], true, 'builtin minimal-chat must keep protected context-cache enabled');

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

test('Multi-signal classification, user pinning, category overrides, and interactive diff overrides + saveAsName', () => {
  const env = makeTempEnv();
  try {
    const configDir = env.options.configDir;
    // Add 3 third-party plugins with opaque names to verify content-based classification
    // 1) corp-helper: opaque name, but SKILL.md describes email & docs -> office
    fs.mkdirSync(path.join(configDir, 'plugins', 'corp-helper', 'skills', 'mail-bot'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'plugins', 'corp-helper', 'plugin.json'),
      JSON.stringify({ name: 'corp-helper', displayName: '企业助手', version: '1.0.0' })
    );
    fs.writeFileSync(
      path.join(configDir, 'plugins', 'corp-helper', 'skills', 'mail-bot', 'SKILL.md'),
      '---\nname: mail-bot\ndescription: 自动整理飞书文档、邮件与会议日程安排。\n---\n# Mail Bot\n'
    );

    // 2) team-kit: opaque name, but SKILL.md describes debugging & refactoring -> coding
    fs.mkdirSync(path.join(configDir, 'plugins', 'team-kit', 'skills', 'code-check'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'plugins', 'team-kit', 'plugin.json'),
      JSON.stringify({ name: 'team-kit', displayName: '研发套件', version: '1.0.0' })
    );
    fs.writeFileSync(
      path.join(configDir, 'plugins', 'team-kit', 'skills', 'code-check', 'SKILL.md'),
      '---\nname: code-check\ndescription: 前端代码重构、单元测试与调试工具链。\n---\n# Code Check\n'
    );

    // 3) mystery-box: no clear signals -> general (uncertain)
    fs.mkdirSync(path.join(configDir, 'plugins', 'mystery-box'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'plugins', 'mystery-box', 'plugin.json'),
      JSON.stringify({ name: 'mystery-box', displayName: 'Mystery Box', version: '1.0.0', description: 'Misc utilities' })
    );

    const eco = scanEcosystem({ projectDir: env.options.projectDir }, env.options);
    const corp = eco.plugins.find((p) => p.id === 'corp-helper');
    const team = eco.plugins.find((p) => p.id === 'team-kit');
    const mystery = eco.plugins.find((p) => p.id === 'mystery-box');
    const globalSql = eco.mcpServers.find((m) => m.scope === 'global' && m.name === 'local-sqlite');

    assert.equal(corp.classification.category, 'office');
    assert.equal(corp.classification.source, 'inferred');
    assert.equal(team.classification.category, 'coding');
    assert.equal(mystery.classification.category, 'general');
    assert.equal(mystery.classification.uncertain, true);
    assert.equal(globalSql.classification.category, 'coding');

    // Coding-focus should disable office plugin, keep coding plugin, and leave general plugin unchanged (in unchangedUncertain)
    const codingDiff = previewProfileDiff('builtin:coding-focus', env.options);
    assert.ok(codingDiff.pluginChanges.some((c) => c.id === 'corp-helper' && c.to === false));
    assert.ok(!codingDiff.pluginChanges.some((c) => c.id === 'mystery-box'));
    assert.ok(codingDiff.unchangedUncertain.some((u) => u.kind === 'plugin' && u.id === 'mystery-box'));
    assert.equal(typeof codingDiff.estimatedTokenBreakdown.rules, 'number');
    assert.equal(typeof codingDiff.estimatedTokenBreakdown.skills, 'number');

    // Pin team-kit as user core plugin -> minimal-chat must keep both context-cache and team-kit enabled
    const pinRes = setPluginPinned('team-kit', true, env.options);
    assert.equal(pinRes.ok, true);
    const builtinsAfterPin = listBuiltinProfiles(null, env.options);
    const minimal = builtinsAfterPin.find((b) => b.id === 'builtin:minimal-chat');
    assert.equal(minimal.plugins['context-cache'], true);
    assert.equal(minimal.plugins['team-kit'], true);
    assert.equal(minimal.plugins['corp-helper'], false);

    // System protected plugin cannot be unpinned
    assert.throws(() => setPluginPinned('context-cache', false, env.options), /系统保护/);

    // Manual category override supersedes inferred category
    setItemCategory('plugin:mystery-box', 'office', env.options);
    const ecoAfterOverride = scanEcosystem({ projectDir: env.options.projectDir }, env.options);
    const mysteryAfter = ecoAfterOverride.plugins.find((p) => p.id === 'mystery-box');
    assert.equal(mysteryAfter.classification.category, 'office');
    assert.equal(mysteryAfter.classification.source, 'user');

    // Apply with overrides (keep corp-helper enabled despite coding-focus wanting it off) + saveAsName
    const applyRes = handleGovernanceAction(
      {
        action: 'apply_profile',
        profileId: 'builtin:coding-focus',
        overrides: { plugins: { 'corp-helper': true, 'mystery-box': false } },
        saveAsName: '我的开发特调',
        projectDir: env.options.projectDir,
      },
      env.options
    );
    assert.equal(applyRes.result.ok, true);
    assert.ok(applyRes.result.savedProfile);
    assert.equal(applyRes.result.savedProfile.name, '我的开发特调');

    const cfgAfter = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.equal(cfgAfter.plugins['mystery-box'].enabled, false);
    assert.notEqual(cfgAfter.plugins['corp-helper']?.enabled, false);

    const savedList = listProfiles(env.options);
    assert.ok(savedList.some((p) => p.name === '我的开发特调'));
  } finally {
    env.cleanup();
  }
});
