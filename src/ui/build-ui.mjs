import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const MAX_UI_BUNDLE_BYTES = 486_400; // 475 KiB hard gate (v1.6.0)

function minifyHtmlTemplate(html) {
  const preserved = [];
  const masked = html.replace(/<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    const idx = preserved.push(match) - 1;
    return `\u0000PRESERVE_${idx}\u0000`;
  });

  const compacted = masked
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, (tag) => {
      let t = tag;
      if (/\bdata-i18n-title="/.test(t)) t = t.replace(/\s+title="[^"]*"/g, '');
      if (/\bdata-i18n-placeholder="/.test(t)) t = t.replace(/\s+placeholder="[^"]*"/g, '');
      if (/\bdata-i18n-aria="/.test(t)) t = t.replace(/\s+aria-label="[^"]*"/g, '');
      t = t.replace(/\s+style="([^"]*)"/g, (_, s) => ` style="${s.replace(/\s*([:;])\s*/g, '$1').replace(/;+$/, '')}"`);
      return t;
    })
    .replace(/(<[^>]*\bdata-i18n="[^"]+"[^>]*>)[^<]+(<\/(?:span|div|button|p|h[1-6]|th|label|option|strong)>)/g, '$1$2')
    .replace(/>[ \t]*\r?\n[ \t]*</g, '><')
    .replace(/>[ \t]*\r?\n[ \t]*/g, '>')
    .replace(/[ \t]*\r?\n[ \t]*</g, '<')
    .replace(/[ \t]*\r?\n[ \t]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return compacted.replace(/\u0000PRESERVE_(\d+)\u0000/g, (_, idx) => preserved[Number(idx)]);
}

export async function buildUi(options = {}) {
  const uiDir = options.uiDir || path.join(PROJECT_ROOT, 'src', 'ui');
  const entryPoint = options.entryPoint || path.join(uiDir, 'app.mjs');
  const outPath = options.outPath || path.join(PROJECT_ROOT, 'dist', 'dashboard.html');
  const maxBytes = options.maxBytes ?? MAX_UI_BUNDLE_BYTES;

  const entrySrc = fs.existsSync(entryPoint) ? fs.readFileSync(entryPoint, 'utf8') : '';
  const nativeClientPath = path.join(uiDir, 'core', 'mcp-app-client.mjs');
  const usesLegacyExtApps =
    !options.disableLegacyAlias &&
    /@modelcontextprotocol\/ext-apps/.test(entrySrc) &&
    fs.existsSync(nativeClientPath);

  function compactHtmlTemplateQuasis(src) {
    // Safely compact whitespace ONLY inside HTML template literal chunks containing markup tags
    // (never touches JS code, comments, or plain-text prompts without HTML closing tags)
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (ch === "'" || ch === '"') {
        const q = ch;
        let j = i + 1;
        while (j < n && src[j] !== q) {
          if (src[j] === '\\') j++;
          j++;
        }
        out += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i + 2);
        const end = nl === -1 ? n : nl + 1;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      if (ch === '`') {
        // Scan until matching unescaped backtick (skipping ${...} expressions cleanly)
        let j = i + 1;
        let depth = 0;
        let hasHtmlTag = false;
        const segments = [];
        let segStart = j;
        while (j < n) {
          const c = src[j];
          if (depth === 0) {
            if (c === '\\') {
              j += 2;
              continue;
            }
            if (c === '`') {
              segments.push({ raw: true, text: src.slice(segStart, j) });
              if (/<\/[a-z][a-z0-9-]*>/i.test(src.slice(segStart, j))) hasHtmlTag = true;
              break;
            }
            if (c === '$' && src[j + 1] === '{') {
              const txt = src.slice(segStart, j);
              if (/<\/[a-z][a-z0-9-]*>/i.test(txt)) hasHtmlTag = true;
              segments.push({ raw: true, text: txt });
              depth = 1;
              segStart = j;
              j += 2;
              continue;
            }
            j++;
          } else {
            if (c === "'" || c === '"') {
              const q = c;
              j++;
              while (j < n && src[j] !== q) {
                if (src[j] === '\\') j++;
                j++;
              }
              j++;
              continue;
            }
            if (c === '`') {
              // Nested template literal inside ${...}: skip cleanly
              j++;
              let subDepth = 0;
              while (j < n) {
                if (src[j] === '\\') {
                  j += 2;
                  continue;
                }
                if (subDepth === 0 && src[j] === '`') {
                  j++;
                  break;
                }
                if (src[j] === '$' && src[j + 1] === '{') {
                  subDepth++;
                  j += 2;
                  continue;
                }
                if (subDepth > 0 && src[j] === '}') subDepth--;
                j++;
              }
              continue;
            }
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                segments.push({ raw: false, text: src.slice(segStart, j + 1) });
                segStart = j + 1;
              }
            }
            j++;
          }
        }
        if (hasHtmlTag && j < n && src[j] === '`') {
          out += '`';
          for (const seg of segments) {
            if (seg.raw) {
              out += seg.text
                .replace(/>[ \t]*\r?\n[ \t]*</g, '><')
                .replace(/>[ \t]*\r?\n[ \t]+/g, '>')
                .replace(/[ \t]*\r?\n[ \t]+</g, '<')
                .replace(/[ \t]*\r?\n[ \t]+/g, ' ');
            } else {
              out += compactHtmlTemplateQuasis(seg.text);
            }
          }
          out += '`';
        } else {
          out += src.slice(i, j + 1);
        }
        i = j + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  const compactHtmlLiteralsPlugin = {
    name: 'compact-ui-html-literals',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]ui[\\/]i18n-ui\.mjs$/ }, async (args) => {
        const src = fs.readFileSync(args.path, 'utf8');
        const m = src.match(/const ZH_CN\s*=\s*\{[\s\S]*?\r?\n\};\s*\r?\nconst EN\s*=\s*\{[\s\S]*?\r?\n\};/);
        if (m) {
          const mod = await import(`${pathToFileURL(args.path).href}?v=${Date.now()}`);
          const dicts = mod.UI_DICTIONARIES;
          if (dicts?.['zh-CN'] && dicts?.en) {
            const tree = {};
            const allKeys = [...new Set([...Object.keys(dicts['zh-CN']), ...Object.keys(dicts.en)])];
            for (const k of allKeys) {
              const pair = [dicts['zh-CN'][k] ?? dicts.en[k], dicts.en[k] ?? dicts['zh-CN'][k]];
              const parts = k.split('.');
              let cur = tree;
              for (let idx = 0; idx < parts.length - 1; idx++) {
                if (!cur[parts[idx]] || Array.isArray(cur[parts[idx]])) cur[parts[idx]] = {};
                cur = cur[parts[idx]];
              }
              cur[parts[parts.length - 1]] = pair;
            }
            const packedCode =
              `const _P=${JSON.stringify(tree)};` +
              `const ZH_CN={},EN={};` +
              `(function u(o,p){for(const k in o){const v=o[k],f=p?p+'.'+k:k;if(Array.isArray(v)){ZH_CN[f]=v[0];EN[f]=v[1]}else u(v,f)}})(_P,'');`;
            return { contents: src.replace(m[0], () => packedCode), loader: 'js' };
          }
        }
        return { contents: src, loader: 'js' };
      });
      build.onLoad({ filter: /[\\/]src[\\/]ui[\\/].*\.mjs$/ }, (args) => {
        const src = fs.readFileSync(args.path, 'utf8');
        return { contents: compactHtmlTemplateQuasis(src), loader: 'js' };
      });
    },
  };

  const esbuildOpts = {
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    charset: 'utf8',
    minify: true,
    legalComments: 'none',
    metafile: true,
    plugins: [compactHtmlLiteralsPlugin],
  };

  if (usesLegacyExtApps) {
    esbuildOpts.alias = {
      '@modelcontextprotocol/ext-apps': nativeClientPath,
    };
  }

  const bundled = await esbuild.build(esbuildOpts);
  const jsCode = bundled.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');

  // Hard gate #1: zero zod runtime residue in bundled UI JavaScript
  if (options.enforceZeroZod !== false && /zod/i.test(jsCode)) {
    throw new Error('Bundled UI JS must contain zero zod runtime references');
  }

  const rawCss = fs.readFileSync(options.cssPath || path.join(uiDir, 'styles.css'), 'utf8');
  const cssCode = esbuild
    .transformSync(rawCss, { loader: 'css', minify: true })
    .code.replace(/<\/style>/gi, '<\\/style>');

  const rawTemplate = fs.readFileSync(options.htmlPath || path.join(uiDir, 'index.html'), 'utf8');
  const template = minifyHtmlTemplate(rawTemplate);

  const html = template
    .replace('/* INLINE_STYLES */', () => cssCode)
    .replace('/* INLINE_SCRIPT */', () => jsCode);

  // Verify embedded script parses cleanly as valid JavaScript (guards against template substitution corruption)
  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(html);
  if (!scriptMatch || !scriptMatch[1].trim()) {
    throw new Error('Bundled UI is missing inline <script> block');
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(scriptMatch[1]);
  } catch (err) {
    throw new Error(`Bundled UI inline script failed JS syntax validation: ${err.message}`);
  }

  // Verify MCP App CSP compliance (no external scripts/stylesheets)
  if (/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
    throw new Error('Bundled UI contains external http(s) script/link tags, violating MCP App CSP');
  }

  const byteSize = Buffer.byteLength(html, 'utf8');
  const jsBytes = Buffer.byteLength(jsCode, 'utf8');
  const cssBytes = Buffer.byteLength(cssCode, 'utf8');

  if (byteSize >= 10 * 1024 * 1024) {
    throw new Error(`Bundled UI exceeds 10 MiB MCP App limit (${byteSize} bytes)`);
  }

  // Hard gate #2: <= 475 KiB (486,400 B) single-file HTML budget
  if (options.enforceSizeGate !== false && byteSize > maxBytes) {
    throw new Error(
      `Bundled UI exceeds ${maxBytes} B (${(maxBytes / 1024).toFixed(0)} KiB) budget: got ${byteSize} B (${(byteSize / 1024).toFixed(1)} KiB)`
    );
  }

  if (options.write !== false) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
  }

  return {
    outPath,
    byteSize,
    jsBytes,
    cssBytes,
    metafile: bundled.metafile,
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const res = await buildUi();
  console.log(
    `Built single-file MCP App UI: ${res.outPath} (${(res.byteSize / 1024).toFixed(1)} KiB; JS ${(res.jsBytes / 1024).toFixed(1)} KiB, CSS ${(res.cssBytes / 1024).toFixed(1)} KiB)`
  );
}
