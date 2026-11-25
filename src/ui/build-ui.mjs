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

  const esbuildOpts = {
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    metafile: true,
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
