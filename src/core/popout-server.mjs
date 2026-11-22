import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CLIENT_TTL_MS = 18_000;
const DEFAULT_STOP_GRACE_MS = 3_000;

/**
 * On-demand localhost-only (127.0.0.1) frameless floating popout window server.
 * Zero idle processes or open ports until explicitly launched; auto-stops once all popout windows close.
 */
export class PopoutServerManager {
  constructor({ getHtml, handleAppTool, onAutoStop = null, stopGraceMs = DEFAULT_STOP_GRACE_MS }) {
    this.getHtml = getHtml;
    this.handleAppTool = handleAppTool;
    this.onAutoStop = onAutoStop;
    this.stopGraceMs = Math.max(50, Number(stopGraceMs) || DEFAULT_STOP_GRACE_MS);
    this.server = null;
    this.port = null;
    this.token = null;
    this.activeClients = new Map();
    this.stopTimer = null;
    this.sweeperTimer = null;
  }

  _pruneStaleClients(now = Date.now()) {
    for (const [cid, lastSeen] of this.activeClients.entries()) {
      if (now - lastSeen > CLIENT_TTL_MS) {
        this.activeClients.delete(cid);
      }
    }
    return this.activeClients.size;
  }

  _clearTimers() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
  }

  _scheduleAutoStopIfEmpty() {
    this._pruneStaleClients();
    if (this.activeClients.size > 0 || !this.server) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this._pruneStaleClients();
      if (this.activeClients.size === 0 && this.server) {
        void this.stop().then(() => {
          if (typeof this.onAutoStop === 'function') {
            this.onAutoStop();
          }
        });
      }
    }, this.stopGraceMs);
    this.stopTimer.unref?.();
  }

  hasActiveClient() {
    return this._pruneStaleClients() > 0;
  }

  getStatus() {
    const activeClients = this._pruneStaleClients();
    return {
      running: Boolean(this.server && this.port),
      port: this.port,
      url: this.server && this.port && this.token ? `http://127.0.0.1:${this.port}/?token=${this.token}` : null,
      activeClients,
    };
  }

  async _readJsonBody(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (body.length > 2 * 1024 * 1024) break;
    }
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async start() {
    if (this.server && this.port) {
      return this.getStatus();
    }
    this.token = crypto.randomBytes(24).toString('hex');
    this.activeClients.clear();

    this.server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        const reqToken = urlObj.searchParams.get('token') || req.headers['x-cc-token'];
        if (!reqToken || reqToken !== this.token) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

        if (req.method === 'GET' && urlObj.pathname === '/') {
          const html = this.getHtml();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(html);
          return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/tool') {
          const parsed = await this._readJsonBody(req);
          const result = await this.handleAppTool(parsed.name, parsed.arguments || {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/popout/heartbeat') {
          const parsed = await this._readJsonBody(req);
          const clientId = String(parsed.clientId || urlObj.searchParams.get('clientId') || 'default');
          this.activeClients.set(clientId, Date.now());
          if (this.stopTimer) {
            clearTimeout(this.stopTimer);
            this.stopTimer = null;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, activeClients: this._pruneStaleClients() }));
          return;
        }

        if (req.method === 'POST' && urlObj.pathname === '/api/popout/closing') {
          const parsed = await this._readJsonBody(req);
          const clientId = String(parsed.clientId || urlObj.searchParams.get('clientId') || 'default');
          this.activeClients.delete(clientId);
          this._scheduleAutoStopIfEmpty();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, activeClients: this._pruneStaleClients() }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : null;
        resolve();
      });
    });

    this.sweeperTimer = setInterval(() => {
      const hadAny = this.activeClients.size > 0;
      const alive = this._pruneStaleClients();
      if (hadAny && alive === 0) {
        this._scheduleAutoStopIfEmpty();
      }
    }, 5_000);
    this.sweeperTimer.unref?.();

    return this.getStatus();
  }

  async stop() {
    this._clearTimers();
    this.activeClients.clear();
    if (!this.server) {
      this.port = null;
      this.token = null;
      return { running: false, port: null, url: null, activeClients: 0 };
    }
    const srv = this.server;
    this.server = null;
    this.port = null;
    this.token = null;
    await new Promise((resolve) => {
      try {
        srv.close(() => resolve());
      } catch {
        resolve();
      }
    });
    return { running: false, port: null, url: null, activeClients: 0 };
  }

  _focusExistingWindow() {
    if (process.platform !== 'win32') return false;
    try {
      const psScript = `
$wshell = New-Object -ComObject WScript.Shell
$null = $wshell.AppActivate('Context Cache & Telemetry')
`;
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  _findBrowserExecutable() {
    if (process.platform === 'win32') {
      const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ];
      return candidates.find((p) => fs.existsSync(p)) || null;
    }
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
      return candidates.find((p) => fs.existsSync(p)) || null;
    }
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  /**
   * Launch system Edge/Chrome in frameless --app mode pointing strictly at 127.0.0.1.
   * Accepts either (sizeString, position) or ({ size, position, forceNew }).
   */
  async launchWindow(sizeOrOpts = '460x720', positionArg = null) {
    const opts =
      sizeOrOpts && typeof sizeOrOpts === 'object'
        ? sizeOrOpts
        : { size: sizeOrOpts, position: positionArg, forceNew: false };

    const status = await this.start();
    const [wRaw, hRaw] = String(opts.size || '460x720').split('x');
    const width = Math.max(360, Math.min(1600, Number(wRaw) || 460));
    const height = Math.max(480, Math.min(1200, Number(hRaw) || 720));

    // Reuse existing live floating window unless forceNew is explicitly requested
    if (!opts.forceNew && this.hasActiveClient()) {
      const focused = this._focusExistingWindow();
      return {
        ...this.getStatus(),
        launched: true,
        reused: true,
        focused,
        size: `${width}x${height}`,
      };
    }

    const args = [`--app=${status.url}`, `--window-size=${width},${height}`];
    if (
      opts.position &&
      Number.isFinite(Number(opts.position.x)) &&
      Number.isFinite(Number(opts.position.y))
    ) {
      const x = Math.max(-2000, Math.min(4000, Math.round(Number(opts.position.x))));
      const y = Math.max(-1000, Math.min(3000, Math.round(Number(opts.position.y))));
      args.push(`--window-position=${x},${y}`);
    }

    let launched = false;
    const exe = this._findBrowserExecutable();
    if (exe) {
      const child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      launched = true;
    }

    return {
      ...this.getStatus(),
      launched,
      reused: false,
      size: `${width}x${height}`,
    };
  }
}
