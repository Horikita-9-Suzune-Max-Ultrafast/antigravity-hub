/**
 * Model & Monitoring Parameters Modal:
 * Context window limits (in K) + Gemini presets, alert thresholds, and USD/1M pricing.
 */

import { esc } from '../core/dom.mjs';
import { renderIcon } from '../components/icons.mjs';

const GEMINI_RE = /^gemini/i;
const TABS = ['limits', 'thresholds', 'pricing'];
const THRESH_SPECS = [
  ['mpWarnPct', 'warnPct', 'contextWarningPct', 50, 95, 1, 75],
  ['mpDropPct', 'dropPct', 'cacheDropThresholdPct', 20, 90, 1, 50],
  ['mpLowTps', 'lowTps', 'lowTpsThreshold', 5, 100, 1, 15],
  ['mpLowTpsStreak', 'lowTpsStreak', 'lowTpsStreak', 2, 10, 1, 3],
  ['mpSubSharePct', 'subShare', 'subagentShareThresholdPct', 10, 90, 1, 35],
  ['mpSubCtxK', 'subCtxK', 'subagentContextWarnK', 10, 2000, 10, 100],
  ['mpMcpWarnK', 'mcpWarnK', 'mcpServerWarnK', 1, 500, 1, 15],
  ['mpSessionBudget', 'sessionBudget', 'sessionStartBudgetTokens', 150, 490, 10, 450],
  ['mpKvTtl', 'kvTtl', 'kvTtlMinutes', 3, 60, 1, 15],
  ['mpCnyPerUsd', 'cnyPerUsd', 'cnyPerUsd', 1, 50, 0.05, 7.2],
];

const clamp = (v, lo, hi, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
};

function toKStr(tok) {
  const k = (Number(tok) || 0) / 1000;
  return Number.isInteger(k) ? String(k) : String(Number(k.toFixed(3)));
}

function matchLimitKey(model, limits) {
  if (!model || !limits) return '';
  const low = String(model).toLowerCase();
  let best = '';
  for (const k of Object.keys(limits)) {
    if (k !== 'default' && low.includes(k.toLowerCase()) && k.length > best.length) best = k;
  }
  return best || 'default';
}

function sortKeys(keys) {
  const rk = (k) => {
    const l = k.toLowerCase();
    return l === 'default' ? 9 : l.startsWith('gemini') ? 1 : l.startsWith('claude') ? 2 : l.startsWith('gpt') || l === 'o3' || l === 'o4' ? 3 : 4;
  };
  return [...keys].sort((a, b) => rk(a) - rk(b) || b.length - a.length || a.localeCompare(b));
}

export function createModelParamsModalModule({
  state, tr, persistConfigPatch, onAfterSave, showToast, openModal, closeModal, positionIndicator,
}) {
  let tab = 'limits';
  let dLimits = {};
  let dPricing = {};
  let dThresh = {};
  let rmLimits = new Set();
  let rmPricing = new Set();
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const builtinKeys = (field) => new Set(Object.keys(state.configDefaults?.[field] || { default: 1 }));
  const extractThresh = (c) => ({
    contextWarningPct: Number(c?.alerts?.contextWarningPct ?? 75),
    cacheDropThresholdPct: Number(c?.alerts?.cacheDropThresholdPct ?? 50),
    lowTpsThreshold: Number(c?.alerts?.lowTpsThreshold ?? 15),
    lowTpsStreak: Number(c?.alerts?.lowTpsStreak ?? 3),
    subagentShareThresholdPct: Number(c?.alerts?.subagentShareThresholdPct ?? 35),
    subagentContextWarnK: Number(((c?.alerts?.subagentContextWarnTokens ?? 100000) / 1000).toFixed(1)),
    mcpServerWarnK: Number(((c?.alerts?.mcpServerWarnTokens ?? 15000) / 1000).toFixed(1)),
    sessionStartBudgetTokens: Number(c?.sessionStartBudgetTokens ?? 450),
    kvTtlMinutes: Number(c?.kvCache?.ttlMinutes ?? 15),
    cnyPerUsd: Number(c?.cnyPerUsd ?? 7.2),
  });

  function loadDraft(cfg) {
    const c = cfg || state.config || {};
    dLimits = structuredClone(c.modelLimits || state.configDefaults?.modelLimits || { default: 200000 });
    dPricing = structuredClone(c.pricing || state.configDefaults?.pricing || { default: { input: 2, cacheRead: 0.2, output: 10 } });
    dThresh = extractThresh(c);
    rmLimits = new Set();
    rmPricing = new Set();
  }

  function geminiPresetVal() {
    const vals = Object.entries(dLimits).filter(([k]) => GEMINI_RE.test(k)).map(([, v]) => Math.round(Number(v) || 0));
    return vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null;
  }

  function syncPresetBtns() {
    const pv = geminiPresetVal();
    document.querySelectorAll('#geminiLimitPresetRow [data-gemini-preset]').forEach((b) => {
      b.dataset.active = String(Number(b.dataset.geminiPreset) === pv);
    });
  }

  function renderTabs() {
    document.querySelectorAll('#modelParamsTabNav .seg-tab').forEach((b) => { b.dataset.active = String(b.dataset.ptab === tab); });
    for (const t of TABS) $(`modelParamsPane${t[0].toUpperCase()}${t.slice(1)}`)?.classList.toggle('hidden', t !== tab);
    requestAnimationFrame(() => positionIndicator('modelParamsTabNav', 'modelParamsTabIndicator'));
  }

  function renderLimits() {
    syncPresetBtns();
    const el = $('modelLimitsEditorList');
    if (!el) return;
    const built = builtinKeys('modelLimits');
    const act = String(state.contextData?.latestModel || state.contextData?.model || '').trim();
    const hit = act ? matchLimitKey(act, dLimits) : '';
    const xIco = renderIcon('close', { size: 12 });
    const delLbl = esc(tr('paramsModal.deleteRule'));

    el.innerHTML = sortKeys(Object.keys(dLimits)).map((k) => {
      const def = k === 'default';
      const canDel = !def && !built.has(k);
      return `<div class="param-row" data-matched="${Boolean(hit && k === hit)}">
        <div class="param-row-label min-w-0">
          <span class="mono-num text-xs font-medium text-fg truncate" title="${esc(k)}">${esc(def ? tr('paramsModal.limits.defaultKey') : k)}</span>
          ${hit && k === hit ? `<span class="agy-pill param-match-pill shrink-0">${esc(tr('paramsModal.limits.activeMatch'))}</span>` : ''}
        </div>
        <div class="param-row-ctrl shrink-0">
          <div class="param-input-unit">
            <input type="number" class="agy-input param-num-input mono-num" data-limit-input="${esc(k)}" value="${esc(toKStr(dLimits[k]))}" min="8" max="10000" step="any" aria-label="${esc(k)}" />
            <span class="param-unit-suffix mono-num">K</span>
          </div>
          ${canDel ? `<button type="button" class="param-del-btn shrink-0" data-limit-del="${esc(k)}" title="${delLbl}" aria-label="${delLbl}">${xIco}</button>` : '<span class="param-del-spacer shrink-0" aria-hidden="true"></span>'}
        </div>
      </div>`;
    }).join('');
  }

  function renderThresholds() {
    const grid = $('modelParamsThresholdGrid');
    if (!grid) return;
    grid.innerHTML = THRESH_SPECS.map(([id, tk, key, min, max, step]) =>
      `<label class="space-y-1 block min-w-0"><span class="text-muted block truncate">${esc(tr(`paramsModal.thresholds.${tk}`))}</span><input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(String(dThresh[key] ?? ''))}" class="agy-input w-full mono-num" /></label>`
    ).join('');
  }

  function readThresholds() {
    for (const [id, , key, , , , fb] of THRESH_SPECS) {
      const el = $(id);
      if (!el) continue;
      const v = Number(el.value);
      dThresh[key] = Number.isFinite(v) ? v : fb;
    }
  }

  function renderPricing() {
    const el = $('modelPricingEditorList');
    if (!el) return;
    const built = builtinKeys('pricing');
    const xIco = renderIcon('close', { size: 12 });
    const delLbl = esc(tr('paramsModal.deleteRule'));

    el.innerHTML = sortKeys(Object.keys(dPricing)).map((k) => {
      const p = dPricing[k] || { input: 2, cacheRead: 0.2, output: 10 };
      const def = k === 'default';
      const canDel = !def && !built.has(k);
      const cell = (f) => `<input type="number" class="agy-input param-price-input mono-num" data-price-key-in="${esc(k)}" data-price-field="${f}" value="${esc(String(p[f] ?? 0))}" min="0" max="1000" step="any" aria-label="${esc(k)} ${f}" />`;
      return `<div class="param-pricing-row">
        <span class="mono-num text-xs font-medium text-fg truncate min-w-0" title="${esc(k)}">${esc(def ? tr('paramsModal.limits.defaultKey') : k)}</span>
        ${cell('input')}${cell('cacheRead')}${cell('output')}
        ${canDel ? `<button type="button" class="param-del-btn shrink-0" data-price-del="${esc(k)}" title="${delLbl}" aria-label="${delLbl}">${xIco}</button>` : '<span class="param-del-spacer shrink-0" aria-hidden="true"></span>'}
      </div>`;
    }).join('');
  }

  function renderAll() {
    const pill = $('modelParamsActiveModelPill');
    const act = String(state.contextData?.latestModel || state.contextData?.model || '').trim();
    if (pill) {
      pill.textContent = act;
      pill.classList.toggle('hidden', !act);
    }
    renderTabs();
    renderLimits();
    renderThresholds();
    renderPricing();
  }

  function open(initialTab = 'limits') {
    tab = TABS.includes(initialTab) ? initialTab : 'limits';
    loadDraft(state.config);
    renderAll();
    openModal('modelParamsModal');
    requestAnimationFrame(() => positionIndicator('modelParamsTabNav', 'modelParamsTabIndicator'));
  }

  async function saveDraft() {
    if (busy) return;
    busy = true;
    const btn = $('modelParamsSaveBtn');
    if (btn) btn.disabled = true;
    try {
      readThresholds();
      const modelLimits = {};
      for (const k of rmLimits) if (!Object.prototype.hasOwnProperty.call(dLimits, k)) modelLimits[k] = null;
      for (const [k, v] of Object.entries(dLimits)) {
        const n = Math.round(Number(v) || 0);
        if (n >= 8000 && n <= 10_000_000) modelLimits[k] = n;
      }
      const pricing = {};
      for (const k of rmPricing) if (!Object.prototype.hasOwnProperty.call(dPricing, k)) pricing[k] = null;
      for (const [k, p] of Object.entries(dPricing)) {
        if (p && typeof p === 'object') {
          pricing[k] = { input: clamp(p.input, 0, 1000, 0), cacheRead: clamp(p.cacheRead, 0, 1000, 0), output: clamp(p.output, 0, 1000, 0) };
        }
      }
      await persistConfigPatch({
        modelLimits,
        pricing,
        cnyPerUsd: clamp(dThresh.cnyPerUsd, 1, 50, 7.2),
        sessionStartBudgetTokens: Math.round(clamp(dThresh.sessionStartBudgetTokens, 150, 490, 450)),
        kvCache: { ttlMinutes: Math.round(clamp(dThresh.kvTtlMinutes, 3, 60, 15)) },
        alerts: {
          contextWarningPct: Math.round(clamp(dThresh.contextWarningPct, 50, 95, 75)),
          cacheDropThresholdPct: Math.round(clamp(dThresh.cacheDropThresholdPct, 20, 90, 50)),
          lowTpsThreshold: clamp(dThresh.lowTpsThreshold, 5, 100, 15),
          lowTpsStreak: Math.round(clamp(dThresh.lowTpsStreak, 2, 10, 3)),
          subagentShareThresholdPct: Math.round(clamp(dThresh.subagentShareThresholdPct, 10, 90, 35)),
          subagentContextWarnTokens: Math.round(clamp(dThresh.subagentContextWarnK * 1000, 10_000, 2_000_000, 100_000)),
          mcpServerWarnTokens: Math.round(clamp(dThresh.mcpServerWarnK * 1000, 1_000, 500_000, 15_000)),
        },
      });
      closeModal('modelParamsModal');
      showToast(tr('toast.modelParamsSaved'), 'success');
      await onAfterSave?.();
    } catch (err) {
      showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  function resetTab() {
    const defs = state.configDefaults;
    if (!defs) return;
    if (tab === 'limits') {
      for (const k of Object.keys(dLimits)) if (!Object.prototype.hasOwnProperty.call(defs.modelLimits || {}, k)) rmLimits.add(k);
      dLimits = structuredClone(defs.modelLimits || { default: 200000 });
      renderLimits();
    } else if (tab === 'pricing') {
      for (const k of Object.keys(dPricing)) if (!Object.prototype.hasOwnProperty.call(defs.pricing || {}, k)) rmPricing.add(k);
      dPricing = structuredClone(defs.pricing || { default: { input: 2, cacheRead: 0.2, output: 10 } });
      renderPricing();
    } else {
      dThresh = extractThresh(defs);
      renderThresholds();
    }
    showToast(tr('toast.modelParamsReset'));
  }

  function bindEvents() {
    document.querySelectorAll('#modelParamsTabNav .seg-tab').forEach((b) => {
      b.addEventListener('click', () => {
        readThresholds();
        tab = b.dataset.ptab || 'limits';
        renderTabs();
      });
    });

    $('geminiLimitPresetRow')?.addEventListener('click', (e) => {
      const val = Math.round(Number(e.target.closest('[data-gemini-preset]')?.dataset.geminiPreset) || 0);
      if (val < 8000) return;
      for (const k of Object.keys(dLimits)) if (GEMINI_RE.test(k)) dLimits[k] = val;
      renderLimits();
    });

    $('modelLimitsEditorList')?.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-limit-input]');
      const v = Number(inp?.value);
      if (inp && Number.isFinite(v) && v > 0) {
        dLimits[inp.dataset.limitInput] = Math.round(v * 1000);
        syncPresetBtns();
      }
    });

    $('modelLimitsEditorList')?.addEventListener('click', (e) => {
      const k = e.target.closest('[data-limit-del]')?.dataset.limitDel;
      if (!k || k === 'default') return;
      delete dLimits[k];
      rmLimits.add(k);
      renderLimits();
    });

    $('modelLimitAddBtn')?.addEventListener('click', () => {
      const key = String($('modelLimitAddKey')?.value || '').trim().slice(0, 64);
      const v = Number($('modelLimitAddVal')?.value);
      if (!key || !Number.isFinite(v) || v < 8 || v > 10000) return showToast(tr('paramsModal.limits.invalidInput'), 'error');
      dLimits[key] = Math.round(v * 1000);
      rmLimits.delete(key);
      if ($('modelLimitAddKey')) $('modelLimitAddKey').value = '';
      if ($('modelLimitAddVal')) $('modelLimitAddVal').value = '';
      renderLimits();
    });

    $('modelPricingEditorList')?.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-price-key-in]');
      const v = Number(inp?.value);
      if (!inp || !Number.isFinite(v) || v < 0) return;
      const k = inp.dataset.priceKeyIn;
      (dPricing[k] ||= { input: 2, cacheRead: 0.2, output: 10 })[inp.dataset.priceField] = v;
    });

    $('modelPricingEditorList')?.addEventListener('click', (e) => {
      const k = e.target.closest('[data-price-del]')?.dataset.priceDel;
      if (!k || k === 'default') return;
      delete dPricing[k];
      rmPricing.add(k);
      renderPricing();
    });

    $('modelPricingAddBtn')?.addEventListener('click', () => {
      const key = String($('modelPricingAddKey')?.value || '').trim().slice(0, 64);
      const iv = Number($('modelPricingAddIn')?.value);
      const cv = Number($('modelPricingAddCache')?.value || 0);
      const ov = Number($('modelPricingAddOut')?.value);
      if (!key || [iv, cv, ov].some((n) => !Number.isFinite(n) || n < 0)) return showToast(tr('paramsModal.pricing.invalidInput'), 'error');
      dPricing[key] = { input: iv, cacheRead: cv, output: ov };
      rmPricing.delete(key);
      for (const id of ['modelPricingAddKey', 'modelPricingAddIn', 'modelPricingAddCache', 'modelPricingAddOut']) {
        if ($(id)) $(id).value = '';
      }
      renderPricing();
    });

    $('modelParamsResetBtn')?.addEventListener('click', resetTab);
    $('modelParamsSaveBtn')?.addEventListener('click', () => void saveDraft());
  }

  return { open, renderAll, bindEvents };
}
