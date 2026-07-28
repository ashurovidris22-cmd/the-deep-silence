/* Arbitrary-expression capture. The bisection tool.
 *
 *   node tools/shot.mjs "g.pose('dark'); g.setLayer('beacons',false)" --out shots/x.png
 *   node tools/shot.mjs --pairs "name=expr" "name2=expr2"   (many, one boot)
 *
 * Exists because "which subsystem is drawing that" is not answerable by
 * reasoning about the code — three subsystems in a row looked guilty and were
 * not. It is answerable in one minute by switching each off.
 */
import fs from 'node:fs';
import { launch, newPage, bootGame, readStats } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 720), H = +opt('h', 405);
const OUT = opt('out', 'shots/_probe.png');
const URL = opt('url', 'http://localhost:8123/index.html?hud=0&auto=1&vsteps=16&vscale=0.4');

const pi = args.indexOf('--pairs');
const pairs = pi >= 0
  ? args.slice(pi + 1).filter((a) => !a.startsWith('--')).map((s) => {
    const k = s.indexOf('=');
    return [s.slice(0, k), s.slice(k + 1)];
  })
  : [[null, args.find((a) => !a.startsWith('--')) || '1']];

fs.mkdirSync('shots', { recursive: true });

const browser = await launch();
const page = await newPage(browser, { w: W, h: H, dpr: 1 });

let first = true;
for (const [name, expr] of pairs) {
  const out = name ? `shots/_p-${name}.png` : OUT;
  try {
    await bootGame(page, {
      url: first ? URL : undefined,
      setup: `(()=>{ ${expr} ; return null; })()`,
      settle: first ? 2400 : 1400,
    });
    first = false;
    await page.screenshot({ path: out, timeout: 180000 });
    const s = await readStats(page);
    console.log(`  ${String(name || 'probe').padEnd(14)} -> ${out}`
      + `  draws=${s.calls} tris=${(s.tris / 1000).toFixed(0)}k ${s.depth}m`);
  } catch (e) {
    console.log(`  ${String(name || 'probe').padEnd(14)} FAILED ${String(e.message).split('\n')[0]}`);
  }
}
await browser.close();
