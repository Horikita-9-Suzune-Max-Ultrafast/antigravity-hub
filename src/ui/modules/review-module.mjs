/**
 * Module 5: Local Code Review & Subagent Gatekeeper (review-module.mjs).
 * 3-section restrained layout:
 * 1. Scope selector (uncommitted/staged/last_commit/branch) + preflight scan + isolated AI review (fast/deep)
 * 2. Summary stats strip + manual native gate pills
 * 3. Findings severity filter + multi-select checkboxes ("Fix with Agent") + ignore/restore + import modal + history
 */

const SCOPES = ['uncommitted', 'staged', 'last_commit', 'branch'];
const SEVERITIES = ['all', 'critical', 'high', 'medium', 'low'];

function fmtTime(iso, lang = 'zh-CN') {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function createReviewModule({
  callAppTool,
  esc,
  tr,
  getUiLang,
  showToast,
  openModal,
  closeModal,
  renderCustomSelect,
  getProjectDir,
  getConversationId,
  canSendMessage,
  sendToAgent,
}) {
  const st = {
    loaded: false,
    busy: false,
    runningGateId: null,
    scope: 'uncommitted',
    baseRef: '',
    severityFilter: 'all',
    showIgnored: false,
    selectedIds: new Set(),
    activeReportId: 'latest',
    statusData: null,
    activeReport: null,
    availableGates: [],
    historyItems: [],
  };

  const t = (key, vars = null) => (typeof tr === 'function' ? tr(key, vars) : key);
  const lang = () => (typeof getUiLang === 'function' ? getUiLang() : 'zh-CN');
  const byId = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

  function getActiveFindings() {
    const all = Array.isArray(st.activeReport?.findings) ? st.activeReport.findings : [];
    return all.filter((f) => !f.ignored);
  }

  function getIgnoredFindings() {
    const all = Array.isArray(st.activeReport?.findings) ? st.activeReport.findings : [];
    return all.filter((f) => Boolean(f.ignored));
  }

  function getFilteredFindings() {
    const base = st.showIgnored ? getIgnoredFindings() : getActiveFindings();
    if (st.severityFilter === 'all') return base;
    return base.filter((f) => f.severity === st.severityFilter);
  }

  function pruneSelection() {
    const validIds = new Set(getActiveFindings().map((f) => f.id));
    for (const id of [...st.selectedIds]) {
      if (!validIds.has(id)) st.selectedIds.delete(id);
    }
  }

  function renderNavBadges() {
    const summary = st.activeReport?.summary || st.statusData?.latestReport?.summary || null;
    const crit = Number(summary?.critical) || 0;
    const high = Number(summary?.high) || 0;
    const showDot = crit > 0 || high > 0;
    const tone = crit > 0 ? 'error' : 'warn';

    const railDot = byId('railReviewAlertDot');
    const topDot = byId('topBarReviewDot');
    if (railDot) {
      railDot.classList.toggle('hidden', !showDot);
      railDot.dataset.tone = tone;
    }
    if (topDot) {
      topDot.classList.toggle('hidden', !showDot);
      topDot.style.background = crit > 0 ? 'var(--error)' : 'var(--warning)';
    }

    const pill = byId('reviewHeaderPill');
    if (pill) {
      if (!summary) {
        pill.textContent = t('review.header.idle');
        pill.dataset.tone = 'neutral';
      } else if (crit > 0) {
        pill.textContent = t('review.header.criticalBadge', { count: crit });
        pill.dataset.tone = 'error';
      } else if (high > 0) {
        pill.textContent = t('review.header.highBadge', { count: high });
        pill.dataset.tone = 'warning';
      } else if ((summary.total || 0) > 0) {
        pill.textContent = t('review.header.totalBadge', { count: summary.total });
        pill.dataset.tone = 'neutral';
      } else {
        pill.textContent = t('review.header.clean');
        pill.dataset.tone = 'success';
      }
    }
  }

  function renderScopeControls() {
    document.querySelectorAll('#reviewScopeSeg [data-review-scope]').forEach((btn) => {
      btn.dataset.active = String(btn.dataset.reviewScope === st.scope);
    });
    const baseWrap = byId('reviewBaseRefWrap');
    if (baseWrap) {
      baseWrap.classList.toggle('hidden', st.scope !== 'branch');
    }
    const baseInp = byId('reviewBaseRefInput');
    if (baseInp && document.activeElement !== baseInp) {
      baseInp.value = st.baseRef;
    }
    const gitMeta = byId('reviewGitMeta');
    const git = st.activeReport?.git || st.statusData?.git || null;
    if (gitMeta) {
      if (git?.branch && git.branch !== 'nogit') {
        const diffStats = st.activeReport?.diffStats;
        const diffPart =
          diffStats && Number.isFinite(diffStats.files)
            ? ` / ${t('review.diffSummary', {
                files: diffStats.files,
                add: diffStats.additions || 0,
                del: diffStats.deletions || 0,
              })}`
            : '';
        gitMeta.textContent = `${git.branch}@${git.head || 'none'}${diffPart}`;
      } else {
        gitMeta.textContent = t('monitor.header.noGit');
      }
    }
  }

  function computeActiveSummary() {
    const active = getActiveFindings();
    const s = { critical: 0, high: 0, medium: 0, low: 0, total: active.length };
    for (const f of active) {
      if (f.severity in s) s[f.severity]++;
    }
    return s;
  }

  function renderStatsAndGates() {
    const report = st.activeReport;
    const summary = report?.summary || computeActiveSummary();

    const setStat = (id, val, toneCls = '') => {
      const el = byId(id);
      if (!el) return;
      el.textContent = String(val);
      if (toneCls) el.className = `text-base font-semibold mono-num ${toneCls}`;
    };
    setStat('reviewStatCritical', summary.critical ?? 0, (summary.critical ?? 0) > 0 ? 'text-error' : 'text-fg');
    setStat('reviewStatHigh', summary.high ?? 0, (summary.high ?? 0) > 0 ? 'text-warning' : 'text-fg');
    setStat('reviewStatMedium', summary.medium ?? 0, (summary.medium ?? 0) > 0 ? 'text-primary' : 'text-fg');
    setStat('reviewStatLow', summary.low ?? 0, 'text-muted');

    const overviewBox = byId('reviewOverviewBanner');
    if (overviewBox) {
      if (report?.overview) {
        overviewBox.textContent = report.overview;
        overviewBox.classList.remove('hidden');
      } else {
        overviewBox.classList.add('hidden');
      }
    }

    const gatesHost = byId('reviewGatesBar');
    if (gatesHost) {
      const gates = st.availableGates || [];
      const ranMap = new Map((report?.gates || []).map((g) => [g.gateId, g]));
      if (!gates.length) {
        gatesHost.innerHTML = `<span class="text-xs text-muted">${esc(t('review.gates.none'))}</span>`;
      } else {
        gatesHost.innerHTML = gates
          .map((g) => {
            const ran = ranMap.get(g.id);
            const isRunning = st.runningGateId === g.id;
            const statusAttr = isRunning ? 'running' : ran ? (ran.ok ? 'pass' : 'fail') : 'idle';
            const statusText = isRunning
              ? t('review.gates.running')
              : ran
                ? ran.ok
                  ? t('review.gates.pass')
                  : t('review.gates.fail')
                : t('review.gates.run');
            const dur = ran?.durationMs != null && !isRunning ? ` ${(ran.durationMs / 1000).toFixed(1)}s` : '';
            return `
              <button
                type="button"
                class="review-gate-pill"
                data-review-gate="${esc(g.id)}"
                data-status="${statusAttr}"
                ${isRunning ? 'disabled' : ''}
                title="${esc(`${g.command} ${(g.args || []).join(' ')}`)}"
              >
                <span>${esc(g.label || g.id)}</span>
                <span class="mono-num text-xs">${esc(statusText)}${esc(dur)}</span>
              </button>`;
          })
          .join('');
      }
    }
  }

  function renderSelects() {
    if (!renderCustomSelect) return;
    const latestId = st.statusData?.latestReport?.reportId || '';
    const opts = [
      {
        value: 'latest',
        label: latestId ? t('review.history.latestWithId', { id: latestId.slice(-8) }) : t('review.history.latest'),
      },
      ...(st.historyItems || [])
        .filter((it) => it && it.reportId && it.reportId !== latestId)
        .slice(0, 15)
        .map((it) => ({
          value: it.reportId,
          label: `${it.scope} / ${fmtTime(it.createdAt, lang())} (${it.summary?.total ?? 0})`,
        })),
    ];
    renderCustomSelect('reviewHistorySelectHost', {
      id: 'reviewHistorySelect',
      value: st.activeReportId,
      options: opts,
      alignRight: true,
      compact: true,
    });
  }

  function renderFindingsSection() {
    pruneSelection();

    // Severity filter buttons
    document.querySelectorAll('#reviewSevFilters [data-review-sev]').forEach((btn) => {
      btn.dataset.active = String(!st.showIgnored && btn.dataset.reviewSev === st.severityFilter);
    });

    const ignoredBtn = byId('reviewShowIgnoredBtn');
    const ignoredCount = getIgnoredFindings().length;
    if (ignoredBtn) {
      ignoredBtn.dataset.active = String(st.showIgnored);
      ignoredBtn.classList.toggle('hidden', ignoredCount === 0 && !st.showIgnored);
      ignoredBtn.textContent = t('review.filter.ignoredCount', { count: ignoredCount });
    }

    // Batch fix bar
    const fixBar = byId('reviewFixBar');
    const fixCount = byId('reviewFixCountLabel');
    const fixBtn = byId('reviewFixSelectedBtn');
    const selectedCount = st.selectedIds.size;
    if (fixBar) {
      fixBar.classList.toggle('hidden', selectedCount === 0 || st.showIgnored);
    }
    if (fixCount) {
      fixCount.textContent = t('review.fixBar.selected', { count: selectedCount });
    }
    if (fixBtn) {
      fixBtn.textContent = canSendMessage?.() ? t('review.fixBar.sendBtn') : t('review.fixBar.copyBtn');
    }

    const listEl = byId('reviewFindingsList');
    if (!listEl) return;

    const list = getFilteredFindings();
    if (!st.activeReport) {
      listEl.innerHTML = `<div class="review-empty">${esc(t('review.empty.noScan'))}</div>`;
      return;
    }
    if (!list.length) {
      listEl.innerHTML = `<div class="review-empty">${esc(
        st.showIgnored ? t('review.empty.noIgnored') : t('review.empty.clean')
      )}</div>`;
      return;
    }

    const sourceLabel = (src) => {
      if (src === 'ai_subagent') return t('review.source.ai');
      if (src === 'gate') return t('review.source.gate');
      return t('review.source.static');
    };
    const sevLabel = (sev) => t(`review.sev.${sev}`);

    listEl.innerHTML = list
      .map((f) => {
        const isIgnored = Boolean(f.ignored);
        const isSelected = !isIgnored && st.selectedIds.has(f.id);
        const loc = f.endLine && f.endLine > f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line || 1}`;
        return `
          <div class="review-finding-card" data-finding-id="${esc(f.id)}" data-selected="${isSelected}" data-ignored="${isIgnored}">
            ${
              isIgnored
                ? ''
                : `<input type="checkbox" class="shrink-0" style="margin-top:3px;accent-color:var(--primary);cursor:pointer;" data-review-check="${esc(f.id)}" ${isSelected ? 'checked' : ''} aria-label="${esc(f.title)}" />`
            }
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="review-sev-badge" data-sev="${esc(f.severity)}">${esc(sevLabel(f.severity))}</span>
                <span class="review-source-pill" data-source="${esc(f.source)}">${esc(sourceLabel(f.source))}</span>
                ${f.ruleId ? `<span class="agy-pill mono-num text-xs">${esc(f.ruleId)}</span>` : ''}
                <span class="text-xs font-medium text-fg">${esc(f.title)}</span>
              </div>
              <div class="review-file-loc mono-num">${esc(loc)}</div>
              ${f.detail ? `<div class="text-xs text-muted leading-relaxed">${esc(f.detail)}</div>` : ''}
              ${f.suggestion ? `<div class="text-xs text-fg leading-relaxed"><strong>${esc(t('review.suggestionLabel'))}</strong>${esc(f.suggestion)}</div>` : ''}
            </div>
            <div class="shrink-0 flex items-center gap-1.5">
              <button
                type="button"
                class="agy-btn agy-btn-secondary agy-btn-sm text-xs"
                data-review-ignore="${esc(f.id)}"
                data-next-ignored="${isIgnored ? 'false' : 'true'}"
              >${esc(isIgnored ? t('review.action.restore') : t('review.action.ignore'))}</button>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderAll() {
    renderNavBadges();
    renderScopeControls();
    renderStatsAndGates();
    renderSelects();
    renderFindingsSection();
  }

  async function loadStatus(silent = true) {
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'status',
        projectDir: getProjectDir?.() || undefined,
        conversationId: getConversationId?.() || undefined,
      });
      if (res) {
        st.statusData = res;
        st.availableGates = Array.isArray(res.availableGates) ? res.availableGates : [];
        if (st.activeReportId === 'latest') {
          st.activeReport = res.latestReport || null;
          if (st.activeReport?.scope && SCOPES.includes(st.activeReport.scope)) {
            st.scope = st.activeReport.scope;
          }
        }
        st.loaded = true;
        renderAll();
      }
      return res;
    } catch (err) {
      if (!silent) showToast(t('review.toast.loadFailed', { error: err?.message || String(err) }), 'error');
      return null;
    }
  }

  async function loadHistory() {
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'history',
        projectDir: getProjectDir?.() || undefined,
      });
      if (Array.isArray(res?.items)) {
        st.historyItems = res.items;
        renderSelects();
      }
    } catch {
      /* non-fatal */
    }
  }

  async function runScan(showSpinner = true) {
    if (st.busy) return;
    st.busy = true;
    const svg = byId('reviewRefreshSvg');
    if (showSpinner && svg) svg.classList.add('spin-once');
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'scan',
        scope: st.scope,
        baseRef: st.scope === 'branch' && st.baseRef.trim() ? st.baseRef.trim() : undefined,
        projectDir: getProjectDir?.() || undefined,
        conversationId: getConversationId?.() || undefined,
      });
      if (res?.report) {
        st.activeReportId = 'latest';
        st.activeReport = res.report;
        if (Array.isArray(res.availableGates)) st.availableGates = res.availableGates;
        st.statusData = { ...(st.statusData || {}), latestReport: res.report, availableGates: st.availableGates };
        st.selectedIds.clear();
        renderAll();
        void loadHistory();
        showToast(
          t('review.toast.scanDone', {
            files: res.diffStats?.files ?? 0,
            total: res.report.summary?.total ?? 0,
          }),
          'success'
        );
      }
    } catch (err) {
      showToast(t('review.toast.scanFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      st.busy = false;
      if (svg) setTimeout(() => svg.classList.remove('spin-once'), 360);
    }
  }

  async function runGate(gateId) {
    if (!gateId || st.runningGateId) return;
    st.runningGateId = gateId;
    renderStatsAndGates();
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'run_gate',
        gateId,
        scope: st.scope,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.report) {
        st.activeReportId = 'latest';
        st.activeReport = res.report;
        st.statusData = { ...(st.statusData || {}), latestReport: res.report };
      }
      const ok = Boolean(res?.gateResult?.ok);
      showToast(
        ok
          ? t('review.toast.gatePass', { gate: res?.gateResult?.label || gateId })
          : t('review.toast.gateFail', { gate: res?.gateResult?.label || gateId }),
        ok ? 'success' : 'error'
      );
    } catch (err) {
      showToast(t('review.toast.gateError', { error: err?.message || String(err) }), 'error');
    } finally {
      st.runningGateId = null;
      renderAll();
    }
  }

  async function launchAiReview(mode = 'fast') {
    if (st.busy) return;
    st.busy = true;
    try {
      const built = await callAppTool('app_review_manage', {
        action: 'build_subagent_prompt',
        scope: st.scope,
        baseRef: st.scope === 'branch' && st.baseRef.trim() ? st.baseRef.trim() : undefined,
        mode,
        projectDir: getProjectDir?.() || undefined,
        conversationId: getConversationId?.() || undefined,
      });
      const prompt = built?.prompt || '';
      if (!prompt) throw new Error('Empty review prompt');

      const sent = await sendToAgent?.(prompt);
      if (sent?.mode === 'sent') {
        showToast(t('review.toast.aiSent', { mode: t(`review.mode.${mode}`), tokens: built.tokens || 0 }), 'success');
      } else if (sent?.mode === 'attached') {
        showToast(t('review.toast.aiAttached', { tokens: built.tokens || 0 }), 'success');
      } else {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt).catch(() => {});
        showToast(t('review.toast.aiCopied', { tokens: built.tokens || 0 }), 'info');
      }
    } catch (err) {
      showToast(t('review.toast.aiFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      st.busy = false;
    }
  }

  async function handleFixSelected() {
    const ids = [...st.selectedIds];
    if (!ids.length) return;
    try {
      const built = await callAppTool('app_review_manage', {
        action: 'build_fix_prompt',
        findingIds: ids,
        reportId: st.activeReportId !== 'latest' ? st.activeReportId : undefined,
        projectDir: getProjectDir?.() || undefined,
      });
      const prompt = built?.prompt || '';
      if (!prompt) throw new Error('Empty fix prompt');
      const sent = await sendToAgent?.(prompt);
      if (sent?.mode === 'sent') {
        showToast(t('review.toast.fixSent', { count: built.count || ids.length }), 'success');
      } else if (sent?.mode === 'attached') {
        showToast(t('review.toast.fixAttached', { count: built.count || ids.length }), 'success');
      } else {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt).catch(() => {});
        showToast(t('review.toast.fixCopied', { count: built.count || ids.length }), 'info');
      }
    } catch (err) {
      showToast(t('review.toast.fixFailed', { error: err?.message || String(err) }), 'error');
    }
  }

  async function handleToggleIgnore(findingId, ignored) {
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'set_ignore',
        findingId,
        ignored,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.report) {
        st.activeReport = res.report;
        st.statusData = { ...(st.statusData || {}), latestReport: res.report };
      }
      if (ignored) st.selectedIds.delete(findingId);
      renderAll();
      showToast(ignored ? t('review.toast.ignored') : t('review.toast.restored'), 'success');
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    }
  }

  async function handleSelectPick(id, val) {
    if (id !== 'reviewHistorySelect') return false;
    st.activeReportId = val || 'latest';
    st.selectedIds.clear();
    if (st.activeReportId === 'latest') {
      st.activeReport = st.statusData?.latestReport || null;
      renderAll();
      return true;
    }
    try {
      const res = await callAppTool('app_review_manage', {
        action: 'history',
        reportId: st.activeReportId,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.report) {
        st.activeReport = res.report;
      }
      renderAll();
    } catch (err) {
      showToast(err?.message || String(err), 'error');
    }
    return true;
  }

  function init() {
    byId('reviewScopeSeg')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review-scope]');
      if (!btn) return;
      const next = btn.dataset.reviewScope;
      if (!SCOPES.includes(next)) return;
      st.scope = next;
      renderScopeControls();
      if (next !== 'branch') {
        void runScan(true);
      }
    });

    byId('reviewBaseRefInput')?.addEventListener('change', (e) => {
      st.baseRef = String(e.target.value || '').trim();
    });

    byId('reviewScanBtn')?.addEventListener('click', () => void runScan(true));
    byId('reviewRefreshBtn')?.addEventListener('click', () => void runScan(true));
    byId('reviewAiFastBtn')?.addEventListener('click', () => void launchAiReview('fast'));
    byId('reviewAiDeepBtn')?.addEventListener('click', () => void launchAiReview('deep'));
    byId('reviewFixSelectedBtn')?.addEventListener('click', () => void handleFixSelected());
    byId('reviewClearSelectBtn')?.addEventListener('click', () => {
      st.selectedIds.clear();
      renderFindingsSection();
    });

    byId('reviewSelectAllBtn')?.addEventListener('click', () => {
      const visible = getFilteredFindings();
      if (visible.every((f) => st.selectedIds.has(f.id))) {
        visible.forEach((f) => st.selectedIds.delete(f.id));
      } else {
        visible.forEach((f) => st.selectedIds.add(f.id));
      }
      renderFindingsSection();
    });

    byId('reviewImportBtn')?.addEventListener('click', () => {
      const ta = byId('reviewImportTextarea');
      if (ta) ta.value = '';
      openModal?.('reviewImportModal');
    });

    byId('reviewImportForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawReport = String(byId('reviewImportTextarea')?.value || '').trim();
      if (!rawReport) return;
      void (async () => {
        try {
          const res = await callAppTool('app_review_manage', {
            action: 'ingest_report',
            scope: st.scope,
            rawReport,
            projectDir: getProjectDir?.() || undefined,
          });
          if (res?.report) {
            st.activeReportId = 'latest';
            st.activeReport = res.report;
            st.statusData = { ...(st.statusData || {}), latestReport: res.report };
          }
          closeModal?.('reviewImportModal');
          renderAll();
          void loadHistory();
          showToast(t('review.toast.imported', { count: res?.importedCount ?? 0 }), 'success');
        } catch (err) {
          showToast(t('review.toast.importFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });

    byId('reviewGatesBar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review-gate]');
      if (!btn || btn.disabled) return;
      void runGate(btn.dataset.reviewGate);
    });

    byId('reviewSevFilters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review-sev]');
      if (!btn) return;
      const next = btn.dataset.reviewSev;
      if (!SEVERITIES.includes(next)) return;
      st.showIgnored = false;
      st.severityFilter = next;
      renderFindingsSection();
    });

    byId('reviewShowIgnoredBtn')?.addEventListener('click', () => {
      st.showIgnored = !st.showIgnored;
      renderFindingsSection();
    });

    byId('reviewFindingsList')?.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-review-check]');
      if (!cb) return;
      const id = cb.dataset.reviewCheck;
      if (cb.checked) st.selectedIds.add(id);
      else st.selectedIds.delete(id);
      renderFindingsSection();
    });

    byId('reviewFindingsList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-review-ignore]');
      if (!btn) return;
      void handleToggleIgnore(btn.dataset.reviewIgnore, btn.dataset.nextIgnored === 'true');
    });
  }

  async function activate() {
    await loadStatus(true);
    void loadHistory();
    if (!st.activeReport) {
      await runScan(false);
    }
  }

  return {
    init,
    activate,
    loadStatus,
    runScan,
    renderAll,
    renderSelects,
    handleSelectPick,
  };
}
