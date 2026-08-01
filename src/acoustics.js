/* Underwater acoustics — derived constants, and the state-to-parameter map.
 *
 * The same argument as `jerlov.js`, applied to sound. The palette of this game
 * is not chosen, it is computed; the noise floor should not be chosen either.
 * Every frequency in this file comes from a dimension or a material property
 * that is already in the project, and where a number is a judgement call it is
 * labelled as one. There are three such numbers and they are all in one block
 * at the bottom.
 *
 * ---------------------------------------------------------------------------
 * Why this file has no AudioContext in it, and no `three` either
 *
 * `src/vessel.js` has no renderer dependency because the sandbox runs the page
 * at one or two frames a second with `dt` clamped, so eight seconds of wall
 * clock is under a second of simulated time and no time constant can be
 * measured through the browser. Sound is *nothing but* time constants: an
 * eight-second tank, a two-and-a-half-second spin-up, a creak rate per minute.
 * So the map from game state to synthesiser parameters lives here as pure
 * arithmetic, gets run in node at a fixed 60 Hz by `tools/dyn.mjs`, and the
 * thing that owns the `AudioContext` (`src/audio.js`) only ever plays what it
 * is told.
 *
 * The absence of an `import ... from 'three'` is load-bearing rather than
 * tidy: the bare specifier `'three'` resolves through the import map in
 * `index.html`, which node knows nothing about. A module that avoids it can be
 * imported by a test directly, with no loader, no shim and no build step.
 *
 * ---------------------------------------------------------------------------
 * Sources
 *
 *   Wenz 1962, JASA 34(12):1936          ambient ocean noise spectra
 *   Minnaert 1933, Phil. Mag. 16:235     bubble resonance
 *   Blevins, Formulas for Natural Freq.  plate and ring flexural modes
 *   Thorp 1967, JASA 42:270              absorption of sound in seawater
 *   Hollien & Feinstein 1975             human hearing underwater
 */

import { rng } from './rng.js';
import { pressureAt } from './jerlov.js';
import { HULL_LEN, HULL_R, DECK_Y } from './hull.js';

/* Sound speed. Two media, and the difference is the whole reason the inside of
 * the boat and the water outside it are different acoustic worlds. */
export const C_WATER = 1500;   // m/s, seawater at 4 degrees and 40 atm
export const C_AIR = 343;      // m/s, the breathable atmosphere in the hull

/* Structural steel. The same three numbers the hull was drawn with. */
const E_STEEL = 200e9;         // Pa
const RHO_STEEL = 7850;        // kg/m^3
const NU_STEEL = 0.30;

/**
 * Fundamental-family flexural frequency of a rectangular plate, in Hz.
 *
 * f_mn = (pi/2) * [ (m/a)^2 + (n/b)^2 ] * sqrt(D / (rho*h)),
 *   D = E h^3 / (12 (1 - nu^2))
 *
 * Simply supported on all four edges. Welded plating between frames is nearer
 * to *clamped*, which raises the fundamental by about 1.8, so the honest range
 * for a strake of this boat is the pair of numbers this function brackets —
 * see `HULL_MODES`, which takes the midpoint and says so.
 */
export function plateMode(m, n, a, b, h) {
  const D = (E_STEEL * h * h * h) / (12 * (1 - NU_STEEL * NU_STEEL));
  return (Math.PI / 2) * ((m * m) / (a * a) + (n * n) / (b * b)) * Math.sqrt(D / (RHO_STEEL * h));
}

/**
 * In-plane flexural mode of a circular ring, in Hz. n = 2 is ovalling.
 *
 * f_n = n(n^2-1) / (2 pi sqrt(n^2+1)) * sqrt(E I / (m R^4))
 *
 * Kept because its answer is a finding rather than a frequency — see
 * `OVALLING`. R^4 in the denominator is brutal: at this boat's 2.35 m radius
 * the ovalling mode is infrasonic.
 */
export function ringMode(n, R, width, depth) {
  const I = (width * depth * depth * depth) / 12;
  const massPerLength = RHO_STEEL * width * depth;
  const base = Math.sqrt((E_STEEL * I) / (massPerLength * Math.pow(R, 4)));
  return ((n * (n * n - 1)) / (2 * Math.PI * Math.sqrt(n * n + 1))) * base;
}

/**
 * Ring frequency of a cylindrical shell, in Hz: f = c_L / (2 pi R), where
 * c_L = sqrt(E / (rho (1 - nu^2))) is the plate longitudinal wave speed.
 *
 * The textbook dividing line for shells — bending-dominated below it, membrane
 * above — and for this hull it is the one structural frequency that is both
 * derived and squarely inside hearing. It is the note the boat rings at.
 */
export function shellRing(R) {
  const cL = Math.sqrt(E_STEEL / (RHO_STEEL * (1 - NU_STEEL * NU_STEEL)));
  return cL / (2 * Math.PI * R);
}

/**
 * Minnaert resonance of a gas bubble of radius R at absolute pressure P, in Hz.
 *
 * f0 = 1/(2 pi R) * sqrt(3 gamma P / rho)
 *
 * This is the single most useful equation in the file, because of the sqrt(P):
 * **a ballast blow gets shriller the deeper you are.** A 2 mm bubble sings at
 * 1.6 kHz at the surface and at 10.6 kHz on the canyon floor. Nobody would
 * think to art-direct that, and once it is there the blow tells you your depth
 * without a gauge.
 */
export function minnaert(R, P) {
  const gamma = 1.4;             // diatomic gas
  const rho = 1025;              // seawater
  return (1 / (2 * Math.PI * R)) * Math.sqrt((3 * gamma * P * 101325) / rho);
}

/** Blade-pass frequency of a rotor: blades times revolutions per second. */
export function bladePass(blades, rpm) {
  return (blades * rpm) / 60;
}

/**
 * Thorp absorption in seawater, dB/km, f in kHz.
 *
 * Included so that the temptation to low-pass the water can be refuted with a
 * number rather than resisted on principle. At 1 kHz it is 0.07 dB/km, so over
 * the twenty metres this game can see it is 1.4 thousandths of a decibel.
 * **Water does not muffle anything at this range.** Whatever the outside of
 * the boat sounds like, absorption is not the reason — see `EAR` below.
 */
export function thorp(fkHz) {
  const f2 = fkHz * fkHz;
  return (0.11 * f2) / (1 + f2) + (44 * f2) / (4100 + f2) + 3.0e-4 * f2 + 0.003;
}

/* ------------------------------------------------------------------ the hull
 *
 * The modal set a creak is allowed to use, and the shape of it is a correction.
 *
 * The first draft of this file gave the groan to the ring-stiffener modes, on
 * the assumption that a hull's lowest note is a few tens of Hz — which is what
 * every film soundtrack says. Then the arithmetic ran: at this boat's radius
 * `ringMode(2)` is **11 Hz**, and the second is 32. Inaudible, and it was
 * weighted at 72% of every descending event, so descent would have sounded like
 * nothing at all and the search would have started in the audio graph.
 *
 * The physics is right and the assumption was wrong. R^4 in the denominator
 * means a 2.35 m shell ovals infrasonically; a real submarine needs heavy ring
 * frames precisely because the shell alone is that floppy in bending. What is
 * actually audible from a pressure hull is higher up:
 *
 *   shell    the ring frequency, c_L/(2 pi R) = 358 Hz. Textbook, derived, and
 *            in the middle of hearing. This is the note she rings at.
 *   plate    a 0.6 m strake at 12 mm — the same panel `interior.js` dishes by
 *            1.4 mm for its oil-canning. 216 Hz and up.
 *
 * 0.6 m is not a new number: it is the strake width the interior material's
 * weld lattice is already built on, so the sound and the surface are describing
 * the same plate.
 *
 * The families are named for what they sound like rather than for where they
 * come from, because that is what the mixing decision needs: `groan` on the way
 * down, `snap` on the way up.
 */
const STRAKE = 0.6;            // m, panel side between welds
const PLATE_H = 0.012;         // m, 12 mm plating

/**
 * The n=2 ovalling mode, 11 Hz, recorded because it is the reason this file
 * does not synthesise a low rumble.
 *
 * It is below hearing, so it is felt and not heard, and nothing is gained by
 * spending headroom on it. The low end of a real hull creak is not a resonance
 * at all — it is the onset of the transient, which is broadband by definition.
 * `src/audio.js` therefore gives a creak an impact body rather than a bass mode.
 */
export const OVALLING = ringMode(2, HULL_R, 0.012, 0.10);

export const HULL_MODES = (() => {
  const simple = [
    plateMode(1, 1, STRAKE, STRAKE, PLATE_H),
    plateMode(1, 2, STRAKE, STRAKE, PLATE_H),
    plateMode(2, 2, STRAKE, STRAKE, PLATE_H),
  ];
  /* Midway between simply supported and clamped, in the log domain, because
   * the truth is between them and the geometric mean is the honest midpoint of
   * a ratio. Clamped is 1.82x the simply-supported fundamental. */
  const weld = Math.sqrt(1.82);
  return [
    { f: simple[0] * weld, q: 34, decay: 0.62, family: 'groan' },
    { f: shellRing(HULL_R), q: 28, decay: 0.90, family: 'groan' },
    { f: simple[1] * weld, q: 40, decay: 0.38, family: 'snap' },
    { f: simple[2] * weld, q: 46, decay: 0.24, family: 'snap' },
  ];
})();

/** The shell's ring frequency, exported because the thud borrows it. */
export const SHELL_RING = shellRing(HULL_R);

/* ------------------------------------------------------------------ the cabin
 *
 * Standing-wave modes of the air inside the pressure hull. Air, not water:
 * this is a breathable compartment, so c = 343.
 *
 * The interesting result is negative. The axial mode of an eighteen-metre tube
 * is c/(2L) = 9.5 Hz, which is below hearing — **the length of the boat makes
 * no sound at all.** What you hear is the width and the headroom, both of them
 * in the thirties and forties, and that is why a submarine interior has a low
 * hum that does not change as you walk forward.
 */
export const CABIN_MODES = (() => {
  const width = 2 * HULL_R;                 // 4.70 m beam at the widest
  const head = HULL_R - DECK_Y;             // 3.40 m deck to crown
  const length = 2 * HULL_LEN;              // 18.0 m
  return {
    axial: C_AIR / (2 * length),            // 9.5 Hz — inaudible, and that is the point
    transverse: C_AIR / (2 * width),        // 36.5 Hz
    vertical: C_AIR / (2 * head),           // 50.4 Hz
  };
})();

/* --------------------------------------------------------------- the machine
 *
 * A four-pole induction motor on a 50 Hz supply turns at just under 1500 rpm;
 * 1450 is the usual nameplate figure once slip is counted. Five blades on the
 * impeller puts the blade-pass note at 121 Hz at full revolutions.
 *
 * The mains hum is the detail that makes it read as *electric*. Magnetostriction
 * in the stator iron sings at twice the line frequency — 100 Hz — and it does
 * **not** move with the telegraph. A machine whose every component slides
 * together sounds like a synthesiser; one fixed partial against a sliding set
 * sounds like equipment.
 */
export const MOTOR = {
  rpmIdle: 380,        // life support and the trim pump never stop
  rpmFull: 1450,
  blades: 5,
  hum: 100,            // Hz, 2x line frequency, fixed
  spinUp: 2.6,         // s, first-order lag from telegraph to shaft
};

/* ----------------------------------------------------------------- the ear
 *
 * Why the water sounds the way it does, and it is not absorption.
 *
 * Thorp says the sea is transparent to sound over the distances this game can
 * see. What actually changes when a head leaves the hull is the head:
 *
 *  - The middle ear is an impedance matcher between air and cochlear fluid. In
 *    water it is bypassed and hearing goes over the skull, which costs 30 to
 *    40 dB of sensitivity (Hollien & Feinstein). Everything gets quieter.
 *  - Bone conduction rolls the top off. The world gets darker, not muffled by
 *    the medium.
 *  - Interaural time difference is the head width divided by the sound speed,
 *    and the sound speed is 4.4 times higher, so the cue shrinks by 4.4 and
 *    **localisation fails**. You can hear the boat perfectly and not know
 *    where it is.
 *
 * That last line is the reason to model this at all. "Muffled underwater" is a
 * cliche; "loud, close, and coming from nowhere" is true, and it is worse.
 */
export const EAR = {
  waterLoss: 0.28,     // linear gain out of the hull: about -11 dB of the 30-40
  /* Hz, low-pass corner outside the hull — and this was 1700, which was both
   * wrong and actively harmful.
   *
   * Wrong because the underwater hearing loss is broadband, not a roll-off:
   * divers hear well past 10 kHz, and the 30-40 dB they lose is a sensitivity
   * shift across the band, which `waterLoss` above already models. That argument
   * stands on its own and is the reason for the change.
   *
   * The evidence that prompted it was weaker than it looked, and that is worth
   * recording. The first render of the excursion scene put the 4 and 8 kHz
   * octaves at -49 and -66 dB, which read as "the 3.1 kHz pinger has been
   * filtered out" — but a band average under-reads a transient by its duty cycle,
   * and a 0.13 s ping every two seconds is six per cent, or -12 dB before
   * anything else. Isolating the pinger in its own scene showed it present and
   * healthy. **The measurement was right and the reading of it was wrong**; the
   * physics is why this number moved, not the graph.
   *
   * Raised to 4500 so the beacon is comfortable; the cabin is still brighter at
   * 8000, so crossing the hatch still changes the world. */
  waterTilt: 4500,
  waterSpread: 0.85,   // 0 = pinpoint, 1 = fully diffuse. Localisation is gone.
  cabinTilt: 8000,     // Hz, air path, essentially open
  cabinRT: 0.35,       // s, RT60 of a steel tube with soft goods in it
  waterRT: 2.4,        // s, the canyon
  crossFade: 0.25,     // s through the hatch. Snapping this clicks.
};

/* ------------------------------------------------------------- the way home
 *
 * A player got lost the moment they left the hull, and the fix is split across
 * two senses on purpose, because the acoustics already decided how:
 * **outside the hull localisation is gone** — interaural time difference shrinks
 * by the 4.4x sound-speed ratio — so a sound out here can honestly tell you *how
 * far* and cannot honestly tell you *which way*.
 *
 * So the strobe on the trunk carries the direction, and this carries the range,
 * by repetition rate alone. A Geiger counter, which is the most legible
 * distance-to-thing signal ever built and needs no interface at all.
 *
 * 3.1 kHz because a diver recall beacon is audible by design — the 37.5 kHz of an
 * aircraft locator pinger is ultrasonic and would be silence.
 */
export const PINGER = {
  f: 3100,             // Hz
  near: 0.26,          // s between pings, alongside
  far: 3.1,            // s between pings, at the limit
  range: 130,          // m at which the interval saturates
  level: 0.075,
};

/* Something in the canyon learns the pinger. It is deliberately close enough
 * to be mistaken for the trunk and deliberately wrong enough that an attentive
 * player can reject it: 37 Hz of detuning produces a slow beat against the real
 * beacon, while its interval copies the last real interval imperfectly. The
 * voice only wakes well outside the hull and after a quiet observation period,
 * so the first excursion teaches the true signal before the game lies with it. */
export const MIMIC = {
  f: PINGER.f - 37,
  wakeRange: 38,       // m from the trunk before it can answer
  learnTime: 24,       // s outside before the first answer
  level: 0.046,
  intervalError: 0.17, // its copied cadence is always slightly too slow
};

/* Breathing on a closed loop. Two events per cycle, because the counterlung
 * makes inhalation and exhalation different sounds, and the asymmetry is most of
 * what makes it read as a person rather than as a bellows. */
export const BREATH = { level: 0.115, inhale: 620, exhale: 320 };

/** The scrubber alarm. Not loud — it has to be heard *under* the breathing. */
export const ALARM = { f: 2050, level: 0.085 };

/* ---------------------------------------------------------------- the score
 *
 * Asked for as "tense music in the background, tastefully", and the operative
 * word is the last one. This project has just finished establishing that
 * **silence is the art direction**, with a measured budget in which the canyon
 * floor at rest sits at 0.040 against 0.55 for a grounding. Anything laid on top
 * of that damages the exact thing that makes a creak frightening.
 *
 * Three rules keep it honest, and they are the same rules as the rest of the
 * file rather than mixing advice:
 *
 *  1. **It is tuned to the boat.** The root is the cabin's transverse air mode,
 *     36.5 Hz, and the upper partial is the shell's ring frequency, 358.4 Hz.
 *     Their ratio is 9.82, which is nearly but not quite three octaves and a
 *     major third — so the drone is slightly inharmonic, because the hull is.
 *     The score and the boat are in the same key instead of merely adjacent.
 *  2. **It is driven by state, not by a timeline.** Depth, loading rate, scrubber
 *     remaining, distance from home. It is dramaturgy, computed the way the
 *     palette and the noise floor are computed.
 *  3. **It gets out of the way of every instrument**, by two separate mechanisms
 *     that were one in the first draft and should never have been. A busy hull
 *     *crowds* it down smoothly, because a creak three times a second is already
 *     doing the work; a genuinely large transient — a grounding, the alarm —
 *     ducks it sharply, because those are information. An ordinary creak does
 *     neither: it is ambience, not an announcement.
 *
 * `tools/dyn.mjs` asserts that the quietest creak still stands 6 dB clear of
 * everything continuous. Six rather than ten because an onset transient against a
 * steady drone is detectable far below equal-level masking — and because the
 * ambient bed alone already leaves only eight. If that check fails the answer is
 * to lower this ceiling, not to raise the creak.
 */
export const SCORE = {
  /* Taken from the two owners rather than typed in. If the beam of the boat ever
   * changes, the score retunes with it — which is the entire claim being made. */
  root: CABIN_MODES.transverse,
  ring: SHELL_RING,
  floor: 0.010,        // at rest, in the shallows, nothing wrong
  ceiling: 0.028,      // descending, low on scrubber, far from home
  rise: 14.0,          // s. Tension arrives slowly or it is a jump scare
  fall: 22.0,          // s. And leaves more slowly still
  duckTo: 0.26,        // multiplier under a big transient
  duckHold: 0.9,       // s to recover
  duckAbove: 0.30,     // event level that counts as a big transient
  /* How far a talking hull pushes the score down, and it is set by measurement.
   *
   * Raising this from 0.55 fixed the descent, where the hull creaks three times a
   * second — but the margin did not move, because the worst case is not the noisy
   * moment. It is the quiet one *just after*: the boat touches down, the loading
   * rate collapses, the hull stops talking and the crowd term opens back up — and
   * the drone is still near the top of its range because it falls with a 22 s
   * constant. Twenty seconds of the score at full level over a silent hull, which
   * is exactly when a creak has to be heard.
   *
   * **The worst masking is not under the loudest sound, it is in the gap after
   * it,** because the two have different time constants. That is what the ceiling
   * below had to pay for; this term still earns its keep during the descent. */
  crowd: 0.72,
};

/* ------------------------------------------------------- the judgement calls
 *
 * Three numbers in this file are not derived from anything. They are here,
 * together, labelled, in the same spirit as `Env.scatterGain`.
 */
const ART = {
  /* Depth at which surface hiss has fallen by 1/e. Wenz gives spectra at a
   * depth, not a depth law, and a canyon shadows its own floor in ways no
   * closed form covers. 120 m puts the hiss at three per cent on the bottom,
   * which is the intent: the shelf sounds like weather, the floor does not. */
  hissScale: 120,
  /* Creaks per second with the boat sitting still at depth. One per twenty-five
   * seconds. Low enough that each one is an event rather than a texture. */
  creakIdle: 1 / 25,
  /* Creaks per second per atmosphere-per-second of loading. At a hard blow
   * (1.8 m/s, 0.18 atm/s) this gives about three a second, which is a hull in
   * trouble; at a gentle 0.3 m/s it is one every three seconds. */
  creakPerLoad: 17,
};

/* -------------------------------------------------------- the loudness budget
 *
 * Written down because "The Deep Silence" is a promise and it is easy to break
 * by accident. Linear gain at the master input, and these are measured by
 * `tools/dyn.mjs` rather than intended — the first draft of this table was
 * aspiration, and the measurement came back at 0.052 on the canyon floor
 * against a claim of 0.018, because `bedLow` does not fade with depth and had
 * been set almost twice as loud as the thing it was supposed to sit under.
 *
 *   bed + machinery, on the shelf       0.081
 *   bed + machinery, on the floor       0.040   <- the title
 *   of which the ambient bed alone      0.020
 *   machinery idling, at the helm       0.020
 *   machinery idling, in the plant      0.075
 *   machinery full ahead, in the plant  0.28
 *   the score, at rest on the floor     0.014
 *   the score, at its worst             0.025
 *   one groan at 400 m                  0.14 to 0.22 peak
 *   the pinger, alongside               0.075 peak
 *   breathing, panting                  0.05 to 0.115 peak
 *   ballast blow, mid-transfer          0.34 peak
 *   grounding                           0.55 peak
 *
 * The order matters more than the values: a grounding is the loudest thing in
 * the game, a blow is next, and the floor at rest is fifteen times quieter than
 * either. A sound is only frightening against silence, so this table is a gate,
 * not a note — and the gate is enforced. `tools/dyn.mjs --only score` measures
 * the quietest creak against everything continuous at depth and fails below 6 dB;
 * it currently reads 6.5.
 */
export const BUDGET = {
  bedLow: 0.018, bedHiss: 0.055,
  machIdle: 0.075, machFull: 0.28,
  creak: 0.22, ballast: 0.34, contact: 0.55,
  master: 0.72,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** First-order lag toward a target. Frame-rate independent, unlike v += (t-v)*k. */
const approach = (v, target, tau, dt) => v + (target - v) * (1 - Math.exp(-dt / Math.max(1e-6, tau)));

/* Where the noisy machinery actually is, in hull coordinates. The pump skid's
 * motor axis is at z = -3.95 in `main.js`'s station table, so that is where the
 * sound comes from — not from the middle of the boat. */
const PLANT_Z = -3.95;

/* Breakaway velocity for the bottom scrape, m/s. Below eight centimetres a
 * second there is no sliding contact noise, only two surfaces resting on each
 * other — and, just as usefully, no voice left running. */
const SCRAPE_GATE = 0.08;

/**
 * The map from game state to synthesiser parameters.
 *
 * Everything in `update` is arithmetic on numbers the game already publishes.
 * Nothing here knows what a filter is. `src/audio.js` reads `this.v` every
 * frame and pushes it at the graph; `tools/dyn.mjs` reads the same fields and
 * prints them.
 */
export class Acoustics {
  constructor(seed = 0x5eed000a) {
    this.rand = rng(seed);

    // --- integrator state, all of it with a time constant
    this.rpm = MOTOR.rpmIdle;
    this.dPdt = 0;             // atm/s, smoothed
    this.inside = 1;           // 0..1 crossfade, hull vs water
    this.lastDepth = null;
    this.creakClock = 0;       // seconds until the next event
    this.thudArmed = 0;        // last contact value, for edge detection
    this.t = 0;
    this.pingClock = 0;        // s until the next ping from the trunk
    this.mimicClock = 0;       // s until the next false reply
    this.mimicLearn = 0;       // s spent outside, hearing the real pinger
    this.mimicInterval = PINGER.far;
    this.breathClock = 0;      // s until the next half-cycle
    this.breathIn = true;
    this.tension = 0;          // 0..1, smoothed. What the score is about
    this.duck = 1;             // 1 open, SCORE.duckTo while an instrument speaks

    /** Impulses to fire this tick. Consumed and cleared by the engine. */
    this.events = [];

    /** Continuous voice parameters. The engine reads this and nothing else. */
    this.v = {
      bedLow: 0, bedHiss: 0, bedTilt: EAR.cabinTilt,
      machGain: 0, machBlade: 0, machHum: MOTOR.hum, machRough: 0, rpm: 0,
      balGain: 0, balBubble: 0, balBlow: 0,
      scrape: 0,
      alarmGain: 0, scoreGain: 0, scoreRoot: SCORE.root, tension: 0,
      inside: 1, tilt: EAR.cabinTilt, spread: 0, rt: EAR.cabinRT,
      master: BUDGET.master,
    };
  }

  /**
   * @param dt seconds
   * @param s  { depth, aboard, earZ, throttle, ballast, ballastCmd,
   *             way, grounded, contact, muted }
   */
  update(dt, s) {
    this.t += dt;
    this.events.length = 0;
    const P = pressureAt(s.depth);

    /* --- loading rate, differentiated here rather than taken from the vessel.
     *
     * The hull answers to the load it is actually under, which is the
     * derivative of its own depth. Taking `vessel.vel.y` instead would be
     * wrong twice: it is zero while a swimmer descends, and it ignores every
     * other way depth can change. Smoothed at 0.4 s because a differentiated
     * signal with a clamped `dt` in it is otherwise all spikes. */
    if (this.lastDepth === null) this.lastDepth = s.depth;
    const raw = (s.depth - this.lastDepth) / Math.max(1e-4, dt) / 10.06;
    this.lastDepth = s.depth;
    this.dPdt = approach(this.dPdt, raw, 0.4, dt);
    const descending = this.dPdt > 0;

    /* --- where the ear is.
     *
     * Gated on the geometry, never on `game.mode`. The review cameras stand
     * outside the boat without being in swim mode, and the same mistake in the
     * renderer is what put glowing plates on the outside of the hull. */
    this.inside = approach(this.inside, s.aboard ? 1 : 0, EAR.crossFade, dt);
    const ins = this.inside;

    // --- the bed. Low rumble is depth-blind; surface hiss is not.
    const hiss = Math.exp(-Math.max(0, s.depth) / ART.hissScale);
    this.v.bedLow = BUDGET.bedLow * (0.55 + 0.45 * ins);
    this.v.bedHiss = BUDGET.bedHiss * hiss * (0.35 + 0.65 * ins);

    /* --- the machine.
     *
     * Revolutions follow the telegraph through a lag, so the note slides for
     * two and a half seconds after the handle stops moving. That is the
     * telegraph being a *setting* made audible: you hear the machine answer,
     * and you hear it still answering after you have let go of the key. */
    const demand = MOTOR.rpmIdle + (MOTOR.rpmFull - MOTOR.rpmIdle) * Math.abs(s.throttle);
    this.rpm = approach(this.rpm, demand, MOTOR.spinUp, dt);
    this.v.rpm = this.rpm;
    this.v.machBlade = bladePass(MOTOR.blades, this.rpm);
    this.v.machHum = MOTOR.hum;

    /* Cavitation. A screw ordered hard over against a hull that is not yet
     * moving is pushing water it cannot get out of the way, and it is rough and
     * loud until she gathers way. Both terms are already published, so this
     * costs one line and it is the difference between a motor and a propeller. */
    const slip = clamp(Math.abs(s.throttle) - Math.abs(s.way) / 4.5, 0, 1);
    this.v.machRough = slip * slip;

    /* Heard through a duct, not across a room. An 18 m tube guides sound: the
     * fall-off along it is far gentler than 1/r^2, so the pump is never
     * inaudible at the helm, only distant. Outside the hull it is the radiated
     * field, quiet but unlocalised. */
    const along = Math.abs((s.earZ ?? 0) - PLANT_Z);
    const duct = 1 / (1 + along / 4.0);
    const load = (this.rpm - MOTOR.rpmIdle) / (MOTOR.rpmFull - MOTOR.rpmIdle);
    const machLevel = BUDGET.machIdle + (BUDGET.machFull - BUDGET.machIdle) * load;
    this.v.machGain = machLevel * (ins * duct + (1 - ins) * 0.30);

    /* --- ballast, and this is the tank lag made audible.
     *
     * `ballastCmd - ballast` is nonzero for about eight seconds after a command
     * and decays exponentially. Using it as the gain means the hiss *is* the
     * instrument: it starts when you press the key, it keeps going long after
     * you let go, and it stops when the tank has finished — which is the one
     * piece of information the pilot most needs and cannot see. */
    const flow = s.ballastCmd - s.ballast;
    const blowing = flow < 0;
    this.v.balGain = BUDGET.ballast * clamp(Math.abs(flow) * 3.4, 0, 1)
      * (ins * 0.85 + (1 - ins) * 1.0);
    this.v.balBubble = minnaert(0.002, P);
    this.v.balBlow = blowing ? 1 : 0;

    /* --- the bottom. `vessel.contact` already carries impact strength and
     * decays on its own, so a rising edge is a strike and the standing value is
     * a scrape. */
    if (s.contact > this.thudArmed + 0.12) {
      this.events.push({
        kind: 'thud',
        level: clamp(s.contact / 2.2, 0.1, 1) * BUDGET.contact,
        f: SHELL_RING,
      });
    }
    this.thudArmed = s.contact;
    /* Gated, and the gate is not a convenience.
     *
     * A scrape proportional to `|way|` never switches off, because a hull
     * aground on a slope never quite stops: she settles at seventeen millimetres
     * a second and stays there, so the voice sat at 0.0017 for ever. Inaudible,
     * unfindable, and exactly how a synthesiser acquires a permanent whisper
     * nobody can trace. Caught by the released-voices check in `tools/dyn.mjs`,
     * which is the only reason it was ever going to be caught.
     *
     * The physical answer is also the right one: sliding friction has a
     * breakaway threshold. Steel resting on silt makes no sound at all, so
     * below the gate the correct level is exactly zero rather than nearly zero.
     *
     * **Any continuous voice keyed to a quantity that only asymptotes to zero
     * needs a gate at the threshold of audibility.** */
    const slide = Math.abs(s.way);
    this.v.scrape = s.grounded && slide > SCRAPE_GATE
      ? clamp((slide - SCRAPE_GATE) / 3.0, 0, 1) * 0.30 : 0;

    // --- creak. The one voice that is a point process rather than a level.
    this._creak(dt, P, descending);

    // --- the excursion: the way home, the lungs, and the warning.
    this._excursion(dt, s);

    /* --- the score, last, because it has to know what everything else did.
     *
     * `duck` is pulled down by any event fired this tick and by the alarm. It is
     * checked after `_creak` and `_excursion` for that reason: a score that ducks
     * one frame late is a score that steps on the front of a creak, which is the
     * only part of a creak that carries. */
    this._score(dt, s);

    // --- the ear itself
    this.v.inside = ins;
    this.v.tilt = EAR.waterTilt + (EAR.cabinTilt - EAR.waterTilt) * ins;
    this.v.spread = EAR.waterSpread * (1 - ins);
    this.v.rt = EAR.waterRT + (EAR.cabinRT - EAR.waterRT) * ins;
    this.v.master = s.muted ? 0 : BUDGET.master * (EAR.waterLoss + (1 - EAR.waterLoss) * ins);
  }

  /**
   * Poisson process on the hull.
   *
   * Rate comes from the *loading rate*, not from the pressure. A hull at rest
   * at 400 m is a hull in equilibrium and it is quiet; the same hull descending
   * at 1.8 m/s is redistributing stress through every weld it has. This is why
   * holding depth is calm and why committing to the bottom is not, and it costs
   * one term.
   *
   * Descent and ascent do not sound alike, and that difference is free
   * instrumentation. Increasing compression loads the whole shell, so it
   * answers low and rings on; relaxing lets individual panels let go, which is
   * short and high. With your eyes shut you can hear which way you are going.
   */
  _creak(dt, P, descending) {
    const rate = ART.creakIdle + ART.creakPerLoad * Math.abs(this.dPdt);
    this.creakClock -= dt * rate;
    if (this.creakClock > 0) return;
    // Exponential intervals. Re-armed rather than reset so a high rate can fire
    // more than once in a long frame without the queue drifting.
    this.creakClock += -Math.log(Math.max(1e-9, this.rand()));

    /* Amplitude from absolute pressure, but weakly. A stick-slip event's size
     * is set by the asperity that lets go, not by the total load, so scaling
     * linearly with pressure over-reads badly: the hull is rated to 6000 m and
     * the canyon is 425, so a linear law would make the whole game inaudible
     * to make one unreachable depth loud. Normalised at 400 m. */
    const strain = Math.pow(P / pressureAt(400), 0.35);
    /* The random spread used to reach down to 0.45, which put the quietest
     * creak at 0.099 — only 8 dB over an ambient bed of 0.040, before a score
     * existed to eat into that. Narrowed, because a creak that has to be
     * strained for is not doing its job. */
    const level = clamp(strain, 0.12, 1.6) * BUDGET.creak * (0.62 + 0.38 * this.rand());

    /* Which family gets the energy. Groans on the way down, snaps on the way
     * up, with enough overlap that it is a tendency rather than a tell. */
    const wantGroan = descending ? 0.72 : 0.22;
    const groan = this.rand() < wantGroan;
    const pool = HULL_MODES.filter((m) => (groan ? m.family === 'groan' : m.family === 'snap'));
    const mode = pool[Math.floor(this.rand() * pool.length)];

    this.events.push({
      kind: 'creak',
      level,
      f: mode.f,
      q: mode.q,
      decay: mode.decay * (0.7 + 0.6 * this.rand()),
      family: mode.family,
    });
  }

  /**
   * Outside the hull: the pinger, the breathing and the scrubber alarm.
   *
   * All three are gated on being outside rather than on a mode, and all three go
   * quiet aboard — the pinger because you have arrived, the breathing because you
   * are off the loop and on cabin air, the alarm because the canister is being
   * swapped.
   */
  _excursion(dt, s) {
    const out = 1 - this.inside;
    if (out < 0.02) {
      this.v.alarmGain += (0 - this.v.alarmGain) * Math.min(1, dt * 3);
      this.pingClock = 0;
      this.mimicClock = 0;
      /* Time aboard does not erase what it learned. Once the player has taught
       * the canyon the signal, later excursions inherit that consequence. */
      return;
    }

    /* The pinger. Interval falls linearly with range and saturates, so the rate
     * is the reading: three seconds apart means you are a long way out, four a
     * second means you are at the hatch. */
    const range = Math.max(0, s.boatRange ?? 0);
    const k = clamp(range / PINGER.range, 0, 1);
    const interval = PINGER.near + (PINGER.far - PINGER.near) * k;
    this.pingClock -= dt;
    if (this.pingClock <= 0) {
      this.pingClock += interval;
      this.events.push({
        kind: 'ping', f: PINGER.f,
        // Attenuated with range, but never to nothing: it is a beacon, and a
        // beacon you cannot hear at the edge of its useful range is furniture.
        level: PINGER.level * out * (0.35 + 0.65 * (1 - k)),
      });
    }

    /* The false answer. It learns continuously but only speaks beyond the range
     * at which the trunk should already sound reassuringly fast. This keeps the
     * near-hatch cue trustworthy and makes uncertainty belong to the open water.
     * The copied cadence converges slowly, so the mimic becomes more convincing
     * across a long excursion without ever becoming mathematically identical. */
    if (range >= MIMIC.wakeRange) {
      this.mimicLearn += dt;
      const learned = clamp((this.mimicLearn - MIMIC.learnTime) / 70, 0, 1);
      this.mimicInterval += (interval - this.mimicInterval)
        * Math.min(1, dt * (0.025 + learned * 0.055));
      if (this.mimicLearn >= MIMIC.learnTime) {
        this.mimicClock -= dt;
        if (this.mimicClock <= 0) {
          const wrong = this.mimicInterval * (1 + MIMIC.intervalError * (1 - 0.55 * learned));
          this.mimicClock += Math.max(PINGER.near * 1.4, wrong);
          this.events.push({
            kind: 'ping', f: MIMIC.f,
            mimic: true,
            level: MIMIC.level * out * (0.72 + 0.28 * learned),
          });
        }
      }
    } else {
      this.mimicClock = 0;
    }

    /* Breathing, at whatever rate the body has settled on. `life.js` owns that
     * number: it rises with exertion and rises again with retained CO2, which is
     * why the first sign of a spent canister is that you cannot stop panting. */
    const bpm = Math.max(4, s.breath ?? 12);
    this.breathClock -= dt;
    if (this.breathClock <= 0) {
      // Two halves per breath, and exhalation is the longer one.
      const cycle = 60 / bpm;
      this.breathClock += this.breathIn ? cycle * 0.42 : cycle * 0.58;
      this.events.push({
        kind: 'breath',
        inhale: this.breathIn,
        f: this.breathIn ? BREATH.inhale : BREATH.exhale,
        // Panting is shallower as well as faster, so it does not just get louder.
        level: BREATH.level * out * clamp(1.25 - bpm / 60, 0.45, 1.0),
      });
      this.breathIn = !this.breathIn;
    }

    /* The scrubber alarm, as beeps rather than as a level.
     *
     * A tone held open by a continuous gain needs an LFO in the graph to become a
     * beep, and a beep is what a warning is. Emitting events instead keeps it the
     * same shape as the creak and the ping — which means `tools/dyn.mjs` counts
     * them, and the score's duck sees them without a special case. Rate carries
     * the urgency: one a second while there is time, two and a half when there is
     * not, which is the same trick the pinger uses on distance. */
    const al = clamp(s.alarm ?? 0, 0, 1);
    this.v.alarmGain = ALARM.level * al * out;
    if (al > 0.02) {
      const rate = s.phase === 'critical' || s.phase === 'blackout' ? 2.5 : 1.0;
      this.beepClock = (this.beepClock ?? 0) - dt * rate;
      if (this.beepClock <= 0) {
        this.beepClock += 1;
        this.events.push({ kind: 'beep', f: ALARM.f, level: ALARM.level * al * out });
      }
    } else {
      this.beepClock = 0;
    }
  }

  /**
   * The score. A level and a root, and nothing else — `audio.js` owns the timbre.
   *
   * Tension is the maximum of four independent pressures rather than their sum,
   * because they are alternatives rather than accumulations: being deep is
   * frightening, and so is being low on scrubber, and a player who is both should
   * not get a score twice as loud as either.
   */
  _score(dt, s) {
    const depth = Math.max(0, s.depth ?? 0);
    /* Depth is weighted low on purpose. Being deep is a *constant*, and a
     * constant is not tension — driven off altitude alone the score would sit at
     * three quarters of its ceiling for as long as the player stayed on the
     * bottom, which is the definition of wallpaper. The three terms that can
     * actually change are the ones allowed to reach the top: going down right
     * now, running out of sorbent, and being a long way from the way in. */
    const want = Math.max(
      clamp(depth / 420, 0, 1) * 0.35,            // simply being down here
      clamp(Math.abs(this.dPdt) / 0.18, 0, 1),    // going further, actively
      clamp(1 - (s.scrubber ?? 1), 0, 1),         // running out
      clamp(((s.boatRange ?? 0) - 25) / 90, 0, 1) * (1 - this.inside),  // lost
    );
    // Asymmetric, like the eye's adaptation and for the same reason: dread should
    // arrive slowly and leave more slowly than it arrived.
    this.tension = approach(this.tension, want, want > this.tension ? SCORE.rise : SCORE.fall, dt);

    /* Two different mechanisms, and the first draft had only the second.
     *
     * Ducking on *every* event was perverse: during a descent the hull creaks
     * three times a second, so the score sat permanently at a quarter of its
     * level — it vanished exactly when the game got frightening, which is the
     * opposite of what a score is for. Measured 0.007 against a ceiling of 0.052.
     *
     * So the two jobs are separated. A hull that is talking *crowds* the score out
     * smoothly, because the creak is already doing the work and the drone is only
     * there to fill silence. And a genuinely big transient — a grounding, a large
     * creak, the scrubber alarm — ducks it sharply, because those are information
     * and the score is not. A small creak now does nothing at all, which is
     * correct: it is ambience, not an announcement. */
    const busy = clamp(this.creakRate / 2.0, 0, 1);
    const crowded = 1 - SCORE.crowd * busy;

    const loudest = this.events.reduce((m, e) => Math.max(m, e.level || 0), 0);
    const big = loudest >= SCORE.duckAbove || this.events.some((e) => e.kind === 'beep');
    const target = big ? SCORE.duckTo : 1;
    this.duck = target < this.duck
      ? target                                       // duck instantly
      : approach(this.duck, 1, SCORE.duckHold, dt);  // recover over most of a second

    this.v.tension = this.tension;
    this.v.scoreRoot = SCORE.root;
    this.v.scoreGain = (SCORE.floor + (SCORE.ceiling - SCORE.floor) * this.tension)
      * this.duck * crowded * (s.music === false ? 0 : 1);
  }

  /** Creaks per second at the current loading rate. For the F3 panel. */
  get creakRate() { return ART.creakIdle + ART.creakPerLoad * Math.abs(this.dPdt); }
}

export { ART };
