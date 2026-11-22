const SECRET_PATTERNS = [
  // PEM private keys
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  // Authorization Bearer tokens
  {
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: '$1[REDACTED_TOKEN]',
  },
  // JWT tokens (3 dot-separated base64url segments starting with eyJ)
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: '[REDACTED_JWT]',
  },
  // OpenAI / Anthropic / Google / GitHub / GitLab / Slack / AWS keys
  {
    re: /\b(sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,})\b/g,
    replace: '[REDACTED_API_KEY]',
  },
  {
    re: /\b(AIza[0-9A-Za-z_-]{28,})\b/g,
    replace: '[REDACTED_GOOGLE_KEY]',
  },
  {
    re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    re: /\b(glpat-[A-Za-z0-9_-]{16,})\b/g,
    replace: '[REDACTED_GITLAB_TOKEN]',
  },
  {
    re: /\b(xox[baprs]-[A-Za-z0-9-]{14,})\b/g,
    replace: '[REDACTED_SLACK_TOKEN]',
  },
  {
    re: /\b(AKIA[0-9A-Z]{16})\b/g,
    replace: '[REDACTED_AWS_KEY]',
  },
  // URL basic auth credentials: https://user:pass@host
  {
    re: /(https?:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi,
    replace: '$1[REDACTED_SECRET]$3',
  },
  // Generic key=value / "api_key": "..." assignments
  {
    re: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|csrf[_-]?token)\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})(["']?)/gi,
    replace: '$1[REDACTED]$3',
  },
];

/**
 * Redact sensitive credentials from plain text.
 */
export function redactText(input) {
  if (input == null) return '';
  let out = String(input);
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

const SENSITIVE_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential|csrf)/i;

/**
 * Recursively redact sensitive values in arbitrary JSON-compatible structures.
 */
export function redactObject(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactObject(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
