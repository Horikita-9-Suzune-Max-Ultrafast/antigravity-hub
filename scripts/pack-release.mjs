import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deployPlugin } from './deploy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Build a portable, zero-node_modules, plug-and-play GitHub Release zip bundle.
 * Uses ${PLUGIN_ROOT}/src/mcp/server.mjs so any user can extract straight into
 * ~/.gemini/config/plugins/context-cache without running npm install.
 */
export async function packRelease(options = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '1.0.0';
  const distDir = path.resolve(options.distDir || path.join(SOURCE_ROOT, 'dist'));
  const stageRoot = path.join(distDir, '.release-stage');
  const stagePluginDir = path.join(stageRoot, 'context-cache');

  if (fs.existsSync(stageRoot)) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }

  try {
    // 1. Deploy clean zero-node_modules runtime files into staging dir
    await deployPlugin({ targetDir: stagePluginDir });

    // 2. Replace mcp_config.json with portable ${PLUGIN_ROOT} path (verified in Antigravity LS)
    const portableMcp = {
      mcpServers: {
        'context-cache-server': {
          command: 'node',
          args: ['--no-warnings', '${PLUGIN_ROOT}/src/mcp/server.mjs'],
        },
      },
    };
    fs.writeFileSync(
      path.join(stagePluginDir, 'mcp_config.json'),
      JSON.stringify(portableMcp, null, 2) + '\n',
      'utf8'
    );

    // 3. Include LICENSE and bilingual READMEs for MIT compliance and offline docs
    for (const doc of ['LICENSE', 'README.md', 'README.en.md']) {
      const srcDoc = path.join(SOURCE_ROOT, doc);
      if (fs.existsSync(srcDoc)) {
        fs.copyFileSync(srcDoc, path.join(stagePluginDir, doc));
      }
    }

    // 4. Refresh deploy-manifest.json hash for portable mcp_config.json
    const manifestPath = path.join(stagePluginDir, 'deploy-manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.portable = true;
      manifest.files['mcp_config.json'] = sha256File(path.join(stagePluginDir, 'mcp_config.json'));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }

    // 5. Assert zero node_modules
    if (fs.existsSync(path.join(stagePluginDir, 'node_modules'))) {
      throw new Error('Release bundle unexpectedly contains node_modules');
    }

    // 6. Create zip archive
    const zipName = `context-cache-v${version}-plugin.zip`;
    const zipPath = path.join(distDir, zipName);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (process.platform === 'win32') {
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path "${stagePluginDir}" -DestinationPath "${zipPath}" -Force`,
        ],
        { windowsHide: true, stdio: 'pipe' }
      );
    } else {
      execFileSync('zip', ['-rq', zipPath, 'context-cache'], { cwd: stageRoot, stdio: 'pipe' });
    }

    const sha256 = sha256File(zipPath);
    const shaPath = `${zipPath}.sha256`;
    fs.writeFileSync(shaPath, `${sha256}  ${zipName}\n`, 'utf8');

    const sizeBytes = fs.statSync(zipPath).size;
    return { version, zipName, zipPath, shaPath, sha256, sizeBytes };
  } finally {
    if (fs.existsSync(stageRoot)) {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const res = await packRelease();
  console.log(`Packed release bundle: ${res.zipPath} (${(res.sizeBytes / 1024).toFixed(1)} KiB)`);
  console.log(`  SHA-256: ${res.sha256}`);
}
