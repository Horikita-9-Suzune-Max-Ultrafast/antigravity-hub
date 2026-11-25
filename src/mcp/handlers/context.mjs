import { loadConfig, VALID_CONSOLE_MODULES } from '../../core/config.mjs';
import { inspectContext, previewContextAsset } from '../../core/context-inspector.mjs';
import { recordActiveSession, resolveTargetSession, getSessionProjectDir } from '../../core/session-tracker.mjs';
import { listConversations } from '../../core/transcript-parser.mjs';

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export function handleOpenMonitor(args, { meta, projectDir, options, popout, invalidateActiveConvCache }) {
  const explicitConvId = String(args.conversationId || meta?.conversationId || meta?.sessionId || '').trim() || null;
  if (explicitConvId) {
    recordActiveSession(
      {
        conversationId: explicitConvId,
        projectDir: args.projectDir || '',
        source: 'tool',
        event: 'ctx_open_monitor',
      },
      options
    );
    invalidateActiveConvCache(explicitConvId);
  }
  const ctx = inspectContext(
    {
      conversationId: explicitConvId || undefined,
      followActive: !explicitConvId,
      projectDir,
      explicitProjectDir: args.projectDir || '',
    },
    options
  );
  const config = loadConfig(options);
  const requestedTab = args.tab === 'quota' ? 'context' : args.tab || 'context';
  const requestedModule = VALID_CONSOLE_MODULES.includes(args.module)
    ? args.module
    : config.console?.defaultModule || 'monitor';
  const summaryText =
    `Antigravity Hub 已就绪：当前上下文 ${ctx.usedPercent}% (${Math.round(ctx.usedTokens / 1000)}K/${Math.round(ctx.limitTokens / 1000)}K)` +
    `，缓存命中 ${ctx.latestCacheHitRate.toFixed(1)}%，均速 ${ctx.avgTps.toFixed(1)} tok/s，预警 ${ctx.alerts.length} 项。`;
  return toolOk(summaryText, {
    initialModule: requestedModule,
    initialTab: requestedTab,
    explicitConversationId: Boolean(explicitConvId),
    context: ctx,
    config,
    popoutStatus: popout.getStatus(),
  });
}

export function handleGetContextBreakdown(args, { projectDir, defaultWorkspace, options }) {
  if (args.action === 'preview_asset') {
    let previewProjectDir = args.projectDir || '';
    if (!previewProjectDir) {
      if (args.conversationId) {
        previewProjectDir = getSessionProjectDir(args.conversationId, defaultWorkspace, options);
      } else {
        const target = resolveTargetSession(
          {
            followActive: args.followActive !== false,
            sessions: listConversations({ ...options, limit: 1 }),
            fallbackProjectDir: defaultWorkspace,
          },
          options
        );
        previewProjectDir = target.projectDir || defaultWorkspace;
      }
    }
    const preview = previewContextAsset(
      {
        filePath: args.filePath,
        projectDir: previewProjectDir,
      },
      options
    );
    return toolOk('ok', preview);
  }

  const followActive = args.followActive !== false && !args.conversationId;
  const ctx = inspectContext(
    {
      conversationId: args.conversationId || undefined,
      followActive,
      projectDir,
      explicitProjectDir: args.projectDir || '',
    },
    args.force ? { ...options, force: true } : options
  );

  if (typeof args.lastRev === 'string' && args.lastRev && !args.force && ctx?.rev && args.lastRev === ctx.rev) {
    return toolOk('unchanged', { unchanged: true, rev: ctx.rev });
  }
  return toolOk('ok', ctx);
}
