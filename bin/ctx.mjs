#!/usr/bin/env node
import fs from 'node:fs';
import { buildCompactBrief, saveMemory, searchMemories } from '../src/core/vault.mjs';
import { getTelemetryReport } from '../src/core/telemetry.mjs';
import { getQuotaSnapshot } from '../src/core/quota.mjs';
import { runDoctor, repairLocalState, exportBackup } from '../src/core/doctor.mjs';
import {
  getI18nStatus,
  refreshRuntimeBundle,
  triggerApplyPatch,
  triggerRestorePatch,
} from '../src/core/i18n/index.mjs';
import {
  getGovernanceOverview,
  listSnapshots,
  rollbackSnapshot,
  runGovernanceLint,
  scanEcosystem,
} from '../src/core/governance/index.mjs';
import {
  getAppearanceStatus,
  emergencyDisableWallpaper,
  pickNextWallpaper,
} from '../src/core/appearance/index.mjs';
import { handleReviewAction } from '../src/core/review/index.mjs';

const MAX_REVIEW_STDIN_BYTES = 2 * 1024 * 1024; // 2 MiB

async function readStdinUtf8(maxBytes = MAX_REVIEW_STDIN_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`stdin input exceeds maximum allowed size (${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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

async function main() {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  const opts = {};
  if (flags['data-dir']) opts.dataDir = flags['data-dir'];
  if (flags['config-dir']) opts.configDir = flags['config-dir'];
  if (flags['app-data-dir']) opts.appDataDir = flags['app-data-dir'];
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
      if (flags['resync-telemetry']) opts.resyncTelemetry = true;
      const res = flags.repair || flags['resync-telemetry']
        ? await repairLocalState(opts)
        : { report: runDoctor(opts) };
      const r = res.report;
      const lines = [
        `Status: ${r.healthy ? 'HEALTHY' : 'ATTENTION'} (v${r.version})`,
        `Data Dir: ${r.dataDir}`,
        `Plugin Dir: ${r.pluginDir}`,
        `Drift: ${r.drift.count} | Circuit: ${r.circuit.state} (${r.circuit.failures}/${r.circuit.threshold})`,
        `Index: ${r.index.ok ? 'OK' : 'NEEDS REBUILD'} (memories ${r.index.dbMemories}/${r.index.truthMemories}, calls ${r.index.dbCalls}/${r.index.truthUniqueCalls} (${r.index.truthRawCallLines} raw))`,
        `Deploy: zero_node_modules=${r.deployment.zeroNodeModules}, ui_bytes=${r.deployment.uiSizeBytes}, missing=${r.deployment.missingFiles.length}`,
        ...(res.telemetryResync ? [`Telemetry Resync: ${JSON.stringify(res.telemetryResync)}`] : []),
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
    case 'i18n': {
      const sub = rest[0] || 'status';
      if (sub === 'status') {
        const st = getI18nStatus(opts);
        const lines = [
          `Status: ${st.status} | Version: ${st.appVersion || 'unknown'}`,
          `Install Dir: ${st.installDir || '(not found)'}`,
          `Clean Backup: ${st.hasCleanBackup ? 'YES' : 'NO'} (${(st.backups || []).map((b) => b.name).join(', ') || 'none'})`,
          `Active Dict Entries: ${st.dictStats?.totalActive ?? 0}`,
        ];
        print(st, lines.join('\n'));
        break;
      }
      if (sub === 'refresh') {
        const res = refreshRuntimeBundle(opts);
        print(res, `Compiled runtime bundle: ${res.bundlePath} (${res.stats.totalActive} active entries)`);
        break;
      }
      if (sub === 'apply') {
        const res = await triggerApplyPatch({ sync: Boolean(flags.sync), skipProcessControl: Boolean(flags['skip-process']) }, opts);
        print(res, res.message || `Applied localization patch (${res.status || 'ok'})`);
        break;
      }
      if (sub === 'restore') {
        const res = await triggerRestorePatch({ sync: Boolean(flags.sync), skipProcessControl: Boolean(flags['skip-process']) }, opts);
        print(res, res.message || `Restored original app.asar (${res.status || 'ok'})`);
        break;
      }
      console.error('Usage: ctx i18n <status|refresh|apply|restore> [--json]');
      process.exit(1);
    }
    case 'gov': {
      const sub = rest[0] || 'status';
      if (sub === 'status') {
        const ov = getGovernanceOverview({ projectDir: opts.projectDir }, opts);
        const s = ov.ecosystem.summary;
        const lines = [
          `Ecosystem Health Score: ${ov.lint.score}/100 (errors=${ov.lint.counts.errors}, warnings=${ov.lint.counts.warnings}, secrets=${ov.lint.counts.secretHits})`,
          `Plugins: ${s.pluginsEnabled}/${s.pluginsTotal} | MCP: ${s.mcpEnabled}/${s.mcpTotal} | Skills: ${s.skillsActive}/${s.skillsTotal} | Rules: ${s.rulesActive}/${s.rulesTotal} | Hooks: ${s.hooksActive}/${s.hooksTotal}`,
          `Estimated Harness Baseline: ~${s.estimatedBaselineTokens} tokens`,
          `Snapshots: ${ov.snapshots.length} | Profiles: ${ov.profiles.length}`,
        ];
        print(ov, lines.join('\n'));
        break;
      }
      if (sub === 'lint') {
        const eco = scanEcosystem({ projectDir: opts.projectDir }, opts);
        const lint = runGovernanceLint(eco, opts);
        const lines = [
          `Lint Score: ${lint.score}/100 (errors=${lint.counts.errors}, warnings=${lint.counts.warnings}, infos=${lint.counts.infos}, scanned=${lint.counts.scannedFiles})`,
          ...lint.findings.map((f) => `  [${f.severity.toUpperCase()}] (${f.category}) ${f.message}`),
        ];
        print(lint, lines.join('\n'));
        if (lint.counts.errors > 0) process.exitCode = 1;
        break;
      }
      if (sub === 'snapshots') {
        const snaps = listSnapshots(opts);
        const lines = snaps.length
          ? snaps.map((s) => `- ${s.id}${s.baseline ? ' [BASELINE]' : ''} | ${s.createdAt} | ${s.reason} (${s.files.length} files)`)
          : ['No host config snapshots yet.'];
        print(snaps, lines.join('\n'));
        break;
      }
      if (sub === 'rollback') {
        const snapId = rest[1] || flags.id || undefined;
        const res = rollbackSnapshot(snapId, opts);
        print(res, res.message);
        break;
      }
      console.error('Usage: ctx gov <status|lint|snapshots|rollback [snapshotId]> [--json]');
      process.exit(1);
    }
    case 'wallpaper': {
      const sub = rest[0] || 'status';
      if (sub === 'status') {
        const st = getAppearanceStatus(opts);
        const s = st.state;
        const lines = [
          `Wallpaper Enabled: ${s.enabled ? 'ON' : 'OFF'} | Mode: ${s.mode} | Runtime Patched: ${st.runtimePatched ? 'YES' : 'NO'}`,
          `Preset: ${s.presetId} | Active Image: ${s.activeWallpaperPath || '(none)'}`,
          `Rotation: ${s.rotationMode} (${s.rotationMinutes}m) | Pool: ${st.poolCount} images (library ${st.library.length}, folder ${st.folder.count})`,
        ];
        print(st, lines.join('\n'));
        break;
      }
      if (sub === 'off') {
        const res = emergencyDisableWallpaper(opts);
        print(res, res.message);
        break;
      }
      if (sub === 'next') {
        const res = pickNextWallpaper(opts);
        print(res, res.message);
        break;
      }
      console.error('Usage: ctx wallpaper <status|off|next> [--json]');
      process.exit(1);
    }
    case 'review': {
      const sub = rest[0] || 'list';
      if (sub === 'scan') {
        const res = await handleReviewAction(
          {
            action: 'scan',
            projectDir: opts.projectDir,
            scope: flags.scope || 'uncommitted',
            baseRef: flags.base || undefined,
          },
          opts
        );
        const r = res.report;
        const s = r.summary || {};
        const lines = [
          `Review Scan [${r.scope}] ${r.git?.branch || 'nogit'}@${r.git?.head || 'none'} | Files: ${res.diffStats?.files ?? 0} (+${res.diffStats?.additions ?? 0}/-${res.diffStats?.deletions ?? 0})`,
          `Findings: total=${s.total ?? 0} (critical=${s.critical ?? 0}, high=${s.high ?? 0}, medium=${s.medium ?? 0}, low=${s.low ?? 0}) | Gates available: ${(res.availableGates || []).map((g) => g.id).join(', ') || 'none'}`,
          ...(r.findings || [])
            .filter((f) => !f.ignored)
            .slice(0, 20)
            .map((f) => `  [${f.severity.toUpperCase()}] (${f.source}/${f.ruleId}) ${f.file}:${f.line} - ${f.title}`),
        ];
        print(res, lines.join('\n'));
        if ((s.critical ?? 0) > 0) process.exitCode = 1;
        break;
      }
      if (sub === 'gates') {
        if (flags.run) {
          const res = await handleReviewAction(
            {
              action: 'run_gate',
              projectDir: opts.projectDir,
              gateId: String(flags.run),
            },
            opts
          );
          const g = res.gateResult;
          const lines = [
            `Gate [${g.gateId}] ${g.label}: ${g.status.toUpperCase()} (${g.durationMs}ms, findings=${g.findings?.length ?? 0})`,
            ...(g.findings || []).slice(0, 20).map((f) => `  [${f.severity.toUpperCase()}] ${f.file}:${f.line} - ${f.title}`),
          ];
          print(res, lines.join('\n'));
          if (!g.ok) process.exitCode = 1;
          break;
        }
        const st = await handleReviewAction({ action: 'status', projectDir: opts.projectDir }, opts);
        const gates = st.availableGates || [];
        const lines = gates.length
          ? gates.map((g) => `- ${g.id}: ${g.label} (${g.command} ${(g.args || []).join(' ')})`)
          : ['No native project gates detected.'];
        print({ availableGates: gates, git: st.git }, lines.join('\n'));
        break;
      }
      if (sub === 'save') {
        let rawReport = '';
        try {
          if (flags.file && typeof flags.file === 'string') {
            const stat = fs.statSync(flags.file);
            if (stat.size > MAX_REVIEW_STDIN_BYTES) {
              throw new Error(`Input file exceeds maximum allowed size (${MAX_REVIEW_STDIN_BYTES} bytes)`);
            }
            rawReport = fs.readFileSync(flags.file, 'utf8');
          } else if (flags.stdin || !process.stdin.isTTY) {
            rawReport = await readStdinUtf8(MAX_REVIEW_STDIN_BYTES);
          } else {
            throw new Error('Provide --stdin or --file <path> with JSON review output');
          }
          const res = await handleReviewAction(
            {
              action: 'ingest_report',
              projectDir: opts.projectDir,
              scope: typeof flags.scope === 'string' ? flags.scope : undefined,
              rawReport,
            },
            opts
          );
          print(res, `Saved review report ${res.report.reportId} (${res.importedCount} findings)`);
        } catch (err) {
          console.error(`Failed to save review report: ${err?.message || err}`);
          process.exit(1);
        }
        break;
      }
      if (sub === 'list') {
        if (flags.history) {
          const hist = await handleReviewAction({ action: 'history', projectDir: opts.projectDir }, opts);
          const items = hist.items || [];
          const lines = items.length
            ? items.map(
                (it) =>
                  `- ${it.reportId} | ${it.scope} | ${it.createdAt} | total=${it.summary?.total ?? 0} (C:${it.summary?.critical ?? 0} H:${it.summary?.high ?? 0} M:${it.summary?.medium ?? 0} L:${it.summary?.low ?? 0})`
              )
            : ['No review history found.'];
          print(hist, lines.join('\n'));
          break;
        }
        const st = await handleReviewAction({ action: 'status', projectDir: opts.projectDir }, opts);
        const r = st.latestReport;
        if (!r) {
          print(st, 'No review report saved yet. Run `ctx review scan` to inspect local changes.');
          break;
        }
        const s = r.summary || {};
        const lines = [
          `Latest Review: ${r.reportId} [${r.scope}] ${r.git?.branch || 'nogit'}@${r.git?.head || 'none'}`,
          `Summary: total=${s.total ?? 0} (critical=${s.critical ?? 0}, high=${s.high ?? 0}, medium=${s.medium ?? 0}, low=${s.low ?? 0}) | History: ${st.historyCount}`,
          ...(r.findings || [])
            .filter((f) => !f.ignored)
            .slice(0, 25)
            .map((f) => `  [${f.severity.toUpperCase()}] (${f.source}/${f.ruleId}) ${f.file}:${f.line} - ${f.title}`),
        ];
        print(st, lines.join('\n'));
        break;
      }
      console.error('Usage: ctx review <scan|gates|save|list> [--scope ...] [--run <gateId>] [--stdin|--file <path>] [--history] [--project <dir>] [--json]');
      process.exit(1);
    }
    default: {
      console.log(`Antigravity Hub CLI
Commands:
  brief     [--project <dir>] [--budget <n>] [--json]
  save      --title <text> --summary <text> [--kind <kind>] [--tags a,b]
  search    <query> [--kind <kind>] [--json]
  calls     [--session <id>] [--agent main|sub] [--drops] [--json]
  quota     [--json]
  doctor    [--repair] [--resync-telemetry] [--json]
  export    [--json]
  review    <scan|gates|save|list> [--scope ...] [--base <ref>] [--run <id>] [--stdin|--file <path>] [--history] [--project <dir>] [--json]
  gov       <status|lint|snapshots|rollback [snapshotId]> [--project <dir>] [--json]
  wallpaper <status|off|next> [--json]
  i18n      <status|refresh|apply|restore> [--json]`);
    }
  }
}

await main();
