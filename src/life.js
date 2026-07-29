/* Life support, and why the limit is the scrubber rather than the gas.
 *
 * The brief was "add oxygen so there is a reason to come back". Oxygen is the
 * wrong quantity, and the right one is already sitting in the machinery space.
 *
 * ---------------------------------------------------------------------------
 * Open circuit cannot work at this depth, and that is the interesting part
 *
 * A demand regulator delivers gas at ambient pressure, so consumption by *mass*
 * scales with the absolute pressure. On the floor of this canyon that is
 * 1 + 426/10.06 = 43.3 atmospheres: a diver who gets an hour from a cylinder at
 * the surface gets eighty-three seconds. Deep work is closed-circuit for exactly
 * this reason, and it is not a detail — it is why the boat has a CO2 scrubber and
 * a bank of HP air rather than a rack of scuba tanks.
 *
 * In a rebreather the loop is recycled, so oxygen is consumed *metabolically* and
 * is very nearly independent of depth. What runs out is the sorbent that takes
 * the carbon dioxide back out. So the number on the readout is scrubber life, the
 * failure mode is hypercapnia rather than suffocation, and the reason to come
 * back is that the canister in the suit is an emergency one.
 *
 * ---------------------------------------------------------------------------
 * Where the duration comes from
 *
 *   metabolic O2 at rest        0.30 l/min      standard physiological figure
 *   working hard                1.9  l/min      a diver swimming against drag
 *   respiratory quotient        0.85            CO2 produced per O2 consumed
 *   Sofnolime practical uptake  120 l CO2 / kg  well under the stoichiometric
 *                                               limit, because channelling and
 *                                               breakthrough end a canister long
 *                                               before the chemistry does
 *   cold de-rating at 4 C       x 0.5           sorbent kinetics fall off badly
 *                                               in cold water, and the bottom of
 *                                               this canyon is about four degrees
 *
 * A 0.25 kg emergency canister is therefore 30 litres of nominal capacity and
 * about 15 usable. At a swimming rate that is a quarter of an hour, at a sprint
 * about eight minutes, and floating still nearly an hour. **Moving carefully is
 * worth more than any other decision the player can make out there**, which is
 * the correct pressure for this game and it falls out of the physiology rather
 * than being balanced in.
 *
 * It is an emergency canister rather than a working rig on purpose. This is a
 * descent vehicle; being outside the hull at 426 m is not the plan.
 *
 * ---------------------------------------------------------------------------
 * No imports, for the usual reason
 *
 * Everything here is a time constant, and the sandbox cannot measure one through
 * a browser. `tools/dyn.mjs` imports this directly and runs it at a fixed 60 Hz.
 */

/** Practical CO2 uptake of soda lime, litres per kg, before breakthrough. */
const UPTAKE = 120;
/** Sorbent in the suit's emergency canister, kg. */
const CANISTER = 0.25;
/** Cold water de-rating. The canyon floor is about 4 degrees. */
const COLD = 0.5;

export const CAPACITY = CANISTER * UPTAKE * COLD;      // litres of CO2, ~15

const RQ = 0.85;
const O2_REST = 0.30;      // l/min
const O2_SWIM = 1.05;      // l/min at an unboosted cruise
const O2_HARD = 1.90;      // l/min at a boosted cruise

/* The speeds those rates are anchored to, from `Pilot`: accel/drag = 7.0/1.6 is
 * 4.4 m/s unboosted, and the boost multiplies the acceleration, so 11.4 m/s. */
const V_SWIM = 4.4;
const V_HARD = 11.4;

/** Phase thresholds, as a fraction of capacity remaining. */
const WARN = 0.25;
const CRITICAL = 0.08;

/* How long the suit's canister takes to swap for a fresh one, in seconds.
 * The boat carries spare sorbent — this is a person changing a canister, not
 * chemistry running backwards, so it is quick and it is not instant. */
const SWAP = 22;

const BLACKOUT_FADE = 4.0;   // s, hypercapnia closing in
const WAKE_FADE = 3.0;       // s, coming round in the mess

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Life {
  constructor() {
    this.co2 = 0;             // litres absorbed by the canister
    this.phase = 'ok';        // ok | warn | critical | blackout | waking
    this.t = 0;
    this.fade = 0;            // 0 clear, 1 black
    this.veil = 0;            // 0..1 vignette from hypercapnia
    this.breath = 12;         // breaths per minute
    this.alarm = 0;           // 0..1
    this.rate = O2_REST * RQ; // l/min of CO2 right now
    this._phaseT = 0;
    /** Consumed by main.js and by the sound layer, then cleared. */
    this.events = [];
  }

  /** Fraction of the canister left, 1 fresh, 0 spent. */
  get remaining() { return clamp(1 - this.co2 / CAPACITY, 0, 1); }

  /**
   * Minutes left at the current rate.
   *
   * A projection rather than a countdown, which is what a real rebreather
   * computer shows and is honest about: swim harder and the number drops faster
   * than one minute per minute.
   */
  get minutesLeft() {
    /* Clamped, because a frame caught it reading "0% - 2.4 MIN". `co2` can
     * overshoot capacity inside the tick that spends the last of it, and a
     * readout that goes negative tells the player the instrument is broken at
     * the exact moment they most need to believe it. */
    return Math.max(0, (CAPACITY - this.co2) / Math.max(1e-4, this.rate));
  }

  /**
   * @param dt seconds
   * @param s  { aboard, speed, boost }
   *
   * `aboard` is the geometric hull test, not `game.mode` — same gate the cabin's
   * visibility and the sound layer use, because the review cameras sit outside
   * the boat without being in swim mode.
   */
  update(dt, s) {
    this.t += dt;
    this._phaseT += dt;
    this.events.length = 0;

    // --- how hard the body is working. Two linear segments through three
    // measured rates, which is all the resolution this deserves.
    const v = Math.max(0, s.speed || 0);
    const o2 = v <= V_SWIM
      ? O2_REST + (O2_SWIM - O2_REST) * (v / V_SWIM)
      : O2_SWIM + (O2_HARD - O2_SWIM) * clamp((v - V_SWIM) / (V_HARD - V_SWIM), 0, 1);
    this.rate = o2 * RQ;

    if (this.phase === 'blackout') return this._blackout(dt);
    if (this.phase === 'waking') return this._waking(dt);

    if (s.aboard) {
      /* Aboard, the canister gets swapped. Not instant, because a readout that
       * snaps back to full the moment you cross the hatch tells the player the
       * resource was never real. */
      this.co2 = Math.max(0, this.co2 - (CAPACITY / SWAP) * dt);
      this.veil += (0 - this.veil) * Math.min(1, dt * 1.6);
      this.alarm += (0 - this.alarm) * Math.min(1, dt * 2.5);
      this.breath += (12 - this.breath) * Math.min(1, dt * 0.5);
      this._setPhase(this.remaining > WARN ? 'ok' : 'warn');
      return;
    }

    this.co2 += (this.rate / 60) * dt;

    const left = this.remaining;
    /* Breathing rate. Rises with work, and rises again with retained CO2 —
     * hypercapnia drives ventilation hard, which is why the first sign of a
     * spent canister is that you cannot stop panting. */
    const want = 11 + 15 * (this.rate - O2_REST * RQ) / (O2_HARD * RQ) + 26 * Math.pow(1 - left, 3);
    this.breath += (want - this.breath) * Math.min(1, dt * 0.7);

    if (left <= 0) {
      this._setPhase('blackout');
      this.events.push({ kind: 'blackout' });
      return;
    }
    if (left <= CRITICAL) {
      this._setPhase('critical');
      this.alarm = 1;
      // The vignette closes in over the last of the canister, not on a timer.
      this.veil = clamp((CRITICAL - left) / CRITICAL, 0, 1) * 0.85;
    } else if (left <= WARN) {
      this._setPhase('warn');
      // A slow pulse, so it reads as a warning rather than as an emergency.
      this.alarm = 0.45 + 0.35 * Math.sin(this.t * 2.2);
      this.veil += (0 - this.veil) * Math.min(1, dt * 1.5);
    } else {
      this._setPhase('ok');
      this.alarm += (0 - this.alarm) * Math.min(1, dt * 2.5);
      this.veil += (0 - this.veil) * Math.min(1, dt * 1.5);
    }
  }

  _setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    this._phaseT = 0;
    this.events.push({ kind: 'phase', phase: p });
  }

  /* Blacking out. Four seconds of the picture closing, then the world is asked
   * to put the player back aboard — this class does not know where that is, so
   * it raises `wake` and lets main.js place them. */
  _blackout(dt) {
    this.fade = clamp(this.fade + dt / BLACKOUT_FADE, 0, 1);
    this.veil = 1;
    this.breath += (34 - this.breath) * Math.min(1, dt * 1.2);
    if (this.fade >= 1) {
      this.phase = 'waking';
      this._phaseT = 0;
      this.co2 = 0;
      this.events.push({ kind: 'wake' });
    }
  }

  _waking(dt) {
    this.fade = clamp(this.fade - dt / WAKE_FADE, 0, 1);
    this.veil = this.fade * 0.6;
    this.breath += (16 - this.breath) * Math.min(1, dt * 0.6);
    if (this.fade <= 0) this._setPhase('ok');
  }

  /** One line for the diagnostic panel. */
  report() {
    return `scrub ${(this.remaining * 100).toFixed(0)}%  ${this.minutesLeft.toFixed(1)} min`
      + `  ${this.rate.toFixed(2)} l/min  ${this.breath.toFixed(0)} bpm  ${this.phase}`
      + (this.fade > 0 ? `  fade ${this.fade.toFixed(2)}` : '');
  }
}
