import { ensureDataDirs, readJsonSafe, atomicWriteJson } from '../../core/storage.mjs';
import { redactText } from '../../core/redact.mjs';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function getCircuitState(options = {}) {
  const paths = ensureDataDirs(options);
  const now = options.nowMs ?? Date.now();
  const data = readJsonSafe(paths.circuitFile, { failures: 0, openUntil: 0, lastError: null });
  const isOpen = Boolean(data.openUntil && now < data.openUntil);
  return {
    state: isOpen ? 'OPEN' : 'CLOSED',
    isOpen,
    failures: Number(data.failures) || 0,
    openUntil: Number(data.openUntil) || 0,
    lastError: data.lastError || null,
  };
}

export function recordHookSuccess(options = {}) {
  try {
    const paths = ensureDataDirs(options);
    const cur = readJsonSafe(paths.circuitFile, { failures: 0, openUntil: 0, lastError: null });
    if (cur.failures > 0 || cur.openUntil > 0) {
      atomicWriteJson(paths.circuitFile, {
        failures: 0,
        openUntil: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // never crash hook
  }
}

export function recordHookFailure(error, options = {}) {
  try {
    const paths = ensureDataDirs(options);
    const now = options.nowMs ?? Date.now();
    const threshold = Number(options.threshold) || DEFAULT_THRESHOLD;
    const cooldownMs = Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS;
    const cur = readJsonSafe(paths.circuitFile, { failures: 0, openUntil: 0, lastError: null });
    const failures = (Number(cur.failures) || 0) + 1;
    const openUntil = failures >= threshold ? now + cooldownMs : 0;
    const next = {
      failures,
      openUntil,
      lastError: redactText(String(error?.message || error || 'unknown error')).slice(0, 300),
      updatedAt: new Date(now).toISOString(),
    };
    atomicWriteJson(paths.circuitFile, next);
    return {
      state: openUntil > now ? 'OPEN' : 'CLOSED',
      isOpen: openUntil > now,
      ...next,
    };
  } catch {
    return { state: 'CLOSED', isOpen: false, failures: 0, openUntil: 0 };
  }
}
