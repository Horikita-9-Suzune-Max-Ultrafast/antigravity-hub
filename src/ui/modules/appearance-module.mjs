const FIT_OPTIONS = [
  { value: 'cover', label: '铺满裁剪' },
  { value: 'contain', label: '完整适应' },
  { value: 'center', label: '原始居中' },
];

const ROTATION_MODE_OPTIONS = [
  { value: 'off', label: '关闭自动轮播' },
  { value: 'startup', label: '每次启动随机切换' },
  { value: 'interval', label: '按时间间隔自动切换' },
];

const ROTATION_SOURCE_LABELS = {
  all: '壁纸库与本地文件夹',
  library: '仅本地壁纸库',
  folder: '仅本地文件夹',
};

const INTERVAL_PRESETS = [5, 10, 15, 30, 60];

function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MiB`;
  if (num >= 1024) return `${(num / 1024).toFixed(0)} KiB`;
  return `${num} B`;
}

function shortBaseName(filePath) {
  if (!filePath) return '';
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function updateRangeTrack(inp) {
  if (!inp) return;
  const min = Number(inp.min) || 0;
  const max = Number(inp.max) || 100;
  const val = Number(inp.value);
  const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0;
  inp.style.setProperty('--range-pct', `${pct.toFixed(1)}%`);
}

export function createAppearanceModule({
  callAppTool,
  esc,
  showToast,
  openModal,
  closeModal,
  positionIndicator,
  renderCustomSelect,
  onOpenSettings,
  onGoI18nPatch,
}) {
  const state = {
    activeSubTab: 'gallery', // 'gallery' | 'tuning' | 'rotation'
    loaded: false,
    busy: false,
    data: null,
    // Draft state for rotation pool modal
    poolDraft: {
      source: 'all',
      selectedIds: new Set(),
      folderPath: '',
      folderCount: 0,
      folderSkipped: 0,
      folderError: null,
      folderDirty: false,
      pickingFolder: false,
    },
    // Throttled latest-wins queue for <50ms real-time slider streaming
    pendingSliderPatch: null,
    sliderInFlight: false,
    sliderThrottleTimer: null,
    lastSliderSentAt: 0,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function positionSubNav() {
    positionIndicator('appSegNav', 'appSegIndicator');
  }

  function setSubTab(tab) {
    const valid = ['gallery', 'tuning', 'rotation'];
    const next = valid.includes(tab) ? tab : 'gallery';
    state.activeSubTab = next;
    valid.forEach((t) => {
      const panel = byId(`app-panel-${t}`);
      if (panel) panel.classList.toggle('hidden', t !== next);
      const btn = document.querySelector(`#appSegNav [data-app-tab="${t}"]`);
      if (btn) btn.dataset.active = String(t === next);
    });
    requestAnimationFrame(positionSubNav);
  }

  async function loadStatus(showSpinner = false) {
    if (state.busy && !showSpinner) return;
    state.busy = true;
    const svg = byId('appRefreshSvg');
    if (showSpinner && svg) svg.classList.add('spin-once');
    try {
      const res = await callAppTool('app_appearance_manage', { action: 'status' });
      if (res && res.state) {
        state.data = res;
        state.loaded = true;
        renderAll();
      }
    } catch (err) {
      showToast(`加载外观壁纸状态失败: ${err.message || err}`, 'error');
    } finally {
      state.busy = false;
      if (svg) setTimeout(() => svg.classList.remove('spin-once'), 360);
    }
  }

  async function patchConfig(patch, { silent = false, light = false, toastText = '外观配置已热更新', rerender = 'all' } = {}) {
    try {
      const res = await callAppTool('app_appearance_manage', { action: 'update_config', patch, light });
      if (res?.status) {
        state.data = res.status;
      } else if (res?.state && state.data) {
        state.data = { ...state.data, state: res.state };
      }
      if (rerender === 'all') {
        renderAll();
      } else if (rerender === 'tuning') {
        renderHeader();
        renderTuning();
      } else if (rerender === 'selects') {
        renderHeader();
        renderTuning();
        renderRotation();
        renderSelects();
      }
      if (!silent) showToast(toastText, 'success');
    } catch (err) {
      showToast(`保存外观配置失败: ${err.message || err}`, 'error');
    }
  }

  async function flushSliderPatch() {
    if (state.sliderInFlight || !state.pendingSliderPatch) return;
    const batch = state.pendingSliderPatch;
    state.pendingSliderPatch = null;
    state.sliderInFlight = true;
    state.lastSliderSentAt = performance.now();
    try {
      const res = await callAppTool('app_appearance_manage', {
        action: 'update_config',
        patch: batch,
        light: true,
      });
      if (res?.state && state.data) {
        state.data = { ...state.data, state: res.state };
      }
    } catch (err) {
      showToast(`实时更新失败: ${err.message || err}`, 'error');
    } finally {
      state.sliderInFlight = false;
      if (state.pendingSliderPatch) {
        const elapsed = performance.now() - state.lastSliderSentAt;
        const wait = Math.max(0, 35 - elapsed);
        if (wait === 0) {
          void flushSliderPatch();
        } else {
          if (state.sliderThrottleTimer) clearTimeout(state.sliderThrottleTimer);
          state.sliderThrottleTimer = setTimeout(() => {
            state.sliderThrottleTimer = null;
            void flushSliderPatch();
          }, wait);
        }
      }
    }
  }

  function scheduleSliderPatch(patch) {
    state.pendingSliderPatch = { ...(state.pendingSliderPatch || {}), ...patch };
    if (state.data?.state) {
      state.data.state = { ...state.data.state, ...patch };
    }
    if (state.sliderInFlight) return;
    const elapsed = performance.now() - state.lastSliderSentAt;
    if (elapsed >= 35) {
      if (state.sliderThrottleTimer) {
        clearTimeout(state.sliderThrottleTimer);
        state.sliderThrottleTimer = null;
      }
      void flushSliderPatch();
    } else if (!state.sliderThrottleTimer) {
      state.sliderThrottleTimer = setTimeout(() => {
        state.sliderThrottleTimer = null;
        void flushSliderPatch();
      }, 35 - elapsed);
    }
  }

  function renderSelects() {
    const s = state.data?.state;
    if (!renderCustomSelect || !s) return;
    renderCustomSelect('appFitSelectHost', {
      id: 'appFitSelect',
      value: s.fit || 'cover',
      options: FIT_OPTIONS,
      alignRight: true,
    });
    renderCustomSelect('appRotationSelectHost', {
      id: 'appRotationSelect',
      value: s.rotationMode || 'off',
      options: ROTATION_MODE_OPTIONS,
      alignRight: true,
    });
  }

  async function handleSelectPick(id, val) {
    if (id === 'appFitSelect') {
      await patchConfig({ fit: val }, { light: true, rerender: 'selects', toastText: '画面填充方式已更新' });
      return true;
    }
    if (id === 'appRotationSelect') {
      await patchConfig({ rotationMode: val }, { light: true, rerender: 'selects', toastText: '轮播模式已更新' });
      return true;
    }
    return false;
  }

  function renderHeader() {
    const d = state.data;
    if (!d) return;
    const s = d.state;

    const pill = byId('appStatusPill');
    if (pill) {
      let label = '已关闭';
      if (s.enabled) {
        label = s.separateThemeWallpapers ? '深浅独立' : '图片壁纸';
      }
      pill.textContent = label;
      pill.dataset.tone = s.enabled ? 'success' : 'neutral';
    }

    const masterSw = byId('appMasterSwitch');
    if (masterSw) {
      masterSw.dataset.on = String(Boolean(s.enabled));
      masterSw.setAttribute('aria-checked', String(Boolean(s.enabled)));
    }

    const patchNotice = byId('appRuntimeNotice');
    if (patchNotice) {
      patchNotice.classList.toggle('hidden', Boolean(d.runtimePatched));
    }
  }

  function renderLibrary() {
    const d = state.data;
    if (!d) return;
    const s = d.state;

    // Theme binding summary bar
    const bindBar = byId('appThemeBindBar');
    if (bindBar) {
      const hasDark = Boolean(s.darkWallpaperPath);
      const hasLight = Boolean(s.lightWallpaperPath);
      if (hasDark || hasLight) {
        bindBar.classList.remove('hidden');
        bindBar.innerHTML = `
          <div class="wp-theme-chips">
            <span class="text-2xs text-muted font-medium">主题独立绑定：</span>
            ${hasDark ? `<span class="wp-theme-chip" data-theme-slot="dark" title="${esc(s.darkWallpaperPath)}"><span class="truncate">深色: ${esc(shortBaseName(s.darkWallpaperPath))}</span></span>` : ''}
            ${hasLight ? `<span class="wp-theme-chip" data-theme-slot="light" title="${esc(s.lightWallpaperPath)}"><span class="truncate">浅色: ${esc(shortBaseName(s.lightWallpaperPath))}</span></span>` : ''}
            ${!s.separateThemeWallpapers ? `<span class="text-2xs text-muted">（已暂停，当前使用通用壁纸）</span>` : ''}
          </div>
          <button type="button" class="wp-mini-btn danger shrink-0" data-app-clear-theme-binds="true">清除全部绑定</button>`;
      } else {
        bindBar.classList.add('hidden');
        bindBar.innerHTML = '';
      }
    }

    const libGrid = byId('appLibraryGrid');
    if (!libGrid) return;

    if (!d.library || !d.library.length) {
      libGrid.innerHTML = `
        <div class="wp-lib-empty">
          壁纸库为空，点击右上角「导入图片」添加本地壁纸。
        </div>`;
      return;
    }

    libGrid.innerHTML = d.library
      .map((item) => {
        const isDark = s.darkWallpaperPath === item.filePath;
        const isLight = s.lightWallpaperPath === item.filePath;
        const isUniversalActive =
          s.enabled && s.mode === 'image' && !s.separateThemeWallpapers && s.activeWallpaperPath === item.filePath;
        const isThemedActive =
          s.enabled && s.mode === 'image' && s.separateThemeWallpapers && (isDark || isLight);
        const isActive = isUniversalActive || isThemedActive;
        const extLabel = String(item.ext || '').replace(/^\./, '') || 'IMG';

        return `
        <div class="wp-lib-item" data-active="${isActive ? 'true' : 'false'}">
          <div class="wp-lib-thumb" style="${item.thumb ? `background-image:url('${item.thumb}')` : ''}">
            ${item.thumb ? '' : `<span class="text-2xs text-muted mono-num">${esc(extLabel)}</span>`}
            <div class="wp-thumb-top">
              <div class="wp-thumb-badges">
                ${isDark ? `<span class="wp-slot-tag" data-slot="dark">深色专属</span>` : ''}
                ${isLight ? `<span class="wp-slot-tag" data-slot="light">浅色专属</span>` : ''}
              </div>
              ${isActive ? `<span class="wp-active-tag">当前生效</span>` : ''}
            </div>
          </div>
          <div class="wp-lib-body">
            <div class="wp-lib-title truncate" title="${esc(item.name)}">${esc(item.name)}</div>
            <div class="wp-lib-meta">
              <span class="mono-num">${fmtBytes(item.bytes)}</span>
              <span class="wp-ext-pill mono-num">${esc(extLabel)}</span>
            </div>
          </div>
          <div class="wp-lib-actions">
            <button
              type="button"
              class="agy-btn ${isUniversalActive ? 'agy-btn-secondary' : 'agy-btn-primary'} wp-apply-btn"
              data-app-use-img="${esc(item.filePath)}"
            >${isUniversalActive ? '当前壁纸' : '设为壁纸'}</button>
            <div class="wp-action-group">
              <button
                type="button"
                class="wp-mini-btn"
                data-bound="${isDark ? 'dark' : 'none'}"
                data-app-bind-dark="${esc(item.filePath)}"
                title="${isDark ? '已绑定深色主题，再次点击撤回' : '绑定为深色主题专属壁纸'}"
              >${isDark ? '深色 ✓' : '深色'}</button>
              <button
                type="button"
                class="wp-mini-btn"
                data-bound="${isLight ? 'light' : 'none'}"
                data-app-bind-light="${esc(item.filePath)}"
                title="${isLight ? '已绑定浅色主题，再次点击撤回' : '绑定为浅色主题专属壁纸'}"
              >${isLight ? '浅色 ✓' : '浅色'}</button>
              <button
                type="button"
                class="wp-mini-btn danger"
                data-app-del-img="${esc(item.id)}"
                title="从壁纸库中移除此图片"
              >删</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderTuning() {
    const d = state.data;
    if (!d) return;
    const s = d.state;

    const setRange = (id, valId, val, fmt) => {
      const inp = byId(id);
      const lbl = byId(valId);
      if (inp && document.activeElement !== inp) inp.value = String(val);
      if (inp) updateRangeTrack(inp);
      if (lbl) lbl.textContent = fmt(val);
    };

    const opPct = Math.round((s.opacity ?? 0.24) * 100);
    setRange('appOpacityRange', 'appOpacityVal', opPct, (v) => `${v}%`);
    setRange('appBlurRange', 'appBlurVal', s.blurPx ?? 2, (v) => `${v}px`);
    setRange('appScrimRange', 'appScrimVal', Math.round((s.scrimOpacity ?? 0.42) * 100), (v) => `${v}%`);
    setRange('appSatRange', 'appSatVal', Math.round(s.saturation ?? 100), (v) => `${v}%`);

    const themeSw = byId('appSeparateThemeSwitch');
    if (themeSw) {
      themeSw.dataset.on = String(Boolean(s.separateThemeWallpapers));
      themeSw.setAttribute('aria-checked', String(Boolean(s.separateThemeWallpapers)));
    }
  }

  function formatMinutesText(mins) {
    const m = Math.max(1, Math.min(1440, Math.round(Number(mins) || 30)));
    if (m % 60 === 0 && m >= 60) return `${m / 60} 小时`;
    return `${m} 分钟`;
  }

  function renderRotation() {
    const d = state.data;
    if (!d) return;
    const s = d.state;

    const intervalRow = byId('appIntervalRow');
    if (intervalRow) {
      intervalRow.classList.toggle('hidden', s.rotationMode !== 'interval');
    }

    const minInput = byId('appRotationMinInput');
    const curMin = Math.max(1, Math.min(1440, Math.round(Number(s.rotationMinutes) || 30)));
    if (minInput && document.activeElement !== minInput) {
      minInput.value = String(curMin);
    }

    document.querySelectorAll('#appIntervalPresets [data-app-interval]').forEach((btn) => {
      const v = Number(btn.dataset.appInterval);
      btn.dataset.active = String(v === curMin);
    });

    const summaryEl = byId('appPoolSummaryText');
    if (summaryEl) {
      const source = s.rotationSource || 'all';
      const sourceLabel = ROTATION_SOURCE_LABELS[source] || ROTATION_SOURCE_LABELS.all;
      const libTotal = (d.library || []).length;
      const libSelected = d.selectedLibraryCount ?? libTotal;
      const folderCount = d.folder?.count || 0;
      const poolCount = d.poolCount || 0;

      if (source === 'library') {
        summaryEl.textContent = `${sourceLabel}，已选 ${libSelected} / ${libTotal} 张`;
      } else if (source === 'folder') {
        summaryEl.textContent = s.folderPath
          ? `${sourceLabel}，共 ${folderCount} 张`
          : `${sourceLabel}，尚未选择文件夹`;
      } else {
        const parts = [`壁纸库 ${libSelected} 张`];
        if (s.folderPath) parts.push(`文件夹 ${folderCount} 张`);
        summaryEl.textContent = `共 ${poolCount} 张（${parts.join('，')}）`;
      }
    }
  }

  function openPoolModal() {
    const d = state.data;
    if (!d) return;
    const s = d.state;
    const lib = d.library || [];
    const selIds = Array.isArray(s.rotationLibrarySelection)
      ? new Set(
          lib
            .filter(
              (it) =>
                s.rotationLibrarySelection.includes(it.id) ||
                s.rotationLibrarySelection.includes(it.name) ||
                s.rotationLibrarySelection.includes(it.filePath)
            )
            .map((it) => it.id)
        )
      : new Set(lib.map((it) => it.id));

    state.poolDraft = {
      source: s.rotationSource || 'all',
      selectedIds: selIds,
      folderPath: s.folderPath || '',
      folderCount: d.folder?.count || 0,
      folderSkipped: d.folder?.skippedTooLarge || 0,
      folderError: d.folder?.error || null,
      folderDirty: false,
      pickingFolder: false,
    };

    const folderInput = byId('appFolderInput');
    if (folderInput) folderInput.value = state.poolDraft.folderPath;

    renderPoolModal();
    openModal?.('appRotationPoolModal');
  }

  function renderPoolModal() {
    const d = state.data;
    if (!d) return;
    const lib = d.library || [];
    const draft = state.poolDraft;

    document.querySelectorAll('#appPoolSourceGroup [data-pool-source]').forEach((btn) => {
      btn.dataset.active = String(btn.dataset.poolSource === draft.source);
    });

    const libSec = byId('appPoolLibrarySection');
    const folderSec = byId('appPoolFolderSection');
    if (libSec) libSec.classList.toggle('hidden', draft.source === 'folder');
    if (folderSec) folderSec.classList.toggle('hidden', draft.source === 'library');

    const libTitle = byId('appPoolLibraryTitle');
    if (libTitle) {
      libTitle.textContent = `本地壁纸库（已选 ${draft.selectedIds.size} / ${lib.length} 张）`;
    }

    const grid = byId('appPoolLibraryGrid');
    if (grid) {
      if (!lib.length) {
        grid.innerHTML = `<div class="wp-lib-empty" style="grid-column:1/-1;padding:16px 12px;">壁纸库暂无图片，请先在「本地壁纸库」中导入。</div>`;
      } else {
        grid.innerHTML = lib
          .map((item) => {
            const selected = draft.selectedIds.has(item.id);
            const extLabel = String(item.ext || '').replace(/^\./, '').toUpperCase() || 'IMG';
            return `
            <button type="button" class="wp-pool-item" data-selected="${selected ? 'true' : 'false'}" data-pool-toggle="${esc(item.id)}">
              <span class="wp-pool-thumb" style="${item.thumb ? `background-image:url('${item.thumb}')` : ''}">
                ${item.thumb ? '' : `<span class="text-xs text-muted mono-num">${esc(extLabel)}</span>`}
                <span class="wp-pool-check">${selected ? '✓' : ''}</span>
              </span>
              <span class="wp-pool-name truncate" title="${esc(item.name)}">${esc(item.name)}</span>
            </button>`;
          })
          .join('');
      }
    }

    const clearBtn = byId('appClearFolderBtn');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !draft.folderPath);
    }

    const pickBtn = byId('appPickFolderBtn');
    if (pickBtn) {
      pickBtn.disabled = draft.pickingFolder;
      pickBtn.textContent = draft.pickingFolder ? '等待选择...' : '选择文件夹';
    }

    const folderMeta = byId('appFolderMeta');
    if (folderMeta) {
      if (!draft.folderPath) {
        folderMeta.textContent = '未绑定本地文件夹';
      } else if (draft.folderError) {
        folderMeta.textContent = `扫描异常：${draft.folderError}`;
      } else if (draft.folderDirty) {
        folderMeta.textContent = '路径已修改，点击「扫描」或「保存轮播池」生效';
      } else {
        const skipNote = draft.folderSkipped ? `，跳过 ${draft.folderSkipped} 张超限大图` : '';
        folderMeta.textContent = `已扫描 ${draft.folderCount} 张可用图片${skipNote}`;
      }
    }

    const countEl = byId('appPoolModalCount');
    if (countEl) {
      const libPart = draft.source === 'folder' ? 0 : draft.selectedIds.size;
      const folderPart = draft.source === 'library' ? 0 : draft.folderError ? 0 : draft.folderCount;
      countEl.textContent = `当前候选池共 ${libPart + folderPart} 张`;
    }
  }

  async function savePoolModal() {
    const d = state.data;
    if (!d) return;
    const lib = d.library || [];
    const draft = state.poolDraft;
    const inputPath = String(byId('appFolderInput')?.value || '').trim();

    if (inputPath !== (d.state?.folderPath || '')) {
      try {
        const scanRes = await callAppTool('app_appearance_manage', {
          action: 'scan_folder',
          folderPath: inputPath,
        });
        if (!scanRes?.ok && inputPath) {
          draft.folderError = scanRes?.scan?.error || '文件夹扫描失败';
          renderPoolModal();
          showToast(draft.folderError, 'error');
          return;
        }
        if (scanRes?.status) {
          state.data = scanRes.status;
        }
      } catch (err) {
        showToast(err.message || String(err), 'error');
        return;
      }
    }

    const allSelected = lib.length > 0 && draft.selectedIds.size === lib.length;
    const rotationLibrarySelection = allSelected ? null : Array.from(draft.selectedIds);

    await patchConfig(
      {
        rotationSource: draft.source,
        rotationLibrarySelection,
      },
      { light: false, rerender: 'all', toastText: '轮播池已更新' }
    );
    closeModal?.('appRotationPoolModal');
  }

  async function commitCustomInterval(rawVal) {
    const parsed = Math.round(Number(rawVal));
    if (!Number.isFinite(parsed) || parsed < 1) {
      const cur = state.data?.state?.rotationMinutes || 30;
      const inp = byId('appRotationMinInput');
      if (inp) inp.value = String(cur);
      showToast('请输入 1 到 1440 之间的分钟数', 'error');
      return;
    }
    const clamped = Math.max(1, Math.min(1440, parsed));
    const inp = byId('appRotationMinInput');
    if (inp) inp.value = String(clamped);
    if (clamped === (state.data?.state?.rotationMinutes || 30)) {
      renderRotation();
      return;
    }
    await patchConfig(
      { rotationMinutes: clamped },
      { light: true, rerender: 'selects', toastText: `切换间隔已设为每 ${formatMinutesText(clamped)}` }
    );
  }

  function renderAll() {
    if (!state.data) return;
    renderHeader();
    renderLibrary();
    renderTuning();
    renderRotation();
    renderSelects();
  }

  function handleFileImport(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      showToast('单张图片超过 15 MiB 安全上限，已拦截导入', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await callAppTool('app_appearance_manage', {
          action: 'import_wallpaper',
          fileName: file.name,
          base64: String(reader.result || ''),
          activate: true,
        });
        if (res?.status) {
          state.data = res.status;
          renderAll();
        }
        showToast(`已导入并应用壁纸：${file.name}`, 'success');
      } catch (err) {
        showToast(`导入失败: ${err.message || err}`, 'error');
      }
    };
    reader.readAsDataURL(file);
  }

  function init() {
    document.querySelectorAll('#appSegNav [data-app-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setSubTab(btn.dataset.appTab));
    });

    byId('appRefreshBtn')?.addEventListener('click', () => void loadStatus(true));
    byId('appSettingsBtn')?.addEventListener('click', () => onOpenSettings?.());
    byId('appGoPatchBtn')?.addEventListener('click', () => onGoI18nPatch?.());

    byId('appMasterSwitch')?.addEventListener('click', () => {
      const s = state.data?.state || {};
      const cur = Boolean(s.enabled);
      if (!cur) {
        const hasTarget =
          Boolean(s.activeWallpaperPath) ||
          (Boolean(s.separateThemeWallpapers) && Boolean(s.darkWallpaperPath || s.lightWallpaperPath));
        const firstLib = state.data?.library?.[0]?.filePath || '';
        const hasPool = (state.data?.poolCount || 0) > 0;
        if (!hasTarget && !firstLib && !hasPool) {
          showToast('请先导入本地图片或绑定只读壁纸文件夹', 'error');
          return;
        }
        const patch = { enabled: true, mode: 'image' };
        if (!hasTarget && firstLib) {
          patch.activeWallpaperPath = firstLib;
        }
        void patchConfig(patch, { light: true, rerender: 'all', toastText: '已启用外观壁纸' });
        return;
      }
      void patchConfig(
        { enabled: false },
        { light: true, rerender: 'all', toastText: '已关闭外观壁纸' }
      );
    });

    byId('appResetTuningBtn')?.addEventListener('click', () => {
      void patchConfig(
        { opacity: 0.24, blurPx: 2, scrimOpacity: 0.42, saturation: 100, fit: 'cover' },
        { light: true, rerender: 'selects', toastText: '已恢复默认视觉参数' }
      );
    });

    byId('appEmergencyOffBtn')?.addEventListener('click', async () => {
      try {
        const res = await callAppTool('app_appearance_manage', { action: 'emergency_off' });
        if (res?.status) {
          state.data = res.status;
          renderAll();
        }
        showToast(res?.message || '已紧急关闭壁纸', 'success');
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });

    byId('appImportFileInput')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      handleFileImport(file);
    });

    // Real-time streaming sliders (35ms throttle + lightweight IPC, zero DOM rebuild)
    byId('appOpacityRange')?.addEventListener('input', (e) => {
      const inp = e.target;
      const v = Number(inp.value);
      updateRangeTrack(inp);
      const lbl = byId('appOpacityVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ opacity: v / 100 });
    });
    byId('appBlurRange')?.addEventListener('input', (e) => {
      const inp = e.target;
      const v = Number(inp.value);
      updateRangeTrack(inp);
      const lbl = byId('appBlurVal');
      if (lbl) lbl.textContent = `${v}px`;
      scheduleSliderPatch({ blurPx: v });
    });
    byId('appScrimRange')?.addEventListener('input', (e) => {
      const inp = e.target;
      const v = Number(inp.value);
      updateRangeTrack(inp);
      const lbl = byId('appScrimVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ scrimOpacity: v / 100 });
    });
    byId('appSatRange')?.addEventListener('input', (e) => {
      const inp = e.target;
      const v = Number(inp.value);
      updateRangeTrack(inp);
      const lbl = byId('appSatVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ saturation: v });
    });

    byId('appSeparateThemeSwitch')?.addEventListener('click', () => {
      const cur = Boolean(state.data?.state?.separateThemeWallpapers);
      void patchConfig(
        { separateThemeWallpapers: !cur },
        { light: true, rerender: 'all', toastText: !cur ? '已开启深浅主题独立绑定' : '已切回通用壁纸模式' }
      );
    });

    byId('appOpenPoolModalBtn')?.addEventListener('click', () => openPoolModal());

    byId('appIntervalPresets')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-app-interval]');
      if (!btn) return;
      void commitCustomInterval(btn.dataset.appInterval);
    });

    const minInput = byId('appRotationMinInput');
    minInput?.addEventListener('change', () => void commitCustomInterval(minInput.value));
    minInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        minInput.blur();
      }
    });

    byId('appPoolSourceGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pool-source]');
      if (!btn) return;
      state.poolDraft.source = btn.dataset.poolSource;
      renderPoolModal();
    });

    byId('appPoolLibraryGrid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pool-toggle]');
      if (!btn) return;
      const id = btn.dataset.poolToggle;
      if (state.poolDraft.selectedIds.has(id)) {
        state.poolDraft.selectedIds.delete(id);
      } else {
        state.poolDraft.selectedIds.add(id);
      }
      renderPoolModal();
    });

    byId('appPoolSelectAllBtn')?.addEventListener('click', () => {
      const lib = state.data?.library || [];
      state.poolDraft.selectedIds = new Set(lib.map((it) => it.id));
      renderPoolModal();
    });

    byId('appPoolSelectNoneBtn')?.addEventListener('click', () => {
      state.poolDraft.selectedIds = new Set();
      renderPoolModal();
    });

    byId('appFolderInput')?.addEventListener('input', (e) => {
      state.poolDraft.folderPath = String(e.target.value || '').trim();
      state.poolDraft.folderError = null;
      state.poolDraft.folderDirty = true;
      renderPoolModal();
    });

    byId('appPickFolderBtn')?.addEventListener('click', async () => {
      if (state.poolDraft.pickingFolder) return;
      state.poolDraft.pickingFolder = true;
      renderPoolModal();
      try {
        const res = await callAppTool('app_appearance_manage', {
          action: 'pick_folder',
          initialPath: state.poolDraft.folderPath,
          autoSave: false,
        });
        if (res?.canceled) return;
        if (!res?.ok) {
          showToast(res?.error || res?.scan?.error || '选择文件夹失败', 'error');
          return;
        }
        state.poolDraft.folderPath = res.folderPath || '';
        state.poolDraft.folderCount = res.scan?.items?.length || 0;
        state.poolDraft.folderSkipped = res.scan?.skippedTooLarge || 0;
        state.poolDraft.folderError = res.scan?.error || null;
        state.poolDraft.folderDirty = false;
        const inp = byId('appFolderInput');
        if (inp) inp.value = state.poolDraft.folderPath;
      } catch (err) {
        showToast(err.message || String(err), 'error');
      } finally {
        state.poolDraft.pickingFolder = false;
        renderPoolModal();
      }
    });

    byId('appClearFolderBtn')?.addEventListener('click', () => {
      state.poolDraft.folderPath = '';
      state.poolDraft.folderCount = 0;
      state.poolDraft.folderSkipped = 0;
      state.poolDraft.folderError = null;
      state.poolDraft.folderDirty = false;
      const inp = byId('appFolderInput');
      if (inp) inp.value = '';
      renderPoolModal();
    });

    byId('appScanFolderBtn')?.addEventListener('click', async () => {
      const folderPath = String(byId('appFolderInput')?.value || '').trim();
      try {
        const res = await callAppTool('app_appearance_manage', { action: 'scan_folder', folderPath });
        if (res?.status) {
          state.data = res.status;
          renderRotation();
        }
        state.poolDraft.folderPath = folderPath;
        state.poolDraft.folderCount = res?.scan?.items?.length || 0;
        state.poolDraft.folderSkipped = res?.scan?.skippedTooLarge || 0;
        state.poolDraft.folderError = res?.ok ? null : res?.scan?.error || '扫描失败';
        state.poolDraft.folderDirty = false;
        renderPoolModal();
        if (res?.ok) {
          showToast(folderPath ? `扫描完成，发现 ${state.poolDraft.folderCount} 张图片` : '已清除本地文件夹', 'success');
        } else {
          showToast(state.poolDraft.folderError, 'error');
        }
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });

    byId('appSavePoolBtn')?.addEventListener('click', () => void savePoolModal());

    byId('appNextWallpaperBtn')?.addEventListener('click', async () => {
      try {
        const res = await callAppTool('app_appearance_manage', { action: 'next_wallpaper' });
        if (res?.status) {
          state.data = res.status;
          renderAll();
        }
        showToast(res?.message || '已切换下一张壁纸', 'success');
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });

    // Delegated library clicks
    byId('module-appearance')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      if (btn.dataset.appUseImg) {
        void patchConfig(
          {
            enabled: true,
            mode: 'image',
            activeWallpaperPath: btn.dataset.appUseImg,
            separateThemeWallpapers: false,
          },
          { light: true, rerender: 'all', toastText: '已设为当前壁纸' }
        );
        return;
      }

      if (btn.dataset.appBindDark) {
        const targetPath = btn.dataset.appBindDark;
        const s = state.data?.state || {};
        const alreadyDark = s.darkWallpaperPath === targetPath;
        if (alreadyDark) {
          const nextSeparate = Boolean(s.lightWallpaperPath);
          void patchConfig(
            { darkWallpaperPath: '', separateThemeWallpapers: nextSeparate },
            { light: true, rerender: 'all', toastText: '已撤回深色主题壁纸绑定' }
          );
        } else {
          // Mutually exclusive on the same card: clear light binding if same image was bound to light
          const patch = {
            enabled: true,
            mode: 'image',
            separateThemeWallpapers: true,
            darkWallpaperPath: targetPath,
          };
          if (s.lightWallpaperPath === targetPath) {
            patch.lightWallpaperPath = '';
          }
          void patchConfig(patch, { light: true, rerender: 'all', toastText: '已绑定为深色主题专属壁纸' });
        }
        return;
      }

      if (btn.dataset.appBindLight) {
        const targetPath = btn.dataset.appBindLight;
        const s = state.data?.state || {};
        const alreadyLight = s.lightWallpaperPath === targetPath;
        if (alreadyLight) {
          const nextSeparate = Boolean(s.darkWallpaperPath);
          void patchConfig(
            { lightWallpaperPath: '', separateThemeWallpapers: nextSeparate },
            { light: true, rerender: 'all', toastText: '已撤回浅色主题壁纸绑定' }
          );
        } else {
          // Mutually exclusive on the same card: clear dark binding if same image was bound to dark
          const patch = {
            enabled: true,
            mode: 'image',
            separateThemeWallpapers: true,
            lightWallpaperPath: targetPath,
          };
          if (s.darkWallpaperPath === targetPath) {
            patch.darkWallpaperPath = '';
          }
          void patchConfig(patch, { light: true, rerender: 'all', toastText: '已绑定为浅色主题专属壁纸' });
        }
        return;
      }

      if (btn.dataset.appClearThemeBinds) {
        void patchConfig(
          { separateThemeWallpapers: false, darkWallpaperPath: '', lightWallpaperPath: '' },
          { light: true, rerender: 'all', toastText: '已清除全部深浅主题绑定' }
        );
        return;
      }

      if (btn.dataset.appDelImg) {
        const id = btn.dataset.appDelImg;
        void (async () => {
          try {
            const res = await callAppTool('app_appearance_manage', { action: 'delete_wallpaper', id });
            if (res?.status) {
              state.data = res.status;
              renderAll();
            }
            showToast('已从壁纸库删除', 'success');
          } catch (err) {
            showToast(err.message || String(err), 'error');
          }
        })();
      }
    });
  }

  async function activate(subTab = null) {
    if (subTab) setSubTab(subTab);
    if (!state.loaded) {
      await loadStatus(true);
    } else {
      void loadStatus(false);
    }
    requestAnimationFrame(positionSubNav);
  }

  return {
    init,
    activate,
    loadStatus,
    setSubTab,
    positionSubNav,
    renderSelects,
    handleSelectPick,
  };
}
