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
export function buildRendererRuntimeSource(bundleSnapshot, bundleFilePath = '', appearanceFilePath = '') {
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
  const appearancePathJson = serializeJsValue(String(appearanceFilePath || ''));

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

      state.config = cfg;
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

    var MODEL_NAME_RE = /\\b(Gemini|Claude|GPT|Opus|Sonnet|Haiku|Neon|Hydrogen|DeepSeek|Llama)\\b/i;
    var TIER_WORD_RE = /^(High|Medium|Low|Fast|Pro|Flash|Max|Mini)$/i;
    var UNTRANS_SKIP_RE = /(https?:\\/\\/|@|[A-Za-z]:\\\\|^\\/|^\\.|\\bsk-|\\bBearer\\b|\\bghp_|\\bAIza|[{}<>\\[\\]=;]|^\\d[\\d.,:%\\s/-]*$)/;
    var pendingUntrans = [];
    var seenUntrans = new Set();
    var flushUntransTimer = null;

    function flushUntranslated() {
      flushUntransTimer = null;
      if (!pendingUntrans.length) return;
      var batch = pendingUntrans.splice(0, 60);
      try {
        var ipcR = typeof require === 'function' ? require('electron').ipcRenderer : null;
        if (ipcR && typeof ipcR.invoke === 'function') {
          ipcR.invoke('agy-hub:record-untranslated', batch).catch(function () {});
        }
      } catch (_) {}
    }

    function maybeCollectUntranslated(rawVal, parentEl) {
      try {
        if (!state.config || state.config.collectUntranslated !== true) return;
        if (!rawVal || typeof rawVal !== 'string') return;
        var t = rawVal.trim();
        if (t.length < 2 || t.length > 140) return;
        if (!/[A-Za-z]{2,}/.test(t) || /[\\u4e00-\\u9fa5]/.test(t)) return;
        if (UNTRANS_SKIP_RE.test(t)) return;
        if (seenUntrans.has(t) || seenUntrans.size >= 500) return;
        if (parentEl && typeof parentEl.closest === 'function') {
          if (parentEl.closest('[data-message-id], .prose, .markdown-body, article')) return;
        }
        seenUntrans.add(t);
        pendingUntrans.push(t);
        if (!flushUntransTimer) {
          flushUntransTimer = setTimeout(flushUntranslated, 2000);
        }
      } catch (_) {}
    }

    function processTextNode(textNode) {
      if (!textNode || textNode.nodeType !== 3) return;
      if (state.processedTextNodes.has(textNode)) return;
      var parent = textNode.parentElement;
      if (!parent || isImmuneForText(parent)) return;

      var val = textNode.nodeValue;
      var trimmedVal = typeof val === 'string' ? val.trim() : '';
      // Protect model tier labels inside model selector chips (e.g. "Gemini 4 Neon High")
      if (trimmedVal && TIER_WORD_RE.test(trimmedVal)) {
        var ctxText = (parent.parentElement && parent.parentElement.textContent) || parent.textContent || '';
        if (MODEL_NAME_RE.test(ctxText)) {
          state.processedTextNodes.add(textNode);
          return;
        }
      }

      var translated = translateString(val);
      if (translated !== null && translated !== val) {
        textNode.nodeValue = translated;
      } else if (translated === null) {
        maybeCollectUntranslated(val, parent);
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
      } else {
        // Electron sandbox:true preload fallback: pull live dictionary updates via main-process IPC
        var ipcRend = null;
        try {
          ipcRend = typeof require === 'function' ? require('electron').ipcRenderer : null;
        } catch (_) {
          ipcRend = null;
        }
        if (ipcRend && typeof ipcRend.invoke === 'function') {
          var syncBundleFromMain = function () {
            try {
              ipcRend.invoke('agy-hub:get-i18n-bundle', state.lastMtimeMs).then(function (res) {
                if (!res || !res.changed || !res.bundle) return;
                state.lastMtimeMs = res.mtimeMs || Date.now();
                compileBundle(res.bundle);
                if (document.documentElement) walkSubtree(document.documentElement);
              }).catch(function () {});
            } catch (_) {}
          };
          syncBundleFromMain();
          var ipcTimer = setInterval(syncBundleFromMain, 3000);
          if (ipcTimer && typeof ipcTimer.unref === 'function') ipcTimer.unref();
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

/* Antigravity Hub Appearance Engine (v1.5.0, isolated fail-open, zero extra ASAR surface) */
(function () {
  'use strict';
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__AGY_HUB_APPEARANCE_LOADED__) {
      return;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.__AGY_HUB_APPEARANCE_LOADED__ = true;
    }

    var BUNDLE_PATH = ${bundlePathJson};
    var EXPLICIT_APPEARANCE_PATH = ${appearancePathJson};
    var STYLE_ID = 'agy-hub-wallpaper-style';
    var LAYER_ID = 'agy-hub-wallpaper-layer';
    var EXT_MIME = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.svg': 'image/svg+xml',
    };

    var nodeFs = null;
    var nodePath = null;
    var ipcRenderer = null;
    try {
      if (typeof require === 'function') {
        try {
          var el = require('electron');
          if (el && el.ipcRenderer && typeof el.ipcRenderer.invoke === 'function') {
            ipcRenderer = el.ipcRenderer;
          }
        } catch (_) {}
        try {
          nodeFs = require('fs');
          nodePath = require('path');
        } catch (_) {
          nodeFs = null;
          nodePath = null;
        }
      }
    } catch (_) {
      nodeFs = null;
      nodePath = null;
    }

    function resolveAppearanceFile() {
      if (EXPLICIT_APPEARANCE_PATH) return EXPLICIT_APPEARANCE_PATH;
      if (BUNDLE_PATH && nodePath) {
        return nodePath.resolve(nodePath.dirname(BUNDLE_PATH), '..', 'appearance', 'runtime-appearance.json');
      }
      return '';
    }

    var APPEARANCE_FILE = resolveAppearanceFile();
    var CROSSFADE_MS = 450;
    var st = {
      lastMtimeMs: -1,
      cfg: null,
      blobUrl: null,
      loadedImagePath: '',
      startupPickedPath: '',
      lastCfgActivePath: '',
      lastRotateAt: 0,
      lastTheme: '',
      activeSlot: 0,
      slotBlobUrls: [null, null],
      currentSourceKey: '',
      transitionSeq: 0,
      revokeTimers: [null, null],
    };

    function parseOpaqueLum(el) {
      if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
      var bg = window.getComputedStyle(el).backgroundColor || '';
      var m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/i);
      if (!m) return null;
      if (m[4] !== undefined && Number(m[4]) <= 0.05) return null;
      return Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114;
    }

    function detectDarkTheme() {
      try {
        var root = document.documentElement;
        var dt = root && root.dataset && root.dataset.theme;
        if (dt === 'dark') return true;
        if (dt === 'light') return false;
        if (root && root.classList && root.classList.contains('dark')) return true;
        if (document.body && document.body.classList && document.body.classList.contains('vscode-dark')) return true;
        var candidates = [
          document.body,
          document.getElementById('root'),
          document.getElementById('app'),
          document.body && document.body.firstElementChild,
          document.querySelector && document.querySelector('main'),
          root,
        ];
        for (var i = 0; i < candidates.length; i++) {
          var lum = parseOpaqueLum(candidates[i]);
          if (lum !== null) return lum < 140;
        }
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
      } catch (_) {}
      return false;
    }

    function safeRevokeBlobUrl(url) {
      if (!url || typeof url !== 'string' || url.indexOf('blob:') !== 0) return;
      if (url === st.blobUrl || url === st.slotBlobUrls[0] || url === st.slotBlobUrls[1]) return;
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(url);
        }
      } catch (_) {}
    }

    function cleanupWallpaper() {
      try {
        st.transitionSeq++;
        for (var t = 0; t < 2; t++) {
          if (st.revokeTimers[t]) {
            clearTimeout(st.revokeTimers[t]);
            st.revokeTimers[t] = null;
          }
        }
        var styleEl = document.getElementById(STYLE_ID);
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        var layerEl = document.getElementById(LAYER_ID);
        if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
        var urlsToRevoke = [st.blobUrl, st.slotBlobUrls[0], st.slotBlobUrls[1]];
        st.blobUrl = null;
        st.slotBlobUrls = [null, null];
        st.loadedImagePath = '';
        st.currentSourceKey = '';
        st.activeSlot = 0;
        for (var i = 0; i < urlsToRevoke.length; i++) {
          safeRevokeBlobUrl(urlsToRevoke[i]);
        }
      } catch (_) {}
    }

    function loadImageAsUrl(imgPath, maxBytes) {
      if (!imgPath || !nodeFs || !nodePath) return null;
      if (st.loadedImagePath === imgPath && st.blobUrl) return st.blobUrl;
      try {
        if (!nodeFs.existsSync(imgPath)) return null;
        var stat = nodeFs.statSync(imgPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > (maxBytes || 15728640)) return null;
        var ext = String(nodePath.extname(imgPath) || '').toLowerCase();
        var mime = EXT_MIME[ext];
        if (!mime) return null;
        var buf = nodeFs.readFileSync(imgPath);
        var nextUrl = null;
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          var blob = new Blob([buf], { type: mime });
          nextUrl = URL.createObjectURL(blob);
        } else if (stat.size <= 4 * 1024 * 1024) {
          nextUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        }
        if (nextUrl) {
          var prevUrl = st.blobUrl;
          st.blobUrl = nextUrl;
          st.loadedImagePath = imgPath;
          if (prevUrl && prevUrl !== nextUrl) {
            setTimeout(function () { safeRevokeBlobUrl(prevUrl); }, CROSSFADE_MS + 120);
          }
          return nextUrl;
        }
      } catch (_) {}
      return null;
    }

    function pickFromPool(cfg) {
      var pool = Array.isArray(cfg.poolPaths) ? cfg.poolPaths : [];
      if (!pool.length) return '';
      var others = pool.filter(function (p) { return p !== st.loadedImagePath; });
      var list = others.length ? others : pool;
      return list[Math.floor(Math.random() * list.length)] || '';
    }

    function resolveTargetImagePath(cfg, isDark) {
      var cfgActive = cfg.activeWallpaperPath || '';
      if (cfgActive && cfgActive !== st.lastCfgActivePath) {
        st.lastCfgActivePath = cfgActive;
        st.startupPickedPath = cfgActive;
        st.lastRotateAt = Date.now();
      }
      if (cfg.separateThemeWallpapers) {
        var themed = isDark ? cfg.darkWallpaperPath : cfg.lightWallpaperPath;
        if (themed) return themed;
      }
      if (cfg.rotationMode === 'startup') {
        if (!st.startupPickedPath) {
          st.startupPickedPath = pickFromPool(cfg) || cfgActive;
        }
        return st.startupPickedPath;
      }
      if (cfg.rotationMode === 'interval') {
        var ms = Math.max(1, Number(cfg.rotationMinutes) || 30) * 60000;
        if (!st.lastRotateAt || Date.now() - st.lastRotateAt >= ms) {
          st.startupPickedPath = pickFromPool(cfg) || cfgActive;
          st.lastRotateAt = Date.now();
        }
        return st.startupPickedPath || cfgActive;
      }
      return cfgActive;
    }

    function base64ToBlobUrl(b64, mime) {
      try {
        if (typeof atob === 'function' && typeof Uint8Array !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return URL.createObjectURL(new Blob([bytes], { type: mime }));
        }
      } catch (_) {}
      return 'data:' + mime + ';base64,' + b64;
    }

    function preloadAndDecode(imgUrl, onReady) {
      if (!imgUrl || typeof Image === 'undefined') {
        onReady();
        return;
      }
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        onReady();
      };
      var guard = setTimeout(finish, 2000);
      var done = function () {
        clearTimeout(guard);
        finish();
      };
      try {
        var img = new Image();
        img.decoding = 'async';
        img.onload = function () {
          if (typeof img.decode === 'function') {
            img.decode().then(done, done);
          } else {
            done();
          }
        };
        img.onerror = done;
        img.src = imgUrl;
        if (img.complete && typeof img.decode === 'function') {
          img.decode().then(done, done);
        }
      } catch (_) {
        done();
      }
    }

    function ensureLayerAndSlots() {
      var layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement('div');
        layer.id = LAYER_ID;
        layer.setAttribute('aria-hidden', 'true');
        layer.style.setProperty('position', 'fixed', 'important');
        layer.style.setProperty('top', '-16px', 'important');
        layer.style.setProperty('left', '-16px', 'important');
        layer.style.setProperty('right', '-16px', 'important');
        layer.style.setProperty('bottom', '-16px', 'important');
        layer.style.setProperty('z-index', '2147483000', 'important');
        layer.style.setProperty('pointer-events', 'none', 'important');
        layer.style.setProperty('user-select', 'none', 'important');
        layer.style.setProperty('will-change', 'opacity, filter', 'important');
        (document.documentElement || document.body).appendChild(layer);
      }
      var slots = [];
      for (var i = 0; i < 2; i++) {
        var slot = layer.querySelector('[data-wp-slot="' + i + '"]');
        if (!slot) {
          slot = document.createElement('div');
          slot.setAttribute('data-wp-slot', String(i));
          slot.style.setProperty('position', 'absolute', 'important');
          slot.style.setProperty('inset', '0', 'important');
          slot.style.setProperty('pointer-events', 'none', 'important');
          slot.style.setProperty('opacity', '0', 'important');
          slot.style.setProperty('transition', 'opacity ' + CROSSFADE_MS + 'ms ease-out', 'important');
          slot.style.setProperty('will-change', 'opacity', 'important');
          layer.appendChild(slot);
        }
        slots.push(slot);
      }
      return { layer: layer, slots: slots };
    }

    function writeSlotBg(slot, bgImage, bgSize, bgPos, bgRepeat) {
      var sig = bgImage + '|' + bgSize;
      if (slot.dataset.bgSig === sig) return;
      slot.dataset.bgSig = sig;
      slot.style.setProperty('background-image', bgImage, 'important');
      slot.style.setProperty('background-size', bgSize, 'important');
      slot.style.setProperty('background-position', bgPos, 'important');
      slot.style.setProperty('background-repeat', bgRepeat, 'important');
    }

    function applyAppearance(cfg, resolvedImgUrl, resolvedImgPath) {
      if (!cfg || cfg.enabled !== true || typeof document === 'undefined' || !document.body) {
        cleanupWallpaper();
        return;
      }

      var isDark = detectDarkTheme();
      st.lastTheme = isDark ? 'dark' : 'light';
      var opacity = Math.max(0.05, Math.min(0.85, Number(cfg.opacity) || 0.24));
      var blurPx = Math.max(0, Math.min(24, Number(cfg.blurPx) || 0));
      var rawScrim = Number(cfg.scrimOpacity);
      var scrimOpacity = Math.max(0, Math.min(0.85, Number.isFinite(rawScrim) ? rawScrim : 0.42));
      var rawSat = Number(cfg.saturation);
      var saturation = Math.max(0, Math.min(160, Number.isFinite(rawSat) ? rawSat : 100));
      var fit = cfg.fit === 'contain' ? 'contain' : cfg.fit === 'center' ? 'auto' : 'cover';

      var scrimRgb = isDark ? '0, 0, 0' : '255, 255, 255';
      var scrimLayer = scrimOpacity > 0.005 ? 'linear-gradient(rgba(' + scrimRgb + ', ' + scrimOpacity.toFixed(2) + '), rgba(' + scrimRgb + ', ' + scrimOpacity.toFixed(2) + '))' : '';

      var bgImage = '';
      var bgSize = 'cover';
      var bgPos = 'center';
      var bgRepeat = 'no-repeat';
      var imgUrl = null;
      var sourceKey = '';

      if (cfg.mode === 'image') {
        imgUrl = resolvedImgUrl || null;
        var targetImg = resolvedImgPath || '';
        if (!imgUrl && nodeFs) {
          targetImg = resolveTargetImagePath(cfg, isDark);
          imgUrl = loadImageAsUrl(targetImg, cfg.maxBytes);
        }
        if (imgUrl) {
          sourceKey = 'img|' + (targetImg || imgUrl);
          var urlPart = 'url("' + imgUrl.replace(/"/g, '\\\\"') + '")';
          if (scrimLayer) {
            bgImage = scrimLayer + ', ' + urlPart;
            bgSize = '100% 100%, ' + fit;
            bgPos = 'center, center';
            bgRepeat = 'no-repeat, no-repeat';
          } else {
            bgImage = urlPart;
            bgSize = fit;
            bgPos = 'center';
            bgRepeat = 'no-repeat';
          }
        }
      }
      if (!bgImage) {
        var presetCss = isDark ? (cfg.preset && cfg.preset.darkCss) : (cfg.preset && cfg.preset.lightCss);
        if (!presetCss) {
          cleanupWallpaper();
          return;
        }
        sourceKey = 'preset|' + ((cfg.preset && cfg.preset.id) || '') + '|' + (isDark ? 'd' : 'l');
        bgImage = scrimLayer ? scrimLayer + ', ' + presetCss : presetCss;
        bgSize = 'cover';
        bgPos = 'center';
        bgRepeat = 'no-repeat';
      }

      var blendMode = isDark ? 'screen' : 'multiply';
      var effectiveOpacity = opacity;
      var filterVal = 'blur(' + blurPx + 'px) saturate(' + Math.round(saturation) + '%)';

      var dom = ensureLayerAndSlots();
      var layer = dom.layer;
      var slots = dom.slots;

      // Outer container receives real-time slider parameters with zero transition lag
      layer.style.setProperty('mix-blend-mode', blendMode, 'important');
      layer.style.setProperty('opacity', String(effectiveOpacity), 'important');
      layer.style.setProperty('filter', filterVal, 'important');

      var oldStyle = document.getElementById(STYLE_ID);
      if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);

      // Same wallpaper/preset: update scrim/fit in place immediately without re-fading
      if (st.currentSourceKey === sourceKey) {
        var curSlot = slots[st.activeSlot];
        writeSlotBg(curSlot, bgImage, bgSize, bgPos, bgRepeat);
        curSlot.style.setProperty('opacity', '1', 'important');
        return;
      }

      // New wallpaper/preset: pre-decode image off-screen, then crossfade between A/B slots (450ms ease-out)
      var seq = ++st.transitionSeq;
      var nextIdx = st.currentSourceKey ? (1 - st.activeSlot) : st.activeSlot;
      var prevIdx = 1 - nextIdx;
      var nextSlot = slots[nextIdx];
      var prevSlot = slots[prevIdx];
      var nextBlob = imgUrl || null;

      preloadAndDecode(imgUrl, function () {
        if (seq !== st.transitionSeq) return;
        if (!document.getElementById(LAYER_ID)) return;

        var oldSlotBlob = st.slotBlobUrls[nextIdx];
        st.slotBlobUrls[nextIdx] = nextBlob;
        if (oldSlotBlob && oldSlotBlob !== nextBlob) {
          safeRevokeBlobUrl(oldSlotBlob);
        }

        writeSlotBg(nextSlot, bgImage, bgSize, bgPos, bgRepeat);
        nextSlot.style.setProperty('z-index', '2', 'important');
        prevSlot.style.setProperty('z-index', '1', 'important');

        var commitFade = function () {
          if (seq !== st.transitionSeq) return;
          nextSlot.style.setProperty('opacity', '1', 'important');
          if (st.currentSourceKey && prevSlot !== nextSlot) {
            prevSlot.style.setProperty('opacity', '0', 'important');
            var retiringBlob = st.slotBlobUrls[prevIdx];
            if (st.revokeTimers[prevIdx]) clearTimeout(st.revokeTimers[prevIdx]);
            st.revokeTimers[prevIdx] = setTimeout(function () {
              st.revokeTimers[prevIdx] = null;
              if (st.activeSlot !== prevIdx) {
                st.slotBlobUrls[prevIdx] = null;
                safeRevokeBlobUrl(retiringBlob);
              }
            }, CROSSFADE_MS + 100);
          }
          st.activeSlot = nextIdx;
          st.currentSourceKey = sourceKey;
        };

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () {
            requestAnimationFrame(commitFade);
          });
        } else {
          commitFade();
        }
      });
    }

    function renderWithIpcImage(cfg) {
      if (!cfg || cfg.enabled !== true) {
        cleanupWallpaper();
        return;
      }
      var isDark = detectDarkTheme();
      if (cfg.mode !== 'image') {
        applyAppearance(cfg, null, '');
        return;
      }
      var targetImg = resolveTargetImagePath(cfg, isDark);
      if (!targetImg) {
        applyAppearance(cfg, null, '');
        return;
      }
      if (st.loadedImagePath === targetImg && st.blobUrl) {
        applyAppearance(cfg, st.blobUrl, targetImg);
        return;
      }
      if (!ipcRenderer) {
        applyAppearance(cfg, null, '');
        return;
      }
      ipcRenderer.invoke('agy-hub:read-wallpaper', targetImg).then(function (imgRes) {
        if (imgRes && imgRes.ok && imgRes.base64) {
          var nextUrl = base64ToBlobUrl(imgRes.base64, imgRes.mime || 'image/png');
          var prevUrl = st.blobUrl;
          st.blobUrl = nextUrl;
          st.loadedImagePath = targetImg;
          if (prevUrl && prevUrl !== nextUrl) {
            setTimeout(function () { safeRevokeBlobUrl(prevUrl); }, CROSSFADE_MS + 120);
          }
          applyAppearance(cfg, nextUrl, targetImg);
        } else {
          applyAppearance(cfg, null, '');
        }
      }).catch(function () {
        applyAppearance(cfg, null, '');
      });
    }

    function pollAppearance(force) {
      try {
        if (nodeFs && APPEARANCE_FILE) {
          if (!nodeFs.existsSync(APPEARANCE_FILE)) {
            if (st.cfg && st.cfg.enabled) {
              st.cfg = null;
              cleanupWallpaper();
            }
            return;
          }
          var stat = nodeFs.statSync(APPEARANCE_FILE);
          var curTheme = detectDarkTheme() ? 'dark' : 'light';
          var needIntervalTick = st.cfg && st.cfg.enabled && st.cfg.mode === 'image' && st.cfg.rotationMode === 'interval';
          if (!force && stat.mtimeMs === st.lastMtimeMs && curTheme === st.lastTheme && !needIntervalTick) {
            return;
          }
          if (force || stat.mtimeMs !== st.lastMtimeMs) {
            st.lastMtimeMs = stat.mtimeMs;
            var raw = nodeFs.readFileSync(APPEARANCE_FILE, 'utf8');
            st.cfg = raw && raw.trim() ? JSON.parse(raw) : null;
          }
          applyAppearance(st.cfg, null);
          return;
        }
        if (ipcRenderer) {
          ipcRenderer.invoke('agy-hub:get-appearance', force ? -1 : st.lastMtimeMs).then(function (res) {
            if (!res) return;
            var curTheme = detectDarkTheme() ? 'dark' : 'light';
            var needIntervalTick = st.cfg && st.cfg.enabled && st.cfg.mode === 'image' && st.cfg.rotationMode === 'interval';
            if (res.missing) {
              if (st.cfg && st.cfg.enabled) {
                st.cfg = null;
                cleanupWallpaper();
              }
              return;
            }
            if (!force && !res.changed && curTheme === st.lastTheme && !needIntervalTick) {
              return;
            }
            if (res.changed && res.config) {
              st.lastMtimeMs = res.mtimeMs || Date.now();
              st.cfg = res.config;
            }
            renderWithIpcImage(st.cfg);
          }).catch(function () {});
        }
      } catch (_) {
        // Fail-open guarantee
      }
    }

    function bootAppearance() {
      pollAppearance(true);

      // Real-time push channel from Electron main-process fs.watch (<30ms latency during slider drag)
      if (ipcRenderer && typeof ipcRenderer.on === 'function') {
        try {
          ipcRenderer.on('agy-hub:appearance-push', function (_evt, pushedCfg) {
            try {
              if (!pushedCfg || typeof pushedCfg !== 'object') return;
              st.cfg = pushedCfg;
              st.lastMtimeMs = Date.now();
              renderWithIpcImage(st.cfg);
            } catch (_) {}
          });
        } catch (_) {}
      }

      // Direct fs.watch when preload has Node fs access
      if (nodeFs && nodePath && APPEARANCE_FILE && typeof nodeFs.watch === 'function') {
        var watchTimer = null;
        try {
          var appDir = nodePath.dirname(APPEARANCE_FILE);
          var appBase = nodePath.basename(APPEARANCE_FILE);
          if (nodeFs.existsSync(appDir)) {
            var watcher = nodeFs.watch(appDir, { persistent: false }, function (_evt, fname) {
              if (fname && String(fname).indexOf(appBase) !== 0) return;
              if (watchTimer) clearTimeout(watchTimer);
              watchTimer = setTimeout(function () { pollAppearance(true); }, 10);
            });
            if (watcher && typeof watcher.unref === 'function') watcher.unref();
          }
        } catch (_) {}
      }

      // Fallback timer for theme transitions & interval rotation
      var timer = setInterval(function () { pollAppearance(false); }, 800);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootAppearance, { once: true });
      } else {
        bootAppearance();
      }
    }
  } catch (_) {
    // Isolated fail-open: never impact i18n or Antigravity host
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

    if (electron && electron.ipcMain && typeof electron.ipcMain.handle === 'function') {
      try {
        var nodePathMain = require('path');
        var appearanceFileMain = BUNDLE_FILE_PATH
          ? nodePathMain.resolve(nodePathMain.dirname(BUNDLE_FILE_PATH), '..', 'appearance', 'runtime-appearance.json')
          : '';
        var ALLOWED_IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

        electron.ipcMain.handle('agy-hub:get-i18n-bundle', function (_evt, lastMtime) {
          try {
            if (!fs || !BUNDLE_FILE_PATH || !fs.existsSync(BUNDLE_FILE_PATH)) {
              return { changed: false };
            }
            var st = fs.statSync(BUNDLE_FILE_PATH);
            if (lastMtime && st.mtimeMs === lastMtime) {
              return { changed: false, mtimeMs: st.mtimeMs };
            }
            var parsed = JSON.parse(fs.readFileSync(BUNDLE_FILE_PATH, 'utf8'));
            return { changed: true, mtimeMs: st.mtimeMs, bundle: parsed };
          } catch (_) {
            return { changed: false };
          }
        });

        electron.ipcMain.handle('agy-hub:get-appearance', function (_evt, lastMtime) {
          try {
            if (!fs || !appearanceFileMain || !fs.existsSync(appearanceFileMain)) {
              return { missing: true, changed: false };
            }
            var st = fs.statSync(appearanceFileMain);
            if (lastMtime && lastMtime > 0 && st.mtimeMs === lastMtime) {
              return { changed: false, mtimeMs: st.mtimeMs };
            }
            var parsed = JSON.parse(fs.readFileSync(appearanceFileMain, 'utf8'));
            return { changed: true, mtimeMs: st.mtimeMs, config: parsed };
          } catch (_) {
            return { changed: false };
          }
        });

        // Push runtime-appearance.json updates to ALL WebContents (BrowserWindow + WebContentsView + BrowserView) in real time (<30ms)
        if (fs && appearanceFileMain && typeof fs.watch === 'function') {
          try {
            var appWatchDir = nodePathMain.dirname(appearanceFileMain);
            var appWatchBase = nodePathMain.basename(appearanceFileMain);
            if (!fs.existsSync(appWatchDir)) {
              try { fs.mkdirSync(appWatchDir, { recursive: true }); } catch (_) {}
            }
            if (fs.existsSync(appWatchDir)) {
              var pushTimer = null;
              var lastPushRaw = '';
              var broadcastAppearance = function () {
                try {
                  if (!fs.existsSync(appearanceFileMain)) return;
                  var raw = fs.readFileSync(appearanceFileMain, 'utf8');
                  if (!raw || !raw.trim() || raw === lastPushRaw) return;
                  var parsed = JSON.parse(raw);
                  lastPushRaw = raw;
                  var sent = 0;
                  if (electron.webContents && typeof electron.webContents.getAllWebContents === 'function') {
                    var allWc = electron.webContents.getAllWebContents();
                    for (var ci = 0; ci < allWc.length; ci++) {
                      var wc = allWc[ci];
                      if (wc && !wc.isDestroyed() && typeof wc.send === 'function') {
                        wc.send('agy-hub:appearance-push', parsed);
                        sent++;
                      }
                    }
                  }
                  if (sent === 0 && electron.BrowserWindow && typeof electron.BrowserWindow.getAllWindows === 'function') {
                    var wins = electron.BrowserWindow.getAllWindows();
                    for (var wi = 0; wi < wins.length; wi++) {
                      var w = wins[wi];
                      if (w && !w.isDestroyed() && w.webContents && typeof w.webContents.send === 'function') {
                        w.webContents.send('agy-hub:appearance-push', parsed);
                      }
                    }
                  }
                } catch (_) {}
              };
              var appWatcher = fs.watch(appWatchDir, { persistent: false }, function (_evt, fname) {
                if (fname && String(fname).indexOf(appWatchBase) !== 0) return;
                if (pushTimer) clearTimeout(pushTimer);
                pushTimer = setTimeout(broadcastAppearance, 10);
              });
              if (appWatcher && typeof appWatcher.unref === 'function') appWatcher.unref();
            }
          } catch (_) {}
        }

        electron.ipcMain.handle('agy-hub:read-wallpaper', function (_evt, imgPath) {
          try {
            if (!fs || typeof imgPath !== 'string' || !imgPath.trim()) return { ok: false };
            if (!fs.existsSync(imgPath)) return { ok: false };
            var st = fs.statSync(imgPath);
            if (!st.isFile() || st.size <= 0 || st.size > 15 * 1024 * 1024) return { ok: false };
            var ext = String(nodePathMain.extname(imgPath) || '').toLowerCase();
            var mime = ALLOWED_IMG[ext];
            if (!mime) return { ok: false };
            var b64 = fs.readFileSync(imgPath).toString('base64');
            return { ok: true, mime: mime, base64: b64 };
          } catch (_) {
            return { ok: false };
          }
        });

        var untransFileMain = BUNDLE_FILE_PATH
          ? nodePathMain.resolve(nodePathMain.dirname(BUNDLE_FILE_PATH), 'untranslated.json')
          : '';
        electron.ipcMain.handle('agy-hub:record-untranslated', function (_evt, batch) {
          try {
            if (!fs || !untransFileMain || !Array.isArray(batch) || !batch.length) return { ok: false };
            var cur = { items: [], updatedAt: null };
            if (fs.existsSync(untransFileMain)) {
              try {
                var parsed = JSON.parse(fs.readFileSync(untransFileMain, 'utf8'));
                if (parsed && Array.isArray(parsed.items)) cur = parsed;
              } catch (_) {}
            }
            var set = new Set(cur.items);
            var added = 0;
            for (var i = 0; i < batch.length; i++) {
              if (set.size >= 500) break;
              var s = typeof batch[i] === 'string' ? batch[i].trim() : '';
              if (s.length >= 2 && s.length <= 140 && !set.has(s)) {
                set.add(s);
                added++;
              }
            }
            if (added > 0) {
              var nextObj = { items: Array.from(set), updatedAt: new Date().toISOString() };
              fs.writeFileSync(untransFileMain, JSON.stringify(nextObj, null, 2) + '\\n', 'utf8');
            }
            return { ok: true, count: set.size, added: added };
          } catch (_) {
            return { ok: false };
          }
        });
      } catch (_) {}
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
