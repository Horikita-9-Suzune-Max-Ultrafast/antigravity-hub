const SEVERITY_LABEL = {
  error: '严重',
  warn: '警告',
  info: '提示',
};

const SCOPE_LABEL = {
  workspace: '工作区',
  global: '全局',
  plugin: '插件',
  builtin: '内置',
};

const CATEGORY_LABEL = {
  secret: '隐私安全',
  mcp: 'MCP 体检',
  skill: 'Skill 体检',
  hook: 'Hook 审计',
  config: '配置解析',
};

function fmtK(tokens) {
  const n = Number(tokens) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createGovernanceModule({
  callAppTool,
  esc,
  showToast,
  positionIndicator,
  onOpenSettings,
  getProjectDir,
}) {
  const state = {
    activeSubTab: 'overview', // 'overview' | 'extensions' | 'harness' | 'profiles'
    loaded: false,
    busy: false,
    overview: null,
    extQuery: '',
    harnessFilter: 'all', // 'all' | 'rules' | 'skills' | 'hooks'
    pendingConfirm: null, // { type: 'profile' | 'rollback', id, title, diff }
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function positionSubNav() {
    positionIndicator('govSegNav', 'govSegIndicator');
  }

  function setSubTab(tab) {
    const valid = ['overview', 'extensions', 'harness', 'profiles'];
    const next = valid.includes(tab) ? tab : 'overview';
    state.activeSubTab = next;
    valid.forEach((t) => {
      const panel = byId(`gov-panel-${t}`);
      if (panel) panel.classList.toggle('hidden', t !== next);
      const btn = document.querySelector(`#govSegNav [data-gov-tab="${t}"]`);
      if (btn) btn.dataset.active = String(t === next);
    });
    requestAnimationFrame(positionSubNav);
  }

  async function loadOverview(showSpinner = false) {
    if (state.busy && !showSpinner) return;
    state.busy = true;
    const svg = byId('govRefreshSvg');
    if (showSpinner && svg) svg.classList.add('spin-once');
    try {
      const data = await callAppTool('app_governance_manage', {
        action: 'overview',
        projectDir: getProjectDir?.() || undefined,
      });
      if (data && data.ecosystem) {
        state.overview = data;
        state.loaded = true;
        renderAll();
      }
    } catch (err) {
      showToast(`加载生态治理数据失败: ${err.message || err}`, 'error');
    } finally {
      state.busy = false;
      if (svg) setTimeout(() => svg.classList.remove('spin-once'), 360);
    }
  }

  function renderHeaderBadge() {
    const pill = byId('govScorePill');
    const railDot = byId('railGovAlertDot');
    const topDot = byId('topBarGovDot');
    if (!state.overview) return;
    const score = state.overview.lint?.score ?? 100;
    const errCount = state.overview.lint?.counts?.errors ?? 0;
    if (pill) {
      pill.textContent = `体检 ${score} 分`;
      pill.dataset.tone = errCount > 0 ? 'error' : score < 85 ? 'warning' : 'success';
    }
    const showDot = errCount > 0;
    if (railDot) railDot.classList.toggle('hidden', !showDot);
    if (topDot) topDot.classList.toggle('hidden', !showDot);
  }

  function renderOverviewPanel() {
    const ov = state.overview;
    if (!ov) return;
    const s = ov.ecosystem.summary;
    const lint = ov.lint;

    const scoreEl = byId('govHealthScoreBig');
    if (scoreEl) {
      scoreEl.textContent = `${lint.score}`;
      scoreEl.className = `text-3xl font-semibold mono-num tracking-tight ${
        lint.counts.errors > 0 ? 'text-danger' : lint.score < 85 ? 'text-warning' : 'text-success'
      }`;
    }

    const metaEl = byId('govHealthSummaryText');
    if (metaEl) {
      metaEl.textContent = `严重 ${lint.counts.errors} · 警告 ${lint.counts.warnings} · 提示 ${lint.counts.infos} · 隐私扫描 ${lint.counts.scannedFiles} 份文件（${lint.counts.secretHits} 处告警）`;
    }

    const baseEl = byId('govBaselineTokens');
    if (baseEl) baseEl.textContent = `~${fmtK(s.estimatedBaselineTokens)}`;

    const countsGrid = byId('govAssetKpis');
    if (countsGrid) {
      countsGrid.innerHTML = [
        { label: '已启插件', val: `${s.pluginsEnabled}/${s.pluginsTotal}` },
        { label: '活跃 MCP', val: `${s.mcpEnabled}/${s.mcpTotal}` },
        { label: '生效 Skills', val: `${s.skillsActive}/${s.skillsTotal}` },
        { label: '生效 Rules / Hooks', val: `${s.rulesActive} / ${s.hooksActive}` },
      ]
        .map(
          (k) => `
          <div class="space-y-0.5">
            <div class="text-xs text-muted">${esc(k.label)}</div>
            <div class="text-base font-semibold mono-num">${esc(k.val)}</div>
          </div>`
        )
        .join('');
    }

    const listEl = byId('govLintFindingsList');
    if (listEl) {
      if (!lint.findings.length) {
        listEl.innerHTML = `
          <div class="px-5 py-6 text-center text-xs text-success">
            全部离线体检通过（MCP 健康、Skill 质量、隐私防泄露与配置解析均无异常）。
          </div>`;
      } else {
        listEl.innerHTML = lint.findings
          .map(
            (f) => `
            <div class="px-5 py-3 flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="gov-sev-badge" data-sev="${esc(f.severity)}">${esc(SEVERITY_LABEL[f.severity] || f.severity)}</span>
                  <span class="agy-pill text-xs">${esc(CATEGORY_LABEL[f.category] || f.category)}</span>
                  <span class="text-xs font-medium text-fg truncate">${esc(f.target || '')}</span>
                </div>
                <div class="text-xs text-muted leading-relaxed break-words">${esc(f.message)}</div>
                ${f.file ? `<div class="text-[11px] text-muted mono-num truncate">${esc(f.file)}</div>` : ''}
              </div>
            </div>`
          )
          .join('');
      }
    }
  }

  function renderExtensionsPanel() {
    const ov = state.overview;
    if (!ov) return;
    const q = state.extQuery.trim().toLowerCase();

    const plugins = ov.ecosystem.plugins.filter(
      (p) => !q || p.id.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)
    );
    const mcps = ov.ecosystem.mcpServers.filter(
      (m) => !q || m.name.toLowerCase().includes(q) || (m.pluginId || '').toLowerCase().includes(q)
    );

    const pList = byId('govPluginsList');
    if (pList) {
      if (!plugins.length) {
        pList.innerHTML = `<div class="px-5 py-6 text-center text-xs text-muted">未匹配到插件</div>`;
      } else {
        pList.innerHTML = plugins
          .map(
            (p) => `
            <div class="px-5 py-3.5 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium text-fg truncate">${esc(p.displayName)}</span>
                  <span class="agy-pill mono-num text-[11px]">${esc(p.version)}</span>
                  ${p.protected ? `<span class="agy-pill text-[11px] text-primary" style="border-color: var(--primary);">受保护</span>` : ''}
                  ${!p.enabled ? `<span class="agy-pill text-[11px] text-muted">已停用</span>` : ''}
                </div>
                <div class="text-xs text-muted truncate">${esc(p.description || p.displayPath)}</div>
                <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted mono-num">
                  <span>MCP ${p.counts.mcp}</span>
                  <span>· Skills ${p.counts.skills}</span>
                  <span>· Rules ${p.counts.rules}</span>
                  <span>· Hooks ${p.counts.hooks}</span>
                  <span>· 估算 ~${fmtK(p.tokens.total)}t</span>
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  class="agy-switch"
                  role="switch"
                  aria-checked="${p.enabled ? 'true' : 'false'}"
                  data-on="${p.enabled ? 'true' : 'false'}"
                  data-gov-toggle-plugin="${esc(p.id)}"
                  data-enabled="${p.enabled ? 'true' : 'false'}"
                  ${p.protected ? 'disabled title="受保护核心控制台，禁止关闭以防失联"' : `title="${p.enabled ? '点击安全停用（写前自动快照）' : '点击启用（写前自动快照）'}"`}
                ><span class="agy-switch-thumb"></span></button>
              </div>
            </div>`
          )
          .join('');
      }
    }

    const mList = byId('govMcpList');
    if (mList) {
      if (!mcps.length) {
        mList.innerHTML = `<div class="px-5 py-6 text-center text-xs text-muted">当前无已配置 MCP Server</div>`;
      } else {
        mList.innerHTML = mcps
          .map(
            (m) => `
            <div class="px-5 py-3.5 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium text-fg mono-num truncate">${esc(m.name)}</span>
                  <span class="agy-pill text-[11px]">${m.scope === 'global' ? '全局' : `插件 · ${esc(m.pluginId)}`}</span>
                  <span class="agy-pill mono-num text-[11px]">${esc(m.mode)}</span>
                  ${m.tokens > 0 ? `<span class="agy-pill mono-num text-[11px]">~${fmtK(m.tokens)}t</span>` : ''}
                </div>
                <div class="text-xs text-muted mono-num truncate">
                  ${m.transport === 'http' ? esc(m.url) : esc(`${m.command} ${(m.args || []).join(' ')}`.trim())}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-2">
                ${
                  m.canToggle
                    ? `<button
                        type="button"
                        class="agy-switch"
                        role="switch"
                        aria-checked="${m.enabled ? 'true' : 'false'}"
                        data-on="${m.enabled ? 'true' : 'false'}"
                        data-gov-toggle-mcp="${esc(m.name)}"
                        data-enabled="${m.enabled ? 'true' : 'false'}"
                        title="${m.enabled ? '停用并移入隔离暂存区（写前自动快照）' : '从隔离暂存区原样恢复'}"
                      ><span class="agy-switch-thumb"></span></button>`
                    : `<span class="text-[11px] text-muted">随父插件控制</span>`
                }
              </div>
            </div>`
          )
          .join('');
      }
    }
  }

  function renderHarnessPanel() {
    const ov = state.overview;
    if (!ov) return;
    const listEl = byId('govHarnessStackList');
    if (!listEl) return;

    const filter = state.harnessFilter;
    const rows = [];

    if (filter === 'all' || filter === 'rules') {
      for (const r of ov.ecosystem.rules) {
        rows.push({
          kind: 'Rule',
          priority: r.priority,
          scope: SCOPE_LABEL[r.scope] || r.scope,
          name: r.name,
          sub: `${r.sourceLabel} · ${r.lines} 行 · ${r.trigger}`,
          tokens: r.tokens,
          active: r.active,
          shadowedBy: null,
          filePath: r.filePath,
          warnTag: null,
        });
      }
    }
    if (filter === 'all' || filter === 'skills') {
      for (const sk of ov.ecosystem.skills) {
        rows.push({
          kind: 'Skill',
          priority: sk.priority,
          scope: SCOPE_LABEL[sk.scope] || sk.scope,
          name: sk.name,
          sub: `${sk.sourceLabel} · 描述 ~${sk.descTokens}t / 全文 ~${fmtK(sk.fullTokens)}t`,
          tokens: sk.descTokens,
          active: sk.active && !sk.shadowedBy,
          shadowedBy: sk.shadowedBy,
          filePath: sk.filePath,
          warnTag: sk.shadowedBy ? `被 ${sk.shadowedBy} 覆盖` : null,
        });
      }
    }
    if (filter === 'all' || filter === 'hooks') {
      for (const h of ov.ecosystem.hooks) {
        rows.push({
          kind: 'Hook',
          priority: h.scope === 'global' ? 2 : 3,
          scope: SCOPE_LABEL[h.scope] || h.scope,
          name: `${h.event}`,
          sub: `${h.sourceLabel}${h.timeout ? ` · timeout ${h.timeout}s` : ''}`,
          tokens: 0,
          active: h.active,
          shadowedBy: null,
          filePath: h.filePath,
          warnTag: h.isPreToolUse ? 'PreToolUse' : null,
        });
      }
    }

    rows.sort((a, b) => a.priority - b.priority || b.tokens - a.tokens);

    if (!rows.length) {
      listEl.innerHTML = `<div class="px-5 py-6 text-center text-xs text-muted">当前筛选下无条目</div>`;
      return;
    }

    listEl.innerHTML = rows
      .map(
        (item) => `
        <div class="px-5 py-3 flex items-center justify-between gap-3 ${item.active ? '' : 'opacity-60'}">
          <div class="min-w-0 space-y-0.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="agy-pill mono-num text-[11px]">P${item.priority}</span>
              <span class="agy-pill text-[11px]">${esc(item.kind)}</span>
              <span class="text-xs font-medium text-fg truncate">${esc(item.name)}</span>
              ${item.warnTag ? `<span class="gov-sev-badge" data-sev="warn">${esc(item.warnTag)}</span>` : ''}
              ${!item.active && !item.shadowedBy ? `<span class="agy-pill text-[11px] text-muted">未激活</span>` : ''}
            </div>
            <div class="text-[11px] text-muted truncate">${esc(item.sub)}</div>
          </div>
          <div class="shrink-0 flex items-center gap-2">
            ${item.tokens > 0 ? `<span class="text-xs mono-num text-muted">~${fmtK(item.tokens)}t</span>` : ''}
            ${
              item.filePath
                ? `<button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-xs" data-gov-preview-file="${esc(item.filePath)}" data-gov-preview-title="${esc(item.name)}">预览</button>`
                : ''
            }
          </div>
        </div>`
      )
      .join('');
  }

  function renderProfilesPanel() {
    const ov = state.overview;
    if (!ov) return;

    const pList = byId('govProfilesList');
    if (pList) {
      if (!ov.profiles.length) {
        pList.innerHTML = `
          <div class="px-5 py-6 text-center text-xs text-muted">
            尚未保存场景预设。在上方输入名称（如「重度编码」「轻量省流」）即可把当前启停组合存为一键预设。
          </div>`;
      } else {
        pList.innerHTML = ov.profiles
          .map((pf) => {
            const enPlugins = Object.values(pf.plugins || {}).filter(Boolean).length;
            const totalPlugins = Object.keys(pf.plugins || {}).length;
            return `
            <div class="px-5 py-3.5 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-0.5">
                <div class="text-sm font-medium text-fg truncate">${esc(pf.name)}</div>
                <div class="text-xs text-muted truncate">
                  ${esc(pf.description || `插件 ${enPlugins}/${totalPlugins} 启用`)} · 更新于 ${fmtTime(pf.updatedAt)}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1.5">
                <button type="button" class="agy-btn agy-btn-primary agy-btn-sm text-xs" data-gov-apply-profile="${esc(pf.id)}">预览并切换</button>
                <button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-xs" data-gov-delete-profile="${esc(pf.id)}">删除</button>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    const sList = byId('govSnapshotsList');
    if (sList) {
      if (!ov.snapshots.length) {
        sList.innerHTML = `
          <div class="px-5 py-6 text-center text-xs text-muted">
            尚未产生宿主配置修改快照。每次安全开关或场景切换前都会自动留存不可变备份。
          </div>`;
      } else {
        sList.innerHTML = ov.snapshots
          .slice(0, 15)
          .map(
            (sn) => `
            <div class="px-5 py-3 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-0.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-xs font-medium text-fg mono-num truncate">${esc(sn.reason)}</span>
                  ${sn.baseline ? `<span class="agy-pill text-[11px] text-success" style="border-color: var(--success);">永久基线</span>` : ''}
                </div>
                <div class="text-[11px] text-muted mono-num truncate">${fmtTime(sn.createdAt)} · ${esc(sn.id)}</div>
              </div>
              <button type="button" class="agy-btn agy-btn-secondary agy-btn-sm text-xs shrink-0" data-gov-rollback="${esc(sn.id)}" ${sn.available ? '' : 'disabled'}>
                预览回滚
              </button>
            </div>`
          )
          .join('');
      }
    }
  }

  function renderAll() {
    renderHeaderBadge();
    renderOverviewPanel();
    renderExtensionsPanel();
    renderHarnessPanel();
    renderProfilesPanel();
  }

  function openConfirmDialog({ type, id, title, bodyHtml }) {
    state.pendingConfirm = { type, id };
    const modal = byId('govConfirmModal');
    const titleEl = byId('govConfirmTitle');
    const bodyEl = byId('govConfirmBody');
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.innerHTML = bodyHtml;
    if (modal) modal.classList.remove('hidden');
  }

  function closeConfirmDialog() {
    state.pendingConfirm = null;
    byId('govConfirmModal')?.classList.add('hidden');
  }

  async function openFilePreview(filePath, title) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'preview_file',
        filePath,
        projectDir: getProjectDir?.() || undefined,
      });
      const modal = byId('govPreviewModal');
      const titleEl = byId('govPreviewTitle');
      const pathEl = byId('govPreviewPath');
      const codeEl = byId('govPreviewContent');
      if (titleEl) titleEl.textContent = `只读脱敏预览 · ${title || ''}`;
      if (pathEl) pathEl.textContent = `${res.displayPath || filePath}（${res.lines || 0} 行${res.truncated ? '，已截断' : ''}）`;
      if (codeEl) codeEl.textContent = res.content || '(空文件)';
      if (modal) modal.classList.remove('hidden');
    } catch (err) {
      showToast(`无法预览文件: ${err.message || err}`, 'error');
    }
  }

  async function handleTogglePlugin(pluginId, nextEnabled) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'toggle_plugin',
        pluginId,
        enabled: nextEnabled,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.overview) state.overview = res.overview;
      renderAll();
      showToast(res?.result?.message || '已更新插件状态', 'success');
    } catch (err) {
      showToast(err.message || String(err), 'error');
      await loadOverview(false);
    }
  }

  async function handleToggleMcp(serverName, nextEnabled) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'toggle_mcp',
        serverName,
        enabled: nextEnabled,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.overview) state.overview = res.overview;
      renderAll();
      showToast(res?.result?.message || '已更新全局 MCP 状态', 'success');
    } catch (err) {
      showToast(err.message || String(err), 'error');
      await loadOverview(false);
    }
  }

  async function handlePreviewProfile(profileId) {
    try {
      const diff = await callAppTool('app_governance_manage', {
        action: 'preview_profile',
        profileId,
      });
      if (!diff.totalChanges) {
        showToast(`当前状态已与预设「${diff.profile.name}」一致，无需修改`, 'info');
        return;
      }
      const lines = [
        ...diff.pluginChanges.map(
          (c) => `<div class="text-xs mono-num">${c.to ? '+ 启用插件' : '- 停用插件'}: <strong>${esc(c.displayName)}</strong> (${esc(c.id)})</div>`
        ),
        ...diff.mcpChanges.map(
          (c) => `<div class="text-xs mono-num">${c.to ? '+ 启用全局 MCP' : '- 隔离全局 MCP'}: <strong>${esc(c.name)}</strong></div>`
        ),
      ];
      const deltaStr = diff.estimatedTokenDelta === 0 ? '±0' : `${diff.estimatedTokenDelta > 0 ? '+' : ''}${fmtK(diff.estimatedTokenDelta)}t`;
      openConfirmDialog({
        type: 'profile',
        id: profileId,
        title: `确认切换场景预设：${diff.profile.name}`,
        bodyHtml: `
          <div class="text-xs text-muted mb-2">执行前将自动创建不可变宿主配置快照；本次共变更 <strong>${diff.totalChanges}</strong> 项，预计常驻上下文变化 <strong class="mono-num">${esc(deltaStr)}</strong>：</div>
          <div class="agy-subtle p-3 space-y-1.5">${lines.join('')}</div>
          ${diff.skippedProtected?.length ? `<div class="text-[11px] text-primary mt-2">已自动跳过受保护项：${esc(diff.skippedProtected.join(', '))}</div>` : ''}
        `,
      });
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  async function handlePreviewRollback(snapshotId) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'preview_rollback',
        snapshotId,
      });
      const rows = (res.diffs || []).map(
        (d) => `<div class="text-xs mono-num">• <strong>${esc(d.fileName)}</strong> → ${d.willChange ? (d.action === 'remove' ? '移除新增文件' : '字节级还原') : '无变化'} (${d.currentBytes}B → ${d.snapshotBytes}B)</div>`
      );
      openConfirmDialog({
        type: 'rollback',
        id: res.snapshot.id,
        title: `确认无损回滚快照`,
        bodyHtml: `
          <div class="text-xs text-muted mb-2">快照原因：<strong>${esc(res.snapshot.reason)}</strong>（${fmtTime(res.snapshot.createdAt)}）</div>
          <div class="agy-subtle p-3 space-y-1.5">${rows.join('')}</div>
        `,
      });
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  async function executePendingConfirm() {
    const pending = state.pendingConfirm;
    if (!pending) return;
    closeConfirmDialog();
    try {
      if (pending.type === 'profile') {
        const res = await callAppTool('app_governance_manage', {
          action: 'apply_profile',
          profileId: pending.id,
          projectDir: getProjectDir?.() || undefined,
        });
        if (res?.overview) state.overview = res.overview;
        renderAll();
        showToast(res?.result?.message || '已切换场景预设', 'success');
      } else if (pending.type === 'rollback') {
        const res = await callAppTool('app_governance_manage', {
          action: 'rollback_snapshot',
          snapshotId: pending.id,
          projectDir: getProjectDir?.() || undefined,
        });
        if (res?.overview) state.overview = res.overview;
        renderAll();
        showToast(res?.result?.message || '已无损回滚快照', 'success');
      }
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  function init() {
    document.querySelectorAll('#govSegNav [data-gov-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setSubTab(btn.dataset.govTab));
    });

    byId('govRefreshBtn')?.addEventListener('click', () => void loadOverview(true));
    byId('govSettingsBtn')?.addEventListener('click', () => onOpenSettings?.());

    byId('govExtSearch')?.addEventListener('input', (e) => {
      state.extQuery = e.target.value || '';
      renderExtensionsPanel();
    });

    document.querySelectorAll('[data-gov-harness-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.harnessFilter = btn.dataset.govHarnessFilter;
        document.querySelectorAll('[data-gov-harness-filter]').forEach((b) => {
          b.dataset.active = String(b.dataset.govHarnessFilter === state.harnessFilter);
        });
        renderHarnessPanel();
      });
    });

    byId('govSaveProfileBtn')?.addEventListener('click', async () => {
      const nameInput = byId('govProfileNameInput');
      const descInput = byId('govProfileDescInput');
      const name = String(nameInput?.value || '').trim();
      if (!name) {
        showToast('请输入场景预设名称', 'warning');
        return;
      }
      try {
        await callAppTool('app_governance_manage', {
          action: 'save_profile',
          name,
          description: String(descInput?.value || '').trim(),
          projectDir: getProjectDir?.() || undefined,
        });
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        await loadOverview(false);
        showToast(`已保存当前组合为预设「${name}」`, 'success');
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });

    // Delegated click handlers inside #module-governance
    byId('module-governance')?.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      if (target.dataset.govTogglePlugin) {
        const nextEnabled = target.dataset.enabled !== 'true';
        void handleTogglePlugin(target.dataset.govTogglePlugin, nextEnabled);
        return;
      }
      if (target.dataset.govToggleMcp) {
        const nextEnabled = target.dataset.enabled !== 'true';
        void handleToggleMcp(target.dataset.govToggleMcp, nextEnabled);
        return;
      }
      if (target.dataset.govPreviewFile) {
        void openFilePreview(target.dataset.govPreviewFile, target.dataset.govPreviewTitle);
        return;
      }
      if (target.dataset.govApplyProfile) {
        void handlePreviewProfile(target.dataset.govApplyProfile);
        return;
      }
      if (target.dataset.govDeleteProfile) {
        const pid = target.dataset.govDeleteProfile;
        void (async () => {
          try {
            await callAppTool('app_governance_manage', { action: 'delete_profile', profileId: pid });
            await loadOverview(false);
            showToast('已删除场景预设', 'success');
          } catch (err) {
            showToast(err.message || String(err), 'error');
          }
        })();
        return;
      }
      if (target.dataset.govRollback) {
        void handlePreviewRollback(target.dataset.govRollback);
      }
    });

    byId('govConfirmOkBtn')?.addEventListener('click', () => void executePendingConfirm());
    byId('govConfirmCancelBtn')?.addEventListener('click', closeConfirmDialog);
    byId('govConfirmCloseBtn')?.addEventListener('click', closeConfirmDialog);
    byId('govPreviewCloseBtn')?.addEventListener('click', () => byId('govPreviewModal')?.classList.add('hidden'));
  }

  async function activate(subTab = null) {
    if (subTab) setSubTab(subTab);
    if (!state.loaded) {
      await loadOverview(true);
    } else {
      void loadOverview(false);
    }
    requestAnimationFrame(positionSubNav);
  }

  return {
    init,
    activate,
    loadOverview,
    setSubTab,
    positionSubNav,
  };
}
