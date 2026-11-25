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

const MCP_MODE_LABEL = {
  eager: '常驻加载',
  deferred: '按需懒加载',
  configured: '已配置',
  disabled: '已停用',
};

const CATEGORY_LABEL = {
  secret: '隐私安全',
  mcp: 'MCP 体检',
  skill: 'Skill 体检',
  hook: 'Hook 审计',
  config: '配置解析',
};

const ITEM_CATEGORY_LABEL = {
  coding: '开发',
  office: '办公协作',
  general: '通用',
};

function fmtK(tokens) {
  const n = Math.abs(Number(tokens) || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtSignedK(tokens) {
  const n = Number(tokens) || 0;
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '-'}${fmtK(n)}t`;
}

function fmtTokenParts(tb) {
  if (!tb) return '';
  const parts = [];
  if (tb.rules) parts.push(`Rules ${fmtK(tb.rules)}t`);
  if (tb.skills) parts.push(`Skills ${fmtK(tb.skills)}t`);
  if (tb.mcp) parts.push(`MCP ${fmtK(tb.mcp)}t`);
  return parts.join(' / ');
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
  canSendMessage,
  sendToAgent,
}) {
  const state = {
    activeSubTab: 'overview', // 'overview' | 'extensions' | 'harness' | 'profiles'
    loaded: false,
    busy: false,
    overview: null,
    extQuery: '',
    harnessFilter: 'all', // 'all' | 'rules' | 'skills' | 'hooks'
    pendingConfirm: null, // { type: 'profile' | 'rollback', id, title, diff }
    showIgnored: false,
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
      const parts = [
        `严重 ${lint.counts.errors}`,
        `警告 ${lint.counts.warnings}`,
        `提示 ${lint.counts.infos}`,
        `隐私扫描 ${lint.counts.scannedFiles} 份文件（${lint.counts.secretHits} 处告警）`,
      ];
      if (lint.counts.ignored > 0) parts.push(`已忽略 ${lint.counts.ignored} 项`);
      metaEl.textContent = parts.join('  ');
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

    const hasDirectSend = Boolean(canSendMessage?.());
    const agentFixable = (lint.findings || []).filter(
      (f) => f.remediation?.strategy === 'agent' && f.remediation?.prompt
    );
    const fixAllBtn = byId('govFixAllBtn');
    if (fixAllBtn) {
      fixAllBtn.classList.toggle('hidden', agentFixable.length === 0);
      if (agentFixable.length > 0) {
        fixAllBtn.textContent = hasDirectSend
          ? `打包交给 Agent (${agentFixable.length})`
          : `复制全部修复提示词 (${agentFixable.length})`;
      }
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
          .map((f, idx) => {
            const rem = f.remediation || {};
            const strategy = rem.strategy || 'agent';
            const btns = [];

            if (strategy === 'secret_manual') {
              if (f.absFile) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-secondary text-xs" data-gov-preview-file="${esc(f.absFile)}" data-gov-preview-title="${esc(f.target || '脱敏预览')}">脱敏预览</button>`
                );
              }
              if (rem.prompt) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-secondary text-xs" data-gov-fix-idx="${idx}">安全改造提示词</button>`
                );
              }
            } else if (strategy === 'local_toggle') {
              if (rem.actionTargetTab) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-primary text-xs" data-gov-jump-tab="${esc(rem.actionTargetTab)}" data-gov-jump-search="${esc(rem.searchHint || '')}">前往处理</button>`
                );
              }
              if (rem.prompt) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-secondary text-xs" data-gov-fix-idx="${idx}">${hasDirectSend ? '交给 Agent' : '修复提示词'}</button>`
                );
              }
            } else {
              if (rem.prompt) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-primary text-xs" data-gov-fix-idx="${idx}">${hasDirectSend ? '交给 Agent' : '修复提示词'}</button>`
                );
              }
              if (rem.actionTargetTab) {
                btns.push(
                  `<button type="button" class="agy-btn agy-btn-secondary text-xs" data-gov-jump-tab="${esc(rem.actionTargetTab)}" data-gov-jump-search="${esc(rem.searchHint || '')}">前往停用</button>`
                );
              }
            }

            if (f.id) {
              btns.push(
                `<button type="button" class="agy-btn agy-btn-secondary text-xs" data-gov-ignore-id="${esc(f.id)}">忽略</button>`
              );
            }

            return `
            <div class="px-5 py-3.5 flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1 space-y-1" style="min-width: min(240px, 100%);">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="gov-sev-badge" data-sev="${esc(f.severity)}">${esc(SEVERITY_LABEL[f.severity] || f.severity)}</span>
                  <span class="agy-pill text-xs">${esc(CATEGORY_LABEL[f.category] || f.category)}</span>
                  ${f.isPluginManaged ? `<span class="agy-pill text-xs text-muted">已安装插件</span>` : ''}
                  <span class="text-xs font-medium text-fg truncate">${esc(f.target || '')}</span>
                </div>
                <div class="text-xs text-fg leading-relaxed break-words">${esc(f.message)}</div>
                ${rem.summary ? `<div class="text-xs text-muted leading-relaxed break-words">建议：${esc(rem.summary)}</div>` : ''}
                ${f.file ? `<div class="text-xs text-muted mono-num truncate">${esc(f.file)}</div>` : ''}
              </div>
              <div class="shrink-0 flex flex-wrap items-center gap-1.5 pt-0.5">
                ${btns.join('')}
              </div>
            </div>`;
          })
          .join('');
      }
    }

    const ignoredList = lint.ignoredFindings || [];
    const ignoredSec = byId('govIgnoredSection');
    const ignoredCountEl = byId('govIgnoredCount');
    const ignoredListEl = byId('govIgnoredList');
    const ignoredToggleBtn = byId('govIgnoredToggleBtn');
    const ignoredChevron = byId('govIgnoredChevron');
    if (ignoredSec && ignoredCountEl && ignoredListEl) {
      ignoredSec.classList.toggle('hidden', ignoredList.length === 0);
      ignoredCountEl.textContent = String(ignoredList.length);
      const isOpen = Boolean(state.showIgnored && ignoredList.length > 0);
      ignoredListEl.classList.toggle('hidden', !isOpen);
      if (ignoredToggleBtn) {
        ignoredToggleBtn.dataset.open = String(isOpen);
        ignoredToggleBtn.setAttribute('aria-expanded', String(isOpen));
      }
      if (ignoredChevron) ignoredChevron.textContent = isOpen ? '收起' : '展开';
      if (ignoredList.length > 0) {
        ignoredListEl.innerHTML = ignoredList
          .map(
            (f) => `
            <div class="px-5 py-3 flex items-center justify-between gap-3 opacity-80">
              <div class="min-w-0 space-y-0.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="gov-sev-badge" data-sev="${esc(f.severity)}">${esc(SEVERITY_LABEL[f.severity] || f.severity)}</span>
                  <span class="agy-pill text-xs">${esc(CATEGORY_LABEL[f.category] || f.category)}</span>
                  <span class="text-xs font-medium text-fg truncate">${esc(f.target || '')}</span>
                </div>
                <div class="text-xs text-muted truncate">${esc(f.message)}</div>
              </div>
              <button type="button" class="agy-btn agy-btn-secondary text-xs shrink-0" data-gov-unignore-id="${esc(f.id)}">恢复检查</button>
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
          .map((p) => {
            const cls = p.classification || { category: 'general', source: 'inferred', reason: '' };
            const selectedCat = cls.source === 'user' ? cls.category : 'auto';
            const autoLabel = `自动(${ITEM_CATEGORY_LABEL[cls.category] || '通用'})`;
            const isSysProt = Boolean(p.systemProtected);
            const isPinned = Boolean(p.userPinned);
            return `
            <div class="px-5 py-3.5 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium text-fg truncate">${esc(p.displayName)}</span>
                  <span class="agy-pill mono-num text-xs">${esc(p.version)}</span>
                  ${isSysProt ? `<span class="agy-pill text-xs text-primary" style="border-color: var(--primary);">系统保护</span>` : ''}
                  ${isPinned ? `<span class="agy-pill text-xs text-primary" style="border-color: var(--primary);">常驻核心</span>` : ''}
                  ${!p.enabled ? `<span class="agy-pill text-xs text-muted">已停用</span>` : ''}
                </div>
                <div class="text-xs text-muted truncate">${esc(p.description || p.displayPath)}</div>
                <div class="flex flex-wrap items-center gap-3 text-xs text-muted mono-num">
                  <span>MCP ${p.counts.mcp}</span>
                  <span>Skills ${p.counts.skills}</span>
                  <span>Rules ${p.counts.rules}</span>
                  <span>Hooks ${p.counts.hooks}</span>
                  <span>估算 ~${fmtK(p.tokens.total)}t</span>
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-2">
                ${
                  isSysProt
                    ? ''
                    : `<select
                        class="agy-input text-xs py-1 px-2"
                        style="width: auto; min-width: 92px;"
                        data-gov-item-category="plugin:${esc(p.id)}"
                        title="${esc(cls.reason || '场景分类')}"
                      >
                        <option value="auto" ${selectedCat === 'auto' ? 'selected' : ''}>${esc(autoLabel)}</option>
                        <option value="coding" ${selectedCat === 'coding' ? 'selected' : ''}>开发</option>
                        <option value="office" ${selectedCat === 'office' ? 'selected' : ''}>办公协作</option>
                        <option value="general" ${selectedCat === 'general' ? 'selected' : ''}>通用</option>
                      </select>
                      <button
                        type="button"
                        class="agy-btn ${isPinned ? 'agy-btn-primary' : 'agy-btn-secondary'} agy-btn-sm text-xs"
                        data-gov-pin-plugin="${esc(p.id)}"
                        data-pinned="${isPinned ? 'true' : 'false'}"
                        title="${isPinned ? '取消常驻核心保护' : '设为常驻核心，场景切换时默认保留'}"
                      >${isPinned ? '已常驻' : '常驻'}</button>`
                }
                <button
                  type="button"
                  class="agy-switch"
                  role="switch"
                  aria-checked="${p.enabled ? 'true' : 'false'}"
                  data-on="${p.enabled ? 'true' : 'false'}"
                  data-gov-toggle-plugin="${esc(p.id)}"
                  data-enabled="${p.enabled ? 'true' : 'false'}"
                  ${isSysProt ? 'disabled title="系统保护核心控制台，禁止关闭以防失联"' : `title="${p.enabled ? '点击安全停用（写前自动快照）' : '点击启用（写前自动快照）'}"`}
                ><span class="agy-switch-thumb"></span></button>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    const mList = byId('govMcpList');
    if (mList) {
      if (!mcps.length) {
        mList.innerHTML = `<div class="px-5 py-6 text-center text-xs text-muted">当前无已配置 MCP Server</div>`;
      } else {
        mList.innerHTML = mcps
          .map((m) => {
            const cls = m.classification || { category: 'general', source: 'inferred', reason: '' };
            const selectedCat = cls.source === 'user' ? cls.category : 'auto';
            const autoLabel = `自动(${ITEM_CATEGORY_LABEL[cls.category] || '通用'})`;
            return `
            <div class="px-5 py-3.5 flex items-center justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium text-fg mono-num truncate">${esc(m.name)}</span>
                  <span class="agy-pill text-xs">${m.scope === 'global' ? '全局' : `插件 ${esc(m.pluginId)}`}</span>
                  <span class="agy-pill text-xs">${esc(MCP_MODE_LABEL[m.mode] || m.mode)}</span>
                  ${m.tokens > 0 ? `<span class="agy-pill mono-num text-xs">~${fmtK(m.tokens)}t</span>` : ''}
                </div>
                <div class="text-xs text-muted mono-num truncate">
                  ${m.transport === 'http' ? esc(m.url) : esc(`${m.command} ${(m.args || []).join(' ')}`.trim())}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-2">
                ${
                  m.canToggle
                    ? `<select
                        class="agy-input text-xs py-1 px-2"
                        style="width: auto; min-width: 92px;"
                        data-gov-item-category="mcp:${esc(m.name)}"
                        title="${esc(cls.reason || '场景分类')}"
                      >
                        <option value="auto" ${selectedCat === 'auto' ? 'selected' : ''}>${esc(autoLabel)}</option>
                        <option value="coding" ${selectedCat === 'coding' ? 'selected' : ''}>开发</option>
                        <option value="office" ${selectedCat === 'office' ? 'selected' : ''}>办公协作</option>
                        <option value="general" ${selectedCat === 'general' ? 'selected' : ''}>通用</option>
                      </select>
                      <button
                        type="button"
                        class="agy-switch"
                        role="switch"
                        aria-checked="${m.enabled ? 'true' : 'false'}"
                        data-on="${m.enabled ? 'true' : 'false'}"
                        data-gov-toggle-mcp="${esc(m.name)}"
                        data-enabled="${m.enabled ? 'true' : 'false'}"
                        title="${m.enabled ? '停用并移入隔离暂存区（写前自动快照）' : '从隔离暂存区原样恢复'}"
                      ><span class="agy-switch-thumb"></span></button>`
                    : `<span class="text-xs text-muted">随父插件控制</span>`
                }
              </div>
            </div>`;
          })
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
          sub: `${r.sourceLabel} / ${r.lines} 行 / ${r.trigger}`,
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
          sub: `${sk.sourceLabel} / 描述 ~${sk.descTokens}t / 全文 ~${fmtK(sk.fullTokens)}t`,
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
          sub: `${h.sourceLabel}${h.timeout ? ` / 超时 ${h.timeout}s` : ''}`,
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
              <span class="agy-pill mono-num text-xs">P${item.priority}</span>
              <span class="agy-pill text-xs">${esc(item.kind)}</span>
              <span class="text-xs font-medium text-fg truncate">${esc(item.name)}</span>
              ${item.warnTag ? `<span class="gov-sev-badge" data-sev="warn">${esc(item.warnTag)}</span>` : ''}
              ${!item.active && !item.shadowedBy ? `<span class="agy-pill text-xs text-muted">未激活</span>` : ''}
            </div>
            <div class="text-xs text-muted truncate">${esc(item.sub)}</div>
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

    const builtinList = byId('govBuiltinProfilesList');
    if (builtinList) {
      const builtins = ov.builtinProfiles || [];
      if (!builtins.length) {
        builtinList.innerHTML = `<div class="px-5 py-5 text-center text-xs text-muted">暂无内置推荐预设</div>`;
      } else {
        builtinList.innerHTML = builtins
          .map((pf) => {
            const st = pf.stats || {};
            const sevTone = pf.tone === 'warn' ? 'warn' : pf.tone === 'error' ? 'error' : 'info';
            return `
            <div class="px-5 py-3.5 space-y-1.5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0 space-y-1 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm font-medium text-fg">${esc(pf.name)}</span>
                    ${pf.badge ? `<span class="gov-sev-badge" data-sev="${sevTone}">${esc(pf.badge)}</span>` : ''}
                  </div>
                  <div class="text-xs text-muted leading-snug">${esc(pf.description || '')}</div>
                  <div class="flex flex-wrap items-center gap-3 text-xs text-muted mono-num pt-0.5">
                    <span>插件 ${st.enabledPlugins ?? 0}/${st.totalPlugins ?? 0}</span>
                    <span>全局 MCP ${st.enabledMcp ?? 0}/${st.totalMcp ?? 0}</span>
                    ${st.uncertainCount > 0 ? `<span>未归类 ${st.uncertainCount}</span>` : ''}
                  </div>
                </div>
                <button type="button" class="agy-btn agy-btn-primary agy-btn-sm text-xs shrink-0" data-gov-apply-profile="${esc(pf.id)}">预览并切换</button>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    const pList = byId('govProfilesList');
    if (pList) {
      if (!ov.profiles.length) {
        pList.innerHTML = `
          <div class="px-5 py-5 text-center text-xs text-muted">
            尚未保存自定义预设。你可以直接使用上方内置推荐预设，或在上方输入框将当前启停组合存为专属预设。
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
                <div class="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span class="truncate">${esc(pf.description || `插件 ${enPlugins}/${totalPlugins} 启用`)}</span>
                  <span class="mono-num shrink-0">更新于 ${fmtTime(pf.updatedAt)}</span>
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
                  ${sn.baseline ? `<span class="agy-pill text-xs text-success" style="border-color: var(--success);">永久基线</span>` : ''}
                </div>
                <div class="text-xs text-muted mono-num truncate">${fmtTime(sn.createdAt)} | ${esc(sn.id)}</div>
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
      if (titleEl) titleEl.textContent = title ? `只读脱敏预览：${title}` : '只读脱敏预览';
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

  async function handlePinPlugin(pluginId, nextPinned) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'set_plugin_pin',
        pluginId,
        pinned: nextPinned,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.overview) state.overview = res.overview;
      renderAll();
      showToast(res?.result?.message || '已更新常驻保护状态', 'success');
    } catch (err) {
      showToast(err.message || String(err), 'error');
      await loadOverview(false);
    }
  }

  async function handleSetItemCategory(itemKey, category) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'set_item_category',
        itemKey,
        category,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.overview) state.overview = res.overview;
      renderAll();
      showToast(res?.result?.message || '已更新场景分类', 'success');
    } catch (err) {
      showToast(err.message || String(err), 'error');
      await loadOverview(false);
    }
  }

  function updateProfileModalSummary() {
    const pending = state.pendingConfirm;
    if (!pending || pending.type !== 'profile' || !pending.items) return;
    const summaryEl = byId('govProfileDiffSummary');
    if (!summaryEl) return;

    let count = 0;
    const totals = { rules: 0, skills: 0, mcp: 0, total: 0 };
    for (const item of pending.items) {
      const cb = document.querySelector(`#govConfirmBody input[data-diff-idx="${item.idx}"]`);
      const checked = cb ? cb.checked : item.defaultChecked;
      if (!checked) continue;
      count++;
      const sign = item.to ? 1 : -1;
      totals.rules += sign * (item.tokenBreakdown?.rules || 0);
      totals.skills += sign * (item.tokenBreakdown?.skills || 0);
      totals.mcp += sign * (item.tokenBreakdown?.mcp || 0);
      totals.total += sign * (item.tokenBreakdown?.total || 0);
    }

    const parts = [];
    if (totals.rules) parts.push(`Rules ${fmtSignedK(totals.rules)}`);
    if (totals.skills) parts.push(`Skills ${fmtSignedK(totals.skills)}`);
    if (totals.mcp) parts.push(`MCP ${fmtSignedK(totals.mcp)}`);
    const breakdownHtml = parts.length ? `（${esc(parts.join(' / '))}）` : '';
    summaryEl.innerHTML = `执行前自动留存快照；本次变更 <strong>${count}</strong> 项，预计常驻上下文变化 <strong class="mono-num">${esc(fmtSignedK(totals.total))}</strong><span class="mono-num text-muted">${breakdownHtml}</span>`;
  }

  async function handlePreviewProfile(profileId) {
    try {
      const diff = await callAppTool('app_governance_manage', {
        action: 'preview_profile',
        profileId,
      });
      const uncertain = Array.isArray(diff.unchangedUncertain) ? diff.unchangedUncertain : [];
      if (!diff.totalChanges && !uncertain.length) {
        showToast(`当前状态已与预设「${diff.profile.name}」一致，无需修改`, 'info');
        return;
      }

      const items = [];
      for (const c of diff.pluginChanges || []) {
        items.push({
          idx: items.length,
          kind: 'plugin',
          id: c.id,
          displayName: c.displayName,
          from: c.from,
          to: c.to,
          defaultChecked: true,
          uncertain: false,
          classification: c.classification,
          tokenBreakdown: c.tokenBreakdown,
        });
      }
      for (const c of diff.mcpChanges || []) {
        items.push({
          idx: items.length,
          kind: 'mcp',
          id: c.name,
          displayName: c.name,
          from: c.from,
          to: c.to,
          defaultChecked: true,
          uncertain: false,
          classification: c.classification,
          tokenBreakdown: c.tokenBreakdown,
        });
      }
      for (const u of uncertain) {
        items.push({
          idx: items.length,
          kind: u.kind,
          id: u.id,
          displayName: u.displayName,
          from: u.enabled,
          to: !u.enabled,
          defaultChecked: false,
          uncertain: true,
          classification: u.classification,
          tokenBreakdown: u.tokenBreakdown,
        });
      }

      const renderRow = (item) => {
        const cls = item.classification || {};
        const catLabel = ITEM_CATEGORY_LABEL[cls.category] || '通用';
        const actionText = item.kind === 'plugin' ? (item.to ? '启用插件' : '停用插件') : item.to ? '启用 MCP' : '隔离 MCP';
        const tbText = fmtTokenParts(item.tokenBreakdown);
        return `
          <label class="flex items-start gap-2 py-1.5 cursor-pointer select-none">
            <input type="checkbox" class="shrink-0" style="margin-top: 2px;" data-diff-idx="${item.idx}" ${item.defaultChecked ? 'checked' : ''} />
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="flex flex-wrap items-center gap-1.5 text-xs">
                <span class="mono-num font-medium ${item.to ? 'text-success' : 'text-fg'}">${item.to ? '+' : '-'} ${esc(actionText)}</span>
                <strong class="text-fg truncate">${esc(item.displayName)}</strong>
                <span class="agy-pill text-xs">${esc(catLabel)}</span>
                ${tbText ? `<span class="text-xs text-muted mono-num">${esc(tbText)}</span>` : ''}
              </div>
              ${cls.reason ? `<div class="text-xs text-muted truncate">${esc(cls.reason)}</div>` : ''}
            </div>
          </label>`;
      };

      const mainItems = items.filter((x) => !x.uncertain);
      const uncertainItems = items.filter((x) => x.uncertain);

      openConfirmDialog({
        type: 'profile',
        id: profileId,
        title: `预览切换：${diff.profile.name}`,
        bodyHtml: `
          <div id="govProfileDiffSummary" class="text-xs text-muted mb-2 leading-relaxed"></div>
          ${
            mainItems.length
              ? `<div class="agy-subtle p-3 divide-y scroll-thin" style="max-height: 240px; overflow-y: auto;">${mainItems.map(renderRow).join('')}</div>`
              : `<div class="agy-subtle p-3 text-xs text-muted">推荐变更项已与当前状态一致。</div>`
          }
          ${
            uncertainItems.length
              ? `<div class="space-y-1.5 pt-2">
                  <div class="text-xs text-muted font-medium">未归类项（默认保持现状，可按需勾选切换）</div>
                  <div class="agy-subtle p-3 divide-y scroll-thin" style="max-height: 160px; overflow-y: auto;">${uncertainItems.map(renderRow).join('')}</div>
                </div>`
              : ''
          }
          ${diff.skippedProtected?.length ? `<div class="text-xs text-primary pt-1">已保护跳过：${esc(diff.skippedProtected.join(', '))}</div>` : ''}
          <div class="pt-2 border-t space-y-2">
            <label class="flex items-center gap-2 text-xs text-fg cursor-pointer select-none">
              <input id="govConfirmSaveAsToggle" type="checkbox" />
              <span>执行后同时另存为自定义预设</span>
            </label>
            <input id="govConfirmSaveAsName" type="text" class="agy-input text-xs hidden" placeholder="输入新预设名称（如：我的开发配置）" value="${esc(diff.profile.name)} 自定义" />
          </div>
        `,
      });

      state.pendingConfirm = { type: 'profile', id: profileId, diff, items };
      updateProfileModalSummary();
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

    let overrides = undefined;
    let saveAsName = undefined;
    if (pending.type === 'profile' && Array.isArray(pending.items)) {
      const pluginOverrides = {};
      const mcpOverrides = {};
      for (const item of pending.items) {
        const cb = document.querySelector(`#govConfirmBody input[data-diff-idx="${item.idx}"]`);
        const checked = cb ? cb.checked : item.defaultChecked;
        const desired = checked ? item.to : item.from;
        if (item.kind === 'plugin') pluginOverrides[item.id] = desired;
        else if (item.kind === 'mcp') mcpOverrides[item.id] = desired;
      }
      overrides = { plugins: pluginOverrides, globalMcp: mcpOverrides };
      const saveToggle = byId('govConfirmSaveAsToggle');
      const saveInput = byId('govConfirmSaveAsName');
      if (saveToggle?.checked) {
        const nm = String(saveInput?.value || '').trim();
        if (!nm) {
          showToast('请输入要保存的自定义预设名称', 'warning');
          saveInput?.focus();
          return;
        }
        saveAsName = nm;
      }
    }

    closeConfirmDialog();
    try {
      if (pending.type === 'profile') {
        const res = await callAppTool('app_governance_manage', {
          action: 'apply_profile',
          profileId: pending.id,
          overrides,
          saveAsName,
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

  function openLintFixModal({ title, prompt, notice = '', noticeTone = 'info' }) {
    const modal = byId('govLintFixModal');
    const titleEl = byId('govLintFixTitle');
    const noticeEl = byId('govLintFixNotice');
    const inputEl = byId('govLintFixPromptInput');
    const sendBtn = byId('govLintFixSendBtn');
    const copyBtn = byId('govLintFixCopyBtn');
    const hintEl = byId('govLintFixSurfaceHint');
    if (!modal || !inputEl) return;

    if (titleEl) titleEl.textContent = title || '修复提示词预览';
    inputEl.value = String(prompt || '');

    if (noticeEl) {
      if (notice) {
        noticeEl.textContent = notice;
        noticeEl.classList.remove('hidden');
        noticeEl.style.borderColor =
          noticeTone === 'danger' ? 'var(--danger)' : noticeTone === 'warning' ? 'var(--warning)' : 'var(--border)';
        noticeEl.style.color =
          noticeTone === 'danger' ? 'var(--danger)' : noticeTone === 'warning' ? 'var(--warning)' : 'var(--muted)';
      } else {
        noticeEl.classList.add('hidden');
      }
    }

    const directSend = Boolean(canSendMessage?.());
    if (sendBtn) sendBtn.classList.toggle('hidden', !directSend);
    if (hintEl) hintEl.classList.toggle('hidden', directSend);
    if (copyBtn) {
      copyBtn.classList.toggle('agy-btn-primary', !directSend);
      copyBtn.classList.toggle('agy-btn-secondary', directSend);
    }

    modal.classList.remove('hidden');
  }

  function closeLintFixModal() {
    byId('govLintFixModal')?.classList.add('hidden');
  }

  function handleOpenFindingFix(idx) {
    const finding = state.overview?.lint?.findings?.[Number(idx)];
    if (!finding?.remediation?.prompt) return;
    let notice = '';
    let noticeTone = 'info';
    if (finding.category === 'secret') {
      notice = '安全提示：直接让 Agent 读取含明文密钥的文件会使原文进入上下文，建议优先自行改为环境变量，或确认后再发送此安全改造提示词。';
      noticeTone = 'danger';
    } else if (finding.isPluginManaged) {
      notice = '该文件位于已安装插件目录，修改可能在插件更新后被覆盖，提示词已自动附加确认提醒。';
      noticeTone = 'warning';
    }
    openLintFixModal({
      title: `修复建议：${finding.target || finding.code}`,
      prompt: finding.remediation.prompt,
      notice,
      noticeTone,
    });
  }

  function handleOpenBatchFix() {
    const findings = (state.overview?.lint?.findings || []).filter(
      (f) => f.remediation?.strategy === 'agent' && f.remediation?.prompt
    );
    if (!findings.length) {
      showToast('当前没有可打包交给 Agent 的体检项', 'info');
      return;
    }
    const hasPluginManaged = findings.some((f) => f.isPluginManaged);
    const lines = [
      `请按顺序帮我排查并修复 Antigravity Hub 离线体检发现的以下 ${findings.length} 项问题：`,
      '',
    ];
    findings.forEach((f, i) => {
      lines.push(`${i + 1}. [${CATEGORY_LABEL[f.category] || f.category}] ${f.target || f.code}`);
      lines.push(`   - 现象：${f.message}`);
      if (f.file) lines.push(`   - 文件：${f.file}`);
      if (f.remediation?.summary) lines.push(`   - 目标：${f.remediation.summary}`);
    });
    lines.push('');
    lines.push('执行要求：逐项读取相关文件并给出最小必要改动；修改前简要说明方案，不要改动无关内容。');
    if (hasPluginManaged) {
      lines.push('注意：部分文件位于已安装插件目录，更新插件后可能被覆盖，请对插件目录内的改动先征得我确认再写入。');
    }

    openLintFixModal({
      title: `批量修复提示词（共 ${findings.length} 项）`,
      prompt: lines.join('\n'),
      notice: hasPluginManaged ? '包含已安装插件目录内的文件，提示词已自动提醒 Agent 修改前先征得确认。' : '',
      noticeTone: 'warning',
    });
  }

  async function handleSetLintIgnore(findingId, ignored) {
    try {
      const res = await callAppTool('app_governance_manage', {
        action: 'set_lint_ignore',
        findingId,
        ignored,
        projectDir: getProjectDir?.() || undefined,
      });
      if (res?.overview) {
        state.overview = res.overview;
        renderAll();
      }
      showToast(res?.result?.message || (ignored ? '已忽略该体检项' : '已恢复该体检项'), 'success');
    } catch (err) {
      showToast(err.message || String(err), 'error');
    }
  }

  function handleJumpToTarget(tab, searchHint) {
    setSubTab(tab);
    if (tab === 'extensions' && searchHint) {
      const inp = byId('govExtSearch');
      state.extQuery = searchHint;
      if (inp) {
        inp.value = searchHint;
        inp.focus();
      }
      renderExtensionsPanel();
    }
  }

  function init() {
    document.querySelectorAll('#govSegNav [data-gov-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setSubTab(btn.dataset.govTab));
    });

    byId('govRefreshBtn')?.addEventListener('click', () => void loadOverview(true));
    byId('govSettingsBtn')?.addEventListener('click', () => onOpenSettings?.());
    byId('govFixAllBtn')?.addEventListener('click', () => handleOpenBatchFix());
    byId('govIgnoredToggleBtn')?.addEventListener('click', () => {
      state.showIgnored = !state.showIgnored;
      renderOverviewPanel();
    });

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
      if (target.dataset.govFixIdx !== undefined) {
        handleOpenFindingFix(target.dataset.govFixIdx);
        return;
      }
      if (target.dataset.govJumpTab) {
        handleJumpToTarget(target.dataset.govJumpTab, target.dataset.govJumpSearch || '');
        return;
      }
      if (target.dataset.govIgnoreId) {
        void handleSetLintIgnore(target.dataset.govIgnoreId, true);
        return;
      }
      if (target.dataset.govUnignoreId) {
        void handleSetLintIgnore(target.dataset.govUnignoreId, false);
        return;
      }
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
      if (target.dataset.govPinPlugin) {
        const nextPinned = target.dataset.pinned !== 'true';
        void handlePinPlugin(target.dataset.govPinPlugin, nextPinned);
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

    byId('module-governance')?.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-gov-item-category]');
      if (!sel) return;
      void handleSetItemCategory(sel.dataset.govItemCategory, sel.value);
    });

    byId('govConfirmBody')?.addEventListener('change', (e) => {
      if (e.target.matches('input[data-diff-idx]')) {
        updateProfileModalSummary();
        return;
      }
      if (e.target.id === 'govConfirmSaveAsToggle') {
        const inp = byId('govConfirmSaveAsName');
        if (inp) {
          inp.classList.toggle('hidden', !e.target.checked);
          if (e.target.checked) inp.focus();
        }
      }
    });

    byId('govConfirmOkBtn')?.addEventListener('click', () => void executePendingConfirm());
    byId('govConfirmCancelBtn')?.addEventListener('click', closeConfirmDialog);
    byId('govConfirmCloseBtn')?.addEventListener('click', closeConfirmDialog);
    byId('govPreviewCloseBtn')?.addEventListener('click', () => byId('govPreviewModal')?.classList.add('hidden'));

    byId('govLintFixCloseBtn')?.addEventListener('click', closeLintFixModal);
    byId('govLintFixCancelBtn')?.addEventListener('click', closeLintFixModal);
    byId('govLintFixCopyBtn')?.addEventListener('click', async () => {
      const txt = String(byId('govLintFixPromptInput')?.value || '').trim();
      if (!txt) return;
      try {
        await navigator.clipboard?.writeText(txt);
        showToast('已复制修复提示词，切回任意对话粘贴发送即可', 'success');
      } catch {
        showToast('复制失败，请手动选中文本框内容复制', 'warning');
      }
    });
    byId('govLintFixSendBtn')?.addEventListener('click', async () => {
      const txt = String(byId('govLintFixPromptInput')?.value || '').trim();
      if (!txt) return;
      try {
        const res = await sendToAgent?.(txt);
        closeLintFixModal();
        if (res?.mode === 'sent') {
          showToast('已发送修复任务给当前对话 Agent', 'success');
        } else if (res?.mode === 'attached') {
          showToast('已附着到下条消息上下文，发送任意消息即可触发修复', 'success');
        } else {
          await navigator.clipboard?.writeText(txt).catch(() => {});
          showToast('当前视图不支持直发，已复制到剪贴板', 'info');
        }
      } catch (err) {
        showToast(`发送失败: ${err.message || err}`, 'error');
      }
    });
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
