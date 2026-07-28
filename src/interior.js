import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { Welder } from './structures.js';
import { loftInto, fairStations } from './loft.js';
import { seabedHeight } from './terrain.js';

/* A submersible you walk around inside.
 *
 * The previous cockpit was a shell glued to the camera — correct as a windscreen,
 * useless as a place. You could not leave the seat, so the vehicle had no
 * interior, only a frame around the view.
 *
 * This is a volume: eighteen metres of pressure hull with a deck through it,
 * three compartments, and a helm at the bow. That distinction is the whole
 * reason SOMA's stations work. A cockpit tells you that you are piloting. Rooms
 * tell you that you are somewhere — and somewhere is what you can be trapped in.
 *
 * Built inside-out with the loft's flip option, so the skin's normals face the
 * cabin and the interior lamps light the room rather than the ocean.
 *
 * Local space: Z runs bow-positive along the hull, Y up from the hull axis, deck
 * at DECK_Y. World placement is a pure translation, which keeps the walking
 * collision arithmetic in the hull's own frame with no matrices involved.
 */

const I_HULL = 0.0;   // painted interior plate between the frames
const I_DECK = 1.0;   // deck grating
const I_TRIM = 2.0;   // frames, rails, ladder, fittings
const I_GAUGE = 3.0;   // instrument faces
const I_ACRYL = 4.0;   // the bow port
const I_LOCK = 5.0;   // lockers and equipment cases

export const HULL_LEN = 9.0;      // half-length: z from -9 to +9
export const HULL_R = 2.35;      // interior radius at the widest
export const DECK_Y = -1.05;     // deck plane, below the hull axis
export const DECK_HALF = 1.95;   // deck half-width
export const EYE = 1.62;         // standing eye height above the deck
export const HELM = { z: 6.9, y: DECK_Y + 1.18 };   // seated eye at the helm

/** Interior half-width available at a given z and height — the walkable envelope. */
export function hullHalfWidth(z, y) {
  const t = Math.min(1, Math.abs(z) / HULL_LEN);
  // Ends taper, so the walkable width closes toward bow and stern.
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(t, 3.2)));
  const dy = y - 0.0;
  const inner = r * r - dy * dy;
  return inner <= 0 ? 0 : Math.min(DECK_HALF, Math.sqrt(inner));
}

function interiorMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uPressure: { value: 1 },
      uAlarm: { value: 0 },
      uLamps: { value: 1 },
      uEye: { value: new THREE.Vector3() },   // camera in hull-local space
    },
    vertexShader: /* glsl */`
      attribute float aMat; attribute float aWear; attribute vec2 aUV;
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear; varying vec2 vUV;
      void main(){
        vP = position; vN = normalize(normal);
        vMat = aMat; vWear = aWear; vUV = aUV;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear; varying vec2 vUV;
      uniform float uTime, uPressure, uAlarm, uLamps;
      uniform vec3 uEye;

      void main(){
        vec3 col; float emis = 0.0;
        float dist = length(uEye - vP);
        float fine = exp(-dist * 0.30);

        if (vMat > 2.5 && vMat < 3.5) {
          // Instrument face. Needle driven by the real pressure, as before.
          vec2 q = vUV * 2.0 - 1.0;
          if (length(q) > 1.0) discard;
          col = vec3(0.028, 0.032, 0.034);
          float ang = atan(q.y, q.x), r = length(q);
          float ticks = abs(fract((ang + 3.14159)/6.2832 * 24.0) - 0.5) * 2.0;
          col += vec3(0.28,0.32,0.31) * smoothstep(0.86,0.98,ticks) * smoothstep(0.62,0.72,r) * (1.0-smoothstep(0.88,0.96,r));
          float frac = clamp(uPressure / 620.0, 0.0, 1.05);
          float na = -2.356 + frac * 4.712;
          vec2 nd = vec2(cos(na), sin(na));
          float across = abs(q.x*nd.y - q.y*nd.x), along = dot(q, nd);
          float needle = (along > -0.06 && along < 0.82) ? smoothstep(0.055,0.012,across) : 0.0;
          col += mix(vec3(0.85,0.86,0.82), vec3(1.0,0.28,0.16), smoothstep(0.72,1.0,frac)) * needle * 1.6;
          emis = 0.9;

        } else if (vMat > 3.5 && vMat < 4.5) {
          // The bow port, from the inside: mostly clear, scuffed at the rim.
          col = vec3(0.030, 0.052, 0.050) * (0.6 + 0.8 * fbm(vUV * 22.0, 3));
          emis = 0.05;

        } else if (vMat > 4.5) {
          // Equipment cases: painted, chipped along every edge people knock.
          float chip = fbm(vUV * 7.0, 3);
          col = mix(vec3(0.088, 0.096, 0.092), vec3(0.150, 0.140, 0.122), smoothstep(0.55,0.85,chip));

        } else if (vMat > 0.5 && vMat < 1.5) {
          /* Deck grating, in deck coordinates.
           *
           * Directional, and running fore-and-aft the way a real deck is laid, so
           * walking along the boat reads as travelling over a surface rather than
           * sliding across a texture. */
          float slot = abs(fract(vUV.x * 22.0) - 0.5) * 2.0;
          float rod  = abs(fract(vUV.y * 4.0) - 0.5) * 2.0;
          float solid = max(smoothstep(0.30,0.60,slot), smoothstep(0.82,0.95,rod));
          col = vec3(0.072, 0.076, 0.074) * (0.22 + 0.95 * solid);
          // Wear polish down the centreline: this is where everyone walks.
          col *= 1.0 + 0.55 * exp(-abs(vP.x) * 1.6) * fine;

        } else if (vMat > 1.5 && vMat < 2.5) {
          col = vec3(0.118, 0.120, 0.124) * (0.82 + 0.40 * fbm(vUV * 8.0, 2));

        } else {
          /* Painted hull plate. Condensation and rust streaks run downward,
           * because water condenses on cold steel and runs — which is also the
           * cheapest way to tell the eye which way is up in a curved room. */
          float grime = fbm(vUV * vec2(3.0, 9.0), 3);
          vec3 paint = vec3(0.100, 0.106, 0.102);
          vec3 rust  = vec3(0.118, 0.070, 0.044);
          float low = smoothstep(0.6, -0.6, vP.y);
          col = mix(paint, rust, smoothstep(0.52, 0.88, grime) * (0.35 + 0.55*low));
          col *= 0.86 + 0.28 * fbm(vUV * 24.0, 2) * fine;
        }

        /* Three deckhead lamps down the centreline, plus the alarm.
         *
         * Spaced so there are pools of light and darkness between them. A room
         * lit evenly has no depth and nowhere to be afraid of; the gaps are the
         * point, and they are what makes an eighteen-metre hull feel long. */
        vec3 lit = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec3 lp = vec3(0.0, 1.55, -5.2 + float(i) * 5.6);
          vec3 d = lp - vP;
          float dd = length(d);
          float ndl = max(dot(vN, d / max(dd,1e-4)), 0.0) * 0.72 + 0.28;
          /* Twenty-two, not 2.4, and the factor of ten is not a fudge.
         *
         * These are cabin lamps competing with an exposure that the ocean sets:
         * at four hundred metres the auto-exposure opens to roughly 1.9, which is
         * tuned for a lamp pool outside, not for a lit room. An interior lit to a
         * physically sensible 0.05 lands below the tone curve's toe and comes out
         * as the same near-black as the water. The room has to be genuinely bright
         * for the exposure the rest of the game is using. */
          lit += col * vec3(1.0, 0.88, 0.70) * uLamps * ndl * (6.2 / (0.85 + dd*dd));
        }
        vec3 rp = vec3(0.0, 1.35, 3.4);
        vec3 rd = rp - vP; float rdd = length(rd);
        float rn = max(dot(vN, rd / max(rdd,1e-4)), 0.0) * 0.7 + 0.3;
        float throb = 0.55 + 0.45 * sin(uTime * 2.1);
        lit += col * vec3(1.0, 0.09, 0.05) * uAlarm * throb * rn * (3.4 / (0.85 + rdd*rdd));

/* A flat bounce term. Not physically motivated — it stands in for the light
         * that has bounced off the deck and the far wall, which nothing here
         * computes. Without it, every surface facing away from all three lamps is
         * pure black, and a steel tube lit by three point sources and nothing else
         * reads as a cave rather than a room. */
        lit += col * vec3(0.075, 0.080, 0.086);
        lit += col * emis * 2.2;
        gl_FragColor = vec4(lit, 0.0);   // alpha 0: interior is exempt from defocus
      }`,
  });
}

/** Deck plate with fore-and-aft grating, plus its side curbs. */
function deck(W) {
  const segs = 26;
  for (let i = 0; i < segs; i++) {
    const z0 = -HULL_LEN + (i / segs) * HULL_LEN * 2;
    const z1 = -HULL_LEN + ((i + 1) / segs) * HULL_LEN * 2;
    const w0 = hullHalfWidth(z0, DECK_Y), w1 = hullHalfWidth(z1, DECK_Y);
    if (w0 < 0.2 || w1 < 0.2) continue;
    const base = W.v;
    W._push(-w0, DECK_Y, z0, 0, 1, 0, I_DECK, 0.5, -w0, z0);
    W._push(w0, DECK_Y, z0, 0, 1, 0, I_DECK, 0.5, w0, z0);
    W._push(w1, DECK_Y, z1, 0, 1, 0, I_DECK, 0.5, w1, z1);
    W._push(-w1, DECK_Y, z1, 0, 1, 0, I_DECK, 0.5, -w1, z1);
    W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // Curbs where the deck meets the curve of the hull.
    for (const s of [-1, 1]) {
      W.box(s * (w0 + 0.04), DECK_Y + 0.09, (z0 + z1) / 2, 0.08, 0.18, (z1 - z0), 0, I_TRIM, 0.6);
    }
  }
}

/** Ring frame against the hull: the ribs a pressure hull is built around. */
function frame(W, z) {
  const seg = 34;
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(z) / HULL_LEN, 3.2))) - 0.03;
  for (let i = 0; i < seg; i++) {
    const a0 = -0.25 + (i / seg) * (Math.PI + 0.5);
    const a1 = -0.25 + ((i + 1) / seg) * (Math.PI + 0.5);
    W.tube(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z,
      0.055, 8, I_TRIM, 0.6);
  }
}

/** Bulkhead with a doorway: what makes three compartments out of one tube. */
function bulkhead(W, z, doorW = 0.82, doorH = 1.95) {
  const seg = 30;
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(z) / HULL_LEN, 3.2)));
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    for (const [aa, bb] of [[a0, a1]]) {
      const p0 = [Math.cos(aa) * r, Math.sin(aa) * r];
      const p1 = [Math.cos(bb) * r, Math.sin(bb) * r];
      // Skip the wedge the doorway occupies.
      const inDoor = (p) => Math.abs(p[0]) < doorW / 2 && p[1] > DECK_Y && p[1] < DECK_Y + doorH;
      if (inDoor(p0) && inDoor(p1)) continue;
      const base = W.v;
      W._push(p0[0], p0[1], z, 0, 0, 1, I_HULL, 0.6, p0[0], p0[1]);
      W._push(p1[0], p1[1], z, 0, 0, 1, I_HULL, 0.6, p1[0], p1[1]);
      W._push(p1[0] * 0.30, Math.max(p1[1] * 0.30, DECK_Y + doorH), z, 0, 0, 1, I_HULL, 0.6, 0, 0);
      W._push(p0[0] * 0.30, Math.max(p0[1] * 0.30, DECK_Y + doorH), z, 0, 0, 1, I_HULL, 0.6, 0, 0);
      W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  // Door frame: the coaming you step over.
  W.box(0, DECK_Y + 0.09, z, doorW + 0.22, 0.18, 0.14, 0, I_TRIM, 0.7);
  W.box(0, DECK_Y + doorH, z, doorW + 0.22, 0.12, 0.14, 0, I_TRIM, 0.7);
  for (const s of [-1, 1]) {
    W.box(s * (doorW / 2 + 0.07), DECK_Y + doorH / 2, z, 0.12, doorH, 0.14, 0, I_TRIM, 0.7);
  }
}

/* Solid volumes, in hull-local space.
 *
 * The first version collided with exactly two things: the deck, and the curve of
 * the hull. Everything else — both bulkheads, every locker, the console, the seat
 * — was scenery you walked straight through, which is worse than having no
 * furniture at all: it tells the player the room is a painting.
 *
 * Boxes rather than the real triangles, on purpose. A mesh collider against
 * twenty-three thousand triangles for a walking player is a great deal of work
 * to arrive at the same answer a dozen boxes give, and the boxes can be derived
 * from the same constants that place the geometry, so they cannot drift out of
 * agreement with what is drawn. */
export function interiorSolids() {
  const s = [];
  const box = (x, y, z, sx, sy, sz) => s.push({
    min: [x - sx / 2, y - sy / 2, z - sz / 2],
    max: [x + sx / 2, y + sy / 2, z + sz / 2],
  });

  // Bulkheads: two cheeks and a lintel, leaving the doorway open.
  for (const z of [-2.6, 4.4]) {
    const doorW = 0.82, doorH = 1.95;
    box(-1.55, DECK_Y + 1.4, z, 2.0, 2.8, 0.30);
    box(1.55, DECK_Y + 1.4, z, 2.0, 2.8, 0.30);
    box(0, DECK_Y + doorH + 0.45, z, doorW + 0.4, 0.9, 0.30);
  }
  // Lockers down both sides.
  for (const side of [-1, 1]) {
    for (const z of [-6.6, -5.0, 0.6, 2.2]) box(side * 1.62, DECK_Y + 0.62, z, 0.46, 1.30, 1.20);
  }
  // Helm console, its front, and the seat.
  box(0, DECK_Y + 0.78, 7.55, 2.05, 0.20, 0.76);
  box(0, DECK_Y + 0.40, 7.86, 2.05, 0.84, 0.18);
  box(0, DECK_Y + 0.30, 6.55, 0.66, 0.70, 0.62);
  // Ladder well: stops you standing in the rungs.
  box(0, DECK_Y + 1.0, -1.5, 0.62, 2.2, 0.20);
  return s;
}

export function buildInterior() {
  const W = new Welder();

  /* The pressure hull, inside out. Sections taper at both ends so the space
   * narrows toward the helm and the machinery, which is what stops an eighteen
   * metre tube reading as a corridor with no shape. */
  const control = [
    { z: -HULL_LEN - 0.4, w: 0.5, h: 0.5, sq: 2.0 },
    { z: -HULL_LEN + 1.6, w: 3.5, h: 3.4, sq: 2.4 },
    { z: -3.5, w: 4.66, h: 4.6, sq: 2.5 },
    { z: 2.0, w: 4.70, h: 4.66, sq: 2.4 },
    { z: 6.2, w: 4.10, h: 4.00, sq: 2.2 },
    { z: HULL_LEN - 0.5, w: 2.30, h: 2.20, sq: 1.9 },
    { z: HULL_LEN + 0.5, w: 0.4, h: 0.4, sq: 1.8 },
  ];
  loftInto(W, fairStations(control, 46), {
    count: 54, mat: I_HULL, wear: 0.6, flip: true, capBow: false, capStern: false,
  });

  deck(W);
  for (const z of [-7.4, -5.6, -3.8, -0.4, 1.4, 3.2, 5.0, 6.6]) frame(W, z);
  bulkhead(W, -2.6);
  bulkhead(W, 4.4);

  /* The bow port, and it is the reason the boat is worth walking to the front of.
   * A ring of acrylic set into the tapering nose, so the helm looks straight out
   * into the water the rest of the game happens in. */
  const PZ = HULL_LEN - 0.55;
  W.tube(0, 0.10, PZ, 0, 0.10, PZ + 0.06, 0.92, 60, I_ACRYL, 0.3);
  W.tube(0, 0.10, PZ - 0.05, 0, 0.10, PZ + 0.02, 0.98, 60, I_TRIM, 0.5);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    W.box(Math.cos(a) * 1.02, 0.10 + Math.sin(a) * 1.02, PZ - 0.02, 0.05, 0.05, 0.05, a, I_TRIM, 0.6);
  }

  /* Helm: a console across the bow, a seat, and three dials that read the
   * simulation. Placed so a standing player can reach it and a seated one is
   * looking straight through the port. */
  W.box(0, DECK_Y + 0.78, 7.55, 2.05, 0.14, 0.72, 0, I_LOCK, 0.6);
  W.box(0, DECK_Y + 0.38, 7.85, 2.05, 0.80, 0.14, 0, I_LOCK, 0.55);
  for (const gx of [-0.52, 0.0, 0.52]) {
    const seg = 24, r = 0.14;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c = W._push(gx, DECK_Y + 0.855, 7.55, 0, 1, 0, I_GAUGE, 0.2, 0.5, 0.5);
      const p = (a) => W._push(gx + Math.cos(a) * r, DECK_Y + 0.855, 7.55 + Math.sin(a) * r,
        0, 1, 0, I_GAUGE, 0.2, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      const v0 = p(a0), v1 = p(a1);
      W.idx.push(c, v1, v0);
    }
    W.tube(gx, DECK_Y + 0.848, 7.55, gx, DECK_Y + 0.868, 7.55, r * 1.12, 26, I_TRIM, 0.5);
  }
  // Seat.
  W.box(0, DECK_Y + 0.44, 6.55, 0.62, 0.10, 0.58, 0, I_LOCK, 0.7);
  W.box(0, DECK_Y + 0.78, 6.28, 0.62, 0.70, 0.10, 0, I_LOCK, 0.7);
  W.tube(0, DECK_Y, 6.55, 0, DECK_Y + 0.40, 6.55, 0.07, 12, I_TRIM, 0.6);

  /* Fit-out along the walls. This is where a hull stops being a tube: lockers,
   * pipe runs and cable trays give the eye something at every distance, and they
   * are what a real boat is mostly made of. */
  for (const s of [-1, 1]) {
    for (const z of [-6.6, -5.0, 0.6, 2.2]) {
      W.box(s * 1.62, DECK_Y + 0.62, z, 0.42, 1.24, 1.15, 0, I_LOCK, 0.6);
      W.box(s * 1.40, DECK_Y + 1.05, z, 0.06, 0.05, 0.9, 0, I_TRIM, 0.5);
    }
    // Pipe runs at shoulder height, following the hull curve.
    for (const [r, yy] of [[1.94, 0.62], [2.02, 0.95]]) {
      W.tube(s * r, yy, -HULL_LEN + 1.2, s * r, yy, HULL_LEN - 1.4, 0.075, 12, I_TRIM, 0.65);
    }
    // Cable tray under them.
    W.box(s * 1.86, 0.30, 0, 0.16, 0.10, HULL_LEN * 1.7, 0, I_TRIM, 0.7);
  }

  // Ladder to the top hatch, amidships.
  for (let i = 0; i < 9; i++) {
    const y = DECK_Y + 0.25 + i * 0.28;
    W.tube(-0.24, y, -1.5, 0.24, y, -1.5, 0.022, 8, I_TRIM, 0.55);
  }
  for (const s of [-1, 1]) {
    W.tube(s * 0.26, DECK_Y + 0.2, -1.5, s * 0.26, 1.85, -1.5, 0.030, 10, I_TRIM, 0.55);
  }
  W.tube(0, 2.02, -1.5, 0, 2.14, -1.5, 0.42, 30, I_TRIM, 0.6);

  // Deckhead lamp housings, so the light comes from something visible.
  for (const z of [-5.2, 0.4, 6.0]) {
    W.tube(0, 1.62, z - 0.20, 0, 1.62, z + 0.20, 0.09, 16, I_TRIM, 0.5);
  }
  W.tube(0, 1.42, 3.4, 0, 1.42, 3.52, 0.06, 12, I_TRIM, 0.6);

  const mesh = new THREE.Mesh(W.geometry(), interiorMaterial());
  mesh.frustumCulled = false;
  mesh.name = 'interior';

  /* Sit the boat on the canyon floor. A pure translation, deliberately: walking
   * collision then works directly in hull coordinates with no inverse transform
   * anywhere in the movement code. */
  const ox = 74, oz = 8;
  const oy = seabedHeight(ox, oz) + 2.5;
  mesh.position.set(ox, oy, oz);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);

  return {
    mesh,
    mat: mesh.material,
    origin: new THREE.Vector3(ox, oy, oz),
    deckY: DECK_Y,
    helm: HELM,
  };
}
