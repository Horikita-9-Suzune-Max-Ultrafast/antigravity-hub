import { handleReviewAction } from '../../core/review/index.mjs';
import { getSessionProjectDir, resolveTargetSession } from '../../core/session-tracker.mjs';
import { listConversations } from '../../core/transcript-parser.mjs';

export const APP_REVIEW_TOOL_DEF = {
  name: 'app_review_manage',
  title: 'App: Local Code Review & Subagent Gatekeeper',
  description:
    'Private UI tool for deterministic L1 diff preflight, project native gate execution, isolated Subagent L2 prompt generation, report ingestion, and batch fix prompt building.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'status',
          'scan',
          'run_gate',
          'build_subagent_prompt',
          'ingest_report',
          'set_ignore',
          'build_fix_prompt',
          'history',
        ],
      },
      projectDir: { type: 'string' },
      conversationId: { type: 'string' },
      scope: { type: 'string', enum: ['uncommitted', 'staged', 'last_commit', 'branch'] },
      baseRef: { type: 'string' },
      mode: { type: 'string', enum: ['fast', 'deep'] },
      budgetTokens: { type: 'number' },
      gateId: { type: 'string' },
      rawReport: { type: 'string' },
      findingId: { type: 'string' },
      findingIds: { type: 'array', items: { type: 'string' } },
      ignored: { type: 'boolean' },
      reportId: { type: 'string' },
    },
    additionalProperties: false,
  },
  _meta: { ui: { visibility: ['app'] } },
};

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

function resolveReviewProjectDir(args = {}, options = {}) {
  const defaultWorkspace =
    options.defaultWorkspace || options.projectDir || process.env.CONTEXT_CACHE_WORKSPACE || process.cwd();

  if (typeof args.projectDir === 'string' && args.projectDir.trim()) {
    return args.projectDir.trim();
  }
  if (typeof args.conversationId === 'string' && args.conversationId.trim()) {
    return getSessionProjectDir(args.conversationId.trim(), defaultWorkspace, options) || defaultWorkspace;
  }
  try {
    const target = resolveTargetSession(
      {
        followActive: true,
        sessions: listConversations({ ...options, limit: 1 }),
        fallbackProjectDir: defaultWorkspace,
      },
      options
    );
    return target?.projectDir || defaultWorkspace;
  } catch {
    return defaultWorkspace;
  }
}

/**
 * Self-contained MCP tool dispatcher for `app_review_manage` (ready for 1-line mount in server.mjs).
 * Returns a standard MCP tool result envelope: `{ content, structuredContent }` or `{ isError: true, content }`.
 */
export async function dispatchReviewTool(args = {}, options = {}) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  try {
    const projectDir = resolveReviewProjectDir(safeArgs, options);
    const result = await handleReviewAction({ ...safeArgs, projectDir }, options);
    return toolOk('ok', result);
  } catch (err) {
    return toolErr(err?.message || String(err));
  }
}
