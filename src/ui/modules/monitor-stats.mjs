import { esc } from '../core/dom.mjs';

export function formatStatsTokens(n, lang = 'zh-CN') {
  const v = Number(n) || 0;
  if (lang === 'en') {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 1 : 2)}M`;
    return v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
  }
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e5) return `${(v / 1e4).toFixed(1)} 万`;
  return v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
}

export function formatStatsCurrency(usd, cur = 'CNY', rate = 7.2) {
  const r = Number(rate) > 0 ? Number(rate) : 7.2;
  const v = (Number(usd) || 0) * (cur === 'CNY' ? r : 1);
  return `${cur === 'CNY' ? '¥' : '$'}${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;
}

export function createMonitorStatsModule({ state, tr, getUiLang, callAppTool, persistConfigPatch, renderCustomSelect, showToast }) {
  let sig = '';
  const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const ts = (k, v) => tr(`monitor.stats.${k}`, v);
  const getCur = () => (state.config?.currency === 'CNY' || state.config?.currency === 'USD' ? state.config.currency : getUiLang() === 'en' ? 'USD' : 'CNY');
  const resetCache = () => { sig = ''; };

  function renderSelects() {
    const models = Array.isArray(state.statsData?.models) ? state.statsData.models : [];
    renderCustomSelect('statsModelSelectHost', {
      id: 'statsModel',
      value: state.statsModelFilter || 'all',
      options: [{ value: 'all', label: ts('modelAll') }, ...models.map((m) => ({ value: m, label: m }))],
      compact: true,
      alignRight: true,
    });
  }

  function syncControls() {
    const r = state.statsRange || 'today';
    document.querySelectorAll('#statsRangeNav [data-stats-range]').forEach((b) => { b.dataset.active = String(b.dataset.statsRange === r); });
    const cb = $('statsCurrencyBtn');
    if (cb) cb.textContent = getCur() === 'CNY' ? '¥ CNY' : '$ USD';
  }

  function renderStats() {
    if (typeof document === 'undefined') return;
    const lang = getUiLang();
    const cur = getCur();
    const rate = Number(state.config?.cnyPerUsd) > 0 ? Number(state.config.cnyPerUsd) : 7.2;
    const d = state.statsData || {};
    const byModel = Array.isArray(d.byModel) ? d.byModel : [];
    const models = Array.isArray(d.models) ? d.models : [];

    syncControls();
    renderSelects();

    const nextSig = `${lang}|${cur}|${rate}|${state.statsRange}|${state.statsModelFilter}|${d.updatedAt || ''}|${d.totalRequests ?? 0}|${d.totalTokens ?? 0}|${d.totalCostUsd ?? 0}|${d.cacheHitRate ?? 0}|${d.avgTps ?? 0}|${d.avgTtftMs ?? 0}|${models.length}|${byModel.length}`;
    if (nextSig === sig) return;
    sig = nextSig;

    const txt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const hit = Math.max(0, Math.min(100, Number(d.cacheHitRate) || 0));
    const drops = Number(d.cacheDropCount) || 0;
    const tps = Number(d.avgTps) || 0;
    const timed = Number(d.timedCount) || 0;
    const ttft = Number(d.avgTtftMs) || 0;
    const ttftN = Number(d.ttftCount) || 0;

    txt('statsTotalTokens', formatStatsTokens(d.totalTokens, lang));
    const sub = $('statsTokensSub');
    if (sub) {
      sub.innerHTML =
        `<span>${esc(ts('inputShort', { val: formatStatsTokens(d.inputTokens, lang) }))}</span>` +
        `<span>${esc(ts('outputShort', { val: formatStatsTokens(d.outputTokens, lang) }))}</span>` +
        `<span>${esc(ts('cacheShort', { val: formatStatsTokens(d.cacheReadTokens, lang) }))}</span>`;
    }

    txt('statsTotalRequests', (Number(d.totalRequests) || 0).toLocaleString());
    const de = $('statsCacheDropSub');
    if (de) {
      de.textContent = drops > 0 ? ts('cacheDrops', { n: drops }) : ts('noCacheDrop');
      de.className = drops > 0 ? 'text-xs text-error font-medium' : 'text-xs text-muted';
    }

    txt('statsTotalCost', formatStatsCurrency(d.totalCostUsd, cur, rate));
    txt('statsCacheHitRate', `${hit.toFixed(2)}%`);
    const fill = $('statsCacheHitFill');
    if (fill) fill.style.transform = `scaleX(${(hit / 100).toFixed(4)})`;

    txt('statsAvgTps', tps > 0 ? `${tps.toFixed(1)} tok/s` : '—');
    txt('statsTimedCount', timed > 0 ? ts('timedCount', { n: timed }) : '');
    txt('statsTtftSub', ttftN > 0 && ttft > 0 ? ts('ttftAvg', { sec: (ttft / 1000).toFixed(1), m: ttftN }) : ts('ttftNone'));

    txt('statsByModelCount', byModel.length ? String(byModel.length) : '');
    const list = $('statsByModelList');
    if (list) {
      list.innerHTML = byModel.length
        ? byModel.map((m) => {
            const mh = Math.max(0, Math.min(100, Number(m.cacheHitRate) || 0));
            return `<div class="stats-model-row"><div class="min-w-0 flex-1 text-xs font-medium text-fg mono-num truncate" title="${esc(m.model)}">${esc(m.model)}</div><div class="flex flex-wrap items-center gap-3 text-xs mono-num shrink-0"><span class="text-muted">${esc(ts('requestsUnit', { n: Number(m.requests) || 0 }))}</span><span class="text-fg font-medium">${esc(formatStatsTokens(m.totalTokens, lang))}</span><span class="text-success">${mh.toFixed(1)}%</span><span class="text-fg font-semibold">${esc(formatStatsCurrency(m.costUsd, cur, rate))}</span></div></div>`;
          }).join('')
        : `<div class="px-4 py-6 text-center text-xs text-muted">${esc(ts('empty'))}</div>`;
    }
  }

  async function loadStats(force = false) {
    syncControls();
    try {
      const res = await callAppTool('app_get_calls', {
        action: 'usage_stats',
        range: state.statsRange || 'today',
        modelFilter: state.statsModelFilter || 'all',
        force: Boolean(force),
      });
      if (res) {
        state.statsData = res;
        if (state.statsModelFilter && state.statsModelFilter !== 'all' && Array.isArray(res.models) && !res.models.includes(state.statsModelFilter)) {
          state.statsModelFilter = 'all';
        }
        renderStats();
      }
    } catch (err) {
      if (force) showToast?.(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
    }
  }

  function bindEvents() {
    $('statsRangeNav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-stats-range]');
      const next = btn?.dataset.statsRange;
      if (!next || next === state.statsRange) return;
      state.statsRange = next;
      syncControls();
      void loadStats(false);
    });
    $('statsCurrencyBtn')?.addEventListener('click', () => {
      const next = getCur() === 'CNY' ? 'USD' : 'CNY';
      if (!state.config) state.config = {};
      state.config.currency = next;
      resetCache();
      renderStats();
      void persistConfigPatch({ currency: next }).catch(() => {});
    });
  }

  return { bindEvents, loadStats, renderStats, renderSelects, resetCache };
}
