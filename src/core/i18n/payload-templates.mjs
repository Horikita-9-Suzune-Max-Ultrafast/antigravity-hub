function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeJsValue(value) {
  return JSON.stringify(value ?? null)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\/script/gi, '<\\/script');
}

/**
 * Strip all idempotent marker blocks matching markerName from sourceText.
 */
export function stripMarkerBlock(sourceText, markerName) {
  const src = String(sourceText ?? '');
  const safeName = escapeRegExp(String(markerName || 'default'));
  const re = new RegExp(
    `\\/\\* AGY_CONSOLE_I18N_START:${safeName} \\*\\/[\\s\\S]*?\\/\\* AGY_CONSOLE_I18N_END:${safeName} \\*\\/(?:\\r?\\n)?`,
    'g'
  );
  return src.replace(re, '');
}

/**
 * Idempotently inject a marker-delimited snippet into sourceText.
 * Preserves leading shebang (#!) and "use strict"; directives so JS semantics remain intact.
 */
export function injectMarkerBlock(sourceText, markerName, snippet) {
  const name = String(markerName || 'default');
  const cleaned = stripMarkerBlock(sourceText, name);
  const block = [
    `/* AGY_CONSOLE_I18N_START:${name} */`,
    String(snippet ?? '').trim(),
    `/* AGY_CONSOLE_I18N_END:${name} */`,
    '',
  ].join('\n');

  // Preserve leading shebang and/or "use strict"; directive
  const headerRe = /^(?:#![^\r\n]*\r?\n)?(?:\s*['"]use strict['"];?\r?\n)?/;
  const match = headerRe.exec(cleaned);
  const prefix = match ? match[0] : '';
  const rest = cleaned.slice(prefix.length);
  return prefix + block + rest;
}

/**
 * Build fail-open loader snippet injected into dist/preload.js.
 */
export function buildPreloadLoaderSnippet() {
  return [
    'try {',
    "  if (typeof require === 'function') {",
    "    require('./agy-console-i18n-runtime.js');",
    '  } else {',
    "    import('./agy-console-i18n-runtime.js').catch(function () {});",
    '  }',
    '} catch (_) {}',
  ].join('\n');
}

/**
 * Build fail-open loader snippet injected into dist/main.js.
 */
export function buildMainLoaderSnippet() {
  return [
    'try {',
    "  if (typeof require === 'function') {",
    "    require('./agy-console-i18n-main.js');",
    '  } else {',
    "    import('./agy-console-i18n-main.js').catch(function () {});",
    '  }',
    '} catch (_) {}',
  ].join('\n');
}

/**
 * Build self-contained fail-open renderer runtime JS (dist/agy-console-i18n-runtime.js).
 * - Live-loads runtime-bundle.json via Node fs when available in preload, falling back to embedded snapshot.
 * - Uses MutationObserver + microtask batch + WeakSet + O(1) Map exact/trimmed lookup + regex patterns.
 * - Translates text nodes and placeholder / title / aria-label / data-tooltip attributes.
 * - Enforces physical immunity (codeBlocks, inputs, terminal, filePaths, customSelectors) and brandMode.
 */
export function buildRendererRuntimeSource(bundleSnapshot, bundleFilePath = '') {
  const snapshotJson = serializeJsValue(
    bundleSnapshot || {
      version: 1,
      config: {
        brandMode: 'original',
        customBrandText: 'Antigravity',
        menuLocalizationEnabled: true,
        immunity: {
          codeBlocks: true,
          inputs: true,
          terminal: true,
          filePaths: true,
          customSelectors: [],
        },
      },
      ui: {},
      menu: {},
      patterns: [],
    }
  );
  const bundlePathJson = serializeJsValue(String(bundleFilePath || ''));

  return `/* Antigravity Hub i18n Renderer Runtime (auto-generated, fail-open) */
(function () {
  'use strict';
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__AGY_CONSOLE_I18N_RENDERER_LOADED__) {
      return;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_CONSOLE_I18N_RENDERER_LOADED__ = true;
    }

    var BUNDLE_FILE_PATH = ${bundlePathJson};
    var FALLBACK_BUNDLE = ${snapshotJson};
    var TARGET_ATTRS = ['placeholder', 'title', 'aria-label', 'data-tooltip'];
    var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var ASCII_LETTER_RE = /[A-Za-z]/;
    var FILE_PATH_OR_URL_RE = /^(?:[a-zA-Z]:[\\\\/]|\\\\\\\\|\\/[^\\s/]+\\/|\\.{1,2}[\\\\/]|(?:https?|file|wss?|ftp|mailto|vscode|antigravity):\\/\\/|mailto:|~\\/|[\\w.-]+(?:\\/[\\w.-]+){2,}|[\\w.-]+\\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|rs|go|java|cpp|c|h|css|scss|html|yml|yaml|toml|sh|ps1|exe|asar|bak|log|txt|lock)$)/i;

    var nodeFs = null;
    try {
      if (typeof require === 'function') {
        nodeFs = require('fs');
      }
    } catch (_) {
      nodeFs = null;
    }

    var state = {
      exactMap: new Map(),
      patterns: [],
      brandMode: 'original',
      customBrandText: 'Antigravity',
      immunity: {
        codeBlocks: true,
        inputs: true,
        terminal: true,
        filePaths: true,
        customSelectors: [],
      },
      textImmuneSelector: '',
      attrImmuneSelector: '',
      processedTextNodes: new WeakSet(),
      processedAttrNodes: new WeakSet(),
      lastMtimeMs: 0,
    };

    function readLiveBundle() {
      if (nodeFs && BUNDLE_FILE_PATH) {
        try {
          if (nodeFs.existsSync(BUNDLE_FILE_PATH)) {
            var stat = nodeFs.statSync(BUNDLE_FILE_PATH);
            var raw = nodeFs.readFileSync(BUNDLE_FILE_PATH, 'utf8');
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              state.lastMtimeMs = stat.mtimeMs || 0;
              return parsed;
            }
          }
        } catch (_) {
          // Fall back silently to embedded snapshot
        }
      }
      return FALLBACK_BUNDLE;
    }

    function filterValidSelectors(list) {
      if (typeof document === 'undefined' || !document.createElement) return list;
      var probe = document.createElement('div');
      var valid = [];
      for (var i = 0; i < list.length; i++) {
        var sel = String(list[i] || '').trim();
        if (!sel) continue;
        try {
          probe.matches(sel);
          valid.push(sel);
        } catch (_) {
          // Ignore malformed custom CSS selector
        }
      }
      return valid;
    }

    function compileBundle(bundle) {
      var cfg = (bundle && bundle.config) || {};
      var imm = cfg.immunity || (bundle && bundle.immunity) || {};
      var exact = new Map();
      var ui = (bundle && bundle.ui) || {};
      var keys = Object.keys(ui);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = ui[k];
        if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
          exact.set(k, v);
        }
      }

      var compiledPatterns = [];
      var rawPatterns = Array.isArray(bundle && bundle.patterns) ? bundle.patterns : [];
      for (var j = 0; j < rawPatterns.length; j++) {
        var p = rawPatterns[j];
        if (!p || typeof p.regex !== 'string' || typeof p.replace !== 'string') continue;
        try {
          compiledPatterns.push({
            re: new RegExp(p.regex, typeof p.flags === 'string' ? p.flags : ''),
            replace: p.replace,
          });
        } catch (_) {
          // Ignore invalid regex pattern
        }
      }

      var brandMode = cfg.brandMode || (bundle && bundle.brandMode) || 'original';
      var customBrandText =
        typeof (cfg.customBrandText || (bundle && bundle.customBrandText)) === 'string'
          ? String(cfg.customBrandText || (bundle && bundle.customBrandText)).trim() || 'Antigravity'
          : 'Antigravity';

      var codeBlocks = imm.codeBlocks === undefined ? true : Boolean(imm.codeBlocks);
      var inputs = imm.inputs === undefined ? true : Boolean(imm.inputs);
      var terminal = imm.terminal === undefined ? true : Boolean(imm.terminal);
      var filePaths = imm.filePaths === undefined ? true : Boolean(imm.filePaths);
      var customSelectors = Array.isArray(imm.customSelectors) ? imm.customSelectors : [];

      var sharedSelectors = [];
      if (codeBlocks) sharedSelectors.push('.monaco-editor', 'pre', 'code', '.cm-editor');
      if (terminal) sharedSelectors.push('.xterm', '.terminal');
      for (var c = 0; c < customSelectors.length; c++) {
        if (typeof customSelectors[c] === 'string' && customSelectors[c].trim()) {
          sharedSelectors.push(customSelectors[c].trim());
        }
      }

      var textSelectors = sharedSelectors.slice();
      if (inputs) {
        textSelectors.push('input', 'textarea', '[contenteditable="true"]', '[contenteditable=""]');
      }

      state.exactMap = exact;
      state.patterns = compiledPatterns;
      state.brandMode = brandMode;
      state.customBrandText = customBrandText;
      state.immunity = {
        codeBlocks: codeBlocks,
        inputs: inputs,
        terminal: terminal,
        filePaths: filePaths,
        customSelectors: customSelectors,
      };
      state.textImmuneSelector = filterValidSelectors(textSelectors).join(', ');
      state.attrImmuneSelector = filterValidSelectors(sharedSelectors).join(', ');
      state.processedTextNodes = new WeakSet();
      state.processedAttrNodes = new WeakSet();
    }

    function applyBrandMode(text) {
      if (typeof text !== 'string' || !text) return text;
      var mode = state.brandMode;
      if (mode === 'original') return text;
      if (mode === 'zh') {
        if (text === 'Antigravity') return '反重力';
        if (text === 'Google Antigravity') return 'Google 反重力';
        if (text.indexOf('Antigravity') !== -1) {
          return text.replace(/\\bAntigravity\\b/g, '反重力');
        }
        return text;
      }
      if (mode === 'custom') {
        if (text === 'Antigravity') return state.customBrandText;
        if (text.indexOf('Antigravity') !== -1) {
          return text.replace(/\\bAntigravity\\b/g, state.customBrandText);
        }
        return text;
      }
      if (mode === 'hidden') {
        if (text === 'Antigravity' || text === 'Google Antigravity') return '';
        return text;
      }
      return text;
    }

    function isProtectedLiteral(trimmed) {
      if (!trimmed) return true;
      if (state.immunity.filePaths && FILE_PATH_OR_URL_RE.test(trimmed)) {
        return true;
      }
      return false;
    }

    function translateString(raw) {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null;
      if (!ASCII_LETTER_RE.test(raw)) return null;

      var trimmed = raw.trim();
      if (!trimmed) return null;
      if (isProtectedLiteral(trimmed)) return null;

      // Handle exact brand token according to brandMode first
      if (trimmed === 'Antigravity' || trimmed === 'Google Antigravity') {
        var branded = applyBrandMode(trimmed);
        if (branded === trimmed) return null;
        return preserveWhitespace(raw, trimmed, branded);
      }

      // 1. O(1) exact lookup
      if (state.exactMap.has(raw)) {
        var hit = applyBrandMode(state.exactMap.get(raw));
        return hit === raw ? null : hit;
      }

      // 2. O(1) trimmed lookup preserving surrounding whitespace
      if (trimmed !== raw && state.exactMap.has(trimmed)) {
        var trimmedHit = applyBrandMode(state.exactMap.get(trimmed));
        var restored = preserveWhitespace(raw, trimmed, trimmedHit);
        return restored === raw ? null : restored;
      }

      // 3. Configured regex patterns (never blind substring replacement)
      for (var i = 0; i < state.patterns.length; i++) {
        var pat = state.patterns[i];
        if (pat.re.test(trimmed)) {
          var replaced = applyBrandMode(trimmed.replace(pat.re, pat.replace));
          if (replaced !== trimmed) {
            var withWs = preserveWhitespace(raw, trimmed, replaced);
            return withWs === raw ? null : withWs;
          }
        }
      }

      return null;
    }

    function preserveWhitespace(raw, trimmed, translated) {
      if (raw === trimmed) return translated;
      var startIdx = raw.indexOf(trimmed);
      if (startIdx < 0) return translated;
      var lead = raw.slice(0, startIdx);
      var tail = raw.slice(startIdx + trimmed.length);
      return lead + translated + tail;
    }

    function isImmuneForText(el) {
      if (!el || el.nodeType !== 1) return false;
      if (SKIP_TAGS[el.tagName]) return true;
      if (state.textImmuneSelector) {
        try {
          if (el.closest(state.textImmuneSelector)) return true;
        } catch (_) {
          // ignore selector error
        }
      }
      return false;
    }

    function isImmuneForAttr(el, attrName) {
      if (!el || el.nodeType !== 1) return false;
      if (SKIP_TAGS[el.tagName]) return true;
      if (state.attrImmuneSelector) {
        try {
          if (el.closest(state.attrImmuneSelector)) return true;
        } catch (_) {
          // ignore selector error
        }
      }
      if (state.immunity.inputs && attrName !== 'placeholder') {
        try {
          if (el.closest('[contenteditable="true"], [contenteditable=""]')) return true;
        } catch (_) {
          // ignore
        }
      }
      return false;
    }

    function processTextNode(textNode) {
      if (!textNode || textNode.nodeType !== 3) return;
      if (state.processedTextNodes.has(textNode)) return;
      var parent = textNode.parentElement;
      if (!parent || isImmuneForText(parent)) return;

      var val = textNode.nodeValue;
      var translated = translateString(val);
      if (translated !== null && translated !== val) {
        textNode.nodeValue = translated;
      }
      state.processedTextNodes.add(textNode);
    }

    function processElementAttrs(el) {
      if (!el || el.nodeType !== 1) return;
      if (SKIP_TAGS[el.tagName]) return;
      for (var i = 0; i < TARGET_ATTRS.length; i++) {
        var attr = TARGET_ATTRS[i];
        if (!el.hasAttribute(attr)) continue;
        if (isImmuneForAttr(el, attr)) continue;
        var current = el.getAttribute(attr);
        var translated = translateString(current);
        if (translated !== null && translated !== current) {
          el.setAttribute(attr, translated);
        }
      }
      state.processedAttrNodes.add(el);
    }

    function walkSubtree(root) {
      if (!root) return;
      if (root.nodeType === 3) {
        processTextNode(root);
        return;
      }
      if (root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
      if (root.nodeType === 1) {
        if (SKIP_TAGS[root.tagName]) return;
        processElementAttrs(root);
        if (isImmuneForText(root)) return;
      }

      try {
        var walker = document.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
        var cur = walker.nextNode();
        while (cur) {
          if (cur.nodeType === 3) {
            processTextNode(cur);
          } else if (cur.nodeType === 1) {
            if (!SKIP_TAGS[cur.tagName]) {
              processElementAttrs(cur);
            }
          }
          cur = walker.nextNode();
        }
      } catch (_) {
        // Ignore TreeWalker errors on detached fragments
      }
    }

    var pendingNodes = new Set();
    var flushScheduled = false;
    var scheduleMicrotask =
      typeof queueMicrotask === 'function'
        ? queueMicrotask
        : function (fn) {
            Promise.resolve().then(fn);
          };

    function enqueueNode(node) {
      if (!node) return;
      pendingNodes.add(node);
      if (!flushScheduled) {
        flushScheduled = true;
        scheduleMicrotask(flushPending);
      }
    }

    function flushPending() {
      flushScheduled = false;
      if (pendingNodes.size === 0) return;
      var batch = Array.from(pendingNodes);
      pendingNodes.clear();
      for (var i = 0; i < batch.length; i++) {
        var node = batch[i];
        if (!node || !node.isConnected) continue;
        if (node.nodeType === 3) {
          state.processedTextNodes.delete(node);
          processTextNode(node);
        } else if (node.nodeType === 1) {
          walkSubtree(node);
        }
      }
      if (typeof document !== 'undefined' && document.title) {
        var nextTitle = translateString(document.title);
        if (nextTitle !== null && nextTitle !== document.title) {
          document.title = nextTitle;
        }
      }
    }

    function startObserver() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
      var root = document.documentElement || document.body;
      if (!root) return;

      compileBundle(readLiveBundle());
      walkSubtree(root);

      var observer = new MutationObserver(function (mutations) {
        try {
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === 'characterData') {
              state.processedTextNodes.delete(m.target);
              enqueueNode(m.target);
            } else if (m.type === 'attributes') {
              state.processedAttrNodes.delete(m.target);
              processElementAttrs(m.target);
            } else if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) {
              for (var j = 0; j < m.addedNodes.length; j++) {
                enqueueNode(m.addedNodes[j]);
              }
            }
          }
        } catch (_) {
          // Never throw inside MutationObserver
        }
      });

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TARGET_ATTRS,
      });

      // Live hot-reload watcher for runtime-bundle.json when Node fs is available in preload
      if (nodeFs && BUNDLE_FILE_PATH && typeof nodeFs.watch === 'function') {
        var reloadTimer = null;
        try {
          var pathMod = require('path');
          var dir = pathMod.dirname(BUNDLE_FILE_PATH);
          var base = pathMod.basename(BUNDLE_FILE_PATH);
          if (nodeFs.existsSync(dir)) {
            var watcher = nodeFs.watch(dir, { persistent: false }, function (_evt, filename) {
              if (filename && String(filename) !== base) return;
              if (reloadTimer) clearTimeout(reloadTimer);
              reloadTimer = setTimeout(function () {
                try {
                  if (!nodeFs.existsSync(BUNDLE_FILE_PATH)) return;
                  var st = nodeFs.statSync(BUNDLE_FILE_PATH);
                  if (st.mtimeMs === state.lastMtimeMs) return;
                  compileBundle(readLiveBundle());
                  if (document.documentElement) {
                    walkSubtree(document.documentElement);
                  }
                } catch (_) {
                  // ignore hot-reload errors
                }
              }, 250);
            });
            if (watcher && typeof watcher.unref === 'function') watcher.unref();
          }
        } catch (_) {
          // ignore watcher setup failure
        }
      }
    }

    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      } else {
        startObserver();
      }
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('DOMContentLoaded', startObserver, { once: true });
    }
  } catch (_) {
    // Fail-open guarantee: never break Antigravity renderer or preload
  }
})();
`;
}

/**
 * Build fail-open Electron main-process runtime JS (dist/agy-console-i18n-main.js).
 * Wraps electron.Menu.buildFromTemplate to recursively localize menu labels when enabled.
 */
export function buildMainRuntimeSource(bundleSnapshot, bundleFilePath = '') {
  const snapshotJson = serializeJsValue(
    bundleSnapshot || {
      version: 1,
      config: {
        brandMode: 'original',
        customBrandText: 'Antigravity',
        menuLocalizationEnabled: true,
      },
      menu: {},
      ui: {},
    }
  );
  const bundlePathJson = serializeJsValue(String(bundleFilePath || ''));

  return `/* Antigravity Hub i18n Main Runtime (auto-generated, fail-open) */
(function () {
  'use strict';
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__) {
      return;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_CONSOLE_I18N_MAIN_LOADED__ = true;
    }

    var BUNDLE_FILE_PATH = ${bundlePathJson};
    var FALLBACK_BUNDLE = ${snapshotJson};
    var fs = null;
    try {
      fs = require('fs');
    } catch (_) {
      fs = null;
    }

    var cachedBundle = FALLBACK_BUNDLE;
    var cachedMtimeMs = -1;

    function getLiveBundle() {
      if (fs && BUNDLE_FILE_PATH) {
        try {
          if (fs.existsSync(BUNDLE_FILE_PATH)) {
            var stat = fs.statSync(BUNDLE_FILE_PATH);
            if (stat.mtimeMs !== cachedMtimeMs) {
              var parsed = JSON.parse(fs.readFileSync(BUNDLE_FILE_PATH, 'utf8'));
              if (parsed && typeof parsed === 'object') {
                cachedBundle = parsed;
                cachedMtimeMs = stat.mtimeMs;
              }
            }
          }
        } catch (_) {
          // Keep previous valid bundle or fallback
        }
      }
      return cachedBundle || FALLBACK_BUNDLE;
    }

    function applyBrandMode(text, cfg) {
      if (typeof text !== 'string' || !text) return text;
      var mode = (cfg && cfg.brandMode) || 'original';
      if (mode === 'original') return text;
      if (mode === 'zh') return text.replace(/\\bAntigravity\\b/g, '反重力');
      if (mode === 'custom') {
        var custom = (cfg && typeof cfg.customBrandText === 'string' && cfg.customBrandText.trim()) || 'Antigravity';
        return text.replace(/\\bAntigravity\\b/g, custom);
      }
      if (mode === 'hidden') return text.replace(/\\s*\\bAntigravity\\b\\s*/g, ' ').trim();
      return text;
    }

    function translateMenuLabel(raw, bundle) {
      if (typeof raw !== 'string' || !raw) return raw;
      var menuMap = (bundle && bundle.menu) || {};
      var uiMap = (bundle && bundle.ui) || {};
      var cfg = (bundle && bundle.config) || {};

      // Exact match first (including mnemonics if explicitly mapped)
      if (Object.prototype.hasOwnProperty.call(menuMap, raw)) {
        return applyBrandMode(menuMap[raw], cfg);
      }

      // Handle Electron accelerator mnemonics like "&File" or "E&xit"
      var accelMatch = raw.match(/&([A-Za-z0-9])/);
      var stripped = raw.replace(/&([A-Za-z0-9])/g, '$1').trim();
      var hit = null;
      if (Object.prototype.hasOwnProperty.call(menuMap, stripped)) {
        hit = menuMap[stripped];
      } else if (Object.prototype.hasOwnProperty.call(uiMap, stripped)) {
        hit = uiMap[stripped];
      }

      if (typeof hit === 'string' && hit.length > 0) {
        var localized = applyBrandMode(hit, cfg);
        if (accelMatch && localized.indexOf('&') === -1) {
          return localized + '(&' + accelMatch[1].toUpperCase() + ')';
        }
        return localized;
      }

      return applyBrandMode(raw, cfg);
    }

    function localizeMenuItems(items, bundle) {
      if (!Array.isArray(items)) return items;
      return items.map(function (item) {
        if (!item || typeof item !== 'object') return item;
        var clone = Object.assign({}, item);
        if (typeof clone.label === 'string') {
          clone.label = translateMenuLabel(clone.label, bundle);
        }
        if (typeof clone.sublabel === 'string') {
          clone.sublabel = translateMenuLabel(clone.sublabel, bundle);
        }
        if (typeof clone.toolTip === 'string') {
          clone.toolTip = translateMenuLabel(clone.toolTip, bundle);
        }
        if (Array.isArray(clone.submenu)) {
          clone.submenu = localizeMenuItems(clone.submenu, bundle);
        }
        return clone;
      });
    }

    var electron = null;
    try {
      electron = require('electron');
    } catch (_) {
      electron = null;
    }

    if (electron && electron.Menu && typeof electron.Menu.buildFromTemplate === 'function') {
      var origBuildFromTemplate = electron.Menu.buildFromTemplate.bind(electron.Menu);
      electron.Menu.buildFromTemplate = function (template) {
        try {
          var bundle = getLiveBundle();
          var cfg = (bundle && bundle.config) || {};
          if (cfg.menuLocalizationEnabled === false) {
            return origBuildFromTemplate(template);
          }
          var localized = localizeMenuItems(template, bundle);
          return origBuildFromTemplate(localized);
        } catch (_) {
          return origBuildFromTemplate(template);
        }
      };
    }
  } catch (_) {
    // Fail-open guarantee: never crash Electron main process
  }
})();
`;
}
