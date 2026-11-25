/**
 * Unified brand prism logos (#hub-logo-mark, #hub-logo-sm), 1.75px stroke SVG icon sprite,
 * and cross-model brand health state computation (Gemini + Claude/GPT).
 */

import { esc } from '../core/dom.mjs';

export const ICON_SPRITE_HTML = `<svg id="agyIconSprite" class="hidden" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <symbol id="hub-logo-mark" viewBox="0 0 128 128" fill="none">
    <rect class="brand-bg" x="10" y="10" width="108" height="108" rx="28" fill="currentColor"/>
    <path class="brand-core" d="M64 26L92 50L64 74L36 50L64 26Z" fill="#FFFFFF"/>
    <path class="brand-facet" d="M64 26L92 50L64 74V26Z" fill="#D5EFFF" fill-opacity="0.42"/>
    <path class="brand-wing" d="M32 78L64 98L96 78" stroke="#D5EFFF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="hub-logo-sm" viewBox="0 0 20 20" fill="none">
    <rect class="brand-bg" x="1" y="1" width="18" height="18" rx="5" fill="currentColor"/>
    <path class="brand-core" d="M10 4L15 8L10 12L5 8L10 4Z" fill="#FFFFFF"/>
    <path class="brand-wing" d="M5 13L10 16L15 13" stroke="#D5EFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </symbol>
  <symbol id="ico-close" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 4l8 8M12 4l-8 8"/>
  </symbol>
  <symbol id="ico-chevron-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3.5L10.5 8L6 12.5"/>
  </symbol>
  <symbol id="ico-chevron-down" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6l4 4 4-4"/>
  </symbol>
  <symbol id="ico-chevron-up" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 10l4-4 4 4"/>
  </symbol>
  <symbol id="ico-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 8.5L6.5 11.5L12.5 4.8"/>
  </symbol>
  <symbol id="ico-info" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="6"/>
    <path d="M8 7.2v3.6M8 4.8h.01"/>
  </symbol>
  <symbol id="ico-help" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 6.2a2.2 2.2 0 1 1 3.5 1.8c-.9.6-1.5 1.1-1.5 2"/>
    <path d="M8 12.2h.01"/>
  </symbol>
  <symbol id="ico-arrow-left" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.5 3.5L6 8l4.5 4.5"/>
  </symbol>
  <symbol id="ico-arrow-right" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5.5 3.5L10 8l-4.5 4.5"/>
  </symbol>
  <symbol id="ico-target" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="8" r="2.2"/>
    <path d="M8 2v2M8 12v2M2 8h2M12 8h2"/>
  </symbol>
  <symbol id="ico-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/>
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>
  </symbol>
  <symbol id="ico-refresh" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.6"/>
    <path d="M13.5 2.4v2.9h-2.9"/>
  </symbol>
  <symbol id="ico-popout" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.5 2.5h4v4"/>
    <path d="M13.5 2.5L7.5 8.5"/>
    <path d="M12 9v3a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5.5A1.5 1.5 0 0 1 4 4h3"/>
  </symbol>
  <symbol id="ico-pin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.8 2.2l4 4-1.4 1.4-1.2-.5-2.7 2.7.5 1.8-1.1 1.1-2.8-2.8-2.9 2.9-.7-.7 2.9-2.9L1.6 6.4l1.1-1.1 1.8.5 2.7-2.7-.5-1.2 1.4-1.4z"/>
  </symbol>
  <symbol id="ico-minimize" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
    <path d="M3.5 8.5h9"/>
  </symbol>
  <symbol id="ico-maximize" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round">
    <rect x="3" y="3" width="10" height="10" rx="2"/>
  </symbol>
  <symbol id="ico-git" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="5" cy="4" r="1.8"/>
    <circle cx="11" cy="12" r="1.8"/>
    <path d="M5 5.8V12M5 8.5c0-1.6 6-1.2 6 1.7"/>
  </symbol>
  <symbol id="ico-capsule" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="4.2" width="12" height="7.6" rx="3.8"/>
    <path d="M8 4.2v7.6"/>
  </symbol>
  <symbol id="ico-monitor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12h4l3-7 4 14 3-7h4"/>
  </symbol>
  <symbol id="ico-review" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
    <path d="M14 3v6h6"/>
    <path d="M9 14l2 2 4-4"/>
  </symbol>
  <symbol id="ico-governance" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7l8-4z"/>
    <path d="M9 12l2 2 4-4"/>
  </symbol>
  <symbol id="ico-appearance" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="3"/>
    <circle cx="9" cy="10" r="1.5"/>
    <path d="M21 15l-4.5-4.5L9 18"/>
  </symbol>
  <symbol id="ico-i18n" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 8l6 6"/>
    <path d="M4 14l6-6 2-3"/>
    <path d="M2 5h12"/>
    <path d="M7 2h1"/>
    <path d="M22 22l-5-10-5 10"/>
    <path d="M14 18h6"/>
  </symbol>
  <symbol id="ico-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
  </symbol>
  <symbol id="ico-restart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
    <line x1="12" y1="2" x2="12" y2="12"/>
  </symbol>
</svg>`;

export function ensureIconSprite(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.body) return null;
  let existing = doc.getElementById('agyIconSprite');
  if (existing) return existing;
  const tpl = doc.createElement('div');
  tpl.innerHTML = ICON_SPRITE_HTML;
  const svg = tpl.firstElementChild;
  if (svg) {
    doc.body.insertBefore(svg, doc.body.firstChild);
    existing = svg;
  }
  return existing;
}

export function renderIcon(name, { size = 14, className = '', id = '' } = {}) {
  const sym = String(name || '').startsWith('ico-') ? name : `ico-${name}`;
  const cls = ['agy-ico', className].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<svg${idAttr} width="${Number(size) || 14}" height="${Number(size) || 14}" class="${esc(cls)}" aria-hidden="true"><use href="#${esc(sym)}"/></svg>`;
}

export function renderBrandMark({ size = 22, id = '', live = true, health = 'safe', className = '' } = {}) {
  const px = Number(size) || 22;
  const symbolId = px <= 20 ? 'hub-logo-sm' : 'hub-logo-mark';
  const cls = ['hub-brand-svg', 'shrink-0', className].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  const stateAttrs = live
    ? ` data-health="${esc(health)}" data-kv-state="${esc(health)}"`
    : ' data-static="true" data-health="safe"';
  return `<svg${idAttr} width="${px}" height="${px}" class="${esc(cls)}"${stateAttrs} aria-hidden="true"><use href="#${symbolId}"/></svg>`;
}

const HEALTH_RANK = { safe: 0, warn: 1, danger: 2 };

function maxHealth(a, b) {
  return (HEALTH_RANK[b] || 0) > (HEALTH_RANK[a] || 0) ? b : a;
}

/**
 * Full-model health state computation for live brand icons & orb:
 * - Gemini models: combines KV cache freshness state with context threshold & cache drops.
 * - Claude/GPT/other models: derives health from context usage threshold & recent cache drops.
 */
export function computeBrandHealthState(ctx, config = {}, kvState = null) {
  let health = 'safe';

  if (kvState && kvState.visible && (kvState.state === 'warn' || kvState.state === 'danger')) {
    health = maxHealth(health, kvState.state);
  }

  if (!ctx || typeof ctx !== 'object') return health;

  const warnPct = Number(config?.alerts?.contextWarningPct) || 75;
  const dangerPct = Math.min(95, Math.max(90, warnPct + 15));
  const usedPct = Number(ctx.usedPercent) || 0;
  const usedTokens = Number(ctx.usedTokens) || 0;
  const totalCalls = Number(ctx.totalCallsCount) || 0;

  if (usedPct >= dangerPct) {
    health = maxHealth(health, 'danger');
  } else if (usedPct >= warnPct) {
    health = maxHealth(health, 'warn');
  }

  const dropThresh = Number(config?.alerts?.cacheDropThresholdPct) || 50;
  const cacheHit = Number(ctx.latestCacheHitRate);
  const alerts = Array.isArray(ctx.alerts) ? ctx.alerts : [];
  const hasCacheDropAlert = alerts.some((a) => a?.code === 'cache_drop');
  const hasErrorAlert = alerts.some((a) => a?.level === 'error');

  if (hasErrorAlert) {
    health = maxHealth(health, 'danger');
  } else if (hasCacheDropAlert || (totalCalls >= 2 && usedTokens > 2000 && Number.isFinite(cacheHit) && cacheHit < dropThresh)) {
    health = maxHealth(health, usedPct >= warnPct || cacheHit < 25 ? 'danger' : 'warn');
  }

  return health;
}
