import { rebuildIndex } from '../../core/index-db.mjs';
import { runDoctor, exportBackup, resetCircuitBreaker, repairLocalState } from '../../core/doctor.mjs';

function toolOk(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function toolErr(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message || 'Unknown error') }],
  };
}

export async function handleCtxDoctor(args, options) {
  const data = args.repair ? await repairLocalState(options) : { report: runDoctor(options) };
  const rep = data.report;
  const text = `Doctor 状态：${rep.healthy ? '健康' : '需关注'} | 漂移 ${rep.drift.count} | 熔断 ${rep.circuit.state} | 记忆 ${rep.index.dbMemories}/${rep.index.truthMemories}`;
  return toolOk(text, data);
}

export async function handleDoctorAction(args, options) {
  if (args.action === 'diagnose') {
    return toolOk('ok', { report: runDoctor(options) });
  }
  if (args.action === 'rebuild_index') {
    const rebuild = rebuildIndex(options);
    return toolOk('rebuilt', { rebuild, report: runDoctor(options) });
  }
  if (args.action === 'export_backup') {
    const exported = exportBackup(options);
    return toolOk('exported', { exported, report: runDoctor(options) });
  }
  if (args.action === 'reset_circuit') {
    const circuit = resetCircuitBreaker(options);
    return toolOk('reset', { circuit, report: runDoctor(options) });
  }
  if (args.action === 'repair') {
    return toolOk('repaired', await repairLocalState(options));
  }
  return toolErr(`Unsupported doctor action: ${args.action}`);
}
