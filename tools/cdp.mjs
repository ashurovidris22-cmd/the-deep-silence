/* Drive Chromium over the DevTools protocol, with no dependencies at all.
 *
 * This exists because npm has now failed in two consecutive sessions. The
 * handoff already records that access to `registry.npmjs.org` is granted per
 * session and does not carry over; what it did not say is that the *browser*
 * comes from a different host, so the two can be granted separately — and on
 * the session that wrote this file, `cdn.playwright.dev` was allowed while the
 * npm registry stayed blocked. A browser and no way to drive it.
 *
 * The way to drive it turns out to be sitting in node already. Node 22 and up
 * ship a global `WebSocket`, the DevTools protocol is JSON over one socket, and
 * the whole surface `tools/` actually uses is fifteen methods. So this is a
 * façade with the same shape as the slice of Playwright the harness calls, and
 * `tools/vendorlink.mjs` installs it at `node_modules/playwright` the same way
 * it points a bare `three` at `vendor/`. **The harness now needs no npm.**
 *
 * It is deliberately not a Playwright implementation. It is exactly enough:
 *
 *   chromium.launch({ headless, args })   browser.newContext({ viewport, dpr })
 *   browser.newPage()  browser.close()    context.newPage()
 *   page.goto(url, { waitUntil })         page.evaluate(fn | string, arg)
 *   page.waitForFunction(fn, { timeout }) page.waitForTimeout(ms)
 *   page.screenshot({ path })             page.on('console' | 'pageerror')
 *
 * If a real Playwright is ever installed, `vendorlink.mjs` leaves it alone.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a browser downloaded from the Playwright CDN ends up — plus, on
 * Windows, the evergreen installs. Edge ships with Windows 11, so the tail of
 * this list is present on any Windows machine even when nothing was ever
 * downloaded. Chrome is preferred when it exists only because it matches the
 * browser the rest of the harness's history was measured against. */
export const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  '/tmp/cr/chrome-linux/chrome',
  '/tmp/cr/chrome-linux/headless_shell',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (p && existsSync(p)) return p;
  throw new Error('no chromium binary; set CHROME_PATH or see tools/vendorlink.mjs --browser');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ socket */

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(fn) { this.listeners.push(fn); }
}

/* -------------------------------------------------------------------- page */

class Page {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sid = sessionId;
    this.handlers = { console: [], pageerror: [] };
    conn.on((msg) => {
      if (msg.sessionId !== this.sid) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value)
            : a.description !== undefined ? a.description : a.type)).join(' ');
        const m = { type: () => msg.params.type, text: () => text };
        for (const h of this.handlers.console) h(m);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        const message = (d.exception && (d.exception.description || d.exception.value))
          || d.text || 'exception';
        for (const h of this.handlers.pageerror) h({ message: String(message) });
      }
    });
  }

  on(event, cb) { if (this.handlers[event]) this.handlers[event].push(cb); return this; }

  async _init(viewport, dpr) {
    await this.conn.send('Runtime.enable', {}, this.sid);
    await this.conn.send('Page.enable', {}, this.sid);
    if (viewport) {
      await this.conn.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height,
        deviceScaleFactor: dpr || 1, mobile: false,
      }, this.sid);
    }
  }

  /**
   * Navigate, then wait for the document rather than for an event.
   *
   * `Page.loadEventFired` is the obvious thing to await and it is a trap here:
   * this page starts compiling shaders under a software rasteriser during load,
   * so the event can be minutes late or, if it fired before the listener was
   * attached, never arrive at all. Polling `readyState` cannot miss it.
   */
  async goto(url, { waitUntil = 'domcontentloaded' } = {}) {
    await this.conn.send('Page.navigate', { url }, this.sid);
    const want = waitUntil === 'load' ? ['complete'] : ['interactive', 'complete'];
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const st = await this.evaluate(() => document.readyState).catch(() => null);
      if (st && want.includes(st)) return;
      await sleep(120);
    }
    throw new Error(`goto timed out: ${url}`);
  }

  /**
   * Run an expression in the page and bring the value back.
   *
   * Accepts a function or a raw string, because the harness uses both — the
   * setup expressions in `bootGame` are strings assembled from the shot table.
   * An argument is serialised through JSON and applied, which is the whole of
   * what Playwright's handle machinery is doing for the one call that needs it.
   */
  async evaluate(fn, arg) {
    const src = typeof fn === 'function'
      ? (arg === undefined ? `(${fn})()` : `(${fn})(${JSON.stringify(arg)})`)
      : String(fn);
    const r = await this.conn.send('Runtime.evaluate', {
      expression: src,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, this.sid);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const m = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(String(m));
    }
    return r.result ? r.result.value : undefined;
  }

  async waitForFunction(fn, { timeout = 30000, poll = 150 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.evaluate(fn).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('waitForFunction timed out');
      await sleep(poll);
    }
  }

  waitForTimeout(ms) { return sleep(ms); }

  /**
   * A PNG of the viewport.
   *
   * `captureBeyondViewport: false` matters: with it true the browser resizes to
   * the full document, which on a page whose canvas is sized from the viewport
   * means every frame in the review set would come back a different shape.
   */
  async screenshot({ path, format = 'png' } = {}) {
    const r = await this.conn.send('Page.captureScreenshot', {
      format, captureBeyondViewport: false, fromSurface: true,
    }, this.sid);
    const buf = Buffer.from(r.data, 'base64');
    if (path) writeFileSync(path, buf);
    return buf;
  }
}

/* ----------------------------------------------------------------- browser */

class Browser {
  constructor(conn, proc, wsUrl) {
    this.conn = conn; this.proc = proc; this.wsUrl = wsUrl;
    this._viewport = null; this._dpr = 1;
  }

  async _open(viewport, dpr) {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId);
    await page._init(viewport, dpr);
    return page;
  }

  /** Playwright's contexts are for isolation; the harness only wants a size. */
  async newContext({ viewport = null, deviceScaleFactor = 1 } = {}) {
    const self = this;
    return { newPage: () => self._open(viewport, deviceScaleFactor) };
  }

  newPage() { return this._open(this._viewport, this._dpr); }

  async close() {
    try { this.conn.ws.close(); } catch { /* already gone */ }
    this.proc.kill('SIGKILL');
    await sleep(120);
  }
}

/* ------------------------------------------------------------------ launch */

export const chromium = {
  async launch({ headless = true, args = [], executablePath = null } = {}) {
    const bin = executablePath || findBrowser();
    const profile = mkdtempSync(join(tmpdir(), 'cr-profile-'));
    const argv = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      // A container has no usable sandbox and /dev/shm is small. Both are what
      // Playwright's own launcher passes here.
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      ...(headless ? ['--headless=new'] : []),
      ...args,
      'about:blank',
    ];
    const proc = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    /* Port 0 means "pick one", and Chromium prints the endpoint it chose on
     * stderr. Reading it is more reliable than guessing a port and racing
     * whatever else in the sandbox might already hold it. */
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('browser never printed a devtools endpoint')), 60000);
      proc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) { clearTimeout(to); resolve(m[0]); }
      });
      proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`browser exited early (${c}): ${buf.slice(-400)}`)); });
    });

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools socket refused')), { once: true });
    });
    const conn = new Conn(ws);
    await conn.send('Target.setDiscoverTargets', { discover: true });
    return new Browser(conn, proc, wsUrl);
  },
};

export default { chromium };
