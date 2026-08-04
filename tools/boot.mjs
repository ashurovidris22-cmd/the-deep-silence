/* Get a page from "loaded" to "rendering", and be honest when it isn't.
 *
 * This exists because a capture that silently photographs the title card
 * passes every assertion while being completely worthless — the only clue is
 * that the picture is wrong, which is exactly the clue a judge cannot give you
 * about a frame it has never seen correctly.
 */
/* Resolve `playwright` before importing it.
 *
 * If a real one is installed this is a no-op and the real one wins. If the npm
 * registry was unreachable — which has now happened in two consecutive sessions —
 * this points the specifier at `tools/cdp.mjs`, a dependency-free DevTools client
 * covering the fifteen methods this harness actually uses. Either way the import
 * below succeeds, which is the point: no tool in here should be stopped by a
 * registry. */
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ensurePlaywright } from './vendorlink.mjs';

/* Point playwright at the browsers that are actually on this machine.
 *
 * Playwright derives its browser cache from HOME. On the machine this was
 * written for, HOME said /home/vercel-sandbox while the cache sat in
 * /vercel/sandbox/.cache — so the driver AND the exact revision it asks for
 * (chromium-1124) were both present and it still refused to launch, telling us
 * to run `npx playwright install` with no registry to install from.
 *
 * `chromium` on PATH turned out to be a symlink straight into that cache,
 * which is what identified it. Derived from the filesystem, not hardcoded: the
 * root differs per machine and a literal path here would be wrong by the next
 * session. If the browser found is not inside an ms-playwright cache it is
 * still usable through executablePath, so it is recorded rather than dropped. */
function ensureBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const MARK = `${sep}ms-playwright${sep}`;
  let plain = null;
  for (const name of ['chromium', 'chrome', 'google-chrome', 'chromium-browser']) {
    for (const d of (process.env.PATH || '').split(':')) {
      if (!d) continue;
      const p = join(d, name);
      if (!existsSync(p)) continue;
      let real;
      try { real = realpathSync(p); } catch { continue; }
      const i = real.indexOf(MARK);
      if (i >= 0) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = real.slice(0, i + MARK.length - 1);
        return;
      }
      plain ||= real;
    }
  }
  if (plain && !process.env.CHROME_PATH) process.env.CHROME_PATH = plain;
}

ensurePlaywright();
ensureBrowsersPath();
const { chromium } = await import('playwright');

export const GPU_ARGS = [
  // No GPU in this container, so WebGL2 has to come from SwiftShader. Slow but
  // pixel-correct, which is all a still frame needs.
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--hide-scrollbars',
];

/* The subset of GPU_ARGS that forces software rendering. Kept apart because a
 * browser with a real GPU may refuse them: Edge on Windows dies with an access
 * violation (0xC0000005) before printing a DevTools endpoint when handed the
 * SwiftShader trio. A machine that kills the software path is a machine that
 * has a hardware one, so the retry below strips exactly these and no more. */
const SOFT_GL_ARGS = new Set([
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
]);

export async function launch(opts = {}) {
  // Only when there is no cache to resolve from: a bundled browser is matched
  // to the driver and must win over whatever is loose on PATH.
  const exe = !process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {};
  try {
    return await chromium.launch({ headless: true, args: GPU_ARGS, ...exe, ...opts });
  } catch (e) {
    if (!/exited early/i.test(String(e && e.message))) throw e;
    const args = GPU_ARGS.filter((a) => !SOFT_GL_ARGS.has(a));
    return chromium.launch({ headless: true, args, ...exe, ...opts });
  }
}

export async function newPage(browser, { w = 1600, h = 900, dpr = 1 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: dpr,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('favicon')) console.log('  [console]', t);
  });
  return page;
}

/**
 * Boot the game and leave it running.
 *
 * `setup` runs with `g` bound to window.__game, before the settle. Returning a
 * value from it hands that value back — used by the metric tools to read state
 * out of the live scene rather than guessing it from the outside.
 */
export async function bootGame(page, { url, setup = null, settle = 1400, tries = 3 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const live = await page.evaluate(
        () => !!(window.__game && window.__game.started),
      ).catch(() => false);

      if (!live) {
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Shader compilation happens before the button appears, and under
        // SwiftShader that is genuinely slow — do not mistake it for a hang.
        await page.waitForFunction(
          () => { const b = document.getElementById('bootStart'); return b && !b.hidden; },
          { timeout: 180000 },
        );
        // Click through the DOM. The overlay animates its opacity and a click
        // arriving mid-transition is discarded without error.
        await page.evaluate(() => document.getElementById('bootStart').click());
        await page.waitForFunction(() => window.__game && window.__game.started, { timeout: 60000 });
        await page.waitForTimeout(600);
      }

      let out;
      if (setup) {
        out = await page.evaluate(`(()=>{ const g = window.__game; return (${setup}); })()`);
      }
      if (settle) await page.waitForTimeout(settle);

      const ok = await page.evaluate(() => !!(window.__game && window.__game.started));
      if (ok) return out;
    } catch (e) {
      // Distinguish "the page went away" from "your setup expression threw".
      // Reporting the second as the first sends you hunting a reload that never
      // happened while the real fault sits in your own string.
      const stillLive = await page.evaluate(
        () => !!(window.__game && window.__game.started),
      ).catch(() => false);
      if (stillLive) throw e;
      if (attempt === tries) throw e;
      console.log(`  [boot] retry ${attempt + 1}/${tries}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error('game never stayed booted');
}

/** Frame stats straight from the renderer, not inferred from wall clock. */
export async function readStats(page) {
  return page.evaluate(() => {
    const g = window.__game;
    return {
      fps: +g.fps.toFixed(1),
      calls: g.renderer.info.render.calls,
      tris: g.renderer.info.render.triangles,
      depth: g.depth,
      zone: g.zone,
      visibility: +g.visibility().toFixed(2),
    };
  });
}
