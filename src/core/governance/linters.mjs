import fs from 'node:fs';
import path from 'node:path';
import { formatDisplayPath, getConfigRoot, getDataPaths } from '../paths.mjs';
import { redactText } from '../redact.mjs';

const HEAVY_MCP_TOKENS = 15000;
const HEAVY_SKILL_DESC_TOKENS = 180;

function safeReadText(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch {
    // ignore
  }
  return '';
}

function isCommandLikelyMissing(cmd, args, configFile) {
  if (!cmd || typeof cmd !== 'string') return { missing: true, reason: '缺少 command 可执行命令' };
  // Absolute path command check
  if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
    return { missing: true, reason: `可执行文件不存在: ${cmd}` };
  }
  // Check local script paths inside args (e.g. node ${PLUGIN_ROOT}/dist/server.mjs)
  const pluginRoot = configFile ? path.dirname(configFile) : '';
  for (const rawArg of args || []) {
    if (typeof rawArg !== 'string') continue;
    const expanded = rawArg
      .replace(/\$\{PLUGIN_ROOT\}/g, pluginRoot)
      .replace(/\$\{AGY_PLUGIN_ROOT\}/g, pluginRoot);
    if (/\.(mjs|cjs|js|py|ps1|sh|exe)$/i.test(expanded) && path.isAbsolute(expanded)) {
      if (!fs.existsSync(expanded)) {
        return { missing: true, reason: `脚本目标不存在: ${formatDisplayPath(expanded)}` };
      }
    }
  }
  return { missing: false, reason: null };
}

/**
 * #8 MCP Offline Health & Schema Redundancy Linter
 */
export function lintMcpServers(ecosystem) {
  const findings = [];
  for (const srv of ecosystem.mcpServers || []) {
    if (!srv.enabled) continue;
    if (srv.tokens >= HEAVY_MCP_TOKENS) {
      findings.push({
        category: 'mcp',
        severity: 'warn',
        code: 'MCP_HEAVY_SCHEMA',
        target: srv.name,
        message: `MCP「${srv.name}」工具定义体积偏重（约 ${(srv.tokens / 1000).toFixed(1)}K tokens，${srv.toolCount} tools），建议非必需场景下停用或检查懒加载。`,
        file: srv.displayConfigFile,
      });
    }
    if (srv.eagerCount >= 8) {
      findings.push({
        category: 'mcp',
        severity: 'warn',
        code: 'MCP_EXCESSIVE_EAGER',
        target: srv.name,
        message: `MCP「${srv.name}」常驻（eager）工具达 ${srv.eagerCount} 个，会固定占用每轮系统提示词。`,
        file: srv.displayConfigFile,
      });
    }
    if (srv.transport === 'stdio') {
      const check = isCommandLikelyMissing(srv.command, srv.args, srv.configFile);
      if (check.missing) {
        findings.push({
          category: 'mcp',
          severity: 'error',
          code: 'MCP_BROKEN_TARGET',
          target: srv.name,
          message: `MCP「${srv.name}」启动目标异常：${check.reason}`,
          file: srv.displayConfigFile,
        });
      }
    } else if (srv.transport === 'http' && !/^https?:\/\//i.test(srv.url || '')) {
      findings.push({
        category: 'mcp',
        severity: 'error',
        code: 'MCP_INVALID_URL',
        target: srv.name,
        message: `MCP「${srv.name}」远程端点 URL 无效`,
        file: srv.displayConfigFile,
      });
    }
  }
  return findings;
}

function tokenizeKeywords(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
  if (!cleaned) return new Set();
  const stop = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'user', 'asks', 'to', 'of', 'in', 'a', 'an', 'or', 'on', 'is', 'are', 'this', 'that', 'from']);
  return new Set(cleaned.split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w)));
}

function findBrokenSkillLinks(skill) {
  const text = safeReadText(skill.filePath);
  if (!text || !skill.skillDir) return [];
  const broken = [];
  const re = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const href = String(m[1] || '').trim().split('#')[0];
    if (!href || /^(https?:|mailto:|file:|#)/i.test(href) || href.includes('://')) continue;
    if (path.isAbsolute(href)) continue;
    const resolved = path.resolve(skill.skillDir, href);
    if (!fs.existsSync(resolved)) {
      broken.push(href);
    }
  }
  return broken;
}

/**
 * #9 Skill Quality, Trigger Overlap & Broken Reference Linter
 */
export function lintSkills(ecosystem) {
  const findings = [];
  const activeSkills = (ecosystem.skills || []).filter((s) => s.active);

  for (const sk of activeSkills) {
    if (sk.shadowedBy) {
      findings.push({
        category: 'skill',
        severity: 'warn',
        code: 'SKILL_SHADOWED',
        target: sk.name,
        message: `Skill「${sk.name}」（${sk.sourceLabel}）被更高优先级的「${sk.shadowedBy}」同名覆盖，当前不会生效。`,
        file: sk.displayPath,
      });
    }
    if (!sk.description || sk.description.trim().length < 12) {
      findings.push({
        category: 'skill',
        severity: 'info',
        code: 'SKILL_WEAK_DESC',
        target: sk.name,
        message: `Skill「${sk.name}」缺少有效 description，模型可能难以在正确时机触发。`,
        file: sk.displayPath,
      });
    } else if (sk.descTokens >= HEAVY_SKILL_DESC_TOKENS) {
      findings.push({
        category: 'skill',
        severity: 'info',
        code: 'SKILL_LONG_DESC',
        target: sk.name,
        message: `Skill「${sk.name}」frontmatter 描述较长（约 ${sk.descTokens} tokens），会常驻注入每轮系统提示词。`,
        file: sk.displayPath,
      });
    }
    const broken = findBrokenSkillLinks(sk);
    if (broken.length > 0) {
      findings.push({
        category: 'skill',
        severity: 'warn',
        code: 'SKILL_BROKEN_LINK',
        target: sk.name,
        message: `Skill「${sk.name}」包含 ${broken.length} 处断链引用（如 ${broken.slice(0, 2).join(', ')}）。`,
        file: sk.displayPath,
      });
    }
  }

  // Detect high-overlap trigger descriptions among non-builtin active skills
  const userSkills = activeSkills.filter((s) => !s.shadowedBy && s.scope !== 'builtin');
  const kwList = userSkills.map((s) => ({ skill: s, kws: tokenizeKeywords(s.description) }));
  for (let i = 0; i < kwList.length; i++) {
    for (let j = i + 1; j < kwList.length; j++) {
      const a = kwList[i];
      const b = kwList[j];
      if (a.kws.size < 6 || b.kws.size < 6) continue;
      let inter = 0;
      for (const w of a.kws) {
        if (b.kws.has(w)) inter++;
      }
      const jaccard = inter / (a.kws.size + b.kws.size - inter);
      if (jaccard >= 0.62) {
        findings.push({
          category: 'skill',
          severity: 'info',
          code: 'SKILL_TRIGGER_OVERLAP',
          target: `${a.skill.name} ↔ ${b.skill.name}`,
          message: `Skill「${a.skill.name}」与「${b.skill.name}」触发描述高度相似（重合度 ${Math.round(jaccard * 100)}%），可能引起模型选错技能。`,
          file: a.skill.displayPath,
        });
      }
    }
  }

  return findings;
}

const AUDIT_PATTERNS = [
  { id: 'PEM_KEY', label: 'PEM 私钥', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'OPENAI_ANTHROPIC_KEY', label: 'API Key (sk-*)', re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'GOOGLE_KEY', label: 'Google API Key (AIza*)', re: /\bAIza[0-9A-Za-z_-]{28,}\b/ },
  { id: 'GITHUB_TOKEN', label: 'GitHub Token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'AWS_KEY', label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'BEARER_TOKEN', label: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { id: 'SLACK_TOKEN', label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{14,}\b/ },
  { id: 'URL_BASIC_AUTH', label: 'URL 明文凭据', re: /https?:\/\/[^/\s:@]+:[^/\s@]{4,}@/i },
];

function scanFileForSecrets(absPath) {
  const hits = [];
  const text = safeReadText(absPath);
  if (!text) return hits;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.includes('[REDACTED')) continue;
    for (const pat of AUDIT_PATTERNS) {
      if (pat.re.test(line)) {
        hits.push({
          line: i + 1,
          kind: pat.label,
          code: pat.id,
          redactedSnippet: redactText(line).trim().slice(0, 120),
        });
        break;
      }
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

/**
 * #10 Offline Privacy & Secret Leak Auditor
 * Scans host configs, active rules, and external vault files strictly offline;
 * never returns raw secret text (always redacted).
 */
export function auditSecrets(ecosystem, options = {}) {
  const findings = [];
  const scannedFiles = new Set();
  const targets = [];

  const configRoot = getConfigRoot(options);
  for (const rel of ['mcp_config.json', 'config.json']) {
    const p = path.join(configRoot, rel);
    if (fs.existsSync(p)) targets.push({ label: `宿主配置 ${rel}`, path: p });
  }
  for (const r of ecosystem.rules || []) {
    if (r.filePath && fs.existsSync(r.filePath)) {
      targets.push({ label: `Rule · ${r.name}`, path: r.filePath });
    }
  }
  for (const srv of ecosystem.mcpServers || []) {
    if (srv.configFile && fs.existsSync(srv.configFile)) {
      targets.push({ label: `MCP 配置 · ${srv.name}`, path: srv.configFile });
    }
  }

  // Also scan Hub's own external projects memories for accidental leaks
  const { projectsDir } = getDataPaths(options);
  if (fs.existsSync(projectsDir)) {
    try {
      for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const memFile = path.join(projectsDir, proj.name, 'memories.jsonl');
        if (fs.existsSync(memFile)) {
          targets.push({ label: `记忆库 · ${proj.name}`, path: memFile });
        }
      }
    } catch {
      // ignore
    }
  }

  for (const t of targets) {
    const key = path.resolve(t.path).toLowerCase();
    if (scannedFiles.has(key)) continue;
    scannedFiles.add(key);
    const hits = scanFileForSecrets(t.path);
    for (const h of hits) {
      findings.push({
        category: 'secret',
        severity: 'error',
        code: `SECRET_${h.code}`,
        target: t.label,
        line: h.line,
        message: `疑似明文 ${h.kind}（第 ${h.line} 行）：${h.redactedSnippet}`,
        file: formatDisplayPath(t.path),
      });
    }
  }

  return {
    scannedFilesCount: scannedFiles.size,
    findings,
  };
}

/**
 * Run all three offline linters (#8 MCP, #9 Skill, #10 Secret Audit) + Hook hygiene checks.
 */
export function runGovernanceLint(ecosystem, options = {}) {
  const mcpFindings = lintMcpServers(ecosystem);
  const skillFindings = lintSkills(ecosystem);
  const secretAudit = auditSecrets(ecosystem, options);

  const hookFindings = [];
  for (const h of ecosystem.hooks || []) {
    if (!h.active) continue;
    if (h.isPreToolUse) {
      hookFindings.push({
        category: 'hook',
        severity: 'info',
        code: 'HOOK_PRE_TOOL_USE',
        target: `${h.sourceLabel} (${h.event})`,
        message: `检测到 PreToolUse 钩子，每次工具执行前都会触发，请确认其耗时与稳定性。`,
        file: h.displayPath,
      });
    }
    if (h.timeout && h.timeout > 15) {
      hookFindings.push({
        category: 'hook',
        severity: 'warn',
        code: 'HOOK_LONG_TIMEOUT',
        target: `${h.sourceLabel} (${h.event})`,
        message: `钩子超时设置为 ${h.timeout}s，若脚本阻塞可能明显拖慢会话响应。`,
        file: h.displayPath,
      });
    }
  }

  const allFindings = [
    ...secretAudit.findings,
    ...(ecosystem.configIssues || []).map((c) => ({
      category: 'config',
      severity: c.severity || 'error',
      code: 'CONFIG_PARSE_ERROR',
      target: c.file,
      message: c.message,
      file: c.file,
    })),
    ...mcpFindings,
    ...skillFindings,
    ...hookFindings,
  ];

  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warn').length;
  const infos = allFindings.filter((f) => f.severity === 'info').length;
  const score = Math.max(0, 100 - errors * 20 - warnings * 8 - infos * 2);

  return {
    checkedAt: new Date().toISOString(),
    score,
    counts: {
      total: allFindings.length,
      errors,
      warnings,
      infos,
      secretHits: secretAudit.findings.length,
      scannedFiles: secretAudit.scannedFilesCount,
    },
    findings: allFindings,
  };
}
