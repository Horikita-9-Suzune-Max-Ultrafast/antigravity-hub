import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deployPlugin } from '../scripts/deploy.mjs';
import { runDoctorCli } from '../scripts/doctor.mjs';
import { saveMemory } from '../src/core/vault.mjs';
import { getDataPaths } from '../src/core/paths.mjs';
import { recordHookFailure } from '../src/adapters/antigravity/circuit-breaker.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Deploy handles Windows path with spaces, produces zero node_modules, valid hooks/mcp_config, and doctor --repair self-heals', async () => {
  const root = makeTmpDir('cc-deploy-');
  const spacedUserDir = path.join(root, 'User With Spaces');
  const pluginDir = path.join(spacedUserDir, '.gemini', 'config', 'plugins', 'context-cache');
  const dataDir = path.join(spacedUserDir, '.context-cache');

  try {
    // 1. Deploy into path with spaces
    const deployed = await deployPlugin({ targetDir: pluginDir });
    assert.equal(deployed.zeroNodeModules, true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(pluginDir, 'dist', 'dashboard.html')), true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'skills', 'context-cache', 'SKILL.md')), true);

    // 2. Verify mcp_config.json rendered exact path with spaces & server executes cleanly
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
    const srv = mcpCfg.mcpServers['context-cache-server'];
    assert.equal(srv.command, 'node');
    assert.equal(srv.args[0], '--no-warnings');
    assert.equal(path.resolve(srv.args[1]), path.join(pluginDir, 'src', 'mcp', 'server.mjs'));
    assert.equal(fs.existsSync(srv.args[1]), true);

    // 3. Verify hooks.json uses relative paths (safe under spaced cwd) and has NO PreToolUse
    const hooksCfg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
    const hookSpec = hooksCfg['context-cache'];
    assert.equal(hookSpec.PreToolUse, undefined);
    assert.ok(Array.isArray(hookSpec.SessionStart));
    assert.ok(Array.isArray(hookSpec.PreInvocation));
    assert.ok(Array.isArray(hookSpec.PostInvocation));
    assert.ok(Array.isArray(hookSpec.Stop));

    // Execute deployed hook from spaced pluginDir cwd
    const hookExec = spawnSync(
      process.execPath,
      ['--no-warnings', './src/adapters/antigravity/hook.mjs', '--event', 'PreInvocation'],
      {
        cwd: pluginDir,
        input: JSON.stringify({ conversationId: 'spaced-test-conv', invocationNum: 1 }),
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, CONTEXT_CACHE_DATA_DIR: dataDir },
      }
    );
    assert.equal(hookExec.status, 0);
    assert.deepEqual(JSON.parse(hookExec.stdout.trim()), {});

    // 4. Simulate corruption: save memory, delete SQLite DB, trip circuit breaker, delete a deployed file
    saveMemory(
      { projectDir: root, kind: 'decision', title: 'Spaced path safe', summary: 'Relative hooks work everywhere.' },
      { dataDir }
    );
    const { dbFile } = getDataPaths({ dataDir });
    for (const sfx of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbFile + sfx)) fs.unlinkSync(dbFile + sfx);
    }
    recordHookFailure('err1', { dataDir });
    recordHookFailure('err2', { dataDir });
    recordHookFailure('err3', { dataDir });
    fs.unlinkSync(path.join(pluginDir, 'dist', 'dashboard.html'));

    const broken = await runDoctorCli({ dataDir, pluginDir, repair: false });
    assert.equal(broken.report.healthy, false);
    assert.equal(broken.report.circuit.state, 'OPEN');
    assert.ok(broken.report.deployment.missingFiles.includes('dist/dashboard.html'));

    // 5. Run doctor --repair -> restores deployed file, rebuilds SQLite index, resets circuit breaker
    const fixed = await runDoctorCli({ dataDir, pluginDir, repair: true });
    assert.equal(fixed.report.healthy, true);
    assert.equal(fixed.report.circuit.state, 'CLOSED');
    assert.equal(fixed.report.index.dbMemories, 1);
    assert.equal(fixed.report.deployment.zeroNodeModules, true);
    assert.equal(fixed.report.deployment.missingFiles.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
