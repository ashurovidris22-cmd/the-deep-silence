import * as THREE from 'three';
import { seabedHeight, WORLD_R } from './terrain.js';
import { HULL_LEN, HULL_R } from './fitout.js';

/* The boat, as a thing that moves.
 *
 * Until now it was scenery you could stand inside: eighteen metres of hull
 * bolted to the canyon floor, with a seat at the bow that changed the camera
 * and nothing else. The honest answer to "how do I drive it" was "you cannot".
 *
 * ---------------------------------------------------------------------------
 * Why a submersible is not a car with a Y axis
 *
 * Three things make this feel like a vessel rather than a flying box, and all
 * three are cheap:
 *
 *  1. **Vertical is ballast, not thrust.** You do not fly up. You blow water
 *     out of a tank and then wait while several hundred tonnes decides to
 *     follow. The tank takes about eight seconds to change state, so every
 *     depth command is a commitment made well before its consequence — which is
 *     the entire feeling Barotrauma gets out of its systems, and it costs one
 *     first-order lag.
 *
 *  2. **A rudder does nothing at rest.** Steering authority is proportional to
 *     the water flowing past the blade. Stopped, you can put the wheel hard
 *     over and the boat will sit there. That single term is the difference
 *     between piloting and driving.
 *
 *  3. **Nothing stops when you let go.** Drag is small compared with the mass,
 *     so the boat carries its way for a long time. Set a throttle and walk
 *     aft, and it is still going — which is why the throttle is a *setting*
 *     rather than a key you hold. Leaving the helm with way on is meant to be
 *     something you can regret.
 *
 * Mass is expressed as accelerations rather than newtons. The alternative is a
 * mass, a displacement, a drag coefficient and a wetted area — four numbers to
 * tune instead of two, all of which only ever appear as their ratios anyway.
 */

const UP = new THREE.Vector3(0, 1, 0);

/* Terminal speed is thrust over drag: 0.95 / 0.21 is about 4.5 m/s, nine knots.
 *
 * Faster than a real deep submersible, which does two or three. The canyon is
 * only a couple of hundred metres across, so at a true two knots crossing it
 * takes three minutes of holding a key — accurate, and an argument for not
 * driving. The time constant is left honest at nearly five seconds, so she
 * still takes her time getting there and a very long time stopping. */
const THRUST = 0.95;         // m/s^2 at full ahead
const SURGE_DRAG = 0.21;     // 1/s, along the hull
const SWAY_DRAG = 1.05;      // 1/s, across it — a hull resists sideways hard
const HEAVE_DRAG = 0.55;     // 1/s, vertically

const RUDDER = 0.34;         // yaw accel per unit rudder at full way
const YAW_DRAG = 1.25;       // 1/s
const STEER_SPEED = 1.4;     // m/s at which the rudder reaches full authority

const BALLAST_RATE = 1 / 8.0;   // tank e-folds in eight seconds
/* Terminal vertical speed is BUOYANCY / HEAVE_DRAG. At 1.45 that was 2.6 m/s —
 * five knots straight up, which is an emergency blow, not a dive plan. At 1.0
 * it is 1.8 m/s, so the four hundred metres from the canyon floor to the shelf
 * take about four minutes. That wait is the point: depth is the one axis you
 * cannot hurry, and it is what makes committing to the bottom feel like a
 * decision rather than a keystroke. */
const BUOYANCY = 1.0;           // m/s^2 between hard-blown and hard-flooded

export class Vessel {
  constructor(origin, yaw = 0) {
    this.pos = origin.clone();
    this.yaw = yaw;
    this.vel = new THREE.Vector3();
    this.yawRate = 0;

    /* Throttle persists, rudder centres. A real telegraph and a real wheel both
     * stay put, but a wheel left hard over while the pilot walks aft turns the
     * boat into a spiral you cannot see out of — and the player has no way to
     * know why. Persistent throttle keeps the interesting half of that. */
    this.throttle = 0;      // -1 .. 1, a setting
    this.rudder = 0;        // -1 .. 1, springs to centre
    this.ballast = 0.5;     // 0 blown (rises), 1 flooded (sinks)
    this.ballastCmd = 0.5;

    this.grounded = false;
    this.contact = 0;       // impact strength of the last touch, for feedback
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  /** Unit vector along the bow, in world space. Hull +Z is forward. */
  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Hull-local point to world. */
  toWorld(local, out = new THREE.Vector3()) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(
      this.pos.x + local.x * c + local.z * s,
      this.pos.y + local.y,
      this.pos.z - local.x * s + local.z * c,
    );
  }

  /** World point to hull-local. The exact inverse of toWorld. */
  toLocal(world, out = new THREE.Vector3()) {
    const dx = world.x - this.pos.x, dy = world.y - this.pos.y, dz = world.z - this.pos.z;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(dx * c - dz * s, dy, dx * s + dz * c);
  }

  /**
   * Lowest point of the hull under a given station, in world Y.
   *
   * The keel is not a point. A boat eighteen metres long resting on a canyon
   * floor with two metres of relief touches at one end first and pivots, and
   * sampling a single point under the middle lets the bow bury itself in a
   * bank without anything noticing.
   */
  groundClearance() {
    let worst = -1e9;
    this._hitX = this.pos.x; this._hitZ = this.pos.z;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const t of [-0.92, -0.45, 0, 0.45, 0.92]) {
      const lz = t * HULL_LEN;
      const wx = this.pos.x + lz * s;
      const wz = this.pos.z + lz * c;
      // The section narrows toward the ends, so the keel rises with it.
      const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(t), 3.2)));
      const keel = this.pos.y - r - 0.25;
      const g = seabedHeight(wx, wz) + 0.15;
      const pen = g - keel;
      if (pen > worst) { worst = pen; this._hitX = wx; this._hitZ = wz; }
    }
    return -worst;   // positive = clear of the bottom
  }

  /** Outward normal of the seabed at a world XZ. */
  groundNormal(x, z, out = new THREE.Vector3()) {
    const e = 2.0;
    const dx = (seabedHeight(x + e, z) - seabedHeight(x - e, z)) / (2 * e);
    const dz = (seabedHeight(x, z + e) - seabedHeight(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  update(dt, ceilingY) {
    // --- ballast, with its lag. Everything vertical follows from this.
    this.ballast += (this.ballastCmd - this.ballast) * (1 - Math.exp(-dt * BALLAST_RATE * 8));
    const netBuoy = (0.5 - this.ballast) * 2 * BUOYANCY;

    // --- surge
    const fwd = this.forward();
    this.vel.addScaledVector(fwd, this.throttle * THRUST * dt);
    this.vel.y += netBuoy * dt;

    /* Drag, resolved in the hull's own axes.
     *
     * One isotropic drag coefficient makes a submarine handle like a balloon:
     * it slides sideways as readily as it goes forward, so a turn becomes a
     * drift and the bow never leads. Splitting surge from sway is what makes
     * the hull track — and it is the same two lines either way. */
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    let vf = this.vel.dot(fwd), vs = this.vel.dot(right), vy = this.vel.y;
    vf *= Math.exp(-SURGE_DRAG * dt);
    vs *= Math.exp(-SWAY_DRAG * dt);
    vy *= Math.exp(-HEAVE_DRAG * dt);
    this.vel.copy(fwd).multiplyScalar(vf).addScaledVector(right, vs);
    this.vel.y = vy;

    /* --- steering, and its authority comes from the water going past.
     *
     * Stopped, the wheel does nothing at all. This is the single detail that
     * separates piloting from driving, and it is one clamp. */
    const way = Math.min(1, Math.abs(vf) / STEER_SPEED) * Math.sign(vf || 1);
    this.yawRate += this.rudder * RUDDER * way * dt;
    this.yawRate *= Math.exp(-YAW_DRAG * dt);
    this.yaw += this.yawRate * dt;
    // Rudder springs amidships when nobody is holding it.
    this.rudder -= this.rudder * Math.min(1, dt * 2.2);

    this.pos.addScaledVector(this.vel, dt);

    // --- the bottom.
    const clear = this.groundClearance();
    if (clear < 0) {
      this.contact = Math.max(this.contact, Math.max(0, -this.vel.y) + Math.abs(vf) * 0.35);
      /* Resolve against the slope's normal, not straight up.
       *
       * Lifting by the penetration alone and leaving the horizontal velocity
       * intact turns the hull into a ratchet: every frame she drives forward,
       * sinks into the rising ground, and is lifted clear again. Left running
       * for three minutes against the canyon wall she climbed three hundred and
       * fifty metres of it and surfaced — a submarine walking up a cliff.
       *
       * Removing the component of velocity going into the surface is the whole
       * fix, and it also produces the right behaviour for free: a gentle bank
       * can be driven over, a wall stops her dead, and a glancing contact slides
       * off with some way lost. */
      this.pos.y += Math.min(-clear, 0.6);   // clear is negative when buried
      const n = this.groundNormal(this._hitX, this._hitZ);
      const into = this.vel.dot(n);
      if (into < 0) this.vel.addScaledVector(n, -into);
      // Scraping the bottom costs way. It should feel like it.
      this.vel.multiplyScalar(Math.exp(-1.4 * dt));
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    this.contact *= Math.exp(-dt * 1.6);

    /* --- the edge of the world, which she was ignoring entirely.
     *
     * The swimmer had a limit and the vessel had none, so she could be driven
     * out through a boundary the player could not swim through. Same constant
     * for both now. Eased rather than snapped, because a hundred tonnes hitting
     * an invisible wall dead should feel like grounding, not like a teleport. */
    const d2 = this.pos.x * this.pos.x + this.pos.z * this.pos.z;
    if (d2 > WORLD_R * WORLD_R) {
      const k = WORLD_R / Math.sqrt(d2);
      this.pos.x *= k; this.pos.z *= k;
      const nx = -this.pos.x / WORLD_R, nz = -this.pos.z / WORLD_R;
      const into = this.vel.x * nx + this.vel.z * nz;
      if (into < 0) { this.vel.x -= nx * into; this.vel.z -= nz * into; }
      this.vel.multiplyScalar(Math.exp(-2.0 * dt));
      this.contact = Math.max(this.contact, 0.4);
    }

    // --- and the ceiling. The vehicle stays under the water it is built for.
    const lid = ceilingY - HULL_R - 1.0;
    if (this.pos.y > lid) { this.pos.y = lid; if (this.vel.y > 0) this.vel.y = 0; }
  }

  /** Push the state onto a mesh whose matrix is manually managed. */
  applyTo(mesh) {
    mesh.position.copy(this.pos);
    this._q.setFromAxisAngle(UP, this.yaw);
    mesh.quaternion.copy(this._q);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  }

  /** Speed along the bow, signed. Positive is ahead. */
  get way() { return this.vel.dot(this.forward()); }
  /** Heading in degrees, 0 = +Z, clockwise seen from above. */
  get heading() { return ((this.yaw * 180 / Math.PI) % 360 + 360) % 360; }
}
