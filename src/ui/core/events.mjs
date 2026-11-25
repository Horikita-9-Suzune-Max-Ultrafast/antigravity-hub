/**
 * Delegated UI event router & select-pick dispatcher.
 */

import { clampHelpTip, clampOpenKvPopovers, clampOpenSelectMenus } from './dom.mjs';
import { parseSizeDimensions, resetSessionViewState } from './store.mjs';
import { renderFollowToggle } from '../components/custom-select.mjs';

export function bindGlobalUiEvents({
  state,
  prevDisplay,
  tr,
  getUiLang,
  isNativePopout,
  rpc,
  callAppTool,
  persistConfigPatch,
  modalCtrl,
  monitorContext,
  monitorCalls,
  monitorStats,
  monitorVault,
  reviewModule,
  governanceModule,
  appearanceModule,
  i18nModule,
  settingsModule,
  nativeChrome,
  resizeScheduler,
  renderCallsSelects,
  renderVaultSelects,
  renderAllSelects,
  closeSelectMenus,
  closeKvPopovers,
  toggleKvPopover,
  switchModule,
  switchTab,
  openSettingsPage,
  closeSettingsPage,
  openPopoutWindow,
  exitGlobalLauncherMode,
  pollAll,
  restartPollTimer,
}) {
  function handleSelectPick(id, val) {
    state.openSelectId = null;
    if (id === 'pollInterval') {
      const sec = Number(val) || 0;
      state.config.pollIntervalSec = sec;
      void persistConfigPatch({ pollIntervalSec: sec }).catch(() => {});
      restartPollTimer();
      renderAllSelects();
      return;
    }
    if (id === 'sessionSelect') {
      if (val === '__auto__') {
        state.followMode = 'auto';
        state.pinnedConversationId = null;
      } else {
        state.followMode = 'pinned';
        state.pinnedConversationId = val || null;
        state.activeConversationId = val || null;
      }
      resetSessionViewState(state, prevDisplay);
      rpc.invalidateRev();
      renderAllSelects();
      void pollAll(true);
      return;
    }
    if (id === 'callsModel') {
      state.modelFilter = val || 'all';
      renderCallsSelects();
      monitorCalls.renderCalls();
      return;
    }
    if (id === 'callsAgent') {
      state.agentFilter = val || 'all';
      renderCallsSelects();
      monitorCalls.renderCalls();
      return;
    }
    if (id === 'statsModel') {
      state.statsModelFilter = val || 'all';
      monitorStats?.renderSelects();
      void monitorStats?.loadStats(false);
      return;
    }
    if (id === 'vaultKind') {
      state.vaultKind = val || 'all';
      renderVaultSelects();
      void monitorVault.loadVault();
      return;
    }
    if (id === 'newMemKind') {
      state.newMemKind = val;
      renderVaultSelects();
      return;
    }
    if (id === 'ctxModelSim') {
      state.modelSimLimit = val;
      monitorContext.renderContextModelSim();
      return;
    }
    if (id === 'popoutSize') {
      if (!state.config.popout) state.config.popout = {};
      state.config.popout.size = val;
      void persistConfigPatch({ popout: { size: val } }).catch(() => {});
      settingsModule.renderSharedWidthPresets();
      renderAllSelects();
      if (isNativePopout) {
        const { width } = parseSizeDimensions(val);
        nativeChrome.setSharedWidth(width);
      }
      return;
    }
    if (reviewModule.handleSelectPick?.(id, val)) return;
    if (i18nModule.handleSelectPick?.(id, val)) return;
    if (appearanceModule.handleSelectPick?.(id, val)) return;
    renderAllSelects();
  }

  document.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-select-toggle]');
    if (toggleBtn) {
      e.stopPropagation();
      const id = toggleBtn.dataset.selectToggle;
      state.openSelectId = state.openSelectId === id ? null : id;
      renderAllSelects();
      return;
    }
    const pickBtn = e.target.closest('[data-select-pick]');
    if (pickBtn) {
      e.stopPropagation();
      handleSelectPick(pickBtn.dataset.selectPick, pickBtn.dataset.selectVal ?? '');
      return;
    }
    const closeModalBtn = e.target.closest('[data-close-modal]');
    if (closeModalBtn) return modalCtrl.closeModal(closeModalBtn.dataset.closeModal);
    if (e.target.classList?.contains('modal-backdrop') && e.target.id) return modalCtrl.closeModal(e.target.id);

    const accIdxBtn = e.target.closest('[data-acc-idx]');
    if (accIdxBtn) {
      const idx = Number(accIdxBtn.dataset.accIdx);
      state.openAccIdx = state.openAccIdx === idx ? -1 : idx;
      document.querySelectorAll('#inventoryList .acc-trigger').forEach((b, i) => {
        b.dataset.open = String(i === state.openAccIdx);
      });
      document.querySelectorAll('#inventoryList .inv-acc-body').forEach((body, i) => {
        body.dataset.open = String(i === state.openAccIdx);
      });
      return;
    }
    const accBtn = e.target.closest('[data-accordion]');
    if (accBtn) {
      const acc = document.getElementById(accBtn.dataset.accordion);
      if (acc) acc.dataset.open = String(acc.dataset.open !== 'true');
      return;
    }
    const invItemBtn = e.target.closest('[data-inv-group][data-inv-item]');
    if (invItemBtn) {
      return void monitorContext.openAssetInspector(
        Number(invItemBtn.dataset.invGroup),
        Number(invItemBtn.dataset.invItem)
      );
    }

    const alertBtn = e.target.closest('[data-alert-idx], [data-alert-jump]');
    if (alertBtn) {
      const idx = alertBtn.dataset.alertIdx ?? alertBtn.dataset.alertJump;
      return void monitorContext.handleAlertJump(Number(idx));
    }

    const callRow = e.target.closest('tr.call-row[data-call-id]');
    if (callRow) return monitorCalls.toggleCallExpand(callRow.dataset.callId);

    if (e.target.closest('[data-toggle-all-calls]')) {
      state.showAllCalls = !state.showAllCalls;
      monitorCalls.renderCalls();
      return;
    }
    const archBtn = e.target.closest('[data-archive-mem]');
    if (archBtn) return void monitorVault.archiveMemory(archBtn.dataset.archiveMem);

    const kvBtn = e.target.closest('#kvHelpBtn');
    if (kvBtn) {
      e.stopPropagation();
      return toggleKvPopover('kvHelpPopover', kvBtn);
    }
    const settingsKvBtn = e.target.closest('#settingsKvHelpBtn');
    if (settingsKvBtn) {
      e.stopPropagation();
      return toggleKvPopover('settingsKvHelpPopover', settingsKvBtn);
    }
    if (e.target.closest('#kvHelpCloseBtn, #settingsKvHelpCloseBtn')) return closeKvPopovers();

    if (state.openSelectId && !e.target.closest('.agy-select')) closeSelectMenus();
    if (!e.target.closest('.kv-help-popover, .kv-help-btn')) closeKvPopovers();
  });

  document.addEventListener('mouseover', (e) => {
    const tipWrap = e.target.closest('.help-tip-wrap');
    if (tipWrap) clampHelpTip(tipWrap);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSelectMenus();
      closeKvPopovers();
      modalCtrl.closeAllModals();
    }
  });

  document.querySelectorAll('#consoleRail [data-module], #consoleTopBar [data-module]').forEach((btn) => {
    btn.addEventListener('click', () => switchModule(btn.dataset.module));
  });
  document.getElementById('railSettingsBtn')?.addEventListener('click', () => openSettingsPage());
  document.getElementById('topBarSettingsBtn')?.addEventListener('click', () => openSettingsPage());
  document.getElementById('topBarPopoutBtn')?.addEventListener('click', () => void openPopoutWindow({ manual: true }));
  document.getElementById('exitSettingsBtn')?.addEventListener('click', () => closeSettingsPage());
  document.querySelectorAll('#mainSegNav .seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('followToggleBtn')?.addEventListener('click', () => {
    state.followMode = state.followMode === 'auto' ? 'pinned' : 'auto';
    renderFollowToggle({ state, tr, getUiLang });
    if (state.followMode === 'auto') {
      rpc.invalidateRev();
      void pollAll(true);
    }
  });
  document.getElementById('refreshBtn')?.addEventListener('click', () => void pollAll(true));
  document.getElementById('quickPopoutBtn')?.addEventListener('click', () => void openPopoutWindow({ manual: true }));
  document.getElementById('launcherOpenPopoutBtn')?.addEventListener('click', () => void openPopoutWindow({ manual: true }));
  document.getElementById('launcherUseEmbeddedBtn')?.addEventListener('click', () => exitGlobalLauncherMode());
  document.getElementById('launcherClosePopoutBtn')?.addEventListener('click', () => {
    void (async () => {
      try {
        await callAppTool('app_config_manage', { action: 'close_popout' });
      } finally {
        exitGlobalLauncherMode();
      }
    })();
  });

  document.getElementById('consoleWorkspace')?.addEventListener(
    'scroll',
    () => {
      clampOpenSelectMenus();
      clampOpenKvPopovers();
    },
    { passive: true }
  );
  window.addEventListener('resize', () => resizeScheduler.schedule(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      monitorContext.startKvCountdownTimer();
      void pollAll(false);
    } else if (!(isNativePopout && state.windowMode === 'orb')) {
      monitorContext.stopKvCountdownTimer();
    }
  });
  window.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') nativeChrome.handleHostMessage(ev.data);
  });
}
