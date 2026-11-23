function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MiB`;
  if (num >= 1024) return `${(num / 1024).toFixed(0)} KiB`;
  return `${num} B`;
}

export function createAppearanceModule({
  callAppTool,
  esc,
  showToast,
  positionIndicator,
  onOpenSettings,
  onGoI18nPatch,
}) {
  const state = {
    activeSubTab: 'gallery', // 'gallery' | 'tuning' | 'rotation'
    loaded: false,
    busy: false,
    data: null,
    sliderTimer: null,
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

  async function patchConfig(patch, silent = false) {
    try {
      const res = await callAppTool('app_appearance_manage', { action: 'update_config', patch });
      if (res?.status) {
        state.data = res.status;
        renderAll();
      }
      if (!silent) showToast('外观配置已热更新', 'success');
    } catch (err) {
      showToast(`保存外观配置失败: ${err.message || err}`, 'error');
    }
  }

  function scheduleSliderPatch(patch) {
    if (state.sliderTimer) clearTimeout(state.sliderTimer);
    state.sliderTimer = setTimeout(() => {
      void patchConfig(patch, true);
    }, 180);
  }

  function renderAll() {
    const d = state.data;
    if (!d) return;
    const s = d.state;

    // Header pill & master switch
    const pill = byId('appStatusPill');
    if (pill) {
      pill.textContent = s.enabled ? (s.mode === 'image' ? '已启用 · 图片' : '已启用 · 渐变') : '已关闭';
      pill.dataset.tone = s.enabled ? 'success' : 'neutral';
    }
    const masterSw = byId('appMasterSwitch');
    if (masterSw) {
      masterSw.dataset.on = String(Boolean(s.enabled));
      masterSw.setAttribute('aria-checked', String(Boolean(s.enabled)));
    }

    // Runtime patch warning banner
    const patchNotice = byId('appRuntimeNotice');
    if (patchNotice) {
      patchNotice.classList.toggle('hidden', Boolean(d.runtimePatched));
    }

    // Presets grid
    const presetGrid = byId('appPresetsGrid');
    if (presetGrid) {
      presetGrid.innerHTML = (d.presets || [])
        .map((p) => {
          const active = s.enabled && s.mode === 'preset' && s.presetId === p.id;
          return `
          <button type="button" class="wp-preset-card" data-active="${active ? 'true' : 'false'}" data-app-preset="${esc(p.id)}">
            <span class="wp-preset-swatch" style="background: ${p.darkCss};"></span>
            <span class="wp-preset-meta">
              <span class="text-xs font-semibold text-fg">${esc(p.name)}</span>
              <span class="text-[11px] text-muted leading-snug">${esc(p.desc)}</span>
            </span>
          </button>`;
        })
        .join('');
    }

    // Library grid
    const libGrid = byId('appLibraryGrid');
    if (libGrid) {
      if (!d.library || !d.library.length) {
        libGrid.innerHTML = `
          <div class="px-5 py-6 text-center text-xs text-muted">
            壁纸库为空。点击上方「导入本地图片」上传 PNG / JPG / WebP（单图上限 15 MiB，绝不修改原图）。
          </div>`;
      } else {
        libGrid.innerHTML = d.library
          .map((item) => {
            const isActive = s.enabled && s.mode === 'image' && s.activeWallpaperPath === item.filePath;
            const isDark = s.darkWallpaperPath === item.filePath;
            const isLight = s.lightWallpaperPath === item.filePath;
            return `
            <div class="wp-lib-item" data-active="${isActive ? 'true' : 'false'}">
              <div class="wp-lib-thumb" style="${item.thumb ? `background-image:url('${item.thumb}')` : ''}">
                ${item.thumb ? '' : `<span class="text-[11px] text-muted mono-num">${esc(item.ext)}</span>`}
                ${isActive ? `<span class="wp-active-tag">当前生效</span>` : ''}
              </div>
              <div class="p-2.5 space-y-2">
                <div class="text-xs font-medium text-fg truncate" title="${esc(item.name)}">${esc(item.name)}</div>
                <div class="text-[11px] text-muted mono-num">${fmtBytes(item.bytes)}${isDark ? ' · 深色' : ''}${isLight ? ' · 浅色' : ''}</div>
                <div class="flex flex-wrap items-center gap-1">
                  <button type="button" class="agy-btn agy-btn-primary agy-btn-sm text-[11px]" data-app-use-img="${esc(item.filePath)}">设为壁纸</button>
                  <button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-[11px]" data-app-bind-dark="${esc(item.filePath)}" title="绑定为深色主题壁纸">深</button>
                  <button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-[11px]" data-app-bind-light="${esc(item.filePath)}" title="绑定为浅色主题壁纸">浅</button>
                  <button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-[11px]" data-app-del-img="${esc(item.id)}">删</button>
                </div>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    // Tuning controls
    const setRange = (id, valId, val, fmt) => {
      const inp = byId(id);
      const lbl = byId(valId);
      if (inp && document.activeElement !== inp) inp.value = String(val);
      if (lbl) lbl.textContent = fmt(val);
    };
    setRange('appOpacityRange', 'appOpacityVal', Math.round(s.opacity * 100), (v) => `${v}%`);
    setRange('appBlurRange', 'appBlurVal', s.blurPx, (v) => `${v}px`);
    setRange('appScrimRange', 'appScrimVal', Math.round(s.scrimOpacity * 100), (v) => `${v}%`);
    setRange('appGlassRange', 'appGlassVal', Math.round(s.glassOpacity * 100), (v) => `${v}%`);

    const fitSel = byId('appFitSelect');
    if (fitSel) fitSel.value = s.fit || 'cover';

    const shieldSw = byId('appReadabilitySwitch');
    if (shieldSw) {
      shieldSw.dataset.on = String(Boolean(s.protectCodeReadability));
      shieldSw.setAttribute('aria-checked', String(Boolean(s.protectCodeReadability)));
    }
    const themeSw = byId('appSeparateThemeSwitch');
    if (themeSw) {
      themeSw.dataset.on = String(Boolean(s.separateThemeWallpapers));
      themeSw.setAttribute('aria-checked', String(Boolean(s.separateThemeWallpapers)));
    }

    // Rotation controls
    const rotSel = byId('appRotationSelect');
    if (rotSel) rotSel.value = s.rotationMode || 'off';
    const rotMinSel = byId('appRotationMinSelect');
    if (rotMinSel) rotMinSel.value = String(s.rotationMinutes || 30);

    const folderInput = byId('appFolderInput');
    if (folderInput && document.activeElement !== folderInput) {
      folderInput.value = s.folderPath || '';
    }
    const folderMeta = byId('appFolderMeta');
    if (folderMeta) {
      if (!s.folderPath) {
        folderMeta.textContent = `当前候选池共 ${d.poolCount || 0} 张（仅壁纸库）。填入本地文件夹路径可只读扩展轮播池。`;
      } else if (d.folder?.error) {
        folderMeta.textContent = `扫描异常：${d.folder.error}`;
      } else {
        folderMeta.textContent = `只读扫描命中 ${d.folder.count} 张合法静态图${d.folder.skippedTooLarge ? `（已自动跳过 ${d.folder.skippedTooLarge} 张超 15 MiB 大图）` : ''} · 总候选池 ${d.poolCount} 张`;
      }
    }
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
      const cur = Boolean(state.data?.state?.enabled);
      void patchConfig({ enabled: !cur });
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

    // Tuning sliders (live debounced hot reload)
    byId('appOpacityRange')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 24;
      const lbl = byId('appOpacityVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ opacity: v / 100 });
    });
    byId('appBlurRange')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 0;
      const lbl = byId('appBlurVal');
      if (lbl) lbl.textContent = `${v}px`;
      scheduleSliderPatch({ blurPx: v });
    });
    byId('appScrimRange')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 42;
      const lbl = byId('appScrimVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ scrimOpacity: v / 100 });
    });
    byId('appGlassRange')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 86;
      const lbl = byId('appGlassVal');
      if (lbl) lbl.textContent = `${v}%`;
      scheduleSliderPatch({ glassOpacity: v / 100 });
    });

    byId('appFitSelect')?.addEventListener('change', (e) => void patchConfig({ fit: e.target.value }));
    byId('appReadabilitySwitch')?.addEventListener('click', () => {
      const cur = state.data?.state?.protectCodeReadability !== false;
      void patchConfig({ protectCodeReadability: !cur });
    });
    byId('appSeparateThemeSwitch')?.addEventListener('click', () => {
      const cur = Boolean(state.data?.state?.separateThemeWallpapers);
      void patchConfig({ separateThemeWallpapers: !cur });
    });

    byId('appRotationSelect')?.addEventListener('change', (e) => void patchConfig({ rotationMode: e.target.value }));
    byId('appRotationMinSelect')?.addEventListener('change', (e) => void patchConfig({ rotationMinutes: Number(e.target.value) || 30 }));

    byId('appScanFolderBtn')?.addEventListener('click', async () => {
      const folderPath = String(byId('appFolderInput')?.value || '').trim();
      try {
        const res = await callAppTool('app_appearance_manage', { action: 'scan_folder', folderPath });
        if (res?.status) {
          state.data = res.status;
          renderAll();
        }
        if (res?.ok) {
          showToast(folderPath ? `只读扫描完成：发现 ${res.scan?.items?.length || 0} 张壁纸` : '已清除本地文件夹绑定', 'success');
        } else {
          showToast(res?.scan?.error || '扫描失败', 'error');
        }
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });

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

    // Delegated preset / library clicks
    byId('module-appearance')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.appPreset) {
        void patchConfig({ enabled: true, mode: 'preset', presetId: btn.dataset.appPreset });
        return;
      }
      if (btn.dataset.appUseImg) {
        void patchConfig({ enabled: true, mode: 'image', activeWallpaperPath: btn.dataset.appUseImg });
        return;
      }
      if (btn.dataset.appBindDark) {
        void patchConfig({ enabled: true, mode: 'image', separateThemeWallpapers: true, darkWallpaperPath: btn.dataset.appBindDark });
        return;
      }
      if (btn.dataset.appBindLight) {
        void patchConfig({ enabled: true, mode: 'image', separateThemeWallpapers: true, lightWallpaperPath: btn.dataset.appBindLight });
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
  };
}
