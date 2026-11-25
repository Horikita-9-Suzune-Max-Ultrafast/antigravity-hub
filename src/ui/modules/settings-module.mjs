/**
 * Settings Module:
 * - 5-module mini-bar priority sorting studio (FLIP drag, click-swap, arrow keys).
 * - Shared width quick buttons (380px / 460px / 640px) synced with both Console & MiniBar.
 * - Language switcher, KV cache window, thresholds, popout controls, self-update, Doctor, IDE restart.
 */

import { esc } from '../core/dom.mjs';
import {
  APP_VERSION,
  MINI_BAR_DEFAULT_ORDER,
  SHARED_WIDTH_PRESETS,
  getMiniBarModules,
  isPopoutOpen,
  parseSizeDimensions,
} from '../core/store.mjs';
import { renderIcon } from '../components/icons.mjs';
import { postHostWindowMsg } from './native-chrome.mjs';

export function createSettingsModule({
  state,
  tr,
  getUiLang,
  normalizeUiLang,
  defaultUiLang = 'zh-CN',
  isNativePopout = false,
  callAppTool,
  getMcpApp,
  persistConfigPatch,
  applyUiLanguage,
  restartPollTimer,
  renderContext,
  syncKvCountdownUi,
  renderNativePinButton,
  onMiniBarOrderChanged,
  onOpenPopout,
  onSetSharedWidth,
  showToast,
  openModal,
  closeModal,
}) {
  let miniBarSelectedMod = null;
  let lastMiniBarSig = '';
  let restartIdeBusy = false;
  let updateCheckBusy = false;
  let updateApplyBusy = false;
  let lastUpdateReleaseUrl = 'https://github.com/Horikita-9-Suzune-Max-Ultrafast/antigravity-hub/releases';

  function getMiniBarModuleMeta(mod) {
    const map = {
      context: { label: tr('settings.miniBar.modContext'), sample: '18.4%' },
      cache: { label: tr('settings.miniBar.modCache'), sample: '96%' },
      kv: { label: tr('settings.miniBar.modKv'), sample: '12:40' },
      tps: { label: tr('settings.miniBar.modTps'), sample: '48.2' },
      model: { label: tr('settings.miniBar.modModel'), sample: 'Neon' },
    };
    return map[mod] || { label: mod, sample: '' };
  }

  function applyMiniBarOrderWithFlip(nextOrder, selectedMod = miniBarSelectedMod) {
    const track = document.getElementById('miniBarPreviewTrack');
    const firstRects = new Map();
    if (track) {
      track.querySelectorAll('.minibar-slot-chip').forEach((el) => {
        firstRects.set(el.dataset.mod, el.getBoundingClientRect());
      });
    }

    miniBarSelectedMod = selectedMod;
    if (!state.config.popout) state.config.popout = {};
    state.config.popout.miniBarModules = [...nextOrder];
    lastMiniBarSig = '';
    renderMiniBarStudio();

    if (track && firstRects.size > 0) {
      track.querySelectorAll('.minibar-slot-chip').forEach((el) => {
        const prev = firstRects.get(el.dataset.mod);
        if (!prev) return;
        const cur = el.getBoundingClientRect();
        const dx = prev.left - cur.left;
        const dy = prev.top - cur.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform var(--dur-base) var(--ease-out)';
          el.style.transform = '';
        });
      });
    }

    onMiniBarOrderChanged?.([...nextOrder]);
    void persistConfigPatch({ popout: { miniBarModules: [...nextOrder] } }).catch(() => {});
  }

  function renderSharedWidthPresets() {
    const row = document.getElementById('sharedWidthPresetRow');
    if (!row) return;
    const { width: curW } = parseSizeDimensions(state.config?.popout?.size || '460x720');
    row.querySelectorAll('[data-shared-width]').forEach((btn) => {
      const w = Number(btn.dataset.sharedWidth);
      btn.dataset.active = String(Math.abs(w - curW) <= 12);
    });
  }

  function renderMiniBarStudio() {
    if (state.isDraggingMiniBar) return;
    const order = getMiniBarModules(state);
    const { width: curW } = parseSizeDimensions(state.config?.popout?.size || '460x720');
    const studioSig = `${getUiLang()}|${curW}|${order.join(',')}|${miniBarSelectedMod || ''}`;
    if (studioSig === lastMiniBarSig) return;
    lastMiniBarSig = studioSig;

    renderSharedWidthPresets();

    const customBadge = document.getElementById('miniBarCustomBadge');
    if (customBadge) customBadge.classList.add('hidden');

    const track = document.getElementById('miniBarPreviewTrack');
    if (!track) return;

    const leftIco = renderIcon('arrow-left', { size: 12 });
    const rightIco = renderIcon('arrow-right', { size: 12 });

    track.innerHTML = order
      .map((mod, idx) => {
        const meta = getMiniBarModuleMeta(mod);
        const isSelected = miniBarSelectedMod === mod;
        const nudgeHtml = isSelected
          ? `<span class="minibar-slot-nudge">
              <button type="button" class="minibar-nudge-btn" data-nudge="left" data-mod="${esc(mod)}" ${idx === 0 ? 'disabled' : ''} aria-label="Move left">${leftIco}</button>
              <button type="button" class="minibar-nudge-btn" data-nudge="right" data-mod="${esc(mod)}" ${idx === order.length - 1 ? 'disabled' : ''} aria-label="Move right">${rightIco}</button>
            </span>`
          : '';
        return `
        <div class="minibar-slot-chip" data-mod="${esc(mod)}" data-idx="${idx}" data-visible="true" data-selected="${isSelected}" tabindex="0">
          <span class="minibar-slot-idx mono-num">${idx + 1}</span>
          <span>${esc(meta.label)}</span>
          ${nudgeHtml}
        </div>`;
      })
      .join('');

    track.querySelectorAll('.minibar-nudge-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mod = btn.dataset.mod;
        const dir = btn.dataset.nudge === 'left' ? -1 : 1;
        const cur = getMiniBarModules(state);
        const from = cur.indexOf(mod);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= cur.length) return;
        [cur[from], cur[to]] = [cur[to], cur[from]];
        applyMiniBarOrderWithFlip(cur, mod);
      });
    });

    track.querySelectorAll('.minibar-slot-chip').forEach((chip) => {
      chip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const mod = chip.dataset.mod;
        const cur = getMiniBarModules(state);
        const from = cur.indexOf(mod);
        const to = from + (e.key === 'ArrowLeft' ? -1 : 1);
        if (from < 0 || to < 0 || to >= cur.length) return;
        [cur[from], cur[to]] = [cur[to], cur[from]];
        applyMiniBarOrderWithFlip(cur, mod);
      });

      chip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.minibar-nudge-btn')) return;
        e.preventDefault();
        const draggedMod = chip.dataset.mod;
        const startX = e.clientX;
        const startY = e.clientY;
        let isDragging = false;
        let ghostEl = null;
        let offsetX = 0;
        let offsetY = 0;
        let curOrder = getMiniBarModules(state);
        let orderChanged = false;
        let lastSwapAt = 0;
        let lastPointerX = startX;
        let lastPointerY = startY;

        const updateSlotBadges = () => {
          [...track.querySelectorAll('.minibar-slot-chip')].forEach((el, idx) => {
            el.dataset.idx = String(idx);
            const idxBadge = el.querySelector('.minibar-slot-idx');
            if (idxBadge) idxBadge.textContent = String(idx + 1);
          });
        };

        const reorderLiveWithFlip = (nextOrder) => {
          const siblings = [...track.querySelectorAll('.minibar-slot-chip')];
          const firstRects = new Map();
          siblings.forEach((el) => firstRects.set(el.dataset.mod, el.getBoundingClientRect()));

          const byMod = new Map(siblings.map((el) => [el.dataset.mod, el]));
          nextOrder.forEach((m) => {
            const el = byMod.get(m);
            if (el) track.appendChild(el);
          });
          updateSlotBadges();

          siblings.forEach((el) => {
            if (el === chip) return;
            const prev = firstRects.get(el.dataset.mod);
            if (!prev) return;
            const cur = el.getBoundingClientRect();
            const dx = prev.left - cur.left;
            const dy = prev.top - cur.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() => {
              el.style.transition = 'transform var(--dur-base) var(--ease-out)';
              el.style.transform = '';
            });
          });
        };

        const onMove = (ev) => {
          if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          if (!isDragging) {
            isDragging = true;
            state.isDraggingMiniBar = true;
            const rect = chip.getBoundingClientRect();
            offsetX = startX - rect.left;
            offsetY = startY - rect.top;

            ghostEl = chip.cloneNode(true);
            ghostEl.querySelector('.minibar-slot-nudge')?.remove();
            ghostEl.classList.remove('is-placeholder');
            ghostEl.classList.add('minibar-drag-ghost');
            ghostEl.style.width = `${Math.ceil(rect.width)}px`;
            ghostEl.style.height = `${Math.ceil(rect.height)}px`;
            ghostEl.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.04)`;
            document.body.appendChild(ghostEl);

            chip.classList.add('is-placeholder');
            try {
              chip.setPointerCapture(e.pointerId);
            } catch {
              /* ignore capture error */
            }
          }

          if (ghostEl) {
            ghostEl.style.transform = `translate3d(${ev.clientX - offsetX}px, ${ev.clientY - offsetY}px, 0) scale(1.04)`;
          }

          const now = performance.now();
          if (now - lastSwapAt < 180 || Math.hypot(ev.clientX - lastPointerX, ev.clientY - lastPointerY) < 2) return;
          lastPointerX = ev.clientX;
          lastPointerY = ev.clientY;

          const chips = [...track.querySelectorAll('.minibar-slot-chip')];
          const fromIdx = curOrder.indexOf(draggedMod);
          if (fromIdx < 0) return;

          let targetIdx = -1;
          for (let i = 0; i < chips.length; i++) {
            const el = chips[i];
            if (el === chip) continue;
            const r = el.getBoundingClientRect();
            if (ev.clientX >= r.left + 4 && ev.clientX <= r.right - 4 && ev.clientY >= r.top + 2 && ev.clientY <= r.bottom - 2) {
              targetIdx = i;
              break;
            }
          }

          if (targetIdx >= 0 && targetIdx !== fromIdx) {
            const next = [...curOrder];
            const [moved] = next.splice(fromIdx, 1);
            next.splice(targetIdx, 0, moved);
            curOrder = next;
            orderChanged = true;
            lastSwapAt = now;
            reorderLiveWithFlip(next);
            const ghostIdx = ghostEl?.querySelector('.minibar-slot-idx');
            if (ghostIdx) ghostIdx.textContent = String(targetIdx + 1);
          }
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);

          if (isDragging) {
            const finalizeDrop = () => {
              state.isDraggingMiniBar = false;
              ghostEl?.remove();
              ghostEl = null;
              chip.classList.remove('is-placeholder');
              if (orderChanged) {
                miniBarSelectedMod = draggedMod;
                if (!state.config.popout) state.config.popout = {};
                state.config.popout.miniBarModules = [...curOrder];
                lastMiniBarSig = '';
                renderMiniBarStudio();
                onMiniBarOrderChanged?.([...curOrder]);
                void persistConfigPatch({ popout: { miniBarModules: [...curOrder] } }).catch(() => {});
              }
            };

            if (ghostEl) {
              const dest = chip.getBoundingClientRect();
              ghostEl.style.transition = 'transform var(--dur-fast) var(--ease-out)';
              ghostEl.style.transform = `translate3d(${dest.left}px, ${dest.top}px, 0) scale(1)`;
              setTimeout(finalizeDrop, 160);
            } else {
              finalizeDrop();
            }
            return;
          }

          if (!miniBarSelectedMod) {
            miniBarSelectedMod = draggedMod;
            lastMiniBarSig = '';
            renderMiniBarStudio();
          } else if (miniBarSelectedMod === draggedMod) {
            miniBarSelectedMod = null;
            lastMiniBarSig = '';
            renderMiniBarStudio();
          } else {
            const cur = getMiniBarModules(state);
            const a = cur.indexOf(miniBarSelectedMod);
            const b = cur.indexOf(draggedMod);
            if (a >= 0 && b >= 0) {
              [cur[a], cur[b]] = [cur[b], cur[a]];
              applyMiniBarOrderWithFlip(cur, null);
            }
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });
  }

  function renderSettings() {
    const cfg = state.config || {};
    const uiLang = getUiLang();
    const zhBtn = document.getElementById('uiLangZhBtn');
    const enBtn = document.getElementById('uiLangEnBtn');
    if (zhBtn) zhBtn.dataset.active = String(uiLang === 'zh-CN');
    if (enBtn) enBtn.dataset.active = String(uiLang === 'en');

    const auxEl = document.getElementById('auxAutoSwitch');
    if (auxEl) auxEl.dataset.on = String(Boolean(cfg.auxAutoOpen));

    const startupAutoEl = document.getElementById('startupAutoPopoutSwitch');
    if (startupAutoEl) startupAutoEl.dataset.on = String(cfg.popout?.autoLaunchOnStartup !== false);

    const sidebarAutoEl = document.getElementById('sidebarAutoPopoutSwitch');
    if (sidebarAutoEl) sidebarAutoEl.dataset.on = String(cfg.popout?.autoLaunchFromSidebar !== false);

    const kvSwitchEl = document.getElementById('kvCacheSwitch');
    const kvOn = cfg.kvCache?.enabled !== false;
    if (kvSwitchEl) kvSwitchEl.dataset.on = String(kvOn);
    const kvControlsEl = document.getElementById('kvCacheControls');
    if (kvControlsEl) kvControlsEl.style.opacity = kvOn ? '1' : '0.45';
    const kvTtl = Math.max(3, Math.min(60, Math.round(Number(cfg.kvCache?.ttlMinutes) || 15)));
    const kvInputEl = document.getElementById('cfgKvTtlInput');
    if (kvInputEl) kvInputEl.value = kvTtl;
    document.querySelectorAll('#kvPresetGroup .kv-preset-btn').forEach((btn) => {
      btn.dataset.active = String(Number(btn.dataset.kvMin) === kvTtl);
    });

    renderMiniBarStudio();

    const topMostEl = document.getElementById('popoutTopMostSwitch');
    if (topMostEl) topMostEl.dataset.on = String(cfg.popout?.alwaysOnTop !== false);
    if (isNativePopout && cfg.popout && typeof cfg.popout.alwaysOnTop === 'boolean') {
      state.windowPinned = cfg.popout.alwaysOnTop;
      renderNativePinButton?.();
    }

    const popRunning = isPopoutOpen(state.popoutStatus);
    const popOn = Boolean(popRunning || cfg.popout?.enabled);
    const popSwitch = document.getElementById('popoutSwitch');
    if (popSwitch) popSwitch.dataset.on = String(popOn);

    const badge = document.getElementById('popoutStateBadge');
    if (badge) {
      badge.textContent = popRunning
        ? tr('settings.popout.running', { port: state.popoutStatus.port })
        : popOn
          ? tr('settings.popout.enabled')
          : tr('settings.popout.closed');
      badge.style.color = popOn ? 'var(--success)' : 'var(--muted-foreground)';
      badge.style.borderColor = popOn ? 'var(--green-6)' : 'var(--border)';
    }

    const bannerOn = Boolean(cfg.uiBanner?.enabled);
    const bannerSwitch = document.getElementById('bannerSwitch');
    if (bannerSwitch) bannerSwitch.dataset.on = String(bannerOn);
    const preview = document.getElementById('bannerPreview');
    if (preview) {
      preview.style.opacity = bannerOn ? '1' : '0.42';
      preview.textContent = state.callsData?.banner
        ? String(state.callsData.banner).replace(/\s*\u00B7\s*/g, ' | ')
        : tr('settings.banner.preview');
    }

    const budgetEl = document.getElementById('cfgBudgetInput');
    const warnEl = document.getElementById('cfgWarnPctInput');
    const dropEl = document.getElementById('cfgDropPctInput');
    if (budgetEl) budgetEl.value = cfg.sessionStartBudgetTokens ?? 450;
    if (warnEl) warnEl.value = cfg.alerts?.contextWarningPct ?? 75;
    if (dropEl) dropEl.value = cfg.alerts?.cacheDropThresholdPct ?? 50;

    const rep = state.doctorReport;
    const verEl = document.getElementById('settingsVersionLabel');
    if (verEl) verEl.textContent = tr('settings.version', { version: rep?.version || APP_VERSION });

    if (rep) {
      const pill = document.getElementById('doctorStatusPill');
      if (pill) {
        pill.textContent = rep.healthy ? tr('settings.doctor.healthy') : tr('settings.doctor.attention');
        pill.style.color = rep.healthy ? 'var(--success)' : 'var(--warning)';
        pill.style.borderColor = rep.healthy ? 'var(--green-6)' : 'var(--amber-6)';
      }

      const driftEl = document.getElementById('docDriftVal');
      if (driftEl) {
        driftEl.textContent = tr('settings.doctor.driftVal', { count: rep.drift.count });
        driftEl.style.color = rep.drift.count === 0 ? 'var(--success)' : 'var(--warning)';
      }

      const circuitEl = document.getElementById('docCircuitVal');
      if (circuitEl) circuitEl.textContent = `${rep.circuit.state} (${rep.circuit.failures} / ${rep.circuit.threshold})`;

      const idxEl = document.getElementById('docIndexVal');
      if (idxEl) {
        idxEl.textContent = tr('settings.doctor.indexVal', {
          status: rep.index.ok ? tr('settings.doctor.indexSynced') : tr('settings.doctor.indexRebuild'),
          count: rep.index.dbMemories,
        });
      }

      const deployEl = document.getElementById('docDeployVal');
      if (deployEl) {
        deployEl.textContent = tr('settings.doctor.deployVal', {
          version: rep.version || APP_VERSION,
          status: rep.deployment.zeroNodeModules ? tr('settings.doctor.deployClean') : tr('settings.doctor.deployDirty'),
        });
      }
    }
  }

  function applySharedWidthPreset(logicalWidth) {
    const safeW = Math.max(360, Math.min(1200, Math.round(Number(logicalWidth) || 460)));
    const { height } = parseSizeDimensions(state.config?.popout?.size || '460x720');
    const nextSize = `${safeW}x${height}`;
    if (!state.config.popout) state.config.popout = {};
    state.config.popout.size = nextSize;
    lastMiniBarSig = '';
    renderSharedWidthPresets();
    if (isNativePopout) {
      onSetSharedWidth?.(safeW);
    }
    void persistConfigPatch({ popout: { size: nextSize } })
      .then(() => {
        showToast(tr('toast.popoutSize', { size: `${safeW}px` }));
      })
      .catch((err) => {
        showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
      });
  }

  function bindEvents() {
    const openRestartIdeModal = () => {
      const confirmBtn = document.getElementById('restartIdeConfirmBtn');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = tr('monitor.restart.confirm');
      }
      openModal('restartIdeModal');
    };
    document.getElementById('restartIdeBtn')?.addEventListener('click', openRestartIdeModal);
    document.getElementById('settingsRestartIdeBtn')?.addEventListener('click', openRestartIdeModal);

    const openExternalUrl = async (url) => {
      if (!url || !/^https:\/\//i.test(String(url))) return;
      const mcpApp = getMcpApp?.();
      if (mcpApp && typeof mcpApp.openLink === 'function') {
        try {
          await mcpApp.openLink({ url });
          return;
        } catch {
          /* fallback to window.open */
        }
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    document.getElementById('settingsOpenReleaseBtn')?.addEventListener('click', () => {
      void openExternalUrl(lastUpdateReleaseUrl);
    });

    document.getElementById('settingsCheckUpdateBtn')?.addEventListener('click', () => {
      if (updateCheckBusy || updateApplyBusy) return;
      updateCheckBusy = true;
      const btn = document.getElementById('settingsCheckUpdateBtn');
      const statusEl = document.getElementById('settingsUpdateStatus');
      const boxEl = document.getElementById('settingsUpdateBox');
      const metaEl = document.getElementById('settingsUpdateMeta');
      const badgeEl = document.getElementById('settingsUpdateBadge');
      const notesEl = document.getElementById('settingsUpdateNotes');
      const applyBtn = document.getElementById('settingsApplyUpdateBtn');

      if (btn) {
        btn.disabled = true;
        btn.textContent = tr('settings.update.checking');
      }

      void (async () => {
        try {
          const res = await callAppTool('app_config_manage', { action: 'check_update' });
          if (res?.releaseUrl) lastUpdateReleaseUrl = res.releaseUrl;
          if (!res || res.ok === false) {
            const msg = res?.message || res?.error || 'network_error';
            if (statusEl) {
              statusEl.className = 'mono-num text-warning';
              statusEl.textContent = tr('settings.update.checkFailed', { error: msg });
            }
            boxEl?.classList.remove('hidden');
            if (metaEl) metaEl.textContent = msg;
            if (badgeEl) badgeEl.textContent = tr('settings.update.manualOnly');
            notesEl?.classList.add('hidden');
            applyBtn?.classList.add('hidden');
            showToast(tr('settings.update.checkFailed', { error: msg }), 'error');
            return;
          }
          if (!res.hasUpdate) {
            if (statusEl) {
              statusEl.className = 'mono-num text-success';
              statusEl.textContent = tr('settings.update.upToDate', { version: res.currentVersion || APP_VERSION });
            }
            boxEl?.classList.add('hidden');
            showToast(tr('settings.update.upToDate', { version: res.currentVersion || APP_VERSION }), 'success');
            return;
          }
          if (statusEl) {
            statusEl.className = 'mono-num text-primary font-medium';
            statusEl.textContent = tr('settings.update.available', { version: res.latestVersion });
          }
          boxEl?.classList.remove('hidden');
          if (metaEl) {
            metaEl.textContent = tr('settings.update.meta', {
              current: res.currentVersion || APP_VERSION,
              latest: res.latestVersion,
            });
          }
          if (badgeEl) {
            badgeEl.textContent = res.canAutoUpdate ? tr('settings.update.shaReady') : tr('settings.update.manualOnly');
          }
          if (notesEl) {
            if (res.notes) {
              notesEl.textContent = res.notes;
              notesEl.classList.remove('hidden');
            } else {
              notesEl.classList.add('hidden');
            }
          }
          applyBtn?.classList.toggle('hidden', !res.canAutoUpdate);
        } catch (err) {
          const msg = err?.message || String(err);
          if (statusEl) {
            statusEl.className = 'mono-num text-warning';
            statusEl.textContent = tr('settings.update.checkFailed', { error: msg });
          }
          showToast(tr('settings.update.checkFailed', { error: msg }), 'error');
        } finally {
          updateCheckBusy = false;
          if (btn) {
            btn.disabled = false;
            btn.textContent = tr('settings.update.checkBtn');
          }
        }
      })();
    });

    document.getElementById('settingsApplyUpdateBtn')?.addEventListener('click', () => {
      if (updateApplyBusy) return;
      updateApplyBusy = true;
      const applyBtn = document.getElementById('settingsApplyUpdateBtn');
      const statusEl = document.getElementById('settingsUpdateStatus');

      if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = tr('settings.update.applying');
      }

      void (async () => {
        try {
          const res = await callAppTool('app_config_manage', { action: 'apply_update' });
          if (res?.releaseUrl) lastUpdateReleaseUrl = res.releaseUrl;
          if (!res || res.ok === false) {
            const msg = res?.message || res?.error || 'update_failed';
            if (statusEl) {
              statusEl.className = 'mono-num text-error';
              statusEl.textContent = tr('settings.update.applyFailed', { error: msg });
            }
            showToast(tr('settings.update.applyFailed', { error: msg }), 'error');
            return;
          }
          const updatedVer = res.updatedVersion || res.latestVersion || APP_VERSION;
          if (statusEl) {
            statusEl.className = 'mono-num text-success font-medium';
            statusEl.textContent = tr('settings.update.updated', { version: updatedVer });
          }
          applyBtn?.classList.add('hidden');
          showToast(tr('settings.update.updated', { version: updatedVer }), 'success');
          if (res.requiresRestart) openRestartIdeModal();
        } catch (err) {
          showToast(tr('settings.update.applyFailed', { error: err?.message || String(err) }), 'error');
        } finally {
          updateApplyBusy = false;
          if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = tr('settings.update.applyBtn');
          }
        }
      })();
    });

    document.getElementById('restartIdeConfirmBtn')?.addEventListener('click', () => {
      if (restartIdeBusy) return;
      restartIdeBusy = true;
      const btn = document.getElementById('restartIdeConfirmBtn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = tr('monitor.restart.restarting');
      }
      void (async () => {
        try {
          const res = await callAppTool('app_config_manage', { action: 'restart_antigravity' });
          closeModal('restartIdeModal');
          if (res && res.ok === false) {
            showToast(tr('monitor.restart.failed', { error: res.message || res.error || res.status || 'not_found' }), 'error');
          } else {
            showToast(tr('monitor.restart.success'), 'success');
          }
        } catch (err) {
          showToast(tr('monitor.restart.failed', { error: err?.message || String(err) }), 'error');
        } finally {
          restartIdeBusy = false;
          if (btn) {
            btn.disabled = false;
            btn.textContent = tr('monitor.restart.confirm');
          }
        }
      })();
    });

    document.querySelectorAll('#uiLangSeg [data-ui-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextLang = normalizeUiLang(btn.dataset.uiLang);
        if (nextLang === getUiLang()) return;
        applyUiLanguage(nextLang);
        void persistConfigPatch({ uiLanguage: nextLang })
          .then(() => showToast(tr('toast.langUpdated'), 'success'))
          .catch((err) => showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error'));
      });
    });

    document.getElementById('auxAutoSwitch')?.addEventListener('click', () => {
      const next = !state.config.auxAutoOpen;
      void persistConfigPatch({ auxAutoOpen: next })
        .then(() => showToast(next ? tr('toast.auxAutoOn') : tr('toast.auxAutoOff')))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('startupAutoPopoutSwitch')?.addEventListener('click', () => {
      const next = state.config.popout?.autoLaunchOnStartup === false;
      void persistConfigPatch({ popout: { autoLaunchOnStartup: next } })
        .then(() => showToast(next ? tr('toast.startupPopoutOn') : tr('toast.startupPopoutOff')))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    // Shared width quick buttons: 380 / 460 / 640px
    document.getElementById('sharedWidthPresetRow')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-shared-width]');
      if (!btn) return;
      const w = Number(btn.dataset.sharedWidth);
      if (SHARED_WIDTH_PRESETS.includes(w) || w >= 360) {
        applySharedWidthPreset(w);
      }
    });

    document.getElementById('miniBarResetOrderBtn')?.addEventListener('click', () => {
      applyMiniBarOrderWithFlip([...MINI_BAR_DEFAULT_ORDER], null);
    });

    document.getElementById('kvCacheSwitch')?.addEventListener('click', () => {
      const next = state.config.kvCache?.enabled === false;
      void persistConfigPatch({ kvCache: { enabled: next } })
        .then(() => syncKvCountdownUi())
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    const updateKvTtl = (minutes) => {
      const clamped = Math.max(3, Math.min(60, Math.round(Number(minutes) || 15)));
      void persistConfigPatch({ kvCache: { ttlMinutes: clamped } })
        .then(() => syncKvCountdownUi())
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    };

    document.getElementById('kvPresetGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.kv-preset-btn');
      if (btn) updateKvTtl(Number(btn.dataset.kvMin));
    });
    document.getElementById('cfgKvTtlInput')?.addEventListener('change', (e) => {
      updateKvTtl(Number(e.target.value));
    });

    document.getElementById('sidebarAutoPopoutSwitch')?.addEventListener('click', () => {
      const next = state.config.popout?.autoLaunchFromSidebar === false;
      void persistConfigPatch({ popout: { autoLaunchFromSidebar: next } })
        .then(() => showToast(next ? tr('toast.sidebarPopoutOn') : tr('toast.sidebarPopoutOff')))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('popoutTopMostSwitch')?.addEventListener('click', () => {
      const next = state.config.popout?.alwaysOnTop === false;
      state.windowPinned = next;
      if (isNativePopout) {
        postHostWindowMsg(next ? 'pin:1' : 'pin:0');
        renderNativePinButton?.();
      }
      void persistConfigPatch({ popout: { alwaysOnTop: next } })
        .then(() => showToast(next ? tr('toast.pinnedTop') : tr('toast.unpinnedTop')))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('popoutSwitch')?.addEventListener('click', () => {
      const next = !(state.popoutStatus?.running || state.config.popout?.enabled);
      void (async () => {
        try {
          if (!next) {
            const res = await callAppTool('app_config_manage', { action: 'close_popout' });
            if (res?.config) state.config = res.config;
            if (res?.popoutStatus) state.popoutStatus = res.popoutStatus;
            renderSettings();
            showToast(tr('toast.popoutClosed'));
          } else {
            await persistConfigPatch({ popout: { enabled: true } });
            showToast(tr('toast.popoutEnabled'));
          }
        } catch (err) {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });

    document.getElementById('launchPopoutBtn')?.addEventListener('click', () => void onOpenPopout?.(false));

    document.getElementById('bannerSwitch')?.addEventListener('click', () => {
      const next = !state.config.uiBanner?.enabled;
      void persistConfigPatch({ uiBanner: { enabled: next } })
        .then(() => showToast(next ? tr('toast.bannerOn') : tr('toast.bannerOff')))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('cfgBudgetInput')?.addEventListener('change', (e) => {
      void persistConfigPatch({ sessionStartBudgetTokens: Number(e.target.value) })
        .then(() => showToast(tr('toast.budgetUpdated', { tokens: state.config.sessionStartBudgetTokens })))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('cfgWarnPctInput')?.addEventListener('change', (e) => {
      void persistConfigPatch({ alerts: { contextWarningPct: Number(e.target.value) } })
        .then(() => {
          renderContext(false);
          showToast(tr('toast.warnPctUpdated', { pct: state.config.alerts.contextWarningPct }));
        })
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('cfgDropPctInput')?.addEventListener('change', (e) => {
      void persistConfigPatch({ alerts: { cacheDropThresholdPct: Number(e.target.value) } })
        .then(() => showToast(tr('toast.dropPctUpdated', { pct: state.config.alerts.cacheDropThresholdPct })))
        .catch((err) => {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        });
    });

    document.getElementById('settingsResetDefaultsBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          await persistConfigPatch({
            uiLanguage: defaultUiLang,
            pollIntervalSec: 5,
            auxAutoOpen: true,
            uiBanner: { enabled: true },
            sessionStartBudgetTokens: 450,
            alerts: { contextWarningPct: 75, cacheDropThresholdPct: 50 },
            kvCache: { enabled: true, ttlMinutes: 15 },
            popout: {
              autoLaunchOnStartup: true,
              autoLaunchFromSidebar: true,
              alwaysOnTop: true,
              size: '460x720',
              windowMode: 'console',
              miniBarPreset: 'standard',
              miniBarModules: [...MINI_BAR_DEFAULT_ORDER],
              miniBarCustomWidth: null,
            },
          });
          applyUiLanguage(state.config?.uiLanguage || defaultUiLang);
          restartPollTimer();
          renderContext(false);
          showToast(tr('toast.configReset'), 'success');
        } catch (err) {
          renderSettings();
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });

    document.getElementById('docRebuildBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_doctor_action', { action: 'rebuild_index' });
          state.doctorReport = res.report;
          renderSettings();
          showToast(tr('toast.indexRebuilt', { ms: res.rebuild?.elapsedMs ?? 0 }), 'success');
        } catch (err) {
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });

    document.getElementById('docExportBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_doctor_action', { action: 'export_backup' });
          state.doctorReport = res.report;
          renderSettings();
          showToast(
            tr('toast.backupExported', { path: res.exported?.displayPath || '.context-cache/exports/' }),
            'success'
          );
        } catch (err) {
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });

    document.getElementById('docRunBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_doctor_action', { action: 'diagnose' });
          state.doctorReport = res.report;
          renderSettings();
          showToast(
            res.report?.healthy
              ? tr('toast.doctorHealthy')
              : tr('toast.doctorIssues', { count: res.report?.issues?.length || 1 }),
            res.report?.healthy ? 'success' : 'info'
          );
        } catch (err) {
          showToast(tr('toast.syncFailed', { error: err?.message || String(err) }), 'error');
        }
      })();
    });
  }

  return {
    renderSettings,
    renderMiniBarStudio,
    renderSharedWidthPresets,
    applySharedWidthPreset,
    applyMiniBarOrderWithFlip,
    bindEvents,
  };
}
