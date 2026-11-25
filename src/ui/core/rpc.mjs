/**
 * Unified App-Only RPC client with `lastRev` short-circuit caching
 * and concurrent in-flight request deduplication.
 */

const REV_CACHEABLE_TOOLS = new Set(['app_get_context_breakdown', 'app_get_calls']);

function buildInFlightKey(name, args) {
  try {
    return `${name}:${JSON.stringify(args || {})}`;
  } catch {
    return '';
  }
}

function isReadOnlyDedupeCall(name, args) {
  if (name === 'app_get_context_breakdown' && args?.action !== 'preview_asset') return true;
  if (name === 'app_get_calls') return true;
  if (name === 'app_config_manage' && args?.action === 'get') return true;
  if (name === 'app_review_manage' && args?.action === 'status') return true;
  return false;
}

export function createRpcClient({
  getMcpApp,
  popoutToken = null,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
} = {}) {
  const revCache = new Map(); // cacheKey -> { rev, data }
  const inFlight = new Map(); // reqKey -> Promise

  async function invokeRaw(name, args) {
    if (popoutToken) {
      if (!fetchImpl) throw new Error('fetch is not available in popout mode');
      const resp = await fetchImpl(`/api/tool?token=${encodeURIComponent(popoutToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cc-token': popoutToken },
        body: JSON.stringify({ name, arguments: args }),
      });
      const res = await resp.json();
      if (res?.isError) throw new Error(res.content?.[0]?.text || 'Tool call failed');
      return res?.structuredContent ?? res;
    }

    const mcpApp = typeof getMcpApp === 'function' ? getMcpApp() : getMcpApp;
    if (!mcpApp) throw new Error('MCP App not connected');
    const res = await mcpApp.callServerTool({ name, arguments: args });
    if (res?.isError) throw new Error(res.content?.[0]?.text || 'Tool call failed');
    return res?.structuredContent ?? res;
  }

  function buildRevCacheKey(name, args) {
    const clean = { ...(args || {}) };
    delete clean.lastRev;
    delete clean.force;
    return `${name}:${JSON.stringify(clean)}`;
  }

  async function callAppTool(name, args = {}, options = {}) {
    const useRev =
      Boolean(options.useRevCache) &&
      REV_CACHEABLE_TOOLS.has(name) &&
      !args.force &&
      args.action !== 'preview_asset';

    const payloadArgs = { ...(args || {}) };
    const revKey = useRev ? buildRevCacheKey(name, payloadArgs) : '';
    const cachedEntry = useRev ? revCache.get(revKey) : null;

    if (useRev && cachedEntry?.rev && !payloadArgs.lastRev) {
      payloadArgs.lastRev = cachedEntry.rev;
    }

    const dedupe = !options.noDedupe && isReadOnlyDedupeCall(name, payloadArgs);
    const flightKey = dedupe ? buildInFlightKey(name, payloadArgs) : '';
    if (flightKey && inFlight.has(flightKey)) {
      return await inFlight.get(flightKey);
    }

    const promise = (async () => {
      const result = await invokeRaw(name, payloadArgs);
      if (useRev && result && typeof result === 'object') {
        if (result.unchanged && cachedEntry) {
          return {
            ...cachedEntry.data,
            unchanged: true,
            rev: result.rev || cachedEntry.rev,
          };
        }
        if (typeof result.rev === 'string' && result.rev) {
          revCache.set(revKey, { rev: result.rev, data: result });
        }
      }
      return result;
    })();

    if (flightKey) {
      inFlight.set(flightKey, promise);
      promise.finally(() => {
        if (inFlight.get(flightKey) === promise) {
          inFlight.delete(flightKey);
        }
      });
    }

    return await promise;
  }

  function invalidateRev(toolName = null) {
    if (!toolName) {
      revCache.clear();
      return;
    }
    const prefix = `${toolName}:`;
    for (const k of [...revCache.keys()]) {
      if (k.startsWith(prefix)) revCache.delete(k);
    }
  }

  function getCachedRevCount() {
    return revCache.size;
  }

  return {
    callAppTool,
    invalidateRev,
    getCachedRevCount,
  };
}
