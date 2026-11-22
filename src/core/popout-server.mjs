import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Option B: On-demand localhost-only (127.0.0.1) frameless popout window server.
 * Strictly OFF by default. Zero idle processes or open ports until explicitly enabled & launched.
 */
export class PopoutServerManager {
  constructor({ getHtml, handleAppTool }) {
    this.getHtml = getHtml;
    this.handleAppTool = handleAppTool;
    this.server = null;
    this.port = null;
    this.token = null;
  }

  getStatus() {
    return {
      running: Boolean(this.server && this.port),
      port: this.port,
      url: this.server && this.port && this.token ? `http://127.0.0.1:${this.port}/?token=${this.token}` : null,
    };
  }

  async start() {
    if (this.server && this.port) {
      return this.getStatus();
    }
    this.token = crypto.randomBytes(24).toString('hex');

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
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString('utf8');
            if (body.length > 2 * 1024 * 1024) break;
          }
          const parsed = JSON.parse(body || '{}');
          const result = await this.handleAppTool(parsed.name, parsed.arguments || {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
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

    return this.getStatus();
  }

  async stop() {
    if (!this.server) {
      this.port = null;
      this.token = null;
      return { running: false, port: null, url: null };
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
    return { running: false, port: null, url: null };
  }

  /**
   * Launch system Edge/Chrome in frameless --app mode pointing strictly at 127.0.0.1.
   */
  async launchWindow(size = '460x720') {
    const status = await this.start();
    const [wRaw, hRaw] = String(size || '460x720').split('x');
    const width = Math.max(360, Math.min(1600, Number(wRaw) || 460));
    const height = Math.max(480, Math.min(1200, Number(hRaw) || 720));

    let launched = false;
    if (process.platform === 'win32') {
      const candidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ];
      const exe = candidates.find((p) => fs.existsSync(p));
      if (exe) {
        const child = spawn(exe, [`--app=${status.url}`, `--window-size=${width},${height}`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        launched = true;
      }
    }

    return { ...status, launched, size: `${width}x${height}` };
  }
}
