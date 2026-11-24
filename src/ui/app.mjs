import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { createI18nModule } from './modules/i18n-module.mjs';
import { createGovernanceModule } from './modules/governance-module.mjs';
import { createAppearanceModule } from './modules/appearance-module.mjs';
import {
  DEFAULT_UI_LANG,
  normalizeUiLang,
  t,
  applyStaticTranslations,
  localizeBreakdownItem,
  localizeDeferredItem,
  localizeInventoryGroup,
} from './i18n-ui.mjs';

// Code-level feature flags (all quota UI/backend code is preserved intact when hidden)
const FEATURE_FLAGS = {
  showQuotaUi: false,
};

const APP_VERSION = '1.5.5-beta.1';
const MINI_BAR_DEFAULT_ORDER = ['context', 'cache', 'kv', 'tps', 'model'];
const MINI_BAR_PRESET_COUNTS = { minimal: 1, compact: 2, standard: 3, wide: 4, full: 5, custom: 5 };
const MINI_BAR_PRESET_WIDTHS = { minimal: 255, compact: 340, standard: 440, wide: 540, full: 650 };

function getUiLang() {
  return normalizeUiLang(state.config?.uiLanguage || DEFAULT_UI_LANG);
}

function tr(key, vars = null) {
  return t(getUiLang(), key, vars);
}

function getPollOptions() {
  return [
    { value: '3', label: tr('monitor.poll.s3'), short: '3s' },
    { value: '5', label: tr('monitor.poll.s5'), short: '5s' },
    { value: '10', label: tr('monitor.poll.s10'), short: '10s' },
    { value: '30', label: tr('monitor.poll.s30'), short: '30s' },
    { value: '60', label: tr('monitor.poll.s60'), short: '60s' },
    { value: '0', label: tr('monitor.poll.manual'), short: tr('monitor.poll.manualShort') },
  ];
}

function getPopoutSizes() {
  return [
    { value: '420x680', label: tr('settings.popout.sizeCompact') },
    { value: '460x720', label: tr('settings.popout.sizeStandard') },
    { value: '880x640', label: tr('settings.popout.sizeWide') },
  ];
}

const state = {
  surface: 'aux_pane', // 'aux_pane' | 'global' | 'popout'
  followMode: 'auto',  // 'auto' | 'pinned'
  pinnedConversationId: null,
  activeConversationId: null,
  activeProjectDir: null,
  launcherMode: false,
  popoutStatus: { running: false, windowOpen: false, serverListening: false, userClosed: false, port: null, activeClients: 0 },
  activeModule: 'monitor', // 'monitor' | 'governance' | 'appearance' | 'i18n'
  i18nStatus: null,
  i18nBannerDismissed: false,
  activeTab: 'context',
  callsMode: 'step',
  agentFilter: 'all',
  modelFilter: 'all',
  onlyDrop: false,
  expandedCallId: null,
  vaultKind: 'all',
  calGroup: 'gemini',
  newMemKind: 'decision',
  capsuleMode: 'human',
  capsuleBudgetPreset: 'standard',
  inspectedAsset: null,
  inSettings: false,
  openSelectId: null,
  openAccIdx: 0,
  canUpdateModelContext: false,
  canSendMessage: false,
  isDraggingMiniBar: false,
  windowFocused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true,
  userClosedPopoutSession: false,
  contextData: null,
  callsData: null,
  quotaData: null,
  vaultData: null,
  capsuleData: null,
  config: {
    uiLanguage: DEFAULT_UI_LANG,
    pollIntervalSec: 5,
    auxAutoOpen: true,
    popout: { enabled: false, autoLaunchFromSidebar: true, alwaysOnTop: true, size: '460x720', position: null },
    uiBanner: { enabled: true },
    sessionStartBudgetTokens: 450,
    alerts: { contextWarningPct: 75, cacheDropThresholdPct: 50 },
    i18n: {
      installDirOverride: '',
      updateReminderEnabled: true,
      menuLocalizationEnabled: true,
      brandMode: 'original',
      customBrandText: 'Antigravity',
      communitySourceUrl: '',
      immunity: { codeBlocks: true, inputs: true, terminal: true, filePaths: true, customSelectors: [] },
    },
  },
  windowPinned: true,
  windowCollapsed: false,
  doctorReport: null,
  knownCallIds: new Set(),
  freshCallId: null,
};

const prevDisplay = { pct: 0, used: 0, cache: 0, tps: 0, free: 0, cost: 0 };
const activeAnims = new WeakMap();
let pollTimer = null;
let launcherTimer = null;
let heartbeatTimer = null;
let boundsTimer = null;
let kvCountdownTimer = null;
let toastTimer = null;
let refreshInFlight = false;
let refreshSeq = 0;
let lastSavedBoundsKey = '';
let lastRefreshAt = 0;
let lastHeartbeatAt = 0;
let launcherCheckInFlight = false;
let launcherVisibilityHandler = null;
let launcherFocusHandler = null;
let idleBadgeCheckScheduled = false;
let lastKvSig = '';
let lastTitleBarSig = '';
let lastContextAlertsSig = '';
let lastContextBreakdownSig = '';
let lastContextDeferredSig = '';
let lastContextInventorySig = '';
let lastCallsRenderSig = '';
let lastVaultRenderSig = '';
let lastMiniBarSig = '';

// Detect standalone popout mode (?token=...) & native frameless WebView2 mode (?native=1)
const urlParams = new URLSearchParams(window.location.search);
const popoutToken = urlParams.get('token');
const isNativePopout = Boolean(popoutToken && urlParams.get('native') === '1');
const initialThemeParam = urlParams.get('theme');
if (popoutToken && urlParams.get('topmost') === '0') {
  state.windowPinned = false;
}
const popoutClientId = popoutToken
  ? `pop-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
  : null;
let mcpApp = null;
let i18nModule = null;
let governanceModule = null;
let appearanceModule = null;

function postHostWindowMsg(cmd) {
  try {
    window.chrome?.webview?.postMessage?.(String(cmd));
  } catch {
    // ignore outside native WebView2 host
  }
}

function detectCurrentTheme() {
  const dt = document.documentElement.dataset.theme;
  if (dt === 'dark' || dt === 'light') return dt;
  if (document.documentElement.classList.contains('dark')) return 'dark';
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtK(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(Math.round(num));
}

function fmtHrs(hrs) {
  const hTotal = Math.max(0, Math.round(Number(hrs) || 0));
  const d = Math.floor(hTotal / 24);
  const h = hTotal % 24;
  return d > 0 ? `将在 ${d} 天 ${h} 小时后完全重置` : `将在 ${h} 小时后完全重置`;
}

function fmtRelativeTime(iso) {
  if (!iso) return tr('common.justNow');
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return tr('common.justNow');
  if (diffSec < 3600) return tr('common.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return tr('common.hoursAgo', { n: Math.floor(diffSec / 3600) });
  return tr('common.daysAgo', { n: Math.floor(diffSec / 86400) });
}

function applyUiLanguage(lang) {
  const norm = normalizeUiLang(lang);
  if (!state.config || typeof state.config !== 'object') {
    state.config = { uiLanguage: norm };
  } else {
    state.config.uiLanguage = norm;
  }
  applyStaticTranslations(document, norm);

  const zhBtn = document.getElementById('uiLangZhBtn');
  const enBtn = document.getElementById('uiLangEnBtn');
  if (zhBtn) zhBtn.dataset.active = String(norm === 'zh-CN');
  if (enBtn) enBtn.dataset.active = String(norm === 'en');

  renderSelects('all');
  if (state.contextData) renderContext(false);
  if (state.callsData) renderCalls();
  if (state.vaultData) renderVault();
  if (state.capsuleData) renderCapsuleModal();
  renderSettings();
  renderNativePinButton();
  if (state.launcherMode) renderLauncherView();

  requestAnimationFrame(positionVisibleIndicators);
}

function showToast(msg, tone = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.dataset.tone = tone || 'info';
  t.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.dataset.show = 'false';
  }, 2600);
}

function animateNumber(el, from, to, fmt, dur = 480) {
  if (!el) return;
  if (activeAnims.has(el)) cancelAnimationFrame(activeAnims.get(el));
  if (!Number.isFinite(from) || Math.abs(to - from) < 0.0001) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) {
      activeAnims.set(el, requestAnimationFrame(frame));
    } else {
      activeAnims.delete(el);
    }
  }
  activeAnims.set(el, requestAnimationFrame(frame));
}

function pulseEl(el) {
  if (!el) return;
  el.classList.remove('kpi-bump');
  requestAnimationFrame(() => {
    el.classList.add('kpi-bump');
  });
}

function positionIndicator(navId, indId) {
  const nav = document.getElementById(navId);
  const ind = document.getElementById(indId);
  if (!nav || !ind) return;
  const active = nav.querySelector('[data-active="true"]');
  if (!active || active.offsetWidth === 0) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

function positionVisibleIndicators() {
  if (state.launcherMode || state.inSettings) return;
  if (state.activeModule === 'monitor') {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    if (state.activeTab === 'calls') {
      positionIndicator('callsModeNav', 'callsModeIndicator');
    }
    const capModal = document.getElementById('capsuleModal');
    if (capModal?.dataset.open === 'true') {
      positionIndicator('capsuleModeNav', 'capsuleModeIndicator');
    }
  } else if (state.activeModule === 'governance') {
    governanceModule?.positionSubNav();
  } else if (state.activeModule === 'appearance') {
    appearanceModule?.positionSubNav();
  } else if (state.activeModule === 'i18n') {
    i18nModule?.positionSubNav();
  }
}

/**
 * Unified server tool bridge (0 LLM tokens — invokes visibility:["app"] private tools).
 */
async function callAppTool(name, args = {}) {
  if (popoutToken) {
    const resp = await fetch(`/api/tool?token=${encodeURIComponent(popoutToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cc-token': popoutToken },
      body: JSON.stringify({ name, arguments: args }),
    });
    const res = await resp.json();
    if (res.isError) throw new Error(res.content?.[0]?.text || 'Tool call failed');
    return res.structuredContent ?? res;
  }
  if (!mcpApp) throw new Error('MCP App not connected');
  const res = await mcpApp.callServerTool({ name, arguments: args });
  if (res?.isError) throw new Error(res.content?.[0]?.text || 'Tool call failed');
  return res?.structuredContent ?? res;
}

// ==================== Custom Popover Select ====================
function renderCustomSelect(hostId, { id, value, options, alignRight = false, fullWidth = false, triggerLabel = null, skipIfOpen = false }) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const isOpen = state.openSelectId === id;
  if (skipIfOpen && isOpen) return;
  const opts = options.length ? options : [{ value: '', label: tr('common.empty') }];
  const current = opts.find((o) => o.value === value) || opts[0];
  const shownLabel = triggerLabel ?? current.label;
  const sig = `${id}|${current.value}|${shownLabel}|${alignRight ? 1 : 0}|${fullWidth ? 1 : 0}|${isOpen ? 1 : 0}|${opts.map((o) => `${o.value}:${o.label}`).join('\u001f')}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger ${fullWidth ? 'w-full' : ''}" aria-expanded="${isOpen}" data-select-toggle="${esc(id)}">
      <span class="truncate">${esc(shownLabel)}</span>
      <svg class="agy-select-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M4.2 6.2L8 10l3.8-3.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="agy-select-menu ${alignRight ? 'align-right' : ''} ${fullWidth ? 'w-full' : ''}" data-open="${isOpen}">
      ${opts
        .map(
          (opt) => `
        <button type="button" class="agy-select-opt" data-selected="${opt.value === current.value}" data-select-pick="${esc(id)}" data-select-val="${esc(opt.value)}">
          <span class="truncate">${esc(opt.label)}</span>
          ${
            opt.value === current.value
              ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><path d="M3.5 8.5L6.5 11.5L12.5 4.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
              : ''
          }
        </button>
      `
        )
        .join('')}
    </div>
  `;
}

function renderPollSelect(fromPoll = false) {
  const host = document.getElementById('pollIntervalHost');
  if (!host) return;
  const isOpen = state.openSelectId === 'pollInterval';
  if (fromPoll && isOpen) return;
  const pollOptions = getPollOptions();
  const val = String(state.config.pollIntervalSec ?? 5);
  const cur = pollOptions.find((o) => o.value === val) || pollOptions[1];
  const isLive = Number(val) > 0;
  const lang = getUiLang();
  const sig = `${lang}|${val}|${isOpen ? 1 : 0}|${isLive ? 1 : 0}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger pill-trigger" aria-expanded="${isOpen}" data-select-toggle="pollInterval" title="${esc(tr('monitor.header.pollTitle'))}">
      ${
        isLive
          ? `<span class="live-halo"><span></span></span>`
          : `<span class="dot-sm" style="background: var(--muted-foreground); opacity: 0.5;"></span>`
      }
      <span class="mono-num text-xs">${esc(cur.short)}</span>
      <svg class="agy-select-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M4.2 6.2L8 10l3.8-3.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="agy-select-menu align-right" data-open="${isOpen}">
      ${pollOptions.map(
        (opt) => `
        <button type="button" class="agy-select-opt" data-selected="${opt.value === val}" data-select-pick="pollInterval" data-select-val="${esc(opt.value)}">
          <span>${esc(opt.label)}</span>
          ${
            opt.value === val
              ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><path d="M3.5 8.5L6.5 11.5L12.5 4.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
              : ''
          }
        </button>
      `
      ).join('')}
    </div>
  `;
}

function renderFollowToggle() {
  const btn = document.getElementById('followToggleBtn');
  if (!btn) return;
  const isAuto = state.followMode === 'auto';
  const sig = `${getUiLang()}|${isAuto ? 'auto' : 'pinned'}`;
  if (btn.dataset.followSig === sig) return;
  btn.dataset.followSig = sig;
  btn.dataset.mode = isAuto ? 'auto' : 'pinned';
  btn.title = isAuto ? tr('monitor.header.followAutoTitle') : tr('monitor.header.followPinnedTitle');
  btn.innerHTML = isAuto
    ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;
}

function formatShortModel(model) {
  const m = String(model || '').trim();
  if (!m) return '—';
  let s = m
    .replace(/^gemini-/i, '')
    .replace(/^claude-/i, '')
    .replace(/-tiered-/i, '-')
    .replace(/hydrogen/i, 'hydro')
    .replace(/-xhigh$/i, '-xh')
    .replace(/-high$/i, '-H')
    .replace(/-medium$/i, '-M')
    .replace(/-low$/i, '-L');
  return s;
}

function clampOpenSelectMenus() {
  requestAnimationFrame(() => {
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const pad = 8;
    document.querySelectorAll('.agy-select-menu[data-open="true"]').forEach((menu) => {
      menu.style.left = '';
      menu.style.right = '';
      menu.style.maxWidth = `${Math.max(160, vw - pad * 2)}px`;
      const rect = menu.getBoundingClientRect();
      if (rect.left < pad) {
        // Menu overflowed left edge (e.g. align-right menu wrapped to left column): anchor to left
        menu.style.left = '0';
        menu.style.right = 'auto';
        const r2 = menu.getBoundingClientRect();
        if (r2.right > vw - pad) {
          menu.style.left = `${Math.max(pad - r2.left, vw - pad - r2.right)}px`;
        }
      } else if (rect.right > vw - pad) {
        menu.style.left = 'auto';
        menu.style.right = '0';
        const r2 = menu.getBoundingClientRect();
        if (r2.left < pad) {
          menu.style.right = `${Math.max(0, r2.left - pad)}px`;
        }
      }
    });
  });
}

function renderSessionSelect(fromPoll = false) {
  const host = document.getElementById('sessionSelectHost');
  if (!host) return;
  const isOpen = state.openSelectId === 'sessionSelect';
  if (fromPoll && isOpen) return;
  const sessions = state.contextData?.sessions || [];
  const isAggregate = state.pinnedConversationId === '__active_all__' || state.activeConversationId === '__active_all__';
  const isAuto = !isAggregate && state.followMode === 'auto';
  const activeId = isAggregate ? '__active_all__' : isAuto ? state.activeConversationId : state.pinnedConversationId || state.activeConversationId;
  const matched = sessions.find((s) => s.id === activeId) || sessions[0] || null;
  const activeCount = sessions.filter((s) => s.isActive).length;
  const sig = `${getUiLang()}|${isOpen ? 1 : 0}|${isAggregate ? 1 : 0}|${isAuto ? 1 : 0}|${activeId || ''}|${activeCount}|${sessions.map((s) => `${s.id}:${s.label}:${s.isActive ? 1 : 0}:${s.stepCount || 0}:${s.subTag || ''}`).join('\u001f')}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;
  const titleText = isAggregate
    ? (activeCount ? tr('monitor.session.aggregateTitleActive', { count: activeCount }) : tr('monitor.session.aggregateTitle'))
    : matched
      ? (matched.isSubagent && matched.subTag ? `${matched.subTag} / ${matched.label}` : matched.label)
      : tr('monitor.session.waiting');

  const modeChipHtml = isAggregate
    ? `<span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.aggregateChip'))}</span></span>`
    : isAuto
      ? `<span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.autoChip'))}</span></span>`
      : `<span class="session-mode-chip" data-mode="pinned"><span>${esc(tr('monitor.session.pinnedChip'))}</span></span>`;

  const checkSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><path d="M3.5 8.5L6.5 11.5L12.5 4.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const sessionsHtml = sessions.length
    ? sessions
        .map((s) => {
          const isCur = !isAggregate && s.id === (matched?.id || activeId);
          return `
        <button type="button" class="agy-select-opt" data-selected="${isCur}" data-select-pick="sessionSelect" data-select-val="${esc(s.id)}">
          <span class="flex items-center gap-1.5 min-w-0">
            ${s.isActive ? `<span class="session-live-dot" title="${esc(tr('monitor.session.recentActive'))}"></span>` : ''}
            ${s.isSubagent ? `<span class="session-sub-pill">${esc(s.subTag || tr('monitor.session.subTag'))}</span>` : ''}
            <span class="truncate">${esc(s.label)}</span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            ${s.stepCount ? `<span class="session-opt-meta mono-num">${esc(tr('monitor.session.stepsShort', { count: s.stepCount }))}</span>` : ''}
            ${isCur ? checkSvg : ''}
          </span>
        </button>`;
        })
        .join('')
    : `<div class="px-2.5 py-2 text-xs text-muted">${esc(tr('monitor.session.emptyWorkspace'))}</div>`;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger w-full" aria-expanded="${isOpen}" data-select-toggle="sessionSelect">
      <span class="session-trigger-inner">
        ${modeChipHtml}
        <span class="truncate text-fg">${esc(titleText)}</span>
      </span>
      <svg class="agy-select-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M4.2 6.2L8 10l3.8-3.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="agy-select-menu w-full" data-open="${isOpen}">
      <button type="button" class="agy-select-opt" data-selected="${isAuto}" data-select-pick="sessionSelect" data-select-val="__auto__">
        <span class="flex items-center gap-2 min-w-0">
          <span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.autoChip'))}</span></span>
          <span class="truncate">${esc(tr('monitor.session.autoOption'))}</span>
        </span>
        ${isAuto ? checkSvg : ''}
      </button>
      <button type="button" class="agy-select-opt" data-selected="${isAggregate}" data-select-pick="sessionSelect" data-select-val="__active_all__">
        <span class="flex items-center gap-2 min-w-0">
          <span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.aggregateChip'))}</span></span>
          <span class="truncate">${esc(tr('monitor.session.aggregateOption'))}</span>
        </span>
        ${isAggregate ? checkSvg : ''}
      </button>
      <div class="session-menu-divider"></div>
      <div class="session-menu-caption">${esc(tr('monitor.session.listCaption'))}</div>
      ${sessionsHtml}
    </div>
  `;
}

function renderMonitorHeaderSelects(fromPoll = false) {
  renderPollSelect(fromPoll);
  renderFollowToggle();
  renderSessionSelect(fromPoll);
}

function renderCallsSelects(fromPoll = false) {
  renderCustomSelect('agentSelectHost', {
    id: 'agentSelect',
    value: state.agentFilter,
    options: [
      { value: 'all', label: tr('monitor.calls.agentAll') },
      { value: 'main', label: tr('monitor.calls.agentMain') },
      { value: 'sub', label: tr('monitor.calls.agentSub') },
    ],
    skipIfOpen: fromPoll,
  });

  const models = state.callsData?.models || [];
  renderCustomSelect('modelSelectHost', {
    id: 'modelSelect',
    value: state.modelFilter,
    options: [{ value: 'all', label: tr('monitor.calls.modelAll') }, ...models.map((m) => ({ value: m, label: m }))],
    alignRight: true,
    skipIfOpen: fromPoll,
  });
}

function renderVaultSelects(fromPoll = false) {
  renderCustomSelect('vaultKindSelectHost', {
    id: 'vaultKindSelect',
    value: state.vaultKind,
    options: [
      { value: 'all', label: tr('monitor.vault.kindAll') },
      { value: 'working_state', label: 'working_state' },
      { value: 'decision', label: 'decision' },
      { value: 'architecture', label: 'architecture' },
      { value: 'pitfall', label: 'pitfall' },
      { value: 'checkpoint', label: 'checkpoint' },
    ],
    alignRight: true,
    skipIfOpen: fromPoll,
  });

  renderCustomSelect('newMemKindSelectHost', {
    id: 'newMemKindSelect',
    value: state.newMemKind,
    options: [
      { value: 'decision', label: tr('monitor.vault.kindDecision') },
      { value: 'working_state', label: tr('monitor.vault.kindWorkingState') },
      { value: 'architecture', label: tr('monitor.vault.kindArchitecture') },
      { value: 'pitfall', label: tr('monitor.vault.kindPitfall') },
    ],
    fullWidth: true,
    skipIfOpen: fromPoll,
  });
}

function renderSettingsSelects(fromPoll = false) {
  const pollOptions = getPollOptions();
  renderCustomSelect('settingsPollHost', {
    id: 'settingsPoll',
    value: String(state.config.pollIntervalSec ?? 5),
    options: pollOptions.map((o) => ({ value: o.value, label: o.label })),
    alignRight: true,
    skipIfOpen: fromPoll,
  });

  renderCustomSelect('popoutSizeSelectHost', {
    id: 'popoutSize',
    value: state.config.popout?.size || '460x720',
    options: getPopoutSizes(),
    skipIfOpen: fromPoll,
  });
}

function renderSelects(scope = 'visible', { fromPoll = false } = {}) {
  const isAll = scope === 'all';
  const isVisible = scope === 'visible';
  const onMonitor = !state.inSettings && state.activeModule === 'monitor';

  if (isAll || scope === 'monitor-header' || (isVisible && onMonitor)) {
    renderMonitorHeaderSelects(fromPoll);
  }
  if (isAll || scope === 'calls' || (isVisible && onMonitor && state.activeTab === 'calls')) {
    renderCallsSelects(fromPoll);
  }
  if (
    isAll ||
    scope === 'vault' ||
    (isVisible && ((onMonitor && state.activeTab === 'vault') || document.getElementById('addMemModal')?.dataset.open === 'true'))
  ) {
    renderVaultSelects(fromPoll);
  }
  if (
    FEATURE_FLAGS.showQuotaUi &&
    (isAll || scope === 'quota' || (isVisible && (state.activeTab === 'quota' || document.getElementById('quotaModal')?.dataset.open === 'true')))
  ) {
    const qGroups = state.quotaData?.groups || [
      { id: 'gemini', name: 'Gemini 模型' },
      { id: 'claude_gpt', name: 'Claude 与 GPT 模型' },
      { id: 'argon', name: 'Gemini 4 Argon' },
    ];
    renderCustomSelect('calGroupSelectHost', {
      id: 'calGroupSelect',
      value: state.calGroup,
      options: qGroups.map((g) => ({ value: g.id, label: g.name })),
      fullWidth: true,
      skipIfOpen: fromPoll,
    });
  }
  if (isAll || scope === 'settings' || (isVisible && state.inSettings)) {
    renderSettingsSelects(fromPoll);
  }
  if (isAll || scope === 'i18n' || (isVisible && !state.inSettings && state.activeModule === 'i18n')) {
    i18nModule?.renderSelects();
  }
  if (isAll || scope === 'appearance' || (isVisible && !state.inSettings && state.activeModule === 'appearance')) {
    appearanceModule?.renderSelects();
  }
  if (state.openSelectId) {
    clampOpenSelectMenus();
  }
}

async function handleSelectPick(id, val) {
  state.openSelectId = null;
  if (id === 'sessionSelect') {
    if (val === '__auto__' || !val) {
      state.followMode = 'auto';
      state.pinnedConversationId = null;
      resetSessionViewState();
      renderSelects();
      await refreshAll(true, false, true);
      showToast(tr('toast.followAuto'));
      return;
    }

    if (val === '__active_all__') {
      state.followMode = 'pinned';
      state.pinnedConversationId = '__active_all__';
      state.activeConversationId = '__active_all__';
      resetSessionViewState();
      renderSelects();
      await refreshAll(true, false, true);
      showToast(tr('toast.aggregateMode'));
      return;
    }

    if (state.followMode === 'pinned') {
      state.pinnedConversationId = val;
      state.activeConversationId = val;
      resetSessionViewState();
      renderSelects();
      await refreshAll(true, false, true);
      return;
    }

    // In auto-follow mode, selecting a session syncs all open views (aux pane + floating popout)
    state.activeConversationId = val;
    resetSessionViewState();
    renderSelects();
    await callAppTool('app_config_manage', { action: 'set_active_session', conversationId: val }).catch(() => {});
    await refreshAll(true, false, true);
    showToast(tr('toast.sessionSynced'));
    return;
  }
  if (id === 'pollInterval' || id === 'settingsPoll') {
    const sec = Number(val);
    state.config.pollIntervalSec = sec;
    renderSelects();
    restartPollTimer();
    try {
      await persistConfigPatch({ pollIntervalSec: sec });
      const opt = getPollOptions().find((o) => o.value === val);
      showToast(sec > 0 ? tr('toast.pollUpdated', { interval: opt?.short || `${sec}s` }) : tr('toast.pollManual'));
    } catch (err) {
      showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
    }
    return;
  }
  if (id === 'popoutSize') {
    state.config.popout = { ...(state.config.popout || {}), size: val };
    renderSelects();
    try {
      await persistConfigPatch({ popout: { size: val } });
      showToast(tr('toast.popoutSize', { size: val }));
    } catch (err) {
      showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
    }
    return;
  }
  if (id === 'agentSelect') {
    state.agentFilter = val;
    renderSelects();
    await loadCalls();
    return;
  }
  if (id === 'modelSelect') {
    state.modelFilter = val;
    renderSelects();
    await loadCalls();
    return;
  }
  if (id === 'vaultKindSelect') {
    state.vaultKind = val;
    renderSelects();
    await loadVault();
    return;
  }
  if (id === 'calGroupSelect') {
    state.calGroup = val;
    renderSelects();
    prefillQuotaInputs();
    return;
  }
  if (id === 'newMemKindSelect') {
    state.newMemKind = val;
    renderSelects();
    return;
  }
  if (i18nModule && (await i18nModule.handleSelectPick(id, val))) {
    return;
  }
  if (appearanceModule && (await appearanceModule.handleSelectPick(id, val))) {
    return;
  }
}

// ==================== Rendering ====================
function fitNativeTitleBar() {
  const titleBar = document.getElementById('nativeTitleBar');
  const dragZone = document.getElementById('titleBarDragZone');
  if (!titleBar || !dragZone || titleBar.classList.contains('hidden')) return;

  const nameEl = dragZone.querySelector('.native-titlebar-name');
  const miniModsEl = document.getElementById('titleBarMiniModules');
  const tpsEl = document.getElementById('titleBarTpsBadge');
  const modelEl = document.getElementById('titleBarModelBadge');
  const hasModel = Boolean(modelEl && modelEl.dataset.fullModel && !modelEl.classList.contains('hidden'));
  const hasTps = Boolean(tpsEl && !tpsEl.classList.contains('hidden'));
  const collapsed = state.windowCollapsed;

  if (collapsed) {
    nameEl?.classList.add('titlebar-fit-hidden');
    miniModsEl?.classList.remove('hidden');
    if (!miniModsEl) return;

    const preset = state.config?.popout?.miniBarPreset || 'standard';
    const maxSlots = MINI_BAR_PRESET_COUNTS[preset] || 3;
    const chips = [...miniModsEl.querySelectorAll('.mini-mod-chip')];
    const activeChips = [];

    chips.forEach((chip, idx) => {
      const mod = chip.dataset.mod;
      if (mod === 'model' && chip.dataset.fullModel) {
        chip.textContent = chip.dataset.fullModel;
      }
      const allowedByPreset = idx < maxSlots;
      const available = chip.dataset.available !== 'false';
      const show = allowedByPreset && available;
      chip.classList.toggle('titlebar-fit-hidden', !show);
      if (show) activeChips.push(chip);
    });

    const overflows = () => dragZone.scrollWidth > dragZone.clientWidth + 1;
    if (!overflows()) return;

    // 1. Shorten model chip before hiding any module
    const modelChip = activeChips.find((c) => c.dataset.mod === 'model');
    if (modelChip && modelChip.dataset.shortModel) {
      modelChip.textContent = modelChip.dataset.shortModel;
      if (!overflows()) return;
    }

    // 2. Hide trailing chips cleanly one by one so zero glyphs or borders get clipped
    for (let i = activeChips.length - 1; i >= 0; i--) {
      if (!overflows()) break;
      activeChips[i].classList.add('titlebar-fit-hidden');
    }
    return;
  }

  miniModsEl?.classList.add('hidden');
  nameEl?.classList.remove('titlebar-fit-hidden');
  tpsEl?.classList.remove('titlebar-fit-hidden');
  modelEl?.classList.remove('titlebar-fit-hidden');
  if (hasModel) modelEl.textContent = modelEl.dataset.fullModel;

  const overflows = () => dragZone.scrollWidth > dragZone.clientWidth + 1;
  if (!overflows()) return;

  // Expanded mode: keep brand visible; degrade model/TPS cleanly without clipping
  if (hasModel && modelEl.dataset.shortModel) {
    modelEl.textContent = modelEl.dataset.shortModel;
    if (!overflows()) return;
  }
  if (hasModel) {
    modelEl.classList.add('titlebar-fit-hidden');
    if (!overflows()) return;
  }
  if (hasTps) {
    tpsEl.classList.add('titlebar-fit-hidden');
  }
}

function getMiniBarModules() {
  const raw = state.config?.popout?.miniBarModules;
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

function computeGeminiKvState() {
  const enabled = state.config?.kvCache?.enabled !== false;
  const ctx = state.contextData;
  const activeModel = String(ctx?.latestModel || ctx?.model || '').trim();
  const isGemini = /gemini/i.test(activeModel);
  const ttlMin = Math.max(3, Math.min(60, Math.round(Number(state.config?.kvCache?.ttlMinutes) || 15)));
  const ttlMs = ttlMin * 60_000;

  if (!enabled || !isGemini) {
    return { visible: false, isGemini, state: 'safe', text: '--:--', title: '', ttlMin };
  }
  if (ctx?.isTurnActive) {
    return {
      visible: true,
      isGemini: true,
      state: 'safe',
      active: true,
      text: tr('monitor.kv.active'),
      title: tr('monitor.kv.titleActive'),
      ttlMin,
    };
  }
  const lastTs = Number(ctx?.latestCallTsMs) || 0;
  if (!lastTs || (Number(ctx?.totalCallsCount) || 0) === 0) {
    return {
      visible: true,
      isGemini: true,
      state: 'safe',
      waiting: true,
      text: tr('monitor.kv.waiting'),
      title: tr('monitor.kv.titleSafe', { rem: `${ttlMin}:00`, ttl: ttlMin }),
      ttlMin,
    };
  }

  const idleMs = Math.max(0, Date.now() - lastTs);
  const remMs = Math.max(0, ttlMs - idleMs);
  const ratio = idleMs / ttlMs;
  const kvState = ratio <= 1 / 3 ? 'safe' : ratio <= 4 / 5 ? 'warn' : 'danger';

  const fmtClock = (ms) => {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const text = remMs > 0 ? fmtClock(remMs) : tr('monitor.kv.expired');
  const title =
    kvState === 'safe'
      ? tr('monitor.kv.titleSafe', { rem: fmtClock(remMs), ttl: ttlMin })
      : kvState === 'warn'
        ? tr('monitor.kv.titleWarn', { rem: fmtClock(remMs), ttl: ttlMin })
        : tr('monitor.kv.titleDanger', { idle: fmtClock(idleMs), ttl: ttlMin });

  return { visible: true, isGemini: true, state: kvState, text, title, ttlMin, remMs, idleMs };
}

function syncKvCountdownUi() {
  const kv = computeGeminiKvState();
  const sig = `${kv.visible ? 1 : 0}|${kv.state}|${kv.text}|${kv.title}`;
  if (sig === lastKvSig) return;
  lastKvSig = sig;

  document.querySelectorAll('.hub-brand-svg').forEach((svg) => {
    const nextState = kv.visible ? kv.state : 'safe';
    if (svg.dataset.kvState !== nextState) svg.dataset.kvState = nextState;
  });

  const wrap = document.getElementById('kvCountdownWrap');
  const pill = document.getElementById('kvCountdownPill');
  const txt = document.getElementById('kvCountdownText');
  if (wrap && pill && txt) {
    wrap.classList.toggle('hidden', !kv.visible);
    if (kv.visible) {
      pill.dataset.kvState = kv.state;
      pill.title = kv.title;
      txt.textContent = kv.text;
    }
  }

  const miniKvChip = document.querySelector('#titleBarMiniModules .mini-mod-chip[data-mod="kv"]');
  if (miniKvChip) {
    const prevAvail = miniKvChip.dataset.available;
    const nextAvail = kv.visible ? 'true' : 'false';
    miniKvChip.dataset.available = nextAvail;
    miniKvChip.dataset.kvState = kv.visible ? kv.state : 'muted';
    miniKvChip.title = kv.title || '';
    const valSpan = miniKvChip.querySelector('.mini-mod-val');
    if (valSpan) valSpan.textContent = kv.text;
    if (state.windowCollapsed && prevAvail !== nextAvail) {
      requestAnimationFrame(fitNativeTitleBar);
    }
  }
}

function renderCollapsedMiniModules(ctx, pct, cache, tps, followTag) {
  const host = document.getElementById('titleBarMiniModules');
  if (!host) return;
  const order = getMiniBarModules();
  const activeModel = String(ctx?.latestModel || ((Number(ctx?.totalCallsCount) || 0) > 0 ? ctx?.model : '') || '').trim();
  const hasCalls = (Number(ctx?.totalCallsCount) || 0) > 0;
  const kv = computeGeminiKvState();

  host.innerHTML = order
    .map((mod) => {
      if (mod === 'context') {
        const label = `${pct.toFixed(1)}%`;
        return `<span class="mini-mod-chip mono-num" data-mod="context" data-available="true" title="${esc(tr('titlebar.miniSummaryTitle', { pct: pct.toFixed(1), cache: cache.toFixed(1), mode: followTag }))}">${esc(label)}</span>`;
      }
      if (mod === 'cache') {
        const label = getUiLang() === 'en' ? `${cache.toFixed(0)}% Hit` : `${cache.toFixed(0)}% 缓存`;
        return `<span class="mini-mod-chip mono-num" data-mod="cache" data-available="true" title="${esc(tr('titlebar.miniSummaryTitle', { pct: pct.toFixed(1), cache: cache.toFixed(1), mode: followTag }))}">${esc(label)}</span>`;
      }
      if (mod === 'kv') {
        return `<span class="mini-mod-chip mono-num" data-mod="kv" data-available="${kv.visible ? 'true' : 'false'}" data-kv-state="${kv.visible ? kv.state : 'muted'}" title="${esc(kv.title || '')}"><span class="mini-mod-dot" aria-hidden="true"></span><span class="mini-mod-val">${esc(kv.text)}</span></span>`;
      }
      if (mod === 'tps') {
        const text = hasCalls || tps > 0 ? `${tps.toFixed(1)} t/s` : '-- t/s';
        const tone = hasCalls || tps > 0 ? (tps < 15 ? 'warn' : 'ok') : 'muted';
        return `<span class="mini-mod-chip mono-num" data-mod="tps" data-available="true" data-tone="${tone}" title="${esc(hasCalls || tps > 0 ? tr('titlebar.tpsBadgeTitle', { tps: tps.toFixed(1), mode: followTag }) : tr('titlebar.tpsWaitingTitle', { mode: followTag }))}">${esc(text)}</span>`;
      }
      if (mod === 'model') {
        const shortM = activeModel ? formatShortModel(activeModel) : '';
        return `<span class="mini-mod-chip mono-num" data-mod="model" data-available="${activeModel ? 'true' : 'false'}" data-full-model="${esc(activeModel)}" data-short-model="${esc(shortM)}" title="${esc(activeModel ? tr('titlebar.modelBadgeTitle', { model: activeModel, mode: followTag }) : '')}">${esc(activeModel)}</span>`;
      }
      return '';
    })
    .join('');
}

function updateNativeTitleBarTelemetry(ctx, pct, cache, tps) {
  if (!isNativePopout) return;
  const isAggregate =
    state.pinnedConversationId === '__active_all__' ||
    state.activeConversationId === '__active_all__' ||
    ctx?.conversationId === '__active_all__';
  const followTag = isAggregate
    ? tr('titlebar.modeAggregate')
    : state.followMode === 'auto'
      ? tr('titlebar.modeAuto')
      : tr('titlebar.modePinned');

  const activeModel = String(ctx?.latestModel || ((Number(ctx?.totalCallsCount) || 0) > 0 ? ctx?.model : '') || '').trim();
  const hasCalls = (Number(ctx?.totalCallsCount) || 0) > 0;
  const modOrder = getMiniBarModules().join(',');
  const preset = state.config?.popout?.miniBarPreset || 'standard';
  const titleBarSig = `${getUiLang()}|${followTag}|${pct.toFixed(1)}|${cache.toFixed(1)}|${tps.toFixed(1)}|${activeModel}|${hasCalls ? 1 : 0}|${modOrder}|${preset}`;
  if (titleBarSig === lastTitleBarSig) {
    syncKvCountdownUi();
    return;
  }
  lastTitleBarSig = titleBarSig;

  const miniEl = document.getElementById('titleBarMiniSummary');
  if (miniEl) {
    miniEl.textContent = tr('titlebar.miniSummary', { pct: pct.toFixed(1), cache: cache.toFixed(0) });
    miniEl.title = tr('titlebar.miniSummaryTitle', { pct: pct.toFixed(1), cache: cache.toFixed(1), mode: followTag });
  }

  const modelEl = document.getElementById('titleBarModelBadge');
  if (modelEl) {
    if (activeModel) {
      modelEl.dataset.fullModel = activeModel;
      modelEl.dataset.shortModel = formatShortModel(activeModel);
      modelEl.textContent = activeModel;
      modelEl.title = tr('titlebar.modelBadgeTitle', { model: activeModel, mode: followTag });
      modelEl.classList.remove('hidden');
    } else {
      modelEl.dataset.fullModel = '';
      modelEl.dataset.shortModel = '';
      modelEl.textContent = '';
      modelEl.classList.add('hidden');
    }
  }

  const tpsEl = document.getElementById('titleBarTpsBadge');
  if (tpsEl) {
    if (hasCalls || tps > 0) {
      tpsEl.textContent = `${tps.toFixed(1)} tok/s`;
      tpsEl.dataset.tone = tps < 15 ? 'warn' : 'ok';
      tpsEl.title = tr('titlebar.tpsBadgeTitle', { tps: tps.toFixed(1), mode: followTag });
    } else {
      tpsEl.textContent = '-- tok/s';
      tpsEl.dataset.tone = 'muted';
      tpsEl.title = tr('titlebar.tpsWaitingTitle', { mode: followTag });
    }
    tpsEl.classList.remove('hidden');
  }

  renderCollapsedMiniModules(ctx, pct, cache, tps, followTag);
  lastKvSig = '';
  syncKvCountdownUi();
  requestAnimationFrame(fitNativeTitleBar);
}

function renderContext(animated = false) {
  const ctx = state.contextData;
  if (!ctx) return;
  const lang = getUiLang();

  const gitPill = document.getElementById('gitBadgePill');
  const gitBranchEl = document.getElementById('gitBranchLabel');
  const gitHeadEl = document.getElementById('gitHeadLabel');
  const gitDirtyEl = document.getElementById('gitDirtyDot');
  const rawBranch = String(ctx.git?.branch || '').trim();
  const rawHead = String(ctx.git?.head || '').trim();
  const isNoGit = !rawBranch || rawBranch === 'nogit';
  if (gitPill) gitPill.dataset.nogit = String(isNoGit);
  if (gitBranchEl) gitBranchEl.textContent = isNoGit ? tr('monitor.header.noGit') : rawBranch;
  if (gitHeadEl) gitHeadEl.textContent = !isNoGit && rawHead && rawHead !== 'none' ? rawHead : '';
  if (gitDirtyEl) gitDirtyEl.classList.toggle('hidden', isNoGit || !ctx.git?.dirty);
  syncKvCountdownUi();
  document.getElementById('tabCallsCount').textContent = String(ctx.totalCallsCount ?? 0);

  const alerts = ctx.alerts || [];
  const alertsSig = `${lang}|${alerts.map((a) => `${a.level}:${a.code || ''}:${a.title}:${a.detail}`).join('\u001f')}`;
  if (alertsSig !== lastContextAlertsSig) {
    lastContextAlertsSig = alertsSig;
    document.getElementById('alertCountLabel').textContent = tr('monitor.header.alertsCount', { count: alerts.length });
    const alertDot = document.getElementById('alertDot');
    alertDot.style.background = alerts.some((a) => a.level === 'error')
      ? 'var(--error)'
      : alerts.length > 0
        ? 'var(--warning)'
        : 'var(--success)';

    const alertsList = document.getElementById('alertsList');
    if (!alerts.length) {
      alertsList.innerHTML = `<div class="py-2 text-xs text-muted">${esc(tr('monitor.header.alertsEmpty'))}</div>`;
    } else {
      alertsList.innerHTML = alerts
        .map(
          (a, idx) => `
      <button type="button" class="alert-row-btn text-xs" data-alert-idx="${idx}">
        <span class="flex items-start gap-2.5 min-w-0 flex-1">
          <span class="dot-sm mt-1.5" style="background: var(--${a.level === 'error' ? 'error' : 'warning'})"></span>
          <span class="space-y-0.5 min-w-0 flex-1">
            <span class="block font-medium text-fg">${esc(a.title)}</span>
            <span class="block text-muted">${esc(a.detail)}</span>
          </span>
        </span>
        <span class="alert-row-chevron" aria-hidden="true">›</span>
      </button>
    `
        )
        .join('');
    }
  }

  const warnPct = state.config.alerts?.contextWarningPct ?? 75;
  document.getElementById('ctxThresholdLine').style.left = `${warnPct}%`;
  document.getElementById('ctxThresholdLabel').textContent = `${warnPct}%`;

  const pct = Number(ctx.usedPercent) || 0;
  const used = Number(ctx.usedTokens) || 0;
  const limit = Number(ctx.limitTokens) || 200000;
  const free = Number(ctx.freeTokens) || Math.max(0, limit - used);
  const cache = Number(ctx.latestCacheHitRate) || 0;
  const tps = Number(ctx.avgTps) || 0;
  const cost = Number(ctx.totalCostUsd) || 0;

  const pctEl = document.getElementById('ctxPctBig');
  pctEl.style.color = pct >= warnPct ? 'var(--warning)' : 'var(--foreground)';

  const cacheEl = document.getElementById('kpiCache');
  cacheEl.style.color = cache < 60 && used > 0 ? 'var(--error)' : cache >= 85 ? 'var(--success)' : 'var(--warning)';

  const ratioEl = document.getElementById('ctxRatioLabel');
  const tpsEl = document.getElementById('kpiTps');
  const freeEl = document.getElementById('kpiFree');
  const costEl = document.getElementById('kpiCost');

  const pctChanged = Math.abs(pct - prevDisplay.pct) >= 0.05;
  const cacheChanged = Math.abs(cache - prevDisplay.cache) >= 0.05;
  const tpsChanged = Math.abs(tps - prevDisplay.tps) >= 0.05;

  if (animated) {
    animateNumber(pctEl, prevDisplay.pct, pct, (v) => `${v.toFixed(1)}%`, 520);
    animateNumber(ratioEl, prevDisplay.used, used, (v) => `${fmtK(Math.round(v))} / ${fmtK(limit)}`, 520);
    animateNumber(cacheEl, prevDisplay.cache, cache, (v) => `${v.toFixed(1)}%`, 500);
    animateNumber(tpsEl, prevDisplay.tps, tps, (v) => `${v.toFixed(1)} tok/s`, 500);
    animateNumber(freeEl, prevDisplay.free, free, (v) => fmtK(Math.round(v)), 520);
    animateNumber(costEl, prevDisplay.cost, cost, (v) => `$${v.toFixed(3)}`, 500);
    if (pctChanged) pulseEl(pctEl);
    if (cacheChanged) pulseEl(cacheEl);
    if (tpsChanged) pulseEl(tpsEl);
  } else {
    pctEl.textContent = `${pct.toFixed(1)}%`;
    ratioEl.textContent = `${fmtK(used)} / ${fmtK(limit)}`;
    cacheEl.textContent = `${cache.toFixed(1)}%`;
    tpsEl.textContent = `${tps.toFixed(1)} tok/s`;
    freeEl.textContent = fmtK(free);
    costEl.textContent = `$${cost.toFixed(3)}`;
  }

  prevDisplay.pct = pct;
  prevDisplay.used = used;
  renderContextModelSim();
  prevDisplay.cache = cache;
  prevDisplay.tps = tps;
  prevDisplay.free = free;
  prevDisplay.cost = cost;

  updateNativeTitleBarTelemetry(ctx, pct, cache, tps);

  document.getElementById('ctxAttribution').textContent = ctx.attribution || '';

  // In-place DOM patch for multi-segment bar (guaranteed CSS width transition)
  const breakdown = ctx.breakdown || [];
  const breakdownSig = `${lang}|${limit}|${free}|${pct.toFixed(2)}|${breakdown.map((b) => `${b.id}:${b.tokens}:${b.color}:${b.key || ''}:${b.note || ''}`).join('\u001f')}`;
  if (breakdownSig !== lastContextBreakdownSig) {
    lastContextBreakdownSig = breakdownSig;
    const segBar = document.getElementById('ctxSegBar');
    const existingSegs = segBar.querySelectorAll('.ctx-seg');
    if (existingSegs.length === breakdown.length) {
      breakdown.forEach((b, i) => {
        const w = b.tokens > 0 ? Math.max(0.8, (b.tokens / limit) * 100) : 0;
        existingSegs[i].style.width = `${w}%`;
        existingSegs[i].style.background = b.color;
        existingSegs[i].dataset.id = b.id;
      });
    } else {
      segBar.innerHTML = breakdown
        .map((b) => {
          const w = b.tokens > 0 ? Math.max(0.8, (b.tokens / limit) * 100) : 0;
          return `<div class="ctx-seg" data-id="${esc(b.id)}" style="width:${w}%; background:${esc(b.color)};"></div>`;
        })
        .join('');
    }

    document.getElementById('ctxBreakdownList').innerHTML =
      breakdown
        .map((b) => {
          const bp = limit > 0 ? ((b.tokens / limit) * 100).toFixed(1) : '0.0';
          const loc = localizeBreakdownItem(b, lang);
          return `
      <div class="ctx-row flex items-center justify-between gap-2 text-xs" data-id="${esc(b.id)}">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="dot-md" style="background:${esc(b.color)};"></span>
          <span class="font-medium text-fg truncate">${esc(loc.key)}</span>
          <span class="hide-narrow text-muted truncate">${esc(loc.note)}</span>
        </div>
        <div class="flex items-center gap-3.5 shrink-0 mono-num">
          <span class="text-muted">${fmtK(b.tokens)}</span>
          <span style="width: 48px;" class="text-right font-semibold">${bp}%</span>
        </div>
      </div>`;
        })
        .join('') +
      `
    <div class="flex items-center justify-between gap-2 text-xs pt-2 mt-1 border-t">
      <div class="flex items-center gap-2.5">
        <span class="dot-md" style="border: 1px solid var(--border); background: var(--background);"></span>
        <span class="text-muted">${esc(tr('monitor.ctx.freeSpace'))}</span>
      </div>
      <div class="flex items-center gap-3.5 mono-num text-muted">
        <span>${fmtK(free)}</span>
        <span style="width: 48px;" class="text-right">${Math.max(0, 100 - pct).toFixed(1)}%</span>
      </div>
    </div>`;
  }

  const deferred = ctx.deferred || [];
  const deferredSig = `${lang}|${deferred.map((d) => `${d.key}:${d.count}:${d.tokens}`).join('\u001f')}`;
  if (deferredSig !== lastContextDeferredSig) {
    lastContextDeferredSig = deferredSig;
    document.getElementById('ctxDeferredList').innerHTML = deferred
      .map((d) => {
        const ld = localizeDeferredItem(d, lang);
        return `
    <div class="flex items-center justify-between text-xs text-muted py-0.5">
      <span>${esc(ld.key)} <span class="mono-num">(${esc(ld.count)})</span></span>
      <span class="mono-num">${fmtK(d.tokens)} / ${esc(ld.status)}</span>
    </div>`;
      })
      .join('');
  }

  const inventories = ctx.inventories || [];
  const invSig = `${lang}|${state.openAccIdx}|${inventories.map((inv) => `${inv.id || inv.title}:${inv.count}:${(inv.items || []).map((it) => `${it.name}:${it.meta}:${it.size}`).join(',')}`).join('\u001f')}`;
  if (invSig !== lastContextInventorySig) {
    lastContextInventorySig = invSig;
    document.getElementById('inventoryList').innerHTML = inventories
      .map((rawInv, idx) => {
        const inv = localizeInventoryGroup(rawInv, lang);
        const open = idx === state.openAccIdx;
        const itemsHtml = inv.items?.length
          ? inv.items
              .map(
                (it, itemIdx) => `
          <button type="button" class="inv-item-btn text-xs" data-inv-group="${idx}" data-inv-item="${itemIdx}">
            <span class="min-w-0 flex-1">
              <span class="block mono-num font-medium truncate">${esc(it.name)}</span>
              <span class="block text-muted truncate">${esc(it.meta)}</span>
            </span>
            <span class="flex items-center gap-1.5 shrink-0">
              <span class="mono-num text-muted font-medium">${esc(it.size)}</span>
              <span class="inv-item-chevron" aria-hidden="true">›</span>
            </span>
          </button>`
              )
              .join('')
          : `<div class="text-xs text-muted py-1">${esc(tr('monitor.ctx.emptyItems'))}</div>`;
        return `
      <div>
        <button type="button" class="acc-trigger" data-acc-idx="${idx}" data-open="${open}">
          <span class="acc-title-wrap">
            <svg class="acc-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M6 3.5L10.5 8L6 12.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="acc-title" title="${esc(inv.title)}">${esc(inv.title)}</span>
          </span>
          <span class="acc-count mono-num text-muted">${esc(inv.count)}</span>
        </button>
        <div class="acc-body inv-acc-body" data-open="${open}">
          <div class="acc-inner">
            <div class="px-5 pb-3 space-y-1.5">${itemsHtml}</div>
          </div>
        </div>
      </div>`;
      })
      .join('');
  }
}

function highlightCtx(id) {
  const ctx = state.contextData;
  const item = id && ctx ? (ctx.breakdown || []).find((b) => b.id === id) : null;
  const hint = document.getElementById('ctxHoverHint');
  if (item && ctx.limitTokens > 0) {
    const bp = ((item.tokens / ctx.limitTokens) * 100).toFixed(1);
    const loc = localizeBreakdownItem(item, getUiLang());
    hint.textContent = tr('monitor.ctx.hoverHint', { key: loc.key, tokens: fmtK(item.tokens), pct: bp });
    hint.dataset.show = 'true';
  } else {
    hint.dataset.show = 'false';
  }
  document.querySelectorAll('.ctx-seg').forEach((el) => {
    el.classList.toggle('ctx-dimmed', Boolean(id) && el.dataset.id !== id);
  });
  document.querySelectorAll('.ctx-row').forEach((el) => {
    el.dataset.hl = Boolean(id) && el.dataset.id === id;
    el.classList.toggle('ctx-dimmed', Boolean(id) && el.dataset.id !== id);
  });
}

function renderCalls() {
  const data = state.callsData;
  const list = data?.calls || [];
  const byAgent = data?.summary?.byAgent || [];
  const byModel = data?.summary?.byModel || [];
  const callsSig = `${getUiLang()}|${state.expandedCallId || ''}|${state.freshCallId || ''}|${data?.totalCallsCount ?? 0}|${list.map((c) => `${c.callUid}:${c.effectiveTps}:${c.cacheHitRate}:${c.estimatedCostUsd}:${c.durationMs}:${c.cacheDrop ? 1 : 0}`).join(',')}|${byAgent.map((a) => `${a.agentTag}:${a.steps}:${a.cost}`).join(',')}|${byModel.map((m) => `${m.model}:${m.steps}:${m.cost}`).join(',')}`;
  if (callsSig === lastCallsRenderSig) return;
  lastCallsRenderSig = callsSig;
  const tbody = document.getElementById('callsTbody');

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-xs text-muted">${esc(tr('monitor.calls.empty'))}</td></tr>`;
  } else {
    tbody.innerHTML = list
      .map((c) => {
        const isExp = state.expandedCallId === c.callUid;
        const badgeStyle =
          c.agentType === 'main'
            ? 'background: color-mix(in srgb, var(--chart-1) 12%, transparent); color: var(--chart-1);'
            : 'background: color-mix(in srgb, var(--chart-4) 14%, transparent); color: var(--chart-4);';
        const cacheCls = c.cacheDrop
          ? 'text-error font-semibold'
          : c.cacheHitRate >= 85
            ? 'text-success font-medium'
            : 'text-warning font-medium';
        const durText = c.ttftMs != null ? `${(c.ttftMs / 1000).toFixed(2)}s TTFT` : `${(c.durationMs / 1000).toFixed(1)}s`;
        const totalOut = Math.max(1, c.thinkingTokensEst + c.contentTokensEst);
        const thinkRatio = Math.round((c.thinkingTokensEst / totalOut) * 100);

        const shortModel = formatShortModel(c.model);
        const sourceText = String(c.sourceLabel || `${c.agentTag} / ${String(c.conversationId || '').slice(0, 8)}`).replace(/\s*\u00B7\s*/g, ' / ');

        return `
        <tr class="call-row ${c.callUid === state.freshCallId ? 'row-fresh' : ''}" data-call-id="${esc(c.callUid)}" data-expanded="${isExp}">
          <td class="cell-step whitespace-nowrap mono-num">
            <span class="agent-badge" style="${badgeStyle}">${esc(c.agentTag)}</span>
            <span>#${c.stepIndex}</span>
            <span class="cell-inline-model" title="${esc(c.model)}">${esc(shortModel)}</span>
          </td>
          <td class="cell-model col-model-cell mono-num text-muted" title="${esc(c.model)}">${esc(shortModel)}</td>
          <td class="cell-tps text-right whitespace-nowrap mono-num font-semibold ${c.effectiveTps < 15 ? 'text-warning' : ''}">
            <span>${c.effectiveTps.toFixed(1)} tok/s</span>
            <span class="cell-inline-cost">$${c.estimatedCostUsd.toFixed(3)}</span>
          </td>
          <td class="cell-dur text-right whitespace-nowrap mono-num text-muted">${durText}</td>
          <td class="cell-tok text-right whitespace-nowrap mono-num">
            <span class="cell-inline-dur">${durText} /</span>
            <span>${fmtK(c.contextTokens)}</span>
            <span class="text-muted"> / ${fmtK(c.thinkingTokensEst)} / ${fmtK(c.contentTokensEst)}</span>
          </td>
          <td class="cell-cache text-right whitespace-nowrap mono-num ${cacheCls}">
            <span class="cache-cell-wrap">
              <span>${c.cacheHitRate.toFixed(1)}%</span>
              ${c.cacheDrop ? `<span class="cache-drop-pill">${esc(tr('monitor.calls.cacheDropPill'))}</span>` : ''}
            </span>
          </td>
          <td class="cell-cost text-right whitespace-nowrap mono-num font-medium">$${c.estimatedCostUsd.toFixed(3)}</td>
        </tr>
        ${
          isExp
            ? `
        <tr class="call-anatomy-row">
          <td colspan="7" class="px-4 py-3.5">
            <div class="space-y-2.5 text-xs panel-enter">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mono-num">
                  <span class="font-semibold text-fg">${esc(tr('monitor.calls.anatomyTitle', { tag: c.agentTag, step: c.stepIndex }))}</span>
                  <span class="text-muted">${esc(tr('monitor.calls.anatomyModel'))}<span class="text-fg font-medium">${esc(c.model)}</span></span>
                  <span class="text-muted">${esc(tr('monitor.calls.anatomyTiming', { source: c.timingSource }))}</span>
                </div>
                <span class="mono-num text-muted">${esc(tr('monitor.calls.anatomyThinkRatio', { ratio: thinkRatio }))}</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span class="text-muted">${esc(tr('monitor.calls.anatomySource'))}<span class="text-fg font-medium">${esc(sourceText)}</span></span>
                <span class="mono-num text-muted">${esc(tr('monitor.calls.anatomyBreakdown', { cache: fmtK(c.cacheReadTokens), input: fmtK(c.inputTokens), output: fmtK(c.outputTokens) }))}</span>
              </div>
              <div class="flex rounded-full overflow-hidden w-full" style="height: 8px; background: var(--card); border: 1px solid var(--border); box-sizing: border-box;">
                <div style="width:${Math.min(100, c.cacheHitRate)}%; background: var(--success);"></div>
                <div style="width:${Math.max(0, 100 - c.cacheHitRate)}%; background: var(--chart-2);"></div>
              </div>
              ${
                c.cacheDrop
                  ? `
              <div class="p-3 rounded-xl flex items-start gap-2.5" style="border: 1px solid var(--error); background: color-mix(in srgb, var(--error) 6%, var(--card));">
                <span class="dot-sm mt-1.5" style="background: var(--error);"></span>
                <div class="space-y-0.5">
                  <div class="font-semibold text-error">${esc(tr('monitor.calls.anatomyDropReason'))}<span class="mono-num">${esc(c.dropReason)}</span></div>
                  <div class="text-muted leading-relaxed">${esc(c.dropDetail)}</div>
                </div>
              </div>`
                  : ''
              }
            </div>
          </td>
        </tr>`
            : ''
        }`;
      })
      .join('');
  }

  const totalCost = list.reduce((s, c) => s + c.estimatedCostUsd, 0);
  const totalOutTokens = list.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const totalDurMs = list.reduce((s, c) => s + (c.durationMs || 0), 0);
  const avgTps =
    totalDurMs > 0 && totalOutTokens > 0
      ? totalOutTokens / (totalDurMs / 1000)
      : list.length
        ? list.reduce((s, c) => s + c.effectiveTps, 0) / list.length
        : 0;
  const heroSteps = document.getElementById('callsHeroSteps');
  const heroTps = document.getElementById('callsHeroTps');
  const heroCost = document.getElementById('callsHeroCost');
  const heroModel = document.getElementById('callsHeroModel');
  const totalAll = data?.totalCallsCount ?? list.length;
  if (heroSteps) {
    heroSteps.textContent = list.length !== totalAll
      ? tr('monitor.calls.heroStepsFiltered', { count: list.length, total: totalAll })
      : tr('monitor.calls.heroStepsVal', { count: list.length });
  }
  if (heroTps) {
    heroTps.textContent = `${avgTps.toFixed(1)} tok/s`;
    heroTps.classList.toggle('text-warning', list.length > 0 && avgTps < 15);
    heroTps.classList.toggle('text-primary', !(list.length > 0 && avgTps < 15));
  }
  if (heroCost) {
    heroCost.textContent = `$${totalCost.toFixed(3)}`;
  }
  if (heroModel) {
    const latestModel = list[0]?.model || data?.summary?.latestModel || '';
    heroModel.textContent = latestModel ? tr('monitor.calls.heroModel', { model: latestModel }) : '';
    heroModel.title = latestModel;
    heroModel.classList.toggle('hidden', !latestModel);
  }
  document.getElementById('callsFooterStats').textContent = tr('monitor.calls.footerStats', {
    count: list.length,
    tps: avgTps.toFixed(1),
    cost: totalCost.toFixed(3),
  });

  document.getElementById('summaryAgentList').innerHTML = byAgent.length
    ? byAgent
        .map(
          (a) => `
      <div class="px-5 py-3 flex items-center justify-between text-xs">
        <div><span class="font-semibold">${esc(a.agentTag)} Agent</span><span class="ml-2 text-muted mono-num">${esc(tr('monitor.calls.stepsUnit', { count: a.steps }))}</span></div>
        <div class="mono-num flex items-center gap-4">
          <span>${a.avgTps.toFixed(1)} tok/s</span>
          <span class="text-success">${a.avgCache.toFixed(1)}%</span>
          <span class="font-semibold">$${a.cost.toFixed(3)}</span>
        </div>
      </div>`
        )
        .join('')
    : `<div class="px-5 py-4 text-xs text-muted">${esc(tr('monitor.calls.summaryEmpty'))}</div>`;

  document.getElementById('summaryModelList').innerHTML = byModel.length
    ? byModel
        .map(
          (m) => `
      <div class="px-5 py-3 flex items-center justify-between text-xs">
        <span class="mono-num truncate pr-2">${esc(m.model)} <span class="text-muted">(${m.steps})</span></span>
        <div class="mono-num flex items-center gap-4 shrink-0">
          <span>${m.avgTps.toFixed(1)} tok/s</span>
          <span class="font-semibold">$${m.cost.toFixed(3)}</span>
        </div>
      </div>`
        )
        .join('')
    : `<div class="px-5 py-4 text-xs text-muted">${esc(tr('monitor.calls.summaryEmpty'))}</div>`;
}

function ringSvg(pct, ringId) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const offset = c * (1 - clamped / 100);
  const col = clamped <= 20 ? 'var(--error)' : clamped <= 45 ? 'var(--warning)' : 'var(--success)';
  return `
    <svg width="42" height="42" viewBox="0 0 42 42" class="ring-svg">
      <circle cx="21" cy="21" r="${r}" fill="none" stroke-width="4" class="ring-track"/>
      <circle data-ring-id="${esc(ringId)}" cx="21" cy="21" r="${r}" fill="none" stroke-width="4" stroke="${col}" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" class="ring-arc"/>
    </svg>`;
}

function renderQuota() {
  const q = state.quotaData;
  if (!q) return;
  const groups = q.groups || [];
  const container = document.getElementById('quotaGroupsList');

  // In-place SVG dashoffset patching so ring arcs animate smoothly without DOM teardown
  if (container.dataset.mounted !== String(groups.length)) {
    container.dataset.mounted = String(groups.length);
    container.innerHTML = groups
      .map(
        (g) => `
      <div class="space-y-2">
        <div class="flex items-center justify-between px-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-semibold">${esc(g.name)}</span>
            <span class="text-xs text-muted">${esc(g.desc)}</span>
          </div>
          <button type="button" class="agy-link-btn" data-cal-group="${esc(g.id)}">校准基线</button>
        </div>
        <div class="agy-group divide-y overflow-hidden">
          <div class="px-5 py-3.5 flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="text-sm font-medium">每周剩余额度</div>
              <div id="q-w-sub-${esc(g.id)}" class="text-xs text-muted mt-0.5">${fmtHrs(g.weeklyHrs)} / 本地 7d 实测 ${esc(g.localTokens7d)}</div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <span id="q-w-pct-${esc(g.id)}" class="mono-num text-sm font-semibold">${g.weeklyPct}%</span>
              ${ringSvg(g.weeklyPct, `w-${g.id}`)}
            </div>
          </div>
          ${
            g.h5Pct !== null
              ? `
          <div class="px-5 py-3.5 flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="text-sm font-medium">5 小时剩余额度</div>
              <div id="q-h-sub-${esc(g.id)}" class="text-xs text-muted mt-0.5">当前 5h 窗口本地实测 ${g.localCalls5h} 次调用 / ${Math.floor(g.h5Mins / 60)}h ${g.h5Mins % 60}m 窗口</div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <span id="q-h-pct-${esc(g.id)}" class="mono-num text-sm font-semibold">${g.h5Pct}%</span>
              ${ringSvg(g.h5Pct, `h-${g.id}`)}
            </div>
          </div>`
              : ''
          }
        </div>
      </div>`
      )
      .join('');
  } else {
    const r = 17;
    const c = 2 * Math.PI * r;
    const patchRing = (ringId, pct) => {
      const arc = container.querySelector(`[data-ring-id="${ringId}"]`);
      if (!arc) return;
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      arc.style.strokeDashoffset = (c * (1 - clamped / 100)).toFixed(2);
      arc.setAttribute('stroke', clamped <= 20 ? 'var(--error)' : clamped <= 45 ? 'var(--warning)' : 'var(--success)');
    };
    groups.forEach((g) => {
      const wp = document.getElementById(`q-w-pct-${g.id}`);
      const ws = document.getElementById(`q-w-sub-${g.id}`);
      if (wp) wp.textContent = `${g.weeklyPct}%`;
      if (ws) ws.textContent = `${fmtHrs(g.weeklyHrs)} / 本地 7d 实测 ${g.localTokens7d}`;
      patchRing(`w-${g.id}`, g.weeklyPct);
      if (g.h5Pct !== null) {
        const hp = document.getElementById(`q-h-pct-${g.id}`);
        const hs = document.getElementById(`q-h-sub-${g.id}`);
        if (hp) hp.textContent = `${g.h5Pct}%`;
        if (hs) hs.textContent = `当前 5h 窗口本地实测 ${g.localCalls5h} 次调用 / ${Math.floor(g.h5Mins / 60)}h ${g.h5Mins % 60}m 窗口`;
        patchRing(`h-${g.id}`, g.h5Pct);
      }
    });
  }

  const sav = q.savings7d || { savedUsd: 0, avgCacheHitPct: 0 };
  document.getElementById('quotaSavingsLabel').textContent = `缓存累计节省约 $${sav.savedUsd.toFixed(2)} / 命中均值 ${sav.avgCacheHitPct.toFixed(1)}%`;

  const chart = q.weeklyChart || [];
  document.getElementById('weeklyChart').innerHTML = chart
    .map((w) => {
      const cachePct = w.total > 0 ? Math.round((w.cached / w.total) * 100) : 0;
      const freshPct = Math.max(0, 100 - cachePct);
      return `
      <div class="chart-col" title="${esc(w.day)} / ${w.calls} 次调用 / ${fmtK(w.totalTokens)} tokens">
        <div class="chart-bar" style="height:${w.total}%;">
          <div style="height:${freshPct}%; background: var(--chart-2);"></div>
          <div style="height:${cachePct}%; background: var(--chart-1);"></div>
        </div>
        <span class="text-xs text-muted">${esc(w.day)}</span>
      </div>`;
    })
    .join('');
}

function renderVault() {
  const v = state.vaultData;
  if (!v) return;
  const items = v.items || [];
  const vaultSig = `${getUiLang()}|${v.storagePath || ''}|${v.commitsAhead || 0}|${v.staleCount || 0}|${items.map((it) => `${it.id}:${it.updatedAt}:${it.kind}:${it.title}:${it.summary}`).join('\u001f')}`;
  if (vaultSig === lastVaultRenderSig) return;
  lastVaultRenderSig = vaultSig;
  document.getElementById('vaultPathLabel').textContent = v.storagePath || '%USERPROFILE%\\.context-cache';
  const staleBadge = document.getElementById('vaultStaleBadge');
  if (v.commitsAhead > 0) {
    staleBadge.textContent = tr('monitor.vault.commitsAhead', { count: v.commitsAhead });
    staleBadge.classList.remove('hidden');
  } else if (v.staleCount > 0) {
    staleBadge.textContent = tr('monitor.vault.staleHead', { count: v.staleCount });
    staleBadge.classList.remove('hidden');
  } else {
    staleBadge.classList.add('hidden');
  }

  const el = document.getElementById('vaultList');
  if (!items.length) {
    el.innerHTML = `<div class="py-8 text-center text-xs text-muted">${esc(tr('monitor.vault.empty'))}</div>`;
    return;
  }

  el.innerHTML = items
    .map(
      (it) => `
    <div class="px-5 py-3.5 flex items-start justify-between gap-4">
      <div class="space-y-1 min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="agy-pill mono-num">${esc(it.kind)}</span>
          <span class="text-sm font-medium text-fg">${esc(it.title)}</span>
        </div>
        <p class="text-xs text-muted m-0 leading-relaxed">${esc(it.summary)}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted mono-num pt-0.5">
          <span>${esc(it.branch)}@${esc(it.head)}</span>
          <span>/</span>
          <span>${esc(fmtRelativeTime(it.updatedAt))}</span>
          ${(it.tags || []).map((t) => `<span>#${esc(t)}</span>`).join('')}
        </div>
      </div>
      <button type="button" data-archive-mem="${esc(it.id)}" class="agy-btn agy-btn-secondary agy-btn-sm text-xs shrink-0">${esc(tr('monitor.vault.archive'))}</button>
    </div>`
    )
    .join('');
}

function resetSessionViewState() {
  state.expandedCallId = null;
  state.knownCallIds.clear();
  state.freshCallId = null;
  state.modelFilter = 'all';
  state.callsData = null;
  state.vaultData = null;
  lastCallsRenderSig = '';
  lastVaultRenderSig = '';
  lastTitleBarSig = '';
}

function isPopoutOpen(status) {
  return Boolean(status && (status.windowOpen || status.running));
}

function isPopoutClosed(status) {
  return Boolean(status && !status.windowOpen && !status.running);
}

function applyFeatureFlags() {
  const quotaTabBtn = document.querySelector('#mainSegNav [data-tab="quota"]');
  const quotaPanel = document.getElementById('panel-quota');
  if (!FEATURE_FLAGS.showQuotaUi) {
    if (quotaTabBtn) {
      quotaTabBtn.classList.add('hidden');
      quotaTabBtn.setAttribute('aria-hidden', 'true');
    }
    if (quotaPanel) quotaPanel.classList.add('hidden');
    if (state.activeTab === 'quota') state.activeTab = 'context';
  } else {
    if (quotaTabBtn) {
      quotaTabBtn.classList.remove('hidden');
      quotaTabBtn.removeAttribute('aria-hidden');
    }
  }
}

function renderLauncherView() {
  const running = isPopoutOpen(state.popoutStatus);
  const port = state.popoutStatus?.port;
  const dot = document.getElementById('launcherStatusDot');
  const title = document.getElementById('launcherTitle');
  const sub = document.getElementById('launcherSubMeta');
  const badge = document.getElementById('launcherPortBadge');
  const sessEl = document.getElementById('launcherSessionLabel');

  if (dot) dot.classList.toggle('hidden', !running);
  if (title) title.textContent = running ? tr('launcher.titleRunning') : tr('launcher.titleStopped');
  if (sub) {
    sub.textContent = running && port
      ? tr('launcher.subRunning', { port })
      : tr('launcher.subStopped');
  }
  if (badge) {
    badge.textContent = running ? tr('launcher.statusRunning') : tr('launcher.statusStopped');
    badge.style.color = running ? 'var(--success)' : 'var(--muted-foreground)';
    badge.style.borderColor = running ? 'var(--success)' : 'var(--border)';
  }
  if (sessEl) {
    const sessions = state.contextData?.sessions || [];
    const cur = sessions.find((s) => s.id === state.activeConversationId) || sessions[0];
    sessEl.textContent = cur ? cur.label : tr('launcher.autoFollowLatest');
  }
}

function stopLauncherTimer() {
  if (launcherTimer) {
    clearInterval(launcherTimer);
    launcherTimer = null;
  }
}

async function checkLauncherPopoutStatus() {
  if (!state.launcherMode || launcherCheckInFlight) return;
  launcherCheckInFlight = true;
  try {
    const res = await callAppTool('app_config_manage', { action: 'get' });
    if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
    if (res?.config) state.config = res.config;
    if (!state.launcherMode) return;
    if (isPopoutClosed(state.popoutStatus)) {
      if (state.popoutStatus?.userClosed) {
        state.userClosedPopoutSession = true;
      }
      exitGlobalLauncherMode();
      return;
    }
    renderLauncherView();
  } catch {
    // ignore transient status poll errors
  } finally {
    launcherCheckInFlight = false;
  }
}

function startLauncherTimer() {
  stopLauncherTimer();
  if (!state.launcherMode || document.visibilityState !== 'visible') return;
  launcherTimer = setInterval(() => {
    if (!state.launcherMode || document.visibilityState !== 'visible') return;
    void checkLauncherPopoutStatus();
  }, 6000);
}

function cleanupLauncherListeners() {
  if (launcherVisibilityHandler) {
    document.removeEventListener('visibilitychange', launcherVisibilityHandler);
    launcherVisibilityHandler = null;
  }
  if (launcherFocusHandler) {
    window.removeEventListener('focus', launcherFocusHandler);
    launcherFocusHandler = null;
  }
}

function enterGlobalLauncherMode(popoutStatus) {
  if (popoutStatus) state.popoutStatus = popoutStatus;
  if (isPopoutClosed(state.popoutStatus)) {
    exitGlobalLauncherMode();
    return;
  }
  state.launcherMode = true;
  document.getElementById('appShell')?.classList.add('hidden');
  document.getElementById('globalLauncherView')?.classList.remove('hidden');
  renderLauncherView();
  // Stop high-frequency polling & KV countdown in hidden background shell while popout window handles monitoring
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopKvCountdownTimer();
  cleanupLauncherListeners();

  launcherVisibilityHandler = () => {
    if (!state.launcherMode) return;
    if (document.visibilityState === 'visible') {
      void checkLauncherPopoutStatus();
      startLauncherTimer();
    } else {
      stopLauncherTimer();
    }
  };
  launcherFocusHandler = () => {
    if (!state.launcherMode) return;
    void checkLauncherPopoutStatus();
  };
  document.addEventListener('visibilitychange', launcherVisibilityHandler);
  window.addEventListener('focus', launcherFocusHandler);

  startLauncherTimer();
}

function exitGlobalLauncherMode() {
  state.launcherMode = false;
  stopLauncherTimer();
  cleanupLauncherListeners();
  document.getElementById('globalLauncherView')?.classList.add('hidden');
  document.getElementById('appShell')?.classList.remove('hidden');
  void refreshAll(false, false, true);
  restartPollTimer();
  startKvCountdownTimer();
  scheduleIdleModuleChecks();
  requestAnimationFrame(positionVisibleIndicators);
}

function startPopoutClientLifecycle() {
  if (!popoutToken || !popoutClientId) return;

  const sendHeartbeat = async (force = false) => {
    const now = Date.now();
    // When hidden (e.g. minimized), throttle heartbeat to ~10s (server TTL is 18s)
    if (!force && document.visibilityState !== 'visible' && now - lastHeartbeatAt < 10000) {
      return;
    }
    lastHeartbeatAt = now;
    try {
      const resp = await fetch(`/api/popout/heartbeat?token=${encodeURIComponent(popoutToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cc-token': popoutToken },
        body: JSON.stringify({ clientId: popoutClientId }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (
        state.followMode === 'auto' &&
        data?.activeConversationId &&
        state.activeConversationId &&
        data.activeConversationId !== state.activeConversationId
      ) {
        void refreshAll(true, false, true);
      }
    } catch {
      // ignore transient heartbeat failure
    }
  };

  void sendHeartbeat(true);
  heartbeatTimer = setInterval(() => void sendHeartbeat(false), 5000);

  let closingSent = false;
  const sendClosing = () => {
    if (closingSent) return;
    closingSent = true;
    const url = `/api/popout/closing?token=${encodeURIComponent(popoutToken)}&clientId=${encodeURIComponent(popoutClientId)}`;
    const payload = JSON.stringify({ clientId: popoutClientId });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
    }
  };
  window.addEventListener('pagehide', sendClosing);
  window.addEventListener('beforeunload', sendClosing);

  // Persist user-resized/moved floating window geometry (debounced; skip when collapsed to 38px mini-bar)
  let saveBoundsDebounce = null;
  const scheduleBoundsSave = () => {
    if (state.windowCollapsed || (typeof window.innerHeight === 'number' && window.innerHeight < 120)) return;
    const w = Math.max(360, Math.min(1600, Math.round(isNativePopout ? window.innerWidth : window.outerWidth || window.innerWidth || 460)));
    const h = Math.max(460, Math.min(1200, Math.round(isNativePopout ? window.innerHeight : window.outerHeight || window.innerHeight || 720)));
    const dpr = window.devicePixelRatio || 1;
    const x = Number.isFinite(window.screenX) && window.screenX >= 10 ? Math.round(window.screenX * dpr) : null;
    const y = Number.isFinite(window.screenY) && window.screenY >= 10 ? Math.round(window.screenY * dpr) : null;
    const key = `${w}x${h}@${x},${y}`;
    if (key === lastSavedBoundsKey) return;
    clearTimeout(saveBoundsDebounce);
    saveBoundsDebounce = setTimeout(() => {
      lastSavedBoundsKey = key;
      const patch = { popout: { size: `${w}x${h}` } };
      if (x !== null && y !== null) patch.popout.position = { x, y };
      void callAppTool('app_config_manage', { action: 'update', patch }).catch(() => {});
    }, 1000);
  };

  window.addEventListener('resize', scheduleBoundsSave);
  const startBoundsTimer = () => {
    if (boundsTimer) clearInterval(boundsTimer);
    if (document.visibilityState !== 'visible') {
      boundsTimer = null;
      return;
    }
    boundsTimer = setInterval(() => {
      if (document.visibilityState === 'visible') scheduleBoundsSave();
    }, 5000);
  };
  startBoundsTimer();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void sendHeartbeat(true);
      startBoundsTimer();
    } else if (boundsTimer) {
      clearInterval(boundsTimer);
      boundsTimer = null;
    }
  });
}

function renderNativePinButton() {
  const btn = document.getElementById('winPinBtn');
  const lbl = document.getElementById('winPinLabel');
  if (!btn) return;
  const pinned = Boolean(state.windowPinned);
  btn.dataset.pinned = String(pinned);
  btn.title = pinned ? tr('titlebar.pinnedTitle') : tr('titlebar.unpinnedTitle');
  if (lbl) lbl.textContent = pinned ? tr('titlebar.pinned') : tr('titlebar.pin');
}

function setupNativeFramelessChrome() {
  if (!isNativePopout) return;
  document.body.classList.add('native-popout');
  document.getElementById('appShell')?.classList.add('scroll-thin');
  document.getElementById('nativeTitleBar')?.classList.remove('hidden');
  document.getElementById('nativeResizeHandles')?.classList.remove('hidden');
  renderNativePinButton();

  let miniWidthSaveDebounce = null;
  let lastSavedMiniWidth = null;
  const getTargetCollapsedLogicalWidth = () => {
    const preset = state.config?.popout?.miniBarPreset || 'standard';
    if (preset === 'custom' && Number(state.config?.popout?.miniBarCustomWidth) >= 220) {
      return Number(state.config.popout.miniBarCustomWidth);
    }
    return MINI_BAR_PRESET_WIDTHS[preset] || MINI_BAR_PRESET_WIDTHS.standard;
  };

  const toggleNativeCollapse = () => {
    state.windowCollapsed = !state.windowCollapsed;
    document.body.classList.toggle('window-collapsed', state.windowCollapsed);
    const dpr = window.devicePixelRatio || 1;
    const collapsePx = Math.ceil(40 * dpr);
    const targetW = Math.ceil(getTargetCollapsedLogicalWidth() * dpr);
    postHostWindowMsg(state.windowCollapsed ? `collapse:1:${collapsePx}:${targetW}` : 'collapse:0');
    document.getElementById('titleBarMiniModules')?.classList.toggle('hidden', !state.windowCollapsed);
    const minSvg = document.getElementById('winMinSvg');
    if (minSvg) {
      minSvg.innerHTML = state.windowCollapsed
        ? `<path d="M4.2 6.2L8 10l3.8-3.8"/>`
        : `<path d="M4.2 9.8L8 6l3.8 3.8"/>`;
    }
    requestAnimationFrame(fitNativeTitleBar);
  };

  const titleBar = document.getElementById('nativeTitleBar');
  if (titleBar) {
    const onTitleBarResize = () => {
      fitNativeTitleBar();
      if (!state.windowCollapsed) return;
      const w = Math.max(220, Math.min(1200, Math.round(window.innerWidth || 0)));
      const expectedPresetW = getTargetCollapsedLogicalWidth();
      if (Math.abs(w - expectedPresetW) <= 6 || w === lastSavedMiniWidth) return;
      clearTimeout(miniWidthSaveDebounce);
      miniWidthSaveDebounce = setTimeout(() => {
        if (!state.windowCollapsed) return;
        const curW = Math.max(220, Math.min(1200, Math.round(window.innerWidth || 0)));
        lastSavedMiniWidth = curW;
        void persistConfigPatch({ popout: { miniBarPreset: 'custom', miniBarCustomWidth: curW } }).catch(() => {});
      }, 650);
    };
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(onTitleBarResize);
      ro.observe(titleBar);
    } else {
      window.addEventListener('resize', onTitleBarResize);
    }
    titleBar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.detail >= 2) return;
      if (e.target.closest('button')) return;
      e.preventDefault();
      postHostWindowMsg('drag');
    });
    titleBar.addEventListener('dblclick', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();
      if (state.windowCollapsed) {
        toggleNativeCollapse();
      } else {
        postHostWindowMsg('max');
      }
    });
  }

  // Also allow dragging by grabbing any empty background area of module headers
  document.querySelectorAll('.agy-header').forEach((headerEl) => {
    headerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.detail >= 2) return;
      if (e.target.closest('button, input, textarea, a, .agy-select-wrap, .seg-nav, .acc-body')) return;
      e.preventDefault();
      postHostWindowMsg('drag');
    });
  });

  document.querySelectorAll('#nativeResizeHandles .win-resize').forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const ht = handle.dataset.ht;
      if (ht) postHostWindowMsg(`resize:${ht}`);
    });
  });

  document.getElementById('winPinBtn')?.addEventListener('click', () => {
    state.windowPinned = !state.windowPinned;
    postHostWindowMsg(state.windowPinned ? 'pin:1' : 'pin:0');
    renderNativePinButton();
    void persistConfigPatch({ popout: { alwaysOnTop: state.windowPinned } }).catch(() => {});
    showToast(state.windowPinned ? '已固定置顶在页面最上方' : '已取消窗口置顶');
  });

  document.getElementById('winMinBtn')?.addEventListener('click', toggleNativeCollapse);
  document.getElementById('winMinimizeBtn')?.addEventListener('click', () => {
    postHostWindowMsg('minimize');
  });
  document.getElementById('winMaxBtn')?.addEventListener('click', () => {
    if (state.windowCollapsed) {
      toggleNativeCollapse();
    } else {
      postHostWindowMsg('max');
    }
  });
  document.getElementById('winCloseBtn')?.addEventListener('click', () => {
    if (popoutToken && popoutClientId) {
      const url = `/api/popout/closing?token=${encodeURIComponent(popoutToken)}&clientId=${encodeURIComponent(popoutClientId)}`;
      const payload = JSON.stringify({ clientId: popoutClientId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      }
    }
    postHostWindowMsg('close');
    window.close();
  });
}

let miniBarSelectedMod = null;

function getMiniBarModuleMeta(mod) {
  const map = {
    context: { label: tr('settings.miniBar.modContext'), sample: '5.3%' },
    cache: { label: tr('settings.miniBar.modCache'), sample: '96%' },
    kv: { label: tr('settings.miniBar.modKv'), sample: '12:40' },
    tps: { label: tr('settings.miniBar.modTps'), sample: '48.2' },
    model: { label: tr('settings.miniBar.modModel'), sample: 'Neon' },
  };
  return map[mod] || { label: mod, sample: '' };
}

function applyMiniBarOrderWithFlip(nextOrder, selectedMod = miniBarSelectedMod) {
  const track = document.getElementById('miniBarPreviewTrack');
  const firstRects = new Map();
  if (track) {
    track.querySelectorAll('.minibar-slot-chip').forEach((el) => {
      firstRects.set(el.dataset.mod, el.getBoundingClientRect());
    });
  }

  miniBarSelectedMod = selectedMod;
  if (!state.config.popout) state.config.popout = {};
  state.config.popout.miniBarModules = [...nextOrder];
  renderMiniBarStudio();

  if (track && firstRects.size > 0) {
    track.querySelectorAll('.minibar-slot-chip').forEach((el) => {
      const prev = firstRects.get(el.dataset.mod);
      if (!prev) return;
      const cur = el.getBoundingClientRect();
      const dx = prev.left - cur.left;
      const dy = prev.top - cur.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 220ms ease-out';
        el.style.transform = '';
      });
    });
  }

  if (state.contextData) {
    const pct = Number(state.contextData.usedPercent) || 0;
    const cache = Number(state.contextData.latestCacheHitRate) || 0;
    const tps = Number(state.contextData.avgTps) || 0;
    updateNativeTitleBarTelemetry(state.contextData, pct, cache, tps);
  }
  void persistConfigPatch({ popout: { miniBarModules: [...nextOrder] } }).catch(() => {});
}

function renderMiniBarStudio() {
  if (state.isDraggingMiniBar) return;
  const preset = state.config?.popout?.miniBarPreset || 'standard';
  const customW = state.config?.popout?.miniBarCustomWidth || null;
  const order = getMiniBarModules();
  const visibleCount = MINI_BAR_PRESET_COUNTS[preset] || 3;
  const studioSig = `${getUiLang()}|${preset}|${customW || ''}|${order.join(',')}|${miniBarSelectedMod || ''}`;
  if (studioSig === lastMiniBarSig) return;
  lastMiniBarSig = studioSig;

  document.querySelectorAll('#miniBarPresetRow .minibar-preset-btn').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.preset === preset);
  });

  const customBadge = document.getElementById('miniBarCustomBadge');
  if (customBadge) {
    if (preset === 'custom' && customW) {
      customBadge.textContent = tr('settings.miniBar.customBadge', { w: customW });
      customBadge.classList.remove('hidden');
    } else {
      customBadge.classList.add('hidden');
    }
  }

  const shell = document.getElementById('miniBarPreviewShell');
  if (shell) shell.dataset.preset = preset;

  const track = document.getElementById('miniBarPreviewTrack');
  if (!track) return;

  const pieces = [];
  order.forEach((mod, idx) => {
    if (idx === visibleCount && visibleCount < order.length) {
      pieces.push('<span class="minibar-divider" aria-hidden="true"></span>');
    }
    const meta = getMiniBarModuleMeta(mod);
    const isVisible = idx < visibleCount;
    const isSelected = miniBarSelectedMod === mod;
    const nudgeHtml = isSelected
      ? `<span class="minibar-slot-nudge">
          <button type="button" class="minibar-nudge-btn" data-nudge="left" data-mod="${esc(mod)}" ${idx === 0 ? 'disabled' : ''} aria-label="向左移动">←</button>
          <button type="button" class="minibar-nudge-btn" data-nudge="right" data-mod="${esc(mod)}" ${idx === order.length - 1 ? 'disabled' : ''} aria-label="向右移动">→</button>
        </span>`
      : '';
    pieces.push(
      `<div class="minibar-slot-chip" data-mod="${esc(mod)}" data-idx="${idx}" data-visible="${isVisible}" data-selected="${isSelected}" tabindex="0">
        <span class="minibar-slot-idx mono-num">${idx + 1}</span>
        <span>${esc(meta.label)}</span>
        ${nudgeHtml}
      </div>`
    );
  });
  track.innerHTML = pieces.join('');

  track.querySelectorAll('.minibar-nudge-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mod = btn.dataset.mod;
      const dir = btn.dataset.nudge === 'left' ? -1 : 1;
      const cur = getMiniBarModules();
      const from = cur.indexOf(mod);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= cur.length) return;
      [cur[from], cur[to]] = [cur[to], cur[from]];
      applyMiniBarOrderWithFlip(cur, mod);
    });
  });

  track.querySelectorAll('.minibar-slot-chip').forEach((chip) => {
    chip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const mod = chip.dataset.mod;
      const cur = getMiniBarModules();
      const from = cur.indexOf(mod);
      const to = from + (e.key === 'ArrowLeft' ? -1 : 1);
      if (from < 0 || to < 0 || to >= cur.length) return;
      [cur[from], cur[to]] = [cur[to], cur[from]];
      applyMiniBarOrderWithFlip(cur, mod);
    });

    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.minibar-nudge-btn')) return;
      e.preventDefault();
      const draggedMod = chip.dataset.mod;
      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let ghostEl = null;
      let offsetX = 0;
      let offsetY = 0;
      let curOrder = getMiniBarModules();
      let orderChanged = false;
      let lastSwapAt = 0;
      let lastPointerX = startX;
      let lastPointerY = startY;
      const visibleCount = MINI_BAR_PRESET_COUNTS[state.config?.popout?.miniBarPreset || 'standard'] || 3;

      const updateSlotBadgesAndDivider = () => {
        const oldDiv = track.querySelector('.minibar-divider');
        if (oldDiv) oldDiv.remove();
        const items = [...track.querySelectorAll('.minibar-slot-chip')];
        items.forEach((el, idx) => {
          el.dataset.idx = String(idx);
          const isVis = idx < visibleCount;
          el.dataset.visible = String(isVis);
          const idxBadge = el.querySelector('.minibar-slot-idx');
          if (idxBadge) idxBadge.textContent = String(idx + 1);
          if (idx === visibleCount && visibleCount < items.length) {
            const div = document.createElement('span');
            div.className = 'minibar-divider';
            div.setAttribute('aria-hidden', 'true');
            track.insertBefore(div, el);
          }
        });
      };

      const reorderLiveWithFlip = (nextOrder) => {
        const siblings = [...track.querySelectorAll('.minibar-slot-chip')];
        const firstRects = new Map();
        siblings.forEach((el) => firstRects.set(el.dataset.mod, el.getBoundingClientRect()));

        const byMod = new Map(siblings.map((el) => [el.dataset.mod, el]));
        const oldDiv = track.querySelector('.minibar-divider');
        if (oldDiv) oldDiv.remove();
        nextOrder.forEach((m) => {
          const el = byMod.get(m);
          if (el) track.appendChild(el);
        });
        updateSlotBadgesAndDivider();

        siblings.forEach((el) => {
          if (el === chip) return;
          const prev = firstRects.get(el.dataset.mod);
          if (!prev) return;
          const cur = el.getBoundingClientRect();
          const dx = prev.left - cur.left;
          const dy = prev.top - cur.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
            el.style.transform = '';
          });
        });
      };

      const onMove = (ev) => {
        if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        if (!isDragging) {
          isDragging = true;
          state.isDraggingMiniBar = true;
          const rect = chip.getBoundingClientRect();
          offsetX = startX - rect.left;
          offsetY = startY - rect.top;

          ghostEl = chip.cloneNode(true);
          ghostEl.querySelector('.minibar-slot-nudge')?.remove();
          ghostEl.classList.remove('is-placeholder');
          ghostEl.classList.add('minibar-drag-ghost');
          ghostEl.style.width = `${Math.ceil(rect.width)}px`;
          ghostEl.style.height = `${Math.ceil(rect.height)}px`;
          ghostEl.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.04)`;
          document.body.appendChild(ghostEl);

          chip.classList.add('is-placeholder');
          try {
            chip.setPointerCapture(e.pointerId);
          } catch {}
        }

        const gx = ev.clientX - offsetX;
        const gy = ev.clientY - offsetY;
        if (ghostEl) {
          ghostEl.style.transform = `translate3d(${gx}px, ${gy}px, 0) scale(1.04)`;
        }

        const now = performance.now();
        const moveDist = Math.hypot(ev.clientX - lastPointerX, ev.clientY - lastPointerY);
        // Cooldown prevents reading mid-FLIP animated rects and eliminates multi-row ping-pong jitter
        if (now - lastSwapAt < 190 || moveDist < 2) return;
        lastPointerX = ev.clientX;
        lastPointerY = ev.clientY;

        // 2D hit-test against resting card rectangles (works cleanly on both single-row and wrapped multi-row layouts)
        const chips = [...track.querySelectorAll('.minibar-slot-chip')];
        const fromIdx = curOrder.indexOf(draggedMod);
        if (fromIdx < 0) return;

        let targetIdx = -1;
        for (let i = 0; i < chips.length; i++) {
          const el = chips[i];
          if (el === chip) continue;
          const r = el.getBoundingClientRect();
          // Strict interior hit with 4px hysteresis padding
          if (
            ev.clientX >= r.left + 4 &&
            ev.clientX <= r.right - 4 &&
            ev.clientY >= r.top + 2 &&
            ev.clientY <= r.bottom - 2
          ) {
            targetIdx = i;
            break;
          }
        }

        if (targetIdx >= 0 && targetIdx !== fromIdx) {
          const next = [...curOrder];
          const [moved] = next.splice(fromIdx, 1);
          next.splice(targetIdx, 0, moved);
          curOrder = next;
          orderChanged = true;
          lastSwapAt = now;
          reorderLiveWithFlip(next);
          const ghostIdx = ghostEl?.querySelector('.minibar-slot-idx');
          if (ghostIdx) ghostIdx.textContent = String(targetIdx + 1);
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);

        if (isDragging) {
          const finalizeDrop = () => {
            state.isDraggingMiniBar = false;
            if (ghostEl) {
              ghostEl.remove();
              ghostEl = null;
            }
            chip.classList.remove('is-placeholder');
            if (orderChanged) {
              miniBarSelectedMod = draggedMod;
              if (!state.config.popout) state.config.popout = {};
              state.config.popout.miniBarModules = [...curOrder];
              lastMiniBarSig = '';
              renderMiniBarStudio();
              if (state.contextData) {
                const pct = Number(state.contextData.usedPercent) || 0;
                const cache = Number(state.contextData.latestCacheHitRate) || 0;
                const tps = Number(state.contextData.avgTps) || 0;
                lastTitleBarSig = '';
                updateNativeTitleBarTelemetry(state.contextData, pct, cache, tps);
              }
              void persistConfigPatch({ popout: { miniBarModules: [...curOrder] } }).catch(() => {});
            }
          };

          if (ghostEl) {
            const dest = chip.getBoundingClientRect();
            ghostEl.style.transition = 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms ease-out';
            ghostEl.style.transform = `translate3d(${dest.left}px, ${dest.top}px, 0) scale(1)`;
            ghostEl.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.08)';
            setTimeout(finalizeDrop, 165);
          } else {
            finalizeDrop();
          }
          return;
        }

        // Click interaction: select first module, click second to swap smoothly
        if (!miniBarSelectedMod) {
          miniBarSelectedMod = draggedMod;
          renderMiniBarStudio();
        } else if (miniBarSelectedMod === draggedMod) {
          miniBarSelectedMod = null;
          renderMiniBarStudio();
        } else {
          const cur = getMiniBarModules();
          const a = cur.indexOf(miniBarSelectedMod);
          const b = cur.indexOf(draggedMod);
          if (a >= 0 && b >= 0) {
            [cur[a], cur[b]] = [cur[b], cur[a]];
            applyMiniBarOrderWithFlip(cur, null);
          }
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  });
}

function renderSettings() {
  const cfg = state.config || {};
  const uiLang = getUiLang();
  const zhBtn = document.getElementById('uiLangZhBtn');
  const enBtn = document.getElementById('uiLangEnBtn');
  if (zhBtn) zhBtn.dataset.active = String(uiLang === 'zh-CN');
  if (enBtn) enBtn.dataset.active = String(uiLang === 'en');

  document.getElementById('auxAutoSwitch').dataset.on = String(Boolean(cfg.auxAutoOpen));
  const startupAutoEl = document.getElementById('startupAutoPopoutSwitch');
  if (startupAutoEl) {
    startupAutoEl.dataset.on = String(cfg.popout?.autoLaunchOnStartup !== false);
  }
  const sidebarAutoEl = document.getElementById('sidebarAutoPopoutSwitch');
  if (sidebarAutoEl) {
    sidebarAutoEl.dataset.on = String(cfg.popout?.autoLaunchFromSidebar !== false);
  }
  const kvSwitchEl = document.getElementById('kvCacheSwitch');
  const kvOn = cfg.kvCache?.enabled !== false;
  if (kvSwitchEl) kvSwitchEl.dataset.on = String(kvOn);
  const kvControlsEl = document.getElementById('kvCacheControls');
  if (kvControlsEl) kvControlsEl.style.opacity = kvOn ? '1' : '0.45';
  const kvTtl = Math.max(3, Math.min(60, Math.round(Number(cfg.kvCache?.ttlMinutes) || 15)));
  const kvInputEl = document.getElementById('cfgKvTtlInput');
  if (kvInputEl) kvInputEl.value = kvTtl;
  document.querySelectorAll('#kvPresetGroup .kv-preset-btn').forEach((btn) => {
    btn.dataset.active = String(Number(btn.dataset.kvMin) === kvTtl);
  });
  renderMiniBarStudio();
  const topMostEl = document.getElementById('popoutTopMostSwitch');
  if (topMostEl) {
    topMostEl.dataset.on = String(cfg.popout?.alwaysOnTop !== false);
  }
  if (isNativePopout && cfg.popout && typeof cfg.popout.alwaysOnTop === 'boolean') {
    state.windowPinned = cfg.popout.alwaysOnTop;
    renderNativePinButton();
  }
  const popRunning = isPopoutOpen(state.popoutStatus);
  const popOn = Boolean(popRunning || cfg.popout?.enabled);
  document.getElementById('popoutSwitch').dataset.on = String(popOn);
  const badge = document.getElementById('popoutStateBadge');
  badge.textContent = popRunning
    ? tr('settings.popout.running', { port: state.popoutStatus.port })
    : popOn
      ? tr('settings.popout.enabled')
      : tr('settings.popout.closed');
  badge.style.color = popOn ? 'var(--success)' : 'var(--muted-foreground)';
  badge.style.borderColor = popOn ? 'var(--success)' : 'var(--border)';

  const bannerOn = Boolean(cfg.uiBanner?.enabled);
  document.getElementById('bannerSwitch').dataset.on = String(bannerOn);
  const preview = document.getElementById('bannerPreview');
  preview.style.opacity = bannerOn ? '1' : '0.42';
  if (state.callsData?.banner) {
    preview.textContent = String(state.callsData.banner).replace(/\s*\u00B7\s*/g, ' | ');
  } else {
    preview.textContent = tr('settings.banner.preview');
  }

  document.getElementById('cfgBudgetInput').value = cfg.sessionStartBudgetTokens ?? 450;
  document.getElementById('cfgWarnPctInput').value = cfg.alerts?.contextWarningPct ?? 75;
  document.getElementById('cfgDropPctInput').value = cfg.alerts?.cacheDropThresholdPct ?? 50;

  const rep = state.doctorReport;
  const verEl = document.getElementById('settingsVersionLabel');
  if (verEl) {
    verEl.textContent = tr('settings.version', { version: rep?.version || APP_VERSION });
  }
  if (rep) {
    const pill = document.getElementById('doctorStatusPill');
    pill.textContent = rep.healthy ? tr('settings.doctor.healthy') : tr('settings.doctor.attention');
    pill.style.color = rep.healthy ? 'var(--success)' : 'var(--warning)';
    pill.style.borderColor = rep.healthy ? 'var(--success)' : 'var(--warning)';

    const driftEl = document.getElementById('docDriftVal');
    driftEl.textContent = tr('settings.doctor.driftVal', { count: rep.drift.count });
    driftEl.style.color = rep.drift.count === 0 ? 'var(--success)' : 'var(--warning)';

    document.getElementById('docCircuitVal').textContent = `${rep.circuit.state} (${rep.circuit.failures} / ${rep.circuit.threshold})`;
    document.getElementById('docIndexVal').textContent = tr('settings.doctor.indexVal', {
      status: rep.index.ok ? tr('settings.doctor.indexSynced') : tr('settings.doctor.indexRebuild'),
      count: rep.index.dbMemories,
    });
    document.getElementById('docDeployVal').textContent = tr('settings.doctor.deployVal', {
      version: rep.version || APP_VERSION,
      status: rep.deployment.zeroNodeModules ? tr('settings.doctor.deployClean') : tr('settings.doctor.deployDirty'),
    });
  }
}

function renderCapsuleModal() {
  const cap = state.capsuleData;
  if (!cap) return;
  const preset = cap.budgetPreset || state.capsuleBudgetPreset || 'standard';
  state.capsuleBudgetPreset = preset;

  document.querySelectorAll('#capsuleBudgetNav .capsule-budget-btn').forEach((b) => {
    b.dataset.active = String(b.dataset.capBudget === preset);
  });

  document.getElementById('capsuleGitMeta').textContent = `${cap.project} / ${cap.branch}@${cap.head}`;

  const goalInput = document.getElementById('capsuleGoalInput');
  if (goalInput && document.activeElement !== goalInput) {
    goalInput.value = cap.activeGoal || '';
  }
  const nextInput = document.getElementById('capsuleNextActionInput');
  if (nextInput && document.activeElement !== nextInput) {
    nextInput.value = cap.nextAction || '';
  }

  const badge = document.getElementById('capsuleTokenBadge');
  if (badge) {
    badge.textContent = `${cap.tokens} / ${cap.budgetTokens} tokens`;
    const over = Number(cap.tokens) > Number(cap.budgetTokens);
    badge.classList.toggle('text-warning', over);
    badge.classList.toggle('text-success', !over);
  }

  const decisions = cap.decisions || [];
  const selectedCount = decisions.filter((d) => d.checked).length;
  document.getElementById('capsuleDecCount').textContent = `${selectedCount} / ${decisions.length}`;

  const decHost = document.getElementById('capsuleDecisionsList');
  decHost.innerHTML = decisions.length
    ? decisions
        .map(
          (d, i) => `
      <label class="capsule-check-item" data-checked="${d.checked}">
        <input type="checkbox" ${d.checked ? 'checked' : ''} data-cap-dec="${esc(d.id)}" style="margin-top:2px; accent-color: var(--primary); cursor: pointer;" />
        <span class="text-xs text-fg leading-relaxed flex-1">${i + 1}. ${esc(d.text)}</span>
        <span class="mono-num text-xs text-muted shrink-0">+${d.tokens}t</span>
      </label>`
        )
        .join('')
    : `<div class="text-xs text-muted py-1">${esc(tr('monitor.capsule.noDecisions'))}</div>`;

  const fileItems = Array.isArray(cap.fileItems) && cap.fileItems.length
    ? cap.fileItems
    : (cap.touchedFiles || []).map((p) => ({ path: p, status: '', checked: true }));
  const checkedFiles = fileItems.filter((f) => f.checked !== false).length;
  const filesCountEl = document.getElementById('capsuleFilesCount');
  if (filesCountEl) filesCountEl.textContent = `${checkedFiles} / ${fileItems.length}`;

  const filesHost = document.getElementById('capsuleFilesList');
  filesHost.innerHTML = fileItems.length
    ? fileItems
        .map((f) => {
          const checked = f.checked !== false;
          const st = f.status && f.status !== 'manual' ? `<span class="text-muted">${esc(f.status)}</span>` : '';
          return `
        <label class="capsule-file-chip mono-num" data-checked="${checked}" title="${esc(f.path)}">
          <input type="checkbox" ${checked ? 'checked' : ''} data-cap-file="${esc(f.path)}" style="accent-color: var(--primary); cursor: pointer;" />
          ${st}
          <span class="truncate">${esc(f.path)}</span>
        </label>`;
        })
        .join('')
    : `<span class="text-xs text-muted">${esc(tr('monitor.capsule.autoTrack'))}</span>`;

  const artifactItems = Array.isArray(cap.artifactItems) ? cap.artifactItems : [];
  const artSection = document.getElementById('capsuleArtifactsSection');
  const artHost = document.getElementById('capsuleArtifactsList');
  const artCountEl = document.getElementById('capsuleArtifactsCount');
  if (artSection && artHost) {
    artSection.classList.toggle('hidden', artifactItems.length === 0);
    if (artCountEl) {
      const checkedArt = artifactItems.filter((a) => a.checked !== false).length;
      artCountEl.textContent = `${checkedArt} / ${artifactItems.length}`;
    }
    artHost.innerHTML = artifactItems
      .map((a) => {
        const checked = a.checked !== false;
        return `
      <label class="capsule-check-item" data-checked="${checked}">
        <input type="checkbox" ${checked ? 'checked' : ''} data-cap-artifact="${esc(a.path)}" style="margin-top:2px; accent-color: var(--primary); cursor: pointer;" />
        <span class="min-w-0 flex-1">
          <span class="block text-xs font-medium text-fg truncate">${esc(a.name || a.displayPath || a.path)}</span>
          <span class="block text-xs text-muted mono-num truncate">${esc(a.displayPath || a.path)}</span>
        </span>
        ${a.tokens ? `<span class="mono-num text-xs text-muted shrink-0">+${a.tokens}t</span>` : ''}
      </label>`;
      })
      .join('');
  }

  document.getElementById('capsuleRawPre').textContent = cap.agentPayload || '';

  // Hide updateModelContext attach button when surface does not support it (global / popout)
  const attachBtn = document.getElementById('attachCapsuleBtn');
  attachBtn.classList.toggle('hidden', !state.canUpdateModelContext);
}

// ==================== Data Loaders ====================
async function loadContext(animated = false) {
  const isPinned = state.followMode === 'pinned' && Boolean(state.pinnedConversationId);
  const ctx = await callAppTool('app_get_context_breakdown', {
    conversationId: isPinned ? state.pinnedConversationId : undefined,
    followActive: !isPinned,
  });

  const prevConvId = state.activeConversationId;
  const nextConvId = ctx.conversationId || null;
  const sessionChanged = Boolean(prevConvId && nextConvId && prevConvId !== nextConvId);

  if (sessionChanged) {
    resetSessionViewState();
  }

  state.contextData = ctx;
  state.activeConversationId = nextConvId;
  state.activeProjectDir = ctx.projectDir || null;
  if (isPinned && nextConvId) {
    state.pinnedConversationId = nextConvId;
  }

  renderSelects('monitor-header', { fromPoll: animated });
  renderContext(animated);
  if (state.launcherMode) renderLauncherView();
  return { sessionChanged };
}

async function loadCalls(force = false) {
  const data = await callAppTool('app_get_calls', {
    conversationId: state.activeConversationId || undefined,
    followActive: state.followMode === 'auto',
    agentFilter: state.agentFilter,
    modelFilter: state.modelFilter,
    onlyDrop: state.onlyDrop,
    force,
  });
  // Detect newly arrived top call for subtle slide highlight
  const topCall = data.calls?.[0];
  if (topCall && state.knownCallIds.size > 0 && !state.knownCallIds.has(topCall.callUid)) {
    state.freshCallId = topCall.callUid;
  } else {
    state.freshCallId = null;
  }
  for (const c of data.calls || []) {
    state.knownCallIds.add(c.callUid);
  }
  state.callsData = data;
  renderSelects('calls', { fromPoll: !force });
  renderCalls();
  const nowStr = new Date().toLocaleTimeString(getUiLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
  const lbl = document.getElementById('lastUpdatedLabel');
  if (lbl) lbl.textContent = tr('monitor.calls.lastSync', { time: nowStr });
}

async function loadQuota() {
  if (!FEATURE_FLAGS.showQuotaUi) return;
  state.quotaData = await callAppTool('app_get_quota', {});
  renderQuota();
}

async function loadVault() {
  const query = (document.getElementById('vaultSearch')?.value || '').trim();
  state.vaultData = await callAppTool('app_vault_manage', {
    action: 'list',
    conversationId: state.activeConversationId || undefined,
    projectDir: state.activeProjectDir || undefined,
    query: query || undefined,
    kind: state.vaultKind,
  });
  renderSelects('vault', { fromPoll: true });
  renderVault();
}

async function loadConfigOnly() {
  const cfgRes = await callAppTool('app_config_manage', { action: 'get' });
  const prevLang = getUiLang();
  if (cfgRes?.config) state.config = cfgRes.config;
  if (cfgRes?.popoutStatus) {
    state.popoutStatus = cfgRes.popoutStatus;
    if (cfgRes.popoutStatus.userClosed) state.userClosedPopoutSession = true;
  }
  const nextLang = getUiLang();
  if (nextLang !== prevLang) {
    applyUiLanguage(nextLang);
    return cfgRes;
  }
  renderSelects(state.inSettings ? 'settings' : 'monitor-header');
  if (state.inSettings) renderSettings();
  if (state.launcherMode) renderLauncherView();
  return cfgRes;
}

async function loadConfigAndDoctor() {
  const [cfgRes, docRes] = await Promise.all([
    callAppTool('app_config_manage', { action: 'get' }),
    callAppTool('app_doctor_action', { action: 'diagnose' }),
  ]);
  const prevLang = getUiLang();
  if (cfgRes?.config) state.config = cfgRes.config;
  if (cfgRes?.popoutStatus) {
    state.popoutStatus = cfgRes.popoutStatus;
    if (cfgRes.popoutStatus.userClosed) state.userClosedPopoutSession = true;
  }
  if (docRes?.report) state.doctorReport = docRes.report;
  const nextLang = getUiLang();
  if (nextLang !== prevLang) {
    applyUiLanguage(nextLang);
    return;
  }
  renderSelects(state.inSettings ? 'settings' : 'visible');
  renderSettings();
  if (state.launcherMode) renderLauncherView();
}

async function persistConfigPatch(patch) {
  const res = await callAppTool('app_config_manage', { action: 'update', patch });
  if (res?.config) state.config = res.config;
  if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
  renderSettings();
  renderSelects('visible');
  return res;
}

function shouldPausePolling() {
  if (state.launcherMode) return true;
  if (document.visibilityState !== 'visible') return true;
  if (state.surface === 'aux_pane' && isPopoutOpen(state.popoutStatus) && !state.windowFocused) {
    return true;
  }
  return false;
}

function stopKvCountdownTimer() {
  if (kvCountdownTimer) {
    clearInterval(kvCountdownTimer);
    kvCountdownTimer = null;
  }
}

function startKvCountdownTimer() {
  stopKvCountdownTimer();
  if (state.launcherMode || document.visibilityState !== 'visible') return;
  syncKvCountdownUi();
  kvCountdownTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.launcherMode) {
      syncKvCountdownUi();
    }
  }, 1000);
}

function scheduleIdleModuleChecks() {
  if (idleBadgeCheckScheduled) return;
  idleBadgeCheckScheduled = true;
  const runChecks = () => {
    if (state.launcherMode || document.visibilityState !== 'visible') {
      idleBadgeCheckScheduled = false;
      return;
    }
    if (!i18nModule?.getStatus?.()) {
      void i18nModule?.loadStatus(false);
    }
    void governanceModule?.loadOverview?.(false);
  };
  setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runChecks, { timeout: 2000 });
    } else {
      runChecks();
    }
  }, 2200);
}

async function refreshAll(animated = true, manual = false, force = false) {
  if (refreshInFlight && !manual && !force) return;
  if (!manual && !force) {
    if (shouldPausePolling()) return;
    if ((state.activeModule !== 'monitor' || state.inSettings) && !state.windowCollapsed) return;
  }
  const mySeq = ++refreshSeq;
  refreshInFlight = true;
  lastRefreshAt = Date.now();
  if (manual) {
    const svg = document.getElementById('refreshSvg');
    if (svg) {
      svg.style.transition = 'transform 480ms cubic-bezier(0.22, 1, 0.36, 1)';
      svg.style.transform = 'rotate(360deg)';
      setTimeout(() => {
        svg.style.transition = 'none';
        svg.style.transform = 'rotate(0deg)';
      }, 500);
    }
  }
  try {
    await loadContext(animated);
    if (mySeq !== refreshSeq) return;
    const tasks = [];
    if (!state.windowCollapsed && !state.inSettings && state.activeModule === 'monitor') {
      if (state.activeTab === 'calls') tasks.push(loadCalls(manual || force));
      if (state.activeTab === 'vault') tasks.push(loadVault());
      if (FEATURE_FLAGS.showQuotaUi && state.activeTab === 'quota') tasks.push(loadQuota());
    }
    if (tasks.length) {
      await Promise.allSettled(tasks);
    }
    if (manual && mySeq === refreshSeq) showToast(tr('toast.synced'));
  } catch (err) {
    if (!state.contextData) {
      const attr = document.getElementById('ctxAttribution');
      if (attr) attr.textContent = tr('toast.syncFailed', { error: err.message });
    }
    if (manual && mySeq === refreshSeq) showToast(tr('toast.syncFailed', { error: err.message }), 'error');
  } finally {
    if (mySeq === refreshSeq) {
      refreshInFlight = false;
    }
  }
}

function restartPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (shouldPausePolling()) return;
  const sec = Number(state.config.pollIntervalSec ?? 5);
  if (sec > 0) {
    pollTimer = setInterval(() => {
      if (shouldPausePolling()) return;
      void refreshAll(true, false);
    }, sec * 1000);
  }
}

// ==================== Navigation & Modals ====================
function renderI18nUpdateBanner() {
  const status = state.i18nStatus;
  const reminderEnabled =
    (status?.config?.i18n?.updateReminderEnabled ?? state.config.i18n?.updateReminderEnabled) !== false;
  const isOutdated = status?.status === 'outdated_after_update' && reminderEnabled;
  const showBanner = isOutdated && !state.i18nBannerDismissed;

  document.getElementById('i18nUpdateBanner')?.classList.toggle('hidden', !showBanner);
  document.getElementById('railI18nAlertDot')?.classList.toggle('hidden', !isOutdated);
  document.getElementById('topBarI18nDot')?.classList.toggle('hidden', !isOutdated);
}

function handleI18nStatusChange(statusData) {
  state.i18nStatus = statusData || null;
  if (statusData?.config?.i18n) {
    state.config = { ...state.config, i18n: statusData.config.i18n };
  }
  renderI18nUpdateBanner();
}

function renderContextModelSim() {
  const sel = document.getElementById('ctxModelSimSelect');
  const out = document.getElementById('ctxModelSimResult');
  if (!sel || !out) return;
  const targetLimit = Number(sel.value) || 0;
  const used = Number(state.contextData?.usedTokens) || 0;
  if (!targetLimit) {
    out.textContent = tr('monitor.ctx.modelSimHint');
    out.style.color = 'var(--muted-foreground)';
    return;
  }
  const simPct = (used / targetLimit) * 100;
  const simFree = Math.max(0, targetLimit - used);
  const warnPct = state.config.alerts?.contextWarningPct ?? 75;
  out.textContent =
    simPct >= 100
      ? tr('monitor.ctx.modelSimOverflow', { pct: simPct.toFixed(1), over: fmtK(used - targetLimit) })
      : tr('monitor.ctx.modelSimResult', { pct: simPct.toFixed(1), free: fmtK(simFree) });
  out.style.color = simPct >= 95 ? 'var(--error)' : simPct >= warnPct ? 'var(--warning)' : 'var(--success)';
}

function syncConsoleNavState() {
  document.querySelectorAll('.console-rail-btn[data-module], .console-top-btn[data-module]').forEach((btn) => {
    btn.dataset.active = String(!state.inSettings && btn.dataset.module === state.activeModule);
  });
  const railSettings = document.getElementById('railSettingsBtn');
  if (railSettings) railSettings.dataset.active = String(Boolean(state.inSettings));

  ['settingsBtn', 'govSettingsBtn', 'appSettingsBtn', 'i18nSettingsBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.borderColor = state.inSettings ? 'var(--primary)' : 'var(--border)';
    btn.style.color = state.inSettings ? 'var(--primary)' : 'var(--foreground)';
  });
}

function switchModule(mod, subTab = null) {
  const safeMod = ['i18n', 'governance', 'appearance'].includes(mod) ? mod : 'monitor';
  state.activeModule = safeMod;
  state.inSettings = false;

  document.getElementById('module-monitor')?.classList.toggle('hidden', safeMod !== 'monitor');
  document.getElementById('module-governance')?.classList.toggle('hidden', safeMod !== 'governance');
  document.getElementById('module-appearance')?.classList.toggle('hidden', safeMod !== 'appearance');
  document.getElementById('module-i18n')?.classList.toggle('hidden', safeMod !== 'i18n');
  document.getElementById('module-settings')?.classList.add('hidden');
  syncConsoleNavState();

  if (safeMod === 'monitor') {
    renderSelects('visible');
    if (!state.contextData || Date.now() - lastRefreshAt >= 2000) {
      void refreshAll(false, false);
    }
    requestAnimationFrame(positionVisibleIndicators);
  } else if (safeMod === 'governance') {
    void governanceModule?.activate(subTab);
    requestAnimationFrame(() => governanceModule?.positionSubNav());
  } else if (safeMod === 'appearance') {
    void appearanceModule?.activate(subTab);
    requestAnimationFrame(() => appearanceModule?.positionSubNav());
  } else {
    void i18nModule?.activate(subTab);
    requestAnimationFrame(() => i18nModule?.positionSubNav());
  }
}

function switchTab(tab) {
  const safeTab = !FEATURE_FLAGS.showQuotaUi && tab === 'quota' ? 'context' : tab;
  state.activeTab = safeTab;
  if (state.activeModule !== 'monitor' || state.inSettings) {
    switchModule('monitor');
  }
  ['context', 'calls', 'quota', 'vault'].forEach((t) => {
    document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== safeTab);
  });
  document.querySelectorAll('#mainSegNav .seg-tab').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.tab === safeTab);
  });
  positionIndicator('mainSegNav', 'mainSegIndicator');
  if (safeTab === 'calls') {
    renderSelects('calls');
    requestAnimationFrame(() => positionIndicator('callsModeNav', 'callsModeIndicator'));
    if (!state.callsData) void loadCalls(false);
  } else if (safeTab === 'vault') {
    renderSelects('vault');
    if (!state.vaultData) void loadVault();
  } else if (safeTab === 'quota' && FEATURE_FLAGS.showQuotaUi) {
    if (!state.quotaData) void loadQuota();
  }
}

function toggleSettingsView() {
  if (state.inSettings) {
    exitSettingsView();
    return;
  }
  state.inSettings = true;
  document.getElementById('module-monitor')?.classList.add('hidden');
  document.getElementById('module-governance')?.classList.add('hidden');
  document.getElementById('module-appearance')?.classList.add('hidden');
  document.getElementById('module-i18n')?.classList.add('hidden');
  document.getElementById('module-settings')?.classList.remove('hidden');
  document.getElementById('panel-settings')?.classList.remove('hidden');
  syncConsoleNavState();
  renderSelects('settings');
  renderSettings();
  void loadConfigAndDoctor();
}

function exitSettingsView() {
  state.inSettings = false;
  document.getElementById('module-settings')?.classList.add('hidden');
  document.getElementById('module-monitor')?.classList.toggle('hidden', state.activeModule !== 'monitor');
  document.getElementById('module-governance')?.classList.toggle('hidden', state.activeModule !== 'governance');
  document.getElementById('module-appearance')?.classList.toggle('hidden', state.activeModule !== 'appearance');
  document.getElementById('module-i18n')?.classList.toggle('hidden', state.activeModule !== 'i18n');
  syncConsoleNavState();
  requestAnimationFrame(positionVisibleIndicators);
}

function pulseTargetEl(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('jump-highlight-pulse');
  requestAnimationFrame(() => {
    el.classList.add('jump-highlight-pulse');
    setTimeout(() => el.classList.remove('jump-highlight-pulse'), 1600);
  });
}

async function handleAlertJump(alertIdx) {
  const alerts = state.contextData?.alerts || [];
  const alert = alerts[Number(alertIdx)];
  if (!alert) return;

  // 1. Collapse alerts drawer immediately
  const acc = document.getElementById('alertsAcc');
  if (acc) acc.dataset.open = 'false';

  const code = String(alert.code || '').toLowerCase();
  const titleStr = String(alert.title || '');
  const detailStr = String(alert.detail || '');
  const combined = `${titleStr} ${detailStr}`;

  // 2. Context threshold warning -> Context tab -> scroll to breakdown card
  if (code === 'context_high') {
    switchTab('context');
    requestAnimationFrame(() => {
      pulseTargetEl(document.getElementById('ctxBreakdownCard') || document.getElementById('ctxBreakdownList'));
    });
    return;
  }

  // 3. Heavy MCP warning -> locate MCP assets accordion or Governance extensions
  if (code.includes('mcp') || /\bmcp\b/i.test(titleStr)) {
    const invs = state.contextData?.inventories || [];
    const mcpIdx = invs.findIndex((g) => g.id === 'mcp_servers');
    if (mcpIdx >= 0 && (invs[mcpIdx].items?.length || 0) > 0) {
      switchTab('context');
      state.openAccIdx = mcpIdx;
      document.querySelectorAll('#inventoryList .acc-trigger').forEach((b, i) => {
        b.dataset.open = String(i === state.openAccIdx);
      });
      document.querySelectorAll('#inventoryList .inv-acc-body').forEach((body, i) => {
        body.dataset.open = String(i === state.openAccIdx);
      });
      requestAnimationFrame(() => {
        pulseTargetEl(document.getElementById('inventoryCard') || document.getElementById('inventoryList'));
      });
    } else {
      switchModule('governance', 'extensions');
    }
    return;
  }

  // 4. Call-level anomalies (cache_drop, low_tps_streak, subagent_burst, long_ctx_media_cache_risk, micro_step_streak, etc.)
  switchTab('calls');
  if (state.callsMode !== 'step') {
    state.callsMode = 'step';
    document.querySelectorAll('#callsModeNav .seg-tab').forEach((b) => {
      b.dataset.active = String(b.dataset.mode === 'step');
    });
    positionIndicator('callsModeNav', 'callsModeIndicator');
    document.getElementById('callsStepWrap')?.classList.remove('hidden');
    document.getElementById('callsSummaryWrap')?.classList.add('hidden');
  }

  const stepMatch = combined.match(/#(\d+)/);
  const tagMatch = combined.match(/\[([^\]]+)\]/);
  const targetStep = alert.stepIndex != null ? Number(alert.stepIndex) : stepMatch ? Number(stepMatch[1]) : null;
  const targetTag = alert.agentTag || (tagMatch ? tagMatch[1] : null);
  const targetCallUid = alert.callUid || null;

  const findMatchingCall = (calls) => {
    if (!Array.isArray(calls) || !calls.length) return null;
    if (targetCallUid) {
      const exact = calls.find((c) => c.callUid === targetCallUid);
      if (exact) return exact;
    }
    if (targetStep != null) {
      if (targetTag) {
        const both = calls.find((c) => Number(c.stepIndex) === targetStep && c.agentTag === targetTag);
        if (both) return both;
      }
      const byStep = calls.find((c) => Number(c.stepIndex) === targetStep);
      if (byStep) return byStep;
    }
    if (code === 'subagent_burst') {
      const subs = targetTag ? calls.filter((c) => c.agentTag === targetTag) : calls.filter((c) => c.agentType === 'sub');
      if (subs.length) {
        return [...subs].sort((a, b) => (b.contextTokens || 0) - (a.contextTokens || 0))[0];
      }
    }
    if (code === 'low_tps_streak') {
      const lowThresh = state.config?.alerts?.lowTpsThreshold || 15;
      const slow = calls.find((c) => c.effectiveTps > 0 && c.effectiveTps < lowThresh);
      if (slow) return slow;
    }
    if (code === 'cache_drop') {
      const drop = calls.find((c) => c.cacheDrop);
      if (drop) return drop;
    }
    return calls[0];
  };

  let matched = findMatchingCall(state.callsData?.calls);
  if (!matched) {
    const hadFilters = state.agentFilter !== 'all' || state.modelFilter !== 'all' || state.onlyDrop;
    if (hadFilters) {
      state.agentFilter = 'all';
      state.modelFilter = 'all';
      state.onlyDrop = false;
      const dropBtn = document.getElementById('onlyDropBtn');
      const dropDot = document.getElementById('onlyDropDot');
      if (dropBtn) {
        dropBtn.style.borderColor = 'var(--border)';
        dropBtn.style.color = 'var(--foreground)';
      }
      if (dropDot) dropDot.style.background = 'var(--border)';
    }
    await loadCalls(false).catch(() => {});
    matched = findMatchingCall(state.callsData?.calls);
  }

  if (matched) {
    state.expandedCallId = matched.callUid;
    renderCalls();
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('#callsTbody tr.call-row[data-call-id]');
      const row = [...rows].find((r) => r.dataset.callId === matched.callUid);
      if (row) {
        pulseTargetEl(row);
        const anatomy = row.nextElementSibling;
        if (anatomy && anatomy.classList.contains('call-anatomy-row')) {
          anatomy.classList.remove('jump-highlight-pulse');
          requestAnimationFrame(() => {
            anatomy.classList.add('jump-highlight-pulse');
            setTimeout(() => anatomy.classList.remove('jump-highlight-pulse'), 1600);
          });
        }
      }
    });
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.open = 'true';
  if (id === 'addMemModal') renderSelects('vault');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.open = 'false';
  if (id === 'appRotationPoolModal') {
    appearanceModule?.onPoolModalClosed?.();
  }
}

function formatSourceLayerLabel(layer) {
  const map = {
    workspace: 'monitor.asset.layerWorkspace',
    global: 'monitor.asset.layerGlobal',
    plugin: 'monitor.asset.layerPlugin',
    builtin: 'monitor.asset.layerBuiltin',
    vault: 'monitor.asset.layerVault',
  };
  const key = map[String(layer || '').toLowerCase()];
  return key ? tr(key) : layer ? String(layer) : '';
}

async function openAssetInspector(groupIdx, itemIdx) {
  const rawGroup = state.contextData?.inventories?.[Number(groupIdx)];
  if (!rawGroup) return;
  const rawItem = rawGroup.items?.[Number(itemIdx)];
  if (!rawItem) return;

  const locGroup = localizeInventoryGroup(rawGroup, getUiLang());
  const locItem = locGroup.items?.[Number(itemIdx)] || rawItem;
  const item = { ...rawItem, name: locItem.name || rawItem.name, meta: locItem.meta || rawItem.meta };
  state.inspectedAsset = item;

  const titleEl = document.getElementById('assetInspectorTitle');
  const sourcePill = document.getElementById('assetInspectorSourcePill');
  const sizePill = document.getElementById('assetInspectorSizePill');
  const subMetaEl = document.getElementById('assetInspectorSubMeta');
  const fileView = document.getElementById('assetFileView');
  const mcpView = document.getElementById('assetMcpView');

  if (titleEl) titleEl.textContent = item.name || tr('monitor.asset.title');
  const layerLabel = formatSourceLayerLabel(item.sourceLayer);
  if (sourcePill) {
    sourcePill.textContent = layerLabel;
    sourcePill.classList.toggle('hidden', !layerLabel);
  }
  if (sizePill) {
    sizePill.textContent = item.size || (item.tokens ? fmtK(item.tokens) : '');
    sizePill.classList.toggle('hidden', !sizePill.textContent);
  }
  if (subMetaEl) {
    subMetaEl.textContent = item.displayPath || item.filePath || item.meta || '';
  }

  const isMcp = item.kind === 'mcp_server' || rawGroup.id === 'mcp_servers';
  if (isMcp) {
    fileView?.classList.add('hidden');
    mcpView?.classList.remove('hidden');

    const tools = Array.isArray(item.tools) ? item.tools : [];
    const totalTokens = Number(item.tokens) || tools.reduce((s, t) => s + (Number(t.tokens) || 0), 0);
    const eagerCnt = item.eagerCount != null ? Number(item.eagerCount) : tools.filter((t) => !t.deferred).length;
    const deferredCnt = item.deferredCount != null ? Number(item.deferredCount) : tools.filter((t) => t.deferred).length;

    const sumEl = document.getElementById('assetMcpSummary');
    if (sumEl) {
      sumEl.innerHTML = `
        <span class="font-medium text-fg mono-num">${esc(fmtK(totalTokens))} tokens</span>
        <span class="flex items-center gap-1.5">
          <span class="agy-pill mono-num text-xs">${esc(tr('monitor.asset.mcpDeferred'))} ${deferredCnt}</span>
          <span class="agy-pill mono-num text-xs">${esc(tr('monitor.asset.mcpEager'))} ${eagerCnt}</span>
        </span>`;
    }

    const cntEl = document.getElementById('assetMcpToolCount');
    if (cntEl) cntEl.textContent = String(tools.length || item.toolCount || 0);

    const listEl = document.getElementById('assetMcpToolsList');
    if (listEl) {
      if (!tools.length) {
        listEl.innerHTML = `<div class="px-4 py-5 text-center text-xs text-muted">${esc(tr('monitor.asset.mcpNoTools'))}</div>`;
      } else {
        const denom = Math.max(1, totalTokens);
        listEl.innerHTML = tools
          .map((tool) => {
            const tok = Number(tool.tokens) || 0;
            const pct = Math.min(100, Math.max(0, (tok / denom) * 100));
            const modeLbl = tool.deferred ? tr('monitor.asset.mcpDeferred') : tr('monitor.asset.mcpEager');
            return `
            <div class="asset-mcp-tool-row text-xs">
              <div class="flex items-center justify-between gap-2">
                <span class="mono-num font-medium text-fg truncate" title="${esc(tool.name)}">${esc(tool.name)}</span>
                <span class="flex items-center gap-1.5 shrink-0">
                  <span class="agy-pill text-xs">${esc(modeLbl)}</span>
                  <span class="mono-num text-muted">${esc(tool.size || fmtK(tok))} (${pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div class="asset-mcp-bar-track">
                <div class="asset-mcp-bar-fill" data-deferred="${Boolean(tool.deferred)}" style="width: ${Math.max(2, pct).toFixed(1)}%;"></div>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    openModal('assetInspectorModal');
    return;
  }

  // Rule / Skill / Subagent / Brief read-only redacted preview
  mcpView?.classList.add('hidden');
  fileView?.classList.remove('hidden');

  const usedBase = Number(state.contextData?.usedTokens) || Number(state.contextData?.limitTokens) || 1;
  const itemTokens = Number(item.tokens) || 0;
  const pctShare = ((itemTokens / usedBase) * 100).toFixed(2);
  const shareEl = document.getElementById('assetFileShareLabel');
  if (shareEl) {
    shareEl.textContent = itemTokens > 0 ? tr('monitor.asset.share', { pct: pctShare, tokens: fmtK(itemTokens) }) : '';
  }

  const hasPath = Boolean(item.filePath);
  document.getElementById('assetCopyPathBtn')?.classList.toggle('hidden', !hasPath);
  document.getElementById('assetOpenFileBtn')?.classList.toggle('hidden', !hasPath);

  const contentEl = document.getElementById('assetFileContent');
  if (hasPath) {
    if (contentEl) contentEl.textContent = tr('common.loading');
    openModal('assetInspectorModal');
    try {
      const res = await callAppTool('app_get_context_breakdown', {
        action: 'preview_asset',
        filePath: item.filePath,
        conversationId: state.activeConversationId || undefined,
        followActive: state.followMode === 'auto',
        projectDir: state.activeProjectDir || undefined,
      });
      if (state.inspectedAsset !== item) return;
      if (subMetaEl) {
        const metaPath = res.displayPath || item.displayPath || item.filePath;
        const linesSuffix = res.lines != null ? ` (${res.lines}L${res.truncated ? ', truncated' : ''})` : '';
        subMetaEl.textContent = `${metaPath}${linesSuffix}`;
      }
      if (contentEl) contentEl.textContent = res.content || '(empty)';
    } catch (err) {
      if (state.inspectedAsset !== item) return;
      if (contentEl) contentEl.textContent = err?.message || String(err);
    }
  } else {
    if (contentEl) {
      contentEl.textContent = item.previewText || tr('monitor.asset.noFileContent');
    }
    openModal('assetInspectorModal');
  }
}

async function reloadCapsule(overrides = {}) {
  const cap = state.capsuleData || {};
  const budgetPreset = overrides.budgetPreset || state.capsuleBudgetPreset || 'standard';
  state.capsuleBudgetPreset = budgetPreset;

  const goalInput = document.getElementById('capsuleGoalInput');
  const nextInput = document.getElementById('capsuleNextActionInput');
  const activeGoal = overrides.activeGoal !== undefined ? overrides.activeGoal : goalInput ? goalInput.value : undefined;
  const nextAction = overrides.nextAction !== undefined ? overrides.nextAction : nextInput ? nextInput.value : undefined;

  const selectedDecisionIds =
    overrides.selectedDecisionIds !== undefined
      ? overrides.selectedDecisionIds
      : Array.isArray(cap.decisions)
        ? cap.decisions.filter((d) => d.checked).map((d) => d.id)
        : undefined;

  const selectedFiles =
    overrides.selectedFiles !== undefined
      ? overrides.selectedFiles
      : Array.isArray(cap.fileItems)
        ? cap.fileItems.filter((f) => f.checked !== false).map((f) => f.path)
        : undefined;

  const selectedArtifacts =
    overrides.selectedArtifacts !== undefined
      ? overrides.selectedArtifacts
      : Array.isArray(cap.artifactItems)
        ? cap.artifactItems.filter((a) => a.checked !== false).map((a) => a.path)
        : undefined;

  state.capsuleData = await callAppTool('app_vault_manage', {
    action: 'capsule',
    conversationId: state.activeConversationId || undefined,
    projectDir: state.activeProjectDir || undefined,
    budgetPreset,
    activeGoal: activeGoal !== undefined && activeGoal.trim() ? activeGoal.trim() : undefined,
    nextAction: nextAction !== undefined && nextAction.trim() ? nextAction.trim() : undefined,
    selectedDecisionIds,
    selectedFiles,
    selectedArtifacts,
  });
  renderCapsuleModal();
}

async function openCapsuleModal() {
  state.capsuleBudgetPreset = state.capsuleBudgetPreset || 'standard';
  const cap = await callAppTool('app_vault_manage', {
    action: 'capsule',
    conversationId: state.activeConversationId || undefined,
    projectDir: state.activeProjectDir || undefined,
    budgetPreset: state.capsuleBudgetPreset,
  });
  state.capsuleData = cap;
  renderCapsuleModal();
  openModal('capsuleModal');
  requestAnimationFrame(() => positionIndicator('capsuleModeNav', 'capsuleModeIndicator'));
}

function setCapsuleMode(mode) {
  state.capsuleMode = mode;
  document.querySelectorAll('#capsuleModeNav .seg-tab').forEach((b) => {
    b.dataset.active = String(b.dataset.cmode === mode);
  });
  positionIndicator('capsuleModeNav', 'capsuleModeIndicator');
  document.getElementById('capsuleHumanView').classList.toggle('hidden', mode !== 'human');
  document.getElementById('capsuleAgentView').classList.toggle('hidden', mode !== 'agent');
}

function openQuotaCalModal(groupId) {
  state.calGroup = groupId || 'gemini';
  renderSelects();
  prefillQuotaInputs();
  openModal('quotaModal');
}

function prefillQuotaInputs() {
  const g = (state.quotaData?.groups || []).find((x) => x.id === state.calGroup);
  if (!g) return;
  document.getElementById('calWeeklyPct').value = g.weeklyPct;
  document.getElementById('calWeeklyHrs').value = g.weeklyHrs;
  const has5h = g.h5Pct !== null;
  document.getElementById('cal5hRow').classList.toggle('hidden', !has5h);
  if (has5h) {
    document.getElementById('cal5hPct').value = g.h5Pct;
    document.getElementById('cal5hMins').value = g.h5Mins;
  }
}

// ==================== Event Wiring ====================
function bindEvents() {
  document.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-select-toggle]');
    if (toggleBtn) {
      e.stopPropagation();
      const id = toggleBtn.dataset.selectToggle;
      state.openSelectId = state.openSelectId === id ? null : id;
      renderSelects();
      return;
    }

    const pickBtn = e.target.closest('[data-select-pick]');
    if (pickBtn) {
      e.stopPropagation();
      void handleSelectPick(pickBtn.dataset.selectPick, pickBtn.dataset.selectVal);
      return;
    }

    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      closeModal(closeBtn.dataset.closeModal);
      return;
    }

    if (e.target.classList.contains('modal-backdrop')) {
      closeModal(e.target.id);
      return;
    }

    const alertRowBtn = e.target.closest('[data-alert-idx]');
    if (alertRowBtn) {
      void handleAlertJump(Number(alertRowBtn.dataset.alertIdx));
      return;
    }

    const invItemBtn = e.target.closest('[data-inv-group][data-inv-item]');
    if (invItemBtn) {
      void openAssetInspector(Number(invItemBtn.dataset.invGroup), Number(invItemBtn.dataset.invItem));
      return;
    }

    const accBtn = e.target.closest('[data-acc-idx]');
    if (accBtn) {
      const idx = Number(accBtn.dataset.accIdx);
      state.openAccIdx = state.openAccIdx === idx ? -1 : idx;
      document.querySelectorAll('.acc-trigger').forEach((b, i) => {
        b.dataset.open = String(i === state.openAccIdx);
      });
      document.querySelectorAll('.inv-acc-body').forEach((body, i) => {
        body.dataset.open = String(i === state.openAccIdx);
      });
      return;
    }

    const callRow = e.target.closest('[data-call-id]');
    if (callRow) {
      const id = callRow.dataset.callId;
      state.expandedCallId = state.expandedCallId === id ? null : id;
      renderCalls();
      return;
    }

    const calBtn = e.target.closest('[data-cal-group]');
    if (calBtn) {
      openQuotaCalModal(calBtn.dataset.calGroup);
      return;
    }

    const archBtn = e.target.closest('[data-archive-mem]');
    if (archBtn) {
      const id = archBtn.dataset.archiveMem;
      void (async () => {
        await callAppTool('app_vault_manage', { action: 'archive', id });
        await loadVault();
        showToast('已软归档该条记忆（保留真相源文件）');
      })();
      return;
    }

    if (state.openSelectId) {
      state.openSelectId = null;
      renderSelects();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.openSelectId) {
        state.openSelectId = null;
        renderSelects();
      }
      ['capsuleModal', 'quotaModal', 'addMemModal', 'i18nPatchConfirmModal', 'i18nEntryModal', 'i18nImportModal', 'appRotationPoolModal', 'restartIdeModal', 'assetInspectorModal'].forEach(closeModal);
      document.getElementById('govLintFixModal')?.classList.add('hidden');
    }
  });

  // Context bar / list bi-directional hover highlight
  const panelCtx = document.getElementById('panel-context');
  panelCtx.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.ctx-seg, .ctx-row');
    if (target?.dataset.id) highlightCtx(target.dataset.id);
  });
  panelCtx.addEventListener('mouseout', (e) => {
    if (e.target.closest('.ctx-seg, .ctx-row')) highlightCtx(null);
  });

  document.querySelectorAll('#mainSegNav .seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('#callsModeNav .seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.callsMode = btn.dataset.mode;
      document.querySelectorAll('#callsModeNav .seg-tab').forEach((b) => {
        b.dataset.active = String(b.dataset.mode === state.callsMode);
      });
      positionIndicator('callsModeNav', 'callsModeIndicator');
      document.getElementById('callsStepWrap').classList.toggle('hidden', state.callsMode !== 'step');
      document.getElementById('callsSummaryWrap').classList.toggle('hidden', state.callsMode !== 'summary');
    });
  });

  document.querySelectorAll('#capsuleModeNav .seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => setCapsuleMode(btn.dataset.cmode));
  });

  document.getElementById('followToggleBtn')?.addEventListener('click', () => {
    if (state.followMode === 'auto') {
      state.followMode = 'pinned';
      state.pinnedConversationId = state.activeConversationId;
      renderSelects();
      showToast(tr('toast.followPinned'));
    } else {
      state.followMode = 'auto';
      state.pinnedConversationId = null;
      resetSessionViewState();
      renderSelects();
      void refreshAll(true, false);
      showToast(tr('toast.followAuto'));
    }
  });

  let popoutLaunchBusy = false;
  const handleOpenPopout = async (forceNew = false) => {
    if (isNativePopout) {
      showToast(tr('toast.popoutAlreadyIn'));
      return state.popoutStatus;
    }
    if (popoutLaunchBusy) return state.popoutStatus;
    popoutLaunchBusy = true;
    const triggerBtns = ['quickPopoutBtn', 'topBarPopoutBtn', 'launcherOpenPopoutBtn', 'launchPopoutBtn']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    triggerBtns.forEach((b) => { b.disabled = true; });
    try {
      state.userClosedPopoutSession = false;
      const res = await callAppTool('app_config_manage', {
        action: 'open_popout',
        forceNew,
        theme: detectCurrentTheme(),
      });
      if (res?.config) state.config = res.config;
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      renderSettings();
      if (state.launcherMode) renderLauncherView();
      restartPollTimer();
      const st = res?.popoutStatus;
      if (st?.reused) {
        showToast(tr('toast.popoutFocused', { port: st.port }));
      } else if (st?.launched) {
        showToast(tr('toast.popoutLaunched', { port: st.port }));
      } else {
        showToast(tr('toast.popoutFallback'));
      }
      return st;
    } catch (err) {
      showToast(tr('toast.popoutFailed', { error: err?.message || String(err) }), 'error');
      return null;
    } finally {
      popoutLaunchBusy = false;
      triggerBtns.forEach((b) => { b.disabled = false; });
    }
  };

  document.getElementById('quickPopoutBtn')?.addEventListener('click', () => {
    void handleOpenPopout(false);
  });
  document.getElementById('topBarPopoutBtn')?.addEventListener('click', () => {
    void handleOpenPopout(false);
  });
  document.getElementById('ctxModelSimSelect')?.addEventListener('change', () => {
    renderContextModelSim();
  });

  // Dynamically clamp help tooltips inside viewport edges so narrow sidebars never clip them
  const clampHelpTip = (wrap) => {
    const pop = wrap?.querySelector('.help-tip-pop');
    if (!pop) return;
    pop.style.left = '';
    pop.style.right = '0px';
    const rect = pop.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const pad = 10;
    if (rect.left < pad) {
      const shift = pad - rect.left;
      pop.style.right = `${-shift}px`;
    } else if (rect.right > vw - pad) {
      const shift = rect.right - (vw - pad);
      pop.style.right = `${shift}px`;
    }
  };
  document.querySelectorAll('.help-tip-wrap').forEach((wrap) => {
    wrap.addEventListener('mouseenter', () => clampHelpTip(wrap));
    wrap.addEventListener('focusin', () => clampHelpTip(wrap));
  });

  document.getElementById('launcherOpenPopoutBtn')?.addEventListener('click', () => {
    void handleOpenPopout(false);
  });

  document.getElementById('launcherUseEmbeddedBtn')?.addEventListener('click', () => {
    exitGlobalLauncherMode();
  });

  document.getElementById('launcherClosePopoutBtn')?.addEventListener('click', () => {
    void (async () => {
      const res = await callAppTool('app_config_manage', { action: 'close_popout' });
      if (res?.config) state.config = res.config;
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      state.userClosedPopoutSession = true;
      if (isPopoutClosed(state.popoutStatus)) {
        exitGlobalLauncherMode();
      } else {
        renderLauncherView();
      }
      renderSettings();
      showToast('已关闭独立悬浮窗并释放本地端口');
    })();
  });

  document.querySelectorAll('.console-rail-btn[data-module], .console-top-btn[data-module]').forEach((btn) => {
    btn.addEventListener('click', () => switchModule(btn.dataset.module));
  });
  document.getElementById('railSettingsBtn')?.addEventListener('click', toggleSettingsView);
  document.getElementById('i18nBannerGoBtn')?.addEventListener('click', () => switchModule('i18n', 'status'));
  document.getElementById('i18nBannerDismissBtn')?.addEventListener('click', () => {
    state.i18nBannerDismissed = true;
    renderI18nUpdateBanner();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => void refreshAll(true, true));
  document.getElementById('settingsBtn').addEventListener('click', toggleSettingsView);
  document.getElementById('exitSettingsBtn').addEventListener('click', exitSettingsView);

  // Monitor & Settings Restart Antigravity confirmation flow
  let restartIdeBusy = false;
  const openRestartIdeModal = () => {
    const confirmBtn = document.getElementById('restartIdeConfirmBtn');
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = tr('monitor.restart.confirm');
    }
    openModal('restartIdeModal');
  };
  document.getElementById('restartIdeBtn')?.addEventListener('click', openRestartIdeModal);
  document.getElementById('settingsRestartIdeBtn')?.addEventListener('click', openRestartIdeModal);

  // Settings: Check & Apply Self-Update (SHA-256 verified)
  let updateCheckBusy = false;
  let updateApplyBusy = false;
  let lastUpdateReleaseUrl = 'https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases';

  const openExternalUrl = async (url) => {
    if (!url || !/^https:\/\//i.test(String(url))) return;
    if (mcpApp && typeof mcpApp.openLink === 'function') {
      try {
        await mcpApp.openLink({ url });
        return;
      } catch {
        // fallback to window.open
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  document.getElementById('settingsOpenReleaseBtn')?.addEventListener('click', () => {
    void openExternalUrl(lastUpdateReleaseUrl);
  });

  document.getElementById('settingsCheckUpdateBtn')?.addEventListener('click', () => {
    if (updateCheckBusy || updateApplyBusy) return;
    updateCheckBusy = true;
    const btn = document.getElementById('settingsCheckUpdateBtn');
    const statusEl = document.getElementById('settingsUpdateStatus');
    const boxEl = document.getElementById('settingsUpdateBox');
    const metaEl = document.getElementById('settingsUpdateMeta');
    const badgeEl = document.getElementById('settingsUpdateBadge');
    const notesEl = document.getElementById('settingsUpdateNotes');
    const applyBtn = document.getElementById('settingsApplyUpdateBtn');

    if (btn) {
      btn.disabled = true;
      btn.textContent = tr('settings.update.checking');
    }

    void (async () => {
      try {
        const res = await callAppTool('app_config_manage', { action: 'check_update' });
        if (res?.releaseUrl) lastUpdateReleaseUrl = res.releaseUrl;
        if (!res || res.ok === false) {
          const msg = res?.message || res?.error || 'network_error';
          if (statusEl) {
            statusEl.className = 'mono-num text-warning';
            statusEl.textContent = tr('settings.update.checkFailed', { error: msg });
          }
          if (boxEl) boxEl.classList.remove('hidden');
          if (metaEl) metaEl.textContent = msg;
          if (badgeEl) badgeEl.textContent = tr('settings.update.manualOnly');
          if (notesEl) notesEl.classList.add('hidden');
          if (applyBtn) applyBtn.classList.add('hidden');
          showToast(tr('settings.update.checkFailed', { error: msg }), 'error');
          return;
        }

        if (!res.hasUpdate) {
          if (statusEl) {
            statusEl.className = 'mono-num text-success';
            statusEl.textContent = tr('settings.update.upToDate', { version: res.currentVersion || APP_VERSION });
          }
          if (boxEl) boxEl.classList.add('hidden');
          showToast(tr('settings.update.upToDate', { version: res.currentVersion || APP_VERSION }), 'success');
          return;
        }

        if (statusEl) {
          statusEl.className = 'mono-num text-primary font-medium';
          statusEl.textContent = tr('settings.update.available', { version: res.latestVersion });
        }
        if (boxEl) boxEl.classList.remove('hidden');
        if (metaEl) {
          metaEl.textContent = tr('settings.update.meta', {
            current: res.currentVersion || APP_VERSION,
            latest: res.latestVersion,
          });
        }
        if (badgeEl) {
          badgeEl.textContent = res.canAutoUpdate ? tr('settings.update.shaReady') : tr('settings.update.manualOnly');
        }
        if (notesEl) {
          if (res.notes) {
            notesEl.textContent = res.notes;
            notesEl.classList.remove('hidden');
          } else {
            notesEl.classList.add('hidden');
          }
        }
        if (applyBtn) {
          applyBtn.classList.toggle('hidden', !res.canAutoUpdate);
        }
      } catch (err) {
        const msg = err?.message || String(err);
        if (statusEl) {
          statusEl.className = 'mono-num text-warning';
          statusEl.textContent = tr('settings.update.checkFailed', { error: msg });
        }
        showToast(tr('settings.update.checkFailed', { error: msg }), 'error');
      } finally {
        updateCheckBusy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = tr('settings.update.checkBtn');
        }
      }
    })();
  });

  document.getElementById('settingsApplyUpdateBtn')?.addEventListener('click', () => {
    if (updateApplyBusy) return;
    updateApplyBusy = true;
    const applyBtn = document.getElementById('settingsApplyUpdateBtn');
    const statusEl = document.getElementById('settingsUpdateStatus');

    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = tr('settings.update.applying');
    }

    void (async () => {
      try {
        const res = await callAppTool('app_config_manage', { action: 'apply_update' });
        if (res?.releaseUrl) lastUpdateReleaseUrl = res.releaseUrl;
        if (!res || res.ok === false) {
          const msg = res?.message || res?.error || 'update_failed';
          if (statusEl) {
            statusEl.className = 'mono-num text-error';
            statusEl.textContent = tr('settings.update.applyFailed', { error: msg });
          }
          showToast(tr('settings.update.applyFailed', { error: msg }), 'error');
          return;
        }

        const updatedVer = res.updatedVersion || res.latestVersion || APP_VERSION;
        if (statusEl) {
          statusEl.className = 'mono-num text-success font-medium';
          statusEl.textContent = tr('settings.update.updated', { version: updatedVer });
        }
        if (applyBtn) applyBtn.classList.add('hidden');
        showToast(tr('settings.update.updated', { version: updatedVer }), 'success');
        if (res.requiresRestart) {
          openRestartIdeModal();
        }
      } catch (err) {
        const msg = err?.message || String(err);
        showToast(tr('settings.update.applyFailed', { error: msg }), 'error');
      } finally {
        updateApplyBusy = false;
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = tr('settings.update.applyBtn');
        }
      }
    })();
  });
  document.getElementById('restartIdeConfirmBtn')?.addEventListener('click', () => {
    if (restartIdeBusy) return;
    restartIdeBusy = true;
    const btn = document.getElementById('restartIdeConfirmBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr('monitor.restart.restarting');
    }
    void (async () => {
      try {
        const res = await callAppTool('app_config_manage', { action: 'restart_antigravity' });
        closeModal('restartIdeModal');
        if (res && res.ok === false) {
          showToast(tr('monitor.restart.failed', { error: res.message || res.error || res.status || 'not_found' }), 'error');
        } else {
          showToast(tr('monitor.restart.success'), 'success');
        }
      } catch (err) {
        showToast(tr('monitor.restart.failed', { error: err?.message || String(err) }), 'error');
      } finally {
        restartIdeBusy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = tr('monitor.restart.confirm');
        }
      }
    })();
  });
  document.getElementById('alertBtn').addEventListener('click', () => {
    const acc = document.getElementById('alertsAcc');
    acc.dataset.open = String(acc.dataset.open !== 'true');
  });
  document.getElementById('alertsCloseBtn').addEventListener('click', () => {
    document.getElementById('alertsAcc').dataset.open = 'false';
  });
  document.getElementById('jumpCallsBtn').addEventListener('click', () => switchTab('calls'));
  document.getElementById('openCapsuleFromCtxBtn').addEventListener('click', () => void openCapsuleModal());
  document.getElementById('openCapsuleFromVaultBtn').addEventListener('click', () => void openCapsuleModal());
  document.getElementById('openAddMemBtn').addEventListener('click', () => openModal('addMemModal'));
  document.getElementById('openQuotaCalBtn').addEventListener('click', () => openQuotaCalModal('gemini'));

  document.getElementById('onlyDropBtn').addEventListener('click', () => {
    state.onlyDrop = !state.onlyDrop;
    const btn = document.getElementById('onlyDropBtn');
    const dot = document.getElementById('onlyDropDot');
    btn.style.borderColor = state.onlyDrop ? 'var(--error)' : 'var(--border)';
    btn.style.color = state.onlyDrop ? 'var(--error)' : 'var(--foreground)';
    dot.style.background = state.onlyDrop ? 'var(--error)' : 'var(--border)';
    void loadCalls();
  });

  // Vault search debounce
  let vaultTimer = null;
  document.getElementById('vaultSearch').addEventListener('input', () => {
    clearTimeout(vaultTimer);
    vaultTimer = setTimeout(() => void loadVault(), 180);
  });

  // Asset Inspector Modal actions
  document.getElementById('assetCopyPathBtn')?.addEventListener('click', () => {
    const p = state.inspectedAsset?.filePath;
    if (!p) return;
    if (navigator.clipboard) navigator.clipboard.writeText(p).catch(() => {});
    showToast(tr('monitor.asset.pathCopied'));
  });

  document.getElementById('assetOpenFileBtn')?.addEventListener('click', () => {
    const p = state.inspectedAsset?.filePath;
    if (!p) return;
    void (async () => {
      const fileUrl = 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
      if (mcpApp && typeof mcpApp.openLink === 'function') {
        try {
          await mcpApp.openLink({ url: fileUrl });
          showToast(tr('monitor.asset.openRequested'));
          return;
        } catch {
          // fallback below
        }
      }
      if (navigator.clipboard) navigator.clipboard.writeText(p).catch(() => {});
      showToast(tr('monitor.asset.openFallback'));
    })();
  });

  document.getElementById('assetGoGovBtn')?.addEventListener('click', () => {
    const srvName = state.inspectedAsset?.name || '';
    closeModal('assetInspectorModal');
    switchModule('governance', 'extensions');
    if (srvName) {
      requestAnimationFrame(() => {
        const searchEl = document.getElementById('govExtSearch');
        if (searchEl) {
          searchEl.value = srvName;
          searchEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
  });

  // Capsule 3-tier budget switcher
  document.getElementById('capsuleBudgetNav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cap-budget]');
    if (!btn) return;
    const nextPreset = btn.dataset.capBudget;
    if (!nextPreset || nextPreset === state.capsuleBudgetPreset) return;
    void reloadCapsule({ budgetPreset: nextPreset });
  });

  // Capsule editable goal & nextAction (debounced live recalculation)
  let capsuleEditTimer = null;
  const scheduleCapsuleEdit = () => {
    clearTimeout(capsuleEditTimer);
    capsuleEditTimer = setTimeout(() => {
      void reloadCapsule();
    }, 260);
  };
  document.getElementById('capsuleGoalInput')?.addEventListener('input', scheduleCapsuleEdit);
  document.getElementById('capsuleNextActionInput')?.addEventListener('input', scheduleCapsuleEdit);

  // Capsule decision toggle (recalculates payload & token budget live)
  document.getElementById('capsuleDecisionsList').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cap-dec]');
    if (!cb || !state.capsuleData) return;
    const dec = (state.capsuleData.decisions || []).find((d) => d.id === cb.dataset.capDec);
    if (dec) dec.checked = cb.checked;
    void reloadCapsule();
  });

  // Capsule touched files toggle
  document.getElementById('capsuleFilesList')?.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cap-file]');
    if (!cb || !state.capsuleData) return;
    const item = (state.capsuleData.fileItems || []).find((f) => f.path === cb.dataset.capFile);
    if (item) item.checked = cb.checked;
    void reloadCapsule();
  });

  // Capsule artifacts toggle
  document.getElementById('capsuleArtifactsList')?.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cap-artifact]');
    if (!cb || !state.capsuleData) return;
    const item = (state.capsuleData.artifactItems || []).find((a) => a.path === cb.dataset.capArtifact);
    if (item) item.checked = cb.checked;
    void reloadCapsule();
  });

  const handleCopyCapsule = () => {
    const txt = state.capsuleData?.agentPayload || document.getElementById('capsuleRawPre')?.textContent || '';
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    showToast(tr('toast.capsuleCopied'));
  };
  document.getElementById('copyCapsuleBtn').addEventListener('click', handleCopyCapsule);
  document.getElementById('copyCapsuleFooterBtn')?.addEventListener('click', handleCopyCapsule);

  document.getElementById('saveCapsuleOnlyBtn').addEventListener('click', () => {
    void (async () => {
      if (state.capsuleData) {
        const goalTxt = (document.getElementById('capsuleGoalInput')?.value || state.capsuleData.activeGoal || '').trim();
        await callAppTool('app_vault_manage', {
          action: 'save',
          conversationId: state.activeConversationId || undefined,
          projectDir: state.activeProjectDir || undefined,
          kind: 'checkpoint',
          title: `交接胶囊：${goalTxt.slice(0, 64)}`,
          summary: state.capsuleData.agentPayload,
          tags: ['handoff-capsule'],
        });
        await loadVault();
      }
      closeModal('capsuleModal');
      showToast(tr('toast.capsuleSaved'));
    })();
  });

  document.getElementById('attachCapsuleBtn').addEventListener('click', () => {
    void (async () => {
      if (!state.capsuleData) return;
      const goalTxt = (document.getElementById('capsuleGoalInput')?.value || state.capsuleData.activeGoal || '').trim();
      await callAppTool('app_vault_manage', {
        action: 'save',
        conversationId: state.activeConversationId || undefined,
        projectDir: state.activeProjectDir || undefined,
        kind: 'checkpoint',
        title: `交接胶囊：${goalTxt.slice(0, 64)}`,
        summary: state.capsuleData.agentPayload,
        tags: ['handoff-capsule'],
      });
      if (mcpApp && state.canUpdateModelContext) {
        await mcpApp.updateModelContext({
          content: [{ type: 'text', text: state.capsuleData.agentPayload }],
        });
      }
      await loadVault();
      closeModal('capsuleModal');
      showToast(tr('toast.capsuleAttached'));
    })();
  });

  // Quota calibration submit
  document.getElementById('quotaCalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const g = (state.quotaData?.groups || []).find((x) => x.id === state.calGroup);
      const args = {
        groupId: state.calGroup,
        weeklyPct: Number(document.getElementById('calWeeklyPct').value),
        weeklyHrs: Number(document.getElementById('calWeeklyHrs').value),
      };
      if (g && g.h5Pct !== null) {
        args.h5Pct = Number(document.getElementById('cal5hPct').value);
        args.h5Mins = Number(document.getElementById('cal5hMins').value);
      }
      state.quotaData = await callAppTool('app_calibrate_quota', args);
      closeModal('quotaModal');
      renderQuota();
      showToast(`已校准「${g?.name || state.calGroup}」基线，后续调用自动推演扣减`);
    })();
  });

  // Add memory submit
  document.getElementById('addMemForm').addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const title = document.getElementById('newMemTitle').value.trim();
      const summary = document.getElementById('newMemBody').value.trim();
      if (!title) return;
      await callAppTool('app_vault_manage', {
        action: 'save',
        conversationId: state.activeConversationId || undefined,
        projectDir: state.activeProjectDir || undefined,
        kind: state.newMemKind,
        title,
        summary,
        tags: ['manual'],
      });
      document.getElementById('newMemTitle').value = '';
      document.getElementById('newMemBody').value = '';
      closeModal('addMemModal');
      await loadVault();
      showToast('已脱敏写入 Markdown 真相源并更新 FTS5 索引');
    })();
  });

  // Settings: UI language switcher (instant apply + persist)
  document.querySelectorAll('#uiLangSeg [data-ui-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextLang = normalizeUiLang(btn.dataset.uiLang);
      if (nextLang === getUiLang()) return;
      applyUiLanguage(nextLang);
      void persistConfigPatch({ uiLanguage: nextLang })
        .then(() => {
          showToast(tr('toast.langUpdated'), 'success');
        })
        .catch((err) => {
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });
  });

  // Settings switches & inputs
  document.getElementById('auxAutoSwitch').addEventListener('click', () => {
    const next = !state.config.auxAutoOpen;
    void persistConfigPatch({ auxAutoOpen: next })
      .then(() => {
        showToast(next ? tr('toast.auxAutoOn') : tr('toast.auxAutoOff'));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('startupAutoPopoutSwitch')?.addEventListener('click', () => {
    const next = state.config.popout?.autoLaunchOnStartup === false;
    void persistConfigPatch({ popout: { autoLaunchOnStartup: next } })
      .then(() => {
        showToast(next ? tr('toast.startupPopoutOn') : tr('toast.startupPopoutOff'));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('miniBarPresetRow')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.minibar-preset-btn');
    if (!btn) return;
    const preset = btn.dataset.preset;
    if (!preset) return;
    if (!state.config.popout) state.config.popout = {};
    state.config.popout.miniBarPreset = preset;
    state.config.popout.miniBarCustomWidth = null;
    renderMiniBarStudio();
    if (isNativePopout && state.windowCollapsed) {
      const targetW = MINI_BAR_PRESET_WIDTHS[preset] || MINI_BAR_PRESET_WIDTHS.standard;
      const dpr = window.devicePixelRatio || 1;
      postHostWindowMsg(`setwidth:${Math.ceil(targetW * dpr)}`);
      requestAnimationFrame(fitNativeTitleBar);
    }
    void persistConfigPatch({ popout: { miniBarPreset: preset, miniBarCustomWidth: null } }).catch(() => {});
  });

  document.getElementById('miniBarResetOrderBtn')?.addEventListener('click', () => {
    applyMiniBarOrderWithFlip([...MINI_BAR_DEFAULT_ORDER], null);
  });

  document.getElementById('kvCacheSwitch')?.addEventListener('click', () => {
    const next = state.config.kvCache?.enabled === false;
    void persistConfigPatch({ kvCache: { enabled: next } })
      .then(() => {
        syncKvCountdownUi();
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  const updateKvTtl = (minutes) => {
    const clamped = Math.max(3, Math.min(60, Math.round(Number(minutes) || 15)));
    void persistConfigPatch({ kvCache: { ttlMinutes: clamped } })
      .then(() => {
        syncKvCountdownUi();
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  };

  document.getElementById('kvPresetGroup')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.kv-preset-btn');
    if (!btn) return;
    updateKvTtl(Number(btn.dataset.kvMin));
  });

  document.getElementById('cfgKvTtlInput')?.addEventListener('change', (e) => {
    updateKvTtl(Number(e.target.value));
  });

  const bindHelpPopover = (btnId, popId) => {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popId);
    if (!btn || !pop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = pop.classList.contains('hidden');
      document.querySelectorAll('.kv-help-popover').forEach((p) => p.classList.add('hidden'));
      pop.classList.toggle('hidden', !willOpen);
    });
  };
  bindHelpPopover('kvHelpBtn', 'kvHelpPopover');
  bindHelpPopover('settingsKvHelpBtn', 'settingsKvHelpPopover');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.kv-pill-wrap, .kv-help-inline-wrap')) {
      document.querySelectorAll('.kv-help-popover').forEach((p) => p.classList.add('hidden'));
    }
  });

  document.getElementById('sidebarAutoPopoutSwitch')?.addEventListener('click', () => {
    const next = state.config.popout?.autoLaunchFromSidebar === false;
    void persistConfigPatch({ popout: { autoLaunchFromSidebar: next } })
      .then(() => {
        showToast(next ? tr('toast.sidebarPopoutOn') : tr('toast.sidebarPopoutOff'));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('popoutTopMostSwitch')?.addEventListener('click', () => {
    const next = state.config.popout?.alwaysOnTop === false;
    state.windowPinned = next;
    if (isNativePopout) {
      postHostWindowMsg(next ? 'pin:1' : 'pin:0');
      renderNativePinButton();
    }
    void persistConfigPatch({ popout: { alwaysOnTop: next } })
      .then(() => {
        showToast(next ? tr('toast.pinnedTop') : tr('toast.unpinnedTop'));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('popoutSwitch').addEventListener('click', () => {
    const next = !(state.popoutStatus?.running || state.config.popout?.enabled);
    void (async () => {
      try {
        if (!next) {
          const res = await callAppTool('app_config_manage', { action: 'close_popout' });
          if (res?.config) state.config = res.config;
          if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
          renderSettings();
          showToast(tr('toast.popoutClosed'));
        } else {
          await persistConfigPatch({ popout: { enabled: true } });
          showToast(tr('toast.popoutEnabled'));
        }
      } catch (err) {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      }
    })();
  });

  document.getElementById('launchPopoutBtn').addEventListener('click', () => {
    void handleOpenPopout(false);
  });

  document.getElementById('bannerSwitch').addEventListener('click', () => {
    const next = !state.config.uiBanner?.enabled;
    void persistConfigPatch({ uiBanner: { enabled: next } })
      .then(() => {
        showToast(next ? tr('toast.bannerOn') : tr('toast.bannerOff'));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('cfgBudgetInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ sessionStartBudgetTokens: val })
      .then(() => {
        showToast(tr('toast.budgetUpdated', { tokens: state.config.sessionStartBudgetTokens }));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('cfgWarnPctInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ alerts: { contextWarningPct: val } })
      .then(() => {
        renderContext(false);
        showToast(tr('toast.warnPctUpdated', { pct: state.config.alerts.contextWarningPct }));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('cfgDropPctInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ alerts: { cacheDropThresholdPct: val } })
      .then(() => {
        showToast(tr('toast.dropPctUpdated', { pct: state.config.alerts.cacheDropThresholdPct }));
      })
      .catch((err) => {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  });

  document.getElementById('settingsResetDefaultsBtn')?.addEventListener('click', () => {
    void (async () => {
      try {
        await persistConfigPatch({
          uiLanguage: DEFAULT_UI_LANG,
          pollIntervalSec: 5,
          auxAutoOpen: true,
          uiBanner: { enabled: true },
          sessionStartBudgetTokens: 450,
          alerts: { contextWarningPct: 75, cacheDropThresholdPct: 50 },
          kvCache: { enabled: true, ttlMinutes: 15 },
          popout: {
            autoLaunchOnStartup: true,
            autoLaunchFromSidebar: true,
            alwaysOnTop: true,
            size: '460x720',
            miniBarPreset: 'standard',
            miniBarModules: [...MINI_BAR_DEFAULT_ORDER],
            miniBarCustomWidth: null,
          },
        });
        applyUiLanguage(state.config?.uiLanguage || DEFAULT_UI_LANG);
        restartPollTimer();
        renderContext(false);
        showToast(tr('toast.configReset'), 'success');
      } catch (err) {
        renderSettings();
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      }
    })();
  });

  // Doctor actions
  document.getElementById('docRebuildBtn').addEventListener('click', () => {
    void (async () => {
      try {
        const res = await callAppTool('app_doctor_action', { action: 'rebuild_index' });
        state.doctorReport = res.report;
        renderSettings();
        showToast(tr('toast.indexRebuilt', { ms: res.rebuild?.elapsedMs ?? 0 }), 'success');
      } catch (err) {
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      }
    })();
  });

  document.getElementById('docExportBtn').addEventListener('click', () => {
    void (async () => {
      try {
        const res = await callAppTool('app_doctor_action', { action: 'export_backup' });
        state.doctorReport = res.report;
        renderSettings();
        showToast(tr('toast.backupExported', { path: res.exported?.displayPath || '.context-cache/exports/' }), 'success');
      } catch (err) {
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      }
    })();
  });

  document.getElementById('docRunBtn').addEventListener('click', () => {
    void (async () => {
      try {
        const res = await callAppTool('app_doctor_action', { action: 'diagnose' });
        state.doctorReport = res.report;
        renderSettings();
        showToast(
          res.report?.healthy
            ? tr('toast.doctorHealthy')
            : tr('toast.doctorIssues', { count: res.report?.issues?.length || 1 }),
          res.report?.healthy ? 'success' : 'info'
        );
      } catch (err) {
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      }
    })();
  });
}

// ==================== Bootstrap ====================
async function init() {
  applyFeatureFlags();
  i18nModule = createI18nModule({
    callAppTool,
    esc,
    showToast,
    openModal,
    closeModal,
    positionIndicator,
    renderCustomSelect,
    onStatusChange: handleI18nStatusChange,
    onOpenSettings: toggleSettingsView,
  });
  i18nModule.init();
  governanceModule = createGovernanceModule({
    callAppTool,
    esc,
    showToast,
    positionIndicator,
    onOpenSettings: toggleSettingsView,
    getProjectDir: () => state.activeProjectDir || state.contextData?.projectDir || undefined,
    canSendMessage: () => Boolean(mcpApp && state.canSendMessage),
    sendToAgent: async (text) => {
      const payload = String(text || '').trim();
      if (!payload) throw new Error('提示词不能为空');
      if (mcpApp && state.canSendMessage && typeof mcpApp.sendMessage === 'function') {
        await mcpApp.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: payload }],
        });
        return { mode: 'sent' };
      }
      if (mcpApp && state.canUpdateModelContext && typeof mcpApp.updateModelContext === 'function') {
        await mcpApp.updateModelContext({
          content: [{ type: 'text', text: payload }],
        });
        return { mode: 'attached' };
      }
      return { mode: 'unsupported' };
    },
  });
  governanceModule.init();
  appearanceModule = createAppearanceModule({
    callAppTool,
    esc,
    showToast,
    openModal,
    closeModal,
    positionIndicator,
    renderCustomSelect,
    onOpenSettings: toggleSettingsView,
    onGoI18nPatch: () => switchModule('i18n', 'status'),
    popoutToken,
  });
  appearanceModule.init();
  bindEvents();
  applyStaticTranslations(document, getUiLang());
  syncConsoleNavState();
  renderSelects('visible');
  requestAnimationFrame(positionVisibleIndicators);

  let resizeRafId = 0;
  const ro = new ResizeObserver(() => {
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = 0;
      positionVisibleIndicators();
      if (state.openSelectId) clampOpenSelectMenus();
    });
  });
  ro.observe(document.getElementById('consoleWorkspace') || document.getElementById('appShell'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!state.launcherMode) {
        startKvCountdownTimer();
        restartPollTimer();
        if (
          Date.now() - lastRefreshAt >= 2000 &&
          (state.activeModule === 'monitor' || state.windowCollapsed) &&
          !state.inSettings &&
          !shouldPausePolling()
        ) {
          void refreshAll(true, false);
        }
      }
    } else {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      stopKvCountdownTimer();
    }
  });

  window.addEventListener('focus', () => {
    state.windowFocused = true;
    if (!state.launcherMode && document.visibilityState === 'visible') {
      restartPollTimer();
      if (
        state.surface === 'aux_pane' &&
        Date.now() - lastRefreshAt >= 2000 &&
        state.activeModule === 'monitor' &&
        !state.inSettings
      ) {
        void refreshAll(true, false);
      }
    }
  });

  window.addEventListener('blur', () => {
    state.windowFocused = false;
    if (state.surface === 'aux_pane' && isPopoutOpen(state.popoutStatus)) {
      restartPollTimer();
    }
  });

  if (!popoutToken) {
    mcpApp = new App({ name: 'Antigravity Hub', version: APP_VERSION }, {});

    // Register handlers BEFORE connect() per Antigravity mcp-app-development guidelines
    mcpApp.ontoolinput = ({ arguments: args }) => {
      if (args?.conversationId) {
        state.activeConversationId = args.conversationId;
        resetSessionViewState();
      }
      if (args?.module === 'i18n') {
        switchModule('i18n', args?.i18nTab || null);
      } else if (args?.module === 'governance') {
        switchModule('governance', args?.govTab || null);
      } else if (args?.module === 'appearance') {
        switchModule('appearance', args?.appTab || null);
      } else if (args?.tab && ['context', 'calls', 'quota', 'vault'].includes(args.tab)) {
        switchTab(args.tab);
      } else if (args?.tab === 'settings') {
        toggleSettingsView();
      }
    };

    mcpApp.ontoolresult = (result) => {
      const sc = result?.structuredContent;
      if (!sc) return;
      const prevLang = getUiLang();
      if (sc.config) state.config = sc.config;
      if (sc.popoutStatus) state.popoutStatus = sc.popoutStatus;
      if (getUiLang() !== prevLang) {
        applyUiLanguage(getUiLang());
      }
      if (sc.context) {
        const changed = Boolean(
          state.activeConversationId &&
            sc.context.conversationId &&
            state.activeConversationId !== sc.context.conversationId
        );
        if (changed) resetSessionViewState();
        state.contextData = sc.context;
        state.activeConversationId = sc.context.conversationId || state.activeConversationId;
        state.activeProjectDir = sc.context.projectDir || state.activeProjectDir;
        renderSelects();
        renderContext(false);
        if (state.launcherMode) renderLauncherView();
      }
      if (sc.initialModule === 'i18n') {
        switchModule('i18n', sc.initialI18nTab || null);
      } else if (sc.initialModule === 'governance') {
        switchModule('governance', sc.initialGovTab || null);
      } else if (sc.initialModule === 'appearance') {
        switchModule('appearance', sc.initialAppTab || null);
      } else if (sc.initialTab && ['context', 'calls', 'quota', 'vault'].includes(sc.initialTab)) {
        switchTab(sc.initialTab);
      } else if (sc.initialTab === 'settings') {
        toggleSettingsView();
      }
    };

    mcpApp.onhostcontextchanged = (ctx) => {
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      // Forward-compatible: if Antigravity exposes focused conversationId in hostContext, follow immediately
      const hostConvId = ctx?.conversationId || ctx?.sessionId;
      if (hostConvId && state.followMode === 'auto' && hostConvId !== state.activeConversationId) {
        state.activeConversationId = String(hostConvId);
        resetSessionViewState();
        void callAppTool('app_config_manage', { action: 'set_active_session', conversationId: state.activeConversationId }).catch(() => {});
        void refreshAll(true, false);
      }
    };

    try {
      await mcpApp.connect();
      const hostCtx = mcpApp.getHostContext();
      if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
      if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);

      const caps = mcpApp.getHostCapabilities();
      state.canUpdateModelContext = Boolean(caps?.updateModelContext);
      state.canSendMessage = Boolean(caps?.message);
      // Distinguish left sidebar global entrypoint (no conversation capabilities) vs right aux_pane
      state.surface = caps?.updateModelContext || caps?.message ? 'aux_pane' : 'global';

      const initHostConvId = hostCtx?.conversationId || hostCtx?.sessionId;
      if (initHostConvId && state.followMode === 'auto') {
        state.activeConversationId = String(initHostConvId);
      }
    } catch (err) {
      const attr = document.getElementById('ctxAttribution');
      if (attr) attr.textContent = `宿主连接失败：${err.message}`;
      showToast(`宿主连接异常：${err.message}`);
    }
  } else {
    // Standalone popout window: native frameless OS floating window with TopMost pin, drag/resize & bounds memory
    state.surface = 'popout';
    state.canUpdateModelContext = false;
    state.canSendMessage = false;
    if (initialThemeParam === 'dark' || initialThemeParam === 'light') {
      applyDocumentTheme(initialThemeParam);
      postHostWindowMsg(`theme:${initialThemeParam}`);
    }
    document.getElementById('quickPopoutBtn')?.classList.add('hidden');
    document.getElementById('topBarPopoutBtn')?.classList.add('hidden');
    setupNativeFramelessChrome();
    startPopoutClientLifecycle();
  }

  // First-paint RPC #1: config & popout status only (doctor is lazy-loaded in Settings)
  await loadConfigOnly().catch(() => {});

  // Left sidebar (global) auto-launches floating OS window when enabled and NOT explicitly closed by user
  const shouldAutoLaunchSidebarPopout =
    state.surface === 'global' &&
    state.config.popout?.autoLaunchFromSidebar !== false &&
    !state.popoutStatus?.userClosed &&
    !state.userClosedPopoutSession;

  if (shouldAutoLaunchSidebarPopout) {
    try {
      const res = await callAppTool('app_config_manage', {
        action: 'open_popout',
        forceNew: false,
        theme: detectCurrentTheme(),
      });
      if (res?.config) state.config = res.config;
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      if (res?.popoutStatus?.launched && isPopoutOpen(res.popoutStatus) && !res.popoutStatus.userClosed) {
        // Fetch once so launcher card displays current followed conversation name
        await loadContext(false).catch(() => {});
        enterGlobalLauncherMode(res.popoutStatus);
        return;
      }
      if (!res?.popoutStatus?.userClosed) {
        showToast('未检测到 Edge/Chrome，已切换为当前页内展示');
      }
    } catch {
      // Fall back cleanly to embedded view if popout launch fails
    }
  }

  // First-paint RPC #2: context breakdown only (calls & vault lazy-load on tab switch)
  await refreshAll(false, false, true);
  restartPollTimer();
  startKvCountdownTimer();
  scheduleIdleModuleChecks();
  requestAnimationFrame(positionVisibleIndicators);
}

void init();
