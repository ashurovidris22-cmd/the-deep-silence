/* Look at the sound, because this sandbox cannot hear it.
 *
 * There is no sound card here and there never will be, so the audio equivalent
 * of the contact sheet is a rendered buffer and a table of numbers. Two modes,
 * and the difference between them matters more than either:
 *
 *   --mode render   Real. Boots the page in headless Chromium and rebuilds the
 *                   graph inside an OfflineAudioContext, which renders faster
 *                   than real time and hands back actual samples. RMS, peak,
 *                   crest factor and energy per octave. This is a measurement.
 *
 *   --mode graph    Structural only. A stub AudioContext in node, just enough
 *                   API surface to let `src/audio.js` build its graph and run
 *                   frames. Proves the code path executes, every node type is
 *                   one this file actually asked for, and no automation call
 *                   receives a NaN. Proves NOTHING about how it sounds.
 *
 * The handoff's hardest-won lesson is that an environment which produces
 * plausible output is not the same as an environment that measures anything —
 * the cloud browser reported 10.0 fps with the volumetric pass cut to one step
 * at 8% resolution, a change that cannot be free. So `graph` mode prints a
 * banner saying what it did not establish, every time, and does not pretend.
 *
 *   node tools/listen.mjs --mode graph
 *   node tools/listen.mjs --mode render --seconds 8 --scene descent
 */
import { ensureThree } from './vendorlink.mjs';
ensureThree();

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const mode = arg('mode', 'graph');
const seconds = parseFloat(arg('seconds', '8'));
const scene = arg('scene', 'descent');

/* The states worth listening to. Each is a plain parameter set, so both modes
 * drive the identical sequence and their numbers are comparable. */
const SCENES = {
  // Sitting on the floor doing nothing. The title, and the quietest case.
  silence: () => ({ depth: 423, aboard: true, earZ: 6.9, throttle: 0, ballast: 0.5, ballastCmd: 0.5, way: 0, grounded: true, contact: 0, breath: 12, alarm: 0, phase: 'ok', boatRange: 0, scrubber: 1 }),
  // Falling. Loading rate up, so the hull talks.
  descent: (t) => ({ depth: 120 + t * 1.81, aboard: true, earZ: 6.9, throttle: 0, ballast: 1, ballastCmd: 1, way: 0, grounded: false, contact: 0, breath: 12, alarm: 0, phase: 'ok', boatRange: 0, scrubber: 1 }),
  // Full ahead in the machinery space, which is the loudest sustained case.
  plant: () => ({ depth: 300, aboard: true, earZ: -3.95, throttle: 1, ballast: 0.5, ballastCmd: 0.5, way: 4.5, grounded: false, contact: 0, breath: 12, alarm: 0, phase: 'ok', boatRange: 0, scrubber: 1 }),
  // Blowing. One press, then the tank works for half a minute on its own.
  blow: (t) => ({ depth: 400, aboard: true, earZ: 6.9, throttle: 0, ballast: 0.5, ballastCmd: t < 1.2 ? 0.5 - t * 0.42 : 0.0, way: 0, grounded: false, contact: 0, breath: 12, alarm: 0, phase: 'ok', boatRange: 0, scrubber: 1 }),
  // Outside the hull: quieter, darker, and with no idea where anything is.
  // Outside the hull, a long way from the trunk, breathing hard and low on
  // sorbent. The pinger, the lungs and the alarm all live in this one.
  water: (t) => ({ depth: 400, aboard: false, earZ: 24, throttle: 0.4, ballast: 0.5, ballastCmd: 0.5, way: 2, grounded: false, contact: 0, breath: 26 + t, alarm: 1, phase: 'critical', boatRange: 78, scrubber: 0.06 }),
  /* Outside, far out, calm, sorbent to spare — so the pinger is the only thing
   * happening. Added because in `water` the 4 kHz octave sat 40 dB down and it
   * was not clear whether that meant inaudible or merely sparse: a band average
   * under-reads a transient by its duty cycle, and a 0.13 s ping every two
   * seconds is six per cent, which is -12 dB before anything else. */
  beacon: () => ({ depth: 400, aboard: false, earZ: 24, throttle: 0, ballast: 0.5, ballastCmd: 0.5, way: 0, grounded: false, contact: 0, breath: 11, alarm: 0, phase: 'ok', boatRange: 60, scrubber: 1 }),
};

/* Resolve the scene ONCE, here, and refuse an unknown name.
 *
 * The in-page copy of this table used to fall back to `descent` for anything it
 * did not recognise, so asking for a scene that was only half-added rendered a
 * completely different one and printed the name that had been asked for. Ten
 * minutes were spent reading a spectrum belonging to another scene. That is the
 * exact failure this harness exists to prevent — `boot.mjs`'s header is about a
 * capture that silently photographs the title card — and it had been reproduced
 * inside the tool itself. */
if (!SCENES[scene]) {
  console.log(`\n  unknown scene "${scene}". Known: ${Object.keys(SCENES).join(', ')}\n`);
  process.exit(2);
}

const bands = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/* ==================================================================== graph */

/** The smallest AudioContext that `src/audio.js` can be built against. */
function stubContext(sampleRate = 48000) {
  const problems = [];
  const num = (label, v) => {
    if (!Number.isFinite(v)) problems.push(`${label} received ${v}`);
    return v;
  };
  let created = {};
  const tally = (k) => { created[k] = (created[k] || 0) + 1; };

  const param = (name, value = 0) => ({
    value,
    setValueAtTime: (v, t) => num(`${name}.setValueAtTime`, v) && num(`${name}.time`, t),
    linearRampToValueAtTime: (v, t) => { num(`${name}.linearRamp`, v); num(`${name}.time`, t); },
    exponentialRampToValueAtTime: (v, t) => {
      num(`${name}.expRamp`, v); num(`${name}.time`, t);
      if (v === 0) problems.push(`${name}.exponentialRampToValueAtTime(0) is illegal`);
    },
    setTargetAtTime: (v, t, tau) => {
      num(`${name}.setTarget`, v); num(`${name}.time`, t); num(`${name}.tau`, tau);
    },
  });

  const node = (kind, extra = {}) => {
    tally(kind);
    const n = {
      kind, connections: 0,
      connect(dst) { this.connections++; return dst; },
      disconnect() {},
      ...extra,
    };
    return n;
  };

  return {
    _problems: problems,
    _created: () => created,
    sampleRate,
    currentTime: 0,
    state: 'running',
    destination: node('destination'),
    resume() {},
    createGain: () => node('gain', { gain: param('gain', 1) }),
    createBiquadFilter: () => node('biquad', {
      type: 'lowpass', frequency: param('freq', 350), Q: param('Q', 1), gain: param('peak', 0),
    }),
    createDynamicsCompressor: () => node('compressor', {
      threshold: param('threshold', -24), knee: param('knee', 30), ratio: param('ratio', 12),
      attack: param('attack', 0.003), release: param('release', 0.25),
    }),
    createConvolver: () => node('convolver', { normalize: true, buffer: null }),
    /* Oscillators end too. The first version of this stub made start and stop
     * no-ops, so `onended` never fired for the pinger or the alarm and sixteen
     * voices "leaked" — in the stub only. A leak checker that cannot see half the
     * voices is worse than none, because it reports a clean run. */
    createOscillator() {
      const ctx = this;
      return node('osc', {
        type: 'sine', frequency: param('oscFreq', 440), detune: param('detune', 0),
        onended: null,
        start(when) { this._t0 = when || 0; },
        stop(when) { ctx._pending.push({ src: this, end: when || 0 }); },
        setPeriodicWave() {},
      });
    },
    /* One-shot sources have to *end*, or the leak this is meant to catch is the
     * one thing it cannot see. `_tick` fires the due callbacks, so the
     * disconnect path in `_creak` and `_thud` is exercised and the voice counter
     * means something. */
    _pending: [],
    _tick(t) {
      const due = this._pending.filter((p) => p.end <= t);
      this._pending = this._pending.filter((p) => p.end > t);
      for (const p of due) p.src.onended?.();
    },
    createBufferSource() {
      const ctx = this;
      return node('bufferSource', {
        buffer: null, loop: false, playbackRate: param('rate', 1),
        onended: null,
        start(when, offset, duration) {
          num('bufferSource.start.when', when ?? 0);
          if (offset !== undefined) num('bufferSource.start.offset', offset);
          if (duration !== undefined) num('bufferSource.start.duration', duration);
          if (this.buffer && offset !== undefined && duration !== undefined
              && offset + duration > this.buffer.duration + 1e-6) {
            problems.push(`bufferSource reads past the end: ${(offset + duration).toFixed(2)}s of a ${this.buffer.duration.toFixed(2)}s buffer`);
          }
          if (!this.loop) {
            const len = duration ?? ((this.buffer ? this.buffer.duration : 0) - (offset || 0));
            ctx._pending.push({ src: this, end: (when || 0) + len });
          }
        },
        stop() {},
      });
    },
    createPeriodicWave: (real, imag) => {
      if (real.length !== imag.length) problems.push('createPeriodicWave: real and imag differ in length');
      if (real.length < 2) problems.push('createPeriodicWave: needs at least two coefficients');
      return node('periodicWave');
    },
    createBuffer(ch, len, sr) {
      tally('buffer');
      if (!(len > 0)) problems.push(`createBuffer length ${len}`);
      const data = [];
      for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => data[i] };
    },
  };
}

async function graphMode() {
  const ctx = stubContext();
  global.window = { AudioContext: function () { return ctx; } };
  const { Audio } = await import('../src/audio.js');
  const a = new Audio();
  const ok = a.start();

  console.log(`\n  start() -> ${ok ? 'built' : 'FAILED'}   state ${a.state}${a.error ? '  ' + a.error : ''}`);
  const made = ctx._created();
  console.log('  nodes created: ' + Object.entries(made).map(([k, v]) => `${k} ${v}`).join(', '));

  // Drive every scene, so every automation path is exercised at least once.
  const DT = 1 / 60;
  let frames = 0;
  for (const [name, fn] of Object.entries(SCENES)) {
    for (let i = 0; i < 60 * 4; i++) {
      ctx.currentTime += DT;
      ctx._tick(ctx.currentTime);
      a.update(DT, fn(i * DT));
      frames++;
    }
    // Let the tails run out before reading the voice count.
    for (let i = 0; i < 60 * 3; i++) { ctx.currentTime += DT; ctx._tick(ctx.currentTime); }
    console.log(`  ${name.padEnd(8)} -> ${a.report()}`);
  }
  console.log(`  ${frames} frames, ${a._events} events fired, ${a.voices} voices still open`);

  const p = [...new Set(ctx._problems)];
  if (p.length) {
    console.log(`\n  ${p.length} PROBLEM(S):`);
    for (const s of p) console.log(`    - ${s}`);
  } else {
    console.log('\n  no NaNs, no illegal ramps, no reads past a buffer end');
  }

  console.log(`
  ------------------------------------------------------------------
  THIS WAS STRUCTURAL ONLY. It proves the graph builds and that the
  numbers going into it are finite. It does NOT establish that
  anything is audible, that the balance is right, or that the mix
  does not clip: no samples were rendered. For that, install
  Playwright and run --mode render.
  ------------------------------------------------------------------`);
  return p.length ? 1 : 0;
}

/* =================================================================== render */

async function renderMode() {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch {
    console.log('\n  playwright is not installed, so there is no browser to render in.');
    console.log('  npm install playwright && npx playwright install chromium');
    console.log('  Falling back to --mode graph would prove something weaker; not doing it silently.\n');
    return 2;
  }
  const { GPU_ARGS } = await import('./boot.mjs');
  const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()); });
  await page.goto(`http://localhost:8123/?auto=1&sound=0&hud=0`, { waitUntil: 'domcontentloaded' });

  /* Render inside the page, against an OfflineAudioContext.
   *
   * The graph is rebuilt on an offline context rather than the live one because
   * an offline render is deterministic and faster than real time — the same
   * argument as seeding the world's PRNG. The scene's parameter sets are passed
   * in from here so both modes drive the same sequence. */
  const DT = 1 / 60;
  const fn = SCENES[scene];
  const timeline = [];
  for (let i = 0; i < Math.floor(seconds / DT); i++) timeline.push(fn(i * DT));

  const out = await page.evaluate(async ({ seconds, timeline, bands }) => {
    const mod = await import('/src/audio.js');
    const SR = 48000;
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const real = window.AudioContext;
    // Audio.start() reads window.AudioContext; hand it the offline one.
    window.AudioContext = function () { return ctx; };
    const a = new mod.Audio();
    const built = a.start();
    window.AudioContext = real;
    if (!built) return { error: a.error || 'start() failed' };

    /* Web Audio schedules against ctx.currentTime, which does not advance until
     * the render runs. So push the whole parameter timeline first, with an
     * explicit clock, then render once. */
    /* The parameter timeline is computed in node from the single scene table and
     * handed over, rather than the table being duplicated in here. It was
     * duplicated, the two copies drifted the moment a scene was added, and the
     * page's copy silently substituted another scene. One owner. */
    const DT = 1 / 60;
    let clock = 0;
    for (const st of timeline) {
      Object.defineProperty(ctx, 'currentTime', { value: clock, configurable: true });
      a.update(DT, st);
      clock += DT;
    }
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);

    let sum = 0, peak = 0, clipped = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      sum += x * x;
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
      if (ax >= 0.999) clipped++;
    }
    const rms = Math.sqrt(sum / d.length);

    /* Energy per octave, by Goertzel averaged ACROSS each band.
     *
     * The first version evaluated one bin at each centre frequency and called the
     * result "energy by octave". Over four seconds a bin is 0.25 Hz wide, so for
     * broadband noise that is a single sample of a random variable — it reported
     * 500 Hz at -5 dB with 250 and 1000 Hz thirty decibels below, which is not a
     * spectrum, it is a fluke. Nine probes spread geometrically over each octave
     * and averaged in power gives the band its actual energy, and costs nine
     * times almost nothing. */
    const n = Math.min(d.length, SR * 4);
    const goertzel = (f) => {
      const c = 2 * Math.cos(2 * Math.PI * f / SR);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);   // power, not amplitude
    };
    const energy = bands.map((f) => {
      let acc = 0, k = 0;
      for (let j = -4; j <= 4; j++) {
        const fj = f * Math.pow(2, j / 12);      // a semitone apart, inside the octave
        if (fj > 20 && fj < SR / 2 - 100) { acc += goertzel(fj); k++; }
      }
      return Math.sqrt(acc / Math.max(1, k));
    });
    return { rms, peak, clipped, samples: d.length, energy, events: a._events, voices: a.voices, report: a.report() };
  }, { seconds, timeline, bands });

  await browser.close();
  if (out.error) { console.log('\n  render failed:', out.error, '\n'); return 1; }

  console.log(`\n  scene ${scene}, ${seconds}s at 48 kHz, ${out.samples} samples`);
  console.log(`  rms ${out.rms.toFixed(5)}   peak ${out.peak.toFixed(4)}   crest ${(out.peak / Math.max(1e-9, out.rms)).toFixed(1)}x   clipped ${out.clipped}`);
  console.log(`  events ${out.events}, voices open at end ${out.voices}`);
  console.log('  energy by octave:');
  const top = Math.max(...out.energy, 1e-12);
  out.energy.forEach((e, i) => {
    const db = 20 * Math.log10(Math.max(1e-12, e / top));
    const bar = '#'.repeat(Math.max(0, Math.round(40 + db / 1.5)));
    console.log(`    ${String(bands[i]).padStart(6)} Hz  ${db.toFixed(1).padStart(7)} dB  ${bar}`);
  });
  if (out.clipped) console.log('\n  CLIPPING: the budget in acoustics.js is wrong, fix it there, not with the limiter');
  console.log('');
  return 0;
}

/* ===================================================================== main */
const code = mode === 'render' ? await renderMode() : await graphMode();
process.exit(code);
