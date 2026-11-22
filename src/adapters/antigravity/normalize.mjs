import { getDataPaths } from '../../core/paths.mjs';
import { appendJsonl, ensureDataDirs } from '../../core/storage.mjs';
import { redactObject } from '../../core/redact.mjs';

const KNOWN_KEYS = new Set([
  'conversationId',
  'conversation_id',
  'workspacePaths',
  'workspace_paths',
  'transcriptPath',
  'transcript_path',
  'artifactDirectoryPath',
  'artifact_directory_path',
  'modelName',
  'model_name',
  'model',
  'lastUserInput',
  'last_user_input',
  'hookEventName',
  'hook_event_name',
  'event',
  'cwd',
  'working_directory',
  'invocationNum',
  'invocation_num',
  'initialNumSteps',
  'initial_num_steps',
  'executionNum',
  'execution_num',
  'terminationReason',
  'termination_reason',
  'error',
  'fullyIdle',
  'fully_idle',
  'continuationActive',
  'continuation_active',
  'toolCall',
  'tool_call',
  'stepIdx',
  'step_idx',
  'stepIndex',
  'step_index',
]);

const SNAKE_COMPAT_KEYS = [
  'conversation_id',
  'workspace_paths',
  'transcript_path',
  'artifact_directory_path',
  'model_name',
  'hook_event_name',
  'invocation_num',
  'continuation_active',
  'termination_reason',
  'working_directory',
];

/**
 * Normalize Antigravity Hook stdin payload across schema versions (camelCase & snake_case)
 * and record sanitized contract drift observations without ever throwing.
 */
export function normalizeHookPayload(raw, fallbackEvent = '', options = {}) {
  const driftReasons = [];
  let payload = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      payload = {};
      driftReasons.push('empty_payload');
    } else {
      try {
        payload = JSON.parse(trimmed);
      } catch (err) {
        recordDrift(
          {
            event: fallbackEvent || 'unknown',
            reasons: ['malformed_json'],
            error: err.message,
            rawPreview: trimmed.slice(0, 240),
          },
          options
        );
        return {
          ok: false,
          malformed: true,
          event: fallbackEvent || 'unknown',
          normalized: null,
          driftReasons: ['malformed_json'],
        };
      }
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    recordDrift(
      {
        event: fallbackEvent || 'unknown',
        reasons: ['non_object_payload'],
        payloadType: Array.isArray(payload) ? 'array' : typeof payload,
      },
      options
    );
    return {
      ok: false,
      malformed: true,
      event: fallbackEvent || 'unknown',
      normalized: null,
      driftReasons: ['non_object_payload'],
    };
  }

  const keys = Object.keys(payload);
  const unknownKeys = keys.filter((k) => !KNOWN_KEYS.has(k));
  const snakeKeys = keys.filter((k) => SNAKE_COMPAT_KEYS.includes(k));

  if (unknownKeys.length > 0) driftReasons.push(`unknown_keys:${unknownKeys.slice(0, 10).join(',')}`);
  if (snakeKeys.length > 0) driftReasons.push(`snake_case_fallback:${snakeKeys.slice(0, 10).join(',')}`);

  const workspacePathsRaw = payload.workspacePaths ?? payload.workspace_paths;
  const workspacePaths = Array.isArray(workspacePathsRaw)
    ? workspacePathsRaw.map(String).filter(Boolean)
    : typeof workspacePathsRaw === 'string' && workspacePathsRaw
      ? [workspacePathsRaw]
      : [];

  const cwd = String(payload.cwd ?? payload.working_directory ?? workspacePaths[0] ?? '').trim();
  const event = String(payload.hookEventName ?? payload.hook_event_name ?? payload.event ?? fallbackEvent ?? '').trim();
  const conversationId = String(payload.conversationId ?? payload.conversation_id ?? '').trim();
  const transcriptPath = String(payload.transcriptPath ?? payload.transcript_path ?? '').trim();
  const artifactDirectoryPath = String(payload.artifactDirectoryPath ?? payload.artifact_directory_path ?? '').trim();
  const modelName = String(payload.modelName ?? payload.model_name ?? payload.model ?? '').trim();
  const lastUserInput = String(payload.lastUserInput ?? payload.last_user_input ?? '').trim();

  if (!conversationId) driftReasons.push('missing_conversation_id');

  const normalized = {
    event,
    conversationId,
    workspacePaths,
    projectDir: cwd || workspacePaths[0] || '',
    transcriptPath,
    artifactDirectoryPath,
    modelName,
    lastUserInput,
    invocationNum: Number(payload.invocationNum ?? payload.invocation_num ?? 0) || 0,
    initialNumSteps: Number(payload.initialNumSteps ?? payload.initial_num_steps ?? 0) || 0,
    executionNum: Number(payload.executionNum ?? payload.execution_num ?? 0) || 0,
    terminationReason: String(payload.terminationReason ?? payload.termination_reason ?? ''),
    error: String(payload.error ?? ''),
    fullyIdle: Boolean(payload.fullyIdle ?? payload.fully_idle ?? true),
    continuationActive: Boolean(payload.continuationActive ?? payload.continuation_active ?? false),
  };

  if (driftReasons.length > 0) {
    recordDrift(
      {
        event: normalized.event || fallbackEvent || 'unknown',
        reasons: driftReasons,
        unknownKeys,
        sample: redactObject(payload),
      },
      options
    );
  }

  return {
    ok: true,
    malformed: false,
    event: normalized.event,
    normalized,
    driftReasons,
  };
}

export function recordDrift(entry, options = {}) {
  try {
    const paths = ensureDataDirs(options);
    appendJsonl(paths.driftLogFile, {
      ts: new Date().toISOString(),
      ...redactObject(entry),
    });
  } catch {
    // Drift logging must never crash the hook
  }
}
