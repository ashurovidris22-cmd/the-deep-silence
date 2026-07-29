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
  waterTilt: 1700,     // Hz, low-pass corner for bone conduction
  waterSpread: 0.85,   // 0 = pinpoint, 1 = fully diffuse. Localisation is gone.
  cabinTilt: 8000,     // Hz, air path, essentially open
  cabinRT: 0.35,       // s, RT60 of a steel tube with soft goods in it
  waterRT: 2.4,        // s, the canyon
  crossFade: 0.25,     // s through the hatch. Snapping this clicks.
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
 *   one groan at 400 m                  0.10 to 0.22 peak
 *   ballast blow, mid-transfer          0.34 peak
 *   grounding                           0.55 peak
 *
 * The order matters more than the values: a grounding is the loudest thing in
 * the game, a blow is next, and the floor at rest is fifteen times quieter than
 * either — fifteen decibels under the quietest creak. A sound is only
 * frightening against silence, so this table is a gate, not a note.
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

    /** Impulses to fire this tick. Consumed and cleared by the engine. */
    this.events = [];

    /** Continuous voice parameters. The engine reads this and nothing else. */
    this.v = {
      bedLow: 0, bedHiss: 0, bedTilt: EAR.cabinTilt,
      machGain: 0, machBlade: 0, machHum: MOTOR.hum, machRough: 0, rpm: 0,
      balGain: 0, balBubble: 0, balBlow: 0,
      scrape: 0,
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
    const level = clamp(strain, 0.12, 1.6) * BUDGET.creak * (0.45 + 0.55 * this.rand());

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

  /** Creaks per second at the current loading rate. For the F3 panel. */
  get creakRate() { return ART.creakIdle + ART.creakPerLoad * Math.abs(this.dPdt); }
}

export { ART };
