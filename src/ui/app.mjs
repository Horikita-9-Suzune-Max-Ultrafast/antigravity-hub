/**
 * Antigravity Hub v1.6.0 — Unified Modular Frontend Entry Point (<650 lines).
 * Zero @modelcontextprotocol/ext-apps / zod dependency; powered by lightweight SEP-1865 client.
 */

import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts, getDocumentTheme } from './core/mcp-app-client.mjs';
import {
  APP_VERSION, VALID_CONSOLE_MODULES, FEATURE_FLAGS, createUiState, createPrevDisplay,
  resetSessionViewState, isPopoutOpen, isPopoutClosed, detectCurrentTheme, parseSizeDimensions,
} from './core/store.mjs';
import {
  esc, showToast, positionIndicator, positionFloatingLayer,
  clampOpenSelectMenus, clampOpenKvPopovers, createResizeScheduler,
} from './core/dom.mjs';
import { createRpcClient } from './core/rpc.mjs';
import { bindGlobalUiEvents } from './core/events.mjs';
import { ensureIconSprite } from './components/icons.mjs';
import {
  getPopoutSizes, renderCustomSelect, renderPollSelect, renderFollowToggle,
  renderSessionSelect, renderCallsSelects as renderCallsSelectsBase, renderVaultSelects as renderVaultSelectsBase,
} from './components/custom-select.mjs';
import { createModalController } from './components/modal.mjs';
import { createMonitorContextModule } from './modules/monitor-context.mjs';
import { createMonitorCallsModule } from './modules/monitor-calls.mjs';
import { createMonitorStatsModule } from './modules/monitor-stats.mjs';
import { createMonitorVaultModule } from './modules/monitor-vault.mjs';
import { createReviewModule } from './modules/review-module.mjs';
import { createGovernanceModule } from './modules/governance-module.mjs';
import { createAppearanceModule } from './modules/appearance-module.mjs';
import { createI18nModule } from './modules/i18n-module.mjs';
import { createSettingsModule } from './modules/settings-module.mjs';
import { createNativeChromeModule, postHostWindowMsg } from './modules/native-chrome.mjs';
import {
  DEFAULT_UI_LANG, normalizeUiLang, t as tUi, applyStaticTranslations,
  localizeBreakdownItem, localizeDeferredItem, localizeInventoryGroup,
} from './i18n-ui.mjs';

const urlParams = new URLSearchParams(window.location.search);
const POPOUT_TOKEN = urlParams.get('token');
const IS_POPOUT = Boolean(POPOUT_TOKEN);
const IS_NATIVE_POPOUT = IS_POPOUT && urlParams.get('native') === '1';
const POPOUT_CLIENT_ID = IS_POPOUT ? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` : null;

const state = createUiState({ isPopout: IS_POPOUT, isNativePopout: IS_NATIVE_POPOUT });
const prevDisplay = createPrevDisplay();

let currentUiLang = DEFAULT_UI_LANG;
const getUiLang = () => currentUiLang;
const tr = (key, vars = null) => tUi(currentUiLang, key, vars);

let mcpApp = null;
let pollTimer = null;
let launcherPollTimer = null;
let autoLaunchAttempted = false;
let autoPopoutTimer = null;

const rpc = createRpcClient({ getMcpApp: () => mcpApp, popoutToken: POPOUT_TOKEN });
const callAppTool = (name, args = {}, options = {}) => rpc.callAppTool(name, args, options);

const modalCtrl = createModalController({
  onClose: (id) => {
    if (id === 'appRotationPoolModal') appearanceModule.onPoolModalClosed?.();
  },
});

const renderSelect = (hostId, cfg) => renderCustomSelect(hostId, cfg, { state, tr });
const renderCallsSelects = () => renderCallsSelectsBase({ state, tr });
const renderVaultSelects = () => renderVaultSelectsBase({ state, tr });

function closeSelectMenus() {
  if (!state.openSelectId) return;
  state.openSelectId = null;
  renderAllSelects();
}

function closeKvPopovers() {
  for (const id of ['kvHelpPopover', 'settingsKvHelpPopover']) {
    const el = document.getElementById(id);
    if (el) {
      el.dataset.open = 'false';
      el.classList.add('hidden');
    }
  }
}

function toggleKvPopover(popoverId, anchorEl) {
  const pop = document.getElementById(popoverId);
  if (!pop || !anchorEl) return;
  const next = pop.classList.contains('hidden') || pop.dataset.open !== 'true';
  closeKvPopovers();
  if (!next) return;
  pop.classList.remove('hidden');
  pop.dataset.open = 'true';
  positionFloatingLayer(pop, anchorEl, {
    alignRight: popoverId === 'kvHelpPopover',
    maxWidthCap: 300,
    maxHeightCap: 260,
    gap: 8,
    pad: 10,
    matchTriggerMinWidth: false,
  });
}

const canSendToAgent = () => !IS_POPOUT && Boolean(mcpApp && (state.canSendMessage || state.canUpdateModelContext));

async function sendToAgent(text) {
  if (!text) return { mode: 'clipboard' };
  if (!IS_POPOUT && mcpApp) {
    if (state.canSendMessage && typeof mcpApp.sendMessage === 'function') {
      await mcpApp.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      return { mode: 'sent' };
    }
    if (state.canUpdateModelContext && typeof mcpApp.updateModelContext === 'function') {
      await mcpApp.updateModelContext({ content: [{ type: 'text', text }] });
      return { mode: 'attached' };
    }
  }
  return { mode: 'clipboard' };
}

async function persistConfigPatch(patch) {
  const res = await callAppTool('app_config_manage', { action: 'update', patch });
  if (res?.config) state.config = res.config;
  if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
  return res;
}

function renderAllSelects(fromPoll = false) {
  renderPollSelect(fromPoll, { state, tr, getUiLang });
  renderFollowToggle({ state, tr, getUiLang });
  renderSessionSelect(fromPoll, { state, tr, getUiLang });
  renderCallsSelects();
  monitorStats.renderSelects?.();
  renderVaultSelects();
  monitorContext.renderContextModelSim();
  renderSelect('popoutSizeHost', {
    id: 'popoutSize',
    value: state.config?.popout?.size || '460x720',
    options: getPopoutSizes(tr),
    fullWidth: true,
    skipIfOpen: fromPoll,
  });
  reviewModule.renderSelects?.();
  i18nModule.renderSelects?.();
  appearanceModule.renderSelects?.();
  clampOpenSelectMenus();
}

// =========================================================================
// Instantiate Modular Subsystems
// =========================================================================
const nativeChrome = createNativeChromeModule({
  state, tr, getUiLang, isNativePopout: IS_NATIVE_POPOUT, popoutToken: POPOUT_TOKEN, popoutClientId: POPOUT_CLIENT_ID,
  persistConfigPatch, showToast,
  onSessionFollowSwitch: (convId) => { state.activeConversationId = convId; resetSessionViewState(state, prevDisplay); rpc.invalidateRev(); void pollAll(true); },
  onSizeMoveChange: (active) => { state.sizeMoveActive = Boolean(active); if (!active) resizeScheduler.schedule(); },
  onModeChanged: (mode) => { if (mode === 'console') resizeScheduler.schedule(); },
});

const monitorCalls = createMonitorCallsModule({ state, tr, getUiLang, callAppTool, renderCallsSelects, positionIndicator });
const monitorStats = createMonitorStatsModule({ state, tr, getUiLang, callAppTool, persistConfigPatch, renderCustomSelect: renderSelect, showToast });
const fitCallsTableLayout = () => {
  // Keeps col-model-full / col-model-short visibility synced with dynamic table container width
  const tbl = document.getElementById('callsTable');
  if (tbl && !tbl.dataset.modelMode) tbl.dataset.modelMode = 'full';
  monitorCalls.fitCallsTableLayout();
};
const monitorVault = createMonitorVaultModule({
  state, tr, getUiLang, callAppTool, getMcpApp: () => mcpApp, showToast,
  openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal, positionIndicator, renderVaultSelects,
});
const monitorContext = createMonitorContextModule({
  state, prevDisplay, tr, getUiLang, localizeBreakdownItem, localizeDeferredItem, localizeInventoryGroup,
  callAppTool, getMcpApp: () => mcpApp, showToast, openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal,
  switchModule, switchTab, positionIndicator,
  onTelemetryUpdate: (ctx, metrics) => { nativeChrome.updateNativeTitleBarTelemetry(ctx, metrics); },
  onOpenCallsMatch: (alert, hay) => monitorCalls.focusAlertCall(alert, hay),
  onOpenCapsule: () => monitorVault.openCapsuleModal(),
});
const reviewModule = createReviewModule({
  callAppTool, esc, tr, getUiLang, showToast, openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal,
  renderCustomSelect: renderSelect, getProjectDir: () => state.activeProjectDir,
  getConversationId: () => state.activeConversationId, canSendMessage: canSendToAgent, sendToAgent,
});
const governanceModule = createGovernanceModule({
  callAppTool, esc, tr, getUiLang, showToast, positionIndicator,
  onOpenSettings: () => openSettingsPage(), getProjectDir: () => state.activeProjectDir,
  canSendMessage: canSendToAgent, sendToAgent,
});
const appearanceModule = createAppearanceModule({
  callAppTool, esc, showToast, openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal,
  positionIndicator, renderCustomSelect: renderSelect, onOpenSettings: () => openSettingsPage(),
  onGoI18nPatch: () => switchModule('i18n', 'status'), popoutToken: POPOUT_TOKEN,
});
const i18nModule = createI18nModule({
  callAppTool, esc, showToast, openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal,
  positionIndicator, renderCustomSelect: renderSelect,
  onStatusChange: (data) => {
    const dot = document.getElementById('railI18nAlertDot');
    if (dot) dot.classList.toggle('hidden', !(data?.status === 'outdated_after_update' || data?.status === 'patched_by_other'));
  },
  onOpenSettings: () => openSettingsPage(),
});
const settingsModule = createSettingsModule({
  state, tr, getUiLang, normalizeUiLang, defaultUiLang: DEFAULT_UI_LANG, isNativePopout: IS_NATIVE_POPOUT,
  callAppTool, getMcpApp: () => mcpApp, persistConfigPatch, applyUiLanguage, restartPollTimer,
  renderContext: (anim) => monitorContext.renderContext(anim), syncKvCountdownUi: () => monitorContext.syncKvCountdownUi(),
  renderNativePinButton: () => nativeChrome.renderNativePinButton(),
  onMiniBarOrderChanged: () => {
    nativeChrome.resetCache();
    const ctx = state.contextData;
    if (ctx) {
      const { kv, health } = monitorContext.syncKvCountdownUi();
      nativeChrome.updateNativeTitleBarTelemetry(ctx, { pct: Number(ctx.usedPercent) || 0, cache: Number(ctx.latestCacheHitRate) || 0, tps: Number(ctx.avgTps) || 0, kv, health });
    }
  },
  onOpenPopout: () => void openPopoutWindow({ manual: true }),
  onSetSharedWidth: (w) => nativeChrome.setSharedWidth(w),
  showToast, openModal: modalCtrl.openModal, closeModal: modalCtrl.closeModal,
});

const resizeScheduler = createResizeScheduler(() => {
  if (state.sizeMoveActive) return;
  if (state.activeModule === 'monitor') {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    if (state.activeTab === 'calls') {
      positionIndicator('callsModeNav', 'callsModeIndicator');
      fitCallsTableLayout();
    }
  } else if (state.activeModule === 'governance') {
    governanceModule.positionSubNav?.();
  } else if (state.activeModule === 'appearance') {
    appearanceModule.positionSubNav?.();
  } else if (state.activeModule === 'i18n') {
    i18nModule.positionSubNav?.();
  }
  clampOpenSelectMenus();
  clampOpenKvPopovers();
  nativeChrome.fitNativeTitleBar();
});

// =========================================================================
// Navigation, Settings & i18n
// =========================================================================
function syncNavState() {
  const activeKey = state.settingsOpen ? 'settings' : state.activeModule;
  for (const mod of VALID_CONSOLE_MODULES) {
    document.getElementById(`module-${mod}`)?.classList.toggle('hidden', state.settingsOpen || state.activeModule !== mod);
  }
  document.getElementById('module-settings')?.classList.toggle('hidden', !state.settingsOpen);
  document.querySelectorAll('#consoleRail [data-module], #consoleTopBar [data-module]').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.module === activeKey);
  });
  for (const id of ['railSettingsBtn', 'topBarSettingsBtn']) {
    const btn = document.getElementById(id);
    if (btn) btn.dataset.active = String(state.settingsOpen);
  }
}

function openSettingsPage() {
  if (!state.settingsOpen) state.prevModuleBeforeSettings = state.activeModule;
  state.settingsOpen = true;
  state.inSettings = true;
  syncNavState();
  settingsModule.renderSettings();
  renderAllSelects();
}

function closeSettingsPage() {
  state.settingsOpen = false;
  state.inSettings = false;
  syncNavState();
  resizeScheduler.schedule();
}

function switchModule(mod, subTab = null) {
  const next = VALID_CONSOLE_MODULES.includes(mod) ? mod : 'monitor';
  state.settingsOpen = false;
  state.inSettings = false;
  state.activeModule = next;
  syncNavState();
  if (next === 'monitor') {
    if (subTab) switchTab(subTab);
    else resizeScheduler.schedule();
  } else if (next === 'review') void reviewModule.activate();
  else if (next === 'governance') void governanceModule.activate(subTab);
  else if (next === 'appearance') void appearanceModule.activate(subTab);
  else if (next === 'i18n') void i18nModule.activate(subTab);
}

function switchTab(tab) {
  const valid = FEATURE_FLAGS.showQuotaTab
    ? ['context', 'calls', 'stats', 'vault', 'quota']
    : ['context', 'calls', 'stats', 'vault'];
  const next = valid.includes(tab) ? tab : 'context';
  state.activeTab = next;
  for (const t of ['context', 'calls', 'stats', 'vault', 'quota']) {
    document.getElementById(`panel-${t}`)?.classList.toggle('hidden', t !== next);
  }
  document.querySelectorAll('#mainSegNav .seg-tab').forEach((b) => {
    b.dataset.active = String(b.dataset.tab === next);
  });
  requestAnimationFrame(() => positionIndicator('mainSegNav', 'mainSegIndicator'));
  if (next === 'calls') void monitorCalls.loadCalls(true);
  else if (next === 'stats') void monitorStats.loadStats(false);
  else if (next === 'vault') void monitorVault.loadVault();
}

function applyUiLanguage(lang) {
  const next = normalizeUiLang(lang || DEFAULT_UI_LANG);
  currentUiLang = next;
  if (state.config) state.config.uiLanguage = next;
  applyStaticTranslations(document, next);
  monitorContext.resetCache();
  monitorCalls.resetCache();
  monitorStats.resetCache();
  monitorVault.resetCache();
  nativeChrome.resetCache();
  nativeChrome.renderNativePinButton();
  if (state.contextData) monitorContext.renderContext(false);
  if (state.callsData) monitorCalls.renderCalls();
  if (state.statsData) monitorStats.renderStats();
  if (state.vaultData) monitorVault.renderVault();
  reviewModule.renderAll?.();
  governanceModule.renderAll?.();
  if (state.settingsOpen) settingsModule.renderSettings();
  renderAllSelects();
  resizeScheduler.schedule();
}

// =========================================================================
// Global Launcher, Popout Sync & Polling
// =========================================================================
function updateLauncherUi() {
  const status = state.popoutStatus || {};
  const open = isPopoutOpen(status);
  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  setTxt('launcherTitle', open ? tr('launcher.titleRunning') : tr('launcher.titleStopped'));
  setTxt('launcherOpenPopoutBtn', tr('launcher.btnFocus'));
  setTxt('launcherPortBadge', open ? tr('launcher.statusRunning') : tr('launcher.statusStopped'));
  const subEl = document.getElementById('launcherSubMeta');
  if (subEl) {
    subEl.textContent = open && status.port ? tr('launcher.subRunning', { port: status.port }) : tr('launcher.subStopped');
  }
  document.getElementById('launcherClosePopoutBtn')?.classList.toggle('hidden', !open);
  const dot = document.getElementById('launcherStatusDot');
  if (dot) dot.classList.toggle('hidden', !open);
}

function stopLauncherStatusPoller() {
  if (launcherPollTimer) {
    clearInterval(launcherPollTimer);
    launcherPollTimer = null;
  }
}

function enterGlobalLauncherMode(status = null) {
  state.launcherMode = true;
  if (status) state.popoutStatus = status;
  document.getElementById('appShell')?.classList.add('hidden');
  document.getElementById('globalLauncherView')?.classList.remove('hidden');
  updateLauncherUi();
  stopLauncherStatusPoller();
  launcherPollTimer = setInterval(() => {
    if (!state.launcherMode || document.visibilityState !== 'visible') return;
    void (async () => {
      try {
        const res = await callAppTool('app_config_manage', { action: 'get' });
        if (res?.popoutStatus) {
          state.popoutStatus = res.popoutStatus;
          if (state.popoutStatus.userClosed || isPopoutClosed(state.popoutStatus)) {
            exitGlobalLauncherMode();
            return;
          }
          updateLauncherUi();
        }
      } catch {
        /* ignore transient launcher poll errors */
      }
    })();
  }, 2500);
}

function exitGlobalLauncherMode() {
  state.launcherMode = false;
  stopLauncherStatusPoller();
  document.getElementById('globalLauncherView')?.classList.add('hidden');
  document.getElementById('appShell')?.classList.remove('hidden');
  resizeScheduler.schedule();
  void pollAll(true);
  restartPollTimer();
}

async function openPopoutWindow({ manual = false } = {}) {
  try {
    const { width, height } = parseSizeDimensions(state.config?.popout?.size || '460x720');
    const res = await callAppTool('app_config_manage', {
      action: 'open_popout',
      theme: detectCurrentTheme(),
      width,
      height,
      alwaysOnTop: state.config?.popout?.alwaysOnTop !== false,
      windowMode: state.config?.popout?.windowMode || 'console',
    });
    if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
    if (res?.opened || isPopoutOpen(res?.popoutStatus)) {
      if (!IS_POPOUT) enterGlobalLauncherMode(res.popoutStatus);
      if (manual) {
        const port = res?.popoutStatus?.port || state.popoutStatus?.port || '';
        const msgKey = res?.alreadyOpen ? 'toast.popoutFocused' : 'toast.popoutLaunched';
        showToast(port ? tr(msgKey, { port }) : tr('toast.popoutOpened'), 'success');
      }
    } else if (manual) {
      showToast(tr('toast.popoutFailed', { error: res?.error || 'unavailable' }), 'error');
    }
  } catch (err) {
    if (manual) showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
  }
}

async function pollAll(force = false) {
  if (state.launcherMode || state.sizeMoveActive) return;
  if (!force && document.visibilityState !== 'visible' && !(IS_NATIVE_POPOUT && state.windowMode === 'orb')) return;
  const svg = document.getElementById('refreshSvg');
  if (force && svg) svg.classList.add('spin-once');
  try {
    const ctx = await callAppTool(
      'app_get_context_breakdown',
      {
        conversationId: state.followMode === 'pinned' ? state.activeConversationId || undefined : undefined,
        projectDir: state.activeProjectDir || undefined,
        force: force ? true : undefined,
      },
      { useRevCache: !force }
    );
    if (ctx) {
      const prevConv = state.activeConversationId;
      state.contextData = ctx;
      if (ctx.conversationId) state.activeConversationId = ctx.conversationId;
      if (ctx.projectDir) state.activeProjectDir = ctx.projectDir;
      if (prevConv && ctx.conversationId && prevConv !== ctx.conversationId) resetSessionViewState(state, prevDisplay);
      monitorContext.renderContext(!force);
      renderSessionSelect(!force, { state, tr, getUiLang });
      renderFollowToggle({ state, tr, getUiLang });
    }
    if (state.activeModule === 'monitor' && state.activeTab === 'calls') await monitorCalls.loadCalls(force);
    else if (state.activeModule === 'monitor' && state.activeTab === 'stats') await monitorStats.loadStats(force);
    else if (state.activeModule === 'monitor' && state.activeTab === 'vault' && force) await monitorVault.loadVault();
  } catch (err) {
    if (force) showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
  } finally {
    if (force && svg) setTimeout(() => svg.classList.remove('spin-once'), 360);
  }
}

function restartPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const sec = Number(state.config?.pollIntervalSec ?? 5);
  if (sec > 0 && !state.launcherMode) {
    pollTimer = setInterval(() => void pollAll(false), Math.max(2, sec) * 1000);
  }
}

// =========================================================================
// Bootstrap (SEP-1865 Host or Standalone Popout)
// =========================================================================
async function hydrateInitialConfig() {
  try {
    const res = await callAppTool('app_config_manage', { action: 'get' });
    if (res?.config) state.config = res.config;
    if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
    applyUiLanguage(state.config?.uiLanguage || DEFAULT_UI_LANG);
    state.windowPinned = state.config?.popout?.alwaysOnTop !== false;
    nativeChrome.renderNativePinButton();

    if (IS_NATIVE_POPOUT) {
      nativeChrome.setWindowMode(state.config?.popout?.windowMode || 'console', { fromHost: true });
      postHostWindowMsg(state.windowPinned ? 'pin:1' : 'pin:0');
    } else if (!IS_POPOUT) {
      const pop = state.popoutStatus || {};
      if (isPopoutOpen(pop)) return enterGlobalLauncherMode(pop);
      if (state.config?.popout?.autoLaunchFromSidebar && !pop.userClosed && !autoLaunchAttempted) {
        autoLaunchAttempted = true;
        clearTimeout(autoPopoutTimer);
        autoPopoutTimer = setTimeout(() => void openPopoutWindow({ manual: false }), 150);
      }
    }
    const defMod = state.config?.console?.defaultModule;
    if (defMod && VALID_CONSOLE_MODULES.includes(defMod) && defMod !== state.activeModule) switchModule(defMod);
  } catch {
    applyUiLanguage(DEFAULT_UI_LANG);
  }
}

async function bootstrap() {
  ensureIconSprite();
  applyStaticTranslations(document, currentUiLang);
  nativeChrome.setupNativeFramelessChrome();
  monitorContext.bindEvents();
  monitorCalls.bindEvents();
  monitorStats.bindEvents();
  monitorVault.bindEvents();
  reviewModule.init();
  governanceModule.init();
  appearanceModule.init();
  i18nModule.init();
  settingsModule.bindEvents();
  bindGlobalUiEvents({
    state, prevDisplay, tr, getUiLang, isNativePopout: IS_NATIVE_POPOUT, rpc, callAppTool, persistConfigPatch, modalCtrl,
    monitorContext, monitorCalls, monitorStats, monitorVault, reviewModule, governanceModule, appearanceModule, i18nModule,
    settingsModule, nativeChrome, resizeScheduler, renderCallsSelects, renderVaultSelects, renderAllSelects,
    closeSelectMenus, closeKvPopovers, toggleKvPopover, switchModule, switchTab, openSettingsPage, closeSettingsPage,
    openPopoutWindow, exitGlobalLauncherMode, pollAll, restartPollTimer,
  });
  syncNavState();

  const initialTheme = urlParams.get('theme');
  applyDocumentTheme(initialTheme === 'light' || initialTheme === 'dark' ? initialTheme : getDocumentTheme());

  if (IS_POPOUT) {
    document.body.classList.add('is-popout');
    nativeChrome.startPopoutClientLifecycle();
  } else {
    mcpApp = new App({ name: 'antigravity-hub', version: APP_VERSION });
    mcpApp.onhostcontextchanged = (ctx) => {
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };
    mcpApp.ontoolresult = (res) => {
      const sc = res?.structuredContent;
      if (!sc) return;
      if (sc.context) {
        state.contextData = sc.context;
        if (sc.context.conversationId) state.activeConversationId = sc.context.conversationId;
        if (sc.context.projectDir) state.activeProjectDir = sc.context.projectDir;
        monitorContext.renderContext(false);
      }
      if (sc.initialModule && VALID_CONSOLE_MODULES.includes(sc.initialModule)) switchModule(sc.initialModule, sc.initialTab || null);
      else if (sc.initialTab) switchTab(sc.initialTab);
    };
    try {
      await mcpApp.connect();
      const caps = mcpApp.getHostCapabilities();
      state.canUpdateModelContext = Boolean(caps?.updateModelContext);
      state.canSendMessage = Boolean(caps?.sendMessage);
      const hostCtx = mcpApp.getHostContext();
      if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
      if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);
      if (hostCtx?.styles?.css?.fonts) applyHostFonts(hostCtx.styles.css.fonts);
    } catch {
      /* Standalone preview fallback */
    }
  }

  await hydrateInitialConfig();
  if (!state.launcherMode) {
    await pollAll(true);
    restartPollTimer();
    monitorContext.startKvCountdownTimer();
  }
}

void bootstrap();
