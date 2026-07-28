import * as THREE from 'three';
import { seabedHeight } from './terrain.js';

/* Piloting a submersible, not walking around a level.
 *
 * The distinction matters more than it sounds. An FPS controller sets velocity
 * directly from the keys, so motion starts and stops on the frame the key does.
 * A three-tonne vehicle in water does neither: thrust builds speed against drag,
 * and when you let go it coasts and settles. That lag is most of what makes the
 * thing feel heavy and submerged, and it is free — it is one exponential.
 *
 * Drag is deliberately high. Water is about eight hundred times denser than air,
 * so a real submersible has no glide at all; it stops within a metre or two. A
 * low-drag "floaty space" feel would be the wrong kind of weightless.
 */

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export class Pilot {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    // m/s^2 of thrust, and 1/s of drag. Terminal speed is accel/drag ~= 4.4 m/s,
    // which is brisk for a crewed submersible and slow enough that the fog has
    // time to resolve things before you reach them.
    this.accel = 7.0;
    this.vertAccel = 4.4;
    this.drag = 1.6;
    this.boost = 2.6;          // shift: survey transit speed

    this.sensitivity = 0.0021;
    this.invertY = false;
    this.enabled = false;
    this.locked = false;

    /* Lowest world Y the vehicle may reach, set each frame from the sea surface.
     *
     * Without it you can simply swim up out of the depth band: the daylight term
     * is exp(-Kd * depth), so ascending thirty metres multiplies the ambient by
     * about twenty and the frame goes white. That is not a tone-mapping problem,
     * it is a submersible leaving the water. */
    this.ceilingY = Infinity;

    /* Walk mode: a different vehicle for the body, not a flag on the same one.
     *
     * Swimming and walking are not the same motion with gravity switched on.
     * Swimming steers where you look, including up and down; walking steers where
     * you face and leaves the head free to look elsewhere. Sharing one movement
     * path would mean glancing at the deckhead sends you into it. */
    this.walk = false;
    this.walkOrigin = new THREE.Vector3();
    this.walkBounds = null;      // (localZ, localY) -> half-width in metres
    this.deckY = 0;              // local Y of the deck
    this.eyeH = 1.62;
    this.halfLen = 8.6;
    this.gravity = 14.0;
    this.walkSpeed = 3.1;
    this.grounded = false;
    this.vy = 0;
    this.solids = [];

    // Depth band. Moving vertically inside the scene changes depth by metres;
    // this lets you change it by kilometres, which is the only way to see the
    // whole optical range without a seabed eleven kilometres tall.
    this.bandTarget = 0;
    this.band = 0;

    this.keys = new Set();
    this._bind();
  }

  _bind() {
    const el = this.canvas;

    el.addEventListener('click', () => {
      if (this.enabled && !this.locked) el.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      /* Yaw ADDS movementX, and the sign is not a matter of taste.
       *
       * This heading is built as dir.x = sin(yaw), dir.z = -cos(yaw), so yaw
       * grows clockwise: positive yaw points +X, which is screen-right for a
       * camera looking down -Z. Most implementations subtract here because they
       * drive a YXZ Euler, where positive Y rotation turns the other way. Copying
       * that convention onto this formula inverted the horizontal axis — mouse
       * right, view left. Trust the basis you actually built, not the idiom.
       */
      this.yaw += e.movementX * this.sensitivity;
      // Vertical is conventional: mouse down looks down. Offered as an option
      // because this genuinely is preference, unlike the above.
      this.pitch -= e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
      // Just short of vertical. Reaching exactly +-90 degrees makes the yaw
      // axis degenerate and the view snaps as it passes through.
      const lim = 88 * D2R;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });

    window.addEventListener('keydown', (e) => {
      // Never swallow the browser's own shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      if (e.code === 'KeyL') this.toggleLamp?.();
      if (e.code === 'KeyV') this.toggleMode?.();
      if (e.code === 'KeyE') this.interact?.();
      /* Additive, and now a secondary control rather than the way you descend.
       * With a four-hundred-metre canyon in the world, descending is swimming
       * down it; this only offsets the surface so the optics beyond the world's
       * own range can still be reached and inspected. */
      if (e.code === 'BracketRight') this.bandTarget = Math.min(5600, this.bandTarget + 70);
      if (e.code === 'BracketLeft') this.bandTarget = Math.max(-30, this.bandTarget - 70);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Losing focus mid-thrust otherwise leaves the key latched down and the
    // vehicle drifts away on its own while the tab is in the background.
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Place the pilot explicitly. Used by the pose table and by the harness. */
  setFrom(pos, yawDeg, pitchDeg, band) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yawDeg * D2R;
    this.pitch = pitchDeg * D2R;
    if (band !== undefined) { this.band = band; this.bandTarget = band; }
    this.apply();
  }

  /** Push pilot state onto the camera. */
  apply() {
    this.camera.position.copy(this.pos);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.pos.clone().add(dir));
  }

  update(dt) {
    // Ease the depth band rather than jumping. A hard cut retunes every optical
    // constant in one frame and reads as a glitch, not as a dive.
    this.band += (this.bandTarget - this.band) * Math.min(1, dt * 1.8);

    if (!this.enabled) { this.apply(); return; }
    if (this.walk) { this._walk(dt); return; }

    const k = this.keys;
    const fwd = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();

    const a = new THREE.Vector3();
    if (k.has('KeyW')) a.addScaledVector(fwd, 1);
    if (k.has('KeyS')) a.addScaledVector(fwd, -1);
    if (k.has('KeyD')) a.addScaledVector(right, 1);
    if (k.has('KeyA')) a.addScaledVector(right, -1);
    if (a.lengthSq() > 0) a.normalize().multiplyScalar(this.accel);

    // Ballast is a separate axis with its own authority — a real vehicle trims
    // vertically far more slowly than it drives forward.
    if (k.has('Space')) a.y += this.vertAccel;
    if (k.has('KeyC') || k.has('ControlLeft')) a.y -= this.vertAccel;

    if (k.has('ShiftLeft')) a.multiplyScalar(this.boost);

    this.vel.addScaledVector(a, dt);
    // Exponential drag, integrated exactly. Multiplying by (1 - drag*dt) is the
    // usual shortcut and it goes unstable the moment a frame runs long.
    this.vel.multiplyScalar(Math.exp(-this.drag * dt));
    this.pos.addScaledVector(this.vel, dt);

    /* Do not sink through the seabed.
     *
     * Checked against the same function that built the mesh, so the collision
     * surface and the visible surface cannot disagree. Contact kills the
     * downward component only — sliding along the bottom is allowed, because
     * scraping the floor is a normal way to pilot one of these. */
    const floor = seabedHeight(this.pos.x, this.pos.z) + 0.8;
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y *= -0.12;   // slight settle, not a bounce
    }
    // And a ceiling: the vehicle stays under the water it is designed for.
    if (this.pos.y > this.ceilingY) {
      this.pos.y = this.ceilingY;
      if (this.vel.y > 0) this.vel.y = 0;
    }

    // Keep inside the built terrain. Beyond it the heightfield still evaluates
    // but there is no mesh, so you would fly out over a hole in the world.
    const R = 280;
    const d2 = this.pos.x * this.pos.x + this.pos.z * this.pos.z;
    if (d2 > R * R) {
      const s = R / Math.sqrt(d2);
      this.pos.x *= s; this.pos.z *= s;
      this.vel.x *= 0.3; this.vel.z *= 0.3;
    }

    this.apply();
  }

  /* Walking inside the hull.
   *
   * Movement is planar and yaw-only, so looking up at the deckhead does not drive
   * you into it. Collision is evaluated in the hull's own coordinates, which is
   * the reason the boat is placed with a pure translation and no rotation: the
   * whole containment test is two clamps and no matrix inversion.
   */
  _walk(dt) {
    const k = this.keys;
    // Local frame: hull Z is forward, so local = world - origin.
    const p = this.pos.clone().sub(this.walkOrigin);

    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    /* Derived by cross product, exactly as the swim path does it.
     *
     * This was hand-written as (fwd.z, 0, -fwd.x), which is the negative of
     * cross(fwd, up) = (-fwd.z, 0, fwd.x) — so A and D were swapped, and only
     * while walking. Two movement paths that disagree about which way is right is
     * worse than either being wrong, because the error appears and disappears as
     * the player changes mode and reads as the game being broken rather than as
     * a control preference. Compute it; never transcribe it. */
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const wish = new THREE.Vector3();
    if (k.has('KeyW')) wish.add(fwd);
    if (k.has('KeyS')) wish.sub(fwd);
    if (k.has('KeyD')) wish.add(right);
    if (k.has('KeyA')) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize();
    const spd = this.walkSpeed * (k.has('ShiftLeft') ? 1.7 : 1.0);

    p.x += wish.x * spd * dt;
    p.z += wish.z * spd * dt;

    /* Gravity, and a floor that is a deck rather than terrain.
     *
     * Kept as real integration rather than snapping to the deck, because the step
     * over each bulkhead coaming is a small fall, and a snap makes that read as a
     * teleport instead of a footfall. */
    this.vy -= this.gravity * dt;
    let feet = p.y - this.eyeH;
    feet += this.vy * dt;
    if (feet <= this.deckY) { feet = this.deckY; this.vy = 0; this.grounded = true; }
    else this.grounded = false;
    if (this.grounded && k.has('Space')) this.vy = 4.4;
    p.y = feet + this.eyeH;

    // Containment: the hull narrows fore and aft, so the limit is a function of
    // where you are, not a constant.
    p.z = Math.max(-this.halfLen, Math.min(this.halfLen, p.z));
    const hw = this.walkBounds ? this.walkBounds(p.z, p.y - 0.9) : 1.9;
    const lim = Math.max(0.25, hw - 0.34);
    p.x = Math.max(-lim, Math.min(lim, p.x));

    /* Push out of the furniture, along the shallowest axis.
     *
     * Resolving on the axis of least penetration is what makes this feel like
     * bumping a locker rather than being grabbed by it: walk into a face and you
     * stop, clip a corner and you slide off it. Vertical overlaps resolve upward
     * only when the box is low enough to be a step, so a console stops you but a
     * coaming is something you walk over. */
    const R = 0.34, H = this.eyeH;
    for (const b of this.solids) {
      const cx = Math.max(b.min[0], Math.min(p.x, b.max[0]));
      const cz = Math.max(b.min[2], Math.min(p.z, b.max[2]));
      const dx = p.x - cx, dz = p.z - cz;
      const horiz = Math.hypot(dx, dz);
      const feetY = p.y - H;
      // Only collide if the body's vertical span overlaps the box at all.
      if (feetY > b.max[1] - 0.02 || feetY + H < b.min[1]) continue;
      if (horiz >= R) continue;

      // Low enough to step onto? Then stand on it instead of being blocked.
      if (b.max[1] - feetY < 0.42 && this.vy <= 0.01) {
        p.y = b.max[1] + H; this.vy = 0; this.grounded = true;
        continue;
      }
      if (horiz > 1e-4) {
        const push = (R - horiz) / horiz;
        p.x += dx * push; p.z += dz * push;
      } else {
        // Dead centre of a box: eject along the shallowest face.
        const ox = Math.min(p.x - b.min[0], b.max[0] - p.x);
        const oz = Math.min(p.z - b.min[2], b.max[2] - p.z);
        if (ox < oz) p.x += (p.x < (b.min[0] + b.max[0]) / 2 ? -1 : 1) * (ox + R);
        else p.z += (p.z < (b.min[2] + b.max[2]) / 2 ? -1 : 1) * (oz + R);
      }
    }

    this.pos.copy(p).add(this.walkOrigin);
    this.vel.set(wish.x * spd, this.vy, wish.z * spd);
    this.apply();
  }

  get speed() { return this.vel.length(); }
}
