import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, formatDisplayPath, findTranscriptPath } from './paths.mjs';
import { redactText } from './redact.mjs';
import { getGitContext, getCommitsAhead, getGitWorkingSummary } from './git-context.mjs';
import {
  atomicWriteFile,
  appendJsonl,
  ensureDataDirs,
  parseMemoryMarkdown,
  serializeMemoryMarkdown,
} from './storage.mjs';
import { ensureIndexReady, upsertMemoryRow, withIndexDb } from './index-db.mjs';
import { loadConfig } from './config.mjs';
import { extractTranscriptHandoffContext } from './transcript-parser.mjs';
import { resolveTargetSession } from './session-tracker.mjs';

export const VALID_MEMORY_KINDS = ['working_state', 'decision', 'architecture', 'pitfall', 'checkpoint'];

const KIND_PRIORITY = {
  working_state: 1,
  decision: 2,
  pitfall: 3,
  architecture: 4,
  checkpoint: 5,
};

/**
 * Deterministic CJK/ASCII mixed token estimator.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.max(1, Math.ceil(cjk * 0.9 + ascii / 3.8));
}

function rowToMemory(row) {
  let tags = [];
  try {
    tags = JSON.parse(row.tags_json || '[]');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    branch: row.branch,
    head: row.head,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    tags,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filePath: row.file_path,
  };
}

function sanitizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/);
  return [...new Set(arr.map((t) => redactText(String(t).trim().replace(/^#/, ''))).filter(Boolean))].slice(0, 12);
}

/**
 * Save a memory entry to Markdown truth source (auto-redacted) + append-only event log + SQLite FTS5.
 */
export function saveMemory(input, options = {}) {
  const paths = ensureDataDirs(options);
  ensureIndexReady(options);
  const git = getGitContext(input.projectDir || options.projectDir);
  const kind = VALID_MEMORY_KINDS.includes(input.kind) ? input.kind : 'decision';
  const now = new Date().toISOString();
  const id = input.id || `mem_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

  const projectId = input.projectId || git.projectId;
  const branch = input.branch || git.branch;
  const head = input.head || git.head;
  const title = redactText(String(input.title || '').trim()).slice(0, 200);
  const summary = redactText(String(input.summary || '').trim());
  const tags = sanitizeTags(input.tags);

  if (!title) throw new Error('Memory title is required');

  const projDir = path.join(paths.projectsDir, projectId);
  const memFile = path.join(projDir, 'memories', `${id}.md`);

  const record = {
    id,
    projectId,
    branch,
    head,
    kind,
    title,
    summary,
    tags,
    archived: false,
    createdAt: input.createdAt || now,
    updatedAt: now,
    filePath: memFile,
  };

  atomicWriteFile(memFile, serializeMemoryMarkdown(record));
  appendJsonl(path.join(projDir, 'events.jsonl'), {
    op: 'save',
    ts: now,
    id: record.id,
    kind: record.kind,
    branch: record.branch,
    head: record.head,
    title: record.title,
  });

  withIndexDb(options, (db) => {
    upsertMemoryRow(db, record);
  });

  return record;
}

/**
 * Soft-archive a memory entry (updates Markdown truth source, never deletes truth file).
 */
export function archiveMemory(id, options = {}) {
  if (!id) throw new Error('Memory id is required');
  ensureIndexReady(options);

  let target = withIndexDb(options, (db) => {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return row ? rowToMemory(row) : null;
  });

  if (!target) {
    return { archived: false, id, error: 'Memory not found' };
  }

  const now = new Date().toISOString();
  target.archived = true;
  target.updatedAt = now;

  if (target.filePath && fs.existsSync(target.filePath)) {
    const current = parseMemoryMarkdown(fs.readFileSync(target.filePath, 'utf8'), target.filePath);
    if (current) {
      target = { ...current, archived: true, updatedAt: now, filePath: target.filePath };
    }
    atomicWriteFile(target.filePath, serializeMemoryMarkdown(target));
  }

  const paths = getDataPaths(options);
  appendJsonl(path.join(paths.projectsDir, target.projectId, 'events.jsonl'), {
    op: 'archive',
    ts: now,
    id: target.id,
  });

  withIndexDb(options, (db) => {
    upsertMemoryRow(db, target);
  });

  return { archived: true, id: target.id };
}

/**
 * Soft-archive oldest auto-generated Stop checkpoints beyond maxKeep (default 30)
 * so active memory count stays bounded without deleting Markdown truth files.
 */
export function pruneAutoStopCheckpoints(projectId, { maxKeep = 30 } = {}, options = {}) {
  if (!projectId) return { pruned: 0 };
  const keep = Math.max(1, Math.min(200, Number(maxKeep) || 30));
  ensureIndexReady(options);
  const rows = withIndexDb(options, (db) =>
    db
      .prepare(
        `SELECT id, title, tags_json FROM memories
         WHERE project_id = ? AND kind = 'checkpoint' AND archived = 0
         ORDER BY updated_at DESC`
      )
      .all(projectId)
  );
  const autoStops = rows.filter((r) => {
    const t = String(r.title || '');
    const tags = String(r.tags_json || '');
    return t.startsWith('Stop 自动快照') || tags.includes('"auto-stop"');
  });
  if (autoStops.length <= keep) return { pruned: 0 };

  let pruned = 0;
  for (const old of autoStops.slice(keep)) {
    const res = archiveMemory(old.id, options);
    if (res?.archived) pruned++;
  }
  return { pruned };
}

/**
 * List memories for a project (optionally filtered by branch, kind, archived).
 */
export function listMemories(params = {}, options = {}) {
  ensureIndexReady(options);
  const git = params.projectId ? null : getGitContext(params.projectDir || options.projectDir);
  const projectId = params.projectId || (git ? git.projectId : null);
  const includeArchived = Boolean(params.includeArchived);
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));

  const rows = withIndexDb(options, (db) => {
    const clauses = [];
    const args = [];
    if (projectId && !params.allProjects) {
      clauses.push('project_id = ?');
      args.push(projectId);
    }
    if (params.branch && params.branch !== 'all') {
      clauses.push('branch = ?');
      args.push(params.branch);
    }
    if (params.kind && params.kind !== 'all') {
      clauses.push('kind = ?');
      args.push(params.kind);
    }
    if (!includeArchived) {
      clauses.push('archived = 0');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    args.push(limit);
    return db.prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args);
  });

  return rows.map(rowToMemory);
}

/**
 * FTS5 full-text search across project memories, with safe LIKE fallback for punctuation/CJK queries.
 */
export function searchMemories(params = {}, options = {}) {
  ensureIndexReady(options);
  const query = String(params.query || '').trim();
  if (!query) return listMemories(params, options);

  const git = params.projectId ? null : getGitContext(params.projectDir || options.projectDir);
  const projectId = params.projectId || (git ? git.projectId : null);
  const includeArchived = Boolean(params.includeArchived);
  const limit = Math.max(1, Math.min(100, Number(params.limit) || 30));

  const tokens = query
    .replace(/["'()*:^~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  return withIndexDb(options, (db) => {
    let rows = [];
    if (tokens.length > 0) {
      const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
      try {
        const clauses = ['memories_fts MATCH ?'];
        const args = [ftsQuery];
        if (projectId && !params.allProjects) {
          clauses.push('m.project_id = ?');
          args.push(projectId);
        }
        if (params.kind && params.kind !== 'all') {
          clauses.push('m.kind = ?');
          args.push(params.kind);
        }
        if (!includeArchived) {
          clauses.push('m.archived = 0');
        }
        args.push(limit);
        rows = db
          .prepare(
            `SELECT m.* FROM memories_fts
             JOIN memories m ON m.id = memories_fts.id
             WHERE ${clauses.join(' AND ')}
             ORDER BY bm25(memories_fts), m.updated_at DESC
             LIMIT ?`
          )
          .all(...args);
      } catch {
        rows = [];
      }
    }

    // Fallback substring LIKE search (especially helpful for CJK substrings)
    if (rows.length === 0) {
      const like = `%${query}%`;
      const clauses = ['(title LIKE ? OR summary LIKE ? OR tags_json LIKE ?)'];
      const args = [like, like, like];
      if (projectId && !params.allProjects) {
        clauses.push('project_id = ?');
        args.push(projectId);
      }
      if (params.kind && params.kind !== 'all') {
        clauses.push('kind = ?');
        args.push(params.kind);
      }
      if (!includeArchived) {
        clauses.push('archived = 0');
      }
      args.push(limit);
      rows = db
        .prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
        .all(...args);
    }

    return rows.map(rowToMemory);
  });
}

/**
 * Build a strictly budgeted (< 500 tokens) Compact Brief for SessionStart or ctx_brief.
 * Returns empty text when no active memories exist for the project/branch.
 */
export function buildCompactBrief(params = {}, options = {}) {
  const config = loadConfig(options);
  const hardBudget = Math.min(490, Math.max(150, Number(params.budgetTokens) || config.sessionStartBudgetTokens || 450));
  const git = getGitContext(params.projectDir || options.projectDir);

  let items = listMemories(
    {
      projectId: git.projectId,
      branch: git.branch,
      limit: 40,
    },
    options
  );

  // If branch has no dedicated memories, fall back to project-level architecture/decision/pitfall
  let branchFallback = false;
  if (items.length === 0) {
    items = listMemories({ projectId: git.projectId, limit: 20 }, options);
    branchFallback = items.length > 0;
  }

  const paths = getDataPaths(options);
  const projectStoragePath = formatDisplayPath(path.join(paths.projectsDir, git.projectId));

  if (items.length === 0) {
    return {
      text: '',
      tokens: 0,
      budgetTokens: hardBudget,
      count: 0,
      staleCount: 0,
      commitsAhead: 0,
      git,
      projectStoragePath,
    };
  }

  // Sort by kind priority, then recency
  items.sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind] || 9;
    const pb = KIND_PRIORITY[b.kind] || 9;
    if (pa !== pb) return pa - pb;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  // Check HEAD staleness (deduplicated & capped at max 10 unique stale heads per call)
  let maxCommitsAhead = 0;
  let staleCount = 0;
  let diverged = false;
  const MAX_STALE_HEAD_CHECKS = 10;
  if (git.isGitRepo && git.head !== 'unborn') {
    const checkedHeads = new Map();
    for (const item of items) {
      if (item.head && item.head !== 'none' && item.head !== git.head) {
        staleCount++;
        const headKey = String(item.head).toLowerCase();
        if (checkedHeads.has(headKey)) {
          continue;
        }
        if (checkedHeads.size >= MAX_STALE_HEAD_CHECKS) {
          continue;
        }
        const ahead = getCommitsAhead(git.repoRoot, item.head, git.head);
        checkedHeads.set(headKey, ahead);
        if (ahead === -1) diverged = true;
        else if (ahead > maxCommitsAhead) maxCommitsAhead = ahead;
      }
    }
  }

  const staleTag =
    maxCommitsAhead > 0
      ? ` stale=+${maxCommitsAhead}commits`
      : diverged
        ? ' stale=diverged'
        : staleCount > 0
          ? ' stale=head-changed'
          : '';
  const fallbackTag = branchFallback ? ' scope=project-fallback' : '';

  const header = `[CTX-BRIEF] project=${git.projectName} branch=${git.branch}@${git.head}${git.dirty ? '*' : ''}${staleTag}${fallbackTag}`;
  const lines = [header];
  let usedTokens = estimateTokens(header);
  let includedCount = 0;

  for (const item of items) {
    const shortSummary = item.summary.replace(/\s+/g, ' ').slice(0, 140);
    const line = `- [${item.kind}] ${item.title}${shortSummary ? `: ${shortSummary}` : ''}`;
    const lineTok = estimateTokens(line) + 1;
    if (usedTokens + lineTok > hardBudget) {
      // Try title-only compact version if room permits
      const compactLine = `- [${item.kind}] ${item.title}`;
      const compactTok = estimateTokens(compactLine) + 1;
      if (usedTokens + compactTok <= hardBudget) {
        lines.push(compactLine);
        usedTokens += compactTok;
        includedCount++;
      }
      break;
    }
    lines.push(line);
    usedTokens += lineTok;
    includedCount++;
  }

  const text = lines.join('\n');
  return {
    text,
    tokens: estimateTokens(text),
    budgetTokens: hardBudget,
    count: includedCount,
    totalAvailable: items.length,
    staleCount,
    commitsAhead: maxCommitsAhead,
    diverged,
    git,
    projectStoragePath,
  };
}

export const CAPSULE_BUDGET_PRESETS = {
  compact: 500,
  standard: 1200,
  full: 2500,
};

function resolveCapsuleBudget(params = {}, config = {}) {
  const presetRaw = typeof params.budgetPreset === 'string' ? params.budgetPreset.trim().toLowerCase() : '';
  const hasPreset = Object.prototype.hasOwnProperty.call(CAPSULE_BUDGET_PRESETS, presetRaw);
  const hasExplicitTokens = params.budgetTokens != null && Number.isFinite(Number(params.budgetTokens));

  if (hasPreset) {
    const budgetTokens = hasExplicitTokens
      ? Math.min(2500, Math.max(180, Math.round(Number(params.budgetTokens))))
      : CAPSULE_BUDGET_PRESETS[presetRaw];
    return { budgetPreset: presetRaw, hardBudget: budgetTokens };
  }
  if (hasExplicitTokens) {
    const budgetTokens = Math.min(2500, Math.max(180, Math.round(Number(params.budgetTokens))));
    const budgetPreset = budgetTokens <= 650 ? 'compact' : budgetTokens <= 1600 ? 'standard' : 'full';
    return { budgetPreset, hardBudget: budgetTokens };
  }
  // Default backward-compatible compact budget (< 500 tokens)
  const hardBudget = Math.min(490, Math.max(180, Number(config.sessionStartBudgetTokens) || 450));
  return { budgetPreset: 'compact', hardBudget };
}

/**
 * Build dual-view Handoff Capsule (0 LLM tokens):
 * - 3-source auto-aggregation: Vault memories + active transcript.jsonl + live Git working tree & commits
 * - 3-tier budgets: compact (500t) / standard (1200t) / full (2500t), backward-compatible default (<500t)
 * - Customizable activeGoal, nextAction, and selectable decisions / changed files / artifacts
 */
export function buildHandoffCapsule(params = {}, options = {}) {
  const config = loadConfig(options);
  const { budgetPreset, hardBudget } = resolveCapsuleBudget(params, config);
  const projectDir = params.projectDir || options.projectDir || process.cwd();
  const git = getGitContext(projectDir);

  const tierLimits =
    budgetPreset === 'full'
      ? { decisionSummaryChars: 500, nextActionChars: 800, maxDecisions: 30, maxFiles: 30, maxArtifacts: 16 }
      : budgetPreset === 'standard'
        ? { decisionSummaryChars: 220, nextActionChars: 360, maxDecisions: 16, maxFiles: 20, maxArtifacts: 8 }
        : { decisionSummaryChars: 80, nextActionChars: 140, maxDecisions: 8, maxFiles: 10, maxArtifacts: 4 };

  // Source 1: Vault memories
  const memories = listMemories({ projectId: git.projectId, limit: 40 }, options);
  const workingState = memories.find((m) => m.kind === 'working_state');
  const checkpoint = memories.find((m) => m.kind === 'checkpoint');

  const decisionCandidates = memories
    .filter((m) => m.kind === 'decision' || m.kind === 'pitfall' || m.kind === 'architecture')
    .slice(0, tierLimits.maxDecisions)
    .map((m) => {
      const cleanSummary = m.summary ? m.summary.replace(/\s+/g, ' ').slice(0, tierLimits.decisionSummaryChars) : '';
      const text = redactText(m.title + (cleanSummary ? ` — ${cleanSummary}` : ''));
      return {
        id: m.id,
        kind: m.kind,
        text,
        tokens: estimateTokens(text),
        checked: true,
      };
    });

  const selectedDecisionSet = Array.isArray(params.selectedDecisionIds) ? new Set(params.selectedDecisionIds) : null;
  if (selectedDecisionSet) {
    for (const d of decisionCandidates) {
      d.checked = selectedDecisionSet.has(d.id);
    }
  }

  // Source 2: Active session transcript.jsonl (recent user requests, edited files, produced artifacts)
  let resolvedConvId = params.conversationId ? String(params.conversationId).trim() : null;
  let resolvedTranscriptPath = params.transcriptPath ? String(params.transcriptPath).trim() : '';
  if (!resolvedTranscriptPath && resolvedConvId) {
    resolvedTranscriptPath = findTranscriptPath(resolvedConvId, options) || '';
  } else if (!resolvedTranscriptPath && params.includeActiveTranscript !== false) {
    const target = resolveTargetSession(
      {
        followActive: true,
        fallbackProjectDir: projectDir,
      },
      options
    );
    const sameProject =
      target.projectDir &&
      path.resolve(target.projectDir).toLowerCase() === path.resolve(git.repoRoot || projectDir).toLowerCase();
    if (target.transcriptPath && (options.appDataDir || sameProject)) {
      resolvedConvId = resolvedConvId || target.conversationId || null;
      resolvedTranscriptPath = target.transcriptPath;
    }
  }

  const transcriptCtx = extractTranscriptHandoffContext(resolvedTranscriptPath, {
    projectDir: git.repoRoot || projectDir,
    maxRequests: 3,
    maxFiles: tierLimits.maxFiles,
    maxArtifacts: tierLimits.maxArtifacts,
  });
  const recentUserRequests = transcriptCtx.recentUserRequests.map((r) => redactText(r));
  const latestUserRequest = redactText(transcriptCtx.latestUserRequest);

  // Source 3: Live Git working tree changes (M/A/?) & recent 2 commits
  const gitSummary = getGitWorkingSummary(projectDir, { commitLimit: 2, fileLimit: 30 });
  const recentCommits = gitSummary.recentCommits.map((c) => ({
    sha: c.sha,
    subject: redactText(c.subject),
  }));

  // Merge touched/changed files (manual + git + transcript), deduplicated
  const fileMap = new Map();
  const upsertFile = (rawPath, status, source) => {
    const clean = redactText(String(rawPath || '').trim().replace(/\\/g, '/'));
    if (!clean) return;
    const key = clean.toLowerCase();
    const existing = fileMap.get(key);
    if (existing) {
      if (existing.source !== source && !existing.source.includes(source)) {
        existing.source = `${existing.source}+${source}`;
      }
      if (existing.status === 'edited' || existing.status === 'manual') {
        if (status === 'M' || status === 'A' || status === '?' || status === 'D' || status === 'R') {
          existing.status = status;
        }
      }
      return;
    }
    const label = status && status !== 'manual' && status !== 'edited' ? `${clean} (${status})` : clean;
    fileMap.set(key, {
      path: clean,
      status,
      source,
      tokens: estimateTokens(label),
      checked: true,
    });
  };

  for (const f of Array.isArray(params.touchedFiles) ? params.touchedFiles : []) {
    upsertFile(f, 'manual', 'manual');
  }
  for (const gf of gitSummary.changedFiles) {
    upsertFile(gf.path, gf.status, 'git');
  }
  for (const tf of transcriptCtx.editedFiles) {
    upsertFile(tf, 'edited', 'transcript');
  }

  const fileItems = [...fileMap.values()].slice(0, tierLimits.maxFiles);
  const selectedFileSet = Array.isArray(params.selectedFiles)
    ? new Set(params.selectedFiles.map((f) => String(f).trim().replace(/\\/g, '/').toLowerCase()))
    : null;
  if (selectedFileSet) {
    for (const fi of fileItems) {
      fi.checked = selectedFileSet.has(fi.path.toLowerCase());
    }
  }

  // Merge Artifacts (transcript + explicit params.artifacts)
  const artifactMap = new Map();
  const addArtifactItem = (item) => {
    const rawPath = typeof item === 'string' ? item : item?.path || item?.displayPath || '';
    const cleanPath = redactText(String(rawPath).trim());
    if (!cleanPath) return;
    const displayPath = redactText(
      typeof item === 'object' && item?.displayPath ? item.displayPath : formatDisplayPath(cleanPath)
    );
    const name = redactText(typeof item === 'object' && item?.name ? item.name : path.basename(cleanPath));
    const key = cleanPath.toLowerCase();
    if (artifactMap.has(key)) return;
    artifactMap.set(key, {
      path: cleanPath,
      displayPath,
      name,
      tokens: estimateTokens(displayPath),
      checked: true,
    });
  };

  for (const a of transcriptCtx.artifacts) addArtifactItem(a);
  for (const a of Array.isArray(params.artifacts) ? params.artifacts : []) addArtifactItem(a);

  const artifactItems = [...artifactMap.values()].slice(0, tierLimits.maxArtifacts);
  const selectedArtifactSet = Array.isArray(params.selectedArtifacts)
    ? new Set(params.selectedArtifacts.map((a) => String(a).trim().toLowerCase()))
    : null;
  if (selectedArtifactSet) {
    for (const ai of artifactItems) {
      ai.checked =
        selectedArtifactSet.has(ai.path.toLowerCase()) ||
        selectedArtifactSet.has(ai.displayPath.toLowerCase()) ||
        selectedArtifactSet.has(ai.name.toLowerCase());
    }
  }

  // Active Goal & Next Action (user custom overrides auto-extracted)
  const activeGoal = redactText(
    (typeof params.activeGoal === 'string' && params.activeGoal.trim()) ||
      workingState?.title ||
      latestUserRequest ||
      checkpoint?.title ||
      `继续推进 ${git.projectName} (${git.branch}) 开发任务`
  );
  const nextAction = redactText(
    (typeof params.nextAction === 'string' && params.nextAction.trim()) ||
      workingState?.summary?.replace(/\s+/g, ' ').slice(0, tierLimits.nextActionChars) ||
      (latestUserRequest ? '承接当前会话诉求继续实现与验证' : '承接上述已敲定决策继续实现与验证')
  );

  // Assemble strictly within hardBudget tokens
  const header = `[CTX-CAPSULE] project=${git.projectName} branch=${git.branch}@${git.head}${git.dirty ? '*' : ''}`;
  const goalLine = `- Active Goal: ${activeGoal}`;
  const nextLine = `- Next Action: ${nextAction}`;

  let usedTokens = estimateTokens([header, goalLine, '- Settled Decisions:', nextLine].join('\n'));

  // 1) Fit selected decisions
  const selectedDecisions = [];
  for (const d of decisionCandidates) {
    if (!d.checked) continue;
    const candidateLine = `  ${selectedDecisions.length + 1}. ${d.text}`;
    const lineTok = estimateTokens(candidateLine) + 1;
    if (usedTokens + lineTok <= hardBudget) {
      selectedDecisions.push(d);
      usedTokens += lineTok;
    } else {
      d.checked = false;
    }
  }

  // 2) Fit selected touched/changed files
  const includedFiles = [];
  for (const fi of fileItems) {
    if (!fi.checked) continue;
    const tag = fi.status && fi.status !== 'manual' && fi.status !== 'edited' ? ` (${fi.status})` : '';
    const entry = `${fi.path}${tag}`;
    const extraTok =
      includedFiles.length === 0 ? estimateTokens(`- Touched Files: ${entry}`) + 1 : estimateTokens(`, ${entry}`);
    if (usedTokens + extraTok <= hardBudget) {
      includedFiles.push({ item: fi, entry });
      usedTokens += extraTok;
    } else {
      fi.checked = false;
    }
  }

  // 3) Fit selected artifacts
  const includedArtifacts = [];
  for (const ai of artifactItems) {
    if (!ai.checked) continue;
    const entry = ai.displayPath || ai.path;
    const extraTok =
      includedArtifacts.length === 0 ? estimateTokens(`- Artifacts: ${entry}`) + 1 : estimateTokens(`, ${entry}`);
    if (usedTokens + extraTok <= hardBudget) {
      includedArtifacts.push({ item: ai, entry });
      usedTokens += extraTok;
    } else {
      ai.checked = false;
    }
  }

  // 4) Fit recent Git commits (up to 2)
  let commitsLine = '';
  if (recentCommits.length > 0) {
    const commitStr = recentCommits.map((c) => `${c.sha} ${c.subject.slice(0, 72)}`).join('; ');
    const candidate = `- Recent Commits: ${commitStr}`;
    const tok = estimateTokens(candidate) + 1;
    if (usedTokens + tok <= hardBudget) {
      commitsLine = candidate;
      usedTokens += tok;
    }
  }

  const decLines = selectedDecisions.length
    ? selectedDecisions.map((d, i) => `  ${i + 1}. ${d.text}`)
    : ['  (none selected)'];
  const filesLine = includedFiles.length ? `- Touched Files: ${includedFiles.map((f) => f.entry).join(', ')}` : '';
  const artifactsLine = includedArtifacts.length
    ? `- Artifacts: ${includedArtifacts.map((a) => a.entry).join(', ')}`
    : '';

  const payloadLines = [
    header,
    goalLine,
    ...(commitsLine ? [commitsLine] : []),
    '- Settled Decisions:',
    ...decLines,
    ...(filesLine ? [filesLine] : []),
    ...(artifactsLine ? [artifactsLine] : []),
    nextLine,
  ];

  const agentPayload = payloadLines.join('\n');
  const tokens = estimateTokens(agentPayload);

  return {
    project: git.projectName,
    branch: git.branch,
    head: git.head,
    dirty: git.dirty,
    conversationId: resolvedConvId,
    budgetPreset,
    budgetTokens: hardBudget,
    budgetPresets: CAPSULE_BUDGET_PRESETS,
    activeGoal,
    decisions: decisionCandidates,
    touchedFiles: includedFiles.map((f) => f.item.path),
    fileItems,
    artifacts: includedArtifacts.map((a) => a.item.displayPath || a.item.path),
    artifactItems,
    recentCommits,
    recentUserRequests,
    sources: {
      vaultDecisions: decisionCandidates.length,
      gitChangedFiles: gitSummary.changedFiles.length,
      gitRecentCommits: recentCommits.length,
      transcriptFiles: transcriptCtx.editedFiles.length,
      transcriptArtifacts: transcriptCtx.artifacts.length,
      transcriptRequests: recentUserRequests.length,
    },
    nextAction,
    agentPayload,
    tokens,
  };
}
