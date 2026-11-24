import fs from 'node:fs';
import path from 'node:path';
import { formatDisplayPath, getConfigRoot, getDataPaths } from '../paths.mjs';
import { redactText } from '../redact.mjs';
import { loadGovernancePreferences } from './guardrails.mjs';

const HEAVY_MCP_TOKENS = 15000;
const HEAVY_SKILL_DESC_TOKENS = 180;

const PLACEHOLDER_HREF_RE = /^(?:url|link|href|path|file|target|dest|destination|example(?:\.[a-z]+)?|placeholder|<[^>]+>|\{[^}]+\}|path\/to\/.+|\.\.\.)$/i;

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
    return { missing: true, reason: `可执行文件不存在: ${formatDisplayPath(cmd)}` };
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
        absFile: srv.configFile,
        pluginId: srv.pluginId || null,
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

function tokenizeKeywords(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
  if (!cleaned) return new Set();
  const stop = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'user', 'asks', 'to', 'of', 'in', 'a', 'an', 'or', 'on', 'is', 'are', 'this', 'that', 'from']);
  return new Set(cleaned.split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w)));
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
    // Strip optional markdown title: (./file.md "title")
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
        absFile: sk.filePath,
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
      if (jaccard >= 0.62) {
        findings.push({
          category: 'skill',
          severity: 'info',
          code: 'SKILL_TRIGGER_OVERLAP',
          target: `${a.skill.name} ↔ ${b.skill.name}`,
          message: `Skill「${a.skill.name}」与「${b.skill.name}」触发描述高度相似（重合度 ${Math.round(jaccard * 100)}%），可能引起模型选错技能。`,
          file: a.skill.displayPath,
          absFile: a.skill.filePath,
          meta: { otherFile: b.skill.displayPath, otherSkill: b.skill.name },
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
      targets.push({ label: `Rule ${r.name}`, path: r.filePath });
    }
  }
  for (const srv of ecosystem.mcpServers || []) {
    if (srv.configFile && fs.existsSync(srv.configFile)) {
      targets.push({ label: `MCP 配置 ${srv.name}`, path: srv.configFile });
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
          targets.push({ label: `记忆库 ${proj.name}`, path: memFile });
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
        absFile: h.filePath,
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
    ...skillFindings,
    ...hookFindings,
  ];

  const prefs = loadGovernancePreferences(options);
  const ignoredSet = new Set(prefs.ignoredFindings || []);

  const enriched = rawFindings.map((f) => {
    const id = makeFindingId(f);
    const isPluginManaged = isUnderInstalledPlugins(f.absFile, options);
    const remediation = buildRemediation(f, { isPluginManaged });
    return {
      ...f,
      id,
      isPluginManaged,
      ignored: ignoredSet.has(id),
      remediation,
    };
  });

  const activeFindings = enriched.filter((f) => !f.ignored);
  const ignoredFindings = enriched.filter((f) => f.ignored);

  const errors = activeFindings.filter((f) => f.severity === 'error').length;
  const warnings = activeFindings.filter((f) => f.severity === 'warn').length;
  const infos = activeFindings.filter((f) => f.severity === 'info').length;
  const activeSecretHits = activeFindings.filter((f) => f.category === 'secret').length;
  const score = Math.max(0, 100 - errors * 20 - warnings * 8 - infos * 2);

  return {
    checkedAt: new Date().toISOString(),
    score,
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
