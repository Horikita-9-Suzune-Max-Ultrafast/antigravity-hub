import path from 'node:path';
import { getGitContext } from '../git-context.mjs';
import {
  VALID_REVIEW_SCOPES,
  validateBaseRef,
  classifyNoiseFile,
  parseUnifiedDiff,
  collectGitDiff,
} from './diff-parser.mjs';
import {
  SEVERITY_ORDER,
  AUDIT_PATTERNS,
  makeReviewFindingId,
  sortReviewFindings,
  runStaticReviewRules,
} from './static-rules.mjs';
import {
  detectProjectGates,
  parseGateOutputToFindings,
  runProjectGate,
} from './gate-runner.mjs';
import {
  REVIEW_PROMPT_MODES,
  resolveCtxCliPath,
  buildSubagentReviewPrompt,
  buildFixPrompt,
} from './prompt-builder.mjs';
import {
  MAX_REVIEW_HISTORY,
  getReviewProjectDir,
  normalizeReviewFinding,
  computeReviewSummary,
  parseLooseReviewJson,
  loadIgnores,
  saveIgnores,
  loadLatestReport,
  loadHistory,
  loadHistoryReport,
  generateReportId,
  saveReviewReport,
  setFindingIgnored,
} from './store.mjs';

export {
  VALID_REVIEW_SCOPES,
  validateBaseRef,
  classifyNoiseFile,
  parseUnifiedDiff,
  collectGitDiff,
  SEVERITY_ORDER,
  AUDIT_PATTERNS,
  makeReviewFindingId,
  sortReviewFindings,
  runStaticReviewRules,
  detectProjectGates,
  parseGateOutputToFindings,
  runProjectGate,
  REVIEW_PROMPT_MODES,
  resolveCtxCliPath,
  buildSubagentReviewPrompt,
  buildFixPrompt,
  MAX_REVIEW_HISTORY,
  getReviewProjectDir,
  normalizeReviewFinding,
  computeReviewSummary,
  parseLooseReviewJson,
  loadIgnores,
  saveIgnores,
  loadLatestReport,
  loadHistory,
  loadHistoryReport,
  generateReportId,
  saveReviewReport,
  setFindingIgnored,
};

function mergeFindingsById(...lists) {
  const map = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || !item.id) continue;
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
  }
  return sortReviewFindings([...map.values()]);
}

function isSameDiffContext(report, git, scope, baseRef) {
  if (!report || !git) return false;
  const sameHead = String(report.git?.head || '') === String(git.head || '');
  const sameScope = String(report.scope || 'uncommitted') === String(scope || 'uncommitted');
  const sameBase = String(report.baseRef || '') === String(baseRef || '');
  return sameHead && sameScope && sameBase;
}

function toHistorySummary(item) {
  return {
    reportId: item.reportId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    scope: item.scope,
    baseRef: item.baseRef || null,
    overview: item.overview || '',
    git: item.git,
    summary: item.summary,
    diffStats: item.diffStats,
    gates: Array.isArray(item.gates) ? item.gates : [],
    findings: Array.isArray(item.findings) ? item.findings : [],
  };
}

/**
 * Unified async action dispatcher for local code review (`app_review_manage` & `ctx review` CLI).
 */
export async function handleReviewAction(args = {}, options = {}) {
  const action = String(args.action || 'status').trim();
  const projectDir = path.resolve(args.projectDir || options.projectDir || process.cwd());
  const git = getGitContext(projectDir);
  const repoRoot = git.repoRoot || projectDir;
  const projectId = git.projectId;

  switch (action) {
    case 'status': {
      const latestReport = loadLatestReport(projectId, options);
      const availableGates = detectProjectGates(repoRoot);
      const history = loadHistory(projectId, options);
      const ignores = loadIgnores(projectId, options);
      return {
        git,
        latestReport,
        availableGates,
        historyCount: history.items.length,
        ignoredCount: ignores.ignoredIds.length,
      };
    }

    case 'scan': {
      const scope = args.scope || 'uncommitted';
      const diffResult = await collectGitDiff({
        projectDir: repoRoot,
        scope,
        baseRef: args.baseRef,
      });
      const staticFindings = runStaticReviewRules(diffResult);
      const existing = loadLatestReport(projectId, options);

      let preservedFindings = [];
      let preservedGates = [];
      let preservedOverview = '';
      if (isSameDiffContext(existing, diffResult.git, diffResult.scope, diffResult.baseRef)) {
        preservedFindings = (existing.findings || []).filter(
          (f) => f.source === 'ai_subagent' || f.source === 'gate'
        );
        preservedGates = Array.isArray(existing.gates) ? existing.gates : [];
        preservedOverview = existing.overview || '';
      }

      const mergedFindings = mergeFindingsById(staticFindings, preservedFindings);
      const report = saveReviewReport(
        projectId,
        {
          reportId: generateReportId(),
          scope: diffResult.scope,
          baseRef: diffResult.baseRef,
          overview: preservedOverview,
          git: diffResult.git,
          diffStats: diffResult.stats,
          gates: preservedGates,
          findings: mergedFindings,
        },
        options,
        { pushHistory: true }
      );

      const availableGates = detectProjectGates(repoRoot);
      return {
        report,
        availableGates,
        diffStats: diffResult.stats,
        skippedFiles: diffResult.skippedFiles,
        truncated: diffResult.truncated,
      };
    }

    case 'run_gate': {
      const gateId = String(args.gateId || '').trim();
      if (!gateId) {
        throw new Error('gateId is required for run_gate');
      }
      const gateResult = await runProjectGate(repoRoot, gateId, {
        timeoutMs: options.gateTimeoutMs,
      });

      const existing = loadLatestReport(projectId, options);
      const prevGates = Array.isArray(existing?.gates) ? existing.gates : [];
      const nextGates = [
        ...prevGates.filter((g) => g && g.gateId !== gateResult.gateId),
        {
          gateId: gateResult.gateId,
          label: gateResult.label,
          command: gateResult.command,
          status: gateResult.status,
          ok: gateResult.ok,
          timedOut: gateResult.timedOut,
          exitCode: gateResult.exitCode,
          durationMs: gateResult.durationMs,
          ranAt: gateResult.ranAt,
        },
      ];

      const prevFindings = Array.isArray(existing?.findings)
        ? existing.findings.filter((f) => !(f.source === 'gate' && f.gateId === gateResult.gateId))
        : [];
      const mergedFindings = mergeFindingsById(prevFindings, gateResult.findings);

      const report = saveReviewReport(
        projectId,
        {
          reportId: existing?.reportId || generateReportId(),
          createdAt: existing?.createdAt,
          scope: existing?.scope || args.scope || 'uncommitted',
          baseRef: existing?.baseRef || null,
          overview: existing?.overview || '',
          git: existing?.git || git,
          diffStats: existing?.diffStats,
          gates: nextGates,
          findings: mergedFindings,
        },
        options,
        { pushHistory: !existing }
      );

      return { gateResult, report };
    }

    case 'build_subagent_prompt': {
      const scope = args.scope || 'uncommitted';
      const mode = args.mode === 'deep' ? 'deep' : 'fast';
      const diffResult = await collectGitDiff({
        projectDir: repoRoot,
        scope,
        baseRef: args.baseRef,
      });
      const staticFindings = runStaticReviewRules(diffResult);
      const existing = loadLatestReport(projectId, options);
      const gateFindings =
        existing && isSameDiffContext(existing, diffResult.git, diffResult.scope, diffResult.baseRef)
          ? (existing.findings || []).filter((f) => f.source === 'gate')
          : [];

      const built = await buildSubagentReviewPrompt(
        {
          projectDir: repoRoot,
          scope: diffResult.scope,
          baseRef: diffResult.baseRef,
          mode,
          budgetTokens: args.budgetTokens,
          diffResult,
          staticFindings,
          gateFindings,
        },
        options
      );

      return {
        prompt: built.prompt,
        tokens: built.tokens,
        budgetTokens: built.budgetTokens,
        mode: built.mode,
        scope: built.scope,
        baseRef: built.baseRef,
        cliSaveCommand: built.cliSaveCommand,
      };
    }

    case 'ingest_report': {
      if (args.rawReport === undefined || args.rawReport === null || String(args.rawReport).trim() === '') {
        throw new Error('rawReport is required for ingest_report');
      }
      const parsed = parseLooseReviewJson(args.rawReport);
      const existing = loadLatestReport(projectId, options);
      const targetScope = parsed.scope || args.scope || existing?.scope || 'uncommitted';
      const targetBaseRef = args.baseRef || existing?.baseRef || null;

      let preservedFindings = [];
      let preservedGates = [];
      let diffStats = existing?.diffStats;
      if (existing && String(existing.git?.head || '') === String(git.head || '')) {
        preservedFindings = (existing.findings || []).filter(
          (f) => f.source === 'static' || f.source === 'gate'
        );
        preservedGates = Array.isArray(existing.gates) ? existing.gates : [];
      }

      const mergedFindings = mergeFindingsById(preservedFindings, parsed.findings);
      const report = saveReviewReport(
        projectId,
        {
          reportId: generateReportId(),
          scope: targetScope,
          baseRef: targetBaseRef,
          overview: parsed.overview || existing?.overview || '',
          git,
          diffStats,
          gates: preservedGates,
          findings: mergedFindings,
        },
        options,
        { pushHistory: true }
      );

      return {
        ok: true,
        importedCount: parsed.findings.length,
        report,
      };
    }

    case 'set_ignore': {
      const findingId = String(args.findingId || '').trim();
      if (!findingId) {
        throw new Error('findingId is required for set_ignore');
      }
      const res = setFindingIgnored(projectId, findingId, Boolean(args.ignored), options);
      return {
        ok: true,
        report: res.report,
        ignores: res.ignores,
      };
    }

    case 'build_fix_prompt': {
      const report = args.reportId
        ? loadHistoryReport(projectId, args.reportId, options)
        : loadLatestReport(projectId, options);
      if (!report) {
        throw new Error('No review report available for building a fix prompt');
      }
      const allFindings = Array.isArray(report.findings) ? report.findings : [];
      let selected;
      if (Array.isArray(args.findingIds) && args.findingIds.length > 0) {
        const wanted = new Set(args.findingIds.map((id) => String(id || '').trim()).filter(Boolean));
        selected = allFindings.filter((f) => wanted.has(f.id));
      } else {
        selected = allFindings.filter((f) => !f.ignored);
      }
      if (selected.length === 0) {
        throw new Error('No matching review findings selected for fix prompt');
      }
      return buildFixPrompt({
        projectDir: repoRoot,
        findings: selected,
        report,
      });
    }

    case 'history': {
      const { items } = loadHistory(projectId, options);
      if (args.reportId) {
        const report = loadHistoryReport(projectId, args.reportId, options);
        return {
          report,
          found: Boolean(report),
          items: items.map(toHistorySummary),
        };
      }
      return {
        items: items.map(toHistorySummary),
      };
    }

    default:
      throw new Error(`Unsupported review action: ${action}`);
  }
}
