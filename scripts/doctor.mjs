import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDoctor, repairLocalState } from '../src/core/doctor.mjs';
import { deployPlugin } from './deploy.mjs';

function parseArgs(argv) {
  const flags = { repair: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repair') flags.repair = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--data-dir' && argv[i + 1]) flags.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) flags.dataDir = a.slice('--data-dir='.length);
    else if (a === '--plugin-dir' && argv[i + 1]) flags.pluginDir = argv[++i];
    else if (a.startsWith('--plugin-dir=')) flags.pluginDir = a.slice('--plugin-dir='.length);
  }
  return flags;
}

export async function runDoctorCli(flags = {}) {
  const opts = {};
  if (flags.dataDir) opts.dataDir = flags.dataDir;
  if (flags.pluginDir) opts.pluginDir = flags.pluginDir;

  let deployResult = null;
  let repairResult = null;

  if (flags.repair) {
    const pre = runDoctor(opts);
    if (!pre.deployment.exists || pre.deployment.missingFiles.length > 0 || !pre.deployment.zeroNodeModules) {
      deployResult = await deployPlugin({ targetDir: flags.pluginDir });
    }
    repairResult = repairLocalState(opts);
  }

  const report = repairResult ? repairResult.report : runDoctor(opts);
  return { report, repairResult, deployResult };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const out = await runDoctorCli(flags);
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const r = out.report;
    console.log(`context-cache doctor: ${r.healthy ? 'HEALTHY' : 'ATTENTION'} (v${r.version})`);
    console.log(`  Data Dir:   ${r.dataDir}`);
    console.log(`  Plugin Dir: ${r.pluginDir}`);
    console.log(`  Drift:      ${r.drift.count} | Circuit: ${r.circuit.state} (${r.circuit.failures}/${r.circuit.threshold})`);
    console.log(`  Index:      ${r.index.ok ? 'SYNCED' : 'OUT_OF_SYNC'} (memories ${r.index.dbMemories}/${r.index.truthMemories}, calls ${r.index.dbCalls}/${r.index.truthCalls})`);
    console.log(`  Deployment: zeroNodeModules=${r.deployment.zeroNodeModules}, uiSelfContained=${r.deployment.uiSelfContained}, uiBytes=${r.deployment.uiSizeBytes}`);
    if (out.deployResult) {
      console.log(`  Repaired deployment -> ${out.deployResult.targetDir}`);
    }
    if (out.repairResult) {
      console.log(`  Rebuilt SQLite index in ${out.repairResult.rebuild.elapsedMs}ms`);
    }
    for (const issue of r.issues) {
      console.log(`  ! ${issue}`);
    }
  }
  if (!out.report.healthy) process.exit(1);
}
