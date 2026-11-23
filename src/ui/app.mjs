import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { createI18nModule } from './modules/i18n-module.mjs';

// Code-level feature flags (all quota UI/backend code is preserved intact when hidden)
const FEATURE_FLAGS = {
  showQuotaUi: false,
};

const POLL_OPTIONS = [
  { value: '3', label: '3 秒（高频）', short: '3s' },
  { value: '5', label: '5 秒（推荐）', short: '5s' },
  { value: '10', label: '10 秒', short: '10s' },
  { value: '30', label: '30 秒', short: '30s' },
  { value: '60', label: '60 秒（省电）', short: '60s' },
  { value: '0', label: '手动刷新（暂停）', short: '手动' },
];

const POPOUT_SIZES = [
  { value: '420x680', label: '420 × 680（紧凑竖窗）' },
  { value: '460x720', label: '460 × 720（标准侧栏）' },
  { value: '880x640', label: '880 × 640（宽屏浮窗）' },
];

const state = {
  surface: 'aux_pane', // 'aux_pane' | 'global' | 'popout'
  followMode: 'auto',  // 'auto' | 'pinned'
  pinnedConversationId: null,
  activeConversationId: null,
  activeProjectDir: null,
  launcherMode: false,
  popoutStatus: { running: false, port: null, activeClients: 0 },
  activeModule: 'monitor', // 'monitor' | 'i18n'
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
  inSettings: false,
  openSelectId: null,
  openAccIdx: 0,
  canUpdateModelContext: false,
  contextData: null,
  callsData: null,
  quotaData: null,
  vaultData: null,
  capsuleData: null,
  config: {
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
let toastTimer = null;
let refreshInFlight = false;
let refreshSeq = 0;
let lastSavedBoundsKey = '';

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
    .replace(/"/g, '&quot;');
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
  if (!iso) return '刚刚';
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
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
  void el.offsetWidth;
  el.classList.add('kpi-bump');
}

function positionIndicator(navId, indId) {
  const nav = document.getElementById(navId);
  const ind = document.getElementById(indId);
  if (!nav || !ind) return;
  const active = nav.querySelector('[data-active="true"]');
  if (!active) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
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
function renderCustomSelect(hostId, { id, value, options, alignRight = false, fullWidth = false, triggerLabel = null }) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const opts = options.length ? options : [{ value: '', label: '暂无数据' }];
  const current = opts.find((o) => o.value === value) || opts[0];
  const isOpen = state.openSelectId === id;
  const shownLabel = triggerLabel ?? current.label;

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

function renderPollSelect() {
  const host = document.getElementById('pollIntervalHost');
  if (!host) return;
  const val = String(state.config.pollIntervalSec ?? 5);
  const cur = POLL_OPTIONS.find((o) => o.value === val) || POLL_OPTIONS[1];
  const isOpen = state.openSelectId === 'pollInterval';
  const isLive = Number(val) > 0;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger pill-trigger" aria-expanded="${isOpen}" data-select-toggle="pollInterval" title="切换定时检测周期">
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
      ${POLL_OPTIONS.map(
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
  btn.dataset.mode = isAuto ? 'auto' : 'pinned';
  btn.title = isAuto
    ? '自动跟随当前活跃对话（点击锁定本窗口）'
    : '已锁定当前对话（点击恢复自动跟随）';
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

function renderSessionSelect() {
  const host = document.getElementById('sessionSelectHost');
  if (!host) return;
  const sessions = state.contextData?.sessions || [];
  const isAggregate = state.pinnedConversationId === '__active_all__' || state.activeConversationId === '__active_all__';
  const isAuto = !isAggregate && state.followMode === 'auto';
  const activeId = isAggregate ? '__active_all__' : isAuto ? state.activeConversationId : state.pinnedConversationId || state.activeConversationId;
  const matched = sessions.find((s) => s.id === activeId) || sessions[0] || null;
  const isOpen = state.openSelectId === 'sessionSelect';
  const activeCount = sessions.filter((s) => s.isActive).length;
  const titleText = isAggregate
    ? `当前运行汇总${activeCount ? ` (${activeCount} 活跃)` : ' (主+子)'}`
    : matched
      ? (matched.isSubagent && matched.subTag ? `${matched.subTag} · ${matched.label}` : matched.label)
      : '等待会话记录';

  const modeChipHtml = isAggregate
    ? `<span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>汇总</span></span>`
    : isAuto
      ? `<span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>自动</span></span>`
      : `<span class="session-mode-chip" data-mode="pinned"><span>锁定</span></span>`;

  const checkSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0"><path d="M3.5 8.5L6.5 11.5L12.5 4.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const sessionsHtml = sessions.length
    ? sessions
        .map((s) => {
          const isCur = !isAggregate && s.id === (matched?.id || activeId);
          return `
        <button type="button" class="agy-select-opt" data-selected="${isCur}" data-select-pick="sessionSelect" data-select-val="${esc(s.id)}">
          <span class="flex items-center gap-1.5 min-w-0">
            ${s.isActive ? `<span class="session-live-dot" title="近期运行中"></span>` : ''}
            ${s.isSubagent ? `<span class="session-sub-pill">${esc(s.subTag || '子')}</span>` : ''}
            <span class="truncate">${esc(s.label)}</span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            ${s.stepCount ? `<span class="session-opt-meta mono-num">${s.stepCount}步</span>` : ''}
            ${isCur ? checkSvg : ''}
          </span>
        </button>`;
        })
        .join('')
    : `<div class="px-2.5 py-2 text-xs text-muted">当前工作区暂无会话记录</div>`;

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
          <span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>自动</span></span>
          <span class="truncate">跟随当前选中 / 活跃对话</span>
        </span>
        ${isAuto ? checkSvg : ''}
      </button>
      <button type="button" class="agy-select-opt" data-selected="${isAggregate}" data-select-pick="sessionSelect" data-select-val="__active_all__">
        <span class="flex items-center gap-2 min-w-0">
          <span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>汇总</span></span>
          <span class="truncate">当前运行中的全部对话 (主+子)</span>
        </span>
        ${isAggregate ? checkSvg : ''}
      </button>
      <div class="session-menu-divider"></div>
      <div class="session-menu-caption">对话与子代理列表（点击切换所有视图）</div>
      ${sessionsHtml}
    </div>
  `;
}

function renderSelects() {
  renderPollSelect();
  renderFollowToggle();
  renderSessionSelect();

  renderCustomSelect('agentSelectHost', {
    id: 'agentSelect',
    value: state.agentFilter,
    options: [
      { value: 'all', label: '全部 Agent (主+子)' },
      { value: 'main', label: '仅主 Agent' },
      { value: 'sub', label: '仅子 Agent' },
    ],
  });

  const models = state.callsData?.models || [];
  renderCustomSelect('modelSelectHost', {
    id: 'modelSelect',
    value: state.modelFilter,
    options: [{ value: 'all', label: '全部模型' }, ...models.map((m) => ({ value: m, label: m }))],
    alignRight: true,
  });

  renderCustomSelect('vaultKindSelectHost', {
    id: 'vaultKindSelect',
    value: state.vaultKind,
    options: [
      { value: 'all', label: '全部类型' },
      { value: 'working_state', label: 'working_state' },
      { value: 'decision', label: 'decision' },
      { value: 'architecture', label: 'architecture' },
      { value: 'pitfall', label: 'pitfall' },
      { value: 'checkpoint', label: 'checkpoint' },
    ],
    alignRight: true,
  });

  if (FEATURE_FLAGS.showQuotaUi) {
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
    });
  }

  renderCustomSelect('newMemKindSelectHost', {
    id: 'newMemKindSelect',
    value: state.newMemKind,
    options: [
      { value: 'decision', label: 'decision（设计决策）' },
      { value: 'working_state', label: 'working_state（当前状态）' },
      { value: 'architecture', label: 'architecture（架构地图）' },
      { value: 'pitfall', label: 'pitfall（踩坑与禁忌）' },
    ],
    fullWidth: true,
  });

  renderCustomSelect('settingsPollHost', {
    id: 'settingsPoll',
    value: String(state.config.pollIntervalSec ?? 5),
    options: POLL_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    alignRight: true,
  });

  renderCustomSelect('popoutSizeSelectHost', {
    id: 'popoutSize',
    value: state.config.popout?.size || '460x720',
    options: POPOUT_SIZES,
  });

  i18nModule?.renderSelects();
  clampOpenSelectMenus();
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
      showToast('已开启自动跟随当前选中 / 活跃对话');
      return;
    }

    if (val === '__active_all__') {
      state.followMode = 'pinned';
      state.pinnedConversationId = '__active_all__';
      state.activeConversationId = '__active_all__';
      resetSessionViewState();
      renderSelects();
      await refreshAll(true, false, true);
      showToast('已切换至「当前运行中的全部对话」汇总视图');
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
    showToast('已同步切换所有监控视图至所选对话');
    return;
  }
  if (id === 'pollInterval' || id === 'settingsPoll') {
    const sec = Number(val);
    state.config.pollIntervalSec = sec;
    renderSelects();
    restartPollTimer();
    await persistConfigPatch({ pollIntervalSec: sec });
    const opt = POLL_OPTIONS.find((o) => o.value === val);
    showToast(sec > 0 ? `已切换自动检测周期：每 ${opt?.short || sec + 's'}` : '已切换为手动刷新');
    return;
  }
  if (id === 'popoutSize') {
    state.config.popout = { ...(state.config.popout || {}), size: val };
    renderSelects();
    await persistConfigPatch({ popout: { size: val } });
    showToast(`独立小窗默认尺寸已设为 ${val}`);
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
}

// ==================== Rendering ====================
function fitNativeTitleBar() {
  const titleBar = document.getElementById('nativeTitleBar');
  const dragZone = document.getElementById('titleBarDragZone');
  if (!titleBar || !dragZone || titleBar.classList.contains('hidden')) return;

  const nameEl = dragZone.querySelector('.native-titlebar-name');
  const tpsEl = document.getElementById('titleBarTpsBadge');
  const modelEl = document.getElementById('titleBarModelBadge');
  const hasModel = Boolean(modelEl && modelEl.dataset.fullModel && !modelEl.classList.contains('hidden'));
  const hasTps = Boolean(tpsEl && !tpsEl.classList.contains('hidden'));
  const collapsed = state.windowCollapsed;

  nameEl?.classList.remove('titlebar-fit-hidden');
  tpsEl?.classList.remove('titlebar-fit-hidden');
  modelEl?.classList.remove('titlebar-fit-hidden');
  if (hasModel) modelEl.textContent = modelEl.dataset.fullModel;

  const overflows = () => dragZone.scrollWidth > dragZone.clientWidth + 1;
  if (!overflows()) return;

  if (collapsed) {
    // 1. Hide brand text first (keep icon) so live metrics take priority
    nameEl?.classList.add('titlebar-fit-hidden');
    if (!overflows()) return;

    // 2. Switch model badge to concise short name (e.g. 4-neon-M)
    if (hasModel && modelEl.dataset.shortModel) {
      modelEl.textContent = modelEl.dataset.shortModel;
      if (!overflows()) return;
    }

    // 3. Hide model badge cleanly rather than clipping to a fragment
    if (hasModel) {
      modelEl.classList.add('titlebar-fit-hidden');
      if (!overflows()) return;
    }

    // 4. Finally hide TPS on extremely narrow widths
    if (hasTps) {
      tpsEl.classList.add('titlebar-fit-hidden');
    }
    return;
  }

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

function updateNativeTitleBarTelemetry(ctx, pct, cache, tps) {
  const isAggregate =
    state.pinnedConversationId === '__active_all__' ||
    state.activeConversationId === '__active_all__' ||
    ctx?.conversationId === '__active_all__';
  const followTag = isAggregate ? '运行汇总' : state.followMode === 'auto' ? '自动跟随' : '已锁定';

  const miniEl = document.getElementById('titleBarMiniSummary');
  if (miniEl) {
    miniEl.textContent = `${pct.toFixed(1)}% · ${cache.toFixed(0)}% Cache`;
    miniEl.title = `上下文占用 ${pct.toFixed(1)}% · 最新缓存命中 ${cache.toFixed(1)}%（${followTag}）`;
  }

  const modelEl = document.getElementById('titleBarModelBadge');
  if (modelEl) {
    const activeModel = String(ctx?.latestModel || ((Number(ctx?.totalCallsCount) || 0) > 0 ? ctx?.model : '') || '').trim();
    if (activeModel) {
      modelEl.dataset.fullModel = activeModel;
      modelEl.dataset.shortModel = formatShortModel(activeModel);
      modelEl.textContent = activeModel;
      modelEl.title = `当前对话模型：${activeModel}（${followTag}）`;
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
    const hasCalls = (Number(ctx?.totalCallsCount) || 0) > 0;
    if (hasCalls || tps > 0) {
      tpsEl.textContent = `${tps.toFixed(1)} tok/s`;
      tpsEl.dataset.tone = tps < 15 ? 'warn' : 'ok';
      tpsEl.title = `当前对话有效输出速度：${tps.toFixed(1)} tok/s（${followTag}）`;
    } else {
      tpsEl.textContent = '-- tok/s';
      tpsEl.dataset.tone = 'muted';
      tpsEl.title = `等待当前对话输出数据（${followTag}）`;
    }
    tpsEl.classList.remove('hidden');
  }

  requestAnimationFrame(fitNativeTitleBar);
}

function renderContext(animated = false) {
  const ctx = state.contextData;
  if (!ctx) return;

  document.getElementById('gitBranchLabel').textContent = ctx.git?.branch || 'nogit';
  document.getElementById('gitHeadLabel').textContent = `@${ctx.git?.head || 'none'}${ctx.git?.dirty ? '*' : ''}`;
  document.getElementById('tabCallsCount').textContent = String(ctx.totalCallsCount ?? 0);

  const alerts = ctx.alerts || [];
  document.getElementById('alertCountLabel').textContent = `${alerts.length} 项预警`;
  const alertDot = document.getElementById('alertDot');
  alertDot.style.background = alerts.some((a) => a.level === 'error')
    ? 'var(--error)'
    : alerts.length > 0
      ? 'var(--warning)'
      : 'var(--success)';

  const alertsList = document.getElementById('alertsList');
  if (!alerts.length) {
    alertsList.innerHTML = `<div class="py-2 text-xs text-muted">当前无异常预警</div>`;
  } else {
    alertsList.innerHTML = alerts
      .map(
        (a) => `
      <div class="py-2 flex items-start gap-2.5 text-xs">
        <span class="dot-sm mt-1.5" style="background: var(--${a.level === 'error' ? 'error' : 'warning'})"></span>
        <div class="space-y-0.5">
          <div class="font-medium text-fg">${esc(a.title)}</div>
          <div class="text-muted">${esc(a.detail)}</div>
        </div>
      </div>
    `
      )
      .join('');
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

  if (animated) {
    animateNumber(pctEl, prevDisplay.pct, pct, (v) => `${v.toFixed(1)}%`, 520);
    animateNumber(ratioEl, prevDisplay.used, used, (v) => `${fmtK(Math.round(v))} / ${fmtK(limit)}`, 520);
    animateNumber(cacheEl, prevDisplay.cache, cache, (v) => `${v.toFixed(1)}%`, 500);
    animateNumber(tpsEl, prevDisplay.tps, tps, (v) => `${v.toFixed(1)} tok/s`, 500);
    animateNumber(freeEl, prevDisplay.free, free, (v) => fmtK(Math.round(v)), 520);
    animateNumber(costEl, prevDisplay.cost, cost, (v) => `$${v.toFixed(3)}`, 500);
    [pctEl, cacheEl, tpsEl].forEach(pulseEl);
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
  prevDisplay.cache = cache;
  prevDisplay.tps = tps;
  prevDisplay.free = free;
  prevDisplay.cost = cost;

  updateNativeTitleBarTelemetry(ctx, pct, cache, tps);

  document.getElementById('ctxAttribution').textContent = ctx.attribution || '';

  // In-place DOM patch for multi-segment bar (guaranteed CSS width transition)
  const breakdown = ctx.breakdown || [];
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
        return `<div class="ctx-seg" data-id="${esc(b.id)}" style="width:${w}%; background:${b.color};"></div>`;
      })
      .join('');
  }

  document.getElementById('ctxBreakdownList').innerHTML =
    breakdown
      .map((b) => {
        const bp = limit > 0 ? ((b.tokens / limit) * 100).toFixed(1) : '0.0';
        return `
      <div class="ctx-row flex items-center justify-between gap-2 text-xs" data-id="${esc(b.id)}">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="dot-md" style="background:${b.color};"></span>
          <span class="font-medium text-fg truncate">${esc(b.key)}</span>
          <span class="hide-narrow text-muted truncate">${esc(b.note)}</span>
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
        <span class="text-muted">Free space</span>
      </div>
      <div class="flex items-center gap-3.5 mono-num text-muted">
        <span>${fmtK(free)}</span>
        <span style="width: 48px;" class="text-right">${Math.max(0, 100 - pct).toFixed(1)}%</span>
      </div>
    </div>`;

  const deferred = ctx.deferred || [];
  document.getElementById('ctxDeferredList').innerHTML = deferred
    .map(
      (d) => `
    <div class="flex items-center justify-between text-xs text-muted py-0.5">
      <span>${esc(d.key)} <span class="mono-num">(${esc(d.count)})</span></span>
      <span class="mono-num">${fmtK(d.tokens)} · 未加载</span>
    </div>`
    )
    .join('');

  const inventories = ctx.inventories || [];
  document.getElementById('inventoryList').innerHTML = inventories
    .map((inv, idx) => {
      const open = idx === state.openAccIdx;
      const itemsHtml = inv.items?.length
        ? inv.items
            .map(
              (it) => `
          <div class="agy-subtle px-3 py-2 flex items-center justify-between gap-2 text-xs">
            <div class="min-w-0">
              <div class="mono-num font-medium truncate">${esc(it.name)}</div>
              <div class="text-muted">${esc(it.meta)}</div>
            </div>
            <span class="mono-num shrink-0 text-muted font-medium">${esc(it.size)}</span>
          </div>`
            )
            .join('')
        : `<div class="text-xs text-muted py-1">暂无条目</div>`;
      return `
      <div>
        <button type="button" class="acc-trigger" data-acc-idx="${idx}" data-open="${open}">
          <span class="flex items-center gap-2">
            <svg class="acc-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M6 3.5L10.5 8L6 12.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>${esc(inv.title)}</span>
          </span>
          <span class="mono-num text-muted">${esc(inv.count)}</span>
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

function highlightCtx(id) {
  const ctx = state.contextData;
  const item = id && ctx ? (ctx.breakdown || []).find((b) => b.id === id) : null;
  const hint = document.getElementById('ctxHoverHint');
  if (item && ctx.limitTokens > 0) {
    const bp = ((item.tokens / ctx.limitTokens) * 100).toFixed(1);
    hint.textContent = `${item.key} · ${fmtK(item.tokens)} (${bp}%)`;
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
  const tbody = document.getElementById('callsTbody');

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-xs text-muted">当前筛选条件下无匹配调用记录</td></tr>`;
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
        const sourceText = c.sourceLabel || `${c.agentTag} · ${String(c.conversationId || '').slice(0, 8)}`;

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
            <span class="cell-inline-dur">${durText} ·</span>
            <span>${fmtK(c.contextTokens)}</span>
            <span class="text-muted"> / ${fmtK(c.thinkingTokensEst)} / ${fmtK(c.contentTokensEst)}</span>
          </td>
          <td class="cell-cache text-right whitespace-nowrap mono-num ${cacheCls}">
            <span class="cache-cell-wrap">
              <span>${c.cacheHitRate.toFixed(1)}%</span>
              ${c.cacheDrop ? `<span class="cache-drop-pill">击穿</span>` : ''}
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
                  <span class="font-semibold text-fg">单步解剖 · ${esc(c.agentTag)} #${c.stepIndex}</span>
                  <span class="text-muted">模型: <span class="text-fg font-medium">${esc(c.model)}</span></span>
                  <span class="text-muted">计时来源: ${esc(c.timingSource)}</span>
                </div>
                <span class="mono-num text-muted">思考占比 ${thinkRatio}%</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span class="text-muted">信息来源：<span class="text-fg font-medium">${esc(sourceText)}</span></span>
                <span class="mono-num text-muted">缓存命中 ${fmtK(c.cacheReadTokens)} · 新编码 ${fmtK(c.inputTokens)} · 输出 ${fmtK(c.outputTokens)}</span>
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
                  <div class="font-semibold text-error">缓存击穿归因：<span class="mono-num">${esc(c.dropReason)}</span></div>
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
    heroSteps.textContent = list.length !== totalAll ? `${list.length} / ${totalAll} 步` : `${list.length} 步`;
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
    heroModel.textContent = latestModel ? `模型: ${latestModel}` : '';
    heroModel.title = latestModel;
    heroModel.classList.toggle('hidden', !latestModel);
  }
  document.getElementById('callsFooterStats').textContent = `共 ${list.length} 步 · 加权均速 ${avgTps.toFixed(1)} tok/s · 估算 $${totalCost.toFixed(3)}`;

  const byAgent = data?.summary?.byAgent || [];
  document.getElementById('summaryAgentList').innerHTML = byAgent.length
    ? byAgent
        .map(
          (a) => `
      <div class="px-5 py-3 flex items-center justify-between text-xs">
        <div><span class="font-semibold">${esc(a.agentTag)} Agent</span><span class="ml-2 text-muted mono-num">${a.steps} 步</span></div>
        <div class="mono-num flex items-center gap-4">
          <span>${a.avgTps.toFixed(1)} tok/s</span>
          <span class="text-success">${a.avgCache.toFixed(1)}%</span>
          <span class="font-semibold">$${a.cost.toFixed(3)}</span>
        </div>
      </div>`
        )
        .join('')
    : `<div class="px-5 py-4 text-xs text-muted">暂无汇总数据</div>`;

  const byModel = data?.summary?.byModel || [];
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
    : `<div class="px-5 py-4 text-xs text-muted">暂无汇总数据</div>`;
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
              <div id="q-w-sub-${esc(g.id)}" class="text-xs text-muted mt-0.5">${fmtHrs(g.weeklyHrs)} · 本地 7d 实测 ${esc(g.localTokens7d)}</div>
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
              <div id="q-h-sub-${esc(g.id)}" class="text-xs text-muted mt-0.5">当前 5h 窗口本地实测 ${g.localCalls5h} 次调用 · ${Math.floor(g.h5Mins / 60)}h ${g.h5Mins % 60}m 窗口</div>
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
      if (ws) ws.textContent = `${fmtHrs(g.weeklyHrs)} · 本地 7d 实测 ${g.localTokens7d}`;
      patchRing(`w-${g.id}`, g.weeklyPct);
      if (g.h5Pct !== null) {
        const hp = document.getElementById(`q-h-pct-${g.id}`);
        const hs = document.getElementById(`q-h-sub-${g.id}`);
        if (hp) hp.textContent = `${g.h5Pct}%`;
        if (hs) hs.textContent = `当前 5h 窗口本地实测 ${g.localCalls5h} 次调用 · ${Math.floor(g.h5Mins / 60)}h ${g.h5Mins % 60}m 窗口`;
        patchRing(`h-${g.id}`, g.h5Pct);
      }
    });
  }

  const sav = q.savings7d || { savedUsd: 0, avgCacheHitPct: 0 };
  document.getElementById('quotaSavingsLabel').textContent = `缓存累计节省约 $${sav.savedUsd.toFixed(2)} · 命中均值 ${sav.avgCacheHitPct.toFixed(1)}%`;

  const chart = q.weeklyChart || [];
  document.getElementById('weeklyChart').innerHTML = chart
    .map((w) => {
      const cachePct = w.total > 0 ? Math.round((w.cached / w.total) * 100) : 0;
      const freshPct = Math.max(0, 100 - cachePct);
      return `
      <div class="chart-col" title="${esc(w.day)} · ${w.calls} 次调用 · ${fmtK(w.totalTokens)} tokens">
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
  document.getElementById('vaultPathLabel').textContent = v.storagePath || '%USERPROFILE%\\.context-cache';
  const staleBadge = document.getElementById('vaultStaleBadge');
  if (v.commitsAhead > 0) {
    staleBadge.textContent = `HEAD 前进 +${v.commitsAhead} commits`;
    staleBadge.classList.remove('hidden');
  } else if (v.staleCount > 0) {
    staleBadge.textContent = `${v.staleCount} 条基于旧 HEAD`;
    staleBadge.classList.remove('hidden');
  } else {
    staleBadge.classList.add('hidden');
  }

  const items = v.items || [];
  const el = document.getElementById('vaultList');
  if (!items.length) {
    el.innerHTML = `<div class="py-8 text-center text-xs text-muted">暂无匹配记忆条目，点击右上角「+ 新增记忆」或等待 Stop 自动快照</div>`;
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
          <span>·</span>
          <span>${fmtRelativeTime(it.updatedAt)}</span>
          ${(it.tags || []).map((t) => `<span>#${esc(t)}</span>`).join('')}
        </div>
      </div>
      <button type="button" data-archive-mem="${esc(it.id)}" class="text-xs text-muted bg-transparent border-0 cursor-pointer shrink-0 pt-0.5">归档</button>
    </div>`
    )
    .join('');
}

function resetSessionViewState() {
  state.expandedCallId = null;
  state.knownCallIds.clear();
  state.freshCallId = null;
  state.modelFilter = 'all';
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
  const running = Boolean(state.popoutStatus?.running);
  const port = state.popoutStatus?.port;
  const dot = document.getElementById('launcherStatusDot');
  const title = document.getElementById('launcherTitle');
  const sub = document.getElementById('launcherSubMeta');
  const badge = document.getElementById('launcherPortBadge');
  const sessEl = document.getElementById('launcherSessionLabel');

  if (dot) dot.classList.toggle('hidden', !running);
  if (title) title.textContent = running ? '独立悬浮监控窗已启动' : '独立悬浮监控窗已关闭';
  if (sub) {
    sub.textContent = running && port
      ? `127.0.0.1:${port} · 本地一次性令牌 · 自动跟随活跃对话`
      : '已自动释放本地端口，点击下方按钮可随时再次弹出';
  }
  if (badge) {
    badge.textContent = running ? '运行中' : '已关闭';
    badge.style.color = running ? 'var(--success)' : 'var(--muted-foreground)';
    badge.style.borderColor = running ? 'var(--success)' : 'var(--border)';
  }
  if (sessEl) {
    const sessions = state.contextData?.sessions || [];
    const cur = sessions.find((s) => s.id === state.activeConversationId) || sessions[0];
    sessEl.textContent = cur ? cur.label : '自动跟随最新活跃对话';
  }
}

function enterGlobalLauncherMode(popoutStatus) {
  state.launcherMode = true;
  if (popoutStatus) state.popoutStatus = popoutStatus;
  document.getElementById('appShell')?.classList.add('hidden');
  document.getElementById('globalLauncherView')?.classList.remove('hidden');
  renderLauncherView();
  // Stop high-frequency polling in hidden background shell while popout window handles monitoring
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (launcherTimer) clearInterval(launcherTimer);
  launcherTimer = setInterval(async () => {
    if (!state.launcherMode) return;
    try {
      const res = await callAppTool('app_config_manage', { action: 'get' });
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      if (res?.config) state.config = res.config;
      renderLauncherView();
    } catch {
      // ignore transient status poll errors
    }
  }, 6000);
}

function exitGlobalLauncherMode() {
  state.launcherMode = false;
  if (launcherTimer) {
    clearInterval(launcherTimer);
    launcherTimer = null;
  }
  document.getElementById('globalLauncherView')?.classList.add('hidden');
  document.getElementById('appShell')?.classList.remove('hidden');
  void refreshAll(false, false);
  restartPollTimer();
  requestAnimationFrame(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
  });
}

function startPopoutClientLifecycle() {
  if (!popoutToken || !popoutClientId) return;

  const sendHeartbeat = async () => {
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

  void sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 1800);

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
  boundsTimer = setInterval(() => {
    if (document.visibilityState === 'visible') scheduleBoundsSave();
  }, 4000);
}

function renderNativePinButton() {
  const btn = document.getElementById('winPinBtn');
  const lbl = document.getElementById('winPinLabel');
  if (!btn) return;
  const pinned = Boolean(state.windowPinned);
  btn.dataset.pinned = String(pinned);
  btn.title = pinned ? '已固定置顶在页面最前（点击取消固定）' : '未固定置顶（点击固定在 Antigravity 页面最前）';
  if (lbl) lbl.textContent = pinned ? '已固定' : '置顶';
}

function setupNativeFramelessChrome() {
  if (!isNativePopout) return;
  document.body.classList.add('native-popout');
  document.getElementById('appShell')?.classList.add('scroll-thin');
  document.getElementById('nativeTitleBar')?.classList.remove('hidden');
  document.getElementById('nativeResizeHandles')?.classList.remove('hidden');
  renderNativePinButton();

  const toggleNativeCollapse = () => {
    state.windowCollapsed = !state.windowCollapsed;
    document.body.classList.toggle('window-collapsed', state.windowCollapsed);
    const collapsePx = Math.ceil(40 * (window.devicePixelRatio || 1));
    postHostWindowMsg(state.windowCollapsed ? `collapse:1:${collapsePx}` : 'collapse:0');
    document.getElementById('titleBarMiniSummary')?.classList.toggle('hidden', !state.windowCollapsed);
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
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => fitNativeTitleBar());
      ro.observe(titleBar);
    } else {
      window.addEventListener('resize', fitNativeTitleBar);
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

function renderSettings() {
  const cfg = state.config;
  document.getElementById('auxAutoSwitch').dataset.on = String(Boolean(cfg.auxAutoOpen));
  const sidebarAutoEl = document.getElementById('sidebarAutoPopoutSwitch');
  if (sidebarAutoEl) {
    sidebarAutoEl.dataset.on = String(cfg.popout?.autoLaunchFromSidebar !== false);
  }
  const topMostEl = document.getElementById('popoutTopMostSwitch');
  if (topMostEl) {
    topMostEl.dataset.on = String(cfg.popout?.alwaysOnTop !== false);
  }
  if (isNativePopout && cfg.popout && typeof cfg.popout.alwaysOnTop === 'boolean') {
    state.windowPinned = cfg.popout.alwaysOnTop;
    renderNativePinButton();
  }
  const popOn = Boolean(state.popoutStatus?.running || cfg.popout?.enabled);
  document.getElementById('popoutSwitch').dataset.on = String(popOn);
  const badge = document.getElementById('popoutStateBadge');
  badge.textContent = state.popoutStatus?.running
    ? `运行中 :${state.popoutStatus.port}`
    : popOn
      ? '已启用'
      : '已关闭';
  badge.style.color = popOn ? 'var(--success)' : 'var(--muted-foreground)';
  badge.style.borderColor = popOn ? 'var(--success)' : 'var(--border)';

  const bannerOn = Boolean(cfg.uiBanner?.enabled);
  document.getElementById('bannerSwitch').dataset.on = String(bannerOn);
  const preview = document.getElementById('bannerPreview');
  preview.style.opacity = bannerOn ? '1' : '0.42';
  if (state.callsData?.banner) {
    preview.textContent = state.callsData.banner;
  }

  document.getElementById('cfgBudgetInput').value = cfg.sessionStartBudgetTokens ?? 450;
  document.getElementById('cfgWarnPctInput').value = cfg.alerts?.contextWarningPct ?? 75;
  document.getElementById('cfgDropPctInput').value = cfg.alerts?.cacheDropThresholdPct ?? 50;

  const rep = state.doctorReport;
  if (rep) {
    document.getElementById('settingsVersionLabel').textContent = `context-cache v${rep.version || '1.2.0'}`;
    const pill = document.getElementById('doctorStatusPill');
    pill.textContent = rep.healthy ? '健康' : '需关注';
    pill.style.color = rep.healthy ? 'var(--success)' : 'var(--warning)';
    pill.style.borderColor = rep.healthy ? 'var(--success)' : 'var(--warning)';

    const driftEl = document.getElementById('docDriftVal');
    driftEl.textContent = `${rep.drift.count} 项漂移`;
    driftEl.style.color = rep.drift.count === 0 ? 'var(--success)' : 'var(--warning)';

    document.getElementById('docCircuitVal').textContent = `${rep.circuit.state} (${rep.circuit.failures} / ${rep.circuit.threshold})`;
    document.getElementById('docIndexVal').textContent = `${rep.index.ok ? '已同步' : '需重建'} · ${rep.index.dbMemories} 条`;
    document.getElementById('docDeployVal').textContent = `v${rep.version} · ${rep.deployment.zeroNodeModules ? '0 node_modules' : '含冗余依赖'}`;
  }
}

function renderCapsuleModal() {
  const cap = state.capsuleData;
  if (!cap) return;
  document.getElementById('capsuleGitMeta').textContent = `${cap.project} · ${cap.branch}@${cap.head}`;
  document.getElementById('capsuleGoalText').textContent = cap.activeGoal;
  document.getElementById('capsuleNextAction').textContent = cap.nextAction;
  document.getElementById('capsuleTokenBadge').textContent = `${cap.tokens} / ${cap.budgetTokens} tokens`;

  const selectedCount = (cap.decisions || []).filter((d) => d.checked).length;
  document.getElementById('capsuleDecCount').textContent = `${selectedCount} / ${(cap.decisions || []).length}`;

  const decHost = document.getElementById('capsuleDecisionsList');
  decHost.innerHTML = (cap.decisions || []).length
    ? cap.decisions
        .map(
          (d, i) => `
      <label class="capsule-check-item" data-checked="${d.checked}">
        <input type="checkbox" ${d.checked ? 'checked' : ''} data-cap-dec="${esc(d.id)}" style="margin-top:2px; accent-color: var(--primary); cursor: pointer;" />
        <span class="text-xs text-fg leading-relaxed flex-1">${i + 1}. ${esc(d.text)}</span>
        <span class="mono-num text-xs text-muted shrink-0">+${d.tokens}t</span>
      </label>`
        )
        .join('')
    : `<div class="text-xs text-muted py-1">当前项目暂无已保存决策条目</div>`;

  const filesHost = document.getElementById('capsuleFilesList');
  filesHost.innerHTML = (cap.touchedFiles || []).length
    ? cap.touchedFiles
        .map((f) => `<span class="mono-num text-xs px-2 py-0.5 rounded-md" style="background:var(--card);border:1px solid var(--border);">${esc(f)}</span>`)
        .join('')
    : `<span class="text-xs text-muted">自动随会话追踪</span>`;

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

  renderSelects();
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
  renderSelects();
  renderCalls();
  const nowStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lbl = document.getElementById('lastUpdatedLabel');
  if (lbl) lbl.textContent = `最近同步 ${nowStr}`;
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
  renderVault();
}

async function loadConfigAndDoctor() {
  const [cfgRes, docRes] = await Promise.all([
    callAppTool('app_config_manage', { action: 'get' }),
    callAppTool('app_doctor_action', { action: 'diagnose' }),
  ]);
  if (cfgRes?.config) state.config = cfgRes.config;
  if (cfgRes?.popoutStatus) state.popoutStatus = cfgRes.popoutStatus;
  if (docRes?.report) state.doctorReport = docRes.report;
  renderSelects();
  renderSettings();
  if (state.launcherMode) renderLauncherView();
}

async function persistConfigPatch(patch) {
  const res = await callAppTool('app_config_manage', { action: 'update', patch });
  if (res?.config) state.config = res.config;
  if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
  renderSettings();
  renderSelects();
}

async function refreshAll(animated = true, manual = false, force = false) {
  if (refreshInFlight && !manual && !force) return;
  const mySeq = ++refreshSeq;
  refreshInFlight = true;
  if (manual) {
    const svg = document.getElementById('refreshSvg');
    svg.style.transition = 'transform 480ms cubic-bezier(0.22, 1, 0.36, 1)';
    svg.style.transform = 'rotate(360deg)';
    setTimeout(() => {
      svg.style.transition = 'none';
      svg.style.transform = 'rotate(0deg)';
    }, 500);
  }
  try {
    await loadContext(animated);
    if (mySeq !== refreshSeq) return;
    const tasks = [loadCalls(manual || force), loadVault()];
    if (FEATURE_FLAGS.showQuotaUi) tasks.push(loadQuota());
    await Promise.allSettled(tasks);
    if (state.inSettings && mySeq === refreshSeq) {
      await loadConfigAndDoctor().catch(() => {});
    }
    if (manual && mySeq === refreshSeq) showToast('已增量同步最新数据');
  } catch (err) {
    if (!state.contextData) {
      const attr = document.getElementById('ctxAttribution');
      if (attr) attr.textContent = `数据加载异常：${err.message}`;
    }
    if (manual && mySeq === refreshSeq) showToast(`同步失败：${err.message}`);
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
  if (state.launcherMode) return;
  const sec = Number(state.config.pollIntervalSec ?? 5);
  if (sec > 0) {
    pollTimer = setInterval(() => {
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

function syncConsoleNavState() {
  document.querySelectorAll('.console-rail-btn[data-module], .console-top-btn[data-module]').forEach((btn) => {
    btn.dataset.active = String(!state.inSettings && btn.dataset.module === state.activeModule);
  });
  const railSettings = document.getElementById('railSettingsBtn');
  if (railSettings) railSettings.dataset.active = String(Boolean(state.inSettings));

  ['settingsBtn', 'i18nSettingsBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.borderColor = state.inSettings ? 'var(--primary)' : 'var(--border)';
    btn.style.color = state.inSettings ? 'var(--primary)' : 'var(--foreground)';
  });
}

function switchModule(mod, subTab = null) {
  const safeMod = mod === 'i18n' ? 'i18n' : 'monitor';
  state.activeModule = safeMod;
  state.inSettings = false;

  document.getElementById('module-monitor')?.classList.toggle('hidden', safeMod !== 'monitor');
  document.getElementById('module-i18n')?.classList.toggle('hidden', safeMod !== 'i18n');
  document.getElementById('module-settings')?.classList.add('hidden');
  syncConsoleNavState();

  if (safeMod === 'monitor') {
    requestAnimationFrame(() => {
      positionIndicator('mainSegNav', 'mainSegIndicator');
      positionIndicator('callsModeNav', 'callsModeIndicator');
    });
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
  if (safeTab === 'calls') setTimeout(() => positionIndicator('callsModeNav', 'callsModeIndicator'), 15);
}

function toggleSettingsView() {
  if (state.inSettings) {
    exitSettingsView();
    return;
  }
  state.inSettings = true;
  document.getElementById('module-monitor')?.classList.add('hidden');
  document.getElementById('module-i18n')?.classList.add('hidden');
  document.getElementById('module-settings')?.classList.remove('hidden');
  document.getElementById('panel-settings')?.classList.remove('hidden');
  syncConsoleNavState();
  void loadConfigAndDoctor();
}

function exitSettingsView() {
  state.inSettings = false;
  document.getElementById('module-settings')?.classList.add('hidden');
  document.getElementById('module-monitor')?.classList.toggle('hidden', state.activeModule !== 'monitor');
  document.getElementById('module-i18n')?.classList.toggle('hidden', state.activeModule !== 'i18n');
  syncConsoleNavState();
  requestAnimationFrame(() => {
    if (state.activeModule === 'monitor') {
      positionIndicator('mainSegNav', 'mainSegIndicator');
      positionIndicator('callsModeNav', 'callsModeIndicator');
    } else {
      i18nModule?.positionSubNav();
    }
  });
}

function openModal(id) {
  document.getElementById(id).dataset.open = 'true';
}

function closeModal(id) {
  document.getElementById(id).dataset.open = 'false';
}

async function openCapsuleModal() {
  const cap = await callAppTool('app_vault_manage', {
    action: 'capsule',
    conversationId: state.activeConversationId || undefined,
    projectDir: state.activeProjectDir || undefined,
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
      ['capsuleModal', 'quotaModal', 'addMemModal', 'i18nPatchConfirmModal', 'i18nEntryModal', 'i18nImportModal'].forEach(closeModal);
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
      showToast('已锁定当前对话（不再随其他对话切换）');
    } else {
      state.followMode = 'auto';
      state.pinnedConversationId = null;
      resetSessionViewState();
      renderSelects();
      void refreshAll(true, false);
      showToast('已恢复自动跟随当前活跃对话');
    }
  });

  let popoutLaunchBusy = false;
  const handleOpenPopout = async (forceNew = false) => {
    if (isNativePopout) {
      showToast('当前已在独立悬浮窗中');
      return state.popoutStatus;
    }
    if (popoutLaunchBusy) return state.popoutStatus;
    popoutLaunchBusy = true;
    const triggerBtns = ['quickPopoutBtn', 'launcherOpenPopoutBtn', 'launchPopoutBtn']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    triggerBtns.forEach((b) => { b.disabled = true; });
    try {
      const res = await callAppTool('app_config_manage', {
        action: 'open_popout',
        forceNew,
        theme: detectCurrentTheme(),
      });
      if (res?.config) state.config = res.config;
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      renderSettings();
      if (state.launcherMode) renderLauncherView();
      const st = res?.popoutStatus;
      if (st?.reused) {
        showToast(`已聚焦现有独立悬浮窗（127.0.0.1:${st.port}）`);
      } else if (st?.launched) {
        showToast(`已弹出无框固定悬浮窗（127.0.0.1:${st.port}）`);
      } else {
        showToast('未检测到 WebView2 或 Edge/Chrome，已保留在当前页内运行');
      }
      return st;
    } catch (err) {
      showToast(`唤出独立悬浮窗失败：${err?.message || '未知错误'}`);
      return null;
    } finally {
      popoutLaunchBusy = false;
      triggerBtns.forEach((b) => { b.disabled = false; });
    }
  };

  document.getElementById('quickPopoutBtn')?.addEventListener('click', () => {
    void handleOpenPopout(false);
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
      renderLauncherView();
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

  // Capsule decision toggle (recalculates payload & token budget live)
  document.getElementById('capsuleDecisionsList').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-cap-dec]');
    if (!cb || !state.capsuleData) return;
    const dec = state.capsuleData.decisions.find((d) => d.id === cb.dataset.capDec);
    if (dec) dec.checked = cb.checked;
    const selectedIds = state.capsuleData.decisions.filter((d) => d.checked).map((d) => d.id);
    void (async () => {
      state.capsuleData = await callAppTool('app_vault_manage', {
        action: 'capsule',
        conversationId: state.activeConversationId || undefined,
        projectDir: state.activeProjectDir || undefined,
        selectedDecisionIds: selectedIds,
      });
      renderCapsuleModal();
    })();
  });

  document.getElementById('copyCapsuleBtn').addEventListener('click', () => {
    const txt = document.getElementById('capsuleRawPre')?.textContent || '';
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    showToast('已复制 Agent 紧凑交接原文');
  });

  document.getElementById('saveCapsuleOnlyBtn').addEventListener('click', () => {
    void (async () => {
      if (state.capsuleData) {
        await callAppTool('app_vault_manage', {
          action: 'save',
          conversationId: state.activeConversationId || undefined,
          projectDir: state.activeProjectDir || undefined,
          kind: 'checkpoint',
          title: `交接胶囊：${state.capsuleData.activeGoal.slice(0, 64)}`,
          summary: state.capsuleData.agentPayload,
          tags: ['handoff-capsule'],
        });
        await loadVault();
      }
      closeModal('capsuleModal');
      showToast('已存入跨会话记忆库');
    })();
  });

  document.getElementById('attachCapsuleBtn').addEventListener('click', () => {
    void (async () => {
      if (!state.capsuleData) return;
      await callAppTool('app_vault_manage', {
        action: 'save',
        conversationId: state.activeConversationId || undefined,
        projectDir: state.activeProjectDir || undefined,
        kind: 'checkpoint',
        title: `交接胶囊：${state.capsuleData.activeGoal.slice(0, 64)}`,
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
      showToast('已按 Agent 紧凑格式保存并附着到下条消息');
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

  // Settings switches & inputs
  document.getElementById('auxAutoSwitch').addEventListener('click', () => {
    const next = !state.config.auxAutoOpen;
    void persistConfigPatch({ auxAutoOpen: next }).then(() => {
      showToast(next ? '已开启右侧边栏自动呼出' : '已关闭自动呼出（仅通过右侧 + 菜单手动打开）');
    });
  });

  document.getElementById('sidebarAutoPopoutSwitch')?.addEventListener('click', () => {
    const next = state.config.popout?.autoLaunchFromSidebar === false;
    void persistConfigPatch({ popout: { autoLaunchFromSidebar: next } }).then(() => {
      showToast(next ? '已开启左侧边栏点击自动弹出独立悬浮窗' : '已关闭自动弹出（左侧边栏将以全页内嵌展示）');
    });
  });

  document.getElementById('popoutTopMostSwitch')?.addEventListener('click', () => {
    const next = state.config.popout?.alwaysOnTop === false;
    state.windowPinned = next;
    if (isNativePopout) {
      postHostWindowMsg(next ? 'pin:1' : 'pin:0');
      renderNativePinButton();
    }
    void persistConfigPatch({ popout: { alwaysOnTop: next } }).then(() => {
      showToast(next ? '已开启独立悬浮窗默认固定置顶' : '已关闭默认固定置顶');
    });
  });

  document.getElementById('popoutSwitch').addEventListener('click', () => {
    const next = !(state.popoutStatus?.running || state.config.popout?.enabled);
    void (async () => {
      if (!next) {
        const res = await callAppTool('app_config_manage', { action: 'close_popout' });
        if (res?.config) state.config = res.config;
        if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
        renderSettings();
        showToast('已关闭独立悬浮小窗并释放本地端口');
      } else {
        await persistConfigPatch({ popout: { enabled: true } });
        showToast('已启用独立悬浮小窗（仅 127.0.0.1 按需拉起）');
      }
    })();
  });

  document.getElementById('launchPopoutBtn').addEventListener('click', () => {
    void handleOpenPopout(false);
  });

  document.getElementById('bannerSwitch').addEventListener('click', () => {
    const next = !state.config.uiBanner?.enabled;
    void persistConfigPatch({ uiBanner: { enabled: next } }).then(() => {
      showToast(next ? '已开启聊天流单行状态条（0 模型消耗）' : '已关闭聊天流单行状态条');
    });
  });

  document.getElementById('cfgBudgetInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ sessionStartBudgetTokens: val }).then(() => {
      showToast(`已更新 SessionStart 预算为 ${state.config.sessionStartBudgetTokens} tokens`);
    });
  });

  document.getElementById('cfgWarnPctInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ alerts: { contextWarningPct: val } }).then(() => {
      renderContext(false);
      showToast(`已更新上下文警戒线为 ${state.config.alerts.contextWarningPct}%`);
    });
  });

  document.getElementById('cfgDropPctInput').addEventListener('change', (e) => {
    const val = Number(e.target.value);
    void persistConfigPatch({ alerts: { cacheDropThresholdPct: val } }).then(() => {
      showToast(`已更新击穿告警阈值为 ${state.config.alerts.cacheDropThresholdPct}%`);
    });
  });

  // Doctor actions
  document.getElementById('docRebuildBtn').addEventListener('click', () => {
    void (async () => {
      const res = await callAppTool('app_doctor_action', { action: 'rebuild_index' });
      state.doctorReport = res.report;
      renderSettings();
      showToast(`已从真相源无损重建 SQLite 索引（${res.rebuild?.elapsedMs ?? 0}ms）`);
    })();
  });

  document.getElementById('docExportBtn').addEventListener('click', () => {
    void (async () => {
      const res = await callAppTool('app_doctor_action', { action: 'export_backup' });
      state.doctorReport = res.report;
      renderSettings();
      showToast(`已导出脱敏备份至 ${res.exported?.displayPath || '.context-cache/exports/'}`);
    })();
  });

  document.getElementById('docRunBtn').addEventListener('click', () => {
    void (async () => {
      const res = await callAppTool('app_doctor_action', { action: 'diagnose' });
      state.doctorReport = res.report;
      renderSettings();
      showToast(res.report?.healthy ? 'Doctor 体检通过：Hook / MCP / 索引 / 部署均正常' : `Doctor 发现 ${res.report?.issues?.length || 1} 项待关注`);
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
  bindEvents();
  syncConsoleNavState();
  renderSelects();
  requestAnimationFrame(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
    i18nModule?.positionSubNav();
  });

  const ro = new ResizeObserver(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
    positionIndicator('capsuleModeNav', 'capsuleModeIndicator');
    i18nModule?.positionSubNav();
    if (state.openSelectId) clampOpenSelectMenus();
  });
  ro.observe(document.getElementById('consoleWorkspace') || document.getElementById('appShell'));

  if (!popoutToken) {
    mcpApp = new App({ name: 'Antigravity Hub', version: '1.3.0' }, {});

    // Register handlers BEFORE connect() per Antigravity mcp-app-development guidelines
    mcpApp.ontoolinput = ({ arguments: args }) => {
      if (args?.conversationId) {
        state.activeConversationId = args.conversationId;
        resetSessionViewState();
      }
      if (args?.module === 'i18n') {
        switchModule('i18n', args?.i18nTab || null);
      } else if (args?.tab && ['context', 'calls', 'quota', 'vault'].includes(args.tab)) {
        switchTab(args.tab);
      } else if (args?.tab === 'settings') {
        toggleSettingsView();
      }
    };

    mcpApp.ontoolresult = (result) => {
      const sc = result?.structuredContent;
      if (!sc) return;
      if (sc.config) state.config = sc.config;
      if (sc.popoutStatus) state.popoutStatus = sc.popoutStatus;
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
    if (initialThemeParam === 'dark' || initialThemeParam === 'light') {
      applyDocumentTheme(initialThemeParam);
      postHostWindowMsg(`theme:${initialThemeParam}`);
    }
    document.getElementById('quickPopoutBtn')?.classList.add('hidden');
    setupNativeFramelessChrome();
    startPopoutClientLifecycle();
  }

  await loadConfigAndDoctor().catch(() => {});

  // Left sidebar (global) auto-launches floating OS window when enabled
  if (state.surface === 'global' && state.config.popout?.autoLaunchFromSidebar !== false) {
    try {
      const res = await callAppTool('app_config_manage', {
        action: 'open_popout',
        forceNew: false,
        theme: detectCurrentTheme(),
      });
      if (res?.config) state.config = res.config;
      if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
      if (res?.popoutStatus?.launched) {
        // Fetch once so launcher card displays current followed conversation name
        await loadContext(false).catch(() => {});
        enterGlobalLauncherMode(res.popoutStatus);
        return;
      }
      showToast('未检测到 Edge/Chrome，已切换为当前页内展示');
    } catch {
      // Fall back cleanly to embedded view if popout launch fails
    }
  }

  await refreshAll(false, false);
  void i18nModule?.loadStatus(false);
  restartPollTimer();
  requestAnimationFrame(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
    i18nModule?.positionSubNav();
  });
}

void init();
