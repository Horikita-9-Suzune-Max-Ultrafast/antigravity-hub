import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataPaths } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUILTIN_DICT_PATH = path.join(__dirname, 'builtin-dict.json');
const MAX_COMMUNITY_BYTES = 5 * 1024 * 1024; // 5 MiB
const SYNC_TIMEOUT_MS = 10_000; // 10s
const VALID_SCOPES = new Set(['ui', 'menu']);
const META_KEYS = new Set(['version', 'name', 'author', 'description', 'license', 'updatedAt', 'syncedAt', 'sourceUrl', '$schema']);

function assertValidScope(scope) {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`Invalid dictionary scope "${scope}". Expected "ui" or "menu".`);
  }
  return scope;
}

function normalizeStringMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function normalizePatternList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const regex = typeof item.regex === 'string' ? item.regex : '';
    const flags = typeof item.flags === 'string' ? item.flags : '';
    const replace = typeof item.replace === 'string' ? item.replace : '';
    if (!regex) continue;
    try {
      // Validate regex syntax so malformed community/custom patterns cannot crash runtime
      new RegExp(regex, flags);
    } catch {
      continue;
    }
    const entry = { regex, flags, replace };
    if (typeof item.note === 'string' && item.note.trim()) {
      entry.note = item.note.trim();
    }
    out.push(entry);
  }
  return out;
}

function normalizeDisabledList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item === 'string' && item.length > 0) {
      seen.add(item);
    }
  }
  return [...seen];
}

function createEmptyLayerDict(extra = {}) {
  return {
    version: 1,
    updatedAt: null,
    ui: {},
    menu: {},
    patterns: [],
    disabled: { ui: [], menu: [] },
    ...extra,
  };
}

function normalizeLayerDict(raw, { includeSourceMeta = false } = {}) {
  const base = createEmptyLayerDict(
    includeSourceMeta ? { sourceUrl: '', syncedAt: null } : {}
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  base.version = Number(raw.version) || 1;
  base.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  base.ui = normalizeStringMap(raw.ui);
  base.menu = normalizeStringMap(raw.menu);
  base.patterns = normalizePatternList(raw.patterns);
  base.disabled = {
    ui: normalizeDisabledList(raw.disabled?.ui),
    menu: normalizeDisabledList(raw.disabled?.menu),
  };
  if (includeSourceMeta) {
    base.sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '';
    base.syncedAt = typeof raw.syncedAt === 'string' ? raw.syncedAt : null;
  }
  return base;
}

function loadLayerDictionary(filePath, opts = {}) {
  const raw = readJsonSafe(filePath, null);
  return normalizeLayerDict(raw, opts);
}

function saveLayerDictionary(filePath, i18nDir, data, opts = {}) {
  ensureDir(i18nDir);
  const normalized = normalizeLayerDict(data, opts);
  normalized.updatedAt = new Date().toISOString();
  atomicWriteJson(filePath, normalized);
  return normalized;
}

/**
 * Load the built-in curated Simplified Chinese dictionary.
 */
export function loadBuiltinDictionary() {
  const raw = JSON.parse(fs.readFileSync(BUILTIN_DICT_PATH, 'utf8'));
  return {
    version: String(raw?.version || '1.3.0'),
    glossary: normalizeStringMap(raw?.glossary),
    menu: normalizeStringMap(raw?.menu),
    ui: normalizeStringMap(raw?.ui),
    patterns: normalizePatternList(raw?.patterns),
  };
}

export function loadCustomDictionary(options = {}) {
  const { i18nCustomDictFile } = getDataPaths(options);
  return loadLayerDictionary(i18nCustomDictFile);
}

export function saveCustomDictionary(data, options = {}) {
  const { i18nDir, i18nCustomDictFile } = getDataPaths(options);
  return saveLayerDictionary(i18nCustomDictFile, i18nDir, data);
}

export function loadCommunityDictionary(options = {}) {
  const { i18nCommunityDictFile } = getDataPaths(options);
  return loadLayerDictionary(i18nCommunityDictFile, { includeSourceMeta: true });
}

export function saveCommunityDictionary(data, options = {}) {
  const { i18nDir, i18nCommunityDictFile } = getDataPaths(options);
  return saveLayerDictionary(i18nCommunityDictFile, i18nDir, data, { includeSourceMeta: true });
}

function mergeScopeMap(builtinMap, communityMap, customMap, communityDisabledArr, customDisabledArr) {
  const communityDisabled = new Set(communityDisabledArr);
  const customDisabled = new Set(customDisabledArr);
  const allKeys = new Set([
    ...Object.keys(builtinMap),
    ...Object.keys(communityMap),
    ...Object.keys(customMap),
  ]);

  const merged = {};
  let disabledCount = 0;

  for (const en of allKeys) {
    if (customDisabled.has(en)) {
      disabledCount++;
      continue;
    }
    if (Object.hasOwn(customMap, en)) {
      merged[en] = customMap[en];
      continue;
    }
    if (communityDisabled.has(en)) {
      disabledCount++;
      continue;
    }
    if (Object.hasOwn(communityMap, en)) {
      merged[en] = communityMap[en];
      continue;
    }
    if (Object.hasOwn(builtinMap, en)) {
      merged[en] = builtinMap[en];
    }
  }

  return { merged, disabledCount };
}

function mergePatterns(builtinPatterns, communityPatterns, customPatterns) {
  const seen = new Set();
  const out = [];
  for (const list of [customPatterns, communityPatterns, builtinPatterns]) {
    for (const p of list) {
      const sig = `${p.regex}::${p.flags || ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(p);
    }
  }
  return out;
}

function computeStats(builtin, community, custom, mergedUi, mergedMenu, mergedPatterns, disabledCount) {
  return {
    builtinCount: Object.keys(builtin.ui).length + Object.keys(builtin.menu).length,
    communityCount: Object.keys(community.ui).length + Object.keys(community.menu).length,
    customCount: Object.keys(custom.ui).length + Object.keys(custom.menu).length,
    disabledCount,
    totalActive: Object.keys(mergedUi).length + Object.keys(mergedMenu).length,
    patternCount: mergedPatterns.length,
  };
}

function loadAllLayersAndMerge(options = {}) {
  const builtin = loadBuiltinDictionary();
  const community = loadCommunityDictionary(options);
  const custom = loadCustomDictionary(options);

  const uiRes = mergeScopeMap(
    builtin.ui,
    community.ui,
    custom.ui,
    community.disabled.ui,
    custom.disabled.ui
  );
  const menuRes = mergeScopeMap(
    builtin.menu,
    community.menu,
    custom.menu,
    community.disabled.menu,
    custom.disabled.menu
  );
  const patterns = mergePatterns(builtin.patterns, community.patterns, custom.patterns);
  const stats = computeStats(
    builtin,
    community,
    custom,
    uiRes.merged,
    menuRes.merged,
    patterns,
    uiRes.disabledCount + menuRes.disabledCount
  );

  return {
    builtin,
    community,
    custom,
    merged: {
      ui: uiRes.merged,
      menu: menuRes.merged,
      patterns,
      stats,
    },
  };
}

/**
 * Merge 3 dictionary layers (custom > community > builtin) respecting disabled flags.
 */
export function getMergedDictionary(options = {}) {
  return loadAllLayersAndMerge(options).merged;
}

/**
 * Compile merged dictionary + config.i18n into <dataDir>/i18n/runtime-bundle.json atomically.
 */
export function compileRuntimeBundle(options = {}) {
  const paths = getDataPaths(options);
  const { merged } = loadAllLayersAndMerge(options);
  const cfg = loadConfig(options);
  const i18nCfg = cfg.i18n || {};

  const bundle = {
    version: 1,
    compiledAt: new Date().toISOString(),
    config: {
      brandMode: i18nCfg.brandMode || 'original',
      customBrandText: i18nCfg.customBrandText || 'Antigravity',
      menuLocalizationEnabled: i18nCfg.menuLocalizationEnabled !== false,
      immunity: i18nCfg.immunity || {},
    },
    ui: merged.ui,
    menu: merged.menu,
    patterns: merged.patterns,
    stats: merged.stats,
  };

  ensureDir(paths.i18nDir);
  atomicWriteJson(paths.i18nBundleFile, bundle);

  return {
    bundlePath: paths.i18nBundleFile,
    bundle,
    stats: merged.stats,
  };
}

/**
 * List dictionary entries across all 3 layers with filtering and pagination.
 */
export function listDictionaryEntries(
  { query = '', source = 'all', scope = 'all', page = 1, pageSize = 50 } = {},
  options = {}
) {
  const { builtin, community, custom, merged } = loadAllLayersAndMerge(options);
  const targetScopes = scope === 'all' ? ['ui', 'menu'] : [assertValidScope(scope)];
  const needle = String(query || '').trim().toLowerCase();

  const items = [];
  for (const sc of targetScopes) {
    const bMap = builtin[sc];
    const mMap = community[sc];
    const cMap = custom[sc];
    const mDisabled = new Set(community.disabled[sc]);
    const cDisabled = new Set(custom.disabled[sc]);

    const keys = new Set([
      ...Object.keys(bMap),
      ...Object.keys(mMap),
      ...Object.keys(cMap),
      ...mDisabled,
      ...cDisabled,
    ]);

    for (const en of keys) {
      const hasBuiltin = Object.hasOwn(bMap, en);
      const hasCommunity = Object.hasOwn(mMap, en);
      const hasCustom = Object.hasOwn(cMap, en);
      const isCustomDisabled = cDisabled.has(en);
      const isCommunityDisabled = mDisabled.has(en);
      const disabled = isCustomDisabled || (!hasCustom && isCommunityDisabled);

      let effectiveSource = 'builtin';
      if (hasCustom || isCustomDisabled) {
        effectiveSource = 'custom';
      } else if (hasCommunity || isCommunityDisabled) {
        effectiveSource = 'community';
      }

      const zh = cMap[en] ?? mMap[en] ?? bMap[en] ?? '';

      if (source === 'custom' && !hasCustom && !isCustomDisabled) continue;
      if (source === 'community' && !hasCommunity && !isCommunityDisabled) continue;
      if (source === 'builtin' && !hasBuiltin) continue;
      if (source === 'disabled' && !disabled) continue;

      if (needle && !en.toLowerCase().includes(needle) && !zh.toLowerCase().includes(needle)) {
        continue;
      }

      items.push({
        en,
        zh,
        scope: sc,
        source: effectiveSource,
        disabled,
        builtinZh: hasBuiltin ? bMap[en] : null,
        communityZh: hasCommunity ? mMap[en] : null,
        customZh: hasCustom ? cMap[en] : null,
      });
    }
  }

  items.sort((a, b) => a.scope.localeCompare(b.scope) || a.en.localeCompare(b.en));

  const safePageSize = Math.max(1, Math.min(500, Number(pageSize) || 50));
  const total = items.length;
  const maxPage = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.max(1, Math.min(maxPage, Number(page) || 1));
  const start = (safePage - 1) * safePageSize;

  return {
    items: items.slice(start, start + safePageSize),
    total,
    page: safePage,
    pageSize: safePageSize,
    stats: merged.stats,
  };
}

/**
 * Add or update a custom dictionary entry or disabled flag, then recompile bundle.
 */
export function upsertCustomEntry({ en, zh, scope = 'ui', disabled = false }, options = {}) {
  if (typeof en !== 'string' || !en.length) {
    throw new Error('Entry key "en" must be a non-empty string.');
  }
  const sc = assertValidScope(scope);
  if (!disabled && typeof zh !== 'string') {
    throw new Error('Entry translation "zh" must be a string.');
  }

  const custom = loadCustomDictionary(options);
  if (typeof zh === 'string' && zh.length > 0) {
    custom[sc][en] = zh;
  }
  custom.disabled[sc] = custom.disabled[sc].filter((k) => k !== en);
  if (disabled) {
    custom.disabled[sc].push(en);
  }

  saveCustomDictionary(custom, options);
  const { bundlePath, stats } = compileRuntimeBundle(options);

  return {
    entry: {
      en,
      zh: custom[sc][en] ?? null,
      scope: sc,
      disabled: Boolean(disabled),
    },
    stats,
    bundlePath,
  };
}

/**
 * Remove a custom dictionary entry or disabled flag, then recompile bundle.
 */
export function deleteCustomEntry({ en, scope = 'ui' }, options = {}) {
  if (typeof en !== 'string' || !en.length) {
    throw new Error('Entry key "en" must be a non-empty string.');
  }
  const sc = assertValidScope(scope);
  const custom = loadCustomDictionary(options);

  const existed = Object.hasOwn(custom[sc], en) || custom.disabled[sc].includes(en);
  delete custom[sc][en];
  custom.disabled[sc] = custom.disabled[sc].filter((k) => k !== en);

  saveCustomDictionary(custom, options);
  const { bundlePath, stats } = compileRuntimeBundle(options);

  return {
    deleted: existed,
    stats,
    bundlePath,
  };
}

function collectNestedStrings(obj, targetMap) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (k.length > 0) targetMap[k] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      collectNestedStrings(v, targetMap);
    }
  }
}

function parseImportedDictionary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Imported dictionary JSON must be a JSON object.');
  }

  const ui = {};
  const menu = {};
  let patterns = [];
  const disabled = { ui: [], menu: [] };

  const hasGrouped =
    (raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui)) ||
    (raw.menu && typeof raw.menu === 'object' && !Array.isArray(raw.menu)) ||
    Array.isArray(raw.patterns);

  if (hasGrouped) {
    Object.assign(ui, normalizeStringMap(raw.ui));
    Object.assign(menu, normalizeStringMap(raw.menu));
    patterns = normalizePatternList(raw.patterns);
    if (raw.disabled && typeof raw.disabled === 'object') {
      disabled.ui = normalizeDisabledList(raw.disabled.ui);
      disabled.menu = normalizeDisabledList(raw.disabled.menu);
    }
    // Also collect any extra nested section objects (e.g. community packs with ui + sidebar)
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'ui' || k === 'menu' || k === 'patterns' || k === 'disabled' || k === 'glossary') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        collectNestedStrings(v, ui);
      }
    }
    return { ui, menu, patterns, disabled };
  }

  // Flat { en: zh } or nested section maps { sidebar: { ... }, menus: { ... } }
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      if (!META_KEYS.has(k) && k.length > 0) {
        ui[k] = v;
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const lower = k.toLowerCase();
      if (lower === 'menu' || lower === 'menus') {
        collectNestedStrings(v, menu);
      } else {
        collectNestedStrings(v, ui);
      }
    }
  }

  return { ui, menu, patterns, disabled };
}

/**
 * Import JSON dictionary into community or custom layer (supports flat, grouped, or nested formats).
 */
export function importDictionary(
  { rawJson, target = 'community', mergeMode = 'merge', sourceMeta = null } = {},
  options = {}
) {
  if (target !== 'community' && target !== 'custom') {
    throw new Error(`Invalid import target "${target}". Expected "community" or "custom".`);
  }
  if (mergeMode !== 'merge' && mergeMode !== 'replace') {
    throw new Error(`Invalid mergeMode "${mergeMode}". Expected "merge" or "replace".`);
  }

  let parsed = rawJson;
  if (typeof rawJson === 'string') {
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`Invalid JSON payload: ${err.message}`);
    }
  }

  const extracted = parseImportedDictionary(parsed);
  const isCommunity = target === 'community';
  const current =
    mergeMode === 'merge'
      ? isCommunity
        ? loadCommunityDictionary(options)
        : loadCustomDictionary(options)
      : createEmptyLayerDict(isCommunity ? { sourceUrl: '', syncedAt: null } : {});

  const next = {
    ...current,
    ui: { ...current.ui, ...extracted.ui },
    menu: { ...current.menu, ...extracted.menu },
    patterns: mergePatterns(current.patterns, extracted.patterns, []),
    disabled: {
      ui: normalizeDisabledList([...current.disabled.ui, ...extracted.disabled.ui]),
      menu: normalizeDisabledList([...current.disabled.menu, ...extracted.disabled.menu]),
    },
  };

  if (isCommunity && sourceMeta) {
    if (typeof sourceMeta.sourceUrl === 'string') next.sourceUrl = sourceMeta.sourceUrl;
    if (typeof sourceMeta.syncedAt === 'string') next.syncedAt = sourceMeta.syncedAt;
  }

  if (isCommunity) {
    saveCommunityDictionary(next, options);
  } else {
    saveCustomDictionary(next, options);
  }

  const { bundlePath, stats } = compileRuntimeBundle(options);
  const importedCount = Object.keys(extracted.ui).length + Object.keys(extracted.menu).length;

  return {
    importedCount,
    patternCount: extracted.patterns.length,
    target,
    mergeMode,
    stats,
    bundlePath,
  };
}

/**
 * Export dictionary entries for backup or sharing.
 */
export function exportDictionary({ scope = 'all' } = {}, options = {}) {
  const exportedAt = new Date().toISOString();
  if (scope === 'custom') {
    return { exportedAt, scope, ...loadCustomDictionary(options) };
  }
  if (scope === 'community') {
    return { exportedAt, scope, ...loadCommunityDictionary(options) };
  }

  const merged = getMergedDictionary(options);
  if (scope === 'ui') {
    return { version: 1, exportedAt, scope, ui: merged.ui };
  }
  if (scope === 'menu') {
    return { version: 1, exportedAt, scope, menu: merged.menu };
  }
  if (scope !== 'all') {
    throw new Error(`Invalid export scope "${scope}".`);
  }

  return {
    version: 1,
    exportedAt,
    scope: 'all',
    ui: merged.ui,
    menu: merged.menu,
    patterns: merged.patterns,
    stats: merged.stats,
  };
}

async function readResponseTextWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Community dictionary exceeds 5 MiB limit (${contentLength} bytes).`);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Community dictionary exceeds 5 MiB limit (${buf.byteLength} bytes).`);
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Community dictionary exceeds 5 MiB limit (> ${maxBytes} bytes).`);
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

/**
 * Fetch and import a community dictionary from an HTTPS URL (<= 5 MiB, 10s timeout).
 */
export async function syncCommunityDictionary({ url }, options = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Community dictionary URL is required.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    throw new Error('Invalid community dictionary URL.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Community dictionary URL must use https://.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

  let text;
  try {
    const response = await fetch(parsedUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch community dictionary: HTTP ${response.status}`);
    }
    text = await readResponseTextWithLimit(response, MAX_COMMUNITY_BYTES);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Community dictionary sync timed out after 10 seconds.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const syncedAt = new Date().toISOString();
  const res = importDictionary(
    {
      rawJson: text,
      target: 'community',
      mergeMode: 'replace',
      sourceMeta: { sourceUrl: parsedUrl.toString(), syncedAt },
    },
    options
  );

  return {
    url: parsedUrl.toString(),
    syncedAt,
    ...res,
  };
}
