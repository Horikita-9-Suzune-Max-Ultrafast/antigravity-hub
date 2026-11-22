#!/usr/bin/env node
import { buildCompactBrief, saveMemory, searchMemories } from '../src/core/vault.mjs';
import { getTelemetryReport } from '../src/core/telemetry.mjs';
import { getQuotaSnapshot } from '../src/core/quota.mjs';
import { runDoctor, repairLocalState, exportBackup } from '../src/core/doctor.mjs';

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos[0] || 'help', rest: pos.slice(1), flags };
}

function main() {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  const opts = {};
  if (flags['data-dir']) opts.dataDir = flags['data-dir'];
  if (flags['plugin-dir']) opts.pluginDir = flags['plugin-dir'];
  if (flags['project']) opts.projectDir = flags['project'];
  const asJson = Boolean(flags.json);

  const print = (obj, fallbackText) => {
    if (asJson) {
      console.log(JSON.stringify(obj, null, 2));
    } else {
      console.log(fallbackText);
    }
  };

  switch (cmd) {
    case 'brief': {
      const brief = buildCompactBrief({ projectDir: opts.projectDir, budgetTokens: flags.budget ? Number(flags.budget) : undefined }, opts);
      print(brief, brief.text || `[CTX-BRIEF] project=${brief.git.projectName} branch=${brief.git.branch}@${brief.git.head} (empty)`);
      break;
    }
    case 'save': {
      const title = flags.title || rest[0];
      const summary = flags.summary || rest.slice(1).join(' ');
      if (!title) {
        console.error('Usage: ctx save --kind <decision|working_state|architecture|pitfall> --title "..." --summary "..."');
        process.exit(1);
      }
      const saved = saveMemory(
        {
          projectDir: opts.projectDir,
          kind: flags.kind || 'decision',
          title,
          summary,
          tags: flags.tags ? String(flags.tags).split(',') : [],
        },
        opts
      );
      print(saved, `Saved [${saved.kind}] ${saved.title} (${saved.id})`);
      break;
    }
    case 'search': {
      const query = rest.join(' ') || flags.query || '';
      const items = searchMemories({ projectDir: opts.projectDir, query, kind: flags.kind || 'all', limit: Number(flags.limit) || 20 }, opts);
      const lines = items.length
        ? items.map((m) => `- [${m.kind}] ${m.title} (${m.branch}@${m.head})\n  ${m.summary}`)
        : ['No matching memories found.'];
      print(items, lines.join('\n'));
      break;
    }
    case 'calls': {
      const rep = getTelemetryReport({ conversationId: flags.session, agentFilter: flags.agent || 'all', onlyDrop: Boolean(flags.drops) }, opts);
      const lines = [
        `Session: ${rep.conversationId || 'none'} | Steps: ${rep.totalCallsCount} | Avg TPS: ${rep.summary.avgTps} | Cost: $${rep.summary.totalCostUsd}`,
        ...rep.calls.slice(0, 15).map(
          (c) => `  [${c.agentTag}] #${c.stepIndex} ${c.model} | ${c.effectiveTps} tok/s | Cache ${c.cacheHitRate}%${c.cacheDrop ? ' [DROP:' + c.dropReason + ']' : ''} | $${c.estimatedCostUsd.toFixed(3)}`
        ),
      ];
      print(rep, lines.join('\n'));
      break;
    }
    case 'quota': {
      const q = getQuotaSnapshot({}, opts);
      const lines = q.groups.map(
        (g) => `${g.name}: Weekly ${g.weeklyPct}% (${g.weeklyHrs}h) | 5h ${g.h5Pct == null ? 'N/A' : g.h5Pct + '%'} | Local 7d ${g.localTokens7d}`
      );
      print(q, lines.join('\n'));
      break;
    }
    case 'doctor': {
      const res = flags.repair ? repairLocalState(opts) : { report: runDoctor(opts) };
      const r = res.report;
      const lines = [
        `Status: ${r.healthy ? 'HEALTHY' : 'ATTENTION'} (v${r.version})`,
        `Data Dir: ${r.dataDir}`,
        `Plugin Dir: ${r.pluginDir}`,
        `Drift: ${r.drift.count} | Circuit: ${r.circuit.state} (${r.circuit.failures}/${r.circuit.threshold})`,
        `Index: ${r.index.ok ? 'OK' : 'NEEDS REBUILD'} (memories ${r.index.dbMemories}/${r.index.truthMemories}, calls ${r.index.dbCalls}/${r.index.truthCalls})`,
        `Deploy: zero_node_modules=${r.deployment.zeroNodeModules}, ui_bytes=${r.deployment.uiSizeBytes}, missing=${r.deployment.missingFiles.length}`,
        ...r.issues.map((i) => `  ! ${i}`),
      ];
      print(res, lines.join('\n'));
      if (!r.healthy) process.exitCode = 1;
      break;
    }
    case 'export': {
      const out = exportBackup(opts);
      print(out, `Exported sanitized backup to ${out.displayPath} (${out.counts.memories} memories, ${out.counts.calls} calls)`);
      break;
    }
    default: {
      console.log(`context-cache CLI
Commands:
  brief   [--project <dir>] [--budget <n>] [--json]
  save    --title <text> --summary <text> [--kind <kind>] [--tags a,b]
  search  <query> [--kind <kind>] [--json]
  calls   [--session <id>] [--agent main|sub] [--drops] [--json]
  quota   [--json]
  doctor  [--repair] [--json]
  export  [--json]`);
    }
  }
}

main();
