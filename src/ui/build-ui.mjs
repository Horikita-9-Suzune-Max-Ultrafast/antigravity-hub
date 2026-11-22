import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export async function buildUi(options = {}) {
  const uiDir = path.join(PROJECT_ROOT, 'src', 'ui');
  const outPath = options.outPath || path.join(PROJECT_ROOT, 'dist', 'dashboard.html');

  const bundled = await esbuild.build({
    entryPoints: [path.join(uiDir, 'app.mjs')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
  });

  const jsCode = bundled.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
  const cssCode = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8').replace(/<\/style>/gi, '<\\/style>');
  const template = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');

  const html = template
    .replace('/* INLINE_STYLES */', cssCode)
    .replace('/* INLINE_SCRIPT */', jsCode);

  // Verify MCP App CSP compliance (no external scripts/stylesheets, < 10 MiB)
  if (/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
    throw new Error('Bundled UI contains external http(s) script/link tags, violating MCP App CSP');
  }
  const byteSize = Buffer.byteLength(html, 'utf8');
  if (byteSize >= 10 * 1024 * 1024) {
    throw new Error(`Bundled UI exceeds 10 MiB MCP App limit (${byteSize} bytes)`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return { outPath, byteSize };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const res = await buildUi();
  console.log(`Built single-file MCP App UI: ${res.outPath} (${(res.byteSize / 1024).toFixed(1)} KiB)`);
}
