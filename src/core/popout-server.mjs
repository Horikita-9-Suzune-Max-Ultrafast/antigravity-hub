import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { getDataDir, getDataPaths } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WIN_HOST_SCRIPT = path.join(__dirname, 'win-floating-host.ps1');
const HOST_ABI_VERSION = 'v1.6.0-native-host-1';
const MIN_COMPILED_EXE_BYTES = 4096;
const HOST_EXE_PREFIX = 'floating-host-';

let _hostSourceHashCache = null;

function isCompiledHostDisabled(env = process.env) {
  const val = String(env?.CONTEXT_CACHE_NO_COMPILED_HOST || '').trim().toLowerCase();
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * Extract the embedded C# source block from win-floating-host.ps1.
 */
export function extractHostCSharpSource(scriptPath = WIN_HOST_SCRIPT) {
  const raw = fs.readFileSync(scriptPath, 'utf8');
  const match = raw.match(/\$csharp\s*=\s*@"\r?\n([\s\S]*?)\r?\n"@/);
  return match ? match[1] : null;
}

function getHostSourceSignature(scriptPath = WIN_HOST_SCRIPT) {
  const st = fs.statSync(scriptPath);
  if (
    _hostSourceHashCache &&
    _hostSourceHashCache.scriptPath === scriptPath &&
    _hostSourceHashCache.mtimeMs === st.mtimeMs &&
    _hostSourceHashCache.size === st.size
  ) {
    return _hostSourceHashCache;
  }
  const csharpSource = extractHostCSharpSource(scriptPath);
  if (!csharpSource) return null;
  const hash12 = crypto
    .createHash('sha256')
    .update(csharpSource)
    .update('\n')
    .update(HOST_ABI_VERSION)
    .digest('hex')
    .slice(0, 12);
  _hostSourceHashCache = {
    scriptPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    hash12,
    csharpSource,
  };
  return _hostSourceHashCache;
}

/**
 * Explicitly locate the built-in .NET Framework 4 csc.exe compiler on Windows (64-bit first).
 * Avoids PowerShell 7's GetRuntimeDirectory() trap where csc.exe does not exist.
 */
export function findWindowsCscCompiler(env = process.env) {
  const winDir = env?.WINDIR || env?.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function cleanupStaleHostExes(cacheDir, keepFileName) {
  try {
    const entries = fs.readdirSync(cacheDir);
    for (const name of entries) {
      if (name === keepFileName) continue;
      if (name.startsWith(HOST_EXE_PREFIX) && name.toLowerCase().endsWith('.exe')) {
        try {
          fs.unlinkSync(path.join(cacheDir, name));
        } catch {
          // Ignore if an older host process is still running and locks its binary
        }
      }
    }
  } catch {
    // Ignore unreadable cache directory
  }
}

/**
 * Compile and cache the Windows native WebView2 floating host C# source into
 * `<dataDir>/runtime/host-bin/floating-host-<hash12>.exe`.
 *
 * - Fast path: returns cached `.exe` path in <1ms if already compiled (>4096 bytes)
 *   and cleans up stale hash `.exe` files.
 * - First-run compile: uses `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
 *   with `/target:exe /optimize+` (preserving stdout `READY:` / `CLOSED` handshake
 *   while `windowsHide: true` + `HideHostConsole()` prevents any console window flash).
 * - Fail-Open: returns `null` when non-Windows, disabled via `CONTEXT_CACHE_NO_COMPILED_HOST=1`,
 *   missing compiler, or any compile/policy error, allowing seamless fallback to `.ps1`.
 */
export function ensureCompiledWinHostExe(options = {}) {
  if (process.platform !== 'win32') return null;
  const env = options.env || process.env;
  if (isCompiledHostDisabled(env)) return null;

  const scriptPath = options.hostScriptPath || WIN_HOST_SCRIPT;
  let sig;
  try {
    sig = getHostSourceSignature(scriptPath);
  } catch {
    return null;
  }
  if (!sig || !sig.hash12 || !sig.csharpSource) return null;

  const { hostExeCacheDir } = getDataPaths({ dataDir: options.dataDir || undefined });
  const targetName = `${HOST_EXE_PREFIX}${sig.hash12}.exe`;
  const targetExe = path.join(hostExeCacheDir, targetName);

  // Cache hit fast path
  try {
    const st = fs.statSync(targetExe);
    if (st.isFile() && st.size > MIN_COMPILED_EXE_BYTES) {
      cleanupStaleHostExes(hostExeCacheDir, targetName);
      return targetExe;
    }
  } catch {
    // Cache miss; proceed to compile
  }

  const cscExe = options.cscPath ? (fs.existsSync(options.cscPath) ? options.cscPath : null) : findWindowsCscCompiler(env);
  if (!cscExe) return null;

  let tmpCs = null;
  let tmpExe = null;
  try {
    fs.mkdirSync(hostExeCacheDir, { recursive: true });
    const suffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    tmpCs = path.join(hostExeCacheDir, `.${HOST_EXE_PREFIX}${sig.hash12}.${suffix}.cs`);
    tmpExe = path.join(hostExeCacheDir, `.${HOST_EXE_PREFIX}${sig.hash12}.${suffix}.exe`);

    // Prefix UTF-8 BOM so .NET Framework csc.exe decodes non-ASCII UI labels accurately across all system locales
    fs.writeFileSync(tmpCs, '\uFEFF' + sig.csharpSource, 'utf8');

    execFileSync(
      cscExe,
      [
        '/target:exe',
        '/optimize+',
        '/nologo',
        '/utf8output',
        `/out:${tmpExe}`,
        '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll',
        '/r:System.Core.dll',
        tmpCs,
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const outStat = fs.statSync(tmpExe);
    if (!outStat.isFile() || outStat.size <= MIN_COMPILED_EXE_BYTES) {
      return null;
    }

    try {
      fs.renameSync(tmpExe, targetExe);
      tmpExe = null;
    } catch {
      // Another process may have raced and produced the identical hash binary
      try {
        const existing = fs.statSync(targetExe);
        if (!existing.isFile() || existing.size <= MIN_COMPILED_EXE_BYTES) {
          fs.copyFileSync(tmpExe, targetExe);
        }
      } catch {
        fs.copyFileSync(tmpExe, targetExe);
      }
    }

    cleanupStaleHostExes(hostExeCacheDir, targetName);
    return targetExe;
  } catch {
    return null;
  } finally {
    if (tmpCs) {
      try {
        if (fs.existsSync(tmpCs)) fs.unlinkSync(tmpCs);
      } catch {
        // ignore temp cleanup failure
      }
    }
    if (tmpExe) {
      try {
        if (fs.existsSync(tmpExe)) fs.unlinkSync(tmpExe);
      } catch {
        // ignore temp cleanup failure
      }
    }
  }
}

const CLIENT_TTL_MS = 18_000;
const DEFAULT_STOP_GRACE_MS = 400;
const STARTUP_GRACE_MS = 5_000;
const MAX_WALLPAPER_STREAM_BYTES = 15 * 1024 * 1024;
const WALLPAPER_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/**
 * Constant-time token comparison using crypto.timingSafeEqual, safely handling
 * non-string inputs, empty strings, and byte-length mismatches without throwing.
 */
export function timingSafeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * On-demand localhost-only (127.0.0.1) frameless floating popout window server.
 * On Windows, prefers a native borderless WebView2 host (zero browser titlebar, TopMost pin,
 * Win11 rounded corners, native drag & 8-edge resize). Falls back cleanly to --app mode.
 */
export class PopoutServerManager {
  constructor({
    getHtml,
    handleAppTool,
    getActiveConversationId = null,
    resolveWallpaper = null,
    onAutoStop = null,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    dataDir = null,
  }) {
    this.getHtml = getHtml;
    this.handleAppTool = handleAppTool;
    this.getActiveConversationId = getActiveConversationId;
    this.resolveWallpaper = resolveWallpaper;
    this.onAutoStop = onAutoStop;
    this.dataDir = dataDir;
    this.stopGraceMs = Math.max(50, Number(stopGraceMs) || DEFAULT_STOP_GRACE_MS);
    this.server = null;
    this.port = null;
    this.token = null;
    this.serverStartedAt = 0;
    this.hostPid = null;
    this.hostMode = 'none';
    this.hostStartedAt = 0;
    this.userClosed = false;
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

  _handleHostProcessExited() {
    this.hostPid = null;
    this.hostMode = 'none';
    this.hostStartedAt = 0;
    this.activeClients.clear();
    this.userClosed = true;
    this._cancelPendingStop();
    if (this.server) {
      void this.stop().then(() => {
        if (typeof this.onAutoStop === 'function') {
          this.onAutoStop();
        }
      });
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
      this._handleHostProcessExited();
      return false;
    }
    return this._pruneStaleClients() > 0;
  }

  getStatus() {
    const now = Date.now();
    let hostAlive = false;
    if (this.hostMode === 'webview2' && this.hostPid) {
      hostAlive = this._isHostProcessAlive();
      if (!hostAlive) {
        this._handleHostProcessExited();
      }
    }
    const activeClients = this._pruneStaleClients(now);
    const serverListening = Boolean(this.server && this.port);
    const inHostStartupGrace =
      this.hostMode === 'webview2'
        ? Boolean(this.hostPid && hostAlive && now - this.hostStartedAt < STARTUP_GRACE_MS)
        : this.hostMode === 'browser-app'
          ? Boolean(this.hostStartedAt > 0 && now - this.hostStartedAt < STARTUP_GRACE_MS)
          : Boolean(this.serverStartedAt > 0 && now - this.serverStartedAt < STARTUP_GRACE_MS);
    const inStartupGrace = !this.userClosed && inHostStartupGrace;
    const windowOpen = Boolean(serverListening && (activeClients > 0 || inStartupGrace));
    return {
      running: windowOpen,
      windowOpen,
      serverListening,
      userClosed: this.userClosed,
      port: this.port,
      url: serverListening && this.token ? `http://127.0.0.1:${this.port}/?token=${this.token}` : null,
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
    this.userClosed = false;
    this.serverStartedAt = Date.now();
    if (this.server && this.port) {
      return this.getStatus();
    }
    this.token = crypto.randomBytes(24).toString('hex');
    this.activeClients.clear();

    this.server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        const headerToken = req.headers['x-cc-token'];
        const reqToken = urlObj.searchParams.get('token') || (typeof headerToken === 'string' ? headerToken : '');
        if (!timingSafeTokenEqual(reqToken, this.token)) {
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

        if (req.method === 'GET' && urlObj.pathname.startsWith('/api/wallpaper/')) {
          const rawId = urlObj.pathname.slice('/api/wallpaper/'.length);
          let wallpaperId = '';
          try {
            wallpaperId = decodeURIComponent(rawId);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid wallpaper id' }));
            return;
          }
          if (
            !wallpaperId ||
            wallpaperId.includes('/') ||
            wallpaperId.includes('\\') ||
            wallpaperId.includes('..') ||
            wallpaperId.includes('\0')
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid wallpaper id' }));
            return;
          }
          if (typeof this.resolveWallpaper !== 'function') {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Wallpaper not found' }));
            return;
          }
          const resolved = await this.resolveWallpaper(wallpaperId);
          const filePath = typeof resolved === 'string' ? resolved : resolved?.filePath;
          if (!filePath || typeof filePath !== 'string') {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Wallpaper not found' }));
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const mime = (typeof resolved === 'object' && resolved?.mime) || WALLPAPER_MIME_BY_EXT[ext];
          if (!mime || !WALLPAPER_MIME_BY_EXT[ext]) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Wallpaper not found' }));
            return;
          }
          let stat;
          try {
            stat = fs.statSync(filePath);
          } catch {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Wallpaper not found' }));
            return;
          }
          if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WALLPAPER_STREAM_BYTES) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Wallpaper not found' }));
            return;
          }
          const headers = {
            'Content-Type': mime,
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          };
          if (ext === '.svg') {
            headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
          }
          res.writeHead(200, headers);
          await new Promise((resolve) => {
            const stream = fs.createReadStream(filePath);
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };
            stream.on('error', () => {
              if (!res.headersSent) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Wallpaper not found' }));
              } else {
                res.destroy();
              }
              finish();
            });
            res.on('close', () => {
              if (!stream.destroyed) stream.destroy();
              finish();
            });
            stream.on('end', finish);
            stream.pipe(res);
          });
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
          this.userClosed = false;
          this._cancelPendingStop();
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
          const remaining = this._pruneStaleClients();
          if (remaining === 0) {
            this.userClosed = true;
            this._scheduleAutoStopIfEmpty();
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, activeClients: remaining }));
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
        this.serverStartedAt = Date.now();
        resolve();
      });
    });

    this.sweeperTimer = setInterval(() => {
      if (this.hostMode === 'webview2' && this.hostPid && !this._isHostProcessAlive()) {
        this._handleHostProcessExited();
        return;
      }
      const hadAny = this.activeClients.size > 0;
      const alive = this._pruneStaleClients();
      if (hadAny && alive === 0) {
        this.userClosed = true;
        this._scheduleAutoStopIfEmpty();
      }
    }, 5_000);
    this.sweeperTimer.unref?.();

    return this.getStatus();
  }

  async stop({ userClosed = undefined } = {}) {
    this._clearTimers();
    this.activeClients.clear();
    if (typeof userClosed === 'boolean') {
      this.userClosed = userClosed;
    }
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
    this.hostStartedAt = 0;
    this.serverStartedAt = 0;
    if (!this.server) {
      this.port = null;
      this.token = null;
      return this.getStatus();
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
    return this.getStatus();
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

  async _spawnAndHandshakeWinHost(command, args) {
    const child = spawn(command, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
        const text = String(chunk);
        if (text.includes('READY:')) finish(true);
        if (text.includes('CLOSED') && settled && this.hostPid === child.pid) {
          this._handleHostProcessExited();
        }
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
        const wasCurrentHost = this.hostPid === child.pid;
        if (!settled) {
          if (wasCurrentHost) {
            this.hostPid = null;
            this.hostMode = 'none';
            this.hostStartedAt = 0;
            this.activeClients.clear();
          }
          finish(code === 0 && this.hasActiveClient());
          return;
        }
        if (wasCurrentHost) {
          this._handleHostProcessExited();
        }
      });
    });

    child.stdout?.resume();
    child.stderr?.resume();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    child.unref();

    const ok = Boolean(handshakeOk && (this.hostPid === child.pid || this.hasActiveClient()));
    if (!ok && this.hostPid === child.pid) {
      try {
        process.kill(child.pid);
      } catch {
        // already exited
      }
      this.hostPid = null;
      this.hostMode = 'none';
      this.hostStartedAt = 0;
    }
    return { ok, errBuf: errBuf.trim() };
  }

  async _launchWindowInternal(sizeOrOpts = '460x720', positionArg = null) {
    const opts =
      sizeOrOpts && typeof sizeOrOpts === 'object'
        ? sizeOrOpts
        : { size: sizeOrOpts, position: positionArg, forceNew: false };

    this._cancelPendingStop();
    this.userClosed = false;
    const status = await this.start();
    const [wRaw, hRaw] = String(opts.size || '460x720').split('x');
    const width = Math.max(360, Math.min(1600, Number(wRaw) || 460));
    const height = Math.max(460, Math.min(1200, Number(hRaw) || 720));
    const alwaysOnTop = opts.alwaysOnTop !== false;
    const theme = opts.theme === 'dark' ? 'dark' : 'light';

    if (this.hostPid && !this._isHostProcessAlive()) {
      this.hostPid = null;
      this.hostMode = 'none';
      this.hostStartedAt = 0;
      this.activeClients.clear();
    }

    const inStartupGrace = this.hostPid && this._isHostProcessAlive() && Date.now() - this.hostStartedAt < STARTUP_GRACE_MS;
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

    // Preferred on Windows: native frameless WebView2 window (compiled-exe fast path -> PowerShell fail-open -> browser --app)
    if (this._hasWindowsWebView2()) {
      const nativeUrl = `${status.url}&native=1&topmost=${alwaysOnTop ? '1' : '0'}&theme=${encodeURIComponent(theme)}`;
      const posX =
        opts.position && Number.isFinite(Number(opts.position.x))
          ? Math.max(-4000, Math.min(8000, Math.round(Number(opts.position.x))))
          : -99999;
      const posY =
        opts.position && Number.isFinite(Number(opts.position.y))
          ? Math.max(-2000, Math.min(4000, Math.round(Number(opts.position.y))))
          : -99999;
      const userDataDir = path.join(getDataDir({ dataDir: this.dataDir || undefined }), 'runtime', 'webview2');
      const hostCliArgs = [
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
      ];
      if (opts.windowMode === 'minibar' || opts.windowMode === 'orb' || opts.windowMode === 'console') {
        hostCliArgs.push('-Mode', opts.windowMode);
      }
      if (
        opts.orbPosition &&
        Number.isFinite(Number(opts.orbPosition.x)) &&
        Number.isFinite(Number(opts.orbPosition.y))
      ) {
        hostCliArgs.push(
          '-OrbX',
          String(Math.max(-4000, Math.min(8000, Math.round(Number(opts.orbPosition.x))))),
          '-OrbY',
          String(Math.max(-2000, Math.min(4000, Math.round(Number(opts.orbPosition.y)))))
        );
      }

      const hostErrors = [];

      // Tier 1: Locally compiled cached .exe (~140ms cold start, zero PowerShell startup overhead)
      const compiledExe = ensureCompiledWinHostExe({ dataDir: this.dataDir || undefined });
      if (compiledExe) {
        const res = await this._spawnAndHandshakeWinHost(compiledExe, hostCliArgs);
        if (res.ok) {
          launched = true;
        } else {
          hostErrors.push(res.errBuf || 'Compiled WebView2 host exited before ready');
        }
      }

      // Tier 2: Fail-Open fallback to PowerShell Add-Type host script
      if (!launched) {
        const psArgs = [
          '-NoProfile',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          WIN_HOST_SCRIPT,
          ...hostCliArgs,
        ];
        const res = await this._spawnAndHandshakeWinHost('powershell.exe', psArgs);
        if (res.ok) {
          launched = true;
        } else {
          hostErrors.push(res.errBuf || 'PowerShell WebView2 host exited before ready');
        }
      }

      // Tier 3: Browser --app fallback
      if (!launched) {
        this.lastHostError = hostErrors.filter(Boolean).join(' | ') || 'WebView2 host exited before ready';
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
