import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../core/config.mjs';
import { buildCompactBrief, saveMemory, pruneAutoStopCheckpoints } from '../../core/vault.mjs';
import {
  recordHookTiming,
  syncConversationTelemetry,
  formatUserMarkdownBanner,
  calcWeightedAvgTps,
} from '../../core/telemetry.mjs';
import { recordActiveSession } from '../../core/session-tracker.mjs';
import { normalizeHookPayload } from './normalize.mjs';
import { getCircuitState, recordHookFailure, recordHookSuccess } from './circuit-breaker.mjs';

/**
 * Pure programmatic hook handler for testing and CLI execution.
 * Always Fail-Open: returns a valid Antigravity hook JSON object (default {}).
 */
export async function handleHookEvent(rawInput, fallbackEvent = '', options = {}) {
  const circuit = getCircuitState(options);
  if (circuit.isOpen) {
    return {};
  }

  try {
    const parsed = normalizeHookPayload(rawInput, fallbackEvent, options);
    if (!parsed.ok || !parsed.normalized) {
      return {};
    }

    const p = parsed.normalized;
    const event = p.event || fallbackEvent;
    const config = loadConfig(options);

    // Track active conversation + workspace for real-time monitor auto-follow across all views
    if (
      p.conversationId &&
      (event === 'SessionStart' || event === 'PreInvocation' || event === 'PostInvocation' || event === 'Stop')
    ) {
      recordActiveSession(
        {
          conversationId: p.conversationId,
          projectDir: p.projectDir,
          transcriptPath: p.transcriptPath,
          source: 'hook',
          event,
          updatedAtMs: options.nowMs ?? Date.now(),
        },
        options
      );
    }

    if (event === 'SessionStart') {
      if (!p.projectDir) {
        recordHookSuccess(options);
        return {};
      }
      const brief = buildCompactBrief(
        {
          projectDir: p.projectDir,
          budgetTokens: config.sessionStartBudgetTokens,
        },
        options
      );
      recordHookSuccess(options);
      if (!brief.text) return {};
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: brief.text,
            },
          },
        ],
      };
    }

    if (event === 'PreInvocation') {
      if (p.conversationId) {
        recordHookTiming(
          {
            conversationId: p.conversationId,
            phase: 'pre',
            invocationNum: p.invocationNum,
            timestampMs: options.nowMs ?? Date.now(),
          },
          options
        );
      }
      recordHookSuccess(options);
      return {};
    }

    if (event === 'PostInvocation') {
      if (p.conversationId) {
        recordHookTiming(
          {
            conversationId: p.conversationId,
            phase: 'post',
            invocationNum: p.invocationNum,
            timestampMs: options.nowMs ?? Date.now(),
          },
          options
        );
      }
      const synced = syncConversationTelemetry(
        {
          conversationId: p.conversationId || undefined,
          transcriptPath: p.transcriptPath || undefined,
        },
        options
      );
      recordHookSuccess(options);

      if (config.uiBanner?.enabled && synced.calls.length > 0) {
        const latestMain = synced.calls.find((c) => c.agentType === 'main') || synced.calls[0];
        const banner = formatUserMarkdownBanner(latestMain);
        if (banner) {
          return {
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: '',
                  metadata: {
                    user_markdown: banner,
                  },
                },
              },
            ],
          };
        }
      }
      return {};
    }

    if (event === 'Stop') {
      if (p.continuationActive === true) {
        recordHookSuccess(options);
        return {};
      }
      const synced = syncConversationTelemetry(
        {
          conversationId: p.conversationId || undefined,
          transcriptPath: p.transcriptPath || undefined,
        },
        options
      );

      if (p.projectDir && synced.calls.length > 0 && p.terminationReason !== 'USER_CANCELED') {
        const latest = synced.calls.find((c) => c.agentType === 'main') || synced.calls[0];
        const totalCost = synced.calls.reduce((s, c) => s + c.estimatedCostUsd, 0);
        const avgTps = calcWeightedAvgTps(synced.calls);
        const goalHint = p.lastUserInput
          ? p.lastUserInput.replace(/<\/?USER_REQUEST>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 72)
          : `会话 ${p.conversationId.slice(0, 8)}`;

        const stopCheckpointId = p.conversationId
          ? `mem_stop_${crypto.createHash('sha256').update(String(p.conversationId)).digest('hex').slice(0, 12)}`
          : undefined;

        const saved = saveMemory(
          {
            id: stopCheckpointId,
            projectDir: p.projectDir,
            kind: 'checkpoint',
            title: `Stop 自动快照：${goalHint}`,
            summary: `模型 ${latest.model}，均速 ${avgTps.toFixed(1)} tok/s，最新缓存命中 ${latest.cacheHitRate.toFixed(1)}%，共 ${synced.calls.length} 步，累计估算 $${totalCost.toFixed(3)}。`,
            tags: ['auto-stop'],
          },
          options
        );
        pruneAutoStopCheckpoints(saved.projectId, { maxKeep: 30 }, options);
      }

      recordHookSuccess(options);
      return {};
    }

    // Unknown/unsupported hook event -> Fail-Open silently
    recordHookSuccess(options);
    return {};
  } catch (err) {
    recordHookFailure(err, options);
    return {};
  }
}

function readStdinWithTimeout(timeoutMs = 3500) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => done(data), timeoutMs);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) done(data);
    });
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(data));
    process.stdin.resume();
  });
}

function parseCliArgs(argv) {
  const args = { event: '', dataDir: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event' && argv[i + 1]) {
      args.event = argv[++i];
    } else if (argv[i].startsWith('--event=')) {
      args.event = argv[i].slice('--event='.length);
    } else if (argv[i] === '--data-dir' && argv[i + 1]) {
      args.dataDir = argv[++i];
    } else if (argv[i].startsWith('--data-dir=')) {
      args.dataDir = argv[i].slice('--data-dir='.length);
    }
  }
  return args;
}

async function runCli() {
  let responded = false;
  const emitAndExit = (obj) => {
    if (responded) return;
    responded = true;
    try {
      process.stdout.write(JSON.stringify(obj ?? {}) + '\n');
    } catch {
      process.stdout.write('{}\n');
    }
    process.exit(0);
  };

  // Hard 4.5s fail-open watchdog (strictly under 5s)
  const hardTimeoutMs = Math.min(4800, Math.max(200, Number(process.env.CONTEXT_CACHE_HOOK_TIMEOUT_MS) || 4500));
  const watchdog = setTimeout(() => {
    emitAndExit({});
  }, hardTimeoutMs);
  watchdog.unref?.();

  process.on('uncaughtException', (err) => {
    recordHookFailure(err);
    emitAndExit({});
  });
  process.on('unhandledRejection', (err) => {
    recordHookFailure(err);
    emitAndExit({});
  });

  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const options = {};
    if (cli.dataDir) options.dataDir = cli.dataDir;

    if (process.env.CONTEXT_CACHE_FORCE_HOOK_ERROR === '1') {
      throw new Error('Injected test hook failure');
    }

    const rawStdin = await readStdinWithTimeout(Math.min(2500, hardTimeoutMs - 150));
    const result = await handleHookEvent(rawStdin, cli.event, options);
    emitAndExit(result);
  } catch (err) {
    recordHookFailure(err);
    emitAndExit({});
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli();
}
