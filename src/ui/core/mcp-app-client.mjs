/**
 * Native zero-dependency SEP-1865 MCP Apps client bridge.
 * Wire-compatible replacement for @modelcontextprotocol/ext-apps@1.x,
 * eliminating ~255 KiB of schema/SDK runtime bloat and forced synchronous layout reflows.
 */

export const LATEST_PROTOCOL_VERSION = '2026-01-26';
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
export const RESOURCE_URI_META_KEY = 'ui/resourceUri';

export const INITIALIZE_METHOD = 'ui/initialize';
export const INITIALIZED_METHOD = 'ui/notifications/initialized';
export const TOOL_INPUT_METHOD = 'ui/notifications/tool-input';
export const TOOL_INPUT_PARTIAL_METHOD = 'ui/notifications/tool-input-partial';
export const TOOL_RESULT_METHOD = 'ui/notifications/tool-result';
export const TOOL_CANCELLED_METHOD = 'ui/notifications/tool-cancelled';
export const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed';
export const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';
export const REQUEST_TEARDOWN_METHOD = 'ui/notifications/request-teardown';
export const RESOURCE_TEARDOWN_METHOD = 'ui/resource-teardown';
export const OPEN_LINK_METHOD = 'ui/open-link';
export const DOWNLOAD_FILE_METHOD = 'ui/download-file';
export const MESSAGE_METHOD = 'ui/message';
export const REQUEST_DISPLAY_MODE_METHOD = 'ui/request-display-mode';

const NOTIFICATION_TO_EVENT = {
  [TOOL_INPUT_METHOD]: 'toolinput',
  [TOOL_INPUT_PARTIAL_METHOD]: 'toolinputpartial',
  [TOOL_RESULT_METHOD]: 'toolresult',
  [TOOL_CANCELLED_METHOD]: 'toolcancelled',
  [HOST_CONTEXT_CHANGED_METHOD]: 'hostcontextchanged',
};

const VALID_EVENTS = new Set(Object.values(NOTIFICATION_TO_EVENT));

export function getDocumentTheme() {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyDocumentTheme(theme) {
  if (typeof document === 'undefined') return;
  const norm = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.setAttribute('data-theme', norm);
  root.classList.toggle('dark', norm === 'dark');
  root.style.colorScheme = norm;
}

export function applyHostStyleVariables(variables, root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root || !variables || typeof variables !== 'object') return;
  for (const [key, val] of Object.entries(variables)) {
    if (val !== undefined && val !== null && key.startsWith('--')) {
      root.style.setProperty(key, String(val));
    }
  }
}

export function applyHostFonts(cssText) {
  if (typeof document === 'undefined' || !cssText) return;
  if (document.getElementById('__mcp-host-fonts')) return;
  const style = document.createElement('style');
  style.id = '__mcp-host-fonts';
  style.textContent = String(cssText);
  document.head.appendChild(style);
}

export class PostMessageTransport {
  constructor(
    eventTarget = typeof window !== 'undefined' ? window.parent : null,
    eventSource = eventTarget,
    hostWindow = typeof window !== 'undefined' ? window : null
  ) {
    this.eventTarget = eventTarget;
    this.eventSource = eventSource;
    this._hostWindow = hostWindow;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    this._started = false;
    this._listener = (ev) => {
      if (this.eventSource && ev.source && ev.source !== this.eventSource) {
        return;
      }
      const msg = ev?.data;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return;
      }
      this.onmessage?.(msg);
    };
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._hostWindow?.addEventListener('message', this._listener);
  }

  async send(message) {
    if (!this.eventTarget || typeof this.eventTarget.postMessage !== 'function') {
      throw new Error('PostMessageTransport has no valid target');
    }
    this.eventTarget.postMessage(message, '*');
  }

  async close() {
    if (this._started) {
      this._started = false;
      this._hostWindow?.removeEventListener('message', this._listener);
    }
    this.onclose?.();
  }
}

export class App {
  constructor(appInfo, capabilities = {}, options = {}) {
    this._appInfo = appInfo || { name: 'mcp-app', version: '1.0.0' };
    this._capabilities = capabilities && typeof capabilities === 'object' ? { ...capabilities } : {};
    this.options = { autoResize: false, requestTimeoutMs: 60_000, ...options };
    this.transport = null;
    this._nextId = 1;
    this._pending = new Map();
    this._initializedSent = false;
    this._hostCapabilities = undefined;
    this._hostInfo = undefined;
    this._hostContext = undefined;
    this._eventSlots = new Map();
    this._onteardown = undefined;
    this._oncalltool = undefined;
    this._onlisttools = undefined;
    this._requestHandlers = new Map();
  }

  _ensureSlot(name) {
    if (!VALID_EVENTS.has(name)) {
      throw new Error(`Unknown MCP App event: ${String(name)}`);
    }
    let slot = this._eventSlots.get(name);
    if (!slot) {
      slot = { onHandler: undefined, listeners: [] };
      this._eventSlots.set(name, slot);
    }
    return slot;
  }

  _dispatchEvent(name, params) {
    if (name === 'hostcontextchanged' && params && typeof params === 'object') {
      this._hostContext = { ...(this._hostContext || {}), ...params };
    }
    const slot = this._eventSlots.get(name);
    if (!slot) return;
    slot.onHandler?.(params);
    for (const fn of [...slot.listeners]) {
      fn(params);
    }
  }

  setEventHandler(name, fn) {
    this._ensureSlot(name).onHandler = fn;
  }

  getEventHandler(name) {
    return this._eventSlots.get(name)?.onHandler;
  }

  addEventListener(name, fn) {
    if (typeof fn !== 'function') return;
    this._ensureSlot(name).listeners.push(fn);
  }

  removeEventListener(name, fn) {
    const slot = this._eventSlots.get(name);
    if (!slot) return;
    const idx = slot.listeners.indexOf(fn);
    if (idx !== -1) slot.listeners.splice(idx, 1);
  }

  get ontoolinput() { return this.getEventHandler('toolinput'); }
  set ontoolinput(fn) { this.setEventHandler('toolinput', fn); }

  get ontoolinputpartial() { return this.getEventHandler('toolinputpartial'); }
  set ontoolinputpartial(fn) { this.setEventHandler('toolinputpartial', fn); }

  get ontoolresult() { return this.getEventHandler('toolresult'); }
  set ontoolresult(fn) { this.setEventHandler('toolresult', fn); }

  get ontoolcancelled() { return this.getEventHandler('toolcancelled'); }
  set ontoolcancelled(fn) { this.setEventHandler('toolcancelled', fn); }

  get onhostcontextchanged() { return this.getEventHandler('hostcontextchanged'); }
  set onhostcontextchanged(fn) { this.setEventHandler('hostcontextchanged', fn); }

  get onteardown() { return this._onteardown; }
  set onteardown(fn) { this._onteardown = fn; }

  get oncalltool() { return this._oncalltool; }
  set oncalltool(fn) { this._oncalltool = fn; }

  get onlisttools() { return this._onlisttools; }
  set onlisttools(fn) { this._onlisttools = fn; }

  getHostCapabilities() { return this._hostCapabilities; }
  getHostVersion() { return this._hostInfo; }
  getHostContext() { return this._hostContext; }

  setRequestHandler(method, handler) {
    if (typeof method === 'string' && typeof handler === 'function') {
      this._requestHandlers.set(method, handler);
    }
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

    // 1. Response to our outbound request
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || `JSON-RPC error (${msg.error.code ?? -32000})`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2. Inbound request from host (requires response)
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      void this._handleHostRequest(msg);
      return;
    }

    // 3. Inbound notification from host
    if (typeof msg.method === 'string') {
      const eventName = NOTIFICATION_TO_EVENT[msg.method];
      if (eventName) {
        this._dispatchEvent(eventName, msg.params ?? {});
      }
    }
  }

  async _handleHostRequest(msg) {
    const reply = (payload) => {
      if (!this.transport) return;
      void this.transport.send({ jsonrpc: '2.0', id: msg.id, ...payload }).catch(() => {
        /* transport closed during response */
      });
    };

    try {
      if (msg.method === 'ping') {
        reply({ result: {} });
        return;
      }
      if (msg.method === RESOURCE_TEARDOWN_METHOD) {
        const res = this._onteardown ? await this._onteardown(msg.params ?? {}) : {};
        reply({ result: res ?? {} });
        return;
      }
      if (msg.method === 'tools/call') {
        if (!this._oncalltool) {
          reply({ error: { code: -32601, message: 'No oncalltool handler registered' } });
          return;
        }
        const res = await this._oncalltool(msg.params ?? {});
        reply({ result: res ?? {} });
        return;
      }
      if (msg.method === 'tools/list') {
        const res = this._onlisttools ? await this._onlisttools(msg.params ?? {}) : { tools: [] };
        reply({ result: res ?? { tools: [] } });
        return;
      }
      const custom = this._requestHandlers.get(msg.method);
      if (custom) {
        const res = await custom(msg.params ?? {});
        reply({ result: res ?? {} });
        return;
      }
      reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    } catch (err) {
      reply({ error: { code: -32603, message: err?.message || String(err) } });
    }
  }

  async request(req, schemaOrOptions, maybeOptions) {
    if (!this.transport) {
      throw new Error('App is not connected');
    }
    const opts =
      maybeOptions && typeof maybeOptions === 'object'
        ? maybeOptions
        : schemaOrOptions && typeof schemaOrOptions === 'object' && ('timeout' in schemaOrOptions || 'signal' in schemaOrOptions)
          ? schemaOrOptions
          : {};
    const id = this._nextId++;
    const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : this.options.requestTimeoutMs;
    const message = {
      jsonrpc: '2.0',
      id,
      method: req.method,
      ...(req.params !== undefined ? { params: req.params } : {}),
    };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error(`MCP App request timed out (${req.method})`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      if (opts.signal) {
        if (opts.signal.aborted) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`MCP App request aborted (${req.method})`));
          return;
        }
        opts.signal.addEventListener(
          'abort',
          () => {
            if (!this._pending.has(id)) return;
            this._pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`MCP App request aborted (${req.method})`));
          },
          { once: true }
        );
      }

      Promise.resolve(this.transport.send(message)).catch((err) => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async notification(notif) {
    if (!this.transport) {
      throw new Error('App is not connected');
    }
    await this.transport.send({
      jsonrpc: '2.0',
      method: notif.method,
      ...(notif.params !== undefined ? { params: notif.params } : {}),
    });
  }

  async connect(transport = new PostMessageTransport(), options) {
    if (this.transport) {
      throw new Error('App is already connected. Call close() before connecting again.');
    }
    this._initializedSent = false;
    this.transport = transport;
    transport.onmessage = (msg) => this._handleIncoming(msg);
    await transport.start();

    try {
      const initResult = await this.request(
        {
          method: INITIALIZE_METHOD,
          params: {
            appCapabilities: this._capabilities,
            appInfo: this._appInfo,
            protocolVersion: LATEST_PROTOCOL_VERSION,
          },
        },
        options
      );
      if (!initResult || typeof initResult !== 'object') {
        throw new Error('Host returned invalid ui/initialize result');
      }
      this._hostCapabilities = initResult.hostCapabilities;
      this._hostInfo = initResult.hostInfo;
      this._hostContext = initResult.hostContext;
      await this.notification({ method: INITIALIZED_METHOD, params: {} });
      this._initializedSent = true;
      return initResult;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close() {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP App connection closed'));
    }
    this._pending.clear();
    const transport = this.transport;
    this.transport = null;
    this._initializedSent = false;
    if (transport) {
      await transport.close();
    }
  }

  async callServerTool(params, options) {
    if (typeof params === 'string') {
      throw new Error(`callServerTool() expects { name, arguments }, received string "${params}"`);
    }
    return await this.request({ method: 'tools/call', params }, options);
  }

  async readServerResource(params, options) {
    return await this.request({ method: 'resources/read', params }, options);
  }

  async listServerResources(params, options) {
    return await this.request({ method: 'resources/list', params }, options);
  }

  async sendMessage(params, options) {
    return await this.request({ method: MESSAGE_METHOD, params }, options);
  }

  async updateModelContext(params, options) {
    return await this.request({ method: 'ui/update-model-context', params }, options);
  }

  async openLink(params, options) {
    return await this.request({ method: OPEN_LINK_METHOD, params }, options);
  }

  sendOpenLink(params, options) {
    return this.openLink(params, options);
  }

  async downloadFile(params, options) {
    return await this.request({ method: DOWNLOAD_FILE_METHOD, params }, options);
  }

  async requestDisplayMode(params, options) {
    return await this.request({ method: REQUEST_DISPLAY_MODE_METHOD, params }, options);
  }

  sendLog(params) {
    return this.notification({ method: 'notifications/message', params });
  }

  requestTeardown(params = {}) {
    return this.notification({ method: REQUEST_TEARDOWN_METHOD, params });
  }

  sendSizeChanged(params) {
    return this.notification({ method: SIZE_CHANGED_METHOD, params });
  }
}
