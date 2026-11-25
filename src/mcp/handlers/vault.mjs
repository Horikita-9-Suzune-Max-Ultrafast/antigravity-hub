import path from 'node:path';
import { getDataPaths, formatDisplayPath } from '../../core/paths.mjs';
import { getGitContext } from '../../core/git-context.mjs';
import {
  saveMemory,
  archiveMemory,
  listMemories,
  searchMemories,
  buildCompactBrief,
  buildHandoffCapsule,
} from '../../core/vault.mjs';
import { resolveTargetSession, getSessionProjectDir } from '../../core/session-tracker.mjs';
import { listConversations } from '../../core/transcript-parser.mjs';

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function toolErr(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message || 'Unknown error') }],
  };
}

export function handleCtxBrief(args, { projectDir, options }) {
  const brief = buildCompactBrief({ projectDir, budgetTokens: args.budgetTokens }, options);
  const text =
    brief.text ||
    `[CTX-BRIEF] project=${brief.git.projectName} branch=${brief.git.branch}@${brief.git.head} (no saved memories yet)`;
  return toolOk(text, brief);
}

export function handleCtxSave(args, { projectDir, options }) {
  const saved = saveMemory(
    {
      projectDir,
      kind: args.kind || 'decision',
      title: args.title,
      summary: args.summary,
      tags: args.tags,
    },
    options
  );
  return toolOk(`已写入记忆 [${saved.kind}] ${saved.title} (${saved.id})`, saved);
}

export function handleCtxSearch(args, { projectDir, options }) {
  const items = searchMemories(
    {
      projectDir,
      query: args.query,
      kind: args.kind || 'all',
      limit: args.limit || 20,
    },
    options
  );
  const text = items.length
    ? items.map((m) => `- [${m.kind}] ${m.title} (${m.branch}@${m.head}): ${m.summary.slice(0, 120)}`).join('\n')
    : `未找到匹配 "${args.query}" 的项目记忆。`;
  return toolOk(text, { query: args.query, count: items.length, items });
}

export function handleVaultManage(args, { defaultWorkspace, options }) {
  const paths = getDataPaths(options);
  let vaultProjectDir = args.projectDir || '';
  let resolvedConvId = args.conversationId || null;
  let resolvedTranscriptPath = '';

  if (!vaultProjectDir || args.action === 'capsule') {
    if (args.conversationId) {
      if (!vaultProjectDir) {
        vaultProjectDir = getSessionProjectDir(args.conversationId, defaultWorkspace, options);
      }
    } else {
      const target = resolveTargetSession(
        {
          followActive: true,
          sessions: listConversations({ ...options, limit: 1 }),
          fallbackProjectDir: defaultWorkspace,
        },
        options
      );
      if (!vaultProjectDir) {
        vaultProjectDir = target.projectDir || defaultWorkspace;
      }
      if (!resolvedConvId && target.conversationId) {
        resolvedConvId = target.conversationId;
      }
      if (target.transcriptPath) {
        resolvedTranscriptPath = target.transcriptPath;
      }
    }
  }

  const git = getGitContext(vaultProjectDir);
  const storagePath = formatDisplayPath(path.join(paths.projectsDir, git.projectId));

  if (args.action === 'list') {
    const items = args.query
      ? searchMemories({ projectDir: vaultProjectDir, query: args.query, kind: args.kind || 'all', limit: 60 }, options)
      : listMemories({ projectDir: vaultProjectDir, kind: args.kind || 'all', limit: 60 }, options);
    const brief = buildCompactBrief({ projectDir: vaultProjectDir }, options);
    return toolOk('ok', {
      items,
      git,
      storagePath,
      commitsAhead: brief.commitsAhead,
      staleCount: brief.staleCount,
    });
  }
  if (args.action === 'save') {
    const saved = saveMemory(
      {
        projectDir: vaultProjectDir,
        kind: args.kind || 'decision',
        title: args.title,
        summary: args.summary,
        tags: args.tags || ['manual'],
      },
      options
    );
    return toolOk('saved', {
      saved,
      items: listMemories({ projectDir: vaultProjectDir, limit: 60 }, options),
      git,
      storagePath,
    });
  }
  if (args.action === 'archive') {
    const res = archiveMemory(args.id, options);
    return toolOk('archived', {
      ...res,
      items: listMemories({ projectDir: vaultProjectDir, limit: 60 }, options),
      git,
      storagePath,
    });
  }
  if (args.action === 'capsule') {
    const capsule = buildHandoffCapsule(
      {
        projectDir: vaultProjectDir,
        conversationId: resolvedConvId || undefined,
        transcriptPath: resolvedTranscriptPath || undefined,
        budgetPreset: args.budgetPreset,
        budgetTokens: args.budgetTokens,
        selectedDecisionIds: args.selectedDecisionIds,
        selectedFiles: args.selectedFiles,
        selectedArtifacts: args.selectedArtifacts,
        activeGoal: args.activeGoal,
        touchedFiles: args.touchedFiles,
        artifacts: args.artifacts,
        nextAction: args.nextAction,
      },
      options
    );
    return toolOk('ok', capsule);
  }
  return toolErr(`Unsupported vault action: ${args.action}`);
}
