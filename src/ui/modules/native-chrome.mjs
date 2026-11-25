/**
 * Native WebView2 Frameless Chrome, Three-State Window Controller (console / minibar / orb),
 * 4px Drag Threshold Gesture State Machine (§3.3), Two-Stage GPU Transitions (§5.4),
 * and Zero-Reflow Mini-Bar Layout Fitter (§3.5).
 */

import { esc, formatShortModel, prefersReducedMotion } from '../core/dom.mjs';
import { getMiniBarModules, parseSizeDimensions } from '../core/store.mjs';
import { renderIcon } from '../components/icons.mjs';

const MODE_SIZE_RANK = { orb: 0, minibar: 1, console: 2 };
const chipWidthCache = new Map();
const CHIP_WIDTH_CACHE_MAX = 256;
const ORB_RING_RADIUS = 19;
const ORB_RING_CIRCUMFERENCE = 2 * Math.PI * ORB_RING_RADIUS;

export function postHostWindowMsg(cmd) {
  try {
    window.chrome?.webview?.postMessage?.(String(cmd));
  } catch {
    /* ignore outside native WebView2 host */
  }
}

/**
 * Pure text-length chip width estimator (§3.5):
 * ASCII/mono 7.2px, CJK 12px, padding/dot 26px (cached; zero DOM reflow).
 */
export function estimateChipWidthPx(text, { hasDot = false } = {}) {
  const str = String(text || '');
  const key = `${hasDot ? 1 : 0}|${str}`;
  const cached = chipWidthCache.get(key);
  if (cached !== undefined) return cached;

  let w = hasDot ? 26 : 18;
  for (const ch of str) {
    w += ch.charCodeAt(0) > 127 ? 12 : 7.2;
  }
  const px = Math.ceil(w);

  if (chipWidthCache.size >= CHIP_WIDTH_CACHE_MAX) {
    const first = chipWidthCache.keys().next().value;
    if (first !== undefined) chipWidthCache.delete(first);
  }
  chipWidthCache.set(key, px);
  return px;
}

/**
 * Pure zero-reflow chip visibility planner (§3.5):
 * Given available horizontal width and ordered chips, returns visibility & model mode
 * without touching the DOM during computation.
 */
export function computeMiniBarFitPlan({ chips, availWidth, gap = 5 }) {
  const available = chips.filter((c) => c.available !== false);
  const result = new Map();
  for (const c of chips) {
    result.set(c.mod, { visible: false, useShortModel: false });
  }
  if (!available.length || availWidth <= 0) return result;

  const measureTotal = (list, useShort) => {
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const text = c.mod === 'model' && useShort && c.shortText ? c.shortText : c.text;
      total += estimateChipWidthPx(text, { hasDot: c.mod === 'kv' });
      if (i > 0) total += gap;
    }
    return total;
  };

  // 1. All full chips fit
  if (measureTotal(available, false) <= availWidth) {
    for (const c of available) {
      result.set(c.mod, { visible: true, useShortModel: false });
    }
    return result;
  }

  // 2. Try compact model name first before hiding any trailing chip
  let useShortModel = true;
  if (measureTotal(available, true) <= availWidth) {
    for (const c of available) {
      result.set(c.mod, { visible: true, useShortModel: c.mod === 'model' });
    }
    return result;
  }

  // 3. Accumulate from highest priority (left) to lowest (right), hiding trailing chips cleanly
  let used = 0;
  for (let i = 0; i < available.length; i++) {
    const c = available[i];
    const text = c.mod === 'model' && useShortModel && c.shortText ? c.shortText : c.text;
    const w = estimateChipWidthPx(text, { hasDot: c.mod === 'kv' });
    const nextUsed = used === 0 ? w : used + gap + w;
    if (nextUsed <= availWidth || i === 0) {
      used = nextUsed;
      result.set(c.mod, { visible: true, useShortModel: c.mod === 'model' && useShortModel });
    } else {
      break;
    }
  }
  return result;
}

/**
 * §3.3 Frontend 4px Drag Threshold Gesture State Machine:
 * Preserves click/dblclick/contextmenu when pointer moves < 4px;
 * hands off to native Win32 WM_NCLBUTTONDOWN drag immediately once >= 4px.
 */
export function bindNativeDragSurface(
  el,
  {
    ignoreSelector = 'button',
    onSingleClick = null,
    onDoubleClick = null,
    onContextMenu = null,
    onDragStart = () => postHostWindowMsg('drag'),
    thresholdPx = 4,
    singleClickDelayMs = 180,
    hostWindow = typeof window !== 'undefined' ? window : null,
  } = {}
) {
  if (!el || !hostWindow) return () => {};

  let clickTimer = null;
  let suppressNextClick = false;
  let activeCleanup = null;

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return;

    const startScreenX = Number(e.screenX) || 0;
    const startScreenY = Number(e.screenY) || 0;
    let dragging = false;

    const detach = () => {
      hostWindow.removeEventListener('pointermove', onPointerMove);
      hostWindow.removeEventListener('pointerup', onPointerUp);
      hostWindow.removeEventListener('pointercancel', onPointerUp);
      activeCleanup = null;
    };

    const onPointerMove = (mv) => {
      if (dragging) return;
      const dx = (Number(mv.screenX) || 0) - startScreenX;
      const dy = (Number(mv.screenY) || 0) - startScreenY;
      if (Math.hypot(dx, dy) >= thresholdPx) {
        dragging = true;
        suppressNextClick = true;
        clearTimeout(clickTimer);
        clickTimer = null;
        detach();
        onDragStart?.(mv);
      }
    };

    const onPointerUp = () => {
      detach();
      if (dragging) {
        setTimeout(() => {
          suppressNextClick = false;
        }, 0);
      }
    };

    activeCleanup?.();
    activeCleanup = detach;
    hostWindow.addEventListener('pointermove', onPointerMove);
    hostWindow.addEventListener('pointerup', onPointerUp);
    hostWindow.addEventListener('pointercancel', onPointerUp);
  };

  const onClick = (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return;
    if (!onSingleClick) return;

    if (onDoubleClick) {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        onSingleClick(e);
      }, singleClickDelayMs);
    } else {
      onSingleClick(e);
    }
  };

  const onDblClick = (e) => {
    if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return;
    clearTimeout(clickTimer);
    clickTimer = null;
    if (onDoubleClick) {
      e.preventDefault?.();
      onDoubleClick(e);
    }
  };

  const onContext = (e) => {
    if (!onContextMenu) return;
    e.preventDefault?.();
    onContextMenu(e);
  };

  el.addEventListener('pointerdown', onPointerDown);
  if (onSingleClick || onDoubleClick) {
    el.addEventListener('click', onClick);
  }
  if (onDoubleClick) {
    el.addEventListener('dblclick', onDblClick);
  }
  if (onContextMenu) {
    el.addEventListener('contextmenu', onContext);
  }

  return () => {
    clearTimeout(clickTimer);
    activeCleanup?.();
    el.removeEventListener('pointerdown', onPointerDown);
    if (onSingleClick || onDoubleClick) el.removeEventListener('click', onClick);
    if (onDoubleClick) el.removeEventListener('dblclick', onDblClick);
    if (onContextMenu) el.removeEventListener('contextmenu', onContext);
  };
}

export function createNativeChromeModule({
  state,
  tr,
  getUiLang,
  isNativePopout = false,
  popoutToken = null,
  popoutClientId = null,
  persistConfigPatch,
  showToast,
  onSessionFollowSwitch,
  onSizeMoveChange,
  onModeChanged,
  postMsg = postHostWindowMsg,
}) {
  let lastTitleBarSig = '';
  let lastOrbTip = '';
  let lastOrbStateSig = '';
  let heartbeatTimer = null;
  let lastHeartbeatAt = 0;
  let lastSavedBoundsKey = '';
  let modeTransitionTimer = null;
  const cleanups = [];

  function scheduleFit() {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => fitNativeTitleBar());
    }
  }

  function resetCache() {
    lastTitleBarSig = '';
    lastOrbTip = '';
    lastOrbStateSig = '';
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

  function updateCollapseButtonIcon() {
    const minSvg = document.getElementById('winMinSvg');
    if (!minSvg) return;
    const isMini = state.windowMode === 'minibar';
    minSvg.innerHTML = isMini
      ? '<path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M4 10l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function getSurfaceElement(mode) {
    if (mode === 'orb') return document.getElementById('orbView');
    if (mode === 'minibar') return document.getElementById('nativeTitleBar');
    return document.getElementById('appShell');
  }

  /**
   * §5.4 Two-Stage Zero-Clip Three-State Transitions (console <-> minibar <-> orb).
   */
  function setWindowMode(targetMode, { fromHost = false } = {}) {
    const nextMode = MODE_SIZE_RANK[targetMode] !== undefined ? targetMode : 'console';
    const prevMode = state.windowMode || 'console';
    clearTimeout(modeTransitionTimer);

    const applyModeState = () => {
      state.windowMode = nextMode;
      state.windowCollapsed = nextMode === 'minibar';
      if (typeof document !== 'undefined') {
        document.body.dataset.winMode = nextMode;
        document.body.classList.toggle('window-collapsed', nextMode === 'minibar');
        document.getElementById('titleBarMiniModules')?.classList.toggle('hidden', nextMode !== 'minibar');
      }
      updateCollapseButtonIcon();
      if (nextMode === 'minibar' || nextMode === 'console') {
        scheduleFit();
      }
      onModeChanged?.(nextMode, prevMode);
    };

    const nativeOrbMorph = isNativePopout && (nextMode === 'orb' || prevMode === 'orb');
    if (fromHost || prevMode === nextMode || nativeOrbMorph || prefersReducedMotion()) {
      applyModeState();
      if (!fromHost) {
        postMsg(nextMode === 'minibar' ? 'mode:minibar:40' : `mode:${nextMode}`);
      }
      return;
    }

    const shrinking = MODE_SIZE_RANK[nextMode] < MODE_SIZE_RANK[prevMode];
    const prevEl = getSurfaceElement(prevMode);
    const nextEl = getSurfaceElement(nextMode);

    if (shrinking) {
      // Stage 1: gracefully fade & scale out current surface before shrinking HWND
      prevEl?.classList.add('surface-exit');
      modeTransitionTimer = setTimeout(() => {
        prevEl?.classList.remove('surface-exit');
        applyModeState();
        postMsg(nextMode === 'minibar' ? 'mode:minibar:40' : `mode:${nextMode}`);
        if (nextEl) {
          nextEl.classList.remove('surface-enter');
          requestAnimationFrame(() => nextEl.classList.add('surface-enter'));
        }
      }, 110);
    } else {
      // Expanding: resize HWND first while target surface starts hidden/scaled, then reveal cleanly
      applyModeState();
      if (nextEl) {
        nextEl.classList.remove('surface-expand-active');
        nextEl.classList.add('surface-expand-init');
      }
      postMsg(nextMode === 'minibar' ? 'mode:minibar:40' : `mode:${nextMode}`);
      requestAnimationFrame(() => {
        if (!nextEl) return;
        nextEl.classList.remove('surface-expand-init');
        nextEl.classList.add('surface-expand-active');
        modeTransitionTimer = setTimeout(() => {
          nextEl.classList.remove('surface-expand-active');
        }, 260);
      });
    }
  }

  /**
   * §3.5 Zero-Reflow Titlebar / Mini-Bar Fitter:
   * Single container width read -> pure width calculation -> single batch DOM class write.
   */
  function fitNativeTitleBar() {
    if (typeof document === 'undefined') return;
    const titleBar = document.getElementById('nativeTitleBar');
    const dragZone = document.getElementById('titleBarDragZone');
    if (!titleBar || !dragZone || titleBar.classList.contains('hidden')) return;

    const nameEl = dragZone.querySelector('.native-titlebar-name');
    const miniModsEl = document.getElementById('titleBarMiniModules');
    const tpsEl = document.getElementById('titleBarTpsBadge');
    const modelEl = document.getElementById('titleBarModelBadge');
    const actionsEl = titleBar.querySelector('.native-titlebar-actions');
    const brandIconEl = document.getElementById('titleBarBrandIcon');

    // Single read phase (zero interleaved writes)
    const barW = titleBar.clientWidth || window.innerWidth || 360;
    const actionsW = actionsEl ? actionsEl.clientWidth : 132;
    const brandW = brandIconEl ? brandIconEl.clientWidth || 18 : 18;
    const availW = Math.max(60, barW - actionsW - brandW - 28);

    if (state.windowMode === 'minibar' || state.windowCollapsed) {
      nameEl?.classList.add('titlebar-fit-hidden');
      miniModsEl?.classList.remove('hidden');
      if (!miniModsEl) return;

      const chipEls = [...miniModsEl.querySelectorAll('.mini-mod-chip')];
      const chipSpecs = chipEls.map((el) => ({
        mod: el.dataset.mod,
        available: el.dataset.available !== 'false',
        text: el.dataset.fullModel || el.dataset.text || el.textContent || '',
        shortText: el.dataset.shortModel || '',
      }));

      const plan = computeMiniBarFitPlan({ chips: chipSpecs, availWidth: availW, gap: 5 });

      // Single write phase
      for (const el of chipEls) {
        const entry = plan.get(el.dataset.mod) || { visible: false, useShortModel: false };
        el.classList.toggle('titlebar-fit-hidden', !entry.visible);
        if (el.dataset.mod === 'model' && el.dataset.fullModel) {
          const desiredText = entry.useShortModel && el.dataset.shortModel ? el.dataset.shortModel : el.dataset.fullModel;
          if (el.textContent !== desiredText) el.textContent = desiredText;
        }
      }
      return;
    }

    // Expanded console titlebar mode (zero read-after-write loop)
    miniModsEl?.classList.add('hidden');
    nameEl?.classList.remove('titlebar-fit-hidden');

    const nameW = nameEl ? estimateChipWidthPx(nameEl.textContent || 'Antigravity Hub') : 112;
    const hasTps = Boolean(tpsEl && !tpsEl.classList.contains('hidden'));
    const hasModel = Boolean(modelEl && modelEl.dataset.fullModel && !modelEl.classList.contains('hidden'));
    const tpsW = hasTps ? estimateChipWidthPx(tpsEl.textContent || '') : 0;
    const fullModelW = hasModel ? estimateChipWidthPx(modelEl.dataset.fullModel) : 0;
    const shortModelW = hasModel ? estimateChipWidthPx(modelEl.dataset.shortModel || modelEl.dataset.fullModel) : 0;

    let showTps = hasTps;
    let showModel = hasModel;
    let useShort = false;

    const totalFull = nameW + (showTps ? tpsW + 8 : 0) + (showModel ? fullModelW + 8 : 0);
    if (totalFull > availW) {
      const totalShort = nameW + (showTps ? tpsW + 8 : 0) + (showModel ? shortModelW + 8 : 0);
      if (showModel && totalShort <= availW) {
        useShort = true;
      } else {
        showModel = false;
        if (nameW + (showTps ? tpsW + 8 : 0) > availW) {
          showTps = false;
        }
      }
    }

    if (tpsEl) tpsEl.classList.toggle('titlebar-fit-hidden', !showTps);
    if (modelEl) {
      modelEl.classList.toggle('titlebar-fit-hidden', !showModel);
      if (showModel) {
        const nextTxt = useShort ? modelEl.dataset.shortModel : modelEl.dataset.fullModel;
        if (modelEl.textContent !== nextTxt) modelEl.textContent = nextTxt;
      }
    }
  }

  function renderCollapsedMiniModules(ctx, pct, cache, tps, followTag, kv) {
    const host = document.getElementById('titleBarMiniModules');
    if (!host) return;
    const order = getMiniBarModules(state);
    const activeModel = String(
      ctx?.latestModel || ((Number(ctx?.totalCallsCount) || 0) > 0 ? ctx?.model : '') || ''
    ).trim();
    const hasCalls = (Number(ctx?.totalCallsCount) || 0) > 0;
    const lang = getUiLang();

    host.innerHTML = order
      .map((mod) => {
        if (mod === 'context') {
          const label = `${pct.toFixed(1)}%`;
          return `<span class="mini-mod-chip mono-num" data-mod="context" data-available="true" data-text="${esc(label)}" title="${esc(tr('titlebar.miniSummaryTitle', { pct: pct.toFixed(1), cache: cache.toFixed(1), mode: followTag }))}">${esc(label)}</span>`;
        }
        if (mod === 'cache') {
          const label = lang === 'en' ? `${cache.toFixed(0)}% Hit` : `${cache.toFixed(0)}% 缓存`;
          return `<span class="mini-mod-chip mono-num" data-mod="cache" data-available="true" data-text="${esc(label)}" title="${esc(tr('titlebar.miniSummaryTitle', { pct: pct.toFixed(1), cache: cache.toFixed(1), mode: followTag }))}">${esc(label)}</span>`;
        }
        if (mod === 'kv') {
          const kvText = kv?.text || '--:--';
          const kvVis = Boolean(kv?.visible);
          const kvSt = kvVis ? kv.state : 'muted';
          return `<span class="mini-mod-chip mono-num" data-mod="kv" data-available="${kvVis ? 'true' : 'false'}" data-kv-state="${esc(kvSt)}" data-text="${esc(kvText)}" title="${esc(kv?.title || '')}"><span class="mini-mod-dot" aria-hidden="true"></span><span class="mini-mod-val">${esc(kvText)}</span></span>`;
        }
        if (mod === 'tps') {
          const text = hasCalls || tps > 0 ? `${tps.toFixed(1)} t/s` : '-- t/s';
          const tone = hasCalls || tps > 0 ? (tps < 15 ? 'warn' : 'ok') : 'muted';
          return `<span class="mini-mod-chip mono-num" data-mod="tps" data-available="true" data-tone="${tone}" data-text="${esc(text)}" title="${esc(hasCalls || tps > 0 ? tr('titlebar.tpsBadgeTitle', { tps: tps.toFixed(1), mode: followTag }) : tr('titlebar.tpsWaitingTitle', { mode: followTag }))}">${esc(text)}</span>`;
        }
        if (mod === 'model') {
          const shortM = activeModel ? formatShortModel(activeModel) : '';
          return `<span class="mini-mod-chip mono-num" data-mod="model" data-available="${activeModel ? 'true' : 'false'}" data-full-model="${esc(activeModel)}" data-short-model="${esc(shortM)}" data-text="${esc(activeModel)}" title="${esc(activeModel ? tr('titlebar.modelBadgeTitle', { model: activeModel, mode: followTag }) : '')}">${esc(activeModel)}</span>`;
        }
        return '';
      })
      .join('');
  }

  function updateOrbView(ctx, { pct = 0, cache = 0, kv = null, health = 'safe' } = {}) {
    const ratio =
      kv && kv.visible && typeof kv.ratio === 'number' && kv.state !== 'safe'
        ? Math.max(0.05, Math.min(1, kv.ratio))
        : Math.max(0.05, Math.min(1, (Number(pct) || 0) / 100));
    const activeTurn = Boolean(ctx?.isTurnActive);

    if (typeof document !== 'undefined') {
      const orb = document.getElementById('orbView');
      if (orb) {
        orb.dataset.health = health;
        orb.dataset.activeTurn = String(activeTurn);
        const progressCircle = orb.querySelector('.orb-ring-progress');
        if (progressCircle) {
          const offset = ORB_RING_CIRCUMFERENCE * (1 - ratio);
          progressCircle.setAttribute('stroke-dasharray', ORB_RING_CIRCUMFERENCE.toFixed(2));
          progressCircle.style.strokeDashoffset = offset.toFixed(2);
        }
        const brandSvg = orb.querySelector('.hub-brand-svg');
        if (brandSvg) {
          brandSvg.dataset.health = health;
          brandSvg.dataset.kvState = health;
        }
      }
    }

    if (isNativePopout) {
      const lang = getUiLang();
      const parts = [
        lang === 'en' ? `Ctx ${(Number(pct) || 0).toFixed(1)}%` : `上下文 ${(Number(pct) || 0).toFixed(1)}%`,
        lang === 'en' ? `Cache ${(Number(cache) || 0).toFixed(0)}%` : `缓存 ${(Number(cache) || 0).toFixed(0)}%`,
      ];
      if (kv?.visible && kv.text) parts.push(`KV ${kv.text}`);
      const tipText = parts.join(' | ');
      if (tipText !== lastOrbTip) {
        lastOrbTip = tipText;
        postMsg(`orb:tip:${tipText}`);
      }
      const orbStateSig = `${ratio.toFixed(3)}|${health}|${activeTurn ? 1 : 0}|${tipText}`;
      if (orbStateSig !== lastOrbStateSig) {
        lastOrbStateSig = orbStateSig;
        postMsg(
          `orb:state:${JSON.stringify({
            ratio: Number(ratio.toFixed(3)),
            health,
            active: activeTurn,
            tip: tipText,
          })}`
        );
      }
    }
  }

  function updateNativeTitleBarTelemetry(ctx, { pct = 0, cache = 0, tps = 0, kv = null, health = 'safe' } = {}) {
    updateOrbView(ctx, { pct, cache, kv, health });
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

    const activeModel = String(
      ctx?.latestModel || ((Number(ctx?.totalCallsCount) || 0) > 0 ? ctx?.model : '') || ''
    ).trim();
    const hasCalls = (Number(ctx?.totalCallsCount) || 0) > 0;
    const modOrder = getMiniBarModules(state).join(',');
    const kvSig = kv ? `${kv.visible ? 1 : 0}:${kv.state}:${kv.text}` : '0';
    const titleBarSig = `${getUiLang()}|${followTag}|${pct.toFixed(1)}|${cache.toFixed(1)}|${tps.toFixed(1)}|${activeModel}|${hasCalls ? 1 : 0}|${modOrder}|${kvSig}`;
    if (titleBarSig === lastTitleBarSig) return;
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

    renderCollapsedMiniModules(ctx, pct, cache, tps, followTag, kv);
    scheduleFit();
  }

  function setSharedWidth(logicalWidth) {
    const safeW = Math.max(360, Math.min(1200, Math.round(Number(logicalWidth) || 460)));
    postMsg(`setwidth:${safeW}`);
    scheduleFit();
  }

  function sendClosingBeacon() {
    if (!popoutToken || !popoutClientId) return;
    const url = `/api/popout/closing?token=${encodeURIComponent(popoutToken)}&clientId=${encodeURIComponent(popoutClientId)}`;
    const payload = JSON.stringify({ clientId: popoutClientId });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    } else if (typeof fetch === 'function') {
      fetch(url, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
    }
  }

  function handleHostMessage(rawData) {
    let msg = rawData;
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'host:state') {
      if (typeof msg.pinned === 'boolean') {
        state.windowPinned = msg.pinned;
        renderNativePinButton();
      }
      if (typeof msg.maximized === 'boolean') state.windowMaximized = msg.maximized;
      if (Number.isFinite(Number(msg.dpiScale))) state.dpiScale = Number(msg.dpiScale);
      if (msg.mode && MODE_SIZE_RANK[msg.mode] !== undefined && msg.mode !== state.windowMode) {
        setWindowMode(msg.mode, { fromHost: true });
      }
      if (state.windowMode === 'minibar' || state.windowMode === 'console') {
        scheduleFit();
      }
      return;
    }

    if (msg.type === 'host:sizemove') {
      const active = Boolean(msg.active);
      state.sizeMoveActive = active;
      onSizeMoveChange?.(active);

      if (!active) {
        const mode = MODE_SIZE_RANK[msg.mode] !== undefined ? msg.mode : state.windowMode;
        const patch = { popout: { windowMode: mode } };
        if (mode === 'orb') {
          if (Number.isFinite(Number(msg.orbX)) && Number.isFinite(Number(msg.orbY))) {
            patch.popout.orbPosition = { x: Math.round(Number(msg.orbX)), y: Math.round(Number(msg.orbY)) };
          } else if (Number.isFinite(Number(msg.x)) && Number.isFinite(Number(msg.y))) {
            patch.popout.orbPosition = { x: Math.round(Number(msg.x)), y: Math.round(Number(msg.y)) };
          }
        } else {
          const curDims = parseSizeDimensions(state.config?.popout?.size || '460x720');
          const nextW = Number.isFinite(Number(msg.logicalWidth))
            ? Math.max(360, Math.min(1600, Math.round(Number(msg.logicalWidth))))
            : curDims.width;
          const nextH =
            mode === 'console' && Number.isFinite(Number(msg.logicalHeight)) && Number(msg.logicalHeight) >= 460
              ? Math.max(460, Math.min(1200, Math.round(Number(msg.logicalHeight))))
              : curDims.height;
          patch.popout.size = `${nextW}x${nextH}`;
          if (Number.isFinite(Number(msg.x)) && Number.isFinite(Number(msg.y))) {
            patch.popout.position = { x: Math.round(Number(msg.x)), y: Math.round(Number(msg.y)) };
          }
        }
        const key = JSON.stringify(patch);
        if (key !== lastSavedBoundsKey) {
          lastSavedBoundsKey = key;
          void persistConfigPatch?.(patch).catch(() => {});
        }
        scheduleFit();
      }
      return;
    }

    if (msg.type === 'host:dpi' && Number.isFinite(Number(msg.dpiScale))) {
      state.dpiScale = Number(msg.dpiScale);
      scheduleFit();
      return;
    }

    if (msg.type === 'host:action' && msg.action === 'request_close') {
      sendClosingBeacon();
      postMsg('close');
      window.close();
    }
  }

  function setupNativeFramelessChrome() {
    if (!isNativePopout) return;
    document.body.classList.add('native-popout');
    document.body.dataset.winMode = state.windowMode || 'console';
    document.getElementById('appShell')?.classList.add('scroll-thin');
    document.getElementById('nativeTitleBar')?.classList.remove('hidden');
    document.getElementById('nativeResizeHandles')?.classList.remove('hidden');
    renderNativePinButton();
    updateCollapseButtonIcon();

    // Listen to Win32 host JSON messages (host:state, host:sizemove, host:action, host:dpi)
    const onWebViewMessage = (e) => handleHostMessage(e?.data);
    try {
      window.chrome?.webview?.addEventListener?.('message', onWebViewMessage);
      cleanups.push(() => window.chrome?.webview?.removeEventListener?.('message', onWebViewMessage));
    } catch {
      /* outside WebView2 */
    }

    const titleBar = document.getElementById('nativeTitleBar');
    if (titleBar) {
      if (typeof ResizeObserver === 'function') {
        const titleBarRo = new ResizeObserver(() => scheduleFit());
        titleBarRo.observe(titleBar);
        cleanups.push(() => titleBarRo.disconnect());
      }
      cleanups.push(
        bindNativeDragSurface(titleBar, {
          ignoreSelector: 'button',
          onDragStart: () => postMsg('drag'),
          onDoubleClick: () => {
            if (state.windowMode === 'minibar') {
              setWindowMode('console');
            } else {
              postMsg('max');
            }
          },
        })
      );
    }

    document.querySelectorAll('.agy-header').forEach((headerEl) => {
      cleanups.push(
        bindNativeDragSurface(headerEl, {
          ignoreSelector: 'button, input, textarea, a, .agy-select-wrap, .seg-nav, .acc-body',
          onDragStart: () => postMsg('drag'),
        })
      );
    });

    // 48px Floating Orb gesture binding (§3.3)
    const orbEl = document.getElementById('orbView');
    if (orbEl) {
      cleanups.push(
        bindNativeDragSurface(orbEl, {
          ignoreSelector: '',
          onDragStart: () => postMsg('drag'),
          onSingleClick: () => setWindowMode('minibar'),
          onDoubleClick: () => setWindowMode('console'),
          onContextMenu: () => postMsg('orb:menu'),
        })
      );
    }

    document.querySelectorAll('#nativeResizeHandles .win-resize').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const ht = handle.dataset.ht;
        if (ht) postMsg(`resize:${ht}`);
      });
    });

    document.getElementById('winPinBtn')?.addEventListener('click', () => {
      state.windowPinned = !state.windowPinned;
      postMsg(state.windowPinned ? 'pin:1' : 'pin:0');
      renderNativePinButton();
      void persistConfigPatch?.({ popout: { alwaysOnTop: state.windowPinned } }).catch(() => {});
      showToast(state.windowPinned ? tr('toast.pinnedTop') : tr('toast.unpinnedTop'));
    });

    document.getElementById('winMinBtn')?.addEventListener('click', () => {
      setWindowMode(state.windowMode === 'minibar' ? 'console' : 'minibar');
    });

    // Minimize enters 48px floating orb (never OS minimize!)
    document.getElementById('winMinimizeBtn')?.addEventListener('click', () => {
      setWindowMode('orb');
    });

    document.getElementById('winMaxBtn')?.addEventListener('click', () => {
      if (state.windowMode !== 'console') {
        setWindowMode('console');
      } else {
        postMsg('max');
      }
    });

    document.getElementById('winCloseBtn')?.addEventListener('click', () => {
      sendClosingBeacon();
      postMsg('close');
      window.close();
    });
  }

  function startPopoutClientLifecycle() {
    if (!popoutToken || !popoutClientId) return;

    const sendHeartbeat = async (force = false) => {
      const now = Date.now();
      if (!force && document.visibilityState !== 'visible' && state.windowMode !== 'orb' && now - lastHeartbeatAt < 10000) return;
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
          onSessionFollowSwitch?.(data.activeConversationId);
        }
      } catch {
        /* ignore transient heartbeat failure */
      }
    };

    void sendHeartbeat(true);
    heartbeatTimer = setInterval(() => void sendHeartbeat(false), 5000);

    let closingSent = false;
    const onClose = () => {
      if (closingSent) return;
      closingSent = true;
      sendClosingBeacon();
    };
    window.addEventListener('pagehide', onClose);
    window.addEventListener('beforeunload', onClose);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void sendHeartbeat(true);
      }
    });
  }

  function destroy() {
    clearTimeout(modeTransitionTimer);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    while (cleanups.length) {
      const fn = cleanups.pop();
      fn?.();
    }
  }

  return {
    setupNativeFramelessChrome,
    startPopoutClientLifecycle,
    setWindowMode,
    fitNativeTitleBar,
    updateNativeTitleBarTelemetry,
    updateOrbView,
    handleHostMessage,
    renderNativePinButton,
    setSharedWidth,
    resetCache,
    destroy,
  };
}

export { renderIcon };
