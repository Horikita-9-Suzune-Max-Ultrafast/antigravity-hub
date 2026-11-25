import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths } from '../paths.mjs';
import { atomicWriteJsonObj, withFileLockSync } from '../fs-utils.mjs';
import { redactObject, redactText } from '../redact.mjs';
import { makeReviewFindingId, sortReviewFindings } from './static-rules.mjs';

export const MAX_REVIEW_HISTORY = 20;
const MAX_REPORT_FINDINGS = 100;

const VALID_SOURCES = new Set(['static', 'gate', 'ai_subagent']);
const VALID_CATEGORIES = new Set([
  'security',
  'correctness',
  'performance',
  'reliability',
  'maintainability',
  'hygiene',
]);

function normalizeSeverity(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'critical' || s === 'blocker' || s === 'p0' || s === 'error') return 'critical';
  if (s === 'high' || s === 'major' || s === 'p1') return 'high';
  if (s === 'medium' || s === 'moderate' || s === 'warn' || s === 'warning' || s === 'p2') return 'medium';
  if (s === 'low' || s === 'minor' || s === 'info' || s === 'nit' || s === 'p3') return 'low';
  return 'medium';
}

function normalizeCategory(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (VALID_CATEGORIES.has(c)) return c;
  if (c === 'bug' || c === 'logic') return 'correctness';
  if (c === 'perf') return 'performance';
  if (c === 'sec' || c === 'privacy') return 'security';
  if (c === 'style' || c === 'cleanup') return 'hygiene';
  return 'correctness';
}

function stripMidDot(text) {
  return String(text || '').replace(/\u00b7/g, '/');
}

function safeReadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // fail-open on missing or corrupt json
  }
  return fallback;
}

export function getReviewProjectDir(projectId, options = {}) {
  const { reviewsDir } = getDataPaths(options);
  const safeId = path.basename(String(projectId || 'default').replace(/[^A-Za-z0-9._-]/g, '_')) || 'default';
  return path.join(reviewsDir, safeId);
}

function getReviewFiles(projectId, options = {}) {
  const dir = getReviewProjectDir(projectId, options);
  return {
    dir,
    latestFile: path.join(dir, 'latest.json'),
    historyFile: path.join(dir, 'history.json'),
    ignoresFile: path.join(dir, 'ignores.json'),
  };
}

/**
 * Normalize and redact any finding into the unified ReviewFinding contract.
 */
export function normalizeReviewFinding(raw, defaultSource = 'ai_subagent') {
  if (!raw || typeof raw !== 'object') return null;

  const titleRaw = String(raw.title || raw.message || raw.summary || '').trim();
  const detailRaw = String(raw.detail || raw.description || raw.reason || raw.explanation || titleRaw).trim();
  if (!titleRaw && !detailRaw) return null;

  const source = VALID_SOURCES.has(raw.source) ? raw.source : defaultSource;
  const severity = normalizeSeverity(raw.severity);
  const category = normalizeCategory(raw.category);
  const ruleId = stripMidDot(
    String(raw.ruleId || raw.rule_id || raw.code || (source === 'ai_subagent' ? 'AI_REVIEW' : 'REVIEW')).trim()
  ).slice(0, 64);
  const file = String(raw.file || raw.path || '.')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '') || '.';
  const line = Math.max(1, Math.floor(Number(raw.line) || 1));
  const endLineNum = raw.endLine !== undefined && raw.endLine !== null ? Math.floor(Number(raw.endLine)) : null;

  const title = stripMidDot(redactText(titleRaw || detailRaw.slice(0, 120))).slice(0, 200);
  const detail = stripMidDot(redactText(detailRaw)).slice(0, 2000);
  const suggestionRaw = String(raw.suggestion || raw.fix || raw.recommendation || '').trim();
  const suggestion = suggestionRaw ? stripMidDot(redactText(suggestionRaw)).slice(0, 1200) : undefined;

  const defaultConf = source === 'ai_subagent' ? 0.8 : 1.0;
  const rawConf = Number(raw.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, Number(rawConf.toFixed(2)))) : defaultConf;

  const id =
    typeof raw.id === 'string' && /^rf_[0-9a-f]{12}$/i.test(raw.id.trim())
      ? raw.id.trim()
      : makeReviewFindingId({ ruleId, file, line, title });

  const out = {
    id,
    source,
    severity,
    category,
    ruleId,
    file,
    line,
    title,
    detail,
    confidence,
    ignored: Boolean(raw.ignored),
  };

  if (endLineNum && Number.isFinite(endLineNum) && endLineNum >= line) {
    out.endLine = endLineNum;
  }
  if (suggestion) {
    out.suggestion = suggestion;
  }
  if (typeof raw.gateId === 'string' && raw.gateId.trim()) {
    out.gateId = raw.gateId.trim();
  }
  return out;
}

/**
 * Recompute summary counters from findings (excluding ignored) and gate results.
 */
export function computeReviewSummary(findings = [], gates = []) {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: 0,
    ignoredCount: 0,
    gateStatus: 'idle',
  };

  for (const f of findings) {
    if (f.ignored) {
      counts.ignoredCount++;
      continue;
    }
    if (f.severity === 'critical') counts.critical++;
    else if (f.severity === 'high') counts.high++;
    else if (f.severity === 'medium') counts.medium++;
    else counts.low++;
    counts.total++;
  }

  const gateList = Array.isArray(gates) ? gates : [];
  if (gateList.length > 0) {
    if (gateList.some((g) => g.status === 'failed' || g.status === 'timeout')) {
      counts.gateStatus = 'failed';
    } else if (gateList.every((g) => g.status === 'passed')) {
      counts.gateStatus = 'passed';
    }
  }

  return counts;
}

function tryExtractBalancedJsonCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inStr = false;
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }
  return candidates;
}

function isReviewPayloadShape(val) {
  if (Array.isArray(val)) return true;
  if (!val || typeof val !== 'object') return false;
  return (
    Array.isArray(val.findings) ||
    Array.isArray(val.issues) ||
    Array.isArray(val.results) ||
    typeof val.overview === 'string' ||
    typeof val.summary === 'string'
  );
}

/**
 * Tolerantly parse L2 Subagent review output from pure JSON, fenced ```json``` blocks,
 * or prose-wrapped JSON objects, validating, normalizing, and redacting all findings.
 */
export function parseLooseReviewJson(rawInput) {
  let parsed = null;

  if (rawInput && typeof rawInput === 'object') {
    parsed = rawInput;
  } else {
    const text = String(rawInput ?? '').trim();
    if (!text) {
      throw new Error('Review report input is empty');
    }

    // 1. Direct JSON parse
    try {
      const direct = JSON.parse(text);
      if (isReviewPayloadShape(direct)) {
        parsed = direct;
      }
    } catch {
      // continue to fenced/balanced extraction
    }

    // 2. Markdown fenced blocks (prefer ```json blocks first, then generic ```)
    if (!parsed) {
      const fencedBlocks = [];
      const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
      let m;
      while ((m = fenceRe.exec(text)) !== null) {
        if (m[1] && m[1].trim()) {
          fencedBlocks.push(m[1].trim());
        }
      }
      for (const block of fencedBlocks) {
        try {
          const obj = JSON.parse(block);
          if (isReviewPayloadShape(obj)) {
            parsed = obj;
            break;
          }
        } catch {
          // try next fenced block
        }
      }
    }

    // 3. Balanced JSON object/array extraction from prose
    if (!parsed) {
      const candidates = tryExtractBalancedJsonCandidates(text);
      for (const cand of candidates) {
        try {
          const obj = JSON.parse(cand);
          if (isReviewPayloadShape(obj)) {
            parsed = obj;
            break;
          }
        } catch {
          // try next candidate
        }
      }
    }
  }

  if (!parsed || (!Array.isArray(parsed) && typeof parsed !== 'object')) {
    throw new Error('Unable to parse valid review JSON payload from input');
  }

  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.findings)
      ? parsed.findings
      : Array.isArray(parsed.issues)
        ? parsed.issues
        : Array.isArray(parsed.results)
          ? parsed.results
          : [];

  const deduped = [];
  const seen = new Set();
  for (const item of rawFindings) {
    const norm = normalizeReviewFinding(item, 'ai_subagent');
    if (norm && !seen.has(norm.id)) {
      seen.add(norm.id);
      deduped.push(norm);
    }
    if (deduped.length >= MAX_REPORT_FINDINGS) break;
  }

  const overviewRaw = !Array.isArray(parsed) ? (parsed.overview || (typeof parsed.summary === 'string' ? parsed.summary : '')) : '';
  const overview = stripMidDot(redactText(String(overviewRaw || '').trim())).slice(0, 1200);
  const mode = !Array.isArray(parsed) && typeof parsed.mode === 'string' ? parsed.mode.trim() : null;
  const scope = !Array.isArray(parsed) && typeof parsed.scope === 'string' ? parsed.scope.trim() : null;
  const model = !Array.isArray(parsed) && typeof parsed.model === 'string' ? stripMidDot(redactText(parsed.model.trim())).slice(0, 100) : null;

  return redactObject({
    overview,
    mode,
    scope,
    model,
    findings: sortReviewFindings(deduped),
  });
}

export function loadIgnores(projectId, options = {}) {
  const { ignoresFile } = getReviewFiles(projectId, options);
  const raw = safeReadJson(ignoresFile, null);
  const ignoredIds = Array.isArray(raw?.ignoredIds)
    ? [...new Set(raw.ignoredIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  return {
    ignoredIds,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function saveIgnores(projectId, ignoredIds, options = {}) {
  const { ignoresFile } = getReviewFiles(projectId, options);
  const cleanIds = [...new Set((Array.isArray(ignoredIds) ? ignoredIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const payload = redactObject({
    ignoredIds: cleanIds,
    updatedAt: new Date().toISOString(),
  });
  return withFileLockSync(ignoresFile, () => {
    atomicWriteJsonObj(ignoresFile, payload);
    return payload;
  });
}

function applyIgnoresToReport(report, ignoredSet) {
  if (!report || typeof report !== 'object') return null;
  const findings = Array.isArray(report.findings)
    ? report.findings.map((f) => ({
        ...f,
        ignored: ignoredSet.has(f.id),
      }))
    : [];
  const gates = Array.isArray(report.gates) ? report.gates : [];
  return {
    ...report,
    findings: sortReviewFindings(findings),
    summary: computeReviewSummary(findings, gates),
  };
}

export function loadLatestReport(projectId, options = {}) {
  const { latestFile } = getReviewFiles(projectId, options);
  const raw = safeReadJson(latestFile, null);
  if (!raw || typeof raw !== 'object') return null;
  const { ignoredIds } = loadIgnores(projectId, options);
  return applyIgnoresToReport(raw, new Set(ignoredIds));
}

export function loadHistory(projectId, options = {}) {
  const { historyFile } = getReviewFiles(projectId, options);
  const raw = safeReadJson(historyFile, null);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    items: items.slice(0, MAX_REVIEW_HISTORY),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function loadHistoryReport(projectId, reportId, options = {}) {
  const idStr = String(reportId || '').trim();
  if (!idStr) return null;
  const { ignoredIds } = loadIgnores(projectId, options);
  const ignoredSet = new Set(ignoredIds);

  const latest = loadLatestReport(projectId, options);
  if (latest && latest.reportId === idStr) {
    return latest;
  }

  const { items } = loadHistory(projectId, options);
  const hit = items.find((item) => item && item.reportId === idStr);
  return hit ? applyIgnoresToReport(hit, ignoredSet) : null;
}

export function generateReportId() {
  return `rev_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Atomically persist a redacted ReviewReport to `latest.json` and (optionally) `history.json` (max 20 entries).
 */
export function saveReviewReport(projectId, report, options = {}, { pushHistory = true } = {}) {
  const { latestFile, historyFile } = getReviewFiles(projectId, options);
  const { ignoredIds } = loadIgnores(projectId, options);
  const ignoredSet = new Set(ignoredIds);
  const now = new Date().toISOString();

  const normalizedFindings = [];
  const seen = new Set();
  for (const rawF of Array.isArray(report.findings) ? report.findings : []) {
    const f = normalizeReviewFinding(rawF, rawF?.source || 'static');
    if (f && !seen.has(f.id)) {
      seen.add(f.id);
      f.ignored = ignoredSet.has(f.id);
      normalizedFindings.push(f);
    }
    if (normalizedFindings.length >= MAX_REPORT_FINDINGS) break;
  }

  const sortedFindings = sortReviewFindings(normalizedFindings);
  const gates = Array.isArray(report.gates) ? report.gates : [];
  const summary = computeReviewSummary(sortedFindings, gates);

  const prepared = redactObject({
    reportId: report.reportId || generateReportId(),
    createdAt: report.createdAt || now,
    updatedAt: now,
    scope: report.scope || 'uncommitted',
    baseRef: report.baseRef || null,
    overview: report.overview ? stripMidDot(redactText(report.overview)).slice(0, 1200) : '',
    git: {
      projectId: report.git?.projectId || projectId,
      projectName: report.git?.projectName || '',
      repoRoot: report.git?.repoRoot || '',
      branch: report.git?.branch || 'nogit',
      head: report.git?.head || 'none',
      dirty: Boolean(report.git?.dirty),
    },
    diffStats: report.diffStats || {
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      skippedCount: 0,
      totalDiffBytes: 0,
    },
    summary,
    gates,
    findings: sortedFindings,
  });

  withFileLockSync(latestFile, () => {
    atomicWriteJsonObj(latestFile, prepared);
  });

  if (pushHistory) {
    withFileLockSync(historyFile, () => {
      const current = safeReadJson(historyFile, { items: [] });
      const prevItems = Array.isArray(current?.items) ? current.items : [];
      const filtered = prevItems.filter((item) => item && item.reportId !== prepared.reportId);
      const nextItems = [prepared, ...filtered].slice(0, MAX_REVIEW_HISTORY);
      atomicWriteJsonObj(historyFile, {
        items: nextItems,
        updatedAt: now,
      });
    });
  }

  return prepared;
}

/**
 * Toggle a finding's ignored status in `ignores.json` and update `latest.json` summary live.
 */
export function setFindingIgnored(projectId, findingId, ignored, options = {}) {
  const idStr = String(findingId || '').trim();
  if (!idStr) {
    throw new Error('findingId is required');
  }

  const current = loadIgnores(projectId, options);
  const set = new Set(current.ignoredIds);
  if (ignored) {
    set.add(idStr);
  } else {
    set.delete(idStr);
  }
  const ignores = saveIgnores(projectId, [...set], options);

  const { latestFile } = getReviewFiles(projectId, options);
  let report = null;
  withFileLockSync(latestFile, () => {
    const rawLatest = safeReadJson(latestFile, null);
    if (rawLatest && typeof rawLatest === 'object') {
      const updated = redactObject(applyIgnoresToReport(rawLatest, set));
      updated.updatedAt = new Date().toISOString();
      atomicWriteJsonObj(latestFile, updated);
      report = updated;
    }
  });

  return { ignores, report };
}
