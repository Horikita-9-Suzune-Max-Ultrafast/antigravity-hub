import fs from 'node:fs';
import path from 'node:path';
import { formatDisplayPath, getConfigRoot, getDataPaths } from '../paths.mjs';
import { redactText } from '../redact.mjs';
import { loadGovernancePreferences } from './guardrails.mjs';

const HEAVY_MCP_EAGER_TOKENS = 15000;
const HEAVY_MCP_DEFERRED_TOKENS = 25000;
const HEAVY_SKILL_DESC_TOKENS = 180;
const OVERSIZED_RULE_TOKENS = 3000;
const SKILL_OVERLAP_THRESHOLD = 0.58;

const PLACEHOLDER_HREF_RE = /^(?:url|link|href|path|file|target|dest|destination|example(?:\.[a-z]+)?|placeholder|<[^>]+>|\{[^}]+\}|path\/to\/.+|\.\.\.)$/i;
const REDACTED_PLACEHOLDER_RE = /\[REDACTED(?:_[A-Z0-9_]+)?\]/g;
const CJK_STOP_PHRASES_RE = /(?:当用户|使用|需要|进行|支持|可以|或者|以及|通过)/g;

export const PILLAR_SPECS = {
  security: { max: 30, scale: 20, pluginFactor: 0.8, ownFactor: 1.0 },
  integrity: { max: 25, scale: 18, pluginFactor: 0.8, ownFactor: 1.0 },
  efficiency: { max: 25, scale: 22, pluginFactor: 0.35, ownFactor: 1.0 },
  hygiene: { max: 20, scale: 16, pluginFactor: 0.35, ownFactor: 1.0 },
};

export const CODE_SPECS = {
  SECRET: { pillar: 'security', severity: 'error', baseWeight: 22.0 },
  CONFIG_PARSE_ERROR: { pillar: 'integrity', severity: 'error', baseWeight: 14.0 },
  MCP_BROKEN_TARGET: { pillar: 'integrity', severity: 'error', baseWeight: 12.0 },
  MCP_INVALID_URL: { pillar: 'integrity', severity: 'error', baseWeight: 12.0 },
  SKILL_BROKEN_LINK: { pillar: 'integrity', severity: 'warn', baseWeight: 6.0 },
  MCP_EXCESSIVE_EAGER: { pillar: 'efficiency', severity: 'warn', baseWeight: 7.5 },
  MCP_HEAVY_SCHEMA: { pillar: 'efficiency', severity: 'warn', baseWeight: 8.5, deferredWeight: 1.2 },
  RULE_OVERSIZED: { pillar: 'efficiency', severity: 'warn', baseWeight: 6.5 },
  SKILL_LONG_DESC: { pillar: 'efficiency', severity: 'info', baseWeight: 2.5 },
  HOOK_LONG_TIMEOUT: { pillar: 'hygiene', severity: 'warn', baseWeight: 4.5 },
  SKILL_SHADOWED: { pillar: 'hygiene', severity: 'warn', baseWeight: 4.0 },
  SKILL_TRIGGER_OVERLAP: { pillar: 'hygiene', severity: 'info', baseWeight: 2.5 },
  SKILL_WEAK_DESC: { pillar: 'hygiene', severity: 'info', baseWeight: 2.0 },
  HOOK_PRE_TOOL_USE: { pillar: 'hygiene', severity: 'info', baseWeight: 1.5 },
};

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

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
  if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
    return { missing: true, reason: `可执行文件不存在: ${formatDisplayPath(cmd)}` };
  }
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
 * #8 MCP Offline Health & Schema Redundancy Linter (distinguishes eager vs deferred pools).
 */
export function lintMcpServers(ecosystem) {
  const findings = [];
  for (const srv of ecosystem.mcpServers || []) {
    if (!srv.enabled) continue;
    const isDeferred = srv.mode === 'deferred';
    const deferredTok = Number(srv.deferredTokens ?? (isDeferred ? srv.tokens : 0)) || 0;
    const eagerTok = Number(srv.eagerTokens ?? (isDeferred ? 0 : srv.tokens)) || 0;

    if (isDeferred) {
      if (deferredTok >= HEAVY_MCP_DEFERRED_TOKENS) {
        findings.push({
          category: 'mcp',
          severity: 'info',
          code: 'MCP_HEAVY_SCHEMA',
          target: srv.name,
          message: `懒加载 MCP「${srv.name}」工具池体积较大（约 ${(deferredTok / 1000).toFixed(1)}K deferred tokens，${srv.toolCount} tools，不占每轮常驻基线）。`,
          file: srv.displayConfigFile,
          absFile: srv.configFile,
          pluginId: srv.pluginId || null,
          meta: { deferred: true, tokens: deferredTok },
        });
      }
    } else if (eagerTok >= HEAVY_MCP_EAGER_TOKENS) {
      findings.push({
        category: 'mcp',
        severity: 'warn',
        code: 'MCP_HEAVY_SCHEMA',
        target: srv.name,
        message: `MCP「${srv.name}」常驻工具定义体积偏重（约 ${(eagerTok / 1000).toFixed(1)}K tokens，${srv.toolCount} tools），建议非必需场景下停用或改用懒加载。`,
        file: srv.displayConfigFile,
        absFile: srv.configFile,
        pluginId: srv.pluginId || null,
        meta: { deferred: false, tokens: eagerTok },
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
        absFile: srv.configFile,
        pluginId: srv.pluginId || null,
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
          absFile: srv.configFile,
          pluginId: srv.pluginId || null,
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
        absFile: srv.configFile,
        pluginId: srv.pluginId || null,
      });
    }
  }
  return findings;
}

/**
 * Bilingual keyword tokenizer combining English/alphanumeric stems (>= 3 chars)
 * and CJK character-level 2-grams (bigrams) after stripping common function phrases.
 */
export function tokenizeKeywords(text) {
  const str = String(text || '').toLowerCase();
  if (!str.trim()) return new Set();

  const stopEn = new Set([
    'the', 'and', 'for', 'with', 'use', 'when', 'user', 'asks', 'to', 'of',
    'in', 'a', 'an', 'or', 'on', 'is', 'are', 'this', 'that', 'from',
  ]);
  const tokens = new Set();

  // 1. English / alphanumeric tokens (length >= 3)
  const latinMatches = str.match(/[a-z0-9]+/g) || [];
  for (const w of latinMatches) {
    if (w.length >= 3 && !stopEn.has(w)) {
      tokens.add(w);
    }
  }

  // 2. CJK bigrams after stripping high-frequency Chinese function phrases
  const cjkCleaned = str.replace(CJK_STOP_PHRASES_RE, ' ');
  const cjkRuns = cjkCleaned.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }

  return tokens;
}

function stripMarkdownCode(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/`[^`\r\n]+`/g, '');
}

function findBrokenSkillLinks(skill) {
  const raw = safeReadText(skill.filePath);
  if (!raw || !skill.skillDir) return [];
  const text = stripMarkdownCode(raw);
  const broken = new Set();
  const re = /(?<!!)\[[^\]]+\]\(([^)\r\n]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawHref = String(m[1] || '').trim().replace(/\s+["'][^"']*["']\s*$/, '');
    const href = rawHref.split('#')[0].split('?')[0].trim();
    if (!href || /^(https?:|mailto:|file:|data:|#)/i.test(href) || href.includes('://')) continue;
    if (PLACEHOLDER_HREF_RE.test(href)) continue;
    if (path.isAbsolute(href)) continue;
    const resolved = path.resolve(skill.skillDir, href);
    if (!fs.existsSync(resolved)) {
      broken.add(href);
    }
  }
  return [...broken];
}

/**
 * #9 Skill Quality, Trigger Overlap (bilingual Jaccard >= 0.58) & Broken Reference Linter.
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
        absFile: sk.filePath,
        pluginId: sk.pluginId || null,
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
        absFile: sk.filePath,
        pluginId: sk.pluginId || null,
      });
    } else if (sk.descTokens >= HEAVY_SKILL_DESC_TOKENS) {
      findings.push({
        category: 'skill',
        severity: 'info',
        code: 'SKILL_LONG_DESC',
        target: sk.name,
        message: `Skill「${sk.name}」frontmatter 描述较长（约 ${sk.descTokens} tokens），会常驻注入每轮系统提示词。`,
        file: sk.displayPath,
        absFile: sk.filePath,
        pluginId: sk.pluginId || null,
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
        absFile: sk.filePath,
        pluginId: sk.pluginId || null,
        meta: { brokenLinks: broken.slice(0, 10) },
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
      if (jaccard >= SKILL_OVERLAP_THRESHOLD) {
        findings.push({
          category: 'skill',
          severity: 'info',
          code: 'SKILL_TRIGGER_OVERLAP',
          target: `${a.skill.name} ↔ ${b.skill.name}`,
          message: `Skill「${a.skill.name}」与「${b.skill.name}」触发描述高度相似（重合度 ${Math.round(jaccard * 100)}%），可能引起模型选错技能。`,
          file: a.skill.displayPath,
          absFile: a.skill.filePath,
          pluginId: a.skill.pluginId || null,
          meta: { otherFile: b.skill.displayPath, otherSkill: b.skill.name, jaccard: Number(jaccard.toFixed(3)) },
        });
      }
    }
  }

  return findings;
}

/**
 * Lint active Rules for oversized prompt baselines (> 3000 tokens).
 */
export function lintRules(ecosystem) {
  const findings = [];
  for (const r of ecosystem.rules || []) {
    if (!r.active) continue;
    if ((Number(r.tokens) || 0) > OVERSIZED_RULE_TOKENS) {
      findings.push({
        category: 'rule',
        severity: 'warn',
        code: 'RULE_OVERSIZED',
        target: r.displayName || r.name,
        message: `规则文件「${r.name}」体积过大（约 ${(r.tokens / 1000).toFixed(1)}K tokens，超出 3K 建议阈值），会常驻注入每轮系统提示词。`,
        file: r.displayPath,
        absFile: r.filePath,
        pluginId: r.pluginId || null,
        meta: { tokens: r.tokens },
      });
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
    if (!line) continue;
    // Strip legitimate [REDACTED...] placeholders first so unredacted secrets on the same line are still caught
    const remaining = line.replace(REDACTED_PLACEHOLDER_RE, '');
    if (!remaining.trim()) continue;
    for (const pat of AUDIT_PATTERNS) {
      if (pat.re.test(remaining)) {
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
 * Scans host configs, hooks.json, active rules, MCP configs, and Vault projects/<id>/memories/*.md & events.jsonl.
 * Never returns raw secret text (always redacted).
 */
export function auditSecrets(ecosystem, options = {}) {
  const findings = [];
  const scannedFiles = new Set();
  const targets = [];

  const configRoot = getConfigRoot(options);
  for (const rel of ['mcp_config.json', 'config.json', 'hooks.json']) {
    const p = path.join(configRoot, rel);
    if (fs.existsSync(p)) targets.push({ label: `宿主配置 ${rel}`, path: p });
  }
  for (const p of ecosystem.plugins || []) {
    if (!p.enabled || !p.dirPath) continue;
    const pHooks = path.join(p.dirPath, 'hooks.json');
    if (fs.existsSync(pHooks)) {
      targets.push({ label: `插件 Hooks ${p.id}`, path: pHooks });
    }
  }
  for (const h of ecosystem.hooks || []) {
    if (h.active && h.filePath && fs.existsSync(h.filePath)) {
      targets.push({ label: `Hook 配置 ${h.sourceLabel || path.basename(h.filePath)}`, path: h.filePath });
    }
  }
  for (const r of ecosystem.rules || []) {
    if (r.filePath && fs.existsSync(r.filePath)) {
      targets.push({ label: `Rule ${r.name}`, path: r.filePath });
    }
  }
  for (const srv of ecosystem.mcpServers || []) {
    if (srv.configFile && fs.existsSync(srv.configFile)) {
      targets.push({ label: `MCP 配置 ${srv.name}`, path: srv.configFile });
    }
  }

  // Scan Hub's external Vault projects/<projectId>/memories/*.md and events.jsonl
  const { projectsDir } = getDataPaths(options);
  if (fs.existsSync(projectsDir)) {
    try {
      for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const projPath = path.join(projectsDir, proj.name);
        const memDir = path.join(projPath, 'memories');
        if (fs.existsSync(memDir)) {
          try {
            for (const entry of fs.readdirSync(memDir, { withFileTypes: true })) {
              if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
              targets.push({
                label: `记忆库 ${proj.name}/${entry.name}`,
                path: path.join(memDir, entry.name),
              });
            }
          } catch {
            // ignore unreadable memory dir
          }
        }
        const eventsFile = path.join(projPath, 'events.jsonl');
        if (fs.existsSync(eventsFile)) {
          targets.push({ label: `记忆事件日志 ${proj.name}`, path: eventsFile });
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
        absFile: t.path,
      });
    }
  }

  return {
    scannedFilesCount: scannedFiles.size,
    findings,
  };
}

function isUnderInstalledPlugins(absPath, options = {}) {
  if (!absPath || typeof absPath !== 'string') return false;
  const pluginsRoot = path.resolve(getConfigRoot(options), 'plugins').toLowerCase();
  const resolved = path.resolve(absPath).toLowerCase();
  return resolved === pluginsRoot || resolved.startsWith(`${pluginsRoot}${path.sep}`);
}

function makeFindingId(f) {
  const linePart = f.line ? `:${f.line}` : '';
  return `${f.code || 'LINT'}::${f.target || ''}::${f.file || ''}${linePart}`;
}

function resolveFindingSpec(finding) {
  const code = String(finding?.code || '');
  if (code.startsWith('SECRET_')) {
    return { pillar: 'security', baseWeight: CODE_SPECS.SECRET.baseWeight };
  }
  if (code === 'MCP_HEAVY_SCHEMA') {
    const isDeferred = Boolean(finding?.meta?.deferred) || finding?.severity === 'info';
    return {
      pillar: 'efficiency',
      baseWeight: isDeferred ? CODE_SPECS.MCP_HEAVY_SCHEMA.deferredWeight : CODE_SPECS.MCP_HEAVY_SCHEMA.baseWeight,
    };
  }
  const spec = CODE_SPECS[code];
  if (spec) {
    return { pillar: spec.pillar, baseWeight: spec.baseWeight };
  }
  return { pillar: 'hygiene', baseWeight: 2.0 };
}

/**
 * Continuous baseline penalty curve B(T) for active eager prompt baseline tokens.
 */
export function computeBaselinePenalty(baselineTokens = 0) {
  const T = Math.max(0, Number(baselineTokens) || 0);
  if (T <= 8000) return 0;
  if (T <= 32000) {
    return 14 * Math.pow((T - 8000) / 24000, 1.35);
  }
  return 14 + 10 * (1 - Math.exp(-(T - 32000) / 28000));
}

function sortCodeGroup(items) {
  return [...items].sort((a, b) => {
    const ownDiff = Number(Boolean(a.isPluginManaged)) - Number(Boolean(b.isPluginManaged));
    if (ownDiff !== 0) return ownDiff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function computeGroupPenalty(items) {
  const ordered = sortCodeGroup(items);
  let sum = 0;
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    const spec = resolveFindingSpec(f);
    const pSpec = PILLAR_SPECS[spec.pillar];
    const ownFactor = f.isPluginManaged ? pSpec.pluginFactor : pSpec.ownFactor;
    sum += (spec.baseWeight * ownFactor) / Math.sqrt(i + 1);
  }
  return sum;
}

/**
 * Pure 4-pillar continuous diminishing scoring engine (§4.2).
 * Computes exact pillar scores, overall grade, and counterfactual `+impactPts` per active finding.
 */
export function computeGovernanceScore(findings = [], baselineTokens = 0) {
  const active = (Array.isArray(findings) ? findings : []).filter((f) => !f.ignored);
  const byCode = new Map();
  for (const f of active) {
    const codeKey = String(f.code || 'UNKNOWN');
    let list = byCode.get(codeKey);
    if (!list) {
      list = [];
      byCode.set(codeKey, list);
    }
    list.push(f);
  }

  const penalties = { security: 0, integrity: 0, efficiency: 0, hygiene: 0 };
  const groupPenaltyCache = new Map();

  for (const [codeKey, list] of byCode.entries()) {
    const ordered = sortCodeGroup(list);
    let groupPen = 0;
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i];
      const spec = resolveFindingSpec(f);
      const pSpec = PILLAR_SPECS[spec.pillar];
      const ownFactor = f.isPluginManaged ? pSpec.pluginFactor : pSpec.ownFactor;
      const eff = (spec.baseWeight * ownFactor) / Math.sqrt(i + 1);
      penalties[spec.pillar] += eff;
      groupPen += eff;
    }
    groupPenaltyCache.set(codeKey, { ordered, groupPen });
  }

  const basePenalty = computeBaselinePenalty(baselineTokens);
  penalties.efficiency += basePenalty;

  const pillarExact = {};
  const pillars = {};
  let scoreExact = 0;
  for (const [pillarId, pSpec] of Object.entries(PILLAR_SPECS)) {
    const pen = penalties[pillarId];
    const sVal = pSpec.max * Math.exp(-pen / pSpec.scale);
    pillarExact[pillarId] = sVal;
    scoreExact += sVal;
    pillars[pillarId] = {
      score: Number(sVal.toFixed(2)),
      max: pSpec.max,
      penalty: Number(pen.toFixed(2)),
    };
  }

  const score = Math.max(0, Math.min(100, Math.round(scoreExact)));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';

  // Counterfactual +impactPts per active finding
  const impactById = new Map();
  for (const [codeKey, { ordered }] of groupPenaltyCache.entries()) {
    for (let idx = 0; idx < ordered.length; idx++) {
      const target = ordered[idx];
      const spec = resolveFindingSpec(target);
      const pSpec = PILLAR_SPECS[spec.pillar];
      // Recompute penalty for this code group without target (same pillar for all items of a code)
      const remaining = ordered.filter((_, j) => j !== idx);
      const oldGroupPen = groupPenaltyCache.get(codeKey).groupPen;
      const newGroupPen = computeGroupPenalty(remaining);
      const newPillarPen = Math.max(0, penalties[spec.pillar] - oldGroupPen + newGroupPen);
      const newPillarScore = pSpec.max * Math.exp(-newPillarPen / pSpec.scale);
      const delta = newPillarScore - pillarExact[spec.pillar];
      const impactPts = Math.max(0.1, Number(delta.toFixed(1)));
      impactById.set(target.id || `${codeKey}#${idx}`, impactPts);
    }
  }

  return {
    score,
    scoreExact: Number(scoreExact.toFixed(2)),
    grade,
    baselineTokens: Math.max(0, Math.round(Number(baselineTokens) || 0)),
    baselinePenalty: Number(basePenalty.toFixed(2)),
    pillars,
    impactById,
  };
}

function buildRemediation(finding, { isPluginManaged }) {
  const fileRef = finding.file || finding.target || '目标文件';
  const pluginNote = isPluginManaged
    ? '\n注意：该文件位于已安装插件目录，直接修改可能在插件更新后被覆盖；请先向我说明改动方案并确认后再编辑。'
    : '';

  if (finding.category === 'secret') {
    const lineInfo = finding.line ? `第 ${finding.line} 行` : '对应行';
    return {
      strategy: 'secret_manual',
      summary: '建议改为环境变量占位符或移出配置文件；若为本地受控测试凭据，可点「忽略」消除告警。',
      prompt: [
        `请帮我排查并安全改造 Antigravity 生态体检发现的疑似明文凭据问题：`,
        `- 问题：${finding.message}`,
        `- 文件：${fileRef}（${lineInfo}）`,
        `安全要求：`,
        `1. 禁止在你的回复、日志或解释中回显任何原始密钥或 Token 原文。`,
        `2. 先检查该配置是否支持通过环境变量引用（如 \${ENV_VAR}）或系统凭据管理替代硬编码；若支持，请给出改造方案并帮我替换为占位符。`,
        `3. 如果该服务或插件确实不支持环境变量，请说明原因并给出最小暴露面建议。`,
        pluginNote.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  switch (finding.code) {
    case 'RULE_OVERSIZED':
      return {
        strategy: 'agent',
        summary: '拆分或精简超长常驻规则文件至 3000 tokens 以内，将按需指南迁移至 Skill。',
        prompt: [
          `请帮我瘦身以下超长常驻规则文件，降低每轮系统提示词常驻 Token 占用：`,
          `- 目标：${finding.target}`,
          `- 文件：${fileRef}`,
          `- 现状：${finding.message}`,
          `要求：通读该规则文件，保留必须每轮生效的核心硬约束（控制在 2500 tokens 内），将低频流程与参考手册拆分为按需加载的 Skill 或参考文档。${pluginNote}`,
        ].join('\n'),
      };
    case 'SKILL_LONG_DESC':
      return {
        strategy: 'agent',
        summary: '压缩 frontmatter description 到 120 tokens 以内，保留核心触发词，减少每轮常驻消耗。',
        prompt: [
          `请帮我优化以下 Skill 的 frontmatter description，降低每轮系统提示词常驻 Token 占用：`,
          `- 目标：${finding.target}`,
          `- 文件：${fileRef}`,
          `- 现状：${finding.message}`,
          `要求：读取该 SKILL.md，仅精简 frontmatter 中的 description 字段（目标压缩至 100–130 tokens 左右），完整保留核心触发场景与关键词，不要删改正文流程。${pluginNote}`,
        ].join('\n'),
      };
    case 'SKILL_WEAK_DESC':
      return {
        strategy: 'agent',
        summary: '为该 Skill 补充明确的适用场景与触发关键词，避免模型漏触发。',
        prompt: [
          `请帮我补全以下 Skill 的 frontmatter description：`,
          `- 目标：${finding.target}`,
          `- 文件：${fileRef}`,
          `要求：通读该 SKILL.md 正文，提炼出清晰简洁的触发描述（60–120 tokens），明确“何时使用 / 何时不用”，并更新到 frontmatter 的 description 字段。${pluginNote}`,
        ].join('\n'),
      };
    case 'SKILL_BROKEN_LINK': {
      const links = finding.meta?.brokenLinks?.length ? `（${finding.meta.brokenLinks.join(', ')}）` : '';
      return {
        strategy: 'agent',
        summary: '检查并修正 SKILL.md 中失效的相对文件引用，或将示例代码包裹进代码块。',
        prompt: [
          `请帮我修复以下 Skill 中的断链引用问题：`,
          `- 目标：${finding.target}`,
          `- 文件：${fileRef}`,
          `- 检测到缺失路径：${finding.message}${links}`,
          `要求：检查该 SKILL.md 及其所在目录，确认缺失引用是路径拼写错误、文件已移动还是示例占位符；修正真实断链或将示例写法放入反引号代码块中。${pluginNote}`,
        ].join('\n'),
      };
    }
    case 'SKILL_TRIGGER_OVERLAP':
      return {
        strategy: 'agent',
        summary: '区分两个高重合 Skill 的触发边界，防止模型选错技能。',
        prompt: [
          `请帮我区分以下两个触发描述高度重合的 Skill：`,
          `- 冲突项：${finding.target}`,
          `- 文件 A：${fileRef}`,
          finding.meta?.otherFile ? `- 文件 B：${finding.meta.otherFile}` : '',
          `要求：对比两者的 SKILL.md 正文与 frontmatter description，明确各自边界与互斥条件，给出差异化改写方案并在确认后更新。${pluginNote}`,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    case 'SKILL_SHADOWED':
      return {
        strategy: 'local_toggle',
        summary: '存在同名 Skill 覆盖，可在「生效栈」查看优先级，或停用不需要的来源插件。',
        actionTargetTab: 'harness',
        searchHint: finding.target,
        prompt: [
          `请帮我排查同名 Skill 覆盖问题：`,
          `- 现象：${finding.message}`,
          `- 被覆盖文件：${fileRef}`,
          `要求：对比同名 Skill 的两个版本，判断是否需要删除/重命名旧版，或保留当前高优先级覆盖。${pluginNote}`,
        ].join('\n'),
      };
    case 'MCP_HEAVY_SCHEMA':
    case 'MCP_EXCESSIVE_EAGER':
      return {
        strategy: 'local_toggle',
        summary: '建议在「插件/MCP」按需停用，或通过「场景预设」在非必需工作流中关闭。',
        actionTargetTab: 'extensions',
        searchHint: finding.pluginId || finding.target,
        prompt: null,
      };
    case 'MCP_BROKEN_TARGET':
    case 'MCP_INVALID_URL':
      return {
        strategy: 'agent',
        summary: '检查对应 MCP 的可执行路径、脚本位置或端点 URL，也可以在「插件/MCP」直接停用。',
        actionTargetTab: 'extensions',
        searchHint: finding.pluginId || finding.target,
        prompt: [
          `请帮我排查并修复以下 MCP Server 配置异常：`,
          `- 目标：${finding.target}`,
          `- 异常：${finding.message}`,
          `- 配置文件：${fileRef}`,
          `要求：检查配置文件中的 command / args / url 路径是否有效、是否存在空格转义或缺失产物问题，确认后给出修复方案。${pluginNote}`,
        ].join('\n'),
      };
    case 'HOOK_LONG_TIMEOUT':
    case 'HOOK_PRE_TOOL_USE':
      return {
        strategy: 'agent',
        summary: '复核该 Hook 脚本的执行耗时与超时上限，避免拖慢每轮工具调用。',
        prompt: [
          `请帮我审查以下 Antigravity Hook 的性能与稳定性配置：`,
          `- 目标：${finding.target}`,
          `- 提示：${finding.message}`,
          `- 文件：${fileRef}`,
          `要求：检查该 Hook 脚本的阻塞风险与 timeout 设置，若无需拦截每次工具调用或超时过大，请提出精简优化建议。${pluginNote}`,
        ].join('\n'),
      };
    default:
      return {
        strategy: 'agent',
        summary: '检查对应配置文件的 JSON 语法与结构合法性。',
        prompt: [
          `请帮我检查并修复以下 Antigravity 配置异常：`,
          `- 问题：${finding.message}`,
          `- 文件：${fileRef}`,
          `要求：定位语法或结构错误并在修改前说明变更内容。${pluginNote}`,
        ].join('\n'),
      };
  }
}

/**
 * Run all offline linters (#8 MCP, #9 Skill, Rule size, #10 Secret Audit, Hook hygiene)
 * and compute 4-pillar continuous health score + counterfactual `+impactPts`.
 */
export function runGovernanceLint(ecosystem, options = {}) {
  const mcpFindings = lintMcpServers(ecosystem);
  const skillFindings = lintSkills(ecosystem);
  const ruleFindings = lintRules(ecosystem);
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
        absFile: h.filePath,
        pluginId: h.pluginId || null,
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
        absFile: h.filePath,
        pluginId: h.pluginId || null,
      });
    }
  }

  const rawFindings = [
    ...secretAudit.findings,
    ...(ecosystem.configIssues || []).map((c) => ({
      category: 'config',
      severity: c.severity || 'error',
      code: 'CONFIG_PARSE_ERROR',
      target: c.file,
      message: c.message,
      file: c.file,
      absFile: c.absFile || null,
    })),
    ...mcpFindings,
    ...ruleFindings,
    ...skillFindings,
    ...hookFindings,
  ];

  const prefs = loadGovernancePreferences(options);
  const ignoredSet = new Set(prefs.ignoredFindings || []);

  const enriched = rawFindings.map((f) => {
    const id = makeFindingId(f);
    const isPluginManaged = Boolean(f.pluginId) || isUnderInstalledPlugins(f.absFile, options);
    const remediation = buildRemediation(f, { isPluginManaged });
    const spec = resolveFindingSpec(f);
    return {
      ...f,
      id,
      pillar: spec.pillar,
      isPluginManaged,
      ignored: ignoredSet.has(id),
      remediation,
    };
  });

  const baselineTokens = Number(ecosystem?.summary?.estimatedBaselineTokens) || 0;
  const scoring = computeGovernanceScore(enriched, baselineTokens);

  const activeFindings = enriched
    .filter((f) => !f.ignored)
    .map((f) => ({
      ...f,
      impactPts: scoring.impactById.get(f.id) ?? 0.1,
    }))
    .sort((a, b) => {
      const rankDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      const impDiff = (b.impactPts || 0) - (a.impactPts || 0);
      if (impDiff !== 0) return impDiff;
      return String(a.id).localeCompare(String(b.id));
    });

  const ignoredFindings = enriched
    .filter((f) => f.ignored)
    .map((f) => ({
      ...f,
      impactPts: 0,
    }));

  const errors = activeFindings.filter((f) => f.severity === 'error').length;
  const warnings = activeFindings.filter((f) => f.severity === 'warn').length;
  const infos = activeFindings.filter((f) => f.severity === 'info').length;
  const activeSecretHits = activeFindings.filter((f) => f.category === 'secret').length;

  return {
    checkedAt: new Date().toISOString(),
    score: scoring.score,
    scoreExact: scoring.scoreExact,
    grade: scoring.grade,
    baselineTokens: scoring.baselineTokens,
    pillars: scoring.pillars,
    counts: {
      total: activeFindings.length,
      ignored: ignoredFindings.length,
      errors,
      warnings,
      infos,
      secretHits: activeSecretHits,
      scannedFiles: secretAudit.scannedFilesCount,
    },
    findings: activeFindings,
    ignoredFindings,
  };
}
