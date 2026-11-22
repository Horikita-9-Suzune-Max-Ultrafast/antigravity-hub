import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

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
  conversationId: null,
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
    popout: { enabled: false, size: '460x720' },
    uiBanner: { enabled: true },
    sessionStartBudgetTokens: 450,
    alerts: { contextWarningPct: 75, cacheDropThresholdPct: 50 },
  },
  doctorReport: null,
  knownCallIds: new Set(),
  freshCallId: null,
};

const prevDisplay = { pct: 0, used: 0, cache: 0, tps: 0, free: 0, cost: 0 };
const activeAnims = new WeakMap();
let pollTimer = null;
let toastTimer = null;
let refreshInFlight = false;

// Detect standalone popout mode (?token=...) vs MCP App iframe mode
const urlParams = new URLSearchParams(window.location.search);
const popoutToken = urlParams.get('token');
let mcpApp = null;

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
function renderCustomSelect(hostId, { id, value, options, alignRight = false, fullWidth = false }) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const opts = options.length ? options : [{ value: '', label: '暂无数据' }];
  const current = opts.find((o) => o.value === value) || opts[0];
  const isOpen = state.openSelectId === id;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger ${fullWidth ? 'w-full' : ''}" aria-expanded="${isOpen}" data-select-toggle="${esc(id)}">
      <span class="truncate">${esc(current.label)}</span>
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

function renderSelects() {
  renderPollSelect();

  const sessions = state.contextData?.sessions || [];
  const sessionOpts = sessions.length
    ? sessions.map((s) => ({ value: s.id, label: s.label }))
    : [{ value: '', label: '当前工作区（等待会话记录）' }];
  renderCustomSelect('sessionSelectHost', {
    id: 'sessionSelect',
    value: state.conversationId || sessionOpts[0].value,
    options: sessionOpts,
    fullWidth: true,
  });

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
}

async function handleSelectPick(id, val) {
  state.openSelectId = null;
  if (id === 'sessionSelect') {
    state.conversationId = val || null;
    state.expandedCallId = null;
    state.knownCallIds.clear();
    await refreshAll(true, false);
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
  }
}

// ==================== Rendering ====================
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

        return `
        <tr class="call-row ${c.callUid === state.freshCallId ? 'row-fresh' : ''}" data-call-id="${esc(c.callUid)}" data-expanded="${isExp}">
          <td class="whitespace-nowrap mono-num">
            <span class="agent-badge" style="${badgeStyle}">${esc(c.agentTag)}</span>
            <span>#${c.stepIndex}</span>
          </td>
          <td class="whitespace-nowrap mono-num text-muted">${esc(c.model)}</td>
          <td class="text-right whitespace-nowrap mono-num font-semibold ${c.effectiveTps < 15 ? 'text-warning' : ''}">${c.effectiveTps.toFixed(1)} tok/s</td>
          <td class="text-right whitespace-nowrap mono-num text-muted">${durText}</td>
          <td class="text-right whitespace-nowrap mono-num">
            <span>${fmtK(c.contextTokens)}</span>
            <span class="text-muted"> / ${fmtK(c.thinkingTokensEst)} / ${fmtK(c.contentTokensEst)}</span>
          </td>
          <td class="text-right whitespace-nowrap mono-num ${cacheCls}">
            ${c.cacheHitRate.toFixed(1)}%
            ${c.cacheDrop ? `<span class="ml-1.5 px-2 py-0.5 rounded-full text-xs" style="background: color-mix(in srgb, var(--error) 12%, transparent);">击穿</span>` : ''}
          </td>
          <td class="text-right whitespace-nowrap mono-num font-medium">$${c.estimatedCostUsd.toFixed(3)}</td>
        </tr>
        ${
          isExp
            ? `
        <tr class="call-anatomy-row">
          <td colspan="7" class="px-4 py-3.5">
            <div class="space-y-2.5 text-xs panel-enter">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-3 mono-num">
                  <span class="font-semibold text-fg">单步解剖 · ${esc(c.agentTag)} #${c.stepIndex}</span>
                  <span class="text-muted">计时来源: ${esc(c.timingSource)}</span>
                  <span class="text-muted">缓存命中 ${fmtK(c.cacheReadTokens)} · 新编码 ${fmtK(c.inputTokens)}</span>
                </div>
                <span class="mono-num text-muted">思考占比 ${thinkRatio}%</span>
              </div>
              <div class="flex rounded-full overflow-hidden" style="height: 8px; background: var(--card); border: 1px solid var(--border);">
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
  const avgTps = list.length ? list.reduce((s, c) => s + c.effectiveTps, 0) / list.length : 0;
  document.getElementById('callsFooterStats').textContent = `共 ${list.length} 步 · 均速 ${avgTps.toFixed(1)} tok/s · 估算 $${totalCost.toFixed(3)}`;

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

function renderSettings() {
  const cfg = state.config;
  document.getElementById('auxAutoSwitch').dataset.on = String(Boolean(cfg.auxAutoOpen));
  const popOn = Boolean(cfg.popout?.enabled);
  document.getElementById('popoutSwitch').dataset.on = String(popOn);
  document.getElementById('popoutControls').classList.toggle('hidden', !popOn);
  const badge = document.getElementById('popoutStateBadge');
  badge.textContent = popOn ? '已启用' : '已关闭';
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
    document.getElementById('settingsVersionLabel').textContent = `context-cache v${rep.version || '1.0.0'}`;
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
  const ctx = await callAppTool('app_get_context_breakdown', {
    conversationId: state.conversationId || undefined,
  });
  state.contextData = ctx;
  if (!state.conversationId && ctx.conversationId) {
    state.conversationId = ctx.conversationId;
  }
  renderSelects();
  renderContext(animated);
}

async function loadCalls(force = false) {
  const data = await callAppTool('app_get_calls', {
    conversationId: state.conversationId || undefined,
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
  state.quotaData = await callAppTool('app_get_quota', {});
  renderQuota();
}

async function loadVault() {
  const query = (document.getElementById('vaultSearch')?.value || '').trim();
  state.vaultData = await callAppTool('app_vault_manage', {
    action: 'list',
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
  if (docRes?.report) state.doctorReport = docRes.report;
  renderSelects();
  renderSettings();
}

async function persistConfigPatch(patch) {
  const res = await callAppTool('app_config_manage', { action: 'update', patch });
  if (res?.config) state.config = res.config;
  renderSettings();
  renderSelects();
}

async function refreshAll(animated = true, manual = false) {
  if (refreshInFlight) return;
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
    await Promise.all([loadCalls(manual), loadQuota(), loadVault()]);
    if (state.inSettings) {
      await loadConfigAndDoctor();
    }
    if (manual) showToast('已增量同步最新数据');
  } catch (err) {
    if (manual) showToast(`同步失败：${err.message}`);
  } finally {
    refreshInFlight = false;
  }
}

function restartPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const sec = Number(state.config.pollIntervalSec ?? 5);
  if (sec > 0) {
    pollTimer = setInterval(() => {
      void refreshAll(true, false);
    }, sec * 1000);
  }
}

// ==================== Navigation & Modals ====================
function switchTab(tab) {
  state.activeTab = tab;
  if (state.inSettings) exitSettingsView();
  ['context', 'calls', 'quota', 'vault'].forEach((t) => {
    document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('#mainSegNav .seg-tab').forEach((btn) => {
    btn.dataset.active = String(btn.dataset.tab === tab);
  });
  positionIndicator('mainSegNav', 'mainSegIndicator');
  if (tab === 'calls') setTimeout(() => positionIndicator('callsModeNav', 'callsModeIndicator'), 15);
}

function toggleSettingsView() {
  if (state.inSettings) {
    exitSettingsView();
    return;
  }
  state.inSettings = true;
  ['context', 'calls', 'quota', 'vault'].forEach((t) => document.getElementById(`panel-${t}`).classList.add('hidden'));
  document.getElementById('panel-settings').classList.remove('hidden');
  const btn = document.getElementById('settingsBtn');
  btn.style.borderColor = 'var(--primary)';
  btn.style.color = 'var(--primary)';
  void loadConfigAndDoctor();
}

function exitSettingsView() {
  state.inSettings = false;
  document.getElementById('panel-settings').classList.add('hidden');
  document.getElementById(`panel-${state.activeTab}`).classList.remove('hidden');
  const btn = document.getElementById('settingsBtn');
  btn.style.borderColor = 'var(--border)';
  btn.style.color = 'var(--foreground)';
}

function openModal(id) {
  document.getElementById(id).dataset.open = 'true';
}

function closeModal(id) {
  document.getElementById(id).dataset.open = 'false';
}

async function openCapsuleModal() {
  const cap = await callAppTool('app_vault_manage', { action: 'capsule' });
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
      ['capsuleModal', 'quotaModal', 'addMemModal'].forEach(closeModal);
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

  document.getElementById('popoutSwitch').addEventListener('click', () => {
    const next = !state.config.popout?.enabled;
    void (async () => {
      if (!next) {
        const res = await callAppTool('app_config_manage', { action: 'close_popout' });
        if (res?.config) state.config = res.config;
        renderSettings();
        showToast('已关闭独立悬浮小窗并释放本地端口');
      } else {
        await persistConfigPatch({ popout: { enabled: true } });
        showToast('已启用独立悬浮小窗（仅 127.0.0.1 按需拉起）');
      }
    })();
  });

  document.getElementById('launchPopoutBtn').addEventListener('click', () => {
    void (async () => {
      const res = await callAppTool('app_config_manage', { action: 'open_popout' });
      const port = res?.popoutStatus?.port;
      showToast(port ? `已弹出无框独立小窗（127.0.0.1:${port} 本地令牌）` : '已启动本地独立小窗服务');
    })();
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
  bindEvents();

  const ro = new ResizeObserver(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
    positionIndicator('capsuleModeNav', 'capsuleModeIndicator');
  });
  ro.observe(document.getElementById('appShell'));

  if (!popoutToken) {
    mcpApp = new App({ name: 'Context Cache & Telemetry', version: '1.0.0' }, {});

    // Register handlers BEFORE connect() per Antigravity mcp-app-development guidelines
    mcpApp.ontoolinput = ({ arguments: args }) => {
      if (args?.conversationId) state.conversationId = args.conversationId;
      if (args?.tab && ['context', 'calls', 'quota', 'vault'].includes(args.tab)) {
        switchTab(args.tab);
      } else if (args?.tab === 'settings') {
        toggleSettingsView();
      }
    };

    mcpApp.ontoolresult = (result) => {
      const sc = result?.structuredContent;
      if (!sc) return;
      if (sc.config) state.config = sc.config;
      if (sc.context) {
        state.contextData = sc.context;
        if (!state.conversationId && sc.context.conversationId) {
          state.conversationId = sc.context.conversationId;
        }
        renderSelects();
        renderContext(false);
      }
      if (sc.initialTab && ['context', 'calls', 'quota', 'vault'].includes(sc.initialTab)) {
        switchTab(sc.initialTab);
      } else if (sc.initialTab === 'settings') {
        toggleSettingsView();
      }
    };

    mcpApp.onhostcontextchanged = (ctx) => {
      if (ctx?.theme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };

    try {
      await mcpApp.connect();
      const hostCtx = mcpApp.getHostContext();
      if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
      if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);

      const caps = mcpApp.getHostCapabilities();
      state.canUpdateModelContext = Boolean(caps?.updateModelContext);
    } catch (err) {
      showToast(`宿主连接异常：${err.message}`);
    }
  } else {
    // Standalone popout window: global-like surface without conversation updateModelContext
    state.canUpdateModelContext = false;
  }

  await loadConfigAndDoctor().catch(() => {});
  await refreshAll(false, false);
  restartPollTimer();
  requestAnimationFrame(() => {
    positionIndicator('mainSegNav', 'mainSegIndicator');
    positionIndicator('callsModeNav', 'callsModeIndicator');
  });
}

void init();
