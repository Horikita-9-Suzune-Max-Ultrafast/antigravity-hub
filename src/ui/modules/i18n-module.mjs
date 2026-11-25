const STATUS_META = {
  unpatched: {
    pill: '未汉化',
    tone: 'neutral',
    title: 'Antigravity 当前为原版英文界面',
    desc: '点击「一键应用汉化」将自动备份纯净原版 app.asar 并注入热加载汉化层，随时可一键无损还原。',
  },
  patched_by_console: {
    pill: '已汉化 (Hub)',
    tone: 'success',
    title: 'Antigravity Hub 汉化补丁运行正常',
    desc: '词典、防误翻免疫区与品牌设置修改后可实时热更新生效，无需再次重启客户端。',
  },
  patched_by_other: {
    pill: '检测到第三方补丁',
    tone: 'warning',
    title: '检测到第三方汉化补丁',
    desc: '应用 Hub 汉化时将优先基于已检测到的纯净原版备份重打，避免叠加补丁导致异常。',
  },
  outdated_after_update: {
    pill: '官方更新待重打',
    tone: 'warning',
    title: 'Antigravity 已更新，原汉化补丁已被官方覆盖',
    desc: '你的自定义词典、社区词典与防误翻规则均安全保留在外部目录，点击「一键应用汉化」即可恢复。',
  },
  not_found: {
    pill: '未检测到客户端',
    tone: 'error',
    title: '未自动探测到 Antigravity 安装目录',
    desc: '请在下方手动填写 Antigravity 安装目录（包含 resources/app.asar），然后点击「重新探测」。',
  },
};

const SOURCE_LABELS = {
  custom: '自定义',
  community: '社区',
  builtin: '内置',
};

const SCOPE_LABELS = {
  ui: '界面 UI',
  menu: '原生菜单',
};

const BRAND_MODE_OPTIONS = [
  { value: 'original', label: '原版（Antigravity）' },
  { value: 'zh', label: '中文（反重力）' },
  { value: 'custom', label: '自定义文本' },
  { value: 'hidden', label: '隐藏品牌字样' },
];

const SOURCE_FILTER_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'custom', label: '自定义' },
  { value: 'community', label: '社区' },
  { value: 'builtin', label: '内置' },
];

const SCOPE_FILTER_OPTIONS = [
  { value: 'all', label: '全部范围' },
  { value: 'ui', label: '界面 UI' },
  { value: 'menu', label: '原生菜单' },
];

const ENTRY_SCOPE_OPTIONS = [
  { value: 'ui', label: '界面 UI（渲染进程）' },
  { value: 'menu', label: '原生顶部菜单（主进程）' },
];

const IMPORT_TARGET_OPTIONS = [
  { value: 'community', label: '社区词典层（推荐）' },
  { value: 'custom', label: '自定义覆盖层' },
];

const IMPORT_MODE_OPTIONS = [
  { value: 'merge', label: '增量合并（保留现有词条）' },
  { value: 'replace', label: '覆盖替换该层词典' },
];

function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MiB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KiB`;
  return num > 0 ? `${num} B` : '';
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return String(iso);
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function createI18nModule({
  callAppTool,
  esc,
  showToast,
  openModal,
  closeModal,
  positionIndicator,
  renderCustomSelect,
  onStatusChange,
  onOpenSettings,
}) {
  const st = {
    activeSubTab: 'status', // 'status' | 'dict' | 'rules'
    statusData: null,
    dictData: null,
    dictQuery: '',
    dictSource: 'all',
    dictScope: 'all',
    dictPage: 1,
    dictPageSize: 30,
    entryScope: 'ui',
    entryDisabled: false,
    editingEn: null,
    importTarget: 'community',
    importMode: 'merge',
    pendingPatchAction: null, // 'apply' | 'restore'
    busyPatch: false,
    syncDrawerOpen: false,
    loadedOnce: false,
  };

  let dictSearchTimer = null;
  let jobPollTimer = null;
  let jobPollPendingVisibility = false;

  function scheduleJobPoll() {
    if (jobPollTimer) return;
    if (document.visibilityState !== 'visible') {
      jobPollPendingVisibility = true;
      return;
    }
    jobPollPendingVisibility = false;
    jobPollTimer = setTimeout(() => {
      jobPollTimer = null;
      if (document.visibilityState !== 'visible') {
        jobPollPendingVisibility = true;
        return;
      }
      void loadStatus(false);
    }, 2500);
  }

  function getI18nConfig() {
    const cfg = st.statusData?.config?.i18n || st.statusData?.config || {};
    return {
      installDirOverride: cfg.installDirOverride || '',
      updateReminderEnabled: cfg.updateReminderEnabled !== false,
      menuLocalizationEnabled: cfg.menuLocalizationEnabled !== false,
      brandMode: cfg.brandMode || 'original',
      customBrandText: cfg.customBrandText || 'Antigravity',
      communitySourceUrl: cfg.communitySourceUrl || '',
      immunity: {
        codeBlocks: cfg.immunity?.codeBlocks !== false,
        inputs: cfg.immunity?.inputs !== false,
        terminal: cfg.immunity?.terminal !== false,
        filePaths: cfg.immunity?.filePaths !== false,
        customSelectors: Array.isArray(cfg.immunity?.customSelectors) ? cfg.immunity.customSelectors : [],
      },
    };
  }

  function renderSelects() {
    renderCustomSelect('i18nSourceSelectHost', {
      id: 'i18nSourceSelect',
      value: st.dictSource,
      options: SOURCE_FILTER_OPTIONS,
    });
    renderCustomSelect('i18nScopeSelectHost', {
      id: 'i18nScopeSelect',
      value: st.dictScope,
      options: SCOPE_FILTER_OPTIONS,
      alignRight: true,
    });
    renderCustomSelect('i18nBrandModeHost', {
      id: 'i18nBrandMode',
      value: getI18nConfig().brandMode,
      options: BRAND_MODE_OPTIONS,
      alignRight: true,
    });
    renderCustomSelect('i18nEntryScopeHost', {
      id: 'i18nEntryScope',
      value: st.entryScope,
      options: ENTRY_SCOPE_OPTIONS,
      fullWidth: true,
    });
    renderCustomSelect('i18nImportTargetHost', {
      id: 'i18nImportTarget',
      value: st.importTarget,
      options: IMPORT_TARGET_OPTIONS,
      fullWidth: true,
    });
    renderCustomSelect('i18nImportModeHost', {
      id: 'i18nImportMode',
      value: st.importMode,
      options: IMPORT_MODE_OPTIONS,
      fullWidth: true,
    });
  }

  async function handleSelectPick(id, val) {
    if (id === 'i18nSourceSelect') {
      st.dictSource = val;
      st.dictPage = 1;
      renderSelects();
      await loadDictionary();
      return true;
    }
    if (id === 'i18nScopeSelect') {
      st.dictScope = val;
      st.dictPage = 1;
      renderSelects();
      await loadDictionary();
      return true;
    }
    if (id === 'i18nBrandMode') {
      await saveI18nConfigPatch({ brandMode: val }, '已更新品牌显示模式');
      return true;
    }
    if (id === 'i18nEntryScope') {
      st.entryScope = val;
      renderSelects();
      return true;
    }
    if (id === 'i18nImportTarget') {
      st.importTarget = val;
      renderSelects();
      return true;
    }
    if (id === 'i18nImportMode') {
      st.importMode = val;
      renderSelects();
      return true;
    }
    return false;
  }

  function renderStatusPanel() {
    const data = st.statusData;
    const code = data?.status || 'not_found';
    const meta = STATUS_META[code] || STATUS_META.not_found;
    const cfg = getI18nConfig();

    const headerPill = document.getElementById('i18nHeaderStatusPill');
    if (headerPill) {
      headerPill.textContent = meta.pill;
      headerPill.className = 'agy-pill i18n-status-pill shrink-0';
      headerPill.dataset.tone = meta.tone;
    }

    const heroPill = document.getElementById('i18nStatusPill');
    if (heroPill) {
      heroPill.textContent = meta.pill;
      heroPill.dataset.tone = meta.tone;
    }

    const verEl = document.getElementById('i18nAppVersion');
    if (verEl) {
      verEl.textContent = data?.appVersion ? `Antigravity v${data.appVersion}` : '版本未探测';
      if (data?.electronVersion) {
        verEl.title = data?.appVersion
          ? `Antigravity v${data.appVersion} / Electron v${data.electronVersion}`
          : `Electron v${data.electronVersion}`;
      } else {
        verEl.removeAttribute?.('title');
      }
    }

    const titleEl = document.getElementById('i18nStatusTitle');
    if (titleEl) titleEl.textContent = meta.title;

    const descEl = document.getElementById('i18nStatusDesc');
    if (descEl) {
      let detail = meta.desc;
      if (code === 'patched_by_console' && data?.consolePatchMeta?.patchedAt) {
        detail += `（补丁时间：${fmtDateTime(data.consolePatchMeta.patchedAt)}）`;
      }
      descEl.textContent = detail;
    }

    const jobRefTs = Date.parse(data?.lastJob?.updatedAt || data?.lastJob?.startedAt || '');
    const jobIsFresh = Number.isFinite(jobRefTs) && Date.now() - jobRefTs <= 120000;
    const jobRunning =
      (data?.lastJob?.status === 'running' || data?.lastJob?.status === 'queued') && jobIsFresh;

    const hasMatchingCleanBackup = Boolean(data?.hasMatchingCleanBackup);

    // Third-party patch remediation card
    const tpCard = document.getElementById('i18nThirdPartyPlanCard');
    const tpBadge = document.getElementById('i18nThirdPartyBadge');
    const tpDesc = document.getElementById('i18nThirdPartyPlanDesc');
    const tpReplaceBtn = document.getElementById('i18nReplaceThirdPartyBtn');
    const tpRestoreBtn = document.getElementById('i18nRestoreFromThirdPartyBtn');
    if (tpCard) {
      const isThirdParty = code === 'patched_by_other';
      tpCard.classList.toggle('hidden', !isThirdParty);
      if (isThirdParty) {
        const tpName = data?.thirdPartyMeta?.tool
          ? `${data.thirdPartyMeta.tool}${data.thirdPartyMeta.toolVersion ? ` v${data.thirdPartyMeta.toolVersion}` : ''}`
          : '未知第三方汉化补丁';
        if (tpBadge) tpBadge.textContent = tpName;
        const matchingCleanBak = (data?.backups || []).find(
          (b) => b.valid && b.isCleanOriginal && b.matchesCurrentVersion
        );
        const cleanBak =
          matchingCleanBak || (data?.backups || []).find((b) => b.valid && b.isCleanOriginal);
        if (hasMatchingCleanBackup && matchingCleanBak) {
          if (tpDesc) {
            tpDesc.textContent = `已检测到同版本纯净原版备份（${matchingCleanBak.name}）。点击「隔离替换」将自动把纯净原版收归 Hub 托管、把第三方旧备份归档隔离至 ~/.context-cache/i18n/quarantine/（不硬删），再基于纯净原版重打 Hub 汉化与壁纸运行时，绝不叠加冲突。`;
          }
          if (tpReplaceBtn) {
            tpReplaceBtn.disabled = st.busyPatch || jobRunning;
            tpReplaceBtn.removeAttribute?.('title');
          }
          if (tpRestoreBtn) {
            tpRestoreBtn.disabled = st.busyPatch || jobRunning;
            tpRestoreBtn.removeAttribute?.('title');
          }
        } else if (data?.hasCleanBackup && cleanBak) {
          if (tpDesc) {
            tpDesc.textContent = `仅检测到旧版原版备份（${cleanBak.name}${cleanBak.appVersion ? `，v${cleanBak.appVersion}` : ''}），与当前客户端版本不匹配。为防止误覆盖降级，已锁定隔离替换与直接还原；建议先重新运行一次官方 Antigravity 安装程序恢复同版本原版，再回到此处一键应用。`;
          }
          if (tpReplaceBtn) {
            tpReplaceBtn.disabled = true;
            tpReplaceBtn.title = '已有备份版本与当前客户端版本不匹配，已锁定隔离替换以防误覆盖降级';
          }
          if (tpRestoreBtn) {
            tpRestoreBtn.disabled = true;
            tpRestoreBtn.title = '已有备份版本与当前客户端版本不匹配，已锁定还原以防误覆盖降级';
          }
        } else {
          if (tpDesc) {
            tpDesc.textContent = '未检测到可用的纯净原版 app.asar 备份。为防止叠加损坏，已锁定直接替换；建议先重新运行一次官方 Antigravity 安装程序恢复原版文件，再回到此处一键应用。';
          }
          if (tpReplaceBtn) {
            tpReplaceBtn.disabled = true;
            tpReplaceBtn.title = '缺少纯净原版备份，已锁定隔离替换';
          }
          if (tpRestoreBtn) {
            tpRestoreBtn.disabled = true;
            tpRestoreBtn.title = '缺少纯净原版备份，已锁定还原';
          }
        }
      }
    }

    const applyBtn = document.getElementById('i18nApplyBtn');
    const restoreBtn = document.getElementById('i18nRestoreBtn');
    if (applyBtn) {
      applyBtn.disabled =
        st.busyPatch ||
        jobRunning ||
        code === 'not_found' ||
        (code === 'patched_by_other' && (!data?.hasCleanBackup || !hasMatchingCleanBackup));
      applyBtn.title = jobRunning
        ? '后台补丁任务正在执行，请稍候...'
        : code === 'not_found'
          ? '未检测到 Antigravity 安装目录，请在下方手动指定路径'
          : code === 'patched_by_other' && !data?.hasCleanBackup
            ? '检测到第三方补丁且缺少纯净原版备份，为防叠加损坏已锁定'
            : code === 'patched_by_other' && !hasMatchingCleanBackup
              ? '检测到第三方补丁，但已有原版备份版本与当前客户端不匹配，已锁定替换以防误覆盖降级'
              : '自动备份纯净原版 app.asar 并注入热加载运行时';
      applyBtn.textContent =
        code === 'patched_by_console'
          ? '重新应用汉化'
          : code === 'outdated_after_update'
            ? '重新应用汉化'
            : code === 'patched_by_other'
              ? '隔离替换并应用 Hub 汉化'
              : '一键应用汉化';
    }
    if (restoreBtn) {
      restoreBtn.disabled =
        st.busyPatch ||
        jobRunning ||
        code === 'not_found' ||
        code === 'unpatched' ||
        code === 'outdated_after_update' ||
        !data?.hasCleanBackup ||
        !hasMatchingCleanBackup;
      restoreBtn.title = jobRunning
        ? '后台补丁任务正在执行，请稍候...'
        : code === 'not_found'
          ? '未检测到 Antigravity 安装目录'
          : code === 'outdated_after_update'
            ? '官方更新后当前客户端已是新版原版，已锁定还原以防旧版备份误覆盖降级'
            : code === 'unpatched'
              ? '当前已为原版英文客户端，无需还原'
              : !data?.hasCleanBackup
                ? '未检测到可用的纯净原版备份'
                : !hasMatchingCleanBackup
                  ? '已有备份版本与当前客户端版本不匹配，已锁定还原以防误覆盖降级'
                  : '基于同版本纯净原版备份无损还原 app.asar';
    }

    // Install path info
    const srcTag = document.getElementById('i18nInstallSourceTag');
    if (srcTag) srcTag.textContent = cfg.installDirOverride ? '手动指定目录' : '自动探测';

    const pathInfo = document.getElementById('i18nDetectedPathInfo');
    if (pathInfo) {
      if (data?.installDir) {
        pathInfo.innerHTML = `
          <div><span class="text-fg">安装目录：</span>${esc(data.installDir)}</div>
          ${data.asarPath ? `<div class="mt-0.5"><span class="text-fg">ASAR 文件：</span>${esc(data.asarPath)}</div>` : ''}
        `;
      } else {
        pathInfo.textContent = '未检测到有效的 Antigravity 安装目录（未找到 resources/app.asar）。';
      }
    }

    const overrideInput = document.getElementById('i18nInstallDirInput');
    if (overrideInput && document.activeElement !== overrideInput) {
      overrideInput.value = cfg.installDirOverride;
    }

    // Backups list
    const backups = Array.isArray(data?.backups) ? data.backups : [];
    const backupCountEl = document.getElementById('i18nBackupCountBadge');
    if (backupCountEl) backupCountEl.textContent = `${backups.length} 个`;

    const backupsEl = document.getElementById('i18nBackupsList');
    if (backupsEl) {
      if (!backups.length) {
        backupsEl.innerHTML = `<div class="px-5 py-4 text-xs text-muted">尚未发现原版备份（首次应用汉化时会自动创建纯净备份）</div>`;
      } else {
        backupsEl.innerHTML = backups
          .map((b) => {
            const clean = Boolean(b.isCleanOriginal);
            const isMismatched = Boolean(b.valid && b.matchesCurrentVersion === false);
            const tone = clean && !isMismatched ? 'success' : 'warning';
            const badgeText = clean ? '纯净原版' : '含补丁';
            const name = b.name || b.fileName || b.path || 'app.asar.bak';
            const subParts = [];
            if (b.appVersion) subParts.push(`v${b.appVersion}`);
            if (b.size) subParts.push(fmtBytes(b.size));
            if (b.mtime || b.updatedAt) subParts.push(fmtDateTime(b.mtime || b.updatedAt));
            const mismatchBadge = isMismatched
              ? `<span class="agy-pill i18n-status-pill shrink-0" data-tone="warning" title="该备份版本与当前客户端不匹配，已禁止直接还原覆盖">旧版备份</span>`
              : '';
            return `
            <div class="px-5 py-3 flex items-center justify-between gap-3 text-xs">
              <div class="min-w-0">
                <div class="mono-num font-medium text-fg truncate" title="${esc(b.path || name)}">${esc(name)}</div>
                ${subParts.length ? `<div class="text-muted mono-num mt-0.5">${esc(subParts.join(' / '))}</div>` : ''}
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                ${mismatchBadge}
                <span class="agy-pill i18n-status-pill shrink-0" data-tone="${tone}">${badgeText}</span>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    // Last detached job
    const job = data?.lastJob || null;
    const jobBadge = document.getElementById('i18nLastJobBadge');
    const jobBox = document.getElementById('i18nLastJobBox');
    if (jobBadge && jobBox) {
      if (!job) {
        jobBadge.textContent = '空闲';
        jobBadge.className = 'agy-pill i18n-status-pill mono-num';
        jobBadge.dataset.tone = 'neutral';
        jobBox.textContent = '尚未执行过汉化或还原任务。';
      } else {
        const jStatus = String(job.status || 'unknown');
        const tone =
          jStatus === 'succeeded' || jStatus === 'completed' || jStatus === 'done'
            ? 'success'
            : jStatus === 'failed' || jStatus === 'error'
              ? 'error'
              : 'warning';
        const statusMap = {
          queued: '等待中',
          running: '执行中',
          succeeded: '已完成',
          completed: '已完成',
          done: '已完成',
          failed: '失败',
          error: '失败',
        };
        const actionLabel = job.action === 'restore' ? '还原原版' : '应用汉化';
        jobBadge.textContent = statusMap[jStatus] || jStatus;
        jobBadge.className = 'agy-pill i18n-status-pill mono-num';
        jobBadge.dataset.tone = tone;
        jobBox.innerHTML = `
          <div class="space-y-1">
            <div class="text-fg font-medium">操作：${esc(actionLabel)}</div>
            <div class="mono-num text-muted">时间：${esc(fmtDateTime(job.finishedAt || job.updatedAt || job.startedAt || job.createdAt))}</div>
            ${job.message ? `<div class="text-muted">${esc(job.message)}</div>` : ''}
            ${job.error ? `<div class="text-error">${esc(job.error)}</div>` : ''}
          </div>
        `;
      }
    }

    if (jobRunning) {
      scheduleJobPoll();
    } else {
      jobPollPendingVisibility = false;
      if (jobPollTimer) {
        clearTimeout(jobPollTimer);
        jobPollTimer = null;
      }
    }
  }

  function renderDictStats(stats) {
    const s = stats || st.statusData?.dictStats || {};
    const host = document.getElementById('i18nDictStats');
    if (!host) return;
    const total = s.totalActive ?? 0;
    const builtin = s.builtinCount ?? 0;
    const community = s.communityCount ?? 0;
    const custom = s.customCount ?? 0;
    const disabled = s.disabledCount ?? 0;
    host.innerHTML = `
      <span class="agy-pill mono-num text-fg">总生效 ${total}</span>
      <span class="agy-pill mono-num">内置 ${builtin}</span>
      <span class="agy-pill mono-num">社区 ${community}</span>
      <span class="agy-pill mono-num">自定义 ${custom}</span>
      <span class="agy-pill mono-num">已禁用 ${disabled}</span>
    `;
    const packHost = document.getElementById('i18nPackStats');
    const packs = Array.isArray(s.packStats) ? s.packStats : [];
    if (packHost) {
      packHost.innerHTML = packs
        .map(
          (pk) =>
            `<span class="agy-pill mono-num text-xs" title="${esc(pk.description || pk.name)}">${esc(pk.name)} (${pk.total})</span>`
        )
        .join('');
    }
  }

  function renderDictionaryPanel() {
    const d = st.dictData;
    renderDictStats(d?.stats);

    const communityUrlInput = document.getElementById('i18nCommunityUrlInput');
    if (communityUrlInput && document.activeElement !== communityUrlInput && !communityUrlInput.value) {
      communityUrlInput.value = getI18nConfig().communitySourceUrl;
    }

    const listEl = document.getElementById('i18nDictList');
    const items = d?.items || [];
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="py-8 text-center text-xs text-muted">当前筛选条件下暂无词条，可点击「+ 新增/覆盖词条」添加自定义翻译</div>`;
    } else {
      listEl.innerHTML = items
        .map((it, idx) => {
          const src = it.source || 'builtin';
          const scope = it.scope || 'ui';
          const disabled = Boolean(it.disabled);
          const isCustom = src === 'custom' || it.customZh != null;
          return `
          <div class="i18n-dict-row" data-disabled="${disabled}" data-dict-idx="${idx}">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="i18n-src-badge" data-src="${esc(src)}">${esc(SOURCE_LABELS[src] || src)}</span>
                <span class="i18n-src-badge">${esc(SCOPE_LABELS[scope] || scope)}</span>
                ${disabled ? `<span class="i18n-src-badge" style="color:var(--warning);border-color:color-mix(in srgb,var(--warning) 40%,var(--border));">已禁用</span>` : ''}
              </div>
              <div class="mono-num text-xs text-muted break-all">${esc(it.en)}</div>
              <div class="i18n-dict-zh text-sm font-medium text-fg break-all">${esc(it.zh || '（保留原文）')}</div>
            </div>
            <div class="i18n-row-actions">
              <button type="button" class="i18n-mini-action" data-i18n-edit="${idx}">编辑</button>
              <button type="button" class="i18n-mini-action" data-i18n-toggle="${idx}">${disabled ? '启用' : '禁用'}</button>
              ${isCustom ? `<button type="button" class="i18n-mini-action danger" data-i18n-del="${idx}">删除</button>` : ''}
            </div>
          </div>`;
        })
        .join('');
    }

    const total = Number(d?.total) || 0;
    const page = Number(d?.page) || 1;
    const pageSize = Number(d?.pageSize) || st.dictPageSize;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));

    const infoEl = document.getElementById('i18nDictPageInfo');
    if (infoEl) infoEl.textContent = `第 ${page} / ${maxPage} 页（共 ${total} 条）`;

    const prevBtn = document.getElementById('i18nPrevPageBtn');
    const nextBtn = document.getElementById('i18nNextPageBtn');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= maxPage;
  }

  async function refreshUntranslatedCount() {
    try {
      const res = await callAppTool('app_i18n_manage', { action: 'list_untranslated' });
      const lbl = document.getElementById('i18nUntransCountLabel');
      if (lbl) lbl.textContent = `已采集 ${res?.count ?? 0} 条未翻译短语`;
    } catch {
      // ignore
    }
  }

  function renderRulesPanel({ includeUntranslated = false } = {}) {
    const cfg = getI18nConfig();
    const imm = cfg.immunity;

    const setSwitch = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.dataset.on = String(Boolean(on));
    };

    setSwitch('i18nImmCodeBlocks', imm.codeBlocks);
    setSwitch('i18nImmInputs', imm.inputs);
    setSwitch('i18nImmTerminal', imm.terminal);
    setSwitch('i18nImmFilePaths', imm.filePaths);
    setSwitch('i18nMenuLocSwitch', cfg.menuLocalizationEnabled);
    setSwitch('i18nUpdateRemindSwitch', cfg.updateReminderEnabled);
    setSwitch('i18nCollectUntransSwitch', Boolean(cfg.collectUntranslated));
    if (includeUntranslated) {
      void refreshUntranslatedCount();
    }

    const selTa = document.getElementById('i18nCustomSelectors');
    if (selTa && document.activeElement !== selTa) {
      selTa.value = (imm.customSelectors || []).join('\n');
    }

    const customBrandRow = document.getElementById('i18nCustomBrandRow');
    if (customBrandRow) {
      customBrandRow.classList.toggle('hidden', cfg.brandMode !== 'custom');
    }
    const customBrandInput = document.getElementById('i18nCustomBrandInput');
    if (customBrandInput && document.activeElement !== customBrandInput) {
      customBrandInput.value = cfg.customBrandText || 'Antigravity';
    }

    renderSelects();
  }

  async function loadStatus(showErrorToast = false) {
    try {
      const res = await callAppTool('app_i18n_manage', { action: 'status' });
      st.statusData = res?.status ? res : res?.data || res;
      st.loadedOnce = true;
      renderStatusPanel();
      renderRulesPanel();
      if (st.statusData?.dictStats && !st.dictData) {
        renderDictStats(st.statusData.dictStats);
      }
      if (typeof onStatusChange === 'function') {
        onStatusChange(st.statusData);
      }
      return st.statusData;
    } catch (err) {
      if (showErrorToast) showToast(`获取汉化状态失败：${err.message}`);
      return null;
    }
  }

  async function loadDictionary() {
    try {
      const res = await callAppTool('app_i18n_manage', {
        action: 'list_dict',
        query: st.dictQuery,
        source: st.dictSource,
        scope: st.dictScope,
        page: st.dictPage,
        pageSize: st.dictPageSize,
      });
      st.dictData = res;
      renderDictionaryPanel();
    } catch (err) {
      const listEl = document.getElementById('i18nDictList');
      if (listEl) {
        listEl.innerHTML = `<div class="py-8 text-center text-xs text-error">词典加载失败：${esc(err.message)}</div>`;
      }
    }
  }

  async function saveI18nConfigPatch(patch, toastMsg) {
    try {
      const res = await callAppTool('app_i18n_manage', {
        action: 'update_config',
        patch,
      });
      if (res?.status && typeof res.status === 'string') {
        st.statusData = res;
      } else if (res?.statusInfo) {
        st.statusData = res.statusInfo;
      } else {
        await loadStatus(false);
      }
      renderStatusPanel();
      renderRulesPanel();
      if (typeof onStatusChange === 'function') {
        onStatusChange(st.statusData);
      }
      if (toastMsg) showToast(toastMsg);
    } catch (err) {
      showToast(`保存配置失败：${err.message}`);
    }
  }

  function openPatchConfirm(action) {
    st.pendingPatchAction = action;
    const isApply = action === 'apply' || action === 'apply_quarantine';
    const isQuarantine = action === 'apply_quarantine' || (isApply && st.statusData?.status === 'patched_by_other');
    const data = st.statusData || {};

    const titleEl = document.getElementById('i18nPatchConfirmTitle');
    const submitBtn = document.getElementById('i18nPatchConfirmSubmitBtn');
    const metaEl = document.getElementById('i18nPatchConfirmMeta');

    if (titleEl) {
      titleEl.textContent = isApply
        ? isQuarantine
          ? '确认隔离替换第三方补丁并应用 Hub 汉化'
          : '确认应用 Antigravity 界面汉化'
        : '确认还原 Antigravity 原版';
    }
    if (submitBtn) {
      submitBtn.textContent = isApply ? (isQuarantine ? '确认隔离替换并重启' : '确认应用并重启') : '确认还原并重启';
    }
    if (metaEl) {
      metaEl.innerHTML = `
        <div>目标目录：${esc(data.installDir || '未探测')}</div>
        <div>客户端版本：${esc(data.appVersion ? `v${data.appVersion}` : '未知')}${data.electronVersion ? `（Electron v${esc(data.electronVersion)}）` : ''}</div>
        <div>纯净原版备份：${data.hasMatchingCleanBackup ? '同版本已就绪' : data.hasCleanBackup ? '仅存在旧版备份（已防降级锁定）' : isApply ? '将自动创建' : '缺失'}</div>
        ${isQuarantine ? '<div>第三方补丁对策：以纯净原版重打（绝不叠加），旧备份归档隔离至 ~/.context-cache/i18n/quarantine/</div>' : ''}
      `;
    }
    openModal('i18nPatchConfirmModal');
  }

  async function executeConfirmedPatch() {
    const action = st.pendingPatchAction;
    if (!action) return;
    closeModal('i18nPatchConfirmModal');
    st.busyPatch = true;
    renderStatusPanel();
    const isApply = action === 'apply' || action === 'apply_quarantine';
    const quarantineThirdParty = action === 'apply_quarantine' || (isApply && st.statusData?.status === 'patched_by_other');
    try {
      const toolAction = isApply ? 'apply_patch' : 'restore_patch';
      const res = await callAppTool('app_i18n_manage', { action: toolAction, quarantineThirdParty });
      showToast(
        res?.message ||
          (isApply
            ? '已启动后台汉化任务，Antigravity 将在约 3~5 秒内短暂重启生效'
            : '已启动后台还原任务，Antigravity 将在约 3~5 秒内短暂重启恢复原版')
      );
      await loadStatus(false);
    } catch (err) {
      showToast(`${isApply ? '应用汉化' : '还原原版'}失败：${err.message}`);
    } finally {
      st.busyPatch = false;
      renderStatusPanel();
    }
  }

  function openEntryModal(item = null) {
    st.editingEn = item ? item.en : null;
    st.entryScope = item?.scope || 'ui';
    st.entryDisabled = Boolean(item?.disabled);

    const titleEl = document.getElementById('i18nEntryModalTitle');
    const enInput = document.getElementById('i18nEntryEnInput');
    const zhInput = document.getElementById('i18nEntryZhInput');
    const disSwitch = document.getElementById('i18nEntryDisabledSwitch');

    if (titleEl) titleEl.textContent = item ? '编辑 / 覆盖词条' : '新增 / 覆盖词条';
    if (enInput) {
      enInput.value = item?.en || '';
      enInput.readOnly = Boolean(item);
    }
    if (zhInput) zhInput.value = item?.zh || '';
    if (disSwitch) disSwitch.dataset.on = String(st.entryDisabled);

    renderSelects();
    openModal('i18nEntryModal');
    setTimeout(() => (item ? zhInput : enInput)?.focus(), 60);
  }

  function switchSubTab(subTab) {
    if (!['status', 'dict', 'rules'].includes(subTab)) return;
    st.activeSubTab = subTab;
    ['status', 'dict', 'rules'].forEach((t) => {
      document.getElementById(`i18n-panel-${t}`)?.classList.toggle('hidden', t !== subTab);
    });
    document.querySelectorAll('#i18nSegNav .seg-tab').forEach((btn) => {
      btn.dataset.active = String(btn.dataset.i18nTab === subTab);
    });
    positionSubNav();
    if (subTab === 'dict') {
      void loadDictionary();
    } else if (subTab === 'rules') {
      renderRulesPanel({ includeUntranslated: true });
    }
  }

  function positionSubNav() {
    positionIndicator('i18nSegNav', 'i18nSegIndicator');
  }

  function bindEvents() {
    document.querySelectorAll('#i18nSegNav .seg-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchSubTab(btn.dataset.i18nTab));
    });

    document.getElementById('i18nRefreshBtn')?.addEventListener('click', () => {
      const svg = document.getElementById('i18nRefreshSvg');
      if (svg) {
        svg.style.transition = 'transform 480ms cubic-bezier(0.22, 1, 0.36, 1)';
        svg.style.transform = 'rotate(360deg)';
        setTimeout(() => {
          svg.style.transition = 'none';
          svg.style.transform = 'rotate(0deg)';
        }, 500);
      }
      void loadStatus(true).then((s) => {
        if (s) showToast('已刷新汉化与客户端检测状态');
        if (st.activeSubTab === 'dict') void loadDictionary();
      });
    });

    document.getElementById('i18nSettingsBtn')?.addEventListener('click', () => {
      if (typeof onOpenSettings === 'function') onOpenSettings();
    });

    document.getElementById('i18nApplyBtn')?.addEventListener('click', () => openPatchConfirm('apply'));
    document.getElementById('i18nRestoreBtn')?.addEventListener('click', () => openPatchConfirm('restore'));
    document.getElementById('i18nReplaceThirdPartyBtn')?.addEventListener('click', () => openPatchConfirm('apply_quarantine'));
    document.getElementById('i18nRestoreFromThirdPartyBtn')?.addEventListener('click', () => openPatchConfirm('restore'));
    document.getElementById('i18nPatchConfirmSubmitBtn')?.addEventListener('click', () => void executeConfirmedPatch());

    document.getElementById('i18nRefreshBundleBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_i18n_manage', { action: 'refresh_bundle' });
          const total = res?.stats?.totalActive ?? res?.bundle?.stats?.totalActive;
          showToast(total != null ? `已重新编译热加载词典（生效 ${total} 条）` : '已刷新热加载词典');
          await loadStatus(false);
        } catch (err) {
          showToast(`刷新词典失败：${err.message}`);
        }
      })();
    });

    document.getElementById('i18nRedetectBtn')?.addEventListener('click', () => {
      const val = (document.getElementById('i18nInstallDirInput')?.value || '').trim();
      void saveI18nConfigPatch({ installDirOverride: val }, val ? '已保存安装目录并重新探测' : '已切换为自动探测');
    });

    // Dict toolbar & list
    document.getElementById('i18nAddEntryBtn')?.addEventListener('click', () => openEntryModal(null));

    document.getElementById('i18nImportBtn')?.addEventListener('click', () => {
      const ta = document.getElementById('i18nImportTextarea');
      if (ta) ta.value = '';
      renderSelects();
      openModal('i18nImportModal');
    });

    document.getElementById('i18nImportFileInput')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const ta = document.getElementById('i18nImportTextarea');
        if (ta) ta.value = String(reader.result || '');
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.getElementById('i18nImportForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void (async () => {
        const rawJson = (document.getElementById('i18nImportTextarea')?.value || '').trim();
        if (!rawJson) return;
        try {
          const res = await callAppTool('app_i18n_manage', {
            action: 'import_dict',
            rawJson,
            target: st.importTarget,
            mergeMode: st.importMode,
          });
          closeModal('i18nImportModal');
          await loadDictionary();
          await loadStatus(false);
          const count = res?.importedCount ?? res?.imported ?? '';
          showToast(count !== '' ? `已导入 ${count} 条词典并刷新热加载包` : '已导入词典并刷新热加载包');
        } catch (err) {
          showToast(`导入失败：${err.message}`);
        }
      })();
    });

    document.getElementById('i18nExportBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_i18n_manage', {
            action: 'export_dict',
            scope: st.dictScope,
          });
          const payload = res?.data ?? res?.exported ?? res;
          const text = JSON.stringify(payload, null, 2);
          try {
            const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `antigravity-i18n-${st.dictScope}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch {
            // Fallback to clipboard inside restricted sandboxes
          }
          if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
          showToast('已导出词典 JSON（同时已复制至剪贴板）');
        } catch (err) {
          showToast(`导出失败：${err.message}`);
        }
      })();
    });

    document.getElementById('i18nSyncToggleBtn')?.addEventListener('click', () => {
      st.syncDrawerOpen = !st.syncDrawerOpen;
      const drawer = document.getElementById('i18nSyncDrawer');
      if (drawer) drawer.dataset.open = String(st.syncDrawerOpen);
    });

    document.getElementById('i18nSyncPresetMitBtn')?.addEventListener('click', () => {
      const urlInput = document.getElementById('i18nCommunityUrlInput');
      if (urlInput) {
        urlInput.value = 'https://raw.githubusercontent.com/While-Shark/antigravity-zh-cn/main/dict.json';
      }
      document.getElementById('i18nSyncRunBtn')?.click();
    });

    document.getElementById('i18nSyncRunBtn')?.addEventListener('click', () => {
      const btn = document.getElementById('i18nSyncRunBtn');
      const url = (document.getElementById('i18nCommunityUrlInput')?.value || '').trim();
      if (!url || !url.startsWith('https://')) {
        showToast('请输入有效的 HTTPS 社区词典 JSON 地址');
        return;
      }
      void (async () => {
        if (btn) btn.disabled = true;
        try {
          await saveI18nConfigPatch({ communitySourceUrl: url }, '');
          const res = await callAppTool('app_i18n_manage', { action: 'sync_community', url });
          await loadDictionary();
          await loadStatus(false);
          const count = res?.importedCount ?? res?.imported ?? '';
          showToast(count !== '' ? `社区词典同步完成（${count} 条）` : '社区词典同步完成并已热更新');
        } catch (err) {
          showToast(`社区词典同步失败：${err.message}`);
        } finally {
          if (btn) btn.disabled = false;
        }
      })();
    });

    document.getElementById('i18nDictSearch')?.addEventListener('input', (e) => {
      st.dictQuery = (e.target.value || '').trim();
      st.dictPage = 1;
      clearTimeout(dictSearchTimer);
      dictSearchTimer = setTimeout(() => void loadDictionary(), 180);
    });

    document.getElementById('i18nPrevPageBtn')?.addEventListener('click', () => {
      if (st.dictPage > 1) {
        st.dictPage -= 1;
        void loadDictionary();
      }
    });

    document.getElementById('i18nNextPageBtn')?.addEventListener('click', () => {
      st.dictPage += 1;
      void loadDictionary();
    });

    // Dict list row actions (event delegation)
    document.getElementById('i18nDictList')?.addEventListener('click', (e) => {
      const items = st.dictData?.items || [];
      const editBtn = e.target.closest('[data-i18n-edit]');
      if (editBtn) {
        const item = items[Number(editBtn.dataset.i18nEdit)];
        if (item) openEntryModal(item);
        return;
      }

      const toggleBtn = e.target.closest('[data-i18n-toggle]');
      if (toggleBtn) {
        const item = items[Number(toggleBtn.dataset.i18nToggle)];
        if (!item) return;
        void (async () => {
          try {
            await callAppTool('app_i18n_manage', {
              action: 'upsert_entry',
              en: item.en,
              zh: item.zh || '',
              scope: item.scope || 'ui',
              disabled: !item.disabled,
            });
            await loadDictionary();
            showToast(!item.disabled ? `已禁用词条「${item.en}」` : `已重新启用词条「${item.en}」`);
          } catch (err) {
            showToast(`操作失败：${err.message}`);
          }
        })();
        return;
      }

      const delBtn = e.target.closest('[data-i18n-del]');
      if (delBtn) {
        const item = items[Number(delBtn.dataset.i18nDel)];
        if (!item) return;
        void (async () => {
          try {
            await callAppTool('app_i18n_manage', {
              action: 'delete_entry',
              en: item.en,
              scope: item.scope || 'ui',
            });
            await loadDictionary();
            showToast(`已移除自定义覆盖「${item.en}」`);
          } catch (err) {
            showToast(`删除失败：${err.message}`);
          }
        })();
      }
    });

    // Entry modal form
    document.getElementById('i18nEntryDisabledSwitch')?.addEventListener('click', (e) => {
      st.entryDisabled = !st.entryDisabled;
      e.currentTarget.dataset.on = String(st.entryDisabled);
    });

    document.getElementById('i18nEntryForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void (async () => {
        const en = (document.getElementById('i18nEntryEnInput')?.value || '').trim();
        const zh = (document.getElementById('i18nEntryZhInput')?.value || '').trim();
        if (!en) return;
        try {
          await callAppTool('app_i18n_manage', {
            action: 'upsert_entry',
            en,
            zh,
            scope: st.entryScope,
            disabled: st.entryDisabled,
          });
          closeModal('i18nEntryModal');
          await loadDictionary();
          showToast('已保存词条并触发热更新');
        } catch (err) {
          showToast(`保存词条失败：${err.message}`);
        }
      })();
    });

    // Rules switches & inputs
    const bindImmSwitch = (id, key, label) => {
      document.getElementById(id)?.addEventListener('click', () => {
        const cur = getI18nConfig().immunity[key];
        const next = !cur;
        void saveI18nConfigPatch({ immunity: { [key]: next } }, `${next ? '已开启' : '已关闭'}${label}`);
      });
    };

    bindImmSwitch('i18nImmCodeBlocks', 'codeBlocks', '代码块免疫');
    bindImmSwitch('i18nImmInputs', 'inputs', '输入框免疫');
    bindImmSwitch('i18nImmTerminal', 'terminal', '终端免疫');
    bindImmSwitch('i18nImmFilePaths', 'filePaths', '文件路径与 URL 免疫');

    document.getElementById('i18nCustomSelectors')?.addEventListener('change', (e) => {
      const list = String(e.target.value || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      void saveI18nConfigPatch({ immunity: { customSelectors: list } }, `已保存 ${list.length} 条自定义免疫选择器`);
    });

    document.getElementById('i18nCustomBrandInput')?.addEventListener('change', (e) => {
      const txt = String(e.target.value || '').trim() || 'Antigravity';
      void saveI18nConfigPatch({ customBrandText: txt }, `已更新自定义品牌名称为「${txt}」`);
    });

    document.getElementById('i18nMenuLocSwitch')?.addEventListener('click', () => {
      const next = !getI18nConfig().menuLocalizationEnabled;
      void saveI18nConfigPatch(
        { menuLocalizationEnabled: next },
        next ? '已开启原生顶部菜单汉化（重启客户端生效）' : '已关闭原生顶部菜单汉化'
      );
    });

    document.getElementById('i18nUpdateRemindSwitch')?.addEventListener('click', () => {
      const next = !getI18nConfig().updateReminderEnabled;
      void saveI18nConfigPatch(
        { updateReminderEnabled: next },
        next ? '已开启官方更新覆盖后自动提醒' : '已关闭官方更新覆盖提醒'
      );
    });

    document.getElementById('i18nCollectUntransSwitch')?.addEventListener('click', () => {
      const next = !Boolean(getI18nConfig().collectUntranslated);
      void saveI18nConfigPatch(
        { collectUntranslated: next },
        next ? '已开启未翻译采集（逛一遍设置页后可复制清单）' : '已关闭未翻译采集'
      );
    });

    document.getElementById('i18nCopyUntransBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await callAppTool('app_i18n_manage', { action: 'list_untranslated' });
          const items = Array.isArray(res?.items) ? res.items : [];
          if (!items.length) {
            showToast('当前尚未采集到未翻译短语');
            return;
          }
          const payload = JSON.stringify(items, null, 2);
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(payload);
            showToast(`已复制 ${items.length} 条未翻译短语 JSON`);
          } else {
            showToast(`已采集 ${items.length} 条，文件位于 ~/.context-cache/i18n/untranslated.json`);
          }
        } catch (err) {
          showToast(`读取采集清单失败：${err.message}`);
        }
      })();
    });

    document.getElementById('i18nClearUntransBtn')?.addEventListener('click', () => {
      void (async () => {
        try {
          await callAppTool('app_i18n_manage', { action: 'clear_untranslated' });
          await refreshUntranslatedCount();
          showToast('已清空未翻译采集清单');
        } catch (err) {
          showToast(`清空失败：${err.message}`);
        }
      })();
    });
  }

  function init() {
    bindEvents();
    renderSelects();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && jobPollPendingVisibility) {
        jobPollPendingVisibility = false;
        void loadStatus(false);
      } else if (document.visibilityState !== 'visible' && jobPollTimer) {
        clearTimeout(jobPollTimer);
        jobPollTimer = null;
        jobPollPendingVisibility = true;
      }
    });
  }

  async function activate(subTab = null) {
    if (subTab && ['status', 'dict', 'rules'].includes(subTab)) {
      st.activeSubTab = subTab;
    }
    switchSubTab(st.activeSubTab);
    await loadStatus(false);
    if (st.activeSubTab === 'dict') {
      await loadDictionary();
    }
  }

  return {
    init,
    activate,
    loadStatus,
    renderSelects,
    handleSelectPick,
    positionSubNav,
    switchSubTab,
    getStatus: () => st.statusData,
  };
}
