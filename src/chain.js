/* Verlet chains. Pure arithmetic — no `three`, no renderer, no globals.
 *
 * Separate from the creature that uses it for the same reason `life.js` and
 * `acoustics.js` are separate from the things that play them: a solver with a
 * stability limit in it is exactly the kind of code that cannot be judged from
 * a browser. `DESIGN-CREATURES.md` says so outright — "assert that a Verlet
 * chain is stable at dt clamped to 0.1 (it will not be, at three iterations —
 * find out in node, not in a browser)". This file exists so that assertion has
 * something to point at, and `tools/dyn.mjs --only chain` is where the numbers
 * come from.
 *
 * Positions are a flat Float32Array of x,y,z triples. Flat rather than an array
 * of vectors because the solver touches every component several times per
 * substep and this is the one place in the project where that matters.
 */

/* Two constants, and only the first is a judgement call.
 *
 * MAX_SUBSTEP is *measured*, not chosen — see the chain scenario in dyn.mjs.
 * A distance constraint is solved by relaxation, so a disturbance travels one
 * node per iteration: an N-node chain needs about N iterations to be rigid,
 * and nobody is paying for thirty. The alternative to more iterations is
 * smaller steps, and a substep cap is strictly better than raising the
 * iteration count because it also makes the motion frame-rate independent —
 * which this project needs, since main.js clamps dt to 0.1 and the sandbox
 * genuinely delivers that. */
export const MAX_SUBSTEP = 1 / 60;
export const ITERATIONS = 4;

export class VerletChain {
  /**
   * @param {number} n      node count
   * @param {number} spacing rest length between neighbours, metres
   * @param {number[]} head world position of node 0 at rest
   * @param {number[]} dir  unit direction the chain trails away along
   */
  constructor(n, spacing, head = [0, 0, 0], dir = [0, 0, 1]) {
    this.n = n;
    this.spacing = spacing;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = head[k] + dir[k] * spacing * i;
        this.pos[i * 3 + k] = v;
        this.prev[i * 3 + k] = v;
      }
    }
    /* Neutral buoyancy, so this is nearly zero rather than 9.81 — and that is
     * the whole silhouette. A chain under real gravity hangs; a chain under
     * this drifts. The residual is what makes it settle rather than float
     * forever, and it is the reason the tail lags below the head on a turn. */
    this.gravity = -0.035;
    /* Water is viscous at this scale. Without damping a Verlet chain retains
     * every impulse it is ever given and ends up thrashing. */
    this.damping = 0.94;
  }

  /** World position of node i, written into `out`. */
  node(i, out) {
    out[0] = this.pos[i * 3];
    out[1] = this.pos[i * 3 + 1];
    out[2] = this.pos[i * 3 + 2];
    return out;
  }

  /** Straight-line distance from node 0 to the last node. */
  span() {
    const n = this.n - 1;
    const dx = this.pos[n * 3] - this.pos[0];
    const dy = this.pos[n * 3 + 1] - this.pos[1];
    const dz = this.pos[n * 3 + 2] - this.pos[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Summed length along the chain. Compare against (n-1)*spacing. */
  arcLength() {
    let s = 0;
    for (let i = 1; i < this.n; i++) {
      const a = i * 3, b = (i - 1) * 3;
      const dx = this.pos[a] - this.pos[b];
      const dy = this.pos[a + 1] - this.pos[b + 1];
      const dz = this.pos[a + 2] - this.pos[b + 2];
      s += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return s;
  }

  /** True if every component is finite. The first thing any gate should ask. */
  finite() {
    for (let i = 0; i < this.pos.length; i++) if (!Number.isFinite(this.pos[i])) return false;
    return true;
  }

  /** Largest single-substep displacement, as a multiple of the rest spacing.
   * A healthy chain sits well under 1; a diverging one runs away immediately. */
  maxStretch() {
    let worst = 0;
    for (let i = 1; i < this.n; i++) {
      const a = i * 3, b = (i - 1) * 3;
      const dx = this.pos[a] - this.pos[b];
      const dy = this.pos[a + 1] - this.pos[b + 1];
      const dz = this.pos[a + 2] - this.pos[b + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      worst = Math.max(worst, Math.abs(d - this.spacing) / this.spacing);
    }
    return worst;
  }

  /**
   * Advance, pinning node 0 to `anchor`.
   *
   * `dt` may be anything — it is split into substeps of at most MAX_SUBSTEP,
   * which is what makes this safe to call from a frame loop whose dt is clamped
   * to 0.1. The anchor is interpolated across the substeps rather than jumped
   * to, otherwise the first substep does all the work and the rest of the chain
   * sees one enormous impulse: the same "give the singularity a multi-metre
   * step width" mistake the volumetric pass records, in a different subsystem.
   */
  update(dt, anchor, iterations = ITERATIONS) {
    if (!(dt > 0)) return;
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / steps;
    const a0 = [this.pos[0], this.pos[1], this.pos[2]];
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      this._substep(h, [
        a0[0] + (anchor[0] - a0[0]) * u,
        a0[1] + (anchor[1] - a0[1]) * u,
        a0[2] + (anchor[2] - a0[2]) * u,
      ], iterations);
    }
  }

  _substep(h, anchor, iterations) {
    const { pos, prev, n } = this;
    const g = this.gravity * h * h;
    // Integrate. Node 0 is driven, so it is skipped and pinned below.
    for (let i = 1; i < n; i++) {
      const b = i * 3;
      for (let k = 0; k < 3; k++) {
        const p = pos[b + k];
        const v = (p - prev[b + k]) * this.damping;
        prev[b + k] = p;
        pos[b + k] = p + v + (k === 1 ? g : 0);
      }
    }
    pos[0] = anchor[0]; pos[1] = anchor[1]; pos[2] = anchor[2];

    // Relax the distance constraints. Node 0 has infinite mass (it is pinned),
    // so its half of every correction goes to its neighbour instead.
    for (let it = 0; it < iterations; it++) {
      for (let i = 1; i < n; i++) {
        const a = (i - 1) * 3, b = i * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;                       // coincident: no direction to push along
        const corr = (d - this.spacing) / d * 0.5;
        const wa = i === 1 ? 0 : 1, wb = i === 1 ? 2 : 1;
        pos[a] += dx * corr * wa; pos[a + 1] += dy * corr * wa; pos[a + 2] += dz * corr * wa;
        pos[b] -= dx * corr * wb; pos[b + 1] -= dy * corr * wb; pos[b + 2] -= dz * corr * wb;
      }
      pos[0] = anchor[0]; pos[1] = anchor[1]; pos[2] = anchor[2];
    }
  }
}
