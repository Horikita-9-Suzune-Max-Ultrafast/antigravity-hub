import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, getPluginDeployDir } from '../paths.mjs';
import { redactText } from '../redact.mjs';
import { estimateTokens, listMemories } from '../vault.mjs';
import { collectGitDiff } from './diff-parser.mjs';
import { SEVERITY_ORDER, runStaticReviewRules } from './static-rules.mjs';

export const REVIEW_PROMPT_MODES = {
  fast: 6000,
  deep: 12000,
};

const MAX_MEMORY_BUDGET_TOKENS = 800;
const DIFF_BUDGET_RATIO = 0.75;

function stripMidDot(text) {
  return String(text || '').replace(/\u00b7/g, '/');
}

export function resolveCtxCliPath(options = {}) {
  const deployed = path.join(getPluginDeployDir(options), 'bin', 'ctx.mjs');
  if (fs.existsSync(deployed)) {
    return deployed;
  }
  return path.join(PACKAGE_ROOT, 'bin', 'ctx.mjs');
}

function buildCliSaveCommand(repoRoot, options = {}) {
  const ctxBin = resolveCtxCliPath(options);
  return `node --no-warnings "${ctxBin}" review save --project "${repoRoot}" --stdin`;
}

function collectVaultMemoryContext(projectId, repoRoot, options = {}) {
  const lines = [];
  let usedTokens = 0;
  let memoryCount = 0;

  try {
    const all = listMemories({ projectId, limit: 40 }, options);
    const relevant = all.filter(
      (m) => !m.archived && (m.kind === 'architecture' || m.kind === 'decision' || m.kind === 'pitfall')
    );

    const priority = { pitfall: 1, architecture: 2, decision: 3 };
    relevant.sort((a, b) => {
      const pa = priority[a.kind] || 9;
      const pb = priority[b.kind] || 9;
      if (pa !== pb) return pa - pb;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

    for (const mem of relevant) {
      const cleanTitle = stripMidDot(redactText(mem.title || '')).replace(/\s+/g, ' ').trim();
      const cleanSummary = stripMidDot(redactText(mem.summary || '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      const line = `- [${mem.kind}] ${cleanTitle}${cleanSummary ? `: ${cleanSummary}` : ''}`;
      const tok = estimateTokens(line) + 1;
      if (usedTokens + tok > MAX_MEMORY_BUDGET_TOKENS) {
        break;
      }
      lines.push(line);
      usedTokens += tok;
      memoryCount++;
    }
  } catch {
    // fail-open if vault index is unavailable
  }

  const guideFiles = [];
  for (const rel of ['AGENTS.md', 'README.md']) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs)) {
      guideFiles.push(abs);
    }
  }

  return { lines, memoryCount, guideFiles };
}

function prioritizeDiffFiles(files, evidenceFindings) {
  const fileSeverity = new Map();
  for (const f of evidenceFindings || []) {
    if (!f?.file || f.ignored) continue;
    const rank = SEVERITY_ORDER[f.severity] ?? 9;
    const prev = fileSeverity.get(f.file);
    if (prev === undefined || rank < prev) {
      fileSeverity.set(f.file, rank);
    }
  }

  return [...files].sort((a, b) => {
    const ra = fileSeverity.has(a.path) ? fileSeverity.get(a.path) : 99;
    const rb = fileSeverity.has(b.path) ? fileSeverity.get(b.path) : 99;
    if (ra !== rb) return ra - rb;
    const densityA = (a.additions || 0) + (a.deletions || 0);
    const densityB = (b.additions || 0) + (b.deletions || 0);
    if (densityA !== densityB) return densityB - densityA;
    return String(a.path).localeCompare(String(b.path));
  });
}

function formatDiffSection(diffResult, evidenceFindings, diffBudgetTokens) {
  const sortedFiles = prioritizeDiffFiles(diffResult.files || [], evidenceFindings);
  const includedBlocks = [];
  const omittedFiles = [];
  let usedTokens = 0;

  for (const file of sortedFiles) {
    const header = `### File: ${file.path} [${file.status}] (+${file.additions}/-${file.deletions})`;
    const hunksText = (file.hunks || [])
      .map((h) => stripMidDot(redactText(h.contextPatch || '')))
      .filter(Boolean)
      .join('\n');
    const block = `${header}\n\`\`\`diff\n${hunksText || '(no textual hunks)'}\n\`\`\``;
    const blockTokens = estimateTokens(block) + 2;

    if (usedTokens + blockTokens <= diffBudgetTokens) {
      includedBlocks.push(block);
      usedTokens += blockTokens;
    } else if (includedBlocks.length === 0 && diffBudgetTokens > 200) {
      // Fit at least a truncated prefix of the top-priority file so the prompt is never empty
      const charLimit = Math.max(400, Math.floor((diffBudgetTokens - 60) * 3.2));
      const trimmedHunks = hunksText.slice(0, charLimit);
      const partial = `${header} (truncated to fit budget)\n\`\`\`diff\n${trimmedHunks}\n... [truncated; use read_file for full context]\n\`\`\``;
      includedBlocks.push(partial);
      usedTokens += estimateTokens(partial);
    } else {
      omittedFiles.push(file);
    }
  }

  return {
    includedBlocks,
    omittedFiles,
    diffTokensUsed: usedTokens,
  };
}

/**
 * Build an isolated L2 Subagent code review prompt combining:
 * 1. Prioritized line-numbered diff snippets (strictly <= 75% of budgetTokens)
 * 2. L1 static preflight & native gate evidence summary
 * 3. Vault project memories (architecture / decision / pitfall, <= 800 tokens) + AGENTS.md path
 * 4. Strict JSON Schema + dual-channel `ctx review save --stdin` persistence instructions
 */
export async function buildSubagentReviewPrompt(
  {
    projectDir,
    scope = 'uncommitted',
    baseRef,
    mode = 'fast',
    budgetTokens,
    diffResult,
    staticFindings,
    gateFindings = [],
  } = {},
  options = {}
) {
  const normalizedMode = mode === 'deep' ? 'deep' : 'fast';
  const defaultBudget = REVIEW_PROMPT_MODES[normalizedMode];
  const resolvedBudget =
    budgetTokens !== undefined && budgetTokens !== null && Number.isFinite(Number(budgetTokens))
      ? Math.max(1500, Math.min(24000, Math.round(Number(budgetTokens))))
      : defaultBudget;

  const diff = diffResult || (await collectGitDiff({ projectDir, scope, baseRef }));
  const repoRoot = diff.repoRoot || (projectDir ? path.resolve(projectDir) : process.cwd());
  const l1Findings = Array.isArray(staticFindings) ? staticFindings : runStaticReviewRules(diff);
  const allEvidence = [...l1Findings, ...(Array.isArray(gateFindings) ? gateFindings : [])].filter((f) => !f.ignored);

  const diffBudget = Math.floor(resolvedBudget * DIFF_BUDGET_RATIO);
  const { includedBlocks, omittedFiles } = formatDiffSection(diff, allEvidence, diffBudget);
  const memoryCtx = collectVaultMemoryContext(diff.git?.projectId, repoRoot, options);
  const cliSaveCommand = buildCliSaveCommand(repoRoot, options);

  const sections = [];

  sections.push(
    [
      '# Isolated Local Code Review Assignment (Antigravity Hub L2)',
      '',
      'You are the primary coordinator agent. Dispatch an isolated, strictly READ-ONLY subagent using `invoke_subagent` (prefer `TypeName: "general-regression-reviewer"` or `"self"`).',
      'Hard rules for the subagent:',
      '- Do NOT modify, create, or delete any file in the target repository.',
      '- Do NOT echo any raw secrets, tokens, or private keys in output.',
      '- Report ONLY high-signal, concrete issues backed by exact file paths and new-file line numbers (`confidence >= 0.75`).',
      '- Do NOT repeat issues already caught in the L1 Static / Gate Evidence section below unless you have deeper root-cause findings.',
      '',
      `## Target Metadata`,
      `- Repository: \`${repoRoot}\``,
      `- Branch / HEAD: \`${diff.git?.branch || 'nogit'}@${diff.git?.head || 'none'}\`${diff.git?.dirty ? ' (dirty)' : ''}`,
      `- Scope: \`${diff.scope}\`${diff.baseRef ? ` (baseRef: \`${diff.baseRef}\`)` : ''}`,
      `- Review Mode: \`${normalizedMode}\` (budget: ${resolvedBudget} tokens)`,
      `- Diff Stats: ${diff.stats?.filesChanged || 0} files (+${diff.stats?.additions || 0}/-${diff.stats?.deletions || 0}), ${diff.stats?.skippedCount || 0} folded noise/oversized files`,
    ].join('\n')
  );

  if (normalizedMode === 'deep') {
    sections.push(
      [
        '## Deep Review Strategy (Dual-Perspective Cross-Check)',
        'Analyze the diff from two independent lenses and cross-verify before emitting findings:',
        '1. Perspective A (Security & Correctness): auth/boundary validation, path traversal, command/SQL injection, race conditions, null/undefined edge cases, error handling, backward compatibility.',
        '2. Perspective B (Performance & Architecture): hot-path I/O or O(N^2) loops, unbounded caches/memory leaks, lock contention, contract drift against project architecture decisions.',
      ].join('\n')
    );
  } else {
    sections.push(
      [
        '## Fast Review Strategy (Single-Pass High-Signal Audit)',
        'Focus on real bugs, security vulnerabilities, regression risks, broken edge cases, and architectural contract violations. Skip minor formatting or subjective style nits.',
      ].join('\n')
    );
  }

  if (memoryCtx.lines.length > 0 || memoryCtx.guideFiles.length > 0) {
    const memBlock = ['## Project Architecture & Vault Memories (Read-Only Context)'];
    if (memoryCtx.guideFiles.length > 0) {
      memBlock.push(`- Reference project guidelines if needed: ${memoryCtx.guideFiles.map((p) => `\`${p}\``).join(', ')}`);
    }
    if (memoryCtx.lines.length > 0) {
      memBlock.push(...memoryCtx.lines);
    }
    sections.push(memBlock.join('\n'));
  }

  if (allEvidence.length > 0) {
    const evLines = ['## Existing L1 Static & Gate Evidence (Already Recorded - Do Not Duplicate)'];
    for (const f of allEvidence.slice(0, 25)) {
      evLines.push(`- [${f.severity}] [${f.ruleId}] ${f.file}:${f.line} - ${stripMidDot(redactText(f.title))}`);
    }
    if (allEvidence.length > 25) {
      evLines.push(`- ... and ${allEvidence.length - 25} more existing findings`);
    }
    sections.push(evLines.join('\n'));
  }

  sections.push(
    [
      '## Line-Numbered Diff Payload',
      includedBlocks.length > 0 ? includedBlocks.join('\n\n') : '(No textual diff hunks in the selected scope.)',
    ].join('\n\n')
  );

  if (omittedFiles.length > 0 || (diff.skippedFiles && diff.skippedFiles.length > 0)) {
    const tableLines = ['## Additional Changed / Folded Files (Use `read_file` on demand)'];
    for (const f of omittedFiles.slice(0, 40)) {
      tableLines.push(`- \`${f.path}\` [${f.status}] (+${f.additions}/-${f.deletions}) [budget_deferred]`);
    }
    for (const sf of (diff.skippedFiles || []).slice(0, 25)) {
      tableLines.push(`- \`${sf.path}\` [${sf.status || 'M'}] [folded: ${sf.reason}]`);
    }
    sections.push(tableLines.join('\n'));
  }

  sections.push(
    [
      '## Required Output Schema & Persistence Channel',
      'Return a single JSON block matching this exact schema:',
      '```json',
      '{',
      '  "overview": "Concise 1-3 sentence summary of review conclusion and main risks",',
      `  "mode": "${normalizedMode}",`,
      `  "scope": "${diff.scope}",`,
      '  "findings": [',
      '    {',
      '      "severity": "critical | high | medium | low",',
      '      "category": "security | correctness | performance | reliability | maintainability | hygiene",',
      '      "ruleId": "AI_SHORT_CODE",',
      '      "file": "relative/posix/path.mjs",',
      '      "line": 42,',
      '      "endLine": 48,',
      '      "title": "Short actionable finding title",',
      '      "detail": "Concrete root cause referencing exact symbols and line numbers",',
      '      "suggestion": "Minimal, safe fix recommendation",',
      '      "confidence": 0.9',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      '### How to Persist the Report Back to Antigravity Hub',
      '1. If you have terminal permission, pipe the JSON payload into stdin of this single command:',
      '```powershell',
      cliSaveCommand,
      '```',
      '2. If the subagent runs in a read-only sandbox without terminal execution permission, return the JSON block verbatim to the primary agent so the primary agent can execute the command above (or the user can paste it into the Hub "Import Report" modal).',
    ].join('\n')
  );

  const prompt = stripMidDot(redactText(sections.join('\n\n')));
  return {
    prompt,
    tokens: estimateTokens(prompt),
    budgetTokens: resolvedBudget,
    mode: normalizedMode,
    scope: diff.scope,
    baseRef: diff.baseRef || null,
    cliSaveCommand,
    includedFilesCount: includedBlocks.length,
    omittedFilesCount: omittedFiles.length,
    memoryCount: memoryCtx.memoryCount,
  };
}

/**
 * Build a precise, minimal-scope batch fix prompt for 1..N selected ReviewFindings.
 */
export function buildFixPrompt({ projectDir, findings = [], report = null } = {}) {
  const list = Array.isArray(findings) ? findings.filter(Boolean) : [];
  if (list.length === 0) {
    throw new Error('At least one finding is required to build a fix prompt');
  }

  const repoRoot = projectDir
    ? path.resolve(projectDir)
    : report?.git?.repoRoot || process.cwd();

  const lines = [
    '# Targeted Code Review Fix Request',
    '',
    `Repository: \`${repoRoot}\``,
    report?.git?.branch ? `Branch / HEAD: \`${report.git.branch}@${report.git.head || 'none'}\`` : '',
    `Selected Findings: ${list.length}`,
    '',
    '## Issues to Fix',
  ].filter(Boolean);

  list.forEach((f, idx) => {
    const loc = f.endLine && f.endLine > f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;
    lines.push(`${idx + 1}. [${String(f.severity || 'medium').toUpperCase()}] [${f.ruleId || 'REVIEW'}] \`${loc}\` - ${stripMidDot(redactText(f.title || ''))}`);
    if (f.detail) {
      lines.push(`   - Cause: ${stripMidDot(redactText(f.detail))}`);
    }
    if (f.suggestion) {
      lines.push(`   - Suggestion: ${stripMidDot(redactText(f.suggestion))}`);
    }
  });

  lines.push(
    '',
    '## Fix Guardrails & Verification',
    '1. Make the smallest correct change needed to resolve the listed findings; do NOT refactor unrelated files or behavior.',
    '2. Never print or echo raw credentials, API keys, or tokens in logs, code, or explanations.',
    '3. After applying the fixes, run the relevant unit tests or project gates to confirm zero regressions, then report modified files and test results.'
  );

  const prompt = stripMidDot(redactText(lines.join('\n')));
  return {
    prompt,
    tokens: estimateTokens(prompt),
    count: list.length,
  };
}
