/**
 * Monitor Calls Table module:
 * - In-place single-row expand/collapse (eliminates full 120-row innerHTML redraw on click).
 * - Cached canvas text-width column layout calculation (O(1) resize evaluation).
 * - Strictly 12px typography and zero middle-dot separators.
 */

import { esc, fmtK, formatShortModel, measureTextPx, pulseTargetEl } from '../core/dom.mjs';
import { CALLS_INITIAL_RENDER_LIMIT } from '../core/store.mjs';

const MONO_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const UI_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export function buildCallAnatomyRowHtml(c, { tr, getUiLang }) {
  const lang = getUiLang();
  const hasTtft = c.ttftMs != null && Number.isFinite(Number(c.ttftMs));
  const decodeSec = hasTtft ? Math.max(0, (c.durationMs - Number(c.ttftMs)) / 1000) : null;
  const durTitle = hasTtft
    ? lang === 'en'
      ? `TTFT ${(Number(c.ttftMs) / 1000).toFixed(2)}s / Decode ${decodeSec.toFixed(2)}s / Total ${(c.durationMs / 1000).toFixed(2)}s`
      : `首字 ${(Number(c.ttftMs) / 1000).toFixed(2)}s / 解码 ${decodeSec.toFixed(2)}s / 模型总耗时 ${(c.durationMs / 1000).toFixed(2)}s`
    : '';
  const totalOut = Math.max(1, (Number(c.thinkingTokensEst) || 0) + (Number(c.contentTokensEst) || 0));
  const thinkRatio = Math.round(((Number(c.thinkingTokensEst) || 0) / totalOut) * 100);
  const sourceText = String(c.sourceLabel || `${c.agentTag} / ${String(c.conversationId || '').slice(0, 8)}`).replace(
    /\s*\u00B7\s*/g,
    ' / '
  );
  const hitPct = Math.max(0, Math.min(100, Number(c.cacheHitRate) || 0));

  return `
  <tr class="call-anatomy-row" data-anatomy-for="${esc(c.callUid)}">
    <td colspan="7" class="px-4 py-3.5">
      <div class="space-y-2.5 text-xs panel-enter">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mono-num">
            <span class="font-semibold text-fg">${esc(tr('monitor.calls.anatomyTitle', { tag: c.agentTag, step: c.stepIndex }))}</span>
            <span class="text-muted">${esc(tr('monitor.calls.anatomyModel'))}<span class="text-fg font-medium">${esc(c.model)}</span></span>
            <span class="text-muted">${esc(tr('monitor.calls.anatomyTiming', { source: c.timingSource }))}</span>
            ${hasTtft ? `<span class="text-muted">${esc(durTitle)}</span>` : ''}
          </div>
          <span class="mono-num text-muted">${esc(tr('monitor.calls.anatomyThinkRatio', { ratio: thinkRatio }))}</span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span class="text-muted">${esc(tr('monitor.calls.anatomySource'))}<span class="text-fg font-medium">${esc(sourceText)}</span></span>
          <span class="mono-num text-muted">${esc(tr('monitor.calls.anatomyBreakdown', { cache: fmtK(c.cacheReadTokens), input: fmtK(c.inputTokens), output: fmtK(c.outputTokens) }))}</span>
        </div>
        <div class="flex rounded-full overflow-hidden w-full" style="height: 8px; background: var(--card); border: 1px solid var(--border); box-sizing: border-box;">
          <div style="flex: 0 0 ${hitPct.toFixed(2)}%; background: var(--success);"></div>
          <div style="flex: 0 0 ${Math.max(0, 100 - hitPct).toFixed(2)}%; background: var(--chart-2);"></div>
        </div>
        ${
          c.cacheDrop
            ? `
        <div class="p-3 rounded-xl flex items-start gap-2.5" style="border: 1px solid var(--red-6); background: var(--error-subtle);">
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
  </tr>`;
}

export function createMonitorCallsModule({
  state,
  tr,
  getUiLang,
  callAppTool,
  renderCallsSelects,
  positionIndicator,
}) {
  let lastRenderSig = '';
  let layoutMeasureCache = { key: '', wide: null, compact: null };

  function clearLayoutCache() {
    layoutMeasureCache = { key: '', wide: null, compact: null };
  }

  function resetCache() {
    lastRenderSig = '';
    clearLayoutCache();
  }

  function computeLayoutMetrics(table, visible) {
    const ths = [...table.querySelectorAll('thead th')];
    const getHeaderText = (idx, compact) => {
      const th = ths[idx];
      if (!th) return '';
      if (!compact) return (th.textContent || '').trim();
      const parts = [];
      th.childNodes.forEach((n) => {
        if (n.nodeType === 1 && n.classList?.contains('col-full-lbl')) return;
        parts.push(n.textContent || '');
      });
      return parts.join('').trim();
    };

    const headersSig = ths.map((th) => (th.textContent || '').trim()).join('|');
    const dataSig = `${getUiLang()}|${headersSig}|${visible.length}|${visible.map((c) => `${c.callUid}:${c.model}:${c.effectiveTps}:${c.durationMs}`).join(',')}`;

    if (layoutMeasureCache.key === dataSig && layoutMeasureCache.wide && layoutMeasureCache.compact) {
      return layoutMeasureCache;
    }

    const measureTier = (px, compact) => {
      const monoFont = `500 ${px}px ${MONO_FONT_FAMILY}`;
      const monoBold = `600 ${px}px ${MONO_FONT_FAMILY}`;
      const hdrFont = `500 ${px}px ${UI_FONT_FAMILY}`;
      const badgeFont = `500 12px ${UI_FONT_FAMILY}`;
      const cellPad = compact ? 12 : 18;
      const edgePad = compact ? 17 : 24;
      const badgeExtra = compact ? 18 : 22;

      let stepW = measureTextPx(getHeaderText(0, compact), hdrFont) + edgePad;
      let tpsW = measureTextPx(getHeaderText(2, compact), hdrFont) + cellPad;
      let durW = measureTextPx(getHeaderText(3, compact), hdrFont) + cellPad;
      let tokW = measureTextPx(getHeaderText(4, compact), hdrFont) + cellPad;
      let cacheW = measureTextPx(getHeaderText(5, compact), hdrFont) + cellPad;
      let costW = measureTextPx(getHeaderText(6, compact), hdrFont) + edgePad;
      let shortModelW = measureTextPx(getHeaderText(1, compact), hdrFont) + cellPad;
      let fullModelW = shortModelW;

      for (const c of visible) {
        const badgeW = measureTextPx(c.agentTag || '主', badgeFont) + badgeExtra;
        const stepNumW = measureTextPx(`#${c.stepIndex}`, monoFont);
        stepW = Math.max(stepW, badgeW + stepNumW + edgePad);

        const tpsVal = Number(c.effectiveTps) || 0;
        const tpsStr = tpsVal > 0 ? `${tpsVal.toFixed(1)} tok/s` : '—';
        tpsW = Math.max(tpsW, measureTextPx(tpsStr, monoBold) + cellPad);

        const durStr =
          c.ttftMs != null
            ? `${(Number(c.ttftMs) / 1000).toFixed(1)}s / ${(Number(c.durationMs || 0) / 1000).toFixed(1)}s`
            : `${(Number(c.durationMs || 0) / 1000).toFixed(1)}s`;
        durW = Math.max(durW, measureTextPx(durStr, monoFont) + cellPad);

        const tokStr = `${fmtK(c.contextTokens)} / ${fmtK(c.thinkingTokensEst)} / ${fmtK(c.contentTokensEst)}`;
        tokW = Math.max(tokW, measureTextPx(tokStr, monoFont) + cellPad);

        const cacheStr = `${Number(c.cacheHitRate || 0).toFixed(1)}%`;
        cacheW = Math.max(cacheW, measureTextPx(cacheStr, monoBold) + cellPad);

        const costStr = `$${Number(c.estimatedCostUsd || 0).toFixed(3)}`;
        costW = Math.max(costW, measureTextPx(costStr, monoFont) + edgePad);

        const shortM = formatShortModel(c.model);
        shortModelW = Math.max(shortModelW, measureTextPx(shortM, monoFont) + cellPad);
        fullModelW = Math.max(fullModelW, measureTextPx(c.model || shortM, monoFont) + cellPad);
      }

      const cols = {
        step: Math.ceil(stepW),
        tps: Math.ceil(tpsW),
        dur: Math.ceil(durW),
        tok: Math.ceil(tokW),
        cache: Math.ceil(cacheW),
        cost: Math.ceil(costW),
      };
      const fixedSum = cols.step + cols.tps + cols.dur + cols.tok + cols.cache + cols.cost;
      const minModelW = Math.min(Math.max(compact ? 76 : 88, Math.ceil(shortModelW)), compact ? 116 : 136);
      return {
        cols,
        fixedSum,
        minModelW,
        shortModelW: Math.ceil(shortModelW),
        fullModelW: Math.ceil(fullModelW),
      };
    };

    layoutMeasureCache = {
      key: dataSig,
      wide: measureTier(12, false),
      compact: measureTier(12, true),
    };
    return layoutMeasureCache;
  }

  function fitCallsTableLayout() {
    if (typeof document === 'undefined') return;
    const wrap = document.getElementById('callsStepWrap');
    if (!wrap || wrap.classList.contains('hidden')) return;
    const table = wrap.querySelector('.calls-table');
    if (!table) return;
    const availW = Math.floor(wrap.clientWidth);
    if (availW <= 0) return;

    const list = state.callsData?.calls || [];
    const visible =
      list.length > CALLS_INITIAL_RENDER_LIMIT && !state.showAllCalls
        ? list.slice(0, CALLS_INITIAL_RENDER_LIMIT)
        : list;

    const { wide, compact } = computeLayoutMetrics(table, visible);

    const applyCols = (cols) => {
      const map = [
        ['col.col-step', `${cols.step}px`],
        ['col.col-model', 'auto'],
        ['col.col-tps', `${cols.tps}px`],
        ['col.col-dur', `${cols.dur}px`],
        ['col.col-tok', `${cols.tok}px`],
        ['col.col-cache', `${cols.cache}px`],
        ['col.col-cost', `${cols.cost}px`],
      ];
      for (const [sel, val] of map) {
        const el = table.querySelector(sel);
        if (el && el.style.width !== val) el.style.width = val;
      }
    };

    if (wide.fixedSum + wide.minModelW <= availW) {
      table.dataset.layoutMode = 'table';
      table.dataset.density = 'wide';
      applyCols(wide.cols);
      const modelW = availW - wide.fixedSum;
      table.dataset.modelMode = modelW >= Math.min(wide.fullModelW, 168) ? 'full' : 'short';
      return;
    }

    if (compact.fixedSum + compact.minModelW <= availW) {
      table.dataset.layoutMode = 'table';
      table.dataset.density = 'compact';
      applyCols(compact.cols);
      const modelW = availW - compact.fixedSum;
      table.dataset.modelMode = modelW >= Math.min(compact.fullModelW, 158) ? 'full' : 'short';
      return;
    }

    table.dataset.layoutMode = 'card';
    delete table.dataset.density;
    table.dataset.modelMode = 'short';
    table.querySelectorAll('colgroup col').forEach((el) => {
      if (el.style.width) el.style.width = '';
    });
  }

  /**
   * In-place single-row expand/collapse without rewriting all 120 rows via innerHTML.
   */
  function toggleCallExpand(callUid) {
    const tbody = document.getElementById('callsTbody');
    const prevId = state.expandedCallId;
    const nextId = prevId === callUid ? null : callUid;
    state.expandedCallId = nextId;

    if (!tbody) return;

    // 1. Collapse existing anatomy row in place
    tbody.querySelectorAll('tr.call-anatomy-row').forEach((el) => el.remove());
    if (prevId) {
      const prevRow = [...tbody.querySelectorAll('tr.call-row[data-call-id]')].find(
        (r) => r.dataset.callId === prevId
      );
      if (prevRow) prevRow.dataset.expanded = 'false';
    }

    // 2. Insert single anatomy row immediately after clicked row
    if (!nextId) return;
    const call = (state.callsData?.calls || []).find((c) => c.callUid === nextId);
    const targetRow = [...tbody.querySelectorAll('tr.call-row[data-call-id]')].find(
      (r) => r.dataset.callId === nextId
    );
    if (!call || !targetRow) return;
    targetRow.dataset.expanded = 'true';
    targetRow.insertAdjacentHTML('afterend', buildCallAnatomyRowHtml(call, { tr, getUiLang }));
  }

  function renderCalls() {
    const data = state.callsData;
    const list = data?.calls || [];
    const byAgent = data?.summary?.byAgent || [];
    const byModel = data?.summary?.byModel || [];
    const lang = getUiLang();

    // Note: expandedCallId is intentionally excluded from full table redraw signature
    // because toggleCallExpand patches anatomy rows in place!
    const callsSig = `${lang}|${state.freshCallId || ''}|${state.showAllCalls ? 1 : 0}|${data?.totalCallsCount ?? 0}|${list.map((c) => `${c.callUid}:${c.effectiveTps}:${c.cacheHitRate}:${c.estimatedCostUsd}:${c.durationMs}:${c.timingSource || ''}:${c.cacheDrop ? 1 : 0}`).join(',')}|${byAgent.map((a) => `${a.agentTag}:${a.steps}:${a.cost}`).join(',')}|${byModel.map((m) => `${m.model}:${m.steps}:${m.cost}`).join(',')}`;
    if (callsSig === lastRenderSig) return;
    lastRenderSig = callsSig;

    const tbody = document.getElementById('callsTbody');
    if (tbody) {
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-xs text-muted">${esc(tr('monitor.calls.empty'))}</td></tr>`;
      } else {
        const hasMore = list.length > CALLS_INITIAL_RENDER_LIMIT;
        const visibleList = !hasMore || state.showAllCalls ? list : list.slice(0, CALLS_INITIAL_RENDER_LIMIT);
        const rowsHtml = visibleList
          .map((c) => {
            const isExp = state.expandedCallId === c.callUid;
            const agentKind = c.agentType === 'main' ? 'main' : 'sub';
            const cacheCls = c.cacheDrop
              ? 'text-error font-semibold'
              : c.cacheHitRate >= 85
                ? 'text-success font-medium'
                : 'text-warning font-medium';
            const hasTtft = c.ttftMs != null && Number.isFinite(Number(c.ttftMs));
            const decodeSec = hasTtft ? Math.max(0, (c.durationMs - Number(c.ttftMs)) / 1000) : null;
            const durText = hasTtft
              ? `${(Number(c.ttftMs) / 1000).toFixed(1)}s / ${(c.durationMs / 1000).toFixed(1)}s`
              : `${(c.durationMs / 1000).toFixed(1)}s`;
            const durTitle = hasTtft
              ? lang === 'en'
                ? `TTFT ${(Number(c.ttftMs) / 1000).toFixed(2)}s / Decode ${decodeSec.toFixed(2)}s / Total ${(c.durationMs / 1000).toFixed(2)}s`
                : `首字 ${(Number(c.ttftMs) / 1000).toFixed(2)}s / 解码 ${decodeSec.toFixed(2)}s / 模型总耗时 ${(c.durationMs / 1000).toFixed(2)}s`
              : '';
            const tpsVal = Number(c.effectiveTps) || 0;
            const tpsText = tpsVal > 0 ? `${tpsVal.toFixed(1)} tok/s` : '—';
            const e2eTps = c.durationMs > 0 ? (c.outputTokens || 0) / (c.durationMs / 1000) : 0;
            const tpsTitle =
              tpsVal > 0 && hasTtft
                ? lang === 'en'
                  ? `Decode ${tpsVal.toFixed(1)} tok/s (excl. TTFT) | End-to-end ${e2eTps.toFixed(1)} tok/s`
                  : `纯解码速度 ${tpsVal.toFixed(1)} tok/s（已扣首字耗时）| 端到端 ${e2eTps.toFixed(1)} tok/s`
                : tpsVal <= 0 && hasTtft
                  ? lang === 'en'
                    ? 'Decode window < 1s; speed omitted to avoid noise'
                    : '解码窗口不足 1 秒，为避免噪声未计入速度'
                  : '';
            const tpsCls =
              tpsVal <= 0
                ? 'text-muted'
                : tpsVal < 15 && c.timingSource !== 'estimated'
                  ? 'text-warning'
                  : '';
            const shortModel = formatShortModel(c.model);

            return `
            <tr class="call-row ${c.callUid === state.freshCallId ? 'row-fresh' : ''}" data-call-id="${esc(c.callUid)}" data-expanded="${isExp}">
              <td class="cell-step whitespace-nowrap mono-num">
                <span class="agent-badge" data-agent="${agentKind}">${esc(c.agentTag)}</span>
                <span>#${c.stepIndex}</span>
                <span class="cell-inline-model" title="${esc(c.model)}">${esc(shortModel)}</span>
              </td>
              <td class="cell-model col-model-cell mono-num text-muted" title="${esc(c.model)}">
                <span class="col-model-full">${esc(c.model)}</span>
                <span class="col-model-short">${esc(shortModel)}</span>
              </td>
              <td class="cell-tps text-right whitespace-nowrap mono-num font-semibold ${tpsCls}" title="${esc(tpsTitle)}">
                <span>${tpsText}</span>
                <span class="cell-inline-cost">$${c.estimatedCostUsd.toFixed(3)}</span>
              </td>
              <td class="cell-dur text-right whitespace-nowrap mono-num text-muted" title="${esc(durTitle)}">${durText}</td>
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
            ${isExp ? buildCallAnatomyRowHtml(c, { tr, getUiLang }) : ''}`;
          })
          .join('');

        const toggleLabel = state.showAllCalls
          ? lang === 'en'
            ? `Show latest ${CALLS_INITIAL_RENDER_LIMIT}`
            : `仅显示前 ${CALLS_INITIAL_RENDER_LIMIT} 条`
          : lang === 'en'
            ? `Show all (${list.length})`
            : `显示全部 (${list.length})`;
        const toggleRowHtml = hasMore
          ? `<tr class="calls-toggle-all-row"><td colspan="7" class="py-2.5 px-4 text-center"><button type="button" data-toggle-all-calls="1" class="agy-btn agy-btn-secondary agy-btn-sm text-xs">${esc(toggleLabel)}</button></td></tr>`
          : '';
        tbody.innerHTML = rowsHtml + toggleRowHtml;
      }
    }

    const totalCost = list.reduce((s, c) => s + (Number(c.estimatedCostUsd) || 0), 0);
    const realTimedList = list.filter((c) => c.timingSource !== 'estimated' && (Number(c.effectiveTps) || 0) > 0);
    const tpsPool = realTimedList.length > 0 ? realTimedList : list.filter((c) => (Number(c.effectiveTps) || 0) > 0);
    const totalOutTokens = tpsPool.reduce((s, c) => s + (c.outputTokens || 0), 0);
    const totalActiveMs = tpsPool.reduce((s, c) => {
      const dur = Math.max(0, Number(c.durationMs) || 0);
      const ttft = c.ttftMs != null && Number.isFinite(Number(c.ttftMs)) ? Number(c.ttftMs) : null;
      return s + (ttft != null && dur > ttft ? dur - ttft : dur);
    }, 0);
    const avgTps =
      totalActiveMs > 0 && totalOutTokens > 0
        ? totalOutTokens / (totalActiveMs / 1000)
        : tpsPool.length
          ? tpsPool.reduce((s, c) => s + c.effectiveTps, 0) / tpsPool.length
          : 0;

    const heroSteps = document.getElementById('callsHeroSteps');
    const heroTps = document.getElementById('callsHeroTps');
    const heroCost = document.getElementById('callsHeroCost');
    const heroModel = document.getElementById('callsHeroModel');
    const totalAll = data?.totalCallsCount ?? list.length;

    if (heroSteps) {
      heroSteps.textContent =
        list.length !== totalAll
          ? tr('monitor.calls.heroStepsFiltered', { count: list.length, total: totalAll })
          : tr('monitor.calls.heroStepsVal', { count: list.length });
    }
    if (heroTps) {
      heroTps.textContent = `${avgTps.toFixed(1)} tok/s`;
      heroTps.classList.toggle('text-warning', list.length > 0 && avgTps < 15);
      heroTps.classList.toggle('text-primary', !(list.length > 0 && avgTps < 15));
    }
    if (heroCost) heroCost.textContent = `$${totalCost.toFixed(3)}`;
    if (heroModel) {
      const latestModel = list[0]?.model || data?.summary?.latestModel || '';
      heroModel.textContent = latestModel ? tr('monitor.calls.heroModel', { model: latestModel }) : '';
      heroModel.title = latestModel;
      heroModel.classList.toggle('hidden', !latestModel);
    }

    const footerEl = document.getElementById('callsFooterStats');
    if (footerEl) {
      footerEl.textContent = tr('monitor.calls.footerStats', {
        count: list.length,
        tps: avgTps.toFixed(1),
        cost: totalCost.toFixed(3),
      });
    }

    const agentListEl = document.getElementById('summaryAgentList');
    if (agentListEl) {
      agentListEl.innerHTML = byAgent.length
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
    }

    const modelListEl = document.getElementById('summaryModelList');
    if (modelListEl) {
      modelListEl.innerHTML = byModel.length
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

    fitCallsTableLayout();
  }

  async function loadCalls(force = false) {
    const data = await callAppTool(
      'app_get_calls',
      {
        conversationId: state.activeConversationId || undefined,
        followActive: state.followMode === 'auto',
        agentFilter: state.agentFilter,
        modelFilter: state.modelFilter,
        onlyDrop: state.onlyDrop,
        force,
      },
      { useRevCache: !force }
    );

    if (data?.unchanged && state.callsData) {
      return data;
    }

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
    renderCallsSelects?.(!force);
    renderCalls();
    const nowStr = new Date().toLocaleTimeString(getUiLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
    const lbl = document.getElementById('lastUpdatedLabel');
    if (lbl) lbl.textContent = tr('monitor.calls.lastSync', { time: nowStr });
    return data;
  }

  async function focusAlertCall(alert, combined) {
    const code = String(alert.code || '').toLowerCase();
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
        if (subs.length) return [...subs].sort((a, b) => (b.contextTokens || 0) - (a.contextTokens || 0))[0];
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
      if (state.agentFilter !== 'all' || state.modelFilter !== 'all' || state.onlyDrop) {
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
      const callsList = state.callsData?.calls || [];
      const matchedIdx = callsList.findIndex((c) => c.callUid === matched.callUid);
      if (matchedIdx >= CALLS_INITIAL_RENDER_LIMIT && !state.showAllCalls) {
        state.showAllCalls = true;
        renderCalls();
      }
      if (state.expandedCallId !== matched.callUid) {
        toggleCallExpand(matched.callUid);
      }
      requestAnimationFrame(() => {
        const rows = document.querySelectorAll('#callsTbody tr.call-row[data-call-id]');
        const row = [...rows].find((r) => r.dataset.callId === matched.callUid);
        if (row) {
          pulseTargetEl(row);
          const anatomy = row.nextElementSibling;
          if (anatomy && anatomy.classList.contains('call-anatomy-row')) {
            pulseTargetEl(anatomy);
          }
        }
      });
    }
  }

  function bindEvents() {
    document.querySelectorAll('#callsModeNav .seg-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.callsMode = btn.dataset.mode;
        document.querySelectorAll('#callsModeNav .seg-tab').forEach((b) => {
          b.dataset.active = String(b.dataset.mode === state.callsMode);
        });
        positionIndicator('callsModeNav', 'callsModeIndicator');
        document.getElementById('callsStepWrap')?.classList.toggle('hidden', state.callsMode !== 'step');
        document.getElementById('callsSummaryWrap')?.classList.toggle('hidden', state.callsMode !== 'summary');
        if (state.callsMode === 'step') requestAnimationFrame(fitCallsTableLayout);
      });
    });

    document.getElementById('onlyDropBtn')?.addEventListener('click', () => {
      state.onlyDrop = !state.onlyDrop;
      const btn = document.getElementById('onlyDropBtn');
      const dot = document.getElementById('onlyDropDot');
      if (btn) {
        btn.style.borderColor = state.onlyDrop ? 'var(--error)' : 'var(--border)';
        btn.style.color = state.onlyDrop ? 'var(--error)' : 'var(--foreground)';
      }
      if (dot) dot.style.background = state.onlyDrop ? 'var(--error)' : 'var(--border)';
      void loadCalls(true);
    });
  }

  return {
    fitCallsTableLayout,
    toggleCallExpand,
    renderCalls,
    loadCalls,
    focusAlertCall,
    bindEvents,
    resetCache,
    clearLayoutCache,
  };
}
