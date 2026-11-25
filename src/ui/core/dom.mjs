/**
 * Shared DOM, formatting, GPU animation, floating layer clamping,
 * cached text measurement, and single-rAF resize scheduler utilities.
 */

const activeAnims = new WeakMap();
const textWidthCache = new Map();
const TEXT_WIDTH_CACHE_MAX = 1024;
let textMeasureCanvasCtx = null;
let toastTimer = null;

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtK(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(Math.round(num));
}

export function fmtHrs(hrs, lang = 'zh-CN') {
  const hTotal = Math.max(0, Math.round(Number(hrs) || 0));
  const d = Math.floor(hTotal / 24);
  const h = hTotal % 24;
  if (lang === 'en') {
    return d > 0 ? `Resets in ${d}d ${h}h` : `Resets in ${h}h`;
  }
  return d > 0 ? `将在 ${d} 天 ${h} 小时后完全重置` : `将在 ${h} 小时后完全重置`;
}

export function fmtRelativeTime(iso, trFn) {
  const translate = typeof trFn === 'function' ? trFn : (k) => k;
  if (!iso) return translate('common.justNow');
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return translate('common.justNow');
  if (diffSec < 3600) return translate('common.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return translate('common.hoursAgo', { n: Math.floor(diffSec / 3600) });
  return translate('common.daysAgo', { n: Math.floor(diffSec / 86400) });
}

export function formatShortModel(model) {
  const m = String(model || '').trim();
  if (!m) return '—';
  return m
    .replace(/^gemini-/i, '')
    .replace(/^claude-/i, '')
    .replace(/-tiered-/i, '-')
    .replace(/hydrogen/i, 'hydro')
    .replace(/-xhigh$/i, '-xh')
    .replace(/-high$/i, '-H')
    .replace(/-medium$/i, '-M')
    .replace(/-low$/i, '-L');
}

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function showToast(msg, tone = 'info') {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.tone = tone || 'info';
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = 'false';
  }, 2600);
}

export function animateNumber(el, from, to, fmt, dur = 220, { paused = false } = {}) {
  if (!el) return;
  if (activeAnims.has(el)) cancelAnimationFrame(activeAnims.get(el));
  if (
    paused ||
    prefersReducedMotion() ||
    !Number.isFinite(from) ||
    Math.abs(to - from) < 0.0001 ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  ) {
    el.textContent = fmt(to);
    return;
  }
  const safeDur = Math.max(80, Math.min(250, Number(dur) || 220));
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / safeDur);
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

export function pulseEl(el) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove('kpi-bump');
  requestAnimationFrame(() => {
    el.classList.add('kpi-bump');
  });
}

export function pulseTargetEl(el) {
  if (!el) return;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
  if (prefersReducedMotion()) return;
  el.classList.remove('jump-highlight-pulse');
  requestAnimationFrame(() => {
    el.classList.add('jump-highlight-pulse');
    setTimeout(() => el.classList.remove('jump-highlight-pulse'), 1600);
  });
}

/**
 * GPU-composited segmented indicator positioning (translateX + scaleX, zero width transition).
 */
export function positionIndicator(navId, indId) {
  if (typeof document === 'undefined') return;
  const nav = document.getElementById(navId);
  const ind = document.getElementById(indId);
  if (!nav || !ind) return;
  const active = nav.querySelector('[data-active="true"]');
  if (!active || active.offsetWidth === 0) return;
  const w = active.offsetWidth;
  const left = active.offsetLeft;
  let baseW = Number(ind.dataset.baseWidth) || 0;
  if (!baseW) {
    baseW = w;
    ind.dataset.baseWidth = String(baseW);
    ind.style.width = `${baseW}px`;
  }
  const scaleX = baseW > 0 ? w / baseW : 1;
  ind.style.transform = `translateX(${left}px) scaleX(${scaleX.toFixed(4)})`;
}

export function measureTextPx(text, fontSpec) {
  const str = String(text || '');
  if (!str) return 0;
  const key = `${fontSpec}\u0000${str}`;
  const cached = textWidthCache.get(key);
  if (cached !== undefined) return cached;

  let width = 0;
  let measured = false;
  try {
    if (!textMeasureCanvasCtx && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      textMeasureCanvasCtx = c.getContext?.('2d') || null;
    }
    if (textMeasureCanvasCtx) {
      textMeasureCanvasCtx.font = fontSpec;
      width = Math.ceil(textMeasureCanvasCtx.measureText(str).width);
      measured = true;
    }
  } catch {
    /* canvas unavailable in non-DOM test environment */
  }

  if (!measured) {
    const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(String(fontSpec || ''));
    const px = sizeMatch ? Number(sizeMatch[1]) : 12;
    let acc = 0;
    for (const ch of str) {
      acc += ch.charCodeAt(0) > 127 ? px : px * 0.62;
    }
    width = Math.ceil(acc);
  }

  if (textWidthCache.size >= TEXT_WIDTH_CACHE_MAX) {
    const firstKey = textWidthCache.keys().next().value;
    if (firstKey !== undefined) textWidthCache.delete(firstKey);
  }
  textWidthCache.set(key, width);
  return width;
}

export function clearTextMeasureCache() {
  textWidthCache.clear();
}

export function positionFloatingLayer(
  triggerEl,
  layerEl,
  { alignRight = false, maxWidthCap = 340, maxHeightCap = 320, gap = 6, pad = 8, matchTriggerMinWidth = true } = {}
) {
  if (!triggerEl || !layerEl) return;
  const vw = window.innerWidth || document.documentElement.clientWidth || 360;
  const vh = window.innerHeight || document.documentElement.clientHeight || 480;
  const tRect = triggerEl.getBoundingClientRect();
  if (tRect.width === 0 && tRect.height === 0) return;

  const availW = Math.max(160, vw - pad * 2);
  const cappedW = Math.min(maxWidthCap, availW);
  const minW = matchTriggerMinWidth ? Math.min(Math.round(tRect.width), cappedW) : 0;

  layerEl.dataset.fixed = 'true';
  layerEl.style.position = 'fixed';
  layerEl.style.right = 'auto';
  layerEl.style.bottom = 'auto';
  layerEl.style.minWidth = minW > 0 ? `${minW}px` : '';
  layerEl.style.maxWidth = `${cappedW}px`;
  layerEl.style.left = `${pad}px`;
  layerEl.style.top = `${pad}px`;

  const measuredW = Math.min(Math.ceil(layerEl.getBoundingClientRect().width), cappedW);
  const rawLeft = alignRight ? tRect.right - measuredW : tRect.left;
  const clampedLeft = Math.max(pad, Math.min(rawLeft, vw - pad - measuredW));

  const spaceBelow = Math.max(0, vh - tRect.bottom - gap - pad);
  const spaceAbove = Math.max(0, tRect.top - gap - pad);
  const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
  const availH = Math.max(110, Math.min(maxHeightCap, flipUp ? spaceAbove : spaceBelow));

  layerEl.style.maxHeight = `${Math.floor(availH)}px`;
  const renderedH = Math.min(Math.ceil(layerEl.scrollHeight) + 2, availH);
  const clampedTop = flipUp
    ? Math.max(pad, tRect.top - gap - renderedH)
    : Math.max(pad, Math.min(tRect.bottom + gap, vh - pad - Math.min(renderedH, 44)));

  layerEl.style.left = `${Math.round(clampedLeft)}px`;
  layerEl.style.top = `${Math.round(clampedTop)}px`;
  layerEl.style.transformOrigin = `${flipUp ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`;
}

export function clampOpenSelectMenus() {
  if (typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    document.querySelectorAll('.agy-select-menu[data-open="true"]').forEach((menu) => {
      const wrap = menu.closest('.agy-select-wrap');
      const trigger = wrap?.querySelector('.agy-select-trigger');
      if (!trigger) return;
      const isSession = wrap?.id === 'sessionSelectHost';
      const triggerW = trigger.getBoundingClientRect().width || 240;
      const maxWidthCap = isSession
        ? Math.min(420, Math.max(320, Math.round(triggerW)))
        : Math.max(340, Math.round(triggerW));
      menu.classList.add('scroll-thin');
      positionFloatingLayer(trigger, menu, {
        alignRight: menu.classList.contains('align-right'),
        maxWidthCap,
        maxHeightCap: isSession ? 340 : 280,
      });
    });
  });
}

export function clampOpenKvPopovers() {
  if (typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    document.querySelectorAll('.kv-help-popover:not(.hidden)').forEach((pop) => {
      const wrap = pop.closest('.kv-pill-wrap, .kv-help-inline-wrap');
      const trigger = wrap?.querySelector('.kv-help-btn') || wrap;
      if (!trigger) return;
      positionFloatingLayer(trigger, pop, {
        alignRight: !pop.classList.contains('kv-help-popover-left'),
        maxWidthCap: 300,
        maxHeightCap: 260,
        gap: 8,
        pad: 10,
        matchTriggerMinWidth: false,
      });
    });
  });
}

export function clampHelpTip(wrap) {
  const pop = wrap?.querySelector('.help-tip-pop');
  if (!pop) return;
  pop.style.left = '';
  pop.style.right = '0px';
  const rect = pop.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 360;
  const pad = 10;
  if (rect.left < pad) {
    pop.style.right = `${-(pad - rect.left)}px`;
  } else if (rect.right > vw - pad) {
    pop.style.right = `${rect.right - (vw - pad)}px`;
  }
}

/**
 * Single coalesced ResizeObserver + window resize rAF scheduler.
 */
export function createResizeScheduler(initialCb = null) {
  const callbacks = new Set();
  if (typeof initialCb === 'function') callbacks.add(initialCb);
  let rafId = 0;
  let observer = null;
  let winBound = false;

  const flush = () => {
    rafId = 0;
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        /* isolate resize listener error */
      }
    }
  };

  const schedule = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(flush);
  };

  return {
    add(cb) {
      if (typeof cb === 'function') callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    observe(el) {
      if (!el) return;
      if (!observer && typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(schedule);
      }
      observer?.observe(el);
    },
    bindWindow() {
      if (winBound || typeof window === 'undefined') return;
      winBound = true;
      window.addEventListener('resize', schedule, { passive: true });
    },
    schedule,
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      observer?.disconnect();
      observer = null;
      if (winBound && typeof window !== 'undefined') {
        window.removeEventListener('resize', schedule);
        winBound = false;
      }
      callbacks.clear();
    },
  };
}
