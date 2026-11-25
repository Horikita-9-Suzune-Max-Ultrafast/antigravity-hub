import { clearNativeStepMetricsCache } from './native-step-metrics.mjs';
import { clearTimingsCache, recordHookTiming } from './telemetry/timings-store.mjs';
import {
  resolveQuotaGroup,
  syncConversationTelemetry,
  queryCalls,
  resyncAllHistoricalTelemetry as resyncAllHistoricalTelemetryCore,
} from './telemetry/sync-engine.mjs';
import { evaluateAlerts } from './telemetry/alerts.mjs';
import {
  calcWeightedAvgTps,
  clearReportCache,
  formatUserMarkdownBanner,
  getTelemetryReport,
  summarizeCallStats,
} from './telemetry/report.mjs';

export function clearTelemetryCache() {
  clearReportCache();
  clearTimingsCache();
  clearNativeStepMetricsCache();
}

export function resyncAllHistoricalTelemetry(options = {}) {
  return resyncAllHistoricalTelemetryCore(options, {
    summarizeStats: summarizeCallStats,
    onAfterResync: clearTelemetryCache,
  });
}

export {
  resolveQuotaGroup,
  recordHookTiming,
  syncConversationTelemetry,
  queryCalls,
  evaluateAlerts,
  getTelemetryReport,
  formatUserMarkdownBanner,
  calcWeightedAvgTps,
};
