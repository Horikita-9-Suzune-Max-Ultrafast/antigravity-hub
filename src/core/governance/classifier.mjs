/**
 * Multi-signal classifier for plugins and global MCP servers.
 * Combines explicit user overrides with weighted metadata signals
 * (manifest description, skill descriptions, MCP tool names, command/URL).
 */

export const CATEGORY_LABELS = {
  coding: '开发',
  office: '办公协作',
  general: '通用',
};

const OFFICE_SIGNALS = [
  { re: /\b(gmail|gdocs|gdrive|gcalendar|gsheets|gslides|google\s*(docs|drive|sheets|slides|calendar|workspace))\b/i, label: 'Google 办公' },
  { re: /\b(feishu|lark|dingtalk|wecom|wechat|slack|teams|discord)\b/i, label: '团队沟通' },
  { re: /\b(notion|obsidian|confluence|jira|linear|clickup|asana|trello|airtable|monday)\b/i, label: '文档协作' },
  { re: /\b(canva|figma|miro|excalidraw)\b/i, label: '设计协作' },
  { re: /\b(mail|email|inbox|calendar|schedule|meeting|spreadsheet|document|presentation|crm|invoice)\b/i, label: '办公文档' },
  { re: /(邮件|邮箱|日程|日历|网盘|云盘|文档|表格|幻灯片|飞书|钉钉|会议|笔记|审批|协作)/, label: '中文办公语义' },
];

const CODING_SIGNALS = [
  { re: /\b(codex|claude|git|github|gitlab|bitbucket|svn)\b/i, label: '代码仓库' },
  { re: /\b(playwright|puppeteer|selenium|cypress|chrome\s*devtools|devtools|webdriver)\b/i, label: '浏览器自动化/调试' },
  { re: /\b(docker|kubernetes|k8s|terraform|aws|gcp|azure|cloudflare|netlify|vercel|android|ios|xcode)\b/i, label: '工程与部署' },
  { re: /\b(sql|sqlite|postgres|postgresql|mysql|mongodb|redis|prisma|graphql|openapi|swagger)\b/i, label: '数据库/API' },
  { re: /\b(eslint|prettier|vitest|jest|pytest|webpack|vite|esbuild|typescript|rust|golang|python|react|vue|svelte|gsap|tailwind|frontend|backend)\b/i, label: '开发栈/测试' },
  { re: /\b(code|coding|dev|developer|debug|debugging|refactor|lint|compiler|build|sdk|cli|terminal|repo|repository|reverse\s*engineer)\b/i, label: '开发工具链' },
  { re: /(代码|编程|开发|调试|重构|前端|后端|测试|构建|部署|仓库|架构|组件|数据库|接口)/, label: '中文开发语义' },
];

function scoreText(text, signals, weight) {
  if (!text) return { score: 0, hits: [] };
  let score = 0;
  const hits = [];
  for (const sig of signals) {
    if (sig.re.test(text)) {
      score += weight;
      hits.push(sig.label);
    }
  }
  return { score, hits };
}

function summarizeClassification(codingScore, officeScore, codingHits, officeHits, sourceHint) {
  const uniqCoding = [...new Set(codingHits)].slice(0, 2);
  const uniqOffice = [...new Set(officeHits)].slice(0, 2);

  if (codingScore === 0 && officeScore === 0) {
    return {
      category: 'general',
      source: 'inferred',
      confidence: 'low',
      uncertain: true,
      reason: '未命中明确场景特征',
    };
  }

  // Require clear margin to avoid misclassifying mixed or ambiguous items
  if (officeScore >= codingScore + 2 || (officeScore > 0 && codingScore === 0)) {
    return {
      category: 'office',
      source: 'inferred',
      confidence: officeScore >= 3 ? 'high' : 'medium',
      uncertain: false,
      reason: `${sourceHint ? `${sourceHint}：` : ''}${uniqOffice.join('、') || '办公特征'}`,
    };
  }

  if (codingScore >= officeScore + 2 || (codingScore > 0 && officeScore === 0)) {
    return {
      category: 'coding',
      source: 'inferred',
      confidence: codingScore >= 3 ? 'high' : 'medium',
      uncertain: false,
      reason: `${sourceHint ? `${sourceHint}：` : ''}${uniqCoding.join('、') || '开发特征'}`,
    };
  }

  return {
    category: 'general',
    source: 'inferred',
    confidence: 'low',
    uncertain: true,
    reason: '同时包含开发与办公特征',
  };
}

/**
 * Classify a plugin using user override first, then multi-signal metadata scoring.
 */
export function classifyPlugin(plugin, { skills = [], mcpServers = [], rules = [], preferences = null } = {}) {
  const itemKey = `plugin:${plugin.id}`;
  const manual = preferences?.categories?.[itemKey];
  if (manual && CATEGORY_LABELS[manual]) {
    return {
      category: manual,
      source: 'user',
      confidence: 'high',
      uncertain: false,
      reason: `用户已标记为${CATEGORY_LABELS[manual]}`,
    };
  }

  if (plugin.systemProtected) {
    return {
      category: 'general',
      source: 'inferred',
      confidence: 'high',
      uncertain: false,
      reason: '系统核心控制台',
    };
  }

  const nameText = `${plugin.id || ''} ${plugin.displayName || ''}`;
  const descText = plugin.description || '';
  const skillText = skills.map((s) => `${s.name || ''} ${s.description || ''}`).join(' ');
  const mcpText = mcpServers
    .map((m) => `${m.shortName || m.name || ''} ${(m.toolNames || []).join(' ')} ${m.command || ''} ${(m.args || []).join(' ')}`)
    .join(' ');
  const ruleText = rules.map((r) => r.name || '').join(' ');

  const buckets = [
    { label: '名称', text: nameText, weight: 3 },
    { label: '插件描述', text: descText, weight: 2 },
    { label: 'Skill 描述', text: skillText, weight: 2 },
    { label: 'MCP 工具', text: mcpText, weight: 2 },
    { label: '规则文件', text: ruleText, weight: 1 },
  ];

  let codingScore = 0;
  let officeScore = 0;
  const codingHits = [];
  const officeHits = [];
  let topCodingSource = '';
  let topOfficeSource = '';
  let maxCodingBucket = 0;
  let maxOfficeBucket = 0;

  for (const b of buckets) {
    const c = scoreText(b.text, CODING_SIGNALS, b.weight);
    const o = scoreText(b.text, OFFICE_SIGNALS, b.weight);
    codingScore += c.score;
    officeScore += o.score;
    codingHits.push(...c.hits);
    officeHits.push(...o.hits);
    if (c.score > maxCodingBucket) {
      maxCodingBucket = c.score;
      topCodingSource = `命中${b.label}`;
    }
    if (o.score > maxOfficeBucket) {
      maxOfficeBucket = o.score;
      topOfficeSource = `命中${b.label}`;
    }
  }

  const sourceHint = officeScore > codingScore ? topOfficeSource : topCodingSource;
  return summarizeClassification(codingScore, officeScore, codingHits, officeHits, sourceHint);
}

/**
 * Classify a global MCP server using user override first, then name/command/URL/cached tool names.
 */
export function classifyGlobalMcp(server, { preferences = null } = {}) {
  const itemKey = `mcp:${server.name}`;
  const manual = preferences?.categories?.[itemKey];
  if (manual && CATEGORY_LABELS[manual]) {
    return {
      category: manual,
      source: 'user',
      confidence: 'high',
      uncertain: false,
      reason: `用户已标记为${CATEGORY_LABELS[manual]}`,
    };
  }

  const buckets = [
    { label: '服务名称', text: server.name || '', weight: 3 },
    { label: '工具列表', text: (server.toolNames || []).join(' '), weight: 2 },
    { label: '启动参数', text: `${server.command || ''} ${(server.args || []).join(' ')} ${server.url || ''}`, weight: 1 },
  ];

  let codingScore = 0;
  let officeScore = 0;
  const codingHits = [];
  const officeHits = [];
  let topCodingSource = '';
  let topOfficeSource = '';
  let maxCodingBucket = 0;
  let maxOfficeBucket = 0;

  for (const b of buckets) {
    const c = scoreText(b.text, CODING_SIGNALS, b.weight);
    const o = scoreText(b.text, OFFICE_SIGNALS, b.weight);
    codingScore += c.score;
    officeScore += o.score;
    codingHits.push(...c.hits);
    officeHits.push(...o.hits);
    if (c.score > maxCodingBucket) {
      maxCodingBucket = c.score;
      topCodingSource = `命中${b.label}`;
    }
    if (o.score > maxOfficeBucket) {
      maxOfficeBucket = o.score;
      topOfficeSource = `命中${b.label}`;
    }
  }

  const sourceHint = officeScore > codingScore ? topOfficeSource : topCodingSource;
  return summarizeClassification(codingScore, officeScore, codingHits, officeHits, sourceHint);
}
