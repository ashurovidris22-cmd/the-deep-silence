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
/* The real camera basis, imported rather than rewritten. A steering test that
 * transcribes the convention it is testing proves only that two copies of a
 * mistake agree — and this project has already had a strafe vector that was its
 * own negative because someone wrote it out by hand. */
const { headingDir, screenRight } = await import('../src/controls.js');
const A = await import('../src/acoustics.js');
const LIFE = await import('../src/life.js');
const CREATURE = await import('../src/creatures.js');
const RECORDER = await import('../src/recorder.js');
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

function step(r, dt = DT, extra = null) {
  r.v.update(dt, SEA_LEVEL - 8);
  const depth = Math.max(0.4, SEA_LEVEL - r.v.pos.y);
  r.a.update(dt, {
    depth, aboard: true, earZ: r.earZ,
    throttle: r.v.throttle, ballast: r.v.ballast, ballastCmd: r.v.ballastCmd,
    way: r.v.way, grounded: r.v.grounded, contact: r.v.contact, muted: false,
    ...(extra || {}),
  });
  r.t += dt;
  for (const e of r.a.events) r.fired.push({ t: r.t, ...e });
  return depth;
}

/** Sum of every continuous voice. The number the loudness budget is about. */
const bedSum = (v) => v.bedLow + v.bedHiss + v.machGain + v.balGain + v.scrape + v.scoreGain;

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
function helm() {
  hr('THE HELM  —  does the boat turn the way the pilot is facing?');
  /* Reported by a player as "steering is inverted", and it was. Two signs from
   * one handedness confusion, and both are asserted here so they cannot come
   * back quietly: the rudder does nothing at rest, so nothing else was ever
   * going to notice.
   *
   * The seated station aims from z = 6.25 toward z = 8.20, along hull +Z, which
   * AIM() solves as local yaw 180. */
  const localYaw = Math.atan2(0, -(8.20 - HELM.z + 0.65)) * 180 / Math.PI;
  let pass = true;
  console.log(`  helm station local yaw ${localYaw.toFixed(0)} deg, looking along hull +Z`);
  for (const [label, rud, want] of [['D  starboard', +1, 'RIGHT'], ['A  port', -1, 'LEFT']]) {
    const r = rig(200);
    r.v.throttle = 1;
    for (let i = 0; i < 60 * 25; i++) step(r);          // a rudder needs way
    const bow0 = r.v.forward().clone();
    const h0 = r.v.heading;
    // Screen-right at the instant of the turn, from the real basis.
    const right = screenRight(headingDir(localYaw * Math.PI / 180 - r.v.yaw, 0));
    for (let i = 0; i < 60 * 6; i++) { r.v.rudder = rud; step(r); }
    const onScreen = r.v.forward().clone().sub(bow0).dot(right);
    const got = onScreen > 0 ? 'RIGHT' : 'LEFT';
    // Signed compass delta, wrapped into +-180.
    const dh = ((r.v.heading - h0 + 540) % 360) - 180;
    const hOk = (rud > 0) === (dh > 0);
    const ok = got === want && hOk;
    pass = pass && ok;
    console.log(`  ${label}   bow swings ${got.padEnd(5)} (want ${want.padEnd(5)})`
      + `  dot ${onScreen.toFixed(3).padStart(7)}`
      + `   heading ${h0.toFixed(0)} -> ${r.v.heading.toFixed(0)} (${dh > 0 ? '+' : ''}${dh.toFixed(0)})`
      + `   ${ok ? 'ok' : 'WRONG'}`);
  }
  console.log(`  ${pass ? 'helm agrees with the view, and the compass counts up to starboard'
    : 'STEERING IS INVERTED'}`);
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
function scrubber() {
  hr('LIFE SUPPORT  —  how long is an excursion, and what ends it');
  console.log(`  canister capacity ${LIFE.CAPACITY.toFixed(1)} l CO2 usable`
    + `  (0.25 kg sorbent x 120 l/kg, halved for 4 C water)`);
  console.log('\n  duration by how hard you swim:');
  for (const [label, speed] of [['floating still', 0], ['gentle 1.5 m/s', 1.5],
    ['cruise 4.4 m/s', 4.4], ['boosted 11.4 m/s', 11.4]]) {
    const l = new LIFE.Life();
    let t = 0;
    while (l.phase !== 'blackout' && t < 60 * 200) { l.update(DT, { aboard: false, speed }); t += DT; }
    console.log(`    ${label.padEnd(17)} ${(t / 60).toFixed(1)} min`
      + `   ${l.rate.toFixed(2)} l/min CO2`);
  }

  console.log('\n  the last quarter of a canister, at a cruise:');
  const l = new LIFE.Life();
  let t = 0, seen = {};
  while (l.phase !== 'waking' && t < 60 * 200) {
    l.update(DT, { aboard: false, speed: 4.4 });
    for (const e of l.events) if (e.kind === 'phase' || e.kind === 'blackout' || e.kind === 'wake') {
      const key = e.phase || e.kind;
      if (!seen[key]) {
        seen[key] = t;
        console.log(`    ${String(key).padEnd(10)} at ${(t / 60).toFixed(2)} min`
          + `   left ${(l.remaining * 100).toFixed(0)}%  breath ${l.breath.toFixed(0)} bpm`
          + `  veil ${l.veil.toFixed(2)}  alarm ${l.alarm.toFixed(2)}`);
      }
    }
    t += DT;
  }

  let wake = 0;
  while (l.fade > 0 && wake < 60 * 20) { l.update(DT, { aboard: true, speed: 0 }); wake += DT; }
  console.log(`    came round after ${wake.toFixed(1)} s of fade, phase ${l.phase}, canister fresh`);

  /* The case that actually matters, which the blackout path hides: coming back
   * aboard *voluntarily* with a nearly spent canister. A readout that snaps to
   * full on crossing the hatch tells the player the resource was never real. */
  const v = new LIFE.Life();
  let out = 0;
  while (v.remaining > 0.12 && out < 60 * 100) { v.update(DT, { aboard: false, speed: 4.4 }); out += DT; }
  const before = v.remaining;
  let swap = 0;
  while (v.remaining < 0.999 && swap < 60 * 60) { v.update(DT, { aboard: true, speed: 0 }); swap += DT; }
  console.log(`\n  came back at ${(before * 100).toFixed(0)}% after ${(out / 60).toFixed(1)} min out;`
    + ` full again ${swap.toFixed(1)} s later, phase ${v.phase}`);
  console.log(`  ${v.remaining > 0.999 && v.phase === 'ok' && swap > 5
    ? 'the loop closes both ways: blackout, and a swap you have to wait for'
    : 'THE LOOP DOES NOT CLOSE'}`);
}

/* ===================================================================== */
function score() {
  hr('THE SCORE  —  is it there, and does it stay under the instruments?');
  /* Asked for as "tense music, tastefully". The whole risk is that it damages the
   * silence the rest of the sound layer was built around, so the useful question
   * is not "can you hear it" but "can you still hear a creak over it". */
  console.log(`  floor ${A.SCORE.floor}  ceiling ${A.SCORE.ceiling}`
    + `  root ${A.SCORE.root.toFixed(1)} Hz  ring ${A.SCORE.ring.toFixed(1)} Hz`
    + `  ratio ${(A.SCORE.ring / A.SCORE.root).toFixed(2)}`);

  /* A real descent from the shelf, then sitting on the bottom for a while.
   *
   * `background` deliberately excludes the ballast hiss and the bottom scrape.
   * The first version of this check summed every continuous voice and reported a
   * catastrophic -13.7 dB, all of which came from frame zero: the test commands a
   * full flood instantly, so the blow was at maximum. But a blow is an
   * *instrument*, not a background — asking a creak to stand clear of it is like
   * asking it to stand clear of a grounding. What a creak has to beat is the
   * stuff that is always there. */
  const background = (v) => v.bedLow + v.bedHiss + v.machGain + v.scoreGain;
  const r = rig(60);
  r.v.ballastCmd = 1.0;
  let mark = 0, loudestScore = 0;
  let bgDeep = 0, bgShelf = 0, creakDeep = 1e9, creakShelf = 1e9;
  console.log('\n      t    depth   dP/dt   tension  score   crowd*duck   continuous');
  for (let i = 0; i < 60 * 420; i++) {
    if (r.t > 300) r.v.ballastCmd = 0.5;      // settle on the floor
    const depth = step(r, DT, { scrubber: 1, boatRange: 0 });
    const cont = bedSum(r.a.v);
    loudestScore = Math.max(loudestScore, r.a.v.scoreGain);
    const deep = depth > 380;
    if (deep) bgDeep = Math.max(bgDeep, background(r.a.v));
    else if (depth < 120) bgShelf = Math.max(bgShelf, background(r.a.v));
    for (const e of r.a.events) {
      if (e.kind !== 'creak') continue;
      if (deep) creakDeep = Math.min(creakDeep, e.level);
      else if (depth < 120) creakShelf = Math.min(creakShelf, e.level);
    }
    if (r.t >= mark) {
      const eff = r.a.v.scoreGain / Math.max(1e-9,
        A.SCORE.floor + (A.SCORE.ceiling - A.SCORE.floor) * r.a.tension);
      console.log(`  ${f(r.t, 0)}  ${f(SEA_LEVEL - r.v.pos.y, 1)}  ${f(r.a.dPdt, 4)}`
        + `   ${f(r.a.tension, 3)}  ${f(r.a.v.scoreGain, 4)}    ${f(eff, 3)}      ${f(cont, 4)}`);
      mark += 60;
    }
  }

  /* The gate, and it applies at depth rather than everywhere.
   *
   * On the shelf the margin is genuinely poor, and that is physics rather than a
   * defect: surface agitation noise is loudest in the shallows while hull stress
   * is lowest there, so a shelf creak is quiet against a bright bed. It is also
   * not where the game lives. The canyon floor is where a creak has to land, and
   * there the bed has faded to almost nothing — so that is the number the score's
   * ceiling is allowed to spend. Both are printed, so nobody has to rediscover
   * why the shallow one looks bad. */
  const mDeep = 20 * Math.log10(creakDeep / bgDeep);
  const mShelf = 20 * Math.log10(creakShelf / bgShelf);
  console.log(`\n  loudest score            ${loudestScore.toFixed(4)}  (ceiling ${A.SCORE.ceiling})`);
  console.log(`  on the floor, below 380 m:  background ${bgDeep.toFixed(4)}`
    + `  quietest creak ${creakDeep.toFixed(4)}   margin ${mDeep.toFixed(1)} dB`
    + `   ${mDeep >= 6 ? 'ok, a creak still lands' : 'TOO LOUD — lower SCORE.ceiling'}`);
  console.log(`  on the shelf, above 120 m:  background ${bgShelf.toFixed(4)}`
    + `  quietest creak ${creakShelf.toFixed(4)}   margin ${mShelf.toFixed(1)} dB`);
  console.log('                              expected to be poor: loud surface noise, low hull stress');

  // And the score has to actually respond to jeopardy, or it is wallpaper.
  console.log('\n  tension by cause, held for 90 s each:');
  for (const [label, extra] of [
    ['still, mid-water', { scrubber: 1, boatRange: 0 }],
    ['low on sorbent', { scrubber: 0.05, boatRange: 0 }],
    ['far from the trunk', { scrubber: 1, boatRange: 110, aboard: false }],
  ]) {
    const q = rig(300);
    for (let i = 0; i < 60 * 90; i++) step(q, DT, extra);
    console.log(`    ${label.padEnd(20)} tension ${q.a.tension.toFixed(2)}  score ${q.a.v.scoreGain.toFixed(4)}`);
  }
}

/* ===================================================================== */
function mimic() {
  hr('ACOUSTIC MIMIC  —  the way home learns to lie');
  const r = rig(180);
  for (let i = 0; i < 60 * 110; i++) {
    step(r, DT, {
      aboard: false, boatRange: 90, breath: 10, alarm: 0,
      scrubber: 0.8, phase: 'nominal',
    });
  }
  const real = r.fired.filter((e) => e.kind === 'ping' && !e.mimic);
  const falsePings = r.fired.filter((e) => e.kind === 'ping' && e.mimic);
  const first = falsePings[0];
  const beforeLearn = falsePings.filter((e) => e.t < A.MIMIC.learnTime).length;
  const realIntervals = real.slice(1).map((e, i) => e.t - real[i].t);
  const falseIntervals = falsePings.slice(1).map((e, i) => e.t - falsePings[i].t);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  console.log(`  true pings ${real.length}, false replies ${falsePings.length}`);
  console.log(`  first false reply at ${first ? first.t.toFixed(1) : 'never'} s`
    + `  (learning gate ${A.MIMIC.learnTime} s)`);
  console.log(`  frequencies true ${A.PINGER.f} Hz, false ${A.MIMIC.f} Hz`
    + `  detune ${A.PINGER.f - A.MIMIC.f} Hz`);
  console.log(`  mean cadence true ${mean(realIntervals).toFixed(2)} s, false ${mean(falseIntervals).toFixed(2)} s`);
  const ok = beforeLearn === 0 && first && first.t >= A.MIMIC.learnTime
    && falsePings.length >= 10 && A.MIMIC.f !== A.PINGER.f;
  console.log(`  ${ok ? 'mimic waits, learns, and remains detectably wrong' : 'MIMIC GATE FAILED'}`);
}

/* ===================================================================== */
function creature() {
  hr('FIRST CREATURE  —  swimming is a relation, not a clip');
  let monotonic = true, prev = -1;
  for (let i = 0; i <= 100; i++) {
    const a = CREATURE.amplitudeEnvelope(i / 100);
    monotonic = monotonic && Number.isFinite(a) && a >= prev;
    prev = a;
  }
  let proportional = true;
  for (const speed of [0, 0.3, 0.9, 1.8, 4.4]) {
    const fBeat = CREATURE.tailbeatFrequency(speed);
    const st = speed > 0 ? fBeat * CREATURE.TAIL_AMPLITUDE / speed : CREATURE.STROUHAL;
    proportional = proportional && Number.isFinite(fBeat)
      && (speed === 0 ? fBeat === 0 : Math.abs(st - CREATURE.STROUHAL) < 1e-9);
    console.log(`  speed ${speed.toFixed(1)} m/s  tailbeat ${fBeat.toFixed(2)} Hz  St ${st.toFixed(2)}`);
  }
  const hidden = CREATURE.mimicPresence(20, 90);
  const nearHatch = CREATURE.mimicPresence(90, 8);
  const revealed = CREATURE.mimicPresence(90, 90);
  console.log(`  envelope monotonic ${monotonic}  zero-speed finite ${CREATURE.tailbeatFrequency(0) === 0}`);
  console.log(`  presence before learning ${hidden.toFixed(2)}, at hatch ${nearHatch.toFixed(2)}, learned/open water ${revealed.toFixed(2)}`);
  const ok = monotonic && proportional && hidden === 0 && nearHatch === 0 && revealed > 0.99;
  console.log(`  ${ok ? 'motion and reveal obey the creature design' : 'CREATURE GATE FAILED'}`);
}

/* ===================================================================== */
function recorder() {
  hr('DEEP RECORDER  —  recovery is a commitment, not a proximity pickup');
  const target = new THREE.Vector3(4, -392, 7);
  const s = new RECORDER.RecorderState(target);
  const swimmer = target.clone().add(new THREE.Vector3(1.1, 0, 0));
  const began = s.begin(swimmer);
  for (let i = 0; i < 60 * (RECORDER.RECOVERY_TIME - 0.5); i++) {
    s.update(DT, { swimmer, holding: true, outside: true });
  }
  const early = s.carrying;
  for (let i = 0; i < 60; i++) s.update(DT, { swimmer, holding: true, outside: true });
  const carried = s.carrying && s.recovered;
  const deniedAtSea = !s.deliver(false);
  const delivered = s.deliver(true) && s.complete;

  const dropped = new RECORDER.RecorderState(target);
  dropped.begin(swimmer);
  for (let i = 0; i < 60 * 1.2; i++) dropped.update(DT, { swimmer, holding: true, outside: true });
  swimmer.x += 6;
  dropped.update(DT, { swimmer, holding: true, outside: true });
  const interrupted = dropped.phase === 'sealed' && dropped.progress < 1;

  const ok = began && !early && carried && deniedAtSea && delivered && interrupted;
  console.log(`  began in range ${began}  premature pickup ${early}`);
  console.log(`  carried after ${RECORDER.RECOVERY_TIME.toFixed(1)} s ${carried}`);
  console.log(`  delivery denied outside ${deniedAtSea}  accepted aboard ${delivered}`);
  console.log(`  leaving the clamps interrupts recovery ${interrupted}`);
  console.log(`  ${ok ? 'recovery, interruption and return gates hold' : 'RECORDER GATE FAILED'}`);
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
const SUITE = { constants, helm, scrubber, score, tank, descent, telegraph, ballast, silence, instrument, mimic, creature, recorder, stuck };
for (const [name, fn] of Object.entries(SUITE)) {
  if (only && only !== name) continue;
  fn();
}
console.log('');
