/* The gate: run both arithmetic harnesses and diff them against `reference/`.
 *
 *   node tools/gate.mjs
 *
 * Exists because the comparison itself has now produced two false failures on
 * two different machines, and a gate you do not trust is worse than no gate —
 * the first instinct on a red result is to go looking in the game, and both
 * times the fault was in the diff.
 *
 *  - `grep -v '^#'` leaves a blank line the baselines do not have, and reports
 *    a one-line difference that is entirely your own (machine 3).
 *  - PowerShell's `*>` redirection writes UTF-8 **with a BOM**, so every
 *    captured file differs from every committed file at byte zero (machine 4).
 *
 * Both are stripped here, once, so no caller has to remember either. Exits
 * non-zero on a real difference, and prints the first differing line rather
 * than the whole file — a wall of identical-looking numbers hides the one that
 * moved.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the comparison must not be sensitive to. */
const normalise = (s) => s
  .replace(/^﻿/, '')          // PowerShell `*>` BOM
  .replace(/^#[^\n]*\n/gm, '')     // baseline header comments
  .replace(/\r/g, '')              // CRLF, if a checkout or an editor added it
  .replace(/^\n+/, '')             // leading blank lines, whoever produced them
  .replace(/\n+$/, '\n');          // trailing ones

const CASES = [
  { name: 'dynamics', argv: ['tools/dyn.mjs'], base: 'reference/baseline-dyn.txt' },
  { name: 'audio graph', argv: ['tools/listen.mjs', '--mode', 'graph'], base: 'reference/baseline-listen.txt' },
];

let failed = 0;
for (const c of CASES) {
  const got = normalise(execFileSync(process.execPath, c.argv, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24,
  }));
  const want = normalise(readFileSync(join(ROOT, c.base), 'utf8'));
  if (got === want) {
    console.log(`  ${c.name.padEnd(13)} matches ${c.base}`);
    continue;
  }
  failed++;
  const g = got.split('\n'), w = want.split('\n');
  console.log(`  ${c.name.padEnd(13)} DIFFERS from ${c.base}`);
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] === w[i]) continue;
    console.log(`      first difference at line ${i + 1}`);
    console.log(`      got   ${JSON.stringify(g[i])}`);
    console.log(`      want  ${JSON.stringify(w[i])}`);
    break;
  }
}

/* A difference is not automatically a defect — several passes have changed
 * these numbers on purpose. It IS automatically something to explain in the
 * commit body before regenerating the baseline. */
console.log(failed
  ? `\n  ${failed} gate(s) differ. Explain the change, then regenerate:\n`
    + '    node tools/dyn.mjs > reference/baseline-dyn.txt'
  : '\n  both gates match the committed baselines');
process.exit(failed ? 1 : 0);
