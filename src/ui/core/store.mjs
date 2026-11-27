/**
 * Centralized UI state, defaults, and lightweight reactive helpers.
 */

export const APP_VERSION = '1.6.1';
export const CALLS_INITIAL_RENDER_LIMIT = 120;
export const MINI_BAR_DEFAULT_ORDER = ['context', 'cache', 'kv', 'tps', 'model'];
export const SHARED_WIDTH_PRESETS = [380, 460, 640];
export const VALID_CONSOLE_MODULES = ['monitor', 'review', 'governance', 'appearance', 'i18n'];
export const VALID_WINDOW_MODES = ['console', 'minibar', 'orb'];

export const FEATURE_FLAGS = {
  showQuotaUi: false,
};

export function createDefaultUiConfig(defaultLang = 'zh-CN') {
  return {
    uiLanguage: defaultLang,
    currency: defaultLang === 'zh-CN' ? 'CNY' : 'USD',
    cnyPerUsd: 7.2,
    pollIntervalSec: 5,
    auxAutoOpen: true,
    popout: {
      enabled: false,
      autoLaunchOnStartup: true,
      autoLaunchFromSidebar: true,
      alwaysOnTop: true,
      size: '460x720',
      position: null,
      windowMode: 'console',
      orbPosition: null,
      miniBarPreset: 'standard',
      miniBarModules: [...MINI_BAR_DEFAULT_ORDER],
      miniBarCustomWidth: null,
    },
    kvCache: {
      enabled: true,
      ttlMinutes: 15,
    },
    uiBanner: {
      enabled: true,
    },
    sessionStartBudgetTokens: 450,
    alerts: {
      contextWarningPct: 75,
      cacheDropThresholdPct: 50,
    },
    i18n: {
      installDirOverride: '',
      updateReminderEnabled: true,
      menuLocalizationEnabled: true,
      brandMode: 'original',
      customBrandText: 'Antigravity',
      communitySourceUrl: '',
      immunity: {
        codeBlocks: true,
        inputs: true,
        terminal: true,
        filePaths: true,
        customSelectors: [],
      },
    },
  };
}

export function createUiState({ defaultLang = 'zh-CN', initialPinned = true } = {}) {
  return {
    surface: 'aux_pane', // 'aux_pane' | 'global' | 'popout'
    followMode: 'auto',  // 'auto' | 'pinned'
    pinnedConversationId: null,
    activeConversationId: null,
    activeProjectDir: null,
    launcherMode: false,
    popoutStatus: {
      running: false,
      windowOpen: false,
      serverListening: false,
      userClosed: false,
      port: null,
      activeClients: 0,
    },
    activeModule: 'monitor', // 'monitor' | 'review' | 'governance' | 'appearance' | 'i18n'
    i18nStatus: null,
    i18nBannerDismissed: false,
    activeTab: 'context',
    callsMode: 'step',
    agentFilter: 'all',
    modelFilter: 'all',
    onlyDrop: false,
    expandedCallId: null,
    showAllCalls: false,
    statsRange: 'today',
    statsModelFilter: 'all',
    statsData: null,
    vaultKind: 'all',
    calGroup: 'gemini',
    newMemKind: 'decision',
    capsuleMode: 'human',
    capsuleBudgetPreset: 'standard',
    modelSimLimit: '',
    inspectedAsset: null,
    inSettings: false,
    openSelectId: null,
    openAccIdx: 0,
    canUpdateModelContext: false,
    canSendMessage: false,
    isDraggingMiniBar: false,
    sizeMoveActive: false,
    windowFocused:
      typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus()
        : true,
    userClosedPopoutSession: false,
    contextData: null,
    callsData: null,
    quotaData: null,
    vaultData: null,
    capsuleData: null,
    reviewData: null,
    config: createDefaultUiConfig(defaultLang),
    configDefaults: null,
    windowPinned: Boolean(initialPinned),
    windowCollapsed: false,
    windowMode: 'console', // 'console' | 'minibar' | 'orb'
    windowMaximized: false,
    dpiScale: 1,
    doctorReport: null,
    knownCallIds: new Set(),
    freshCallId: null,
    lastRev: {
      context: null,
      calls: null,
    },
  };
}

export function createPrevDisplay() {
  return { pct: 0, used: 0, cache: 0, tps: 0, free: 0, cost: 0 };
}

export function resetSessionViewState(state) {
  state.expandedCallId = null;
  state.showAllCalls = false;
  state.knownCallIds.clear();
  state.freshCallId = null;
  state.modelFilter = 'all';
  state.callsData = null;
  state.vaultData = null;
  if (state.lastRev) {
    state.lastRev.context = null;
    state.lastRev.calls = null;
  }
}

export function getMiniBarModules(state) {
  const raw = state?.config?.popout?.miniBarModules;
  if (!Array.isArray(raw) || raw.length === 0) return [...MINI_BAR_DEFAULT_ORDER];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    if (MINI_BAR_DEFAULT_ORDER.includes(m) && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  for (const m of MINI_BAR_DEFAULT_ORDER) {
    if (!seen.has(m)) out.push(m);
  }
  return out;
}

export function isPopoutOpen(status) {
  return Boolean(status && (status.windowOpen || status.running));
}

export function isPopoutClosed(status) {
  return Boolean(status && !status.windowOpen && !status.running);
}

export function detectCurrentTheme() {
  if (typeof document === 'undefined') return 'light';
  const dt = document.documentElement.dataset.theme;
  if (dt === 'dark' || dt === 'light') return dt;
  if (document.documentElement.classList.contains('dark')) return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function parseSizeDimensions(sizeStr, fallbackW = 460, fallbackH = 720) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(sizeStr || '').trim());
  if (!m) return { width: fallbackW, height: fallbackH };
  return {
    width: Math.max(360, Math.min(1600, Number(m[1]) || fallbackW)),
    height: Math.max(460, Math.min(1200, Number(m[2]) || fallbackH)),
  };
}
