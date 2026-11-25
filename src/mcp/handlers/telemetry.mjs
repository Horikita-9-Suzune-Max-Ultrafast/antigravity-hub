import { getTelemetryReport, getUsageStats } from '../../core/telemetry.mjs';
import { getQuotaSnapshot, calibrateQuotaGroup } from '../../core/quota.mjs';
import { resolveTargetSession } from '../../core/session-tracker.mjs';
import { listConversations } from '../../core/transcript-parser.mjs';

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export function handleGetCalls(args, { defaultWorkspace, options }) {
  if (args?.action === 'usage_stats') {
    return toolOk(
      'ok',
      getUsageStats(
        {
          range: args.range || 'today',
          modelFilter: args.modelFilter || 'all',
          force: Boolean(args.force),
        },
        options
      )
    );
  }

  let resolvedConvId = args.conversationId || undefined;
  let resolvedTranscript = undefined;
  if (!resolvedConvId && args.followActive !== false) {
    const target = resolveTargetSession(
      {
        followActive: true,
        sessions: listConversations({ ...options, limit: 1 }),
        fallbackProjectDir: defaultWorkspace,
      },
      options
    );
    resolvedConvId = target.conversationId || undefined;
    resolvedTranscript = target.transcriptPath || undefined;
  }

  const report = getTelemetryReport(
    {
      conversationId: resolvedConvId,
      transcriptPath: resolvedTranscript,
      agentFilter: args.agentFilter || 'all',
      modelFilter: args.modelFilter || 'all',
      onlyDrop: Boolean(args.onlyDrop),
      force: Boolean(args.force),
    },
    options
  );

  if (typeof args.lastRev === 'string' && args.lastRev && !args.force && report?.rev && args.lastRev === report.rev) {
    return toolOk('unchanged', { unchanged: true, rev: report.rev });
  }
  return toolOk('ok', report);
}

export function handleGetQuota(options) {
  return toolOk('ok', getQuotaSnapshot({}, options));
}

export function handleCalibrateQuota(args, options) {
  return toolOk('ok', calibrateQuotaGroup(args, options));
}
