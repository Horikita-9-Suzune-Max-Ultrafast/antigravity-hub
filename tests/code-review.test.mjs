import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  collectGitDiff,
  validateBaseRef,
  runStaticReviewRules,
  detectProjectGates,
  runProjectGate,
  buildSubagentReviewPrompt,
  buildFixPrompt,
  parseLooseReviewJson,
  handleReviewAction,
  loadLatestReport,
  loadHistory,
  loadIgnores,
  saveReviewReport,
  MAX_REVIEW_HISTORY,
} from '../src/core/review/index.mjs';
import { APP_REVIEW_TOOL_DEF, dispatchReviewTool } from '../src/mcp/handlers/review.mjs';
import { saveMemory } from '../src/core/vault.mjs';
import { clearGitContextCache } from '../src/core/git-context.mjs';

function makeTempDir(prefix = 'ctx-review-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitSync(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initTempGitRepo(dir, { initialBranch = 'main' } = {}) {
  gitSync(['init', '-b', initialBranch], dir);
  gitSync(['config', 'user.name', 'Test Reviewer'], dir);
  gitSync(['config', 'user.email', 'reviewer@example.test'], dir);
  gitSync(['config', 'core.autocrlf', 'false'], dir);
}

function writeRel(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function listAllRepoFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

test('diff-parser: supports unborn repo and all 4 git scopes with exact new-file line numbers', async () => {
  const repoDir = makeTempDir('review-scopes-');
  try {
    initTempGitRepo(repoDir);
    clearGitContextCache();

    // 1. Unborn repository: 1 staged file + 1 untracked file
    writeRel(repoDir, 'src/init.mjs', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    gitSync(['add', 'src/init.mjs'], repoDir);
    writeRel(repoDir, 'src/untracked.mjs', 'export const x = 10;\nexport const y = 20;\n');

    const unbornDiff = await collectGitDiff({ projectDir: repoDir, scope: 'uncommitted' });
    assert.equal(unbornDiff.isGitRepo, true);
    assert.equal(unbornDiff.files.length, 2);
    const initFile = unbornDiff.files.find((f) => f.path === 'src/init.mjs');
    const untFile = unbornDiff.files.find((f) => f.path === 'src/untracked.mjs');
    assert.ok(initFile && untFile);
    assert.deepEqual(
      initFile.hunks[0].addedLines.map((l) => l.line),
      [1, 2, 3]
    );
    assert.deepEqual(
      untFile.hunks[0].addedLines.map((l) => l.line),
      [1, 2]
    );
    assert.equal(untFile.untracked, true);

    // Commit initial files (test last_commit on initial commit via git show)
    gitSync(['add', '.'], repoDir);
    gitSync(['commit', '-m', 'initial commit'], repoDir);
    clearGitContextCache();

    const firstCommitDiff = await collectGitDiff({ projectDir: repoDir, scope: 'last_commit' });
    assert.equal(firstCommitDiff.files.length, 2);

    // 2. Second commit: test line number shift when deleting early line and adding later lines
    const v1 = [
      'line1',
      'line2_remove_me',
      'line3',
      'line4',
      'line5',
      'line6',
    ].join('\n') + '\n';
    writeRel(repoDir, 'src/lines.mjs', v1);
    gitSync(['add', 'src/lines.mjs'], repoDir);
    gitSync(['commit', '-m', 'add lines.mjs'], repoDir);
    clearGitContextCache();

    const v2 = [
      'line1',
      'line3',
      'line4',
      'inserted_at_line_4',
      'inserted_at_line_5',
      'line5',
      'line6',
    ].join('\n') + '\n';
    writeRel(repoDir, 'src/lines.mjs', v2);
    writeRel(repoDir, 'src/new_untracked.mjs', 'const u1 = 1;\nconst u2 = 2;\n');

    // Scope: uncommitted
    const uncommitted = await collectGitDiff({ projectDir: repoDir, scope: 'uncommitted' });
    const linesFile = uncommitted.files.find((f) => f.path === 'src/lines.mjs');
    assert.ok(linesFile);
    const addedNums = linesFile.hunks.flatMap((h) => h.addedLines);
    assert.deepEqual(addedNums, [
      { line: 4, content: 'inserted_at_line_4' },
      { line: 5, content: 'inserted_at_line_5' },
    ]);
    assert.ok(linesFile.hunks[0].contextPatch.includes('+0004| inserted_at_line_4'));
    assert.ok(uncommitted.files.some((f) => f.path === 'src/new_untracked.mjs'));

    // Scope: staged (stage only src/lines.mjs, modify src/init.mjs unstaged)
    gitSync(['add', 'src/lines.mjs'], repoDir);
    writeRel(repoDir, 'src/init.mjs', 'const a = 999;\nconst b = 2;\nconst c = 3;\n');
    const staged = await collectGitDiff({ projectDir: repoDir, scope: 'staged' });
    assert.equal(staged.files.length, 1);
    assert.equal(staged.files[0].path, 'src/lines.mjs');
    assert.deepEqual(
      staged.files[0].hunks.flatMap((h) => h.addedLines.map((l) => l.line)),
      [4, 5]
    );

    // Commit staged change and verify last_commit (HEAD~1..HEAD)
    gitSync(['commit', '-m', 'shift lines'], repoDir);
    clearGitContextCache();
    const lastCommit = await collectGitDiff({ projectDir: repoDir, scope: 'last_commit' });
    assert.equal(lastCommit.files.length, 1);
    assert.equal(lastCommit.files[0].path, 'src/lines.mjs');
    assert.deepEqual(
      lastCommit.files[0].hunks.flatMap((h) => h.addedLines.map((l) => l.line)),
      [4, 5]
    );

    // Scope: branch (create feature branch off main and commit)
    gitSync(['checkout', '--', 'src/init.mjs'], repoDir);
    fs.unlinkSync(path.join(repoDir, 'src/new_untracked.mjs'));
    gitSync(['checkout', '-b', 'feat/review-test'], repoDir);
    writeRel(repoDir, 'src/feature.mjs', 'const f1 = 1;\nconst f2 = 2;\nconst f3 = 3;\n');
    gitSync(['add', 'src/feature.mjs'], repoDir);
    gitSync(['commit', '-m', 'feature commit'], repoDir);
    clearGitContextCache();

    const branchExplicit = await collectGitDiff({
      projectDir: repoDir,
      scope: 'branch',
      baseRef: 'main',
    });
    assert.equal(branchExplicit.baseRef, 'main');
    assert.equal(branchExplicit.files.length, 1);
    assert.equal(branchExplicit.files[0].path, 'src/feature.mjs');
    assert.deepEqual(
      branchExplicit.files[0].hunks[0].addedLines.map((l) => l.line),
      [1, 2, 3]
    );

    const branchAuto = await collectGitDiff({ projectDir: repoDir, scope: 'branch' });
    assert.equal(branchAuto.baseRef, 'main');
    assert.equal(branchAuto.files.length, 1);
    assert.equal(branchAuto.files[0].path, 'src/feature.mjs');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('diff-parser: folds lockfiles, dist/generated, binary, and >120KiB oversized diffs', async () => {
  const repoDir = makeTempDir('review-noise-');
  try {
    initTempGitRepo(repoDir);
    writeRel(repoDir, 'README.md', '# repo\n');
    gitSync(['add', 'README.md'], repoDir);
    gitSync(['commit', '-m', 'init'], repoDir);
    clearGitContextCache();

    writeRel(repoDir, 'package-lock.json', '{"lockfileVersion": 3}\n');
    writeRel(repoDir, 'dist/dashboard.js', 'console.log("built");\n');
    writeRel(repoDir, 'assets/app.min.js', 'var a=1;\n');
    writeRel(repoDir, 'assets/icon.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    // Oversized staged file (> 120 KiB)
    writeRel(repoDir, 'src/huge.txt', 'a'.repeat(130 * 1024) + '\n');
    writeRel(repoDir, 'src/clean.mjs', 'export const ok = true;\n');
    gitSync(['add', 'package-lock.json', 'dist/dashboard.js', 'assets/app.min.js', 'assets/icon.bin', 'src/huge.txt', 'src/clean.mjs'], repoDir);

    const diff = await collectGitDiff({ projectDir: repoDir, scope: 'staged' });
    assert.deepEqual(
      diff.files.map((f) => f.path),
      ['src/clean.mjs']
    );
    const reasonByPath = new Map(diff.skippedFiles.map((s) => [s.path, s.reason]));
    assert.equal(reasonByPath.get('package-lock.json'), 'lockfile');
    assert.equal(reasonByPath.get('dist/dashboard.js'), 'generated');
    assert.equal(reasonByPath.get('assets/app.min.js'), 'generated');
    assert.equal(reasonByPath.get('assets/icon.bin'), 'binary');
    assert.equal(reasonByPath.get('src/huge.txt'), 'oversized_diff');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('diff-parser: rejects malicious baseRef arguments to prevent git option injection', async () => {
  const repoDir = makeTempDir('review-baseref-');
  try {
    initTempGitRepo(repoDir);
    writeRel(repoDir, 'a.txt', 'hello\n');
    gitSync(['add', '.'], repoDir);
    gitSync(['commit', '-m', 'init'], repoDir);

    const maliciousRefs = [
      '--exec=calc',
      '-p',
      '--upload-pack=evil',
      'main..HEAD',
      'main;rm -rf /',
      'main$(whoami)',
      'HEAD@{0}',
      'main\\evil',
      'a'.repeat(121),
    ];

    for (const bad of maliciousRefs) {
      assert.throws(() => validateBaseRef(bad), /Unsafe baseRef|Invalid baseRef/);
      await assert.rejects(
        () => collectGitDiff({ projectDir: repoDir, scope: 'branch', baseRef: bad }),
        /Unsafe baseRef|Invalid baseRef/
      );
    }

    assert.equal(validateBaseRef('origin/main'), 'origin/main');
    assert.equal(validateBaseRef('release/v1.6.0_rc-1'), 'release/v1.6.0_rc-1');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('static-rules: all 8 rules trigger accurately, ignore unmodified legacy code, redact secrets, and exempt commented catch', async () => {
  const repoDir = makeTempDir('review-rules-');
  const dataDir = makeTempDir('review-rules-data-');
  try {
    initTempGitRepo(repoDir);
    // Commit legacy code packed with issues that MUST NOT trigger when untouched
    const fakeLegacySecret = 'sk-proj-' + 'LegacyOldSecret99999999999999';
    writeRel(
      repoDir,
      'src/legacy.mjs',
      [
        'export function legacy() {',
        `  const oldKey = "${fakeLegacySecret}";`,
        '  eval("1+1");',
        '  debugger;',
        '  try { risky(); } catch (e) {}',
        '  return oldKey;',
        '}',
        '',
        'export function safeHelper() {',
        '  return 1;',
        '}',
      ].join('\n') + '\n'
    );
    gitSync(['add', '.'], repoDir);
    gitSync(['commit', '-m', 'legacy baseline'], repoDir);
    clearGitContextCache();

    // Touch ONLY safeHelper in legacy.mjs -> zero findings on legacy.mjs!
    const updatedLegacy = fs
      .readFileSync(path.join(repoDir, 'src/legacy.mjs'), 'utf8')
      .replace('return 1;', 'return 2;');
    writeRel(repoDir, 'src/legacy.mjs', updatedLegacy);

    const legacyDiff = await collectGitDiff({ projectDir: repoDir, scope: 'uncommitted' });
    const legacyFindings = runStaticReviewRules(legacyDiff);
    assert.equal(legacyFindings.length, 0, `Expected 0 findings on unmodified legacy code, got: ${JSON.stringify(legacyFindings)}`);

    // Now introduce all 8 rule violations in new/modified lines + exemptions
    const rawSecretSk = 'sk-proj-' + 'AbCdEf1234567890GhIjKlMnOpQr';
    const rawSecretUrl = 'https://admin:SuperSecretPass99@db.internal.local/app';

    writeRel(repoDir, '.env.production', 'APP_MODE=prod\n');
    writeRel(
      repoDir,
      'src/bad.mjs',
      [
        `const apiKey = "${rawSecretSk}";`,
        `const exampleKey = "sk-proj-EXAMPLE12345678901234567890";`,
        `const conn = "${rawSecretUrl}";`,
        '<<<<<<< HEAD',
        'const v = eval(userInput);',
        'const fn = new Function("a", "return a");',
        'execFile("cmd", [], { shell: true });',
        'try { doWork(); } catch (err) {}',
        'try { doSafe(); } catch (err) { /* fail-open */ }',
        'debugger;',
        'console.log("ok in backend/cli");',
      ].join('\n') + '\n'
    );
    writeRel(repoDir, 'src/script.py', 'def f():\n    breakpoint()\n');
    writeRel(repoDir, 'src/ui/panel.mjs', 'export function render() {\n  console.log("debug");\n}\n');
    writeRel(
      repoDir,
      'src/ui/build-ui.mjs',
      'export function verify(js) {\n  new Function(js); // syntax check\n}\n'
    );
    // Large new file (> 900 lines)
    writeRel(repoDir, 'src/giant.mjs', Array.from({ length: 920 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');

    const beforeFiles = listAllRepoFiles(repoDir);
    const res = await handleReviewAction({ action: 'scan', projectDir: repoDir, scope: 'uncommitted' }, { dataDir });
    const afterFiles = listAllRepoFiles(repoDir);
    // Ensure zero temporary files written to target repo
    assert.deepEqual(afterFiles, beforeFiles);

    const findings = res.report.findings;
    const rulesHit = new Set(findings.map((f) => f.ruleId));

    for (const expectedRule of [
      'REV_SECRET_FILE',
      'REV_HARDCODED_SECRET',
      'REV_MERGE_CONFLICT',
      'REV_DANGEROUS_EXEC',
      'REV_EMPTY_CATCH',
      'REV_DEBUGGER_STMT',
      'REV_CONSOLE_DEBUG',
      'REV_LARGE_NEW_FILE',
    ]) {
      assert.ok(rulesHit.has(expectedRule), `Expected rule ${expectedRule} to trigger; got: ${[...rulesHit].join(', ')}`);
    }

    // Verify exemptions
    assert.equal(
      findings.some((f) => f.file === 'src/bad.mjs' && f.ruleId === 'REV_HARDCODED_SECRET' && f.line === 2),
      false,
      'EXAMPLE secret line must be exempted'
    );
    assert.equal(
      findings.some((f) => f.file === 'src/bad.mjs' && f.ruleId === 'REV_EMPTY_CATCH' && f.line === 9),
      false,
      'Commented /* fail-open */ catch must NOT be flagged'
    );
    assert.equal(
      findings.some((f) => f.file === 'src/bad.mjs' && f.ruleId === 'REV_CONSOLE_DEBUG'),
      false,
      'Non-UI console.log must NOT trigger REV_CONSOLE_DEBUG'
    );
    assert.equal(
      findings.some((f) => f.file === 'src/ui/build-ui.mjs' && f.ruleId === 'REV_DANGEROUS_EXEC'),
      false,
      'build-ui.mjs syntax check comment exemption must hold'
    );

    // Verify Python breakpoint() was caught
    assert.ok(findings.some((f) => f.file === 'src/script.py' && f.ruleId === 'REV_DEBUGGER_STMT' && f.line === 2));

    // Verify raw secrets NEVER appear in memory findings or persisted latest.json
    const serializedFindings = JSON.stringify(findings);
    assert.equal(serializedFindings.includes(rawSecretSk), false, 'Raw sk-* secret leaked in findings!');
    assert.equal(serializedFindings.includes('SuperSecretPass99'), false, 'Raw URL password leaked in findings!');
    assert.ok(serializedFindings.includes('[REDACTED'), 'Redacted marker expected in secret finding detail');

    const latestFile = path.join(dataDir, 'reviews', res.report.git.projectId, 'latest.json');
    const persistedRaw = fs.readFileSync(latestFile, 'utf8');
    assert.equal(persistedRaw.includes(rawSecretSk), false, 'Raw sk-* secret leaked to latest.json!');
    assert.equal(persistedRaw.includes('SuperSecretPass99'), false, 'Raw URL password leaked to latest.json!');
    assert.equal(persistedRaw.includes('\u00b7'), false, 'Middle-dot character must never appear in report output');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('gate-runner: static detection, whitelist enforcement, file:line extraction, and timeout kill', async () => {
  const repoDir = makeTempDir('review-gates-');
  try {
    initTempGitRepo(repoDir);
    writeRel(
      repoDir,
      'package.json',
      JSON.stringify(
        {
          name: 'gate-demo',
          scripts: {
            lint: 'node -e "console.error(\'src/demo.mjs:14:3: error Unexpected var\'); process.exit(1)"',
            check: 'node -e "console.log(\'all green\')"',
            test: 'node -e "setTimeout(() => {}, 30000)"',
          },
        },
        null,
        2
      )
    );
    writeRel(repoDir, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n');
    writeRel(repoDir, 'Cargo.toml', '[package]\nname = "demo"\n');
    writeRel(repoDir, 'go.mod', 'module example.com/demo\n');

    const gates = detectProjectGates(repoDir);
    const ids = gates.map((g) => g.id);
    assert.ok(ids.includes('node:lint'));
    assert.ok(ids.includes('node:check'));
    assert.ok(ids.includes('node:test'));
    assert.ok(ids.includes('py:ruff'));
    assert.ok(ids.includes('py:mypy'));
    assert.ok(ids.includes('rust:check'));
    assert.ok(ids.includes('go:vet'));

    // Whitelist rejection
    await assert.rejects(
      () => runProjectGate(repoDir, 'node:evil && calc'),
      /not in the detected project gate whitelist/
    );
    await assert.rejects(
      () => runProjectGate(repoDir, 'arbitrary-command'),
      /not in the detected project gate whitelist/
    );

    // Passing gate
    const passRes = await runProjectGate(repoDir, 'node:check', { timeoutMs: 10_000 });
    assert.equal(passRes.ok, true);
    assert.equal(passRes.status, 'passed');
    assert.equal(passRes.findings.length, 0);

    // Failing gate with file:line extraction
    const failRes = await runProjectGate(repoDir, 'node:lint', { timeoutMs: 10_000 });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.status, 'failed');
    assert.ok(failRes.findings.length >= 1);
    assert.equal(failRes.findings[0].source, 'gate');
    assert.equal(failRes.findings[0].file, 'src/demo.mjs');
    assert.equal(failRes.findings[0].line, 14);

    // Timeout enforcement & kill
    const t0 = Date.now();
    const timeoutRes = await runProjectGate(repoDir, 'node:test', { timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.timedOut, true);
    assert.equal(timeoutRes.status, 'timeout');
    assert.ok(elapsed < 6000, `Timeout gate took too long to terminate: ${elapsed}ms`);
    assert.ok(timeoutRes.findings.some((f) => f.ruleId === 'GATE_TIMEOUT'));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('prompt-builder & store: fast/deep prompts with vault memories, loose L2 JSON parsing, ignores persistence, 20-item history cap, and MCP dispatch', async () => {
  const repoDir = makeTempDir('review-e2e-');
  const dataDir = makeTempDir('review-e2e-data-');
  try {
    initTempGitRepo(repoDir);
    writeRel(repoDir, 'AGENTS.md', '# Repo Rules\nNo eval allowed.\n');
    writeRel(repoDir, 'src/core.mjs', 'export function add(a, b) {\n  return a + b;\n}\n');
    gitSync(['add', '.'], repoDir);
    gitSync(['commit', '-m', 'init'], repoDir);
    clearGitContextCache();

    // Seed vault architecture memory
    saveMemory(
      {
        projectDir: repoDir,
        kind: 'architecture',
        title: 'Strict zero-dependency Node runtime',
        summary: 'Never introduce runtime npm dependencies into src/core.',
        tags: ['arch'],
      },
      { dataDir }
    );

    // Make a change with a static issue
    writeRel(
      repoDir,
      'src/core.mjs',
      'export function add(a, b) {\n  try { return a + b; } catch (e) {}\n}\n'
    );

    // MCP Tool Schema contract checks
    assert.equal(APP_REVIEW_TOOL_DEF.name, 'app_review_manage');
    assert.deepEqual(APP_REVIEW_TOOL_DEF._meta, { ui: { visibility: ['app'] } });
    assert.equal(APP_REVIEW_TOOL_DEF.inputSchema.additionalProperties, false);

    // 1. status
    const statusRpc = await dispatchReviewTool({ action: 'status', projectDir: repoDir }, { dataDir });
    assert.equal(statusRpc.isError, undefined);
    assert.equal(statusRpc.structuredContent.latestReport, null);

    // 2. scan
    const scanRpc = await dispatchReviewTool(
      { action: 'scan', projectDir: repoDir, scope: 'uncommitted' },
      { dataDir }
    );
    const scannedReport = scanRpc.structuredContent.report;
    assert.equal(scannedReport.summary.medium, 1);
    assert.equal(scannedReport.findings[0].ruleId, 'REV_EMPTY_CATCH');
    const staticFindingId = scannedReport.findings[0].id;

    // 3. build_subagent_prompt (fast & deep)
    const fastPrompt = await buildSubagentReviewPrompt(
      { projectDir: repoDir, scope: 'uncommitted', mode: 'fast' },
      { dataDir }
    );
    assert.equal(fastPrompt.mode, 'fast');
    assert.equal(fastPrompt.budgetTokens, 6000);
    assert.ok(fastPrompt.prompt.includes('Strict zero-dependency Node runtime'));
    assert.ok(fastPrompt.prompt.includes('AGENTS.md'));
    assert.ok(fastPrompt.prompt.includes('review save --project'));
    assert.ok(fastPrompt.prompt.includes('--stdin'));
    assert.ok(fastPrompt.prompt.includes('REV_EMPTY_CATCH'));
    assert.ok(fastPrompt.prompt.includes('+0002|'));

    const deepPromptRpc = await dispatchReviewTool(
      { action: 'build_subagent_prompt', projectDir: repoDir, scope: 'uncommitted', mode: 'deep' },
      { dataDir }
    );
    assert.equal(deepPromptRpc.structuredContent.mode, 'deep');
    assert.equal(deepPromptRpc.structuredContent.budgetTokens, 12000);
    assert.ok(deepPromptRpc.structuredContent.prompt.includes('Perspective A'));
    assert.ok(deepPromptRpc.structuredContent.prompt.includes('Perspective B'));

    // 4. parseLooseReviewJson variations (pure JSON, fenced JSON in prose, bare JSON in prose, invalid)
    const leakSecret = 'ghp_1234567890ABCDEFGHIJKLMNOPQRSTUV';
    const fencedWithProse = [
      'Here is my review summary after inspecting the diff:',
      '```json',
      JSON.stringify({
        overview: 'Found 1 correctness bug and checked auth token handling.',
        findings: [
          {
            severity: 'high',
            category: 'correctness',
            ruleId: 'AI_NULL_RETURN',
            file: 'src/core.mjs',
            line: 2,
            title: 'Swallowed error returns undefined',
            detail: `Catch block returns undefined silently even when token ${leakSecret} fails`,
            suggestion: 'Re-throw or return an explicit Result object.',
            confidence: 0.92,
          },
        ],
      }),
      '```',
      'Let me know if you want me to apply this fix.',
    ].join('\n');

    const parsedFenced = parseLooseReviewJson(fencedWithProse);
    assert.equal(parsedFenced.findings.length, 1);
    assert.equal(parsedFenced.findings[0].source, 'ai_subagent');
    assert.equal(parsedFenced.findings[0].detail.includes(leakSecret), false, 'Ingested L2 secret must be redacted');
    assert.ok(parsedFenced.findings[0].detail.includes('[REDACTED'));

    const parsedProseEmbedded = parseLooseReviewJson(
      'Review complete! {"overview": "clean", "findings": [{"severity": "low", "file": "src/core.mjs", "line": 1, "title": "Add JSDoc"}]} Done.'
    );
    assert.equal(parsedProseEmbedded.findings.length, 1);
    assert.equal(parsedProseEmbedded.findings[0].severity, 'low');

    assert.throws(() => parseLooseReviewJson('not json at all without braces'), /Unable to parse/);

    // 5. ingest_report via MCP dispatch (merges with existing static findings)
    const ingestRpc = await dispatchReviewTool(
      { action: 'ingest_report', projectDir: repoDir, rawReport: fencedWithProse },
      { dataDir }
    );
    assert.equal(ingestRpc.structuredContent.ok, true);
    assert.equal(ingestRpc.structuredContent.importedCount, 1);
    assert.equal(ingestRpc.structuredContent.report.findings.length, 2);
    assert.equal(ingestRpc.structuredContent.report.summary.high, 1);
    assert.equal(ingestRpc.structuredContent.report.summary.medium, 1);

    // 6. set_ignore persistence across reload & subsequent scan
    const ignoreRpc = await dispatchReviewTool(
      { action: 'set_ignore', projectDir: repoDir, findingId: staticFindingId, ignored: true },
      { dataDir }
    );
    assert.equal(ignoreRpc.structuredContent.ok, true);
    assert.equal(ignoreRpc.structuredContent.report.summary.medium, 0);
    assert.equal(ignoreRpc.structuredContent.report.summary.ignoredCount, 1);
    assert.equal(ignoreRpc.structuredContent.report.summary.total, 1);

    const projectId = scannedReport.git.projectId;
    assert.deepEqual(loadIgnores(projectId, { dataDir }).ignoredIds, [staticFindingId]);

    const reloaded = loadLatestReport(projectId, { dataDir });
    assert.equal(reloaded.summary.ignoredCount, 1);
    assert.equal(reloaded.findings.find((f) => f.id === staticFindingId).ignored, true);

    // Re-scan preserves ignored state AND preserved ai_subagent finding on same HEAD/scope
    const rescanRpc = await dispatchReviewTool(
      { action: 'scan', projectDir: repoDir, scope: 'uncommitted' },
      { dataDir }
    );
    assert.equal(rescanRpc.structuredContent.report.findings.length, 2);
    assert.equal(rescanRpc.structuredContent.report.summary.ignoredCount, 1);
    assert.equal(rescanRpc.structuredContent.report.summary.high, 1);

    // 7. build_fix_prompt for selected findings
    const aiFindingId = rescanRpc.structuredContent.report.findings.find((f) => f.source === 'ai_subagent').id;
    const fixRpc = await dispatchReviewTool(
      { action: 'build_fix_prompt', projectDir: repoDir, findingIds: [aiFindingId] },
      { dataDir }
    );
    assert.equal(fixRpc.structuredContent.count, 1);
    assert.ok(fixRpc.structuredContent.prompt.includes('src/core.mjs:2'));
    assert.ok(fixRpc.structuredContent.prompt.includes('AI_NULL_RETURN'));

    // Also test direct buildFixPrompt empty rejection
    assert.throws(() => buildFixPrompt({ projectDir: repoDir, findings: [] }), /At least one finding/);

    // 8. History cap at MAX_REVIEW_HISTORY (20)
    for (let i = 0; i < 25; i++) {
      saveReviewReport(
        projectId,
        {
          reportId: `rev_batch_${i}`,
          scope: 'uncommitted',
          git: scannedReport.git,
          findings: [],
        },
        { dataDir },
        { pushHistory: true }
      );
    }
    const hist = loadHistory(projectId, { dataDir });
    assert.equal(hist.items.length, MAX_REVIEW_HISTORY);
    assert.equal(hist.items[0].reportId, 'rev_batch_24');

    const histRpc = await dispatchReviewTool(
      { action: 'history', projectDir: repoDir, reportId: 'rev_batch_20' },
      { dataDir }
    );
    assert.equal(histRpc.structuredContent.found, true);
    assert.equal(histRpc.structuredContent.report.reportId, 'rev_batch_20');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('hygiene: zero middle-dot (\\u00b7) characters across all review backend source files', () => {
  const filesToCheck = [
    'src/core/review/diff-parser.mjs',
    'src/core/review/static-rules.mjs',
    'src/core/review/gate-runner.mjs',
    'src/core/review/prompt-builder.mjs',
    'src/core/review/store.mjs',
    'src/core/review/index.mjs',
    'src/mcp/handlers/review.mjs',
  ];
  for (const rel of filesToCheck) {
    const content = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.equal(
      content.includes('\u00b7'),
      false,
      `Middle-dot character \\u00b7 found in ${rel}`
    );
  }
});
