/**
 * Monitor Vault & Handoff Capsule module:
 * Project memory vault list, search, add/archive, and 3-tier Handoff Capsule editor.
 */

import { esc, fmtRelativeTime } from '../core/dom.mjs';

export function createMonitorVaultModule({
  state,
  tr,
  getUiLang,
  callAppTool,
  getMcpApp,
  showToast,
  openModal,
  closeModal,
  positionIndicator,
  renderVaultSelects,
}) {
  let lastVaultRenderSig = '';

  function resetCache() {
    lastVaultRenderSig = '';
  }

  function renderVault() {
    const v = state.vaultData;
    if (!v) return;
    const items = v.items || [];
    const vaultSig = `${getUiLang()}|${v.storagePath || ''}|${v.commitsAhead || 0}|${v.staleCount || 0}|${items.map((it) => `${it.id}:${it.updatedAt}:${it.kind}:${it.title}:${it.summary}`).join('\u001f')}`;
    if (vaultSig === lastVaultRenderSig) return;
    lastVaultRenderSig = vaultSig;

    const pathEl = document.getElementById('vaultPathLabel');
    if (pathEl) pathEl.textContent = v.storagePath || '%USERPROFILE%\\.context-cache';

    const staleBadge = document.getElementById('vaultStaleBadge');
    if (staleBadge) {
      if (v.commitsAhead > 0) {
        staleBadge.textContent = tr('monitor.vault.commitsAhead', { count: v.commitsAhead });
        staleBadge.classList.remove('hidden');
      } else if (v.staleCount > 0) {
        staleBadge.textContent = tr('monitor.vault.staleHead', { count: v.staleCount });
        staleBadge.classList.remove('hidden');
      } else {
        staleBadge.classList.add('hidden');
      }
    }

    const el = document.getElementById('vaultList');
    if (!el) return;
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
            <span>${esc(fmtRelativeTime(it.updatedAt, tr))}</span>
            ${(it.tags || []).map((tag) => `<span>#${esc(tag)}</span>`).join('')}
          </div>
        </div>
        <button type="button" data-archive-mem="${esc(it.id)}" class="agy-btn agy-btn-secondary agy-btn-sm text-xs shrink-0">${esc(tr('monitor.vault.archive'))}</button>
      </div>`
      )
      .join('');
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
    renderVaultSelects?.(true);
    renderVault();
    return state.vaultData;
  }

  async function archiveMemory(id) {
    await callAppTool('app_vault_manage', { action: 'archive', id });
    await loadVault();
    const msg = tr('toast.memoryArchived');
    showToast(msg !== 'toast.memoryArchived' ? msg : getUiLang() === 'en' ? 'Memory archived locally' : '已归档该条记忆');
  }

  function renderCapsuleModal() {
    const cap = state.capsuleData;
    if (!cap) return;
    const preset = cap.budgetPreset || state.capsuleBudgetPreset || 'standard';
    state.capsuleBudgetPreset = preset;

    document.querySelectorAll('#capsuleBudgetNav .capsule-budget-btn').forEach((b) => {
      b.dataset.active = String(b.dataset.capBudget === preset);
    });

    const gitMeta = document.getElementById('capsuleGitMeta');
    if (gitMeta) gitMeta.textContent = `${cap.project} / ${cap.branch}@${cap.head}`;

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
    const decCount = document.getElementById('capsuleDecCount');
    if (decCount) decCount.textContent = `${selectedCount} / ${decisions.length}`;

    const decHost = document.getElementById('capsuleDecisionsList');
    if (decHost) {
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
    }

    const fileItems =
      Array.isArray(cap.fileItems) && cap.fileItems.length
        ? cap.fileItems
        : (cap.touchedFiles || []).map((p) => ({ path: p, status: '', checked: true }));
    const checkedFiles = fileItems.filter((f) => f.checked !== false).length;
    const filesCountEl = document.getElementById('capsuleFilesCount');
    if (filesCountEl) filesCountEl.textContent = `${checkedFiles} / ${fileItems.length}`;

    const filesHost = document.getElementById('capsuleFilesList');
    if (filesHost) {
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
    }

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

    const rawPre = document.getElementById('capsuleRawPre');
    if (rawPre) rawPre.textContent = cap.agentPayload || '';

    const attachBtn = document.getElementById('attachCapsuleBtn');
    if (attachBtn) attachBtn.classList.toggle('hidden', !state.canUpdateModelContext);
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
    state.capsuleData = await callAppTool('app_vault_manage', {
      action: 'capsule',
      conversationId: state.activeConversationId || undefined,
      projectDir: state.activeProjectDir || undefined,
      budgetPreset: state.capsuleBudgetPreset,
    });
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
    document.getElementById('capsuleHumanView')?.classList.toggle('hidden', mode !== 'human');
    document.getElementById('capsuleAgentView')?.classList.toggle('hidden', mode !== 'agent');
  }

  function bindEvents() {
    document.getElementById('openCapsuleFromVaultBtn')?.addEventListener('click', () => void openCapsuleModal());
    document.getElementById('openAddMemBtn')?.addEventListener('click', () => openModal('addMemModal'));

    let vaultTimer = null;
    document.getElementById('vaultSearch')?.addEventListener('input', () => {
      clearTimeout(vaultTimer);
      vaultTimer = setTimeout(() => void loadVault(), 180);
    });

    document.querySelectorAll('#capsuleModeNav .seg-tab').forEach((btn) => {
      btn.addEventListener('click', () => setCapsuleMode(btn.dataset.cmode));
    });

    document.getElementById('capsuleBudgetNav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cap-budget]');
      if (!btn) return;
      const nextPreset = btn.dataset.capBudget;
      if (!nextPreset || nextPreset === state.capsuleBudgetPreset) return;
      void reloadCapsule({ budgetPreset: nextPreset });
    });

    let capsuleEditTimer = null;
    const scheduleCapsuleEdit = () => {
      clearTimeout(capsuleEditTimer);
      capsuleEditTimer = setTimeout(() => void reloadCapsule(), 260);
    };
    document.getElementById('capsuleGoalInput')?.addEventListener('input', scheduleCapsuleEdit);
    document.getElementById('capsuleNextActionInput')?.addEventListener('input', scheduleCapsuleEdit);

    document.getElementById('capsuleDecisionsList')?.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-cap-dec]');
      if (!cb || !state.capsuleData) return;
      const dec = (state.capsuleData.decisions || []).find((d) => d.id === cb.dataset.capDec);
      if (dec) dec.checked = cb.checked;
      void reloadCapsule();
    });

    document.getElementById('capsuleFilesList')?.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-cap-file]');
      if (!cb || !state.capsuleData) return;
      const item = (state.capsuleData.fileItems || []).find((f) => f.path === cb.dataset.capFile);
      if (item) item.checked = cb.checked;
      void reloadCapsule();
    });

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
    document.getElementById('copyCapsuleBtn')?.addEventListener('click', handleCopyCapsule);
    document.getElementById('copyCapsuleFooterBtn')?.addEventListener('click', handleCopyCapsule);

    const buildCapsuleTitle = (goalTxt) => {
      const prefix = getUiLang() === 'en' ? 'Handoff Capsule: ' : '交接胶囊：';
      return `${prefix}${goalTxt.slice(0, 64)}`;
    };

    document.getElementById('saveCapsuleOnlyBtn')?.addEventListener('click', () => {
      void (async () => {
        if (state.capsuleData) {
          const goalTxt = (document.getElementById('capsuleGoalInput')?.value || state.capsuleData.activeGoal || '').trim();
          await callAppTool('app_vault_manage', {
            action: 'save',
            conversationId: state.activeConversationId || undefined,
            projectDir: state.activeProjectDir || undefined,
            kind: 'checkpoint',
            title: buildCapsuleTitle(goalTxt),
            summary: state.capsuleData.agentPayload,
            tags: ['handoff-capsule'],
          });
          await loadVault();
        }
        closeModal('capsuleModal');
        showToast(tr('toast.capsuleSaved'));
      })();
    });

    document.getElementById('attachCapsuleBtn')?.addEventListener('click', () => {
      void (async () => {
        if (!state.capsuleData) return;
        const goalTxt = (document.getElementById('capsuleGoalInput')?.value || state.capsuleData.activeGoal || '').trim();
        await callAppTool('app_vault_manage', {
          action: 'save',
          conversationId: state.activeConversationId || undefined,
          projectDir: state.activeProjectDir || undefined,
          kind: 'checkpoint',
          title: buildCapsuleTitle(goalTxt),
          summary: state.capsuleData.agentPayload,
          tags: ['handoff-capsule'],
        });
        const mcpApp = getMcpApp?.();
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

    document.getElementById('addMemForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void (async () => {
        const titleEl = document.getElementById('newMemTitle');
        const bodyEl = document.getElementById('newMemBody');
        const title = titleEl?.value.trim() || '';
        const summary = bodyEl?.value.trim() || '';
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
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
        closeModal('addMemModal');
        await loadVault();
        const savedMsg = tr('toast.memorySaved');
        showToast(
          savedMsg !== 'toast.memorySaved'
            ? savedMsg
            : getUiLang() === 'en'
              ? 'Saved to local memory vault'
              : '已保存至本地记忆库',
          'success'
        );
      })();
    });
  }

  return {
    renderVault,
    loadVault,
    archiveMemory,
    openCapsuleModal,
    reloadCapsule,
    renderCapsuleModal,
    setCapsuleMode,
    bindEvents,
    resetCache,
  };
}
