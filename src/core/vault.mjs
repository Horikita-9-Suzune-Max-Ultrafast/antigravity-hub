import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths, formatDisplayPath } from './paths.mjs';
import { redactText } from './redact.mjs';
import { getGitContext, getCommitsAhead } from './git-context.mjs';
import {
  atomicWriteFile,
  appendJsonl,
  ensureDataDirs,
  parseMemoryMarkdown,
  serializeMemoryMarkdown,
} from './storage.mjs';
import { ensureIndexReady, upsertMemoryRow, withIndexDb } from './index-db.mjs';
import { loadConfig } from './config.mjs';

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

  // Check HEAD staleness
  let maxCommitsAhead = 0;
  let staleCount = 0;
  let diverged = false;
  if (git.isGitRepo && git.head !== 'unborn') {
    for (const item of items) {
      if (item.head && item.head !== 'none' && item.head !== git.head) {
        staleCount++;
        const ahead = getCommitsAhead(git.repoRoot, item.head);
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

/**
 * Build dual-view Handoff Capsule (Human structured cards + compact Agent payload < 500 tokens).
 */
export function buildHandoffCapsule(params = {}, options = {}) {
  const config = loadConfig(options);
  const hardBudget = Math.min(490, Math.max(180, Number(params.budgetTokens) || config.sessionStartBudgetTokens || 450));
  const git = getGitContext(params.projectDir || options.projectDir);

  const memories = listMemories({ projectId: git.projectId, limit: 30 }, options);
  const workingState = memories.find((m) => m.kind === 'working_state');
  const checkpoint = memories.find((m) => m.kind === 'checkpoint');

  const decisionCandidates = memories
    .filter((m) => m.kind === 'decision' || m.kind === 'pitfall' || m.kind === 'architecture')
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      text: redactText(m.title + (m.summary ? ` — ${m.summary.replace(/\s+/g, ' ').slice(0, 80)}` : '')),
      tokens: estimateTokens(m.title + ' ' + m.summary.slice(0, 80)),
      checked: true,
    }));

  const selectedSet = Array.isArray(params.selectedDecisionIds) ? new Set(params.selectedDecisionIds) : null;
  if (selectedSet) {
    for (const d of decisionCandidates) {
      d.checked = selectedSet.has(d.id);
    }
  }

  const activeGoal = redactText(
    params.activeGoal ||
      workingState?.title ||
      checkpoint?.title ||
      `继续推进 ${git.projectName} (${git.branch}) 开发任务`
  );
  const touchedFiles = (Array.isArray(params.touchedFiles) ? params.touchedFiles : [])
    .map((f) => redactText(String(f).trim()))
    .filter(Boolean)
    .slice(0, 8);
  const nextAction = redactText(
    params.nextAction ||
      workingState?.summary?.replace(/\s+/g, ' ').slice(0, 140) ||
      '承接上述已敲定决策继续实现与验证'
  );

  // Assemble strictly within hardBudget tokens
  const header = `[CTX-CAPSULE] project=${git.projectName} branch=${git.branch}@${git.head}${git.dirty ? '*' : ''}`;
  const goalLine = `- Active Goal: ${activeGoal}`;
  const filesLine = touchedFiles.length ? `- Touched Files: ${touchedFiles.join(', ')}` : '';
  const nextLine = `- Next Action: ${nextAction}`;

  const baseLines = [header, goalLine, '- Settled Decisions:'];
  const tailLines = [filesLine, nextLine].filter(Boolean);
  let usedTokens = estimateTokens([...baseLines, ...tailLines].join('\n'));

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

  const decLines = selectedDecisions.length
    ? selectedDecisions.map((d, i) => `  ${i + 1}. ${d.text}`)
    : ['  (none selected)'];

  const agentPayload = [...baseLines, ...decLines, ...tailLines].join('\n');
  const tokens = estimateTokens(agentPayload);

  return {
    project: git.projectName,
    branch: git.branch,
    head: git.head,
    activeGoal,
    decisions: decisionCandidates,
    touchedFiles,
    nextAction,
    agentPayload,
    tokens,
    budgetTokens: hardBudget,
  };
}
