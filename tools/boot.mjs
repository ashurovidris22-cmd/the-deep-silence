/* Get a page from "loaded" to "rendering", and be honest when it isn't.
 *
 * This exists because a capture that silently photographs the title card
 * passes every assertion while being completely worthless — the only clue is
 * that the picture is wrong, which is exactly the clue a judge cannot give you
 * about a frame it has never seen correctly.
 */
import { chromium } from 'playwright';

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

export async function launch(opts = {}) {
  return chromium.launch({ headless: true, args: GPU_ARGS, ...opts });
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
