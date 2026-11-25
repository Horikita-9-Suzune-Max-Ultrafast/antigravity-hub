import crypto from 'node:crypto';
import path from 'node:path';
import { BLOCKED_SECRET_FILE_RE } from '../fs-utils.mjs';
import { redactText } from '../redact.mjs';

export const SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const AUDIT_PATTERNS = [
  { id: 'PEM_KEY', label: 'PEM private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'OPENAI_ANTHROPIC_KEY', label: 'API Key (sk-*)', re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'GOOGLE_KEY', label: 'Google API Key (AIza*)', re: /\bAIza[0-9A-Za-z_-]{28,}\b/ },
  { id: 'GITHUB_TOKEN', label: 'GitHub Token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'GITLAB_TOKEN', label: 'GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'AWS_KEY', label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'BEARER_TOKEN', label: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { id: 'SLACK_TOKEN', label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{14,}\b/ },
  { id: 'URL_BASIC_AUTH', label: 'URL embedded credentials', re: /https?:\/\/[^/\s:@]+:[^/\s@]{4,}@/i },
];

const SECRET_EXEMPTION_RE = /(?:\[REDACTED|REDACTED|EXAMPLE|PLACEHOLDER|DUMMY|FAKE_?(?:KEY|TOKEN|SECRET)|YOUR_[A-Z0-9_]+)/i;
const MERGE_CONFLICT_RE = /^(?:<{7}|={7}|>{7})(?:\s|$)/;
const JS_TS_EXT_RE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const PY_EXT_RE = /\.py$/i;
const UI_PATH_RE = /^src\/ui\//i;
const SOURCE_FILE_EXT_RE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|scala|css|scss|html|vue|svelte|ps1|sh)$/i;
const COMMENT_ONLY_RE = /^\s*(?:\/\/|\/\*|\*\/?(?:\s|$)|#)/;

const EVAL_RE = /\beval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;
const SHELL_TRUE_RE = /\bshell\s*:\s*true\b/;
const CHILD_PROC_HINT_RE = /\b(?:child_process|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b/;
const EMPTY_CATCH_SINGLE_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
const EMPTY_CATCH_OPEN_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/;
const JS_DEBUGGER_RE = /(?:^|[^\w.$'"`])debugger\s*(?:;|\s*$|\s*\/\/|\s*\/\*)/;
const PY_BREAKPOINT_RE = /(?:^|[^\w.'"#])breakpoint\s*\(\s*\)/;
const CONSOLE_DEBUG_RE = /\bconsole\.(?:log|debug)\s*\(/;

const LARGE_NEW_FILE_LINES = 900;
const LARGE_NEW_FILE_BYTES = 64 * 1024;

/**
 * Deterministic finding ID hash matching §1.2-4 contract:
 * `rf_${sha256(`${ruleId}|${file}|${line}|${title}`).slice(0, 12)}`
 */
export function makeReviewFindingId({ ruleId, file, line, title }) {
  const payload = `${String(ruleId || '')}|${String(file || '')}|${Number(line) || 1}|${String(title || '')}`;
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
  return `rf_${hash}`;
}

function scrubSnippet(rawLine, matchedPattern) {
  let safe = redactText(String(rawLine || ''));
  safe = safe.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  if (matchedPattern && matchedPattern.re) {
    safe = safe.replace(new RegExp(matchedPattern.re.source, matchedPattern.re.flags.includes('g') ? matchedPattern.re.flags : `${matchedPattern.re.flags}g`), '[REDACTED_SECRET]');
  }
  return safe.trim().replace(/\u00b7/g, '/').slice(0, 160);
}

function createStaticFinding({ severity, category, ruleId, file, line, endLine, title, detail, suggestion }) {
  const cleanTitle = redactText(String(title || '')).replace(/\u00b7/g, '/');
  const cleanDetail = redactText(String(detail || '')).replace(/\u00b7/g, '/');
  const cleanSuggestion = suggestion ? redactText(String(suggestion)).replace(/\u00b7/g, '/') : undefined;
  const lineNum = Math.max(1, Math.floor(Number(line) || 1));

  const finding = {
    id: makeReviewFindingId({ ruleId, file, line: lineNum, title: cleanTitle }),
    source: 'static',
    severity,
    category,
    ruleId,
    file,
    line: lineNum,
    title: cleanTitle,
    detail: cleanDetail,
    confidence: 1.0,
    ignored: false,
  };
  if (endLine && endLine >= lineNum) {
    finding.endLine = Math.floor(endLine);
  }
  if (cleanSuggestion) {
    finding.suggestion = cleanSuggestion;
  }
  return finding;
}

export function sortReviewFindings(findings) {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9;
    const sb = SEVERITY_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    const fc = String(a.file || '').localeCompare(String(b.file || ''));
    if (fc !== 0) return fc;
    return (Number(a.line) || 1) - (Number(b.line) || 1);
  });
}

function isBuildUiSyntaxCheckExempt(filePath, content) {
  if (/build-ui\.mjs$/i.test(filePath)) {
    if (/(?:syntax|verify|check|校验|review-ignore)/i.test(content)) {
      return true;
    }
  }
  return /review-ignore|eslint-disable/i.test(content);
}

/**
 * Run all 8 deterministic L1 static review rules (0 tokens, millisecond execution).
 * Line-level rules strictly scan `hunk.addedLines` only so unmodified legacy code never triggers false positives.
 */
export function runStaticReviewRules(diffResult) {
  if (!diffResult || typeof diffResult !== 'object') {
    return [];
  }

  const findings = [];
  const seenIds = new Set();
  const pushFinding = (f) => {
    if (!seenIds.has(f.id)) {
      seenIds.add(f.id);
      findings.push(f);
    }
  };

  const files = Array.isArray(diffResult.files) ? diffResult.files : [];
  const skippedFiles = Array.isArray(diffResult.skippedFiles) ? diffResult.skippedFiles : [];

  // File-level rules on skipped files (e.g., binary .p12/.key files or >64KiB untracked/staged new files)
  for (const sf of skippedFiles) {
    if (!sf?.path || sf.status === 'D') continue;
    const baseName = path.posix.basename(sf.path);
    if (BLOCKED_SECRET_FILE_RE.test(baseName)) {
      pushFinding(
        createStaticFinding({
          severity: 'critical',
          category: 'security',
          ruleId: 'REV_SECRET_FILE',
          file: sf.path,
          line: 1,
          title: `Sensitive credential file detected: ${baseName}`,
          detail: `File "${sf.path}" matches sensitive credential filename policy and must not be committed.`,
          suggestion: 'Remove this file from the repository, add a matching pattern to .gitignore, and rotate any exposed credentials.',
        })
      );
    }
    if (
      sf.status === 'A' &&
      sf.reason === 'oversized_diff' &&
      SOURCE_FILE_EXT_RE.test(sf.path) &&
      Number(sf.bytes) > LARGE_NEW_FILE_BYTES
    ) {
      const kb = (Number(sf.bytes) / 1024).toFixed(1);
      pushFinding(
        createStaticFinding({
          severity: 'medium',
          category: 'maintainability',
          ruleId: 'REV_LARGE_NEW_FILE',
          file: sf.path,
          line: 1,
          title: `Large newly added source file (${kb} KiB)`,
          detail: `New source file "${sf.path}" is ${kb} KiB (exceeds 64 KiB threshold), which hurts reviewability and modularity.`,
          suggestion: 'Consider splitting cohesive responsibilities into smaller focused modules.',
        })
      );
    }
  }

  for (const file of files) {
    if (!file?.path) continue;
    const filePath = file.path;
    const baseName = path.posix.basename(filePath);
    const isJsTs = JS_TS_EXT_RE.test(filePath);
    const isPy = PY_EXT_RE.test(filePath);
    const isUiBrowser = UI_PATH_RE.test(filePath) && isJsTs && !/build-ui\.mjs$/i.test(baseName);

    // Rule 1: REV_SECRET_FILE
    if (file.status !== 'D' && BLOCKED_SECRET_FILE_RE.test(baseName)) {
      pushFinding(
        createStaticFinding({
          severity: 'critical',
          category: 'security',
          ruleId: 'REV_SECRET_FILE',
          file: filePath,
          line: 1,
          title: `Sensitive credential file detected: ${baseName}`,
          detail: `File "${filePath}" matches sensitive credential filename policy and must not be committed.`,
          suggestion: 'Remove this file from version control, add it to .gitignore, and use environment variables or a secret manager.',
        })
      );
    }

    // Rule 8: REV_LARGE_NEW_FILE
    if (file.status === 'A' && SOURCE_FILE_EXT_RE.test(filePath)) {
      const lineCount = Number(file.lineCount) || Number(file.additions) || 0;
      const bytes = Number(file.bytes) || 0;
      if (lineCount > LARGE_NEW_FILE_LINES || bytes > LARGE_NEW_FILE_BYTES) {
        const kb = (bytes / 1024).toFixed(1);
        pushFinding(
          createStaticFinding({
            severity: 'medium',
            category: 'maintainability',
            ruleId: 'REV_LARGE_NEW_FILE',
            file: filePath,
            line: 1,
            title: `Large newly added source file (${lineCount} lines / ${kb} KiB)`,
            detail: `New source file "${filePath}" has ${lineCount} lines (${kb} KiB), exceeding the 900 lines / 64 KiB maintainability threshold.`,
            suggestion: 'Decompose this module into smaller, single-responsibility files to keep changes easy to review and maintain.',
          })
        );
      }
    }

    if (file.status === 'D') continue;

    const hunks = Array.isArray(file.hunks) ? file.hunks : [];
    for (const hunk of hunks) {
      const addedLines = Array.isArray(hunk.addedLines) ? hunk.addedLines : [];
      const hunkHasChildProcHint = CHILD_PROC_HINT_RE.test(hunk.contextPatch || '');

      for (let i = 0; i < addedLines.length; i++) {
        const entry = addedLines[i];
        const lineNum = entry.line;
        const content = String(entry.content ?? '');
        const trimmed = content.trim();
        if (!trimmed) continue;

        // Rule 3: REV_MERGE_CONFLICT (check even before comment filtering)
        if (MERGE_CONFLICT_RE.test(content)) {
          pushFinding(
            createStaticFinding({
              severity: 'critical',
              category: 'correctness',
              ruleId: 'REV_MERGE_CONFLICT',
              file: filePath,
              line: lineNum,
              title: 'Unresolved Git merge conflict marker',
              detail: `Added line ${lineNum} contains an unresolved conflict marker: ${trimmed.slice(0, 60)}`,
              suggestion: 'Resolve the merge conflict completely and remove all <<<<<<<, =======, and >>>>>>> markers.',
            })
          );
        }

        // Rule 2: REV_HARDCODED_SECRET (check even inside comments, unless explicitly redacted/example)
        if (!SECRET_EXEMPTION_RE.test(content)) {
          for (const pat of AUDIT_PATTERNS) {
            if (pat.re.test(content)) {
              const snippet = scrubSnippet(content, pat);
              pushFinding(
                createStaticFinding({
                  severity: 'critical',
                  category: 'security',
                  ruleId: 'REV_HARDCODED_SECRET',
                  file: filePath,
                  line: lineNum,
                  title: `Hardcoded secret detected (${pat.label})`,
                  detail: `Line ${lineNum} appears to contain a plaintext ${pat.label}: ${snippet}`,
                  suggestion: 'Remove the hardcoded secret immediately, load it from environment variables or a secret store, and rotate the credential if exposed.',
                })
              );
              break;
            }
          }
        }

        const isCommentOnly = COMMENT_ONLY_RE.test(content);
        if (isCommentOnly) continue;

        // Rule 4: REV_DANGEROUS_EXEC
        if (isJsTs) {
          let dangerKind = null;
          if (EVAL_RE.test(content)) {
            dangerKind = 'eval()';
          } else if (NEW_FUNCTION_RE.test(content) && !isBuildUiSyntaxCheckExempt(filePath, content)) {
            dangerKind = 'new Function()';
          } else if (SHELL_TRUE_RE.test(content) && (CHILD_PROC_HINT_RE.test(content) || hunkHasChildProcHint)) {
            dangerKind = 'child_process with shell: true';
          }
          if (dangerKind) {
            pushFinding(
              createStaticFinding({
                severity: 'high',
                category: 'security',
                ruleId: 'REV_DANGEROUS_EXEC',
                file: filePath,
                line: lineNum,
                title: `Dangerous dynamic execution: ${dangerKind}`,
                detail: `Line ${lineNum} introduces ${dangerKind}, which risks code or command injection: ${scrubSnippet(content)}`,
                suggestion:
                  dangerKind === 'child_process with shell: true'
                    ? 'Use execFile/spawn with an explicit argument array and avoid shell: true.'
                    : 'Replace dynamic code evaluation with static logic or safe structured parsing.',
              })
            );
          }
        }

        // Rule 5: REV_EMPTY_CATCH
        if (isJsTs) {
          const hasInlineExplainComment = /\/\/|\/\*/.test(content);
          if (EMPTY_CATCH_SINGLE_RE.test(content) && !hasInlineExplainComment) {
            pushFinding(
              createStaticFinding({
                severity: 'medium',
                category: 'reliability',
                ruleId: 'REV_EMPTY_CATCH',
                file: filePath,
                line: lineNum,
                title: 'Empty catch block silently swallows errors',
                detail: `Line ${lineNum} contains an empty catch block without explanation: ${scrubSnippet(content)}`,
                suggestion: 'Handle or log the error, or add an explicit comment (such as /* fail-open */) if swallowing is intentional.',
              })
            );
          } else if (EMPTY_CATCH_OPEN_RE.test(content)) {
            const next = addedLines[i + 1];
            if (next && next.line === lineNum + 1 && /^\s*\}\s*$/.test(String(next.content || ''))) {
              pushFinding(
                createStaticFinding({
                  severity: 'medium',
                  category: 'reliability',
                  ruleId: 'REV_EMPTY_CATCH',
                  file: filePath,
                  line: lineNum,
                  endLine: next.line,
                  title: 'Empty catch block silently swallows errors',
                  detail: `Lines ${lineNum}-${next.line} contain an empty catch block without error handling or explanation.`,
                  suggestion: 'Handle or log the error, or document the intentional fallback with an explicit comment inside the catch block.',
                })
              );
            }
          }
        }

        // Rule 6: REV_DEBUGGER_STMT
        if (isJsTs && JS_DEBUGGER_RE.test(content)) {
          pushFinding(
            createStaticFinding({
              severity: 'high',
              category: 'hygiene',
              ruleId: 'REV_DEBUGGER_STMT',
              file: filePath,
              line: lineNum,
              title: 'Leftover debugger statement',
              detail: `Line ${lineNum} contains a debugger statement that will pause execution in dev tools: ${scrubSnippet(content)}`,
              suggestion: 'Remove the debugger statement before committing.',
            })
          );
        } else if (isPy && PY_BREAKPOINT_RE.test(content)) {
          pushFinding(
            createStaticFinding({
              severity: 'high',
              category: 'hygiene',
              ruleId: 'REV_DEBUGGER_STMT',
              file: filePath,
              line: lineNum,
              title: 'Leftover Python breakpoint() call',
              detail: `Line ${lineNum} contains a breakpoint() call that halts execution: ${scrubSnippet(content)}`,
              suggestion: 'Remove the breakpoint() call before committing.',
            })
          );
        }

        // Rule 7: REV_CONSOLE_DEBUG (browser UI code under src/ui/** only)
        if (isUiBrowser && CONSOLE_DEBUG_RE.test(content)) {
          pushFinding(
            createStaticFinding({
              severity: 'low',
              category: 'hygiene',
              ruleId: 'REV_CONSOLE_DEBUG',
              file: filePath,
              line: lineNum,
              title: 'Debug console output in browser UI code',
              detail: `Line ${lineNum} calls console.log/debug in UI module "${filePath}": ${scrubSnippet(content)}`,
              suggestion: 'Remove temporary console debug statements from production UI code.',
            })
          );
        }
      }
    }
  }

  return sortReviewFindings(findings);
}
