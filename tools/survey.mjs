/* Shoot the whole review set from one boot.
 *
 *   node tools/survey.mjs [--w 1280] [--h 720] [--only name] [--out shots]
 *
 * One browser, one shader compile, N frames. Launching a browser per frame
 * costs minutes under software rendering and buys nothing.
 */
import fs from 'node:fs';
import { launch, newPage, bootGame, readStats } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1280), H = +opt('h', 720);
const ONLY = opt('only', null);
const OUT = opt('out', 'shots');
const URL = opt('url', 'http://localhost:8123/index.html?hud=0&auto=1');

fs.mkdirSync(OUT, { recursive: true });

/* Reset anything a previous shot changed, here rather than in the next shot.
 * State that leaks forward is the failure mode that produced twenty frames of
 * an empty starfield in the project this harness is modelled on. */
const PRE = `g.setLayer('hud',false); g.setLayer('kelp',true); g.setLayer('rocks',true);
  g.setLayer('snow',true); g.setLayer('terrain',true); g.setLayer('beacons',true);
  g.setLayer('station',true); g.setLayer('sub',true);`;

const SHOTS = [
  ['a-shelf',   `g.pose('shelf');`],
  ['b-rim',     `g.pose('rim');`],
  ['c-wall',    `g.pose('wall');`],
  ['d-deep',    `g.pose('deep');`],
  ['e-floor',   `g.pose('floor');`],
  ['f-descent', `g.pose('descent');`],
  ['m-catwalk', `g.pose('catwalk');`],
  ['n-station', `g.pose('station');`],
  ['o-wreck',   `g.pose('wreck');`],
  ['p-bow',     `g.pose('bow');`],
  // Depth is a property of position now, so the ladder is shot by standing in
  // different places rather than by retuning a number — which also means each
  // rung is a real location and can be judged as a picture.
  ['g-shelf-noc', `g.pose('shelf'); g.setLayer('kelp', false);`],
  ['h-deep-dark', `g.pose('deep'); g.setLamp(0);`],
  ['i-wall-lit',  `g.pose('wall'); g.setLamp(1);`],
  // Surface-offset rungs, for optics past the world's own 440 m of range.
  ['j-d1200',   `g.pose('floor'); g.setDepth(1200); g.setLamp(1);`],
  ['k-d4000',   `g.pose('floor'); g.setDepth(4000); g.setLamp(1);`],
  // No marine snow: if the frame looks the same, snow is not earning its cost.
  ['l-nosnow',  `g.pose('shelf'); g.setLayer('snow',false);`],
];

const browser = await launch();
const page = await newPage(browser, { w: W, h: H, dpr: +opt('dpr', 1) });

console.log(`survey ${W}x${H} -> ${OUT}/`);
let first = true;
for (const [name, js] of SHOTS) {
  if (ONLY && name !== ONLY) continue;
  const t0 = Date.now();
  try {
    await bootGame(page, {
      url: first ? URL : undefined,
      setup: `(()=>{ ${PRE} ${js} return null; })()`,
      settle: first ? 2600 : 1500,
    });
    first = false;
    // Generous on purpose. A frame that takes half a minute on a software
    // rasteriser is not a failure, and treating it as one loses the shot.
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
    const s = await readStats(page);
    console.log(`  ${name.padEnd(11)} ${((Date.now() - t0) / 1000).toFixed(1)}s`
      + `  ${s.depth}m ${String(s.zone).padEnd(13)} vis=${s.visibility}m`
      + `  draws=${s.calls} tris=${(s.tris / 1000).toFixed(0)}k`);
  } catch (e) {
    console.log(`  ${name.padEnd(11)} FAILED  ${String(e.message).split('\n')[0]}`);
  }
}

await browser.close();
console.log(`done — ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} frames`);
