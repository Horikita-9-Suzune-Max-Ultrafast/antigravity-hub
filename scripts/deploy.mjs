import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPluginDeployDir } from '../src/core/paths.mjs';
import { buildUi } from '../src/ui/build-ui.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyTreeFiltered(srcDir, destDir, manifestFiles, baseDest, excludeNames = new Set()) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(srcPath, destPath, manifestFiles, baseDest, excludeNames);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      const rel = path.relative(baseDest, destPath).replace(/\\/g, '/');
      manifestFiles[rel] = sha256File(destPath);
    }
  }
}

/**
 * Idempotently build single-file UI and deploy a zero-node_modules runtime plugin bundle.
 * Never modifies ~/.gemini/config/config.json.
 */
export async function deployPlugin(options = {}) {
  const targetDir = path.resolve(options.targetDir || getPluginDeployDir(options));
  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));

  // 1. Build self-contained single-file MCP App UI
  const uiRes = await buildUi({
    outPath: path.join(SOURCE_ROOT, 'dist', 'dashboard.html'),
  });

  // 2. Ensure target directory exists and never contains node_modules
  fs.mkdirSync(targetDir, { recursive: true });
  const staleNodeModules = path.join(targetDir, 'node_modules');
  if (fs.existsSync(staleNodeModules)) {
    fs.rmSync(staleNodeModules, { recursive: true, force: true });
  }

  // Clean managed subdirectories for idempotent sync (never delete unknown user files outside our bundle)
  for (const managed of ['src', 'bin', 'dist', 'rules', 'skills', 'assets']) {
    const p = path.join(targetDir, managed);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }

  const manifestFiles = {};

  // 3. Copy plugin metadata & customizations (excluding mcp_config.template.json which is rendered below)
  copyTreeFiltered(
    path.join(SOURCE_ROOT, 'plugin'),
    targetDir,
    manifestFiles,
    targetDir,
    new Set(['mcp_config.template.json'])
  );

  // 4. Copy pure Node.js 24 zero-dependency runtime code (exclude src/ui dev sources)
  copyTreeFiltered(
    path.join(SOURCE_ROOT, 'src', 'core'),
    path.join(targetDir, 'src', 'core'),
    manifestFiles,
    targetDir
  );
  copyTreeFiltered(
    path.join(SOURCE_ROOT, 'src', 'adapters'),
    path.join(targetDir, 'src', 'adapters'),
    manifestFiles,
    targetDir
  );
  copyTreeFiltered(
    path.join(SOURCE_ROOT, 'src', 'mcp'),
    path.join(targetDir, 'src', 'mcp'),
    manifestFiles,
    targetDir
  );
  copyTreeFiltered(
    path.join(SOURCE_ROOT, 'bin'),
    path.join(targetDir, 'bin'),
    manifestFiles,
    targetDir
  );

  // 5. Copy compiled single-file dashboard.html
  const destUiDir = path.join(targetDir, 'dist');
  fs.mkdirSync(destUiDir, { recursive: true });
  const destUiPath = path.join(destUiDir, 'dashboard.html');
  fs.copyFileSync(uiRes.outPath, destUiPath);
  manifestFiles['dist/dashboard.html'] = sha256File(destUiPath);

  // 6. Write minimal package.json with "type": "module" and ZERO dependencies
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    private: true,
    engines: pkg.engines,
  };
  const destPkgPath = path.join(targetDir, 'package.json');
  fs.writeFileSync(destPkgPath, JSON.stringify(runtimePkg, null, 2) + '\n', 'utf8');
  manifestFiles['package.json'] = sha256File(destPkgPath);

  // 7. Render mcp_config.json with exact deployed absolute path (safe for Windows paths with spaces)
  const templateRaw = fs.readFileSync(path.join(SOURCE_ROOT, 'plugin', 'mcp_config.template.json'), 'utf8');
  const deployedServerPath = path.join(targetDir, 'src', 'mcp', 'server.mjs');
  const templateObj = JSON.parse(templateRaw);
  for (const srv of Object.values(templateObj.mcpServers || {})) {
    if (Array.isArray(srv.args)) {
      srv.args = srv.args.map((a) => (a === '{{SERVER_PATH}}' ? deployedServerPath : a));
    }
  }
  const destMcpPath = path.join(targetDir, 'mcp_config.json');
  fs.writeFileSync(destMcpPath, JSON.stringify(templateObj, null, 2) + '\n', 'utf8');
  manifestFiles['mcp_config.json'] = sha256File(destMcpPath);

  // 8. Write deploy-manifest.json for Doctor integrity verification
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    deployedAt: new Date().toISOString(),
    uiBytes: uiRes.byteSize,
    zeroNodeModules: !fs.existsSync(path.join(targetDir, 'node_modules')),
    fileCount: Object.keys(manifestFiles).length,
    files: manifestFiles,
  };
  fs.writeFileSync(path.join(targetDir, 'deploy-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    targetDir,
    version: pkg.version,
    uiBytes: uiRes.byteSize,
    fileCount: manifest.fileCount,
    zeroNodeModules: manifest.zeroNodeModules,
    serverPath: deployedServerPath,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) out.targetDir = argv[++i];
    else if (argv[i].startsWith('--target=')) out.targetDir = argv[i].slice('--target='.length);
  }
  return out;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const res = await deployPlugin(args);
  console.log(`Deployed context-cache v${res.version} -> ${res.targetDir}`);
  console.log(`  Files: ${res.fileCount} | UI: ${(res.uiBytes / 1024).toFixed(1)} KiB | Zero node_modules: ${res.zeroNodeModules}`);
}
