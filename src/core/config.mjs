import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths } from './paths.mjs';
import { atomicWriteJsonObj, createLruCache, withFileLockSync } from './fs-utils.mjs';

export const VALID_POLL_INTERVALS = [3, 5, 10, 30, 60, 0];
export const VALID_UI_LANGUAGES = ['zh-CN', 'en'];
export const VALID_CURRENCIES = ['CNY', 'USD'];
export const VALID_MINI_BAR_MODULES = ['context', 'cache', 'kv', 'tps', 'model'];
export const VALID_MINI_BAR_PRESETS = ['full', 'wide', 'standard', 'compact', 'minimal', 'custom'];
export const VALID_CONSOLE_MODULES = ['monitor', 'review', 'governance', 'appearance', 'i18n'];
export const VALID_WINDOW_MODES = ['console', 'minibar', 'orb'];

const CNY_TIMEZONE_RE = /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Hong_Kong|Macau|Taipei)/i;

export function detectDefaultCurrency() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return CNY_TIMEZONE_RE.test(tz) ? 'CNY' : 'USD';
  } catch {
    return 'USD';
  }
}

const configReadCache = createLruCache(16);

export const DEFAULT_CONFIG = {
  version: 1,
  uiLanguage: 'zh-CN',
  currency: detectDefaultCurrency(),
  cnyPerUsd: 7.2,
  pollIntervalSec: 5,
  auxAutoOpen: true,
  popout: {
    enabled: false,
    autoLaunchOnStartup: true,
    autoLaunchFromSidebar: true,
    alwaysOnTop: true,
    size: '460x720',
    position: null,
    windowMode: 'console', // 'console' | 'minibar' | 'orb'
    orbPosition: null,     // { x: number, y: number } | null
    miniBarPreset: 'standard',
    miniBarModules: ['context', 'cache', 'kv', 'tps', 'model'],
    miniBarCustomWidth: null,
  },
  kvCache: {
    enabled: true,
    ttlMinutes: 15,
  },
  uiBanner: {
    enabled: true,
  },
  console: {
    defaultModule: 'monitor', // 'monitor' | 'i18n'
  },
  i18n: {
    installDirOverride: '',
    updateReminderEnabled: true,
    menuLocalizationEnabled: true,
    collectUntranslated: false,
    brandMode: 'original', // 'original' | 'zh' | 'custom' | 'hidden'
    customBrandText: 'Antigravity',
    communitySourceUrl: '',
    immunity: {
      codeBlocks: true,
      inputs: true,
      terminal: true,
      filePaths: true,
      customSelectors: [],
    },
  },
  sessionStartBudgetTokens: 450,
  alerts: {
    contextWarningPct: 75,
    cacheDropThresholdPct: 50,
    lowTpsThreshold: 15,
    lowTpsStreak: 3,
    subagentShareThresholdPct: 35,
    subagentContextWarnTokens: 100000,
    mcpServerWarnTokens: 15000,
  },
  modelLimits: {
    'gemini-4-hydrogen': 1000000,
    'gemini-4-neon': 1000000,
    'gemini-4-pro': 1000000,
    'gemini-4-flash': 1000000,
    'gemini-4-argon': 1000000,
    'gemini-4': 1000000,
    'gemini-2.5': 1000000,
    'gemini-2.0': 1000000,
    'gemini': 1000000,
    'claude-4': 200000,
    'claude-3': 200000,
    'claude': 200000,
    'gpt-5': 400000,
    'gpt-4': 128000,
    'o3': 200000,
    'o4': 200000,
    default: 200000,
  },
  // USD per 1,000,000 tokens
  pricing: {
    'gemini-4-hydrogen': { input: 2.5, cacheRead: 0.25, output: 15.0 },
    'gemini-4-neon': { input: 2.5, cacheRead: 0.25, output: 15.0 },
    'gemini-4-pro': { input: 2.0, cacheRead: 0.2, output: 12.0 },
    'gemini-4-flash': { input: 0.3, cacheRead: 0.03, output: 1.5 },
    'gemini-4-argon': { input: 4.0, cacheRead: 0.4, output: 20.0 },
    'gemini-2.5-pro': { input: 1.25, cacheRead: 0.125, output: 10.0 },
    'gemini-2.5-flash': { input: 0.15, cacheRead: 0.015, output: 0.6 },
    'claude-4-opus': { input: 15.0, cacheRead: 1.5, output: 75.0 },
    'claude-4-sonnet': { input: 3.0, cacheRead: 0.3, output: 15.0 },
    'claude-3': { input: 3.0, cacheRead: 0.3, output: 15.0 },
    'gpt-4o': { input: 2.5, cacheRead: 1.25, output: 10.0 },
    'o3': { input: 2.0, cacheRead: 0.5, output: 8.0 },
    default: { input: 2.0, cacheRead: 0.2, output: 10.0 },
  },
  quotaGroups: [
    {
      id: 'gemini',
      name: 'Gemini 模型',
      desc: 'Gemini 4 Neon / Pro / Flash',
      includePattern: 'gemini',
      excludePattern: 'argon',
      has5hWindow: true,
      defaultWeeklyBudgetTokens: 15000000,
      default5hBudgetTokens: 2500000,
    },
    {
      id: 'claude_gpt',
      name: 'Claude 与 GPT 模型',
      desc: 'Claude Sonnet / Opus / GPT',
      includePattern: 'claude|gpt|o1|o3|o4',
      excludePattern: '',
      has5hWindow: true,
      defaultWeeklyBudgetTokens: 8000000,
      default5hBudgetTokens: 1500000,
    },
    {
      id: 'argon',
      name: 'Gemini 4 Argon',
      desc: '深度推理独立配额池',
      includePattern: 'argon',
      excludePattern: '',
      has5hWindow: false,
      defaultWeeklyBudgetTokens: 4000000,
      default5hBudgetTokens: 0,
    },
  ],
  quotaCalibrations: {},
};

const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? structuredClone(base) : structuredClone(patch);
  }
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || UNSAFE_MERGE_KEYS.has(k)) continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.prototype.hasOwnProperty.call(out, k) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

/**
 * Clamp user-edited config fields into safe, valid bounds.
 */
export function sanitizeConfig(cfg) {
  const out = deepMerge(DEFAULT_CONFIG, cfg);
  if (typeof out.uiLanguage === 'string') {
    const trimmedLang = out.uiLanguage.trim();
    if (VALID_UI_LANGUAGES.includes(trimmedLang)) {
      out.uiLanguage = trimmedLang;
    } else if (trimmedLang.toLowerCase() === 'en') {
      out.uiLanguage = 'en';
    } else {
      out.uiLanguage = 'zh-CN';
    }
  } else {
    out.uiLanguage = 'zh-CN';
  }
  const normalizedCurrency = typeof out.currency === 'string' ? out.currency.trim().toUpperCase() : '';
  out.currency = VALID_CURRENCIES.includes(normalizedCurrency) ? normalizedCurrency : detectDefaultCurrency();
  const rawCnyPerUsd = Number(out.cnyPerUsd);
  out.cnyPerUsd =
    Number.isFinite(rawCnyPerUsd) && rawCnyPerUsd !== 0 ? Math.max(1, Math.min(50, rawCnyPerUsd)) : 7.2;
  if (!VALID_POLL_INTERVALS.includes(Number(out.pollIntervalSec))) {
    out.pollIntervalSec = 5;
  } else {
    out.pollIntervalSec = Number(out.pollIntervalSec);
  }
  out.auxAutoOpen = Boolean(out.auxAutoOpen);
  out.popout.enabled = Boolean(out.popout.enabled);
  out.popout.autoLaunchOnStartup =
    out.popout.autoLaunchOnStartup === undefined ? true : Boolean(out.popout.autoLaunchOnStartup);
  out.popout.autoLaunchFromSidebar =
    out.popout.autoLaunchFromSidebar === undefined ? true : Boolean(out.popout.autoLaunchFromSidebar);
  out.popout.alwaysOnTop =
    out.popout.alwaysOnTop === undefined ? true : Boolean(out.popout.alwaysOnTop);
  if (!/^\d{3,4}x\d{3,4}$/.test(String(out.popout.size || ''))) {
    out.popout.size = '460x720';
  }
  if (!VALID_MINI_BAR_PRESETS.includes(out.popout.miniBarPreset)) {
    out.popout.miniBarPreset = 'standard';
  }
  {
    const rawMods = Array.isArray(out.popout.miniBarModules) ? out.popout.miniBarModules : [];
    const seen = new Set();
    const cleaned = [];
    for (const m of rawMods) {
      const k = String(m || '').trim();
      if (VALID_MINI_BAR_MODULES.includes(k) && !seen.has(k)) {
        seen.add(k);
        cleaned.push(k);
      }
    }
    for (const defMod of VALID_MINI_BAR_MODULES) {
      if (!seen.has(defMod)) cleaned.push(defMod);
    }
    out.popout.miniBarModules = cleaned;
  }
  if (Number.isFinite(Number(out.popout.miniBarCustomWidth)) && Number(out.popout.miniBarCustomWidth) >= 220) {
    out.popout.miniBarCustomWidth = Math.max(220, Math.min(1200, Math.round(Number(out.popout.miniBarCustomWidth))));
  } else {
    out.popout.miniBarCustomWidth = null;
  }
  out.kvCache = {
    enabled: out.kvCache?.enabled === undefined ? true : Boolean(out.kvCache.enabled),
    ttlMinutes: Math.max(3, Math.min(60, Math.round(Number(out.kvCache?.ttlMinutes) || 15))),
  };
  if (
    out.popout.position &&
    typeof out.popout.position === 'object' &&
    Number.isFinite(Number(out.popout.position.x)) &&
    Number.isFinite(Number(out.popout.position.y))
  ) {
    out.popout.position = {
      x: Math.max(-4000, Math.min(8000, Math.round(Number(out.popout.position.x)))),
      y: Math.max(-2000, Math.min(4000, Math.round(Number(out.popout.position.y)))),
    };
  } else {
    out.popout.position = null;
  }
  if (!VALID_WINDOW_MODES.includes(out.popout.windowMode)) {
    out.popout.windowMode = 'console';
  }
  if (
    out.popout.orbPosition &&
    typeof out.popout.orbPosition === 'object' &&
    Number.isFinite(Number(out.popout.orbPosition.x)) &&
    Number.isFinite(Number(out.popout.orbPosition.y))
  ) {
    out.popout.orbPosition = {
      x: Math.max(-4000, Math.min(8000, Math.round(Number(out.popout.orbPosition.x)))),
      y: Math.max(-2000, Math.min(4000, Math.round(Number(out.popout.orbPosition.y)))),
    };
  } else {
    out.popout.orbPosition = null;
  }
  out.uiBanner.enabled = Boolean(out.uiBanner.enabled);
  out.sessionStartBudgetTokens = Math.max(150, Math.min(490, Number(out.sessionStartBudgetTokens) || 450));
  out.alerts.contextWarningPct = Math.max(50, Math.min(95, Number(out.alerts.contextWarningPct) || 75));
  out.alerts.cacheDropThresholdPct = Math.max(20, Math.min(90, Number(out.alerts.cacheDropThresholdPct) || 50));
  out.alerts.lowTpsThreshold = Math.max(5, Math.min(100, Number(out.alerts.lowTpsThreshold) || 15));
  out.alerts.lowTpsStreak = Math.max(2, Math.min(10, Number(out.alerts.lowTpsStreak) || 3));

  if (!VALID_CONSOLE_MODULES.includes(out.console?.defaultModule)) {
    out.console = { defaultModule: 'monitor' };
  }
  out.i18n.installDirOverride = typeof out.i18n.installDirOverride === 'string' ? out.i18n.installDirOverride.trim() : '';
  out.i18n.updateReminderEnabled = out.i18n.updateReminderEnabled === undefined ? true : Boolean(out.i18n.updateReminderEnabled);
  out.i18n.menuLocalizationEnabled = out.i18n.menuLocalizationEnabled === undefined ? true : Boolean(out.i18n.menuLocalizationEnabled);
  out.i18n.collectUntranslated = Boolean(out.i18n.collectUntranslated);
  if (!['original', 'zh', 'custom', 'hidden'].includes(out.i18n.brandMode)) {
    out.i18n.brandMode = 'original';
  }
  out.i18n.customBrandText = typeof out.i18n.customBrandText === 'string'
    ? out.i18n.customBrandText.trim().slice(0, 64) || 'Antigravity'
    : 'Antigravity';
  out.i18n.communitySourceUrl = typeof out.i18n.communitySourceUrl === 'string' ? out.i18n.communitySourceUrl.trim() : '';
  out.i18n.immunity = {
    codeBlocks: out.i18n.immunity?.codeBlocks === undefined ? true : Boolean(out.i18n.immunity.codeBlocks),
    inputs: out.i18n.immunity?.inputs === undefined ? true : Boolean(out.i18n.immunity.inputs),
    terminal: out.i18n.immunity?.terminal === undefined ? true : Boolean(out.i18n.immunity.terminal),
    filePaths: out.i18n.immunity?.filePaths === undefined ? true : Boolean(out.i18n.immunity.filePaths),
    customSelectors: Array.isArray(out.i18n.immunity?.customSelectors)
      ? out.i18n.immunity.customSelectors.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50)
      : [],
  };
  return out;
}

export function loadConfig(options = {}) {
  const { configFile } = getDataPaths(options);
  const resolved = path.resolve(configFile);
  try {
    const st = fs.statSync(resolved);
    const cached = configReadCache.get(resolved);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return structuredClone(cached.value);
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const sanitized = sanitizeConfig(raw);
    configReadCache.set(resolved, { mtimeMs: st.mtimeMs, size: st.size, value: sanitized });
    return structuredClone(sanitized);
  } catch {
    // Fall back safely to defaults on missing or corrupt config
    configReadCache.delete(resolved);
  }
  return sanitizeConfig(DEFAULT_CONFIG);
}

export function saveConfig(patch, options = {}) {
  const { configFile } = getDataPaths(options);
  const resolved = path.resolve(configFile);
  return withFileLockSync(resolved, () => {
    const current = loadConfig(options);
    const next = sanitizeConfig(deepMerge(current, patch));
    atomicWriteJsonObj(resolved, next);
    try {
      const st = fs.statSync(resolved);
      configReadCache.set(resolved, { mtimeMs: st.mtimeMs, size: st.size, value: next });
    } catch {
      configReadCache.delete(resolved);
    }
    return structuredClone(next);
  });
}

/**
 * Lookup model context window limit by longest prefix match.
 */
export function getModelLimit(modelName, config = DEFAULT_CONFIG) {
  const limits = config?.modelLimits || DEFAULT_CONFIG.modelLimits;
  if (!modelName) return limits.default || 200000;
  const lower = String(modelName).toLowerCase();
  let bestKey = '';
  let bestVal = limits.default || 200000;
  for (const [k, v] of Object.entries(limits)) {
    if (k === 'default') continue;
    if (lower.includes(k.toLowerCase()) && k.length > bestKey.length) {
      bestKey = k;
      bestVal = Number(v) || bestVal;
    }
  }
  return bestVal;
}

/**
 * Lookup model pricing (USD per 1M tokens) by longest match.
 */
export function getModelPricing(modelName, config = DEFAULT_CONFIG) {
  const pricing = config?.pricing || DEFAULT_CONFIG.pricing;
  const fallback = pricing.default || DEFAULT_CONFIG.pricing.default;
  if (!modelName) return fallback;
  const lower = String(modelName).toLowerCase();
  let bestKey = '';
  let bestVal = fallback;
  for (const [k, v] of Object.entries(pricing)) {
    if (k === 'default') continue;
    if (lower.includes(k.toLowerCase()) && k.length > bestKey.length) {
      bestKey = k;
      bestVal = v;
    }
  }
  return bestVal;
}

/**
 * Estimate call cost in USD from token counts.
 */
export function estimateCallCostUsd({ model, inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 }, config = DEFAULT_CONFIG) {
  const p = getModelPricing(model, config);
  const freshIn = Math.max(0, Number(inputTokens) || 0);
  const cachedIn = Math.max(0, Number(cacheReadTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const usd = (freshIn * p.input + cachedIn * p.cacheRead + out * p.output) / 1_000_000;
  return Number(usd.toFixed(6));
}
