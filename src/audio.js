/* The synthesiser. Owns the AudioContext and decides nothing.
 *
 * Every number this file uses arrives from `src/acoustics.js`, which is pure
 * arithmetic and is measured in node at a fixed 60 Hz by `tools/dyn.mjs`. The
 * split is the same one that keeps `src/vessel.js` renderer-free, and for the
 * same reason: the sandbox cannot measure a time constant, and sound is nothing
 * but time constants. If a creak rate is wrong, it is wrong in `acoustics.js`
 * and there is a test that says so. If it is *inaudible*, it is wrong here.
 *
 * ---------------------------------------------------------------------------
 * No assets, and that includes sound
 *
 * The project's rule is that nothing is downloaded and nothing is authored
 * outside the code, which for audio means no samples: every voice is an
 * oscillator, a filter, or a buffer of noise generated at boot from
 * `src/rng.js`. Seeded, because an unseeded noise buffer makes a rendered
 * spectrum different every run and an offline render stops being a test.
 *
 * That constraint has the same payoff it had for the meshes. The ballast blow
 * is bandpassed at the Minnaert frequency of a 2 mm bubble at the *current*
 * pressure, so it climbs from 1.6 kHz to 10.6 kHz over the descent on its own.
 * No sample library ships that.
 *
 * ---------------------------------------------------------------------------
 * Failing loudly
 *
 * A shader that fails to compile renders nothing and says nothing; that cost
 * this project a session. Audio has the same failure mode and worse, because
 * silence is a legitimate output. So: nothing in here is allowed to throw into
 * the frame loop, `state` always says what happened, and F3 prints it. A game
 * that is quiet because the context never resumed must not look like a game
 * that is quiet because it is 400 m down.
 */

import { rng, SEEDS } from './rng.js';
import { Acoustics, SHELL_RING, CABIN_MODES, EAR, MOTOR, SCORE } from './acoustics.js';

/* Smooth a parameter toward a value. Assigning `.value` every frame is a
 * staircase and audibly zippers on anything tonal; `setTargetAtTime` is the
 * exponential approach the API provides for exactly this. 25 ms is below the
 * ear's resolution for level and above the frame interval.
 *
 * The time has to be passed in. An AudioParam has no `context` property — the
 * first version of this reached for one, got undefined, and scheduled every
 * change at time zero. That happens to work in Chrome, because a start time in
 * the past means "now", and it is exactly the kind of accident that works until
 * a browser tightens up. */
const SMOOTH = 0.025;
function ramp(param, v, t, tau = SMOOTH) {
  if (!Number.isFinite(v)) return;
  param.setTargetAtTime(v, t, tau);
}

export class Audio {
  constructor() {
    /** 'off' until start(), then 'running', or 'failed' with `error` set. */
    this.state = 'off';
    this.error = '';
    this.ctx = null;
    this.acoustics = new Acoustics(SEEDS.creak);
    this.muted = false;
    this.voices = 0;          // live event nodes, for F3
    this.peak = 0;            // decaying peak of the summed parameter set
    this._events = 0;         // lifetime event count, for F3
  }

  /**
   * Build the graph. Must be called from a user gesture — a context created
   * outside one starts suspended and silently stays that way.
   *
   * The one place this file is allowed to know about the DOM is here, and it
   * still does not: `main.js` calls this from the Begin descent handler, which
   * is the gesture the boot gate already had.
   */
  start() {
    if (this.state === 'running') return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('no AudioContext in this browser');
      const ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this._build(ctx);
      ctx.resume?.();
      this.state = 'running';
      return true;
    } catch (e) {
      this.state = 'failed';
      this.error = String(e && e.message ? e.message : e);
      /* Say it once, plainly. The alternative is a silent game that looks
       * exactly like a working one, which is the bug class this project has
       * already paid for twice. */
      console.error('[audio] failed to start:', this.error);
      return false;
    }
  }

  /* ------------------------------------------------------------------ graph
   *
   *   voices ──┬─→ direct ──────────────┐
   *            └─→ send ─┬─→ cabinIR ───┤
   *                      └─→ waterIR ───┤
   *                                     └─→ tilt → limiter → master → out
   *
   * `tilt` is the ear, not the water: Thorp says the sea is transparent over
   * the twenty metres this game can see, so the darkening when your head leaves
   * the hull is bone conduction, and it belongs on the listener.
   *
   * The limiter is a safety rail with arithmetic behind it. A grounding at 0.55
   * plus a blow at 0.34 plus a creak at 0.22 is 1.11, and Web Audio clips hard
   * and ugly. It should almost never engage; if it engages often the budget in
   * `acoustics.js` is wrong and that is where to fix it.
   */
  _build(ctx) {
    const noise = this._noiseBuffer(ctx, 6.0);
    this.noise = noise;

    this.master = ctx.createGain();
    this.master.gain.value = 0;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;

    this.tilt = ctx.createBiquadFilter();
    this.tilt.type = 'lowpass';
    this.tilt.frequency.value = EAR.cabinTilt;
    this.tilt.Q.value = 0.7;

    this.tilt.connect(this.limiter).connect(this.master).connect(ctx.destination);

    // Direct and diffuse paths. `spread` moves energy from one to the other.
    this.direct = ctx.createGain();
    this.direct.gain.value = 1;
    this.direct.connect(this.tilt);

    this.send = ctx.createGain();
    this.send.gain.value = 0.35;

    this.cabinWet = ctx.createGain();
    this.waterWet = ctx.createGain();
    this.cabinWet.gain.value = 1;
    this.waterWet.gain.value = 0;

    this.cabinIR = ctx.createConvolver();
    this.cabinIR.normalize = true;
    this.cabinIR.buffer = this._impulse(ctx, EAR.cabinRT, 2400);
    this.waterIR = ctx.createConvolver();
    this.waterIR.normalize = true;
    this.waterIR.buffer = this._impulse(ctx, EAR.waterRT, 700);

    this.send.connect(this.cabinIR).connect(this.cabinWet).connect(this.tilt);
    this.send.connect(this.waterIR).connect(this.waterWet).connect(this.tilt);

    /** Every voice connects here: one place that feeds both paths. */
    this.bus = ctx.createGain();
    this.bus.connect(this.direct);
    this.bus.connect(this.send);

    this._buildBed(ctx, noise);
    this._buildMachine(ctx, noise);
    this._buildBallast(ctx, noise);
    this._buildScrape(ctx, noise);
    this._buildScore(ctx);
  }

  /* --------------------------------------------------------------- the score
   *
   * Three partials on the boat's own frequencies, and the tuning is the argument:
   * the root is the cabin's transverse air mode and the top is the shell's ring
   * frequency, so their ratio is 9.82 rather than a round 8 or 10. That near-miss
   * is the whole character — a drone built on exact octaves sounds like a synth
   * pad, and one built on a hull sounds like the hull.
   *
   * The middle partial is detuned by three cents against the root's second
   * harmonic, which beats once every eleven seconds. Slow enough not to read as
   * vibrato, fast enough that the drone never sits perfectly still.
   *
   * It goes to `direct` rather than through `bus`, so it is not fed to the
   * convolvers and does not get the ear model applied. The score is not in the
   * water with the player: reverberating it would make the non-diegetic layer
   * respond to the hatch, which is the moment the trick becomes visible.
   */
  _buildScore(ctx) {
    this.scoreG = ctx.createGain();
    this.scoreG.gain.value = 0;

    /* One gentle lowpass over the lot, opening with tension. Brightness is how a
     * drone communicates rising pressure without getting louder — which matters
     * here, because the level is capped hard by the budget. */
    this.scoreF = ctx.createBiquadFilter();
    this.scoreF.type = 'lowpass';
    this.scoreF.frequency.value = 180;
    this.scoreF.Q.value = 0.9;
    this.scoreG.connect(this.scoreF).connect(this.direct);

    const root = SCORE.root;
    const partials = [
      { f: root, type: 'sine', g: 1.00 },
      { f: root * 2 * 1.0017, type: 'sine', g: 0.42 },   // +3 cents: an 11 s beat
      { f: SCORE.ring, type: 'triangle', g: 0.055 },
    ];
    this.scoreOsc = [];
    for (const p of partials) {
      const o = ctx.createOscillator();
      o.type = p.type;
      o.frequency.value = p.f;
      const g = ctx.createGain();
      g.gain.value = p.g;
      o.connect(g).connect(this.scoreG);
      o.start();
      this.scoreOsc.push(o);
    }
  }

  /* --------------------------------------------------------------- the bed
   *
   * Two components because Wenz's spectra have two: a low band that barely
   * cares about depth, and surface agitation that does. The result is that the
   * descent takes the hiss away and leaves the rumble, which is the whole
   * reason the bottom of this canyon sounds like the title.
   */
  _buildBed(ctx, noise) {
    const low = ctx.createBufferSource();
    low.buffer = noise; low.loop = true;
    low.playbackRate.value = 0.55;        // slower playback drops the spectrum
    const lowF = ctx.createBiquadFilter();
    lowF.type = 'lowpass'; lowF.frequency.value = 140; lowF.Q.value = 0.5;

    /* The cabin's own air resonance, sitting on the bed. 36.5 Hz is the beam of
     * the boat; the 18 m length is 9.5 Hz and inaudible, which is why walking
     * forward does not change the hum.
     *
     * In series, not in parallel. A peaking filter already passes the whole
     * signal and adds a bump — hanging it alongside the dry path as well doubles
     * everything below it and gets the bed's level wrong by 6 dB before the
     * budget has had a chance to be obeyed. */
    const modeF = ctx.createBiquadFilter();
    modeF.type = 'peaking';
    modeF.frequency.value = CABIN_MODES.transverse;
    modeF.Q.value = 6; modeF.gain.value = 9;

    this.bedLowG = ctx.createGain(); this.bedLowG.gain.value = 0;
    low.connect(lowF).connect(modeF).connect(this.bedLowG).connect(this.bus);
    low.start();

    const hiss = ctx.createBufferSource();
    hiss.buffer = noise; hiss.loop = true;
    hiss.playbackRate.value = 1.0;
    const hissF = ctx.createBiquadFilter();
    hissF.type = 'bandpass'; hissF.frequency.value = 1200; hissF.Q.value = 0.45;
    this.bedHissG = ctx.createGain(); this.bedHissG.gain.value = 0;
    hiss.connect(hissF).connect(this.bedHissG).connect(this.bus);
    hiss.start();
  }

  /* ----------------------------------------------------------- the machine
   *
   * Three parts, and the one that makes it read as equipment rather than as a
   * synthesiser is the one that does not move: magnetostriction in the stator
   * sings at twice line frequency, 100 Hz, fixed, while the blade note slides
   * from 32 Hz to 121 Hz under it.
   *
   * The blade note is a PeriodicWave rather than a sine because at idle the
   * fundamental is 32 Hz — under most speakers. Its harmonics are what actually
   * carries an idling pump, and that is true of the real thing too.
   */
  _buildMachine(ctx, noise) {
    this.machG = ctx.createGain(); this.machG.gain.value = 0;
    this.machG.connect(this.bus);

    const real = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
    const imag = new Float32Array([0, 1, 0.52, 0.31, 0.18, 0.10, 0.06]);
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });

    this.blade = ctx.createOscillator();
    this.blade.setPeriodicWave(wave);
    this.blade.frequency.value = 32;
    const bladeG = ctx.createGain(); bladeG.gain.value = 0.55;
    this.blade.connect(bladeG).connect(this.machG);
    this.blade.start();

    this.hum = ctx.createOscillator();
    this.hum.type = 'sawtooth';
    this.hum.frequency.value = MOTOR.hum;
    const humF = ctx.createBiquadFilter();
    humF.type = 'lowpass'; humF.frequency.value = 420; humF.Q.value = 1.2;
    const humG = ctx.createGain(); humG.gain.value = 0.30;
    this.hum.connect(humF).connect(humG).connect(this.machG);
    this.hum.start();

    /* Cavitation. A screw ordered hard over against a hull with no way on is
     * pushing water that cannot get out of the way. Broadband, and it cleans up
     * over about seventeen seconds as she gathers way — measured, not guessed. */
    const rough = ctx.createBufferSource();
    rough.buffer = noise; rough.loop = true; rough.playbackRate.value = 1.35;
    const roughF = ctx.createBiquadFilter();
    roughF.type = 'bandpass'; roughF.frequency.value = 260; roughF.Q.value = 0.7;
    this.roughG = ctx.createGain(); this.roughG.gain.value = 0;
    rough.connect(roughF).connect(this.roughG).connect(this.machG);
    rough.start();
  }

  /* ---------------------------------------------------------- the ballast
   *
   * Gain comes straight from `ballastCmd - ballast`, so the hiss *is* the
   * gauge for a tank the pilot cannot see: it starts on the keypress, it keeps
   * going for twenty-six seconds after a one-second press, and it stops when
   * the transfer is actually finished. Measured against the eight-second tank.
   *
   * Blowing and flooding are the same noise through two different filters,
   * because they are the same event in two directions: high-pressure air out
   * through a valve is bright and hard, water in through a vent is low and
   * gulping.
   */
  _buildBallast(ctx, noise) {
    this.balG = ctx.createGain(); this.balG.gain.value = 0;
    this.balG.connect(this.bus);

    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true; src.playbackRate.value = 1.0;

    this.bubbleF = ctx.createBiquadFilter();
    this.bubbleF.type = 'bandpass';
    this.bubbleF.frequency.value = 1600;
    this.bubbleF.Q.value = 1.1;
    this.blowG = ctx.createGain(); this.blowG.gain.value = 1;
    src.connect(this.bubbleF).connect(this.blowG).connect(this.balG);

    const gulp = ctx.createBiquadFilter();
    gulp.type = 'lowpass'; gulp.frequency.value = 340; gulp.Q.value = 2.2;
    this.floodG = ctx.createGain(); this.floodG.gain.value = 0;
    src.connect(gulp).connect(this.floodG).connect(this.balG);
    src.start();
  }

  _buildScrape(ctx, noise) {
    this.scrapeG = ctx.createGain(); this.scrapeG.gain.value = 0;
    this.scrapeG.connect(this.bus);
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true; src.playbackRate.value = 0.8;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.6;
    src.connect(f).connect(this.scrapeG);
    src.start();
  }

  /* --------------------------------------------------------------- buffers */

  /** Seeded white noise. One buffer, reused by every noise voice. */
  _noiseBuffer(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const rand = rng(SEEDS.noise);
    for (let i = 0; i < n; i++) d[i] = rand() * 2 - 1;
    return buf;
  }

  /**
   * A room, as an impulse response: noise under an exponential decay, then
   * one-pole low-passed so the tail is darker than the onset.
   *
   * Real tails lose their top first, and the two rooms this game has differ
   * mostly in that. The cabin is a steel tube with soft goods in it — short and
   * fairly bright. The canyon is long and dark. RT60 to time constant is
   * ln(1000) = 6.91.
   */
  _impulse(ctx, rt60, cutoff) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * rt60));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const rand = rng(SEEDS.noise ^ Math.round(rt60 * 1000));
    const tau = rt60 / 6.91;
    // One-pole coefficient for the tail's low-pass, per channel.
    const a = Math.exp((-2 * Math.PI * cutoff) / ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let z = 0;
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        const x = (rand() * 2 - 1) * Math.exp(-t / tau);
        z = x * (1 - a) + z * a;
        d[i] = z;
      }
    }
    return buf;
  }

  /* ---------------------------------------------------------------- update */

  /**
   * One frame. `s` is the same state object `Acoustics.update` takes.
   *
   * Wrapped, because a thrown exception here would take the render loop with
   * it and the game would die of a sound bug.
   */
  update(dt, s) {
    try {
      this.acoustics.update(dt, { ...s, muted: this.muted });
      if (this.state !== 'running' || !this.ctx) return;

      /* A context can be created inside a gesture and still come up suspended —
       * autoplay policy, a background tab, an audio device that went away. That
       * is silence indistinguishable from working silence, so retry, at most
       * once a second, and let F3 show `ctx.state` either way. */
      if (this.ctx.state === 'suspended') {
        this._retry = (this._retry || 0) + dt;
        if (this._retry > 1) { this._retry = 0; this.ctx.resume?.(); }
      }

      const v = this.acoustics.v;
      const t = this.ctx.currentTime;

      ramp(this.master.gain, v.master, t);
      ramp(this.tilt.frequency, v.tilt, t, 0.08);

      // Losing localisation is more diffuse and less direct, which is what it is.
      ramp(this.direct.gain, 1 - 0.55 * v.spread, t);
      ramp(this.send.gain, 0.28 + 0.55 * v.spread, t);
      ramp(this.cabinWet.gain, v.inside, t);
      ramp(this.waterWet.gain, 1 - v.inside, t);

      ramp(this.bedLowG.gain, v.bedLow, t);
      ramp(this.bedHissG.gain, v.bedHiss, t);

      ramp(this.machG.gain, v.machGain, t);
      ramp(this.blade.frequency, v.machBlade, t, 0.12);
      ramp(this.roughG.gain, v.machRough * 0.5, t);

      ramp(this.balG.gain, v.balGain, t);
      ramp(this.bubbleF.frequency, v.balBubble, t, 0.15);
      ramp(this.blowG.gain, v.balBlow, t);
      ramp(this.floodG.gain, 1 - v.balBlow, t);

      ramp(this.scrapeG.gain, v.scrape, t);

      /* The score. Level is already ducked by the mapping, so it is followed
       * quickly — a slow ramp here would undo the ducking, which is the one thing
       * this voice must get right. Brightness follows tension more slowly. */
      ramp(this.scoreG.gain, v.scoreGain, t, 0.05);
      ramp(this.scoreF.frequency, 130 + 460 * v.tension, t, 1.2);

      for (const e of this.acoustics.events) {
        if (e.kind === 'creak') this._creak(t, e);
        else if (e.kind === 'thud') this._thud(t, e);
        else if (e.kind === 'ping') this._ping(t, e);
        else if (e.kind === 'breath') this._breath(t, e);
        else if (e.kind === 'beep') this._beep(t, e);
        this._events++;
      }

      this.peak = Math.max(this.peak * Math.exp(-dt * 1.5),
        v.bedLow + v.bedHiss + v.machGain + v.balGain + v.scrape + v.scoreGain);
    } catch (e) {
      this.state = 'failed';
      this.error = String(e && e.message ? e.message : e);
      console.error('[audio] update failed, going quiet:', this.error);
    }
  }

  /**
   * One hull event: a modal ring plus an impact body.
   *
   * The body is the reason this is two nodes. The ovalling mode of this hull is
   * 11 Hz — below hearing — so a creak's low end cannot come from a resonance
   * and has to come from the onset of the transient, which is broadband. A
   * bandpass alone gives a pure tone that sounds like a bowed glass.
   */
  _creak(t, e) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = false;
    /* A moving window into the shared noise buffer, so two events never use the
     * same slice. The modulus leaves room for the longest tail: run off the end
     * of the buffer and playback stops while the envelope is still open, which
     * truncates the ring and reads as a click. */
    const dur = Math.min(e.decay * 1.3, 2.2);
    const off = (this._events * 0.137) % (this.noise.duration - 2.5);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = e.f; bp.Q.value = e.q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(e.level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, e.level * 0.001), t + dur);

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass'; body.frequency.value = 190; body.Q.value = 0.8;
    const bodyG = ctx.createGain();
    bodyG.gain.setValueAtTime(0, t);
    bodyG.gain.linearRampToValueAtTime(e.level * 0.5, t + 0.003);
    bodyG.gain.exponentialRampToValueAtTime(1e-4, t + 0.09);

    src.connect(bp).connect(g).connect(this.bus);
    src.connect(body).connect(bodyG).connect(this.bus);
    src.start(t, off, dur + 0.05);
    this.voices++;
    src.onended = () => {
      this.voices--;
      try { g.disconnect(); bodyG.disconnect(); } catch { /* already gone */ }
    };
  }

  /** Grounding. Broadband impact with a downward sweep, plus the shell ringing. */
  _thud(t, e) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const off = (this._events * 0.211) % (this.noise.duration - 1.0);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.exponentialRampToValueAtTime(55, t + 0.45);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(e.level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.7);

    const ring = ctx.createBiquadFilter();
    ring.type = 'bandpass'; ring.frequency.value = e.f || SHELL_RING; ring.Q.value = 24;
    const ringG = ctx.createGain();
    ringG.gain.setValueAtTime(0, t);
    ringG.gain.linearRampToValueAtTime(e.level * 0.32, t + 0.004);
    ringG.gain.exponentialRampToValueAtTime(1e-4, t + 0.55);

    src.connect(lp).connect(g).connect(this.bus);
    src.connect(ring).connect(ringG).connect(this.bus);
    src.start(t, off, 0.8);
    this.voices++;
    src.onended = () => {
      this.voices--;
      try { g.disconnect(); ringG.disconnect(); } catch { /* already gone */ }
    };
  }

  /**
   * The trunk's pinger. A clean tone with a hard onset, because the *rate* is the
   * message and a soft attack blurs the interval the ear is trying to time.
   */
  _ping(t, e) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = e.f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(e.level, t + 0.002);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.13);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.16);
    this.voices++;
    o.onended = () => { this.voices--; try { g.disconnect(); } catch { /* gone */ } };
  }

  /**
   * One half of a breath. Filtered noise with a slow swell, and inhalation is
   * brighter and shorter than exhalation because the counterlung is on the other
   * side of it.
   *
   * This is the cheapest frightening sound in the game and it costs three nodes.
   */
  _breath(t, e) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const dur = e.inhale ? 0.5 : 0.72;
    const off = (this._events * 0.317) % (this.noise.duration - 1.2);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(e.f * (e.inhale ? 0.7 : 1.25), t);
    // The formant slides through the breath, which is what makes it a throat.
    bp.frequency.linearRampToValueAtTime(e.f * (e.inhale ? 1.35 : 0.72), t + dur);
    bp.Q.value = 1.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(e.level, t + dur * (e.inhale ? 0.35 : 0.22));
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);

    src.connect(bp).connect(g).connect(this.bus);
    src.start(t, off, dur + 0.05);
    this.voices++;
    src.onended = () => { this.voices--; try { g.disconnect(); } catch { /* gone */ } };
  }

  /** The scrubber warning. Two short pips, so it cannot be heard as the pinger. */
  _beep(t, e) {
    const ctx = this.ctx;
    for (const [i, off] of [[0, 0], [1, 0.11]]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = e.f * (i ? 1.0 : 1.0);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.7;
      const g = ctx.createGain();
      const t0 = t + off;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(e.level * 0.5, t0 + 0.004);
      g.gain.setValueAtTime(e.level * 0.5, t0 + 0.055);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.08);
      o.connect(lp).connect(g).connect(this.bus);
      o.start(t0);
      o.stop(t0 + 0.1);
      this.voices++;
      o.onended = () => { this.voices--; try { g.disconnect(); } catch { /* gone */ } };
    }
  }

  /** Toggle. Silence is a gain change, not a teardown — the graph stays warm. */
  mute(on = !this.muted) { this.muted = on; return this.muted; }

  /** One line for the diagnostic panel. See F3. */
  report() {
    const a = this.acoustics;
    /* Even with the graph off the mapping is still running, so the panel can
     * still say what the hull *would* be doing. That is what makes a report of
     * "I hear nothing" answerable: if creak/s is 3 and the level is 0, the
     * problem is the context, not the physics. */
    if (this.state === 'off') return `sound off   creak/s ${a.creakRate.toFixed(2)}`;
    if (this.state === 'failed') return `sound FAILED: ${this.error}`;
    return `sound ${this.ctx.state}  ${this.muted ? 'MUTED' : `lvl ${this.peak.toFixed(3)}`}`
      + `  voices ${this.voices}  creak/s ${a.creakRate.toFixed(2)}`
      + `  rpm ${a.rpm.toFixed(0)}  blade ${a.v.machBlade.toFixed(0)}Hz`
      + `  in ${a.v.inside.toFixed(2)}`
      + `  score ${a.v.scoreGain.toFixed(3)} tens ${a.tension.toFixed(2)} duck ${a.duck.toFixed(2)}`;
  }
}
