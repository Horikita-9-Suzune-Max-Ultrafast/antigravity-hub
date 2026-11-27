/**
 * Monitor Context Panel module:
 * Context usage bar, KPI readouts, Gemini KV countdown + cross-model health state,
 * model window simulator, mounted assets accordion, alerts jump, and Asset Inspector Modal.
 */

import { esc, fmtK, animateNumber, pulseEl, pulseTargetEl } from '../core/dom.mjs';
import { renderIcon, computeBrandHealthState } from '../components/icons.mjs';
import { renderModelSimSelect } from '../components/custom-select.mjs';

export function createMonitorContextModule({
  state,
  prevDisplay,
  tr,
  getUiLang,
  localizeBreakdownItem,
  localizeDeferredItem,
  localizeInventoryGroup,
  callAppTool,
  getMcpApp,
  showToast,
  openModal,
  closeModal,
  switchModule,
  switchTab,
  positionIndicator,
  onTelemetryUpdate,
  onOpenCallsMatch,
  onOpenCapsule,
  onOpenModelParams,
}) {
  let kvCountdownTimer = null;
  let lastKvSig = '';
  let lastAlertsSig = '';
  let lastBreakdownSig = '';
  let lastDeferredSig = '';
  let lastInventorySig = '';

  function computeGeminiKvState() {
    const enabled = state.config?.kvCache?.enabled !== false;
    const ctx = state.contextData;
    const activeModel = String(ctx?.latestModel || ctx?.model || '').trim();
    const isGemini = /gemini/i.test(activeModel);
    const ttlMin = Math.max(3, Math.min(60, Math.round(Number(state.config?.kvCache?.ttlMinutes) || 15)));
    const ttlMs = ttlMin * 60_000;

    if (!enabled || !isGemini) {
      return { visible: false, isGemini, state: 'safe', text: '--:--', title: '', ttlMin, ratio: 0 };
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
        ratio: 1,
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
        ratio: 1,
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

    return {
      visible: true,
      isGemini: true,
      state: kvState,
      text,
      title,
      ttlMin,
      remMs,
      idleMs,
      ratio: Math.max(0, Math.min(1, remMs / ttlMs)),
    };
  }

  function shouldTickKvCountdown(kv) {
    return Boolean(
      kv &&
        kv.visible &&
        !kv.active &&
        !kv.waiting &&
        (kv.remMs || 0) > 0 &&
        !state.launcherMode &&
        !state.sizeMoveActive &&
        (typeof document === 'undefined' || document.visibilityState === 'visible')
    );
  }

  function stopKvCountdownTimer() {
    if (kvCountdownTimer) {
      clearInterval(kvCountdownTimer);
      kvCountdownTimer = null;
    }
  }

  function syncKvCountdownUi() {
    const kv = computeGeminiKvState();
    const health = computeBrandHealthState(state.contextData, state.config, kv);
    const needsTick = shouldTickKvCountdown(kv);

    if (needsTick && !kvCountdownTimer) {
      kvCountdownTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !state.launcherMode && !state.sizeMoveActive) {
          syncKvCountdownUi();
        } else {
          stopKvCountdownTimer();
        }
      }, 1000);
    } else if (!needsTick && kvCountdownTimer) {
      stopKvCountdownTimer();
    }

    const sig = `${kv.visible ? 1 : 0}|${kv.state}|${health}|${kv.text}|${kv.title}`;
    if (sig === lastKvSig) return { kv, health };
    lastKvSig = sig;

    if (typeof document !== 'undefined') {
      // Only tint live brand marks; static preview icons keep data-static="true"
      document.querySelectorAll('.hub-brand-svg:not([data-static="true"])').forEach((svg) => {
        if (svg.dataset.health !== health) svg.dataset.health = health;
        if (svg.dataset.kvState !== health) svg.dataset.kvState = health;
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
        miniKvChip.dataset.available = kv.visible ? 'true' : 'false';
        miniKvChip.dataset.kvState = kv.visible ? kv.state : 'muted';
        miniKvChip.title = kv.title || '';
        const valSpan = miniKvChip.querySelector('.mini-mod-val');
        if (valSpan) valSpan.textContent = kv.text;
      }
    }

    if (state.contextData) {
      const ctx = state.contextData;
      onTelemetryUpdate?.(ctx, {
        pct: Number(ctx.usedPercent) || 0,
        cache: Number(ctx.latestCacheHitRate) || 0,
        tps: Number(ctx.avgTps) || 0,
        kv,
        health,
      });
    }

    return { kv, health };
  }

  function startKvCountdownTimer() {
    stopKvCountdownTimer();
    if (state.launcherMode || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return;
    syncKvCountdownUi();
  }

  function renderContextModelSim() {
    const out = document.getElementById('ctxModelSimResult');
    const legacySel = document.getElementById('ctxModelSimSelect');
    const rawLimit = state.modelSimLimit || (legacySel ? legacySel.value : '');
    renderModelSimSelect(false, { state, tr });
    if (!out) return;

    const targetLimit = Number(rawLimit) || 0;
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

    const callsCountEl = document.getElementById('tabCallsCount');
    if (callsCountEl) callsCountEl.textContent = String(ctx.totalCallsCount ?? 0);

    const alerts = ctx.alerts || [];
    const alertsSig = `${lang}|${alerts.map((a) => `${a.level}:${a.code || ''}:${a.title}:${a.detail}`).join('\u001f')}`;
    if (alertsSig !== lastAlertsSig) {
      lastAlertsSig = alertsSig;
      const alertCountLabel = document.getElementById('alertCountLabel');
      if (alertCountLabel) alertCountLabel.textContent = tr('monitor.header.alertsCount', { count: alerts.length });
      const alertDot = document.getElementById('alertDot');
      if (alertDot) {
        alertDot.style.background = alerts.some((a) => a.level === 'error')
          ? 'var(--error)'
          : alerts.length > 0
            ? 'var(--warning)'
            : 'var(--success)';
      }

      const alertsList = document.getElementById('alertsList');
      if (alertsList) {
        if (!alerts.length) {
          alertsList.innerHTML = `<div class="py-2 text-xs text-muted">${esc(tr('monitor.header.alertsEmpty'))}</div>`;
        } else {
          const chevronHtml = renderIcon('chevron-right', { size: 14 });
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
            <span class="alert-row-chevron" aria-hidden="true">${chevronHtml}</span>
          </button>`
            )
            .join('');
        }
      }
    }

    const warnPct = state.config.alerts?.contextWarningPct ?? 75;
    const threshLine = document.getElementById('ctxThresholdLine');
    const threshLabel = document.getElementById('ctxThresholdLabel');
    if (threshLine) threshLine.style.left = `${warnPct}%`;
    if (threshLabel) threshLabel.textContent = `${warnPct}%`;

    const pct = Number(ctx.usedPercent) || 0;
    const used = Number(ctx.usedTokens) || 0;
    const limit = Number(ctx.limitTokens) || 200000;
    const free = Number(ctx.freeTokens) || Math.max(0, limit - used);
    const cache = Number(ctx.latestCacheHitRate) || 0;
    const tps = Number(ctx.avgTps) || 0;
    const cost = Number(ctx.totalCostUsd) || 0;

    const pctEl = document.getElementById('ctxPctBig');
    const cacheEl = document.getElementById('kpiCache');
    const ratioEl = document.getElementById('ctxRatioLabel');
    const tpsEl = document.getElementById('kpiTps');
    const freeEl = document.getElementById('kpiFree');
    const costEl = document.getElementById('kpiCost');

    if (pctEl) {
      pctEl.style.color = pct >= 100 ? 'var(--error)' : pct >= warnPct ? 'var(--warning)' : 'var(--foreground)';
    }
    if (cacheEl) {
      cacheEl.style.color =
        cache < 60 && used > 0 ? 'var(--error)' : cache >= 85 ? 'var(--success)' : 'var(--warning)';
    }

    const animOpts = { paused: Boolean(state.sizeMoveActive) };
    const pctChanged = Math.abs(pct - prevDisplay.pct) >= 0.05;
    const cacheChanged = Math.abs(cache - prevDisplay.cache) >= 0.05;
    const tpsChanged = Math.abs(tps - prevDisplay.tps) >= 0.05;

    if (animated && !state.sizeMoveActive) {
      animateNumber(pctEl, prevDisplay.pct, pct, (v) => `${v.toFixed(1)}%`, 220, animOpts);
      animateNumber(ratioEl, prevDisplay.used, used, (v) => `${fmtK(Math.round(v))} / ${fmtK(limit)}`, 220, animOpts);
      animateNumber(cacheEl, prevDisplay.cache, cache, (v) => `${v.toFixed(1)}%`, 220, animOpts);
      animateNumber(tpsEl, prevDisplay.tps, tps, (v) => `${v.toFixed(1)} tok/s`, 220, animOpts);
      animateNumber(freeEl, prevDisplay.free, free, (v) => fmtK(Math.round(v)), 220, animOpts);
      animateNumber(costEl, prevDisplay.cost, cost, (v) => `$${v.toFixed(3)}`, 220, animOpts);
      if (pctChanged) pulseEl(pctEl);
      if (cacheChanged) pulseEl(cacheEl);
      if (tpsChanged) pulseEl(tpsEl);
    } else {
      if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;
      if (ratioEl) ratioEl.textContent = `${fmtK(used)} / ${fmtK(limit)}`;
      if (cacheEl) cacheEl.textContent = `${cache.toFixed(1)}%`;
      if (tpsEl) tpsEl.textContent = `${tps.toFixed(1)} tok/s`;
      if (freeEl) freeEl.textContent = fmtK(free);
      if (costEl) costEl.textContent = `$${cost.toFixed(3)}`;
    }

    prevDisplay.pct = pct;
    prevDisplay.used = used;
    prevDisplay.cache = cache;
    prevDisplay.tps = tps;
    prevDisplay.free = free;
    prevDisplay.cost = cost;

    renderContextModelSim();

    const { kv, health } = syncKvCountdownUi();
    onTelemetryUpdate?.(ctx, { pct, cache, tps, kv, health });

    const attrEl = document.getElementById('ctxAttribution');
    if (attrEl) attrEl.textContent = ctx.attribution || '';

    // Multi-segment bar (zero CSS width transition; flex-basis sets proportion cleanly)
    const breakdown = ctx.breakdown || [];
    const breakdownSig = `${lang}|${limit}|${free}|${pct.toFixed(2)}|${breakdown.map((b) => `${b.id}:${b.tokens}:${b.color}:${b.key || ''}:${b.note || ''}`).join('\u001f')}`;
    if (breakdownSig !== lastBreakdownSig) {
      lastBreakdownSig = breakdownSig;
      const segBar = document.getElementById('ctxSegBar');
      if (segBar) {
        const barDenom = Math.max(limit, used, 1);
        const existingSegs = segBar.querySelectorAll('.ctx-seg');
        if (existingSegs.length === breakdown.length) {
          breakdown.forEach((b, i) => {
            const w = b.tokens > 0 ? Math.max(0.8, (b.tokens / barDenom) * 100) : 0;
            existingSegs[i].style.flex = `0 0 ${w.toFixed(3)}%`;
            existingSegs[i].style.background = b.color;
            existingSegs[i].dataset.id = b.id;
          });
        } else {
          segBar.innerHTML = breakdown
            .map((b) => {
              const w = b.tokens > 0 ? Math.max(0.8, (b.tokens / barDenom) * 100) : 0;
              return `<div class="ctx-seg" data-id="${esc(b.id)}" style="flex:0 0 ${w.toFixed(3)}%; background:${esc(b.color)};"></div>`;
            })
            .join('');
        }
      }

      const listEl = document.getElementById('ctxBreakdownList');
      if (listEl) {
        listEl.innerHTML =
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
    }

    const deferred = ctx.deferred || [];
    const deferredSig = `${lang}|${deferred.map((d) => `${d.key}:${d.count}:${d.tokens}`).join('\u001f')}`;
    if (deferredSig !== lastDeferredSig) {
      lastDeferredSig = deferredSig;
      const defEl = document.getElementById('ctxDeferredList');
      if (defEl) {
        defEl.innerHTML = deferred
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
    }

    const inventories = ctx.inventories || [];
    const invSig = `${lang}|${state.openAccIdx}|${inventories.map((inv) => `${inv.id || inv.title}:${inv.count}:${(inv.items || []).map((it) => `${it.name}:${it.meta}:${it.size}`).join(',')}`).join('\u001f')}`;
    if (invSig !== lastInventorySig) {
      lastInventorySig = invSig;
      const invEl = document.getElementById('inventoryList');
      if (invEl) {
        const chevronHtml = renderIcon('chevron-right', { size: 13 });
        const accChevron = renderIcon('chevron-right', { size: 13, className: 'acc-chevron' });
        invEl.innerHTML = inventories
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
                  <span class="inv-item-chevron" aria-hidden="true">${chevronHtml}</span>
                </span>
              </button>`
                  )
                  .join('')
              : `<div class="text-xs text-muted py-1">${esc(tr('monitor.ctx.emptyItems'))}</div>`;
            return `
          <div>
            <button type="button" class="acc-trigger" data-acc-idx="${idx}" data-open="${open}">
              <span class="acc-title-wrap">
                ${accChevron}
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
  }

  function highlightCtx(id) {
    const ctx = state.contextData;
    const item = id && ctx ? (ctx.breakdown || []).find((b) => b.id === id) : null;
    const hint = document.getElementById('ctxHoverHint');
    if (hint) {
      if (item && ctx.limitTokens > 0) {
        const bp = ((item.tokens / ctx.limitTokens) * 100).toFixed(1);
        const loc = localizeBreakdownItem(item, getUiLang());
        hint.textContent = tr('monitor.ctx.hoverHint', { key: loc.key, tokens: fmtK(item.tokens), pct: bp });
        hint.dataset.show = 'true';
      } else {
        hint.dataset.show = 'false';
      }
    }
    document.querySelectorAll('.ctx-seg').forEach((el) => {
      el.classList.toggle('ctx-dimmed', Boolean(id) && el.dataset.id !== id);
    });
    document.querySelectorAll('.ctx-row').forEach((el) => {
      el.dataset.hl = String(Boolean(id) && el.dataset.id === id);
      el.classList.toggle('ctx-dimmed', Boolean(id) && el.dataset.id !== id);
    });
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
      const deferredCnt =
        item.deferredCount != null ? Number(item.deferredCount) : tools.filter((t) => t.deferred).length;

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
              const ratio = Math.min(1, Math.max(0.02, tok / denom));
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
                  <div class="asset-mcp-bar-fill" data-deferred="${Boolean(tool.deferred)}" style="--ratio: ${ratio.toFixed(4)};"></div>
                </div>
              </div>`;
            })
            .join('');
        }
      }

      openModal('assetInspectorModal');
      return;
    }

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
      if (contentEl) contentEl.textContent = item.previewText || tr('monitor.asset.noFileContent');
      openModal('assetInspectorModal');
    }
  }

  async function handleAlertJump(alertIdx) {
    const alerts = state.contextData?.alerts || [];
    const alert = alerts[Number(alertIdx)];
    if (!alert) return;

    const acc = document.getElementById('alertsAcc');
    if (acc) acc.dataset.open = 'false';

    const code = String(alert.code || '').toLowerCase();
    const titleStr = String(alert.title || '');
    const detailStr = String(alert.detail || '');

    if (code === 'context_high') {
      switchTab('context');
      requestAnimationFrame(() => {
        pulseTargetEl(document.getElementById('ctxBreakdownCard') || document.getElementById('ctxBreakdownList'));
      });
      return;
    }

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

    await onOpenCallsMatch?.(alert, `${titleStr} ${detailStr}`);
  }

  function bindEvents() {
    const panelCtx = document.getElementById('panel-context');
    if (panelCtx) {
      panelCtx.addEventListener('mouseover', (e) => {
        const target = e.target.closest('.ctx-seg, .ctx-row');
        if (target?.dataset.id) highlightCtx(target.dataset.id);
      });
      panelCtx.addEventListener('mouseout', (e) => {
        if (e.target.closest('.ctx-seg, .ctx-row')) highlightCtx(null);
      });
    }

    document.getElementById('ctxModelSimSelect')?.addEventListener('change', (e) => {
      state.modelSimLimit = e.target.value;
      renderContextModelSim();
    });

    document.getElementById('alertBtn')?.addEventListener('click', () => {
      const acc = document.getElementById('alertsAcc');
      if (acc) acc.dataset.open = String(acc.dataset.open !== 'true');
    });
    document.getElementById('alertsCloseBtn')?.addEventListener('click', () => {
      const acc = document.getElementById('alertsAcc');
      if (acc) acc.dataset.open = 'false';
    });
    document.getElementById('jumpCallsBtn')?.addEventListener('click', () => switchTab('calls'));
    document.getElementById('openCapsuleFromCtxBtn')?.addEventListener('click', () => void onOpenCapsule?.());
    document.getElementById('ctxLimitEditBtn')?.addEventListener('click', () => onOpenModelParams?.('limits'));

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
        const mcpApp = getMcpApp?.();
        if (mcpApp && typeof mcpApp.openLink === 'function') {
          try {
            await mcpApp.openLink({ url: fileUrl });
            showToast(tr('monitor.asset.openRequested'));
            return;
          } catch {
            /* fallback to clipboard */
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
  }

  function resetCache() {
    lastKvSig = '';
    lastAlertsSig = '';
    lastBreakdownSig = '';
    lastDeferredSig = '';
    lastInventorySig = '';
  }

  return {
    computeGeminiKvState,
    syncKvCountdownUi,
    startKvCountdownTimer,
    stopKvCountdownTimer,
    renderContext,
    renderContextModelSim,
    highlightCtx,
    handleAlertJump,
    openAssetInspector,
    bindEvents,
    resetCache,
  };
}
