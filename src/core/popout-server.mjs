import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getDataDir } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WIN_HOST_SCRIPT = path.join(__dirname, 'win-floating-host.ps1');

const CLIENT_TTL_MS = 18_000;
const DEFAULT_STOP_GRACE_MS = 3_000;

/**
 * On-demand localhost-only (127.0.0.1) frameless floating popout window server.
 * On Windows, prefers a native borderless WebView2 host (zero browser titlebar, TopMost pin,
 * Win11 rounded corners, native 120Hz drag & 8-edge resize). Falls back cleanly to --app mode.
 */
export class PopoutServerManager {
  constructor({
    getHtml,
    handleAppTool,
    getActiveConversationId = null,
    onAutoStop = null,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    dataDir = null,
  }) {
    this.getHtml = getHtml;
    this.handleAppTool = handleAppTool;
    this.getActiveConversationId = getActiveConversationId;
    this.onAutoStop = onAutoStop;
    this.dataDir = dataDir;
    this.stopGraceMs = Math.max(50, Number(stopGraceMs) || DEFAULT_STOP_GRACE_MS);
    this.server = null;
    this.port = null;
    this.token = null;
    this.hostPid = null;
    this.hostMode = 'none';
    this.hostStartedAt = 0;
    this.lastHostError = null;
    this.activeClients = new Map();
    this.stopTimer = null;
    this.sweeperTimer = null;
    this._launchPromise = null;
  }

  _cancelPendingStop() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  _isHostProcessAlive() {
    if (!this.hostPid) return false;
    try {
      process.kill(this.hostPid, 0);
      return true;
    } catch {
      return false;
    }
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
    if (this.hostMode === 'webview2' && this.hostPid && !this._isHostProcessAlive()) {
      this.hostPid = null;
      this.hostMode = 'none';
      this.activeClients.clear();
      return false;
    }
    return this._pruneStaleClients() > 0;
  }

  getStatus() {
    const activeClients = this._pruneStaleClients();
    return {
      running: Boolean(this.server && this.port),
      port: this.port,
      url: this.server && this.port && this.token ? `http://127.0.0.1:${this.port}/?token=${this.token}` : null,
      activeClients,
      hostMode: this.hostMode,
    };
  }

  async _readJsonBody(req) {
    const MAX_BODY_BYTES = 24 * 1024 * 1024; // Supports 15 MiB image base64 import (~20 MiB JSON)
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        const err = new Error('Request payload too large');
        err.statusCode = 413;
        throw err;
      }
    }
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async start() {
    this._cancelPendingStop();
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
          let activeConversationId = null;
          if (typeof this.getActiveConversationId === 'function') {
            try {
              activeConversationId = this.getActiveConversationId() || null;
            } catch {
              activeConversationId = null;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: true,
              activeClients: this._pruneStaleClients(),
              activeConversationId,
            })
          );
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
        const code = err?.statusCode === 413 ? 413 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
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
    if (this.hostPid) {
      const pid = this.hostPid;
      this.hostPid = null;
      try {
        process.kill(pid);
      } catch {
        // host already closed
      }
    }
    this.hostMode = 'none';
    if (!this.server) {
      this.port = null;
      this.token = null;
      return { running: false, port: null, url: null, activeClients: 0, hostMode: 'none' };
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
    return { running: false, port: null, url: null, activeClients: 0, hostMode: 'none' };
  }

  _hasWindowsWebView2() {
    if (process.platform !== 'win32' || !fs.existsSync(WIN_HOST_SCRIPT)) return false;
    const roots = [
      'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application',
      'C:\\Program Files\\Microsoft\\EdgeWebView\\Application',
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const dirs = fs.readdirSync(root).filter((n) => /^\d+\./.test(n));
        for (const ver of dirs) {
          if (fs.existsSync(path.join(root, ver, 'EBWebView', 'x64', 'EmbeddedBrowserWebView.dll'))) {
            return true;
          }
        }
      } catch {
        // ignore unreadable dir
      }
    }
    return false;
  }

  async _focusExistingWindow() {
    if (process.platform !== 'win32') return false;
    try {
      const pid = this.hostPid && this._isHostProcessAlive() ? Number(this.hostPid) : 0;
      const evBlock = pid
        ? `
try {
  $ev = [System.Threading.EventWaitHandle]::OpenExisting('Local\\ContextCacheFocus_${pid}')
  $ok = $ev.Set()
  $ev.Dispose()
  if ($ok) { exit 0 }
} catch {}
`
        : '';
      const psScript = `${evBlock}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WinFocusHelper {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(IntPtr lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$hwnd = [WinFocusHelper]::FindWindow([IntPtr]::Zero, 'Context Cache & Telemetry')
if ($hwnd -ne [IntPtr]::Zero) {
  if ([WinFocusHelper]::IsIconic($hwnd)) { [void][WinFocusHelper]::ShowWindow($hwnd, 9) }
  [void][WinFocusHelper]::ShowWindow($hwnd, 5)
  $fg = [WinFocusHelper]::SetForegroundWindow($hwnd)
  if ($fg) { exit 0 }
}
$wshell = New-Object -ComObject WScript.Shell
if ($wshell.AppActivate('Context Cache & Telemetry')) { exit 0 }
exit 2
`;
      return await new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          child.unref();
          finish(false);
        }, 1800);
        timer.unref?.();
        child.once('error', () => finish(false));
        child.once('exit', (code) => finish(code === 0));
      });
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
   * Launch floating window pointing strictly at 127.0.0.1.
   * On Windows with Evergreen WebView2, launches a true borderless native host (no browser titlebar,
   * Always-on-Top pin, Win11 rounded corners, native drag/resize). Falls back to --app mode elsewhere.
   */
  async launchWindow(sizeOrOpts = '460x720', positionArg = null) {
    if (this._launchPromise) {
      await this._launchPromise.catch(() => {});
    }
    const run = this._launchWindowInternal(sizeOrOpts, positionArg);
    this._launchPromise = run;
    try {
      return await run;
    } finally {
      if (this._launchPromise === run) this._launchPromise = null;
    }
  }

  _launchBrowserFallback(status, { width, height, theme, position }) {
    const fallbackUrl = `${status.url}&theme=${encodeURIComponent(theme)}`;
    const args = [`--app=${fallbackUrl}`, `--window-size=${width},${height}`];
    if (
      position &&
      Number.isFinite(Number(position.x)) &&
      Number.isFinite(Number(position.y))
    ) {
      const x = Math.max(-2000, Math.min(4000, Math.round(Number(position.x))));
      const y = Math.max(-1000, Math.min(3000, Math.round(Number(position.y))));
      args.push(`--window-position=${x},${y}`);
    }

    const exe = this._findBrowserExecutable();
    if (!exe) return false;
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    this.hostMode = 'browser-app';
    this.hostStartedAt = Date.now();
    child.unref();
    return true;
  }

  async _launchWindowInternal(sizeOrOpts = '460x720', positionArg = null) {
    const opts =
      sizeOrOpts && typeof sizeOrOpts === 'object'
        ? sizeOrOpts
        : { size: sizeOrOpts, position: positionArg, forceNew: false };

    this._cancelPendingStop();
    const status = await this.start();
    const [wRaw, hRaw] = String(opts.size || '460x720').split('x');
    const width = Math.max(360, Math.min(1600, Number(wRaw) || 460));
    const height = Math.max(460, Math.min(1200, Number(hRaw) || 720));
    const alwaysOnTop = opts.alwaysOnTop !== false;
    const theme = opts.theme === 'dark' ? 'dark' : 'light';

    if (this.hostPid && !this._isHostProcessAlive()) {
      this.hostPid = null;
      this.hostMode = 'none';
      this.activeClients.clear();
    }

    const inStartupGrace = this.hostPid && Date.now() - this.hostStartedAt < 5_000;
    const canReuseLiveHost =
      this.hostMode === 'webview2'
        ? this._isHostProcessAlive() && (this.hasActiveClient() || inStartupGrace)
        : this.hasActiveClient();

    // Reuse existing live floating window unless forceNew is explicitly requested
    if (!opts.forceNew && canReuseLiveHost) {
      const focused = await this._focusExistingWindow();
      if (focused || inStartupGrace) {
        return {
          ...this.getStatus(),
          launched: true,
          reused: true,
          focused,
          size: `${width}x${height}`,
        };
      }
      // Zombie host process whose window could not be located/focused: terminate and re-launch cleanly
      if (this.hostPid) {
        try { process.kill(this.hostPid); } catch {}
        this.hostPid = null;
        this.hostMode = 'none';
        this.activeClients.clear();
      }
    }

    let launched = false;
    this.lastHostError = null;

    // Preferred on Windows: native frameless WebView2 window (no browser chrome, TopMost fixed)
    if (this._hasWindowsWebView2()) {
      const nativeUrl = `${status.url}&native=1&topmost=${alwaysOnTop ? '1' : '0'}&theme=${encodeURIComponent(theme)}`;
      const posX =
        opts.position && Number.isFinite(Number(opts.position.x))
          ? Math.max(-2000, Math.min(4000, Math.round(Number(opts.position.x))))
          : -99999;
      const posY =
        opts.position && Number.isFinite(Number(opts.position.y))
          ? Math.max(-1000, Math.min(3000, Math.round(Number(opts.position.y))))
          : -99999;
      const userDataDir = path.join(getDataDir({ dataDir: this.dataDir || undefined }), 'runtime', 'webview2');

      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          WIN_HOST_SCRIPT,
          '-Url',
          nativeUrl,
          '-Width',
          String(width),
          '-Height',
          String(height),
          '-PosX',
          String(posX),
          '-PosY',
          String(posY),
          '-TopMost',
          alwaysOnTop ? '1' : '0',
          '-Theme',
          theme,
          '-UserDataDir',
          userDataDir,
        ],
        {
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      this.hostPid = child.pid || null;
      this.hostMode = 'webview2';
      this.hostStartedAt = Date.now();

      let errBuf = '';
      const handshakeOk = await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(this._isHostProcessAlive()), 2500);
        timer.unref?.();

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
          if (String(chunk).includes('READY:')) finish(true);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
          if (errBuf.length < 2048) errBuf += String(chunk);
        });
        child.once('error', (err) => {
          errBuf += err?.message || 'spawn error';
          finish(false);
        });
        child.once('exit', (code) => {
          if (this.hostPid === child.pid) {
            this.hostPid = null;
            this.hostMode = 'none';
            this.activeClients.clear();
          }
          if (!settled) {
            finish(code === 0 && this.hasActiveClient());
          }
          this._scheduleAutoStopIfEmpty();
        });
      });

      child.stdout?.resume();
      child.stderr?.resume();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      child.unref();

      if (handshakeOk && (this.hostPid === child.pid || this.hasActiveClient())) {
        launched = true;
      } else {
        this.lastHostError = errBuf.trim() || 'WebView2 host exited before ready';
        if (this.hostPid === child.pid) {
          this.hostPid = null;
          this.hostMode = 'none';
        }
        launched = this._launchBrowserFallback(status, { width, height, theme, position: opts.position });
      }
    } else {
      launched = this._launchBrowserFallback(status, { width, height, theme, position: opts.position });
    }

    return {
      ...this.getStatus(),
      launched,
      reused: false,
      lastHostError: this.lastHostError,
      size: `${width}x${height}`,
    };
  }
}
