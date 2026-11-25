import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { redactText } from '../redact.mjs';
import { makeReviewFindingId } from './static-rules.mjs';

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const MAX_GATE_OUTPUT_BYTES = 32 * 1024; // 32 KiB tail
const MAX_GATE_FINDINGS = 50;

function safeReadText(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    // fail-open
  }
  return '';
}

function findProjectRoot(projectDir) {
  const start = projectDir ? path.resolve(projectDir) : process.cwd();
  let cur = start;
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

function detectNodePackageManager(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function findLocalTscPath(repoRoot) {
  const jsEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(jsEntry)) return jsEntry;
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const binPath = path.join(repoRoot, 'node_modules', '.bin', binName);
  if (fs.existsSync(binPath)) return binPath;
  return null;
}

/**
 * Pure static read-only detection of native project verification gates (0 child processes).
 * Supports Node/TypeScript, Python (ruff/mypy), Rust (cargo check), and Go (go vet).
 */
export function detectProjectGates(projectDir) {
  const repoRoot = findProjectRoot(projectDir);
  const gates = [];

  // 1. Node / TypeScript
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkgRaw = safeReadText(pkgPath);
  let scripts = null;
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
        scripts = pkg.scripts;
      }
    } catch {
      // ignore malformed package.json
    }
  }

  if (scripts) {
    const pm = detectNodePackageManager(repoRoot);
    for (const scriptName of ['lint', 'typecheck', 'check', 'test']) {
      if (typeof scripts[scriptName] === 'string' && scripts[scriptName].trim()) {
        const args = pm === 'yarn' ? [scriptName] : ['run', scriptName];
        gates.push({
          id: `node:${scriptName}`,
          label: `${pm} ${args.join(' ')}`,
          command: pm,
          args,
          cwd: repoRoot,
        });
      }
    }
  }

  const hasTypecheckScript = Boolean(scripts && typeof scripts.typecheck === 'string' && scripts.typecheck.trim());
  if (!hasTypecheckScript && fs.existsSync(path.join(repoRoot, 'tsconfig.json'))) {
    const tscPath = findLocalTscPath(repoRoot);
    if (tscPath) {
      gates.push({
        id: 'ts:typecheck',
        label: 'tsc --noEmit',
        command: tscPath,
        args: ['--noEmit'],
        cwd: repoRoot,
      });
    }
  }

  // 2. Python (pyproject.toml / ruff.toml / mypy.ini)
  const pyprojectRaw = safeReadText(path.join(repoRoot, 'pyproject.toml'));
  const hasRuff =
    fs.existsSync(path.join(repoRoot, 'ruff.toml')) ||
    fs.existsSync(path.join(repoRoot, '.ruff.toml')) ||
    /\[tool\.ruff\b|\bruff\b/i.test(pyprojectRaw);
  if (hasRuff) {
    gates.push({
      id: 'py:ruff',
      label: 'ruff check',
      command: 'ruff',
      args: ['check', '.'],
      cwd: repoRoot,
    });
  }

  const hasMypy =
    fs.existsSync(path.join(repoRoot, 'mypy.ini')) ||
    fs.existsSync(path.join(repoRoot, '.mypy.ini')) ||
    /\[tool\.mypy\b|\bmypy\b/i.test(pyprojectRaw);
  if (hasMypy) {
    gates.push({
      id: 'py:mypy',
      label: 'mypy',
      command: 'mypy',
      args: ['.'],
      cwd: repoRoot,
    });
  }

  // 3. Rust (Cargo.toml)
  if (fs.existsSync(path.join(repoRoot, 'Cargo.toml'))) {
    gates.push({
      id: 'rust:check',
      label: 'cargo check',
      command: 'cargo',
      args: ['check', '--message-format=short'],
      cwd: repoRoot,
    });
  }

  // 4. Go (go.mod)
  if (fs.existsSync(path.join(repoRoot, 'go.mod'))) {
    gates.push({
      id: 'go:vet',
      label: 'go vet',
      command: 'go',
      args: ['vet', './...'],
      cwd: repoRoot,
    });
  }

  return gates;
}

/**
 * Resolve a whitelisted GateDescriptor into a direct executable + argv without invoking a user shell.
 * On Windows, resolves npm/tsc .cmd wrappers directly to their Node.js JS entry scripts via process.execPath.
 */
function resolveGateInvocation(gate) {
  const cmd = gate.command;
  const args = Array.isArray(gate.args) ? [...gate.args] : [];

  // Direct JS entrypoint (e.g., node_modules/typescript/bin/tsc)
  if (path.isAbsolute(cmd) && !cmd.toLowerCase().endsWith('.cmd') && !cmd.toLowerCase().endsWith('.exe')) {
    try {
      const head = fs.readFileSync(cmd, 'utf8').slice(0, 128);
      if (head.startsWith('#!') && /node\b/i.test(head)) {
        return { execBin: process.execPath, execArgs: [cmd, ...args] };
      }
    } catch {
      // fall through
    }
  }

  if (process.platform === 'win32') {
    const nodeDir = path.dirname(process.execPath);

    if (cmd === 'npm') {
      const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(npmCli)) {
        return { execBin: process.execPath, execArgs: [npmCli, ...args] };
      }
    }

    if (cmd === 'pnpm' || cmd === 'yarn') {
      const candidates = [
        path.join(gate.cwd, 'node_modules', cmd, 'bin', `${cmd}.cjs`),
        path.join(gate.cwd, 'node_modules', cmd, 'bin', `${cmd}.js`),
        path.join(nodeDir, 'node_modules', 'corepack', 'dist', `${cmd}.js`),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          return { execBin: process.execPath, execArgs: [c, ...args] };
        }
      }
      // Controlled cmd.exe wrapper for whitelisted static command & args only (never user-supplied)
      const comspec = process.env.ComSpec || 'cmd.exe';
      return { execBin: comspec, execArgs: ['/d', '/s', '/c', `${cmd}.cmd`, ...args] };
    }

    if (cmd.toLowerCase().endsWith('.cmd')) {
      const jsTsc = path.join(gate.cwd, 'node_modules', 'typescript', 'bin', 'tsc');
      if (gate.id === 'ts:typecheck' && fs.existsSync(jsTsc)) {
        return { execBin: process.execPath, execArgs: [jsTsc, ...args] };
      }
      const comspec = process.env.ComSpec || 'cmd.exe';
      return { execBin: comspec, execArgs: ['/d', '/s', '/c', cmd, ...args] };
    }
  }

  return { execBin: cmd, execArgs: args };
}

function normalizeGateFilePath(rawFile, repoRoot) {
  if (!rawFile) return null;
  let cleaned = String(rawFile).trim().replace(/^file:\/\/\/?/i, '');
  // On Windows file:///F:/path -> F:/path
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  cleaned = cleaned.replace(/^['"`(]+|['"`)]+$/g, '');
  if (
    !cleaned ||
    cleaned.startsWith('>') ||
    cleaned.startsWith('node:') ||
    cleaned.includes('node_modules') ||
    /["'`<>|;=]/.test(cleaned)
  ) {
    return null;
  }
  if (path.isAbsolute(cleaned)) {
    const rel = path.relative(repoRoot, cleaned);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, '/');
    }
    return null;
  }
  return cleaned.replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Parse `file:line(:col)` or `file(line,col)` diagnostics from gate stdout/stderr into `source: 'gate'` findings.
 */
export function parseGateOutputToFindings(output, { gateId, label, repoRoot, ok, timedOut }) {
  const findings = [];
  const seenIds = new Set();
  const safeOutput = redactText(String(output || '')).replace(/\u00b7/g, '/');
  const lines = safeOutput.split(/\r?\n/);

  const pushUnique = (item) => {
    if (findings.length >= MAX_GATE_FINDINGS) return;
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      findings.push(item);
    }
  };

  // Patterns:
  // 1) TypeScript: path/to/file.ts(12,5): error TS2322: message
  const tsRe = /^([^\s("'`<>|][^()"'`<>|]*?\.[A-Za-z0-9]{1,8})\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z0-9_-]+):\s*(.+)$/i;
  // 2) Standard file:line(:col): message (ESLint unix, rustc short, go vet, ruff, mypy, node)
  const colonRe = /^((?:[A-Za-z]:[\\/])?[^:\s"'`<>()|][^:"'`<>()|]*?\.[A-Za-z0-9]{1,8}):(\d+)(?::(\d+))?(?::|\s+-)\s*(.+)$/;
  // 3) ESLint stylish header + indented line:col
  let currentStylishFile = null;
  const stylishFileRe = /^((?:[A-Za-z]:[\\/])?[^\s"'`<>()|].*\.(?:[cm]?js|[cm]?ts|jsx|tsx|vue|svelte))$/;
  const stylishErrRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([A-Za-z0-9_/-]+))?\s*$/i;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      currentStylishFile = null;
      continue;
    }
    // Skip package-manager echoed script command lines (e.g. `> node -e ...`)
    if (/^\s*>\s+/.test(line)) {
      continue;
    }

    let match = tsRe.exec(line);
    if (match) {
      const rel = normalizeGateFilePath(match[1], repoRoot);
      if (rel) {
        const lineNum = Math.max(1, Number(match[2]) || 1);
        const sev = match[4].toLowerCase() === 'warning' ? 'medium' : 'high';
        const code = match[5] || gateId;
        const msg = match[6].trim();
        const ruleId = `GATE_${code}`;
        const title = `[${label}] ${msg.slice(0, 140)}`;
        pushUnique({
          id: makeReviewFindingId({ ruleId, file: rel, line: lineNum, title }),
          source: 'gate',
          gateId,
          severity: sev,
          category: 'correctness',
          ruleId,
          file: rel,
          line: lineNum,
          title,
          detail: line.trim().slice(0, 400),
          confidence: 1.0,
          ignored: false,
        });
        continue;
      }
    }

    match = colonRe.exec(line.trim());
    if (match) {
      const rel = normalizeGateFilePath(match[1], repoRoot);
      if (rel) {
        const lineNum = Math.max(1, Number(match[2]) || 1);
        const msg = match[4].trim();
        const isWarn = /\bwarn(?:ing)?\b/i.test(msg);
        const ruleId = `GATE_${gateId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
        const title = `[${label}] ${msg.slice(0, 140)}`;
        pushUnique({
          id: makeReviewFindingId({ ruleId, file: rel, line: lineNum, title }),
          source: 'gate',
          gateId,
          severity: isWarn ? 'medium' : 'high',
          category: 'correctness',
          ruleId,
          file: rel,
          line: lineNum,
          title,
          detail: line.trim().slice(0, 400),
          confidence: 1.0,
          ignored: false,
        });
        continue;
      }
    }

    const sfMatch = stylishFileRe.exec(line.trim());
    if (sfMatch && !line.startsWith(' ')) {
      currentStylishFile = normalizeGateFilePath(sfMatch[1], repoRoot);
      continue;
    }

    if (currentStylishFile) {
      const seMatch = stylishErrRe.exec(line);
      if (seMatch) {
        const lineNum = Math.max(1, Number(seMatch[1]) || 1);
        const sev = seMatch[3].toLowerCase() === 'warning' ? 'medium' : 'high';
        const msg = seMatch[4].trim();
        const ruleSuffix = seMatch[5] ? seMatch[5].replace(/[^A-Za-z0-9_-]+/g, '_') : gateId;
        const ruleId = `GATE_${ruleSuffix}`;
        const title = `[${label}] ${msg.slice(0, 140)}`;
        pushUnique({
          id: makeReviewFindingId({ ruleId, file: currentStylishFile, line: lineNum, title }),
          source: 'gate',
          gateId,
          severity: sev,
          category: 'correctness',
          ruleId,
          file: currentStylishFile,
          line: lineNum,
          title,
          detail: `${currentStylishFile}:${lineNum} ${msg}`.slice(0, 400),
          confidence: 1.0,
          ignored: false,
        });
      }
    }
  }

  if (!ok && findings.length === 0) {
    const ruleId = timedOut ? 'GATE_TIMEOUT' : 'GATE_FAILED';
    const title = timedOut ? `[${label}] Timed out` : `[${label}] Check failed`;
    const tailSnippet = safeOutput.trim().slice(-600) || (timedOut ? 'Gate process exceeded timeout and was terminated.' : 'Gate exited with a non-zero status.');
    pushUnique({
      id: makeReviewFindingId({ ruleId, file: '.', line: 1, title }),
      source: 'gate',
      gateId,
      severity: 'high',
      category: 'reliability',
      ruleId,
      file: '.',
      line: 1,
      title,
      detail: tailSnippet,
      confidence: 1.0,
      ignored: false,
    });
  }

  return findings;
}

function killProcessTree(child, onDone) {
  if (!child || !child.pid) {
    onDone?.();
    return;
  }
  const pid = child.pid;
  const fallbackKill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    onDone?.();
  };

  if (process.platform === 'win32') {
    // Run taskkill /T /F BEFORE killing parent so Windows can traverse and terminate grandchildren too.
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => {
        fallbackKill();
      });
      return;
    } catch {
      // fall through to direct kill
    }
  }
  fallbackKill();
}

/**
 * Execute a strictly whitelisted native project gate with hard timeout (default 60s),
 * tail 32 KiB output retention, secret redaction, and file:line finding extraction.
 */
export async function runProjectGate(projectDir, gateId, options = {}) {
  const idStr = String(gateId || '').trim();
  if (!idStr) {
    throw new Error('gateId is required');
  }

  const detected = detectProjectGates(projectDir);
  const gate = detected.find((g) => g.id === idStr);
  if (!gate) {
    throw new Error(`Gate "${idStr}" is not in the detected project gate whitelist`);
  }

  const timeoutMs = Math.max(100, Math.min(120_000, Number(options.timeoutMs) || DEFAULT_GATE_TIMEOUT_MS));
  const { execBin, execArgs } = resolveGateInvocation(gate);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let chunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let settled = false;

    const appendChunk = (buf) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
      chunks.push(b);
      totalBytes += b.length;
      // Keep bounded tail buffer in memory (2x tail cap) so huge stdout cannot OOM
      if (totalBytes > MAX_GATE_OUTPUT_BYTES * 2) {
        const merged = Buffer.concat(chunks);
        const tail = merged.subarray(merged.length - MAX_GATE_OUTPUT_BYTES);
        chunks = [tail];
        totalBytes = tail.length;
      }
    };

    const finalize = (exitCode, spawnErr = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (spawnErr) {
        appendChunk(`\n${spawnErr.message || String(spawnErr)}\n`);
      }

      const merged = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
      const tailBuf = merged.length > MAX_GATE_OUTPUT_BYTES
        ? merged.subarray(merged.length - MAX_GATE_OUTPUT_BYTES)
        : merged;
      const redactedOutput = redactText(tailBuf.toString('utf8')).replace(/\u00b7/g, '/');

      const durationMs = Date.now() - startedAt;
      const ok = !timedOut && !spawnErr && exitCode === 0;
      const status = timedOut ? 'timeout' : ok ? 'passed' : 'failed';
      const findings = parseGateOutputToFindings(redactedOutput, {
        gateId: gate.id,
        label: gate.label,
        repoRoot: gate.cwd,
        ok,
        timedOut,
      });

      resolve({
        gateId: gate.id,
        label: gate.label,
        command: `${gate.command} ${gate.args.join(' ')}`.trim(),
        status,
        ok,
        timedOut,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        durationMs,
        output: redactedOutput,
        findings,
        ranAt: new Date().toISOString(),
      });
    };

    let child;
    try {
      child = spawn(execBin, execArgs, {
        cwd: gate.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finalize(null, err);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, () => {
        setTimeout(() => finalize(null), 80).unref?.();
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);
    child.on('error', (err) => finalize(null, err));
    child.on('close', (code) => finalize(code));
  });
}
