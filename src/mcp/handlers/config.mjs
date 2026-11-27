import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../core/config.mjs';
import { clearTelemetryCache } from '../../core/telemetry.mjs';
import { recordActiveSession } from '../../core/session-tracker.mjs';
import { restartAntigravity } from '../../core/client-restart.mjs';
import { checkForUpdate, applySelfUpdate } from '../../core/self-update.mjs';

function getEditableDefaults() {
  return {
    modelLimits: structuredClone(DEFAULT_CONFIG.modelLimits),
    pricing: structuredClone(DEFAULT_CONFIG.pricing),
    alerts: structuredClone(DEFAULT_CONFIG.alerts),
    sessionStartBudgetTokens: DEFAULT_CONFIG.sessionStartBudgetTokens,
    kvCache: structuredClone(DEFAULT_CONFIG.kvCache),
    cnyPerUsd: DEFAULT_CONFIG.cnyPerUsd,
  };
}

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

export async function handleConfigManage(args, { options, popout, invalidateActiveConvCache }) {
  if (args.action === 'get') {
    return toolOk('ok', {
      config: loadConfig(options),
      defaults: getEditableDefaults(),
      popoutStatus: popout.getStatus(),
    });
  }
  if (args.action === 'update') {
    const next = saveConfig(args.patch || {}, options);
    clearTelemetryCache();
    if (args.patch?.popout && Object.prototype.hasOwnProperty.call(args.patch.popout, 'enabled') && !next.popout?.enabled) {
      await popout.stop({ userClosed: true });
    }
    return toolOk('updated', {
      config: next,
      defaults: getEditableDefaults(),
      popoutStatus: popout.getStatus(),
    });
  }
  if (args.action === 'open_popout') {
    const cfg = loadConfig(options);
    if (!cfg.popout?.enabled) {
      saveConfig({ popout: { enabled: true } }, options);
    }
    const status = await popout.launchWindow({
      size: cfg.popout?.size || '460x720',
      position: cfg.popout?.position || null,
      alwaysOnTop: cfg.popout?.alwaysOnTop !== false,
      theme: args.theme === 'dark' ? 'dark' : 'light',
      forceNew: Boolean(args.forceNew),
    });
    return toolOk('launched', { config: loadConfig(options), popoutStatus: status });
  }
  if (args.action === 'close_popout') {
    const status = await popout.stop({ userClosed: true });
    const next = saveConfig({ popout: { enabled: false } }, options);
    return toolOk('closed', { config: next, popoutStatus: status });
  }
  if (args.action === 'set_active_session') {
    const convId = String(args.conversationId || '').trim();
    if (!convId) {
      return toolErr('conversationId is required for set_active_session');
    }
    const activeSession = recordActiveSession(
      {
        conversationId: convId,
        projectDir: args.projectDir || '',
        source: 'ui_sync',
        event: 'ui_select',
      },
      options
    );
    invalidateActiveConvCache(convId);
    return toolOk('synced', { activeSession });
  }
  if (args.action === 'restart_antigravity') {
    const restartOpts = {
      ...options,
      dryRun: Boolean(args.dryRun),
    };
    if (typeof args.installDir === 'string' && args.installDir.trim()) {
      restartOpts.installDir = args.installDir.trim();
    }
    const res = restartAntigravity(restartOpts);
    return toolOk(res.message, res);
  }
  if (args.action === 'check_update') {
    const res = await checkForUpdate(options);
    return toolOk(res.ok ? 'checked' : res.message || 'check_failed', res);
  }
  if (args.action === 'apply_update') {
    try {
      await popout.stop();
    } catch {
      /* best-effort release of floating window before directory swap */
    }
    const res = await applySelfUpdate({
      ...options,
      force: Boolean(args.force),
    });
    return toolOk(res.message || res.status || 'done', res);
  }
  return toolErr(`Unsupported config action: ${args.action}`);
}
