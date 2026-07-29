/* Dynamics, as arithmetic. No browser, no renderer, no audio device.
 *
 * The handoff's rule, and it is the most expensive lesson in the project: the
 * sandbox runs the page at one or two frames a second with `dt` clamped to 0.1,
 * so eight seconds of wall clock is under a second of simulated time and *every*
 * measurement with a time constant in it comes back wrong. Adaptation,
 * acceleration and ballast were all measured here rather than in a browser.
 *
 * Sound is nothing but time constants. A creak rate per minute, a two and a half
 * second spin-up, a tank that takes seconds to answer — none of it can be heard
 * from a sandbox that has no sound card, and none of it could be trusted from
 * one that did. So the sound layer was built to be measurable: `src/acoustics.js`
 * maps game state to synthesiser parameters as pure arithmetic, and this drives
 * it against the *real* `Vessel` at a fixed 60 Hz.
 *
 * Driving the real vessel rather than a synthetic depth ramp is the point. The
 * ballast lag, the drag, the bottom contact and the terrain are all in the loop,
 * so what comes out is what a player will actually hear.
 *
 *   node tools/dyn.mjs                 # everything
 *   node tools/dyn.mjs --only descent
 */
import { ensureThree } from './vendorlink.mjs';
ensureThree();

const THREE = await import('three');
const { SEA_LEVEL, seabedHeight } = await import('../src/terrain.js');
const { Vessel } = await import('../src/vessel.js');
const { HELM } = await import('../src/hull.js');
const A = await import('../src/acoustics.js');
const { Acoustics } = A;

const DT = 1 / 60;                    // fixed. The whole reason this file exists.
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const only = arg('only', null);

const f = (v, n = 2) => v.toFixed(n).padStart(n + 5);
const hr = (s) => console.log(`\n${'-'.repeat(74)}\n${s}\n${'-'.repeat(74)}`);

/* One rig: a vessel at a depth, and the acoustic map that listens to her. The
 * ear sits at the helm, which is 10.85 m forward of the pump skid — that
 * distance is what makes the machinery quiet at the wheel and loud in the
 * plant, so it has to be in the test. */
function rig(depth0, x = 0, z = 0) {
  const v = new Vessel(new THREE.Vector3(x, SEA_LEVEL - depth0, z), 0);
  return { v, a: new Acoustics(), earZ: HELM.z, t: 0, fired: [] };
}

function step(r, dt = DT) {
  r.v.update(dt, SEA_LEVEL - 8);
  const depth = Math.max(0.4, SEA_LEVEL - r.v.pos.y);
  r.a.update(dt, {
    depth, aboard: true, earZ: r.earZ,
    throttle: r.v.throttle, ballast: r.v.ballast, ballastCmd: r.v.ballastCmd,
    way: r.v.way, grounded: r.v.grounded, contact: r.v.contact, muted: false,
  });
  r.t += dt;
  for (const e of r.a.events) r.fired.push({ t: r.t, ...e });
  return depth;
}

/** Sum of every continuous voice. The number the loudness budget is about. */
const bedSum = (v) => v.bedLow + v.bedHiss + v.machGain + v.balGain + v.scrape;

/* ===================================================================== */
function constants() {
  hr('DERIVED CONSTANTS  (every number quoted in a comment, checkable)');
  console.log(`  shell ring frequency      ${f(A.SHELL_RING, 1)} Hz    c_L/(2 pi R), R = 2.35 m`);
  console.log(`  ovalling mode n=2         ${f(A.OVALLING, 1)} Hz    infrasonic: felt, not heard`);
  console.log('  hull modes the creak may use:');
  for (const m of A.HULL_MODES) {
    console.log(`      ${m.family.padEnd(6)} ${f(m.f, 1)} Hz   Q ${String(m.q).padStart(3)}   decay ${f(m.decay, 2)} s`);
  }
  console.log('  cabin air modes:');
  for (const [k, v] of Object.entries(A.CABIN_MODES)) {
    const note = k === 'axial' ? '   <- below hearing. The length of the boat is silent.' : '';
    console.log(`      ${k.padEnd(11)} ${f(v, 1)} Hz${note}`);
  }
  console.log(`  blade pass, idle 380 rpm  ${f(A.bladePass(5, 380), 1)} Hz    carried by its harmonics, not its fundamental`);
  console.log(`  blade pass, full 1450 rpm ${f(A.bladePass(5, 1450), 1)} Hz`);
  console.log(`  mains hum, fixed          ${f(A.MOTOR.hum, 1)} Hz    does not move with the telegraph`);
  console.log(`  bubble, 2 mm at surface   ${f(A.minnaert(0.002, 1), 0)} Hz`);
  console.log(`  bubble, 2 mm at 426 m     ${f(A.minnaert(0.002, 1 + 426 / 10.06), 0)} Hz    sqrt(P): the blow tells you your depth`);
  console.log(`  Thorp at 1 kHz            ${A.thorp(1).toFixed(4)} dB/km  -> ${(A.thorp(1) * 0.02).toFixed(5)} dB over 20 m`);
  console.log('                                       water does not muffle anything at this range');
}

/* ===================================================================== */
function tank() {
  hr('BALLAST TANK  —  measuring the lag the whole design rests on');
  const r = rig(200);
  r.v.ballastCmd = 1.0;
  r.v.ballast = 0.0;
  const target = 1 - 1 / Math.E;
  let tau = null, t95 = null;
  for (let i = 0; i < 60 * 30; i++) {
    step(r);
    if (tau === null && r.v.ballast >= target) tau = r.t;
    if (t95 === null && r.v.ballast >= 0.95) t95 = r.t;
  }
  console.log(`  measured time constant    ${f(tau, 2)} s`);
  console.log(`  time to 95 per cent       ${f(t95, 2)} s`);
  console.log(`  stated intent             8.00 s   (vessel.js comment, README, HANDOFF)`);
  const verdict = Math.abs(tau - 8) < 1.2 ? 'AGREES with the stated intent'
    : `DISAGREES with the stated intent by ${(8 / tau).toFixed(1)}x`;
  console.log(`  verdict                   ${verdict}`);
}

/* ===================================================================== */
function descent() {
  hr('DESCENT  —  flood at depth 60 and fall to the canyon floor');
  console.log('     t      depth    m/s    dP/dt   creak/s   fired  groan snap   bed   mach');
  const r = rig(60);
  r.v.ballastCmd = 1.0;
  let mark = 0, prev = 0;
  for (let i = 0; i < 60 * 320; i++) {
    step(r);
    if (r.t >= mark) {
      const n = r.fired.length - prev;
      const win = r.fired.slice(prev);
      prev = r.fired.length;
      const g = win.filter((e) => e.family === 'groan').length;
      const s = win.filter((e) => e.family === 'snap').length;
      console.log(`  ${f(r.t, 0)}   ${f(SEA_LEVEL - r.v.pos.y, 1)}  ${f(r.v.vel.y, 2)}  ${f(r.a.dPdt, 4)}   ${f(r.a.creakRate, 3)}   ${String(n).padStart(5)}  ${String(g).padStart(5)} ${String(s).padStart(4)}  ${f(bedSum(r.a.v), 3)} ${f(r.a.v.machGain, 3)}`);
      mark += 40;
    }
  }
  const floor = SEA_LEVEL - seabedHeight(0, 0);
  console.log(`  reached ${(SEA_LEVEL - r.v.pos.y).toFixed(1)} m; seabed here is ${floor.toFixed(1)} m; aground: ${r.v.grounded}`);
  console.log(`  total creaks ${r.fired.filter((e) => e.kind === 'creak').length}, thuds ${r.fired.filter((e) => e.kind === 'thud').length}`);
}

/* ===================================================================== */
function telegraph() {
  hr('TELEGRAPH  —  the note has to slide after the handle stops');
  const r = rig(200);
  for (let i = 0; i < 60 * 2; i++) step(r);
  const rpm0 = r.a.rpm, blade0 = r.a.v.machBlade;
  r.v.throttle = 1.0;
  let t95 = null, tau = null;
  const span = A.MOTOR.rpmFull - A.MOTOR.rpmIdle;
  console.log('     t       rpm    blade Hz   rough    machGain    way');
  let mark = r.t;
  for (let i = 0; i < 60 * 40; i++) {
    step(r);
    const frac = (r.a.rpm - A.MOTOR.rpmIdle) / span;
    if (tau === null && frac >= 1 - 1 / Math.E) tau = r.t - 2;
    if (t95 === null && frac >= 0.95) t95 = r.t - 2;
    if (r.t >= mark) {
      console.log(`  ${f(r.t - 2, 1)}  ${f(r.a.rpm, 0)}    ${f(r.a.v.machBlade, 1)}   ${f(r.a.v.machRough, 3)}   ${f(r.a.v.machGain, 4)}  ${f(r.v.way, 2)}`);
      mark += 2.5;
    }
  }
  console.log(`  idle:  ${rpm0.toFixed(0)} rpm, blade ${blade0.toFixed(1)} Hz`);
  console.log(`  spin-up time constant ${tau.toFixed(2)} s (declared ${A.MOTOR.spinUp}), 95% at ${t95.toFixed(2)} s`);
  console.log('  cavitation clears as she gathers way — that is the screw, not the motor');
}

/* ===================================================================== */
function ballast() {
  hr('BALLAST HISS  —  the sound IS the instrument for an invisible tank');
  const r = rig(300);
  for (let i = 0; i < 60; i++) step(r);
  // Hold Space for 1.2 s, exactly as main.js does it: cmd -= dt * 0.42
  const holdFor = 1.2;
  let held = 0;
  console.log('     t     cmd   tank    flow    balGain   bubble Hz');
  let mark = r.t, peak = 0, lastAudible = 0;
  for (let i = 0; i < 60 * 25; i++) {
    if (held < holdFor) { r.v.ballastCmd = Math.max(0, r.v.ballastCmd - DT * 0.42); held += DT; }
    step(r);
    peak = Math.max(peak, r.a.v.balGain);
    if (r.a.v.balGain > 0.003) lastAudible = r.t;
    if (r.t >= mark) {
      console.log(`  ${f(r.t, 1)}  ${f(r.v.ballastCmd, 3)}  ${f(r.v.ballast, 3)}  ${f(r.v.ballastCmd - r.v.ballast, 4)}   ${f(r.a.v.balGain, 4)}    ${f(r.a.v.balBubble, 0)}`);
      mark += 1.5;
    }
  }
  console.log(`  peak hiss ${peak.toFixed(3)} (budget ${A.BUDGET.ballast}); audible for ${lastAudible.toFixed(1)} s after a ${holdFor} s press`);
  console.log(`  blow flag ${r.a.v.balBlow} — HP air, so bright; flooding is the other tone`);
}

/* ===================================================================== */
function silence() {
  hr('THE DEEP SILENCE  —  sitting still on the floor, which is the title');
  const r = rig(300);
  r.v.ballastCmd = 1.0;
  for (let i = 0; i < 60 * 260; i++) step(r);   // get her down and settled
  r.v.ballastCmd = 0.5;
  for (let i = 0; i < 60 * 40; i++) step(r);
  const t0 = r.t, n0 = r.fired.length;
  let sum = 0, n = 0, peak = 0;
  for (let i = 0; i < 60 * 120; i++) {
    step(r); sum += bedSum(r.a.v); n++;
    peak = Math.max(peak, bedSum(r.a.v));
  }
  const creaks = r.fired.length - n0;
  console.log(`  depth ${(SEA_LEVEL - r.v.pos.y).toFixed(1)} m, aground ${r.v.grounded}, way ${r.v.way.toFixed(2)} m/s`);
  console.log(`  continuous level: mean ${(sum / n).toFixed(4)}, peak ${peak.toFixed(4)}`);
  console.log(`  budget says the floor should sit near 0.018 + machinery at the helm`);
  console.log(`  creaks in ${(r.t - t0).toFixed(0)} s: ${creaks}  (${(creaks / ((r.t - t0) / 60)).toFixed(1)} per minute)`);
  console.log(`  dP/dt at rest ${r.a.dPdt.toExponential(1)} atm/s — a hull in equilibrium is quiet`);
}

/* ===================================================================== */
function instrument() {
  hr('WHICH WAY AM I GOING  —  groans down, snaps up, with your eyes shut');
  for (const [label, cmd, d0] of [['descending', 1.0, 80], ['ascending', 0.0, 380]]) {
    const r = rig(d0);
    r.v.ballastCmd = cmd;
    for (let i = 0; i < 60 * 150; i++) step(r);
    const c = r.fired.filter((e) => e.kind === 'creak');
    const g = c.filter((e) => e.family === 'groan').length;
    const s = c.filter((e) => e.family === 'snap').length;
    const pct = (100 * g / Math.max(1, c.length)).toFixed(0);
    console.log(`  ${label.padEnd(11)} ${String(c.length).padStart(4)} creaks   groan ${String(g).padStart(4)}  snap ${String(s).padStart(4)}   ${pct}% groan`);
  }
}

/* ===================================================================== */
function stuck() {
  hr('NO STUCK VOICES  —  everything back to its floor after the excitement');
  const r = rig(120);
  r.v.throttle = 1.0; r.v.ballastCmd = 1.0;
  for (let i = 0; i < 60 * 200; i++) step(r);
  const busy = { ...r.a.v };
  r.v.throttle = 0; r.v.ballastCmd = r.v.ballast;
  for (let i = 0; i < 60 * 60; i++) step(r);
  const rows = [
    ['machGain', busy.machGain, r.a.v.machGain, A.BUDGET.machIdle * 1.1],
    ['balGain', busy.balGain, r.a.v.balGain, 0.001],
    ['scrape', busy.scrape, r.a.v.scrape, 0.001],
    ['machRough', busy.machRough, r.a.v.machRough, 0.001],
  ];
  console.log('  voice        busy      settled    ceiling   ok');
  let allOk = true;
  for (const [k, b, s, lim] of rows) {
    const ok = s <= lim;
    allOk = allOk && ok;
    console.log(`  ${k.padEnd(11)} ${f(b, 4)}   ${f(s, 4)}   ${f(lim, 4)}   ${ok ? 'yes' : 'NO'}`);
  }
  console.log(`  ${allOk ? 'all voices released' : 'A VOICE IS STUCK ON'}`);
}

/* ===================================================================== */
const SUITE = { constants, tank, descent, telegraph, ballast, silence, instrument, stuck };
for (const [name, fn] of Object.entries(SUITE)) {
  if (only && only !== name) continue;
  fn();
}
console.log('');
