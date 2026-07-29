/* Make the vendored three.js importable from node, with no network at all.
 *
 * `src/vessel.js` is described in the handoff as having no renderer dependency,
 * and in spirit it does — but it imports `three` for Vector3 and Matrix4, and
 * the bare specifier `'three'` resolves through the import map in `index.html`,
 * which node has never heard of. So a dynamics test could only ever run on a
 * machine where `npm install` had already happened.
 *
 * That assumption broke on the first session that opened a fresh clone:
 * `node_modules/` is in .gitignore, npm answered 403, and every arithmetic test
 * in the project was unrunnable — including the ones the handoff insists are the
 * *only* valid way to measure anything with a time constant in it.
 *
 * The repository already contains the exact file needed. `vendor/three.module.js`
 * is the ES build, it imports cleanly under node, and its maths classes touch no
 * browser global. This writes the eight lines of packaging that let node find
 * it. Idempotent, offline, and it costs nothing to call at the top of a tool.
 *
 *   node tools/vendorlink.mjs      # standalone
 *   import { ensureThree } from './vendorlink.mjs'; ensureThree();
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PKG = JSON.stringify({
  name: 'three',
  version: '0.0.0-vendored',
  type: 'module',
  main: 'index.mjs',
  exports: { '.': './index.mjs' },
}, null, 2) + '\n';

const INDEX = "export * from '../../vendor/three.module.js';\n";

/** Point the bare specifier `three` at vendor/. Returns true if it wrote. */
export function ensureThree(verbose = false) {
  const dir = join(ROOT, 'node_modules', 'three');
  const pkg = join(dir, 'package.json');
  const idx = join(dir, 'index.mjs');
  const ok = existsSync(pkg) && existsSync(idx)
    && readFileSync(idx, 'utf8') === INDEX;
  if (ok) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(pkg, PKG);
  writeFileSync(idx, INDEX);
  if (verbose) console.log(`  vendorlink: wrote node_modules/three -> vendor/three.module.js`);
  return true;
}

const PW_PKG = JSON.stringify({
  name: 'playwright',
  version: '0.0.0-cdp-shim',
  type: 'module',
  main: 'index.mjs',
  exports: { '.': './index.mjs' },
}, null, 2) + '\n';

const PW_INDEX = "export * from '../../tools/cdp.mjs';\nexport { default } from '../../tools/cdp.mjs';\n";

/**
 * Point the bare specifier `playwright` at the local CDP shim.
 *
 * Only when there is no real Playwright installed — a genuine one is strictly
 * better and must win. The marker is the version string, so an installed
 * package is never overwritten and the shim is never mistaken for one.
 *
 * This exists because the registry has now been unavailable in two consecutive
 * sessions while the browser CDN was reachable in one of them. A browser and no
 * driver is a bad place to be for the sake of fifteen methods.
 */
export function ensurePlaywright(verbose = false) {
  const dir = join(ROOT, 'node_modules', 'playwright');
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    const j = JSON.parse(readFileSync(pkg, 'utf8'));
    if (j.version !== '0.0.0-cdp-shim') return false;   // a real one: leave it
    if (readFileSync(join(dir, 'index.mjs'), 'utf8') === PW_INDEX) return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(pkg, PW_PKG);
  writeFileSync(join(dir, 'index.mjs'), PW_INDEX);
  if (verbose) console.log('  vendorlink: wrote node_modules/playwright -> tools/cdp.mjs');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = ensureThree(true);
  const b = ensurePlaywright(true);
  console.log(a || b ? 'linked' : 'already linked');
}
