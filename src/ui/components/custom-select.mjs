/**
 * Reusable custom popover select components (zero native <select>).
 */

import { esc, clampOpenSelectMenus } from '../core/dom.mjs';
import { renderIcon } from './icons.mjs';

export function getPollOptions(tr) {
  return [
    { value: '3', label: tr('monitor.poll.s3'), short: '3s' },
    { value: '5', label: tr('monitor.poll.s5'), short: '5s' },
    { value: '10', label: tr('monitor.poll.s10'), short: '10s' },
    { value: '30', label: tr('monitor.poll.s30'), short: '30s' },
    { value: '60', label: tr('monitor.poll.s60'), short: '60s' },
    { value: '0', label: tr('monitor.poll.manual'), short: tr('monitor.poll.manualShort') },
  ];
}

export function getPopoutSizes(tr) {
  return [
    { value: '380x660', label: tr('settings.popout.sizeCompact') },
    { value: '460x720', label: tr('settings.popout.sizeStandard') },
    { value: '640x720', label: tr('settings.popout.sizeWide') },
  ];
}

export function getModelSimOptions(tr) {
  return [
    { value: '', label: tr('monitor.ctx.modelSimNone') },
    { value: '200000', label: tr('monitor.ctx.modelSim200k') },
    { value: '256000', label: tr('monitor.ctx.modelSim256k') },
    { value: '1000000', label: tr('monitor.ctx.modelSim1m') },
  ];
}

export function renderCustomSelect(
  hostId,
  {
    id,
    value,
    options,
    alignRight = false,
    fullWidth = false,
    compact = false,
    triggerLabel = null,
    skipIfOpen = false,
  },
  { state, tr }
) {
  const host = typeof document !== 'undefined' ? document.getElementById(hostId) : null;
  if (!host) return;
  const isOpen = state.openSelectId === id;
  if (skipIfOpen && isOpen) return;
  const opts = options.length ? options : [{ value: '', label: tr('common.empty') }];
  const current = opts.find((o) => o.value === value) || opts[0];
  const shownLabel = triggerLabel ?? current.label;
  const sig = `${id}|${current.value}|${shownLabel}|${alignRight ? 1 : 0}|${fullWidth ? 1 : 0}|${compact ? 1 : 0}|${isOpen ? 1 : 0}|${opts.map((o) => `${o.value}:${o.label}`).join('\u001f')}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;

  const checkSvg = renderIcon('check', { size: 14, className: 'shrink-0' });
  const chevronSvg = renderIcon('chevron-down', { size: compact ? 12 : 14, className: 'agy-select-chevron' });

  host.innerHTML = `
    <button type="button" class="agy-select-trigger ${fullWidth ? 'w-full' : ''} ${compact ? 'compact-trigger' : ''}" aria-expanded="${isOpen}" data-select-toggle="${esc(id)}">
      <span class="truncate">${esc(shownLabel)}</span>
      ${chevronSvg}
    </button>
    <div class="agy-select-menu ${alignRight ? 'align-right' : ''} ${fullWidth ? 'w-full' : ''}" data-open="${isOpen}">
      ${opts
        .map(
          (opt) => `
        <button type="button" class="agy-select-opt" data-selected="${opt.value === current.value}" data-select-pick="${esc(id)}" data-select-val="${esc(opt.value)}">
          <span class="truncate">${esc(opt.label)}</span>
          ${opt.value === current.value ? checkSvg : ''}
        </button>`
        )
        .join('')}
    </div>`;
}

export function renderPollSelect(fromPoll, { state, tr, getUiLang }) {
  const host = document.getElementById('pollIntervalHost');
  if (!host) return;
  const isOpen = state.openSelectId === 'pollInterval';
  if (fromPoll && isOpen) return;
  const pollOptions = getPollOptions(tr);
  const val = String(state.config?.pollIntervalSec ?? 5);
  const cur = pollOptions.find((o) => o.value === val) || pollOptions[1];
  const isLive = Number(val) > 0;
  const lang = getUiLang();
  const sig = `${lang}|${val}|${isOpen ? 1 : 0}|${isLive ? 1 : 0}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;

  const checkSvg = renderIcon('check', { size: 14, className: 'shrink-0' });
  const chevronSvg = renderIcon('chevron-down', { size: 12, className: 'agy-select-chevron' });

  host.innerHTML = `
    <button type="button" class="agy-select-trigger pill-trigger" aria-expanded="${isOpen}" data-select-toggle="pollInterval" title="${esc(tr('monitor.header.pollTitle'))}">
      ${
        isLive
          ? '<span class="live-halo"><span></span></span>'
          : '<span class="dot-sm" style="background: var(--muted-foreground); opacity: 0.5;"></span>'
      }
      <span class="mono-num text-xs">${esc(cur.short)}</span>
      ${chevronSvg}
    </button>
    <div class="agy-select-menu align-right" data-open="${isOpen}">
      ${pollOptions
        .map(
          (opt) => `
        <button type="button" class="agy-select-opt" data-selected="${opt.value === val}" data-select-pick="pollInterval" data-select-val="${esc(opt.value)}">
          <span>${esc(opt.label)}</span>
          ${opt.value === val ? checkSvg : ''}
        </button>`
        )
        .join('')}
    </div>`;
}

export function renderFollowToggle({ state, tr, getUiLang }) {
  const btn = document.getElementById('followToggleBtn');
  if (!btn) return;
  const isAuto = state.followMode === 'auto';
  const sig = `${getUiLang()}|${isAuto ? 'auto' : 'pinned'}`;
  if (btn.dataset.followSig === sig) return;
  btn.dataset.followSig = sig;
  btn.dataset.mode = isAuto ? 'auto' : 'pinned';
  btn.title = isAuto ? tr('monitor.header.followAutoTitle') : tr('monitor.header.followPinnedTitle');
  btn.innerHTML = renderIcon(isAuto ? 'target' : 'lock', { size: 14 });
}

export function renderSessionSelect(fromPoll, { state, tr, getUiLang }) {
  const host = document.getElementById('sessionSelectHost');
  if (!host) return;
  const isOpen = state.openSelectId === 'sessionSelect';
  if (fromPoll && isOpen) return;
  const sessions = state.contextData?.sessions || [];
  const isAggregate = state.pinnedConversationId === '__active_all__' || state.activeConversationId === '__active_all__';
  const isAuto = !isAggregate && state.followMode === 'auto';
  const activeId = isAggregate
    ? '__active_all__'
    : isAuto
      ? state.activeConversationId
      : state.pinnedConversationId || state.activeConversationId;
  const matched = sessions.find((s) => s.id === activeId) || sessions[0] || null;
  const activeCount = sessions.filter((s) => s.isActive).length;
  const sig = `${getUiLang()}|${isOpen ? 1 : 0}|${isAggregate ? 1 : 0}|${isAuto ? 1 : 0}|${activeId || ''}|${activeCount}|${sessions.map((s) => `${s.id}:${s.label}:${s.isActive ? 1 : 0}:${s.stepCount || 0}:${s.subTag || ''}`).join('\u001f')}`;
  if (host.dataset.selectSig === sig) return;
  host.dataset.selectSig = sig;

  const titleText = isAggregate
    ? activeCount
      ? tr('monitor.session.aggregateTitleActive', { count: activeCount })
      : tr('monitor.session.aggregateTitle')
    : matched
      ? matched.isSubagent && matched.subTag
        ? `${matched.subTag} / ${matched.label}`
        : matched.label
      : tr('monitor.session.waiting');

  const modeChipHtml = isAggregate
    ? `<span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.aggregateChip'))}</span></span>`
    : isAuto
      ? `<span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.autoChip'))}</span></span>`
      : `<span class="session-mode-chip" data-mode="pinned"><span>${esc(tr('monitor.session.pinnedChip'))}</span></span>`;

  const checkSvg = renderIcon('check', { size: 14, className: 'shrink-0' });
  const chevronSvg = renderIcon('chevron-down', { size: 14, className: 'agy-select-chevron' });

  const sessionsHtml = sessions.length
    ? sessions
        .map((s) => {
          const isCur = !isAggregate && s.id === (matched?.id || activeId);
          return `
        <button type="button" class="agy-select-opt" data-selected="${isCur}" data-select-pick="sessionSelect" data-select-val="${esc(s.id)}">
          <span class="flex items-center gap-1.5 min-w-0">
            ${s.isActive ? `<span class="session-live-dot" title="${esc(tr('monitor.session.recentActive'))}"></span>` : ''}
            ${s.isSubagent ? `<span class="session-sub-pill">${esc(s.subTag || tr('monitor.session.subTag'))}</span>` : ''}
            <span class="truncate">${esc(s.label)}</span>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            ${s.stepCount ? `<span class="session-opt-meta mono-num">${esc(tr('monitor.session.stepsShort', { count: s.stepCount }))}</span>` : ''}
            ${isCur ? checkSvg : ''}
          </span>
        </button>`;
        })
        .join('')
    : `<div class="px-2.5 py-2 text-xs text-muted">${esc(tr('monitor.session.emptyWorkspace'))}</div>`;

  host.innerHTML = `
    <button type="button" class="agy-select-trigger w-full" aria-expanded="${isOpen}" data-select-toggle="sessionSelect">
      <span class="session-trigger-inner">
        ${modeChipHtml}
        <span class="truncate text-fg">${esc(titleText)}</span>
      </span>
      ${chevronSvg}
    </button>
    <div class="agy-select-menu w-full" data-open="${isOpen}">
      <button type="button" class="agy-select-opt" data-selected="${isAuto}" data-select-pick="sessionSelect" data-select-val="__auto__">
        <span class="flex items-center gap-2 min-w-0">
          <span class="session-mode-chip" data-mode="auto"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.autoChip'))}</span></span>
          <span class="truncate">${esc(tr('monitor.session.autoOption'))}</span>
        </span>
        ${isAuto ? checkSvg : ''}
      </button>
      <button type="button" class="agy-select-opt" data-selected="${isAggregate}" data-select-pick="sessionSelect" data-select-val="__active_all__">
        <span class="flex items-center gap-2 min-w-0">
          <span class="session-mode-chip" data-mode="aggregate"><span class="session-mode-dot"></span><span>${esc(tr('monitor.session.aggregateChip'))}</span></span>
          <span class="truncate">${esc(tr('monitor.session.aggregateOption'))}</span>
        </span>
        ${isAggregate ? checkSvg : ''}
      </button>
      <div class="session-menu-divider"></div>
      <div class="session-menu-caption">${esc(tr('monitor.session.listCaption'))}</div>
      ${sessionsHtml}
    </div>`;
}

export function renderModelSimSelect(fromPoll, { state, tr }) {
  const host = document.getElementById('ctxModelSimSelectHost');
  if (!host) return;
  renderCustomSelect(
    'ctxModelSimSelectHost',
    {
      id: 'ctxModelSim',
      value: String(state.modelSimLimit || ''),
      options: getModelSimOptions(tr),
      compact: true,
      skipIfOpen: fromPoll,
    },
    { state, tr }
  );
  if (state.openSelectId === 'ctxModelSim') {
    clampOpenSelectMenus();
  }
}
