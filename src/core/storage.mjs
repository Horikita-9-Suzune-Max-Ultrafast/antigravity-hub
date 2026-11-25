import fs from 'node:fs';
import path from 'node:path';
import { getDataPaths } from './paths.mjs';
import { atomicWriteFileSafe } from './fs-utils.mjs';

const ENSURED_DATA_DIRS = new Set();
const MAX_ENSURED_DIRS = 64;

export function clearEnsuredDirsCache() {
  ENSURED_DATA_DIRS.clear();
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureDataDirs(options = {}) {
  const paths = getDataPaths(options);
  const key = process.platform === 'win32' ? path.resolve(paths.dataDir).toLowerCase() : path.resolve(paths.dataDir);
  if (ENSURED_DATA_DIRS.has(key) && fs.existsSync(paths.dataDir)) {
    return paths;
  }
  ensureDir(paths.dataDir);
  ensureDir(paths.projectsDir);
  ensureDir(paths.telemetryDir);
  ensureDir(paths.diagnosticsDir);
  ensureDir(paths.exportsDir);
  if (ENSURED_DATA_DIRS.size >= MAX_ENSURED_DIRS) {
    const oldest = ENSURED_DATA_DIRS.values().next().value;
    if (oldest !== undefined) ENSURED_DATA_DIRS.delete(oldest);
  }
  ENSURED_DATA_DIRS.add(key);
  return paths;
}

/**
 * Atomic file write using Windows EPERM/EBUSY-resilient fs-utils implementation.
 */
export function atomicWriteFile(filePath, content) {
  atomicWriteFileSafe(filePath, content);
}

export function atomicWriteJson(filePath, data) {
  atomicWriteFileSafe(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Append one JSON object line to an append-only JSONL truth-source file.
 */
export function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Append multiple JSON object lines in a single batched write syscall.
 */
export function appendJsonlBatch(filePath, records) {
  if (!Array.isArray(records) || records.length === 0) return;
  ensureDir(path.dirname(filePath));
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, payload, 'utf8');
}

/**
 * Read a JSONL file tolerating malformed or truncated lines.
 */
export function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Skip partial/corrupt lines
    }
  }
  return items;
}

/**
 * Serialize a memory record to Markdown with JSON-safe frontmatter values.
 */
export function serializeMemoryMarkdown(mem) {
  const fm = [
    '---',
    `id: ${JSON.stringify(mem.id)}`,
    `project_id: ${JSON.stringify(mem.projectId)}`,
    `branch: ${JSON.stringify(mem.branch || 'main')}`,
    `head: ${JSON.stringify(mem.head || 'none')}`,
    `kind: ${JSON.stringify(mem.kind || 'decision')}`,
    `title: ${JSON.stringify(mem.title || '')}`,
    `tags: ${JSON.stringify(Array.isArray(mem.tags) ? mem.tags : [])}`,
    `archived: ${mem.archived ? 'true' : 'false'}`,
    `created_at: ${JSON.stringify(mem.createdAt)}`,
    `updated_at: ${JSON.stringify(mem.updatedAt)}`,
    '---',
    '',
    String(mem.summary || '').trim(),
    '',
  ];
  return fm.join('\n');
}

/**
 * Parse a Markdown truth-source memory file back to an object.
 */
export function parseMemoryMarkdown(content, filePath = '') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  const headerLines = match[1].split(/\r?\n/);
  const body = match[2].trim();
  const meta = {};
  for (const line of headerLines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    try {
      meta[k] = JSON.parse(rawVal);
    } catch {
      meta[k] = rawVal;
    }
  }
  if (!meta.id || !meta.project_id) return null;
  return {
    id: String(meta.id),
    projectId: String(meta.project_id),
    branch: String(meta.branch || 'main'),
    head: String(meta.head || 'none'),
    kind: String(meta.kind || 'decision'),
    title: String(meta.title || ''),
    summary: body,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    archived: Boolean(meta.archived),
    createdAt: String(meta.created_at || new Date().toISOString()),
    updatedAt: String(meta.updated_at || meta.created_at || new Date().toISOString()),
    filePath,
  };
}

/**
 * Scan all Markdown truth-source memory files across all projects.
 */
export function scanAllMemoryFiles(options = {}) {
  const { projectsDir } = getDataPaths(options);
  if (!fs.existsSync(projectsDir)) return [];
  const results = [];
  for (const projEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const memDir = path.join(projectsDir, projEntry.name, 'memories');
    if (!fs.existsSync(memDir)) continue;
    for (const fileEntry of fs.readdirSync(memDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.md')) continue;
      const fullPath = path.join(memDir, fileEntry.name);
      try {
        const parsed = parseMemoryMarkdown(fs.readFileSync(fullPath, 'utf8'), fullPath);
        if (parsed) results.push(parsed);
      } catch {
        // Ignore unreadable file
      }
    }
  }
  return results;
}
