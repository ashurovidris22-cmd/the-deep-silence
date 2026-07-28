/* Tile frames into one image.
 *
 *   node tools/sheet.mjs shots/*.png --out shots/_sheet.png [--cols 4] [--w 470]
 *
 * A reviewer handed one frame at a time will comment on that frame. A reviewer
 * handed the whole set at once notices that everything is too dark, or that two
 * shots are the same picture — which are the failures that actually matter and
 * the ones no single frame can reveal.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const OUT = opt('out', 'shots/_sheet.png');
const CW = +opt('w', 470);
if (!files.length) { console.error('no input files'); process.exit(1); }

const COLS = +opt('cols', Math.min(4, Math.ceil(Math.sqrt(files.length))));
const ROWS = Math.ceil(files.length / COLS);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const inputs = [], filters = [];
files.forEach((f, i) => {
  inputs.push('-i', f);
  // A hairline border, because adjacent dark frames otherwise merge into one
  // continuous smear and you cannot tell where a shot ends.
  filters.push(`[${i}:v]scale=${CW}:-1,pad=iw+4:ih+4:2:2:0x2a2a2a[t${i}]`);
});
const pad = COLS * ROWS - files.length;
for (let i = 0; i < pad; i++) {
  filters.push(`color=c=black:s=${CW + 4}x${Math.round(CW * 9 / 16) + 4}[t${files.length + i}]`);
}
const layout = Array.from({ length: COLS * ROWS }, (_, i) => {
  const c = i % COLS, r = (i / COLS) | 0;
  const xs = c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+');
  const ys = r === 0 ? '0' : Array.from({ length: r }, (_, k) => `h${k * COLS}`).join('+');
  return `${xs}_${ys}`;
}).join('|');
const stack = Array.from({ length: COLS * ROWS }, (_, i) => `[t${i}]`).join('');
filters.push(`${stack}xstack=inputs=${COLS * ROWS}:layout=${layout}[out]`);

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs,
  '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', OUT],
{ stdio: 'inherit' });

// ffmpeg here has no freetype, so tiles cannot carry their names. Print the
// reading order instead — an unlabelled sheet is useless for acting on.
console.log(`${OUT}  ${COLS}x${ROWS}`);
files.forEach((f, i) => {
  const c = i % COLS;
  process.stdout.write(path.basename(f).replace(/\.[a-z]+$/, '').padEnd(14)
    + (c === COLS - 1 || i === files.length - 1 ? '\n' : ''));
});
