import * as THREE from 'three';
import { HULL_LEN, HULL_R, DECK_Y, DECK_HALF, EYE, HELM } from './hull.js';

/* Fit-out: everything inside the pressure hull that is not the hull.
 *
 * Split out of interior.js for one reason that is not tidiness. The complaint
 * was that the compartments read as large flat planes, and the fix has two
 * halves that fail in different ways: the *surface* needs relief at the
 * millimetre scale, and the *volume* needs objects at every distance. Mixing
 * them in one file made it impossible to tell which half was underweight.
 *
 * "Fit-out" is the shipyard's own word for it: the hull is finished as a
 * structure long before anyone can live in it, and the difference between the
 * two states is exactly what this file adds.
 *
 * ---------------------------------------------------------------------------
 * The rule that decides geometry from shading, and it is arithmetic
 *
 * The camera is 62 degrees vertical over 720 px, so a feature of size s at
 * distance d covers  s/d * 599  pixels. Inside a boat the player stands one to
 * three metres from everything:
 *
 *     12 mm bolt head at 0.8 m  ->  9 px      readable, and there are hundreds
 *     12 mm bolt head at 3.0 m  ->  2.4 px    below the aliasing floor
 *     40 cm locker handle at 2 m -> 120 px    unmissable
 *
 * So: anything above about 1.5 cm is geometry, anything below is a height field
 * in the shader, and the shader's fine bands must fade out with distance or
 * they alias into crawling static — the same discipline the seabed already
 * uses, and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * Collision comes from the same numbers as the geometry
 *
 * The previous fit-out was scenery: two bulkheads, every locker, the console and
 * the seat were all walk-through, which tells the player the room is a painting.
 * Every builder here takes a `Fit`, and `Fit.sbox` emits the mesh and the
 * collision box from one call with one set of dimensions. They cannot drift
 * apart, because there is only one of them.
 */

const TAU = Math.PI * 2;

/* Material ids, carried per-vertex and branched on in the interior shader.
 *
 * These live here rather than in interior.js because the furniture is what
 * needs most of them, and a cycle between the two modules is worth avoiding. */
export const I = {
  HULL: 0,    // painted pressure-hull plate, cylindrical chart
  DECK: 1,    // deck grating
  TRIM: 2,    // frames, rails, ladder, pipework, fittings
  GAUGE: 3,   // analogue instrument faces
  ACRYL: 4,   // the bow port
  LOCK: 5,    // painted equipment cases and cabinets
  BULK: 6,    // flat bulkhead plate, XY chart
  FABRIC: 7,  // mattresses, blankets, canvas, clothing
  SCREEN: 8,  // sonar and CRT faces, emissive
  PANEL: 9,   // switchboards: breaker rows and indicator lamps
  DECAL: 10,  // atlas-mapped stencils, placards, charts, photographs
  BRASS: 11,  // valve wheels and copper lines — the only warm metal aboard
};

/* Hull geometry. Everything else is derived from these five numbers, and they
 * now live in `hull.js` — a file with no imports at all, so that a module
 * without a renderer can ask how big the boat is without inheriting `three`.
 * Re-exported here because half the project already imports them from this
 * file and there is no reason to make it stop. */
export { HULL_LEN, HULL_R, DECK_Y, DECK_HALF, EYE, HELM };

/**
 * Unclamped interior half-width of the shell at (z, y), in metres.
 *
 * The single source of truth for where the wall is. The walking bound clamps
 * this to the deck; the furniture does not, because a locker's bottom edge can
 * legitimately sit further out than the deck plate does — that is what the
 * curb is for. Placing furniture against a hardcoded x is how you get cabinets
 * floating in the tapered ends.
 */
export function shellX(z, y) {
  const t = Math.min(1, Math.abs(z) / HULL_LEN);
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(t, 3.2)));
  const inner = r * r - y * y;
  return inner <= 0 ? 0 : Math.sqrt(inner);
}

/** Outer face x for something standing on the deck at side s (+1 stbd, -1 port). */
export function standX(z, s) {
  return s * Math.min(DECK_HALF + 0.10, shellX(z, DECK_Y + 0.06));
}

/* ------------------------------------------------------------------ decals
 *
 * A canvas drawn at boot, not a downloaded image — the project's no-assets rule
 * is about shipping files, not about pixels. Text is the reason: procedural
 * GLSL can produce convincing steel all day and cannot produce the word BILGE,
 * and a stencilled word is the cheapest thing in this entire file that says a
 * human being worked here. Everything with a legible edge — compartment
 * numbers, valve tags, the chart, the photograph over the bunk — comes from
 * this one 1024 texture.
 */
const CELL = 128;
const ATLAS_W = 1024, ATLAS_H = 1024;
const rects = new Map();

function cellRect(col, row, cw = 1, ch = 1) {
  return [
    (col * CELL) / ATLAS_W, (row * CELL) / ATLAS_H,
    ((col + cw) * CELL) / ATLAS_W, ((row + ch) * CELL) / ATLAS_H,
  ];
}

/** UV rectangle of a named decal: [u0, v0, u1, v1]. */
export function decal(name) {
  return rects.get(name) || rects.get('PLATE');
}

export function buildDecalAtlas() {
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext('2d');

  // Transparent ground: a decal is paint on steel, not a sticker with a border.
  g.clearRect(0, 0, ATLAS_W, ATLAS_H);

  /* Stencil lettering, drawn with gaps in the strokes.
   *
   * Real stencils have bridges — the plate has to hold together, so an O is
   * never closed. Faking that with two overdrawn slots is the whole difference
   * between "stencilled on with a brush" and "printed in a word processor". */
  const stencil = (col, row, text, colour = '#d8d3c4', size = 54) => {
    const [u0, v0] = cellRect(col, row);
    const x = u0 * ATLAS_W, y = v0 * ATLAS_H;
    g.save();
    g.translate(x + CELL / 2, y + CELL / 2);
    g.fillStyle = colour;
    g.font = `bold ${size}px "DejaVu Sans Mono", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = text.split('\n');
    const lh = size * 1.02;
    lines.forEach((ln, i) => g.fillText(ln, 0, (i - (lines.length - 1) / 2) * lh));
    /* Bridges: two horizontal cuts through the glyphs — and they have to scale
     * with the type.
     *
     * Fixed at four pixels they removed most of a 38 px two-line label, so the
     * H.P. AIR plate on the air bottles rendered as a blank white square: the
     * plate was legible, the word on it was not. Proportional cuts keep the
     * stencil read at every size in the sheet. */
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    const cut = Math.max(1.6, size * 0.042);
    for (const fy of [-0.20, 0.24]) g.fillRect(-CELL / 2, fy * size - cut / 2, CELL, cut);
    g.restore();
    g.globalCompositeOperation = 'source-over';
  };

  const labels = [
    ['ONE', '1'], ['TWO', '2'], ['THREE', '3'],
    ['CO2', 'CO2'], ['FIRE', 'FIRE'], ['BILGE', 'BILGE'],
    ['TRIM', 'TRIM'], ['BALLAST', 'BAL\nLAST'], ['HPAIR', 'H.P.\nAIR'],
    ['O2', 'O2'], ['SCRUB', 'SCR\nUB'], ['PUMP', 'PUMP'],
    ['MAIN', 'MAIN'], ['VENT', 'VENT'], ['SHUT', 'SHUT'], ['OPEN', 'OPEN'],
  ];
  labels.forEach(([name, text], i) => {
    const col = i % 8, row = (i / 8) | 0;
    stencil(col, row, text, '#d8d3c4', text.includes('\n') ? 38 : 52);
    rects.set(name, cellRect(col, row));
  });

  // Warning chevrons: black and amber, the universal "this will hurt you".
  {
    const col = 0, row = 2;
    const [u0, v0] = cellRect(col, row);
    const x = u0 * ATLAS_W, y = v0 * ATLAS_H;
    g.save(); g.beginPath(); g.rect(x, y, CELL, CELL); g.clip();
    g.fillStyle = '#b8912c'; g.fillRect(x, y, CELL, CELL);
    g.fillStyle = '#161412';
    for (let i = -2; i < 6; i++) {
      g.beginPath();
      g.moveTo(x + i * 32, y); g.lineTo(x + i * 32 + 16, y);
      g.lineTo(x + i * 32 + 16 + CELL, y + CELL); g.lineTo(x + i * 32 + CELL, y + CELL);
      g.closePath(); g.fill();
    }
    g.restore();
    rects.set('HAZARD', cellRect(col, row));
  }

  // Medical cross: the only pure white thing in the boat, so it reads instantly.
  {
    const col = 1, row = 2;
    const [u0, v0] = cellRect(col, row);
    const x = u0 * ATLAS_W, y = v0 * ATLAS_H;
    g.fillStyle = '#cfd6d2';
    g.fillRect(x + 50, y + 20, 28, 88);
    g.fillRect(x + 20, y + 50, 88, 28);
    rects.set('MEDCROSS', cellRect(col, row));
  }

  // A blank painted placard, used as the fallback and as a backing plate.
  {
    const col = 2, row = 2;
    const [u0, v0] = cellRect(col, row);
    g.fillStyle = 'rgba(150,150,140,0.16)';
    g.fillRect(u0 * ATLAS_W + 8, v0 * ATLAS_H + 8, CELL - 16, CELL - 16);
    rects.set('PLATE', cellRect(col, row));
  }

  /* The chart. Four cells square, and worth every one of them.
   *
   * A chart is the one object aboard that states where you are and how deep it
   * gets, so it carries plot without a line of dialogue. Contours from summed
   * sines rather than noise, because a bathymetric chart's lines are nested and
   * never cross — a noise field's isolines do both, and the eye knows. */
  {
    const col = 0, row = 4, span = 4;
    const [u0, v0] = cellRect(col, row, span, span);
    const x0 = u0 * ATLAS_W, y0 = v0 * ATLAS_H, S = CELL * span;
    g.save();
    g.beginPath(); g.rect(x0, y0, S, S); g.clip();
    g.fillStyle = '#c9c2a8'; g.fillRect(x0, y0, S, S);   // aged paper

    const depth = (px, py) => {
      const u = px / S, v = py / S;
      return Math.sin(u * 5.1 + 0.7) * 0.5 + Math.sin(v * 3.7 - 1.2) * 0.42
        + Math.sin((u + v) * 6.3) * 0.18 + Math.sin((u - v) * 9.1) * 0.09;
    };
    // Nested isolines, marched on a coarse grid — cheap and topologically sane.
    for (let lvl = -10; lvl <= 10; lvl++) {
      const L = lvl * 0.11;
      g.beginPath();
      for (let py = 0; py < S; py += 3) {
        for (let px = 0; px < S; px += 3) {
          const d = depth(px, py);
          if (Math.abs(d - L) < 0.011) { g.moveTo(x0 + px, y0 + py); g.lineTo(x0 + px + 2.2, y0 + py + 2.2); }
        }
      }
      g.strokeStyle = lvl % 5 === 0 ? 'rgba(58,74,86,0.85)' : 'rgba(96,112,120,0.55)';
      g.lineWidth = lvl % 5 === 0 ? 2.0 : 1.1;
      g.stroke();
    }
    // Soundings, a compass rose and a hand-drawn track line.
    g.fillStyle = 'rgba(40,54,64,0.7)';
    g.font = '13px "DejaVu Sans Mono", monospace';
    for (let i = 0; i < 90; i++) {
      const px = ((i * 137.5) % S), py = ((i * 71.3) % S);
      g.fillText(String(60 + ((i * 37) % 380)), x0 + px, y0 + py);
    }
    g.strokeStyle = 'rgba(40,54,64,0.75)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(x0 + S * 0.74, y0 + S * 0.26, S * 0.13, 0, TAU); g.stroke();
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU, r0 = S * 0.13, r1 = i % 4 === 0 ? S * 0.09 : S * 0.115;
      g.moveTo(x0 + S * 0.74 + Math.cos(a) * r0, y0 + S * 0.26 + Math.sin(a) * r0);
      g.lineTo(x0 + S * 0.74 + Math.cos(a) * r1, y0 + S * 0.26 + Math.sin(a) * r1);
    }
    g.stroke();
    g.strokeStyle = 'rgba(150,40,30,0.8)'; g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(x0 + S * 0.12, y0 + S * 0.86);
    g.lineTo(x0 + S * 0.38, y0 + S * 0.62);
    g.lineTo(x0 + S * 0.55, y0 + S * 0.55);
    g.lineTo(x0 + S * 0.79, y0 + S * 0.34);
    g.stroke();
    // The last leg, dashed: a course intended rather than run.
    g.setLineDash([9, 7]);
    g.beginPath();
    g.moveTo(x0 + S * 0.79, y0 + S * 0.34);
    g.lineTo(x0 + S * 0.93, y0 + S * 0.13);
    g.stroke();
    g.setLineDash([]);
    g.restore();
    rects.set('CHART', cellRect(col, row, span, span));
  }

  /* A photograph, taped up beside the lower bunk.
   *
   * Deliberately unreadable: two figures on a bright shore, over-exposed and
   * out of focus. Draw faces and it becomes a specific story that competes with
   * the player's; leave it as light and shape and it is only "someone had a
   * life before this", which is the whole of what the frame needs to say. */
  {
    const col = 4, row = 4, span = 2;
    const [u0, v0] = cellRect(col, row, span, span);
    const x0 = u0 * ATLAS_W, y0 = v0 * ATLAS_H, S = CELL * span;
    g.save(); g.beginPath(); g.rect(x0, y0, S, S); g.clip();
    const sky = g.createLinearGradient(0, y0, 0, y0 + S);
    sky.addColorStop(0, '#cfd8d2'); sky.addColorStop(0.62, '#b9c0ae'); sky.addColorStop(1, '#8f8a72');
    g.fillStyle = sky; g.fillRect(x0, y0, S, S);
    g.fillStyle = 'rgba(52,48,42,0.55)';
    g.beginPath(); g.ellipse(x0 + S * 0.40, y0 + S * 0.70, S * 0.055, S * 0.20, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(x0 + S * 0.56, y0 + S * 0.72, S * 0.048, S * 0.17, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,252,240,0.30)'; g.fillRect(x0, y0, S, S);   // sun-bleached
    g.strokeStyle = 'rgba(240,240,232,0.85)'; g.lineWidth = 7;
    g.strokeRect(x0 + 4, y0 + 4, S - 8, S - 8);                          // print border
    g.restore();
    rects.set('PHOTO', cellRect(col, row, span, span));
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* ---------------------------------------------------------------- assembly */

/**
 * A Welder plus the collision list it is building, so the two cannot disagree.
 */
export class Fit {
  constructor(W) { this.W = W; this.solids = []; }

  solid(x, y, z, sx, sy, sz) {
    this.solids.push({
      min: [x - sx / 2, y - sy / 2, z - sz / 2],
      max: [x + sx / 2, y + sy / 2, z + sz / 2],
    });
  }

  /** Box that is also solid. One call, one set of dimensions, no drift. */
  sbox(x, y, z, sx, sy, sz, yaw = 0, m = I.LOCK, wear = 0.5) {
    this.W.box(x, y, z, sx, sy, sz, yaw, m, wear);
    // Yawed items get their axis-aligned envelope, which is what a capsule
    // sliding along a wall wants anyway.
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    this.solid(x, y, z, sx * c + sz * s, sy, sx * s + sz * c);
  }

  /** Box with no collision: too small or too high to walk into. */
  box(...a) { this.W.box(...a); }
  tube(...a) { this.W.tube(...a); }
}

/* ------------------------------------------------------------------- parts */

/** Ring of tube segments in a plane. Handwheels, port rims, hatch coamings. */
export function ring(W, cx, cy, cz, R, tr, seg, axis = 'z', m = I.TRIM, wear = 0.5) {
  const at = (a) => (
    axis === 'x' ? [cx, cy + Math.cos(a) * R, cz + Math.sin(a) * R]
      : axis === 'y' ? [cx + Math.cos(a) * R, cy, cz + Math.sin(a) * R]
        : [cx + Math.cos(a) * R, cy + Math.sin(a) * R, cz]
  );
  for (let i = 0; i < seg; i++) {
    const A = at((i / seg) * TAU), B = at(((i + 1) / seg) * TAU);
    W.tube(A[0], A[1], A[2], B[0], B[1], B[2], tr, 6, m, wear);
  }
}

/**
 * Valve handwheel: rim, four spokes, hub.
 *
 * Brass on purpose. Everything else in this hull is grey-green painted steel
 * under a cold lamp, so a handful of warm metal objects are the only things
 * that separate by hue rather than by value — and hue separation is what stops
 * a monochrome room from reading as one moulded surface.
 */
export function handwheel(W, cx, cy, cz, R, axis = 'x', stem = 0) {
  /* The spindle, and it was the most obvious fault in the whole fit-out.
   *
   * The hub was a disc four centimetres thick, so between the wheel and the
   * valve bonnet below it there was nothing at all — three brass wheels hanging
   * in mid-air over three separate lumps. A handwheel turns a stem; without the
   * stem drawn it is not a control, it is an ornament that has come loose. */
  if (stem > 0) {
    const d = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    W.tube(cx - d[0] * stem, cy - d[1] * stem, cz - d[2] * stem, cx, cy, cz,
      R * 0.14, 8, I.TRIM, 0.45);
    // A gland nut where the stem enters the bonnet: the detail that says sealed.
    W.tube(cx - d[0] * stem, cy - d[1] * stem, cz - d[2] * stem,
      cx - d[0] * stem * 0.72, cy - d[1] * stem * 0.72, cz - d[2] * stem * 0.72,
      R * 0.26, 8, I.BRASS, 0.4);
  }
  ring(W, cx, cy, cz, R, R * 0.10, 14, axis, I.BRASS, 0.35);
  const at = (a, r) => (
    axis === 'x' ? [cx, cy + Math.cos(a) * r, cz + Math.sin(a) * r]
      : axis === 'y' ? [cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]
        : [cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz]
  );
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    const A = at(a, R * 0.92);
    W.tube(cx, cy, cz, A[0], A[1], A[2], R * 0.065, 5, I.BRASS, 0.4);
  }
  const h = axis === 'x' ? [R * 0.16, 0, 0] : axis === 'y' ? [0, R * 0.16, 0] : [0, 0, R * 0.16];
  W.tube(cx - h[0], cy - h[1], cz - h[2], cx + h[0], cy + h[1], cz + h[2], R * 0.20, 8, I.BRASS, 0.35);
}

/** Bolted flange at a pipe joint: the detail that says the run was assembled. */
export function flange(W, x, y, z, dir, r, m = I.TRIM) {
  const t = 0.022;
  W.tube(x - dir[0] * t, y - dir[1] * t, z - dir[2] * t,
    x + dir[0] * t, y + dir[1] * t, z + dir[2] * t, r * 1.38, 12, m, 0.55);
}

/**
 * Pipe along a polyline, with flanges at the bends.
 *
 * Straight runs meeting at hard corners is what a first pass always produces
 * and it is exactly wrong: pipe is bent on a former with a radius several times
 * its own bore, so a right-angle join reads as two separate pipes. The flange
 * at each vertex is the honest fix — real pipework turns corners with a fitting,
 * and a fitting is a visible lump.
 */
export function pipeline(W, pts, r, m = I.TRIM, wear = 0.55) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    W.tube(a[0], a[1], a[2], b[0], b[1], b[2], r, 8, m, wear);
    if (i > 0) {
      const p = pts[i - 1];
      const d = [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
      const l = Math.hypot(...d) || 1;
      flange(W, a[0], a[1], a[2], [d[0] / l, d[1] / l, d[2] / l], r, m);
    }
  }
}

/**
 * Cable loom: a bundle of conductors with a real catenary between clips.
 *
 * Sag is the whole point. A cable run modelled as straight segments is a set of
 * grey rods, and grey rods are indistinguishable from structure; hang the same
 * geometry on a catenary and it is instantly the one soft thing in a hard room.
 * Cheap, too — the sag is a sine and the clips are boxes.
 */
export function loom(W, x, y, z0, z1, n = 4, r = 0.020, span = 1.25) {
  const bays = Math.max(1, Math.round(Math.abs(z1 - z0) / span));
  const STEPS = 3;   // three chords per bay is enough to read as a curve
  for (let c = 0; c < n; c++) {
    const off = (c - (n - 1) / 2) * r * 2.5;
    // Each conductor hangs a little differently, or the bundle is one fat rod.
    const sag = 0.050 + 0.018 * c;
    for (let i = 0; i < bays; i++) {
      const za = z0 + ((z1 - z0) * i) / bays;
      const zb = z0 + ((z1 - z0) * (i + 1)) / bays;
      const dip = (k) => -sag * Math.sin(Math.PI * (k / STEPS));
      for (let k = 0; k < STEPS; k++) {
        const pa = za + ((zb - za) * k) / STEPS;
        const pb = za + ((zb - za) * (k + 1)) / STEPS;
        W.tube(x + off, y + dip(k), pa, x + off, y + dip(k + 1), pb, r, 5, I.TRIM, 0.5);
      }
    }
  }
  // Clips.
  for (let i = 0; i <= bays; i++) {
    const zc = z0 + (z1 - z0) * (i / bays);
    W.box(x, y + 0.012, zc, n * r * 2.8, 0.030, 0.035, 0, I.TRIM, 0.55);
  }
}

/** Grab rail: the thing you actually hold when the boat moves. */
export function grabRail(W, x, y, z0, z1, r = 0.024) {
  W.tube(x, y, z0, x, y, z1, r, 8, I.TRIM, 0.30);   // low wear: polished by hands
  for (const z of [z0, z1]) {
    W.tube(x, y, z, x, y + 0.10, z, r * 0.7, 6, I.TRIM, 0.5);
    W.box(x, y + 0.13, z, 0.07, 0.03, 0.07, 0, I.TRIM, 0.5);
  }
}

/**
 * Cabinet: carcass, recessed door, hinges, handle, and a plinth.
 *
 * The recess is the load-bearing part. A cabinet drawn as one box has a
 * silhouette but no construction, and at a metre away that is a painted crate.
 * Setting the door back 12 mm inside its frame gives a shadow line all the way
 * round, which is the single cue that says "this opens".
 */
/* `s` is which side of the boat a fitting is mounted on: +1 starboard, -1 port.
 *
 * Its working face therefore points at the centreline, in direction `-s`, and
 * getting that sign wrong is silent: the door, the label and the indicator
 * lamps are all still drawn, just facing into the shell where the player can
 * never stand. The first pass had it inverted on nine separate fittings — the
 * switchboard, both compartment numbers, the medical cross, the photograph over
 * the bunk — and every one of them rendered as a blank grey box, which reads as
 * "not modelled yet" rather than as a bug.
 *
 * Named once, here, so it cannot be re-derived differently each time. */
const IN = (s) => -s;

export function cabinet(F, x, y, z, w, h, d, s, opts = {}) {
  const { mat = I.LOCK, wear = 0.55, doors = 1, plinth = true, vent = false } = opts;
  const W = F.W;
  const i = IN(s);
  F.sbox(x, y, z, d, h, w, 0, mat, wear);
  const face = x + i * d / 2;          // the face you can actually see
  for (let k = 0; k < doors; k++) {
    const dw = (w - 0.05 * (doors + 1)) / doors;
    const dz = z - w / 2 + 0.05 * (k + 1) + dw * (k + 0.5);
    // Door leaf, set 12 mm back into its frame. That shadow line all the way
    // round is the single cue that says this thing opens.
    W.box(face - i * 0.012, y + 0.02, dz, 0.020, h - 0.10, dw, 0, mat, wear * 0.9);
    for (const hy of [y - h * 0.32, y + h * 0.32]) {
      W.box(face + i * 0.004, hy, dz - dw / 2 + 0.02, 0.030, 0.070, 0.045, 0, I.TRIM, 0.5);
    }
    W.tube(face + i * 0.030, y + 0.02, dz + dw / 2 - 0.07,
      face + i * 0.030, y + 0.02, dz + dw / 2 - 0.16, 0.014, 6, I.TRIM, 0.35);
    for (const gz of [dw / 2 - 0.07, dw / 2 - 0.16]) {
      W.tube(face, y + 0.02, dz + gz, face + i * 0.032, y + 0.02, dz + gz, 0.010, 5, I.TRIM, 0.4);
    }
    if (vent) {
      for (let v = 0; v < 5; v++) {
        W.box(face - i * 0.004, y + h * 0.28 - v * 0.035, dz, 0.012, 0.012, dw * 0.62, 0, I.TRIM, 0.6);
      }
    }
  }
  if (plinth) F.box(x, y - h / 2 - 0.03, z, d * 0.86, 0.06, w * 0.96, 0, I.TRIM, 0.7);
}

/** Open shelving with a retaining bar — nothing stays on a shelf at sea. */
export function shelf(F, x, y, z, w, d, s, levels = 3, gap = 0.30) {
  const W = F.W;
  for (let i = 0; i < levels; i++) {
    const sy = y + i * gap;
    W.box(x, sy, z, d, 0.022, w, 0, I.TRIM, 0.6);
    // The fiddle rail. Two centimetres of steel that says "this thing moves".
    W.tube(x + IN(s) * d * 0.46, sy + 0.075, z - w / 2, x + IN(s) * d * 0.46, sy + 0.075, z + w / 2,
      0.010, 5, I.TRIM, 0.5);
  }
  for (const ez of [z - w / 2, z + w / 2]) {
    W.box(x, y + (levels - 1) * gap / 2, ez, d, (levels - 1) * gap + 0.05, 0.022, 0, I.TRIM, 0.6);
  }
}

/** Stencil or placard: a quad on a wall, mapped to one atlas cell. */
export function placard(W, x, y, z, w, h, axis, s, name) {
  const [u0, v0, u1, v1] = decal(name);
  const base = W.v;
  const put = (px, py, pz, u, v) => {
    const n = axis === 'x' ? [s, 0, 0] : axis === 'y' ? [0, s, 0] : [0, 0, s];
    return W._push(px, py, pz, n[0], n[1], n[2], I.DECAL, 0.4, u, v);
  };
  // Atlas v runs down the canvas; flip it so text is the right way up.
  if (axis === 'x') {
    put(x, y - h / 2, z - s * w / 2, u0, v1); put(x, y - h / 2, z + s * w / 2, u1, v1);
    put(x, y + h / 2, z + s * w / 2, u1, v0); put(x, y + h / 2, z - s * w / 2, u0, v0);
  } else if (axis === 'y') {
    put(x - w / 2, y, z - s * h / 2, u0, v1); put(x + w / 2, y, z - s * h / 2, u1, v1);
    put(x + w / 2, y, z + s * h / 2, u1, v0); put(x - w / 2, y, z + s * h / 2, u0, v0);
  } else {
    put(x + s * w / 2, y - h / 2, z, u0, v1); put(x - s * w / 2, y - h / 2, z, u1, v1);
    put(x - s * w / 2, y + h / 2, z, u1, v0); put(x + s * w / 2, y + h / 2, z, u0, v0);
  }
  W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Placard on a bulkhead: axis Z, facing `sd`. Saves repeating the axis dance. */
export function placardOn(W, x, y, z, sd, name, w = 0.18, h = 0.18) {
  placard(W, x, y, z, w, h, 'z', sd, name);
}

/** Fire extinguisher on a quick-release bracket. */
export function extinguisher(F, x, y, z, s) {
  const W = F.W;
  W.tube(x, y, z, x, y + 0.42, z, 0.072, 12, I.LOCK, 0.35);
  W.tube(x, y + 0.42, z, x, y + 0.50, z, 0.030, 8, I.TRIM, 0.4);
  W.box(x, y + 0.53, z, 0.075, 0.05, 0.10, 0, I.BRASS, 0.35);          // valve head
  W.tube(x, y + 0.52, z + 0.03, x + s * 0.10, y + 0.30, z + 0.10, 0.014, 6, I.TRIM, 0.5); // hose
  for (const by of [y + 0.10, y + 0.32]) {                              // bracket bands
    W.box(x + s * 0.055, by, z, 0.055, 0.045, 0.17, 0, I.TRIM, 0.6);
  }
  placard(W, x + IN(s) * 0.078, y + 0.20, z, 0.125, 0.15, 'x', IN(s), 'FIRE');
}

/** Stowed crate, strapped down. */
export function crate(F, x, y, z, w, h, d, yaw = 0) {
  const W = F.W;
  F.sbox(x, y, z, d, h, w, yaw, I.LOCK, 0.7);
  // Corner irons and two lashing straps.
  for (const sy of [-h / 2, h / 2]) {
    for (const sz of [-w / 2, w / 2]) {
      W.box(x, y + sy, z + sz, d * 1.02, 0.035, 0.035, yaw, I.TRIM, 0.75);
    }
  }
  for (const sz of [-w * 0.26, w * 0.26]) {
    W.box(x, y, z + sz, d * 1.04, h * 1.02, 0.030, yaw, I.FABRIC, 0.6);
  }
}

/** Arbitrary quad from four corners. Sloped desks, screens, canvas, chart tables. */
export function quad(W, p0, p1, p2, p3, mat, wear, uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
  const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const base = W.v;
  const P = [p0, p1, p2, p3];
  for (let i = 0; i < 4; i++) W._push(P[i][0], P[i][1], P[i][2], nx, ny, nz, mat, wear, uv[i][0], uv[i][1]);
  W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/* ------------------------------------------------------- deckhead services
 *
 * The ceiling was the emptiest surface in the boat and the one most often in
 * frame, because a curved deckhead fills the top third of every shot taken
 * from standing height. Trunking, cable and rails fix that for almost nothing:
 * they are simple shapes, they run the full length so they give the eye a line
 * to follow down an eighteen-metre tube, and — being overhead — they never
 * interfere with walking, so none of it needs collision.
 */
export function deckhead(F) {
  const W = F.W;

  /* Ventilation trunk down the crown, with branch spigots into each space.
   *
   * Rectangular, because ducting is folded from sheet and round duct is a
   * pressure-vessel solution to a problem ventilation does not have. The
   * flanged joints every 1.6 m are what stop it reading as a long grey box. */
  const TY = 1.98;
  for (let z = -8.0; z < 8.0; z += 1.6) {
    const zb = Math.min(z + 1.6, 8.0);
    W.box(0.42, TY, (z + zb) / 2, 0.34, 0.26, zb - z, 0, I.TRIM, 0.5);
    W.box(0.42, TY, zb, 0.39, 0.31, 0.045, 0, I.TRIM, 0.55);   // joint flange
  }
  for (const z of [-6.4, -3.9, 0.2, 2.9, 6.2]) {
    W.tube(0.42, TY - 0.13, z, 0.42, TY - 0.34, z, 0.075, 10, I.TRIM, 0.5);
    W.box(0.42, TY - 0.37, z, 0.20, 0.045, 0.20, 0, I.TRIM, 0.55);   // register grille
  }

  // Cable looms opposite the trunk, and a conduit run beneath them.
  loom(W, -0.46, TY - 0.06, -8.2, 8.0, 5, 0.019);
  W.tube(-0.72, TY - 0.16, -8.2, -0.72, TY - 0.16, 8.0, 0.032, 8, I.TRIM, 0.55);
  for (let z = -8.0; z < 8.0; z += 2.4) {
    W.box(-0.72, TY - 0.10, z, 0.09, 0.10, 0.05, 0, I.TRIM, 0.6);   // saddle clamps
  }

  /* Pipe runs along both sides at shoulder and head height, and the cable tray
   * under them. These follow the shell rather than the deck, so they converge
   * toward the bow and stern with the hull — which is most of what tells the eye
   * that this tube has a shape at all. */
  /* Height matters more than anything else about these.
   *
   * They ran at 0.62 m and 0.95 m off the hull axis. Standing eye height is
   * DECK_Y + EYE = 0.57 — so the lower run was a 15 cm pipe straight across the
   * middle of the view, one metre from the face, in every single frame shot
   * from inside the boat. It was invisible as a fault while the compartments
   * were empty because there was nothing behind it to block. Now there is, and
   * it was blocking all of it.
   *
   * Lifted to 1.18 and 1.45: above a standing eye, below the deckhead trunk at
   * 1.98, and clear of the tallest cabinet at 0.67.
   *
   * Following the shell rather than a fixed x, too. A straight run at x = 1.94
   * is outside the hull anywhere past |z| = 6, where the section has closed to
   * 1.9 — so both pipes pushed through the skin and hung in open water at each
   * end of the boat. */
  for (const s of [-1, 1]) {
    for (const [inset, yy] of [[0.11, 1.18], [0.09, 1.45]]) {
      const pts = [];
      for (let z = -HULL_LEN + 1.2; z <= HULL_LEN - 1.3; z += 0.9) {
        pts.push([s * Math.max(0.5, shellX(z, yy) - inset), yy, z]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        W.tube(a[0], a[1], a[2], b[0], b[1], b[2], 0.075, 12, I.TRIM, 0.65);
        if (i % 2 === 0) W.box(a[0] + s * 0.07, a[1], a[2], 0.10, 0.16, 0.07, 0, I.TRIM, 0.6);
      }
    }
    // Cable tray, also lifted clear of the eye and of the furniture below it.
    const ty = 0.92;
    for (let z = -7.6; z < 7.3; z += 1.8) {
      const x = s * Math.max(0.5, shellX(z + 0.9, ty) - 0.20);
      W.box(x, ty, z + 0.9, 0.16, 0.10, 1.8, 0, I.TRIM, 0.7);
    }
    loom(W, s * 1.72, 1.00, -7.6, 7.2, 3, 0.017, 1.6);
  }

  /* Grab rails, and they are placed where a hand actually goes: alongside the
   * centreline, low enough to reach at 1.62 m eye height, and broken at the
   * bulkheads rather than run through them. */
  for (const s of [-1, 1]) {
    grabRail(W, s * 0.30, 1.52, -8.0, -2.9);
    grabRail(W, s * 0.30, 1.52, -2.2, 4.1);
    grabRail(W, s * 0.30, 1.52, 4.7, 7.6);
  }
}

/* --------------------------------------------------------- stern: machinery
 *
 * Compartment 1, z from -8.6 to -2.9. The loud end.
 *
 * Given a function first and objects second, which is the only order that
 * works. A room furnished from a list of nice props is a shop window; a room
 * furnished from "this is where the pumps, the air and the switchboard live"
 * produces the same props with a reason for each position — the switchboard by
 * the door because that is where you reach for it, the bilge hatch at the low
 * point, the air bottles against the strongest frame.
 */
export function sternMachinery(F) {
  const W = F.W;
  const P = -1, S = 1;   // port, starboard

  /* Main pump skid: bedplate, motor, volute, and the pipework it serves.
   *
   * Built as a skid rather than as loose objects because that is how machinery
   * arrives — bolted to a frame at the works, craned in as one unit. The
   * bedplate also gives the whole assembly a single shadow line on the deck,
   * which is what stops five cylinders reading as five separate props. */
  {
    const x = standX(-5.7, P) - P * -0.30, z = -5.7;
    const bx = standX(-5.7, P) + 0.34;
    F.sbox(bx, DECK_Y + 0.09, z, 0.62, 0.18, 1.30, 0, I.TRIM, 0.7);           // bedplate
    W.tube(bx - 0.10, DECK_Y + 0.42, z - 0.42, bx - 0.10, DECK_Y + 0.42, z + 0.30,
      0.20, 14, I.LOCK, 0.5);                                                   // motor
    for (let i = 0; i < 9; i++) {                                               // cooling fins
      W.tube(bx - 0.10, DECK_Y + 0.42, z - 0.40 + i * 0.085,
        bx - 0.10, DECK_Y + 0.42, z - 0.38 + i * 0.085, 0.225, 14, I.LOCK, 0.55);
    }
    W.tube(bx - 0.10, DECK_Y + 0.42, z + 0.30, bx - 0.10, DECK_Y + 0.42, z + 0.40,
      0.075, 8, I.TRIM, 0.5);                                                   // shaft coupling
    W.tube(bx - 0.10, DECK_Y + 0.42, z + 0.40, bx - 0.10, DECK_Y + 0.42, z + 0.62,
      0.21, 16, I.LOCK, 0.6);                                                   // volute
    W.tube(bx - 0.10, DECK_Y + 0.63, z + 0.51, bx - 0.10, DECK_Y + 0.86, z + 0.51,
      0.085, 10, I.TRIM, 0.6);                                                  // discharge
    flange(W, bx - 0.10, DECK_Y + 0.86, z + 0.51, [0, 1, 0], 0.085);
    pipeline(W, [
      [bx - 0.10, DECK_Y + 0.88, z + 0.51],
      [bx - 0.10, DECK_Y + 1.30, z + 0.51],
      [bx - 0.10, DECK_Y + 1.30, z + 1.60],
    ], 0.075);
    // Suction from the bilge, down through the deck.
    pipeline(W, [
      [bx - 0.10, DECK_Y + 0.42, z - 0.44],
      [bx - 0.10, DECK_Y + 0.42, z - 0.78],
      [bx - 0.10, DECK_Y - 0.05, z - 0.78],
    ], 0.070);
    handwheel(W, bx - 0.10, DECK_Y + 1.05, z + 0.51, 0.135, 'z', 0.19);
    placard(W, bx + 0.32, DECK_Y + 0.62, z - 0.30, 0.15, 0.17, 'x', 1, 'PUMP');
  }

  /* High-pressure air: two bottles in a rack against a frame.
   *
   * Barotrauma's dread with none of its look — HP air is the system that lets
   * you blow ballast and get off the bottom, so a player who has understood
   * these two cylinders has understood the stakes without being told them. */
  {
    const z = -6.6, x = standX(z, S) - S * 0.22;
    for (const dz of [-0.24, 0.24]) {
      W.tube(x, DECK_Y + 0.10, z + dz, x, DECK_Y + 1.18, z + dz, 0.135, 14, I.LOCK, 0.4);
      W.tube(x, DECK_Y + 1.18, z + dz, x, DECK_Y + 1.27, z + dz, 0.055, 10, I.BRASS, 0.35);
      handwheel(W, x, DECK_Y + 1.33, z + dz, 0.075, 'y', 0.06);
    }
    F.solid(x, DECK_Y + 0.64, z, 0.30, 1.28, 0.72);
    for (const by of [DECK_Y + 0.30, DECK_Y + 1.00]) {                          // rack bands
      W.box(x + S * 0.10, by, z, 0.075, 0.055, 0.62, 0, I.TRIM, 0.6);
    }
    pipeline(W, [
      [x, DECK_Y + 1.30, z - 0.24], [x, DECK_Y + 1.52, z - 0.24],
      [x, DECK_Y + 1.52, z + 0.24], [x, DECK_Y + 1.52, z + 1.90],
    ], 0.028, I.BRASS, 0.4);
    placard(W, x + IN(S) * 0.140, DECK_Y + 0.86, z, 0.17, 0.19, 'x', IN(S), 'HPAIR');
  }

  /* Main switchboard, by the door because that is where a hand reaches for it.
   *
   * The indicator lamps are the point rather than the cabinet. Three green, one
   * amber and one dead is a machine reporting a state, and a machine reporting
   * a state in an empty room is the cheapest suspense in the game. */
  {
    const z = -3.55, x = standX(z, P);
    W.box(x - P * 0.11, DECK_Y + 1.02, z, 0.22, 0.92, 1.05, 0, I.LOCK, 0.45);
    F.solid(x - P * 0.11, DECK_Y + 1.02, z, 0.22, 0.92, 1.05);
    // The live face: breakers and lamps, drawn by the shader from these UVs.
    const bf = x - P * 0.225;                    // the inboard face of the box
    quad(W,
      [bf, DECK_Y + 0.58, z - 0.47], [bf, DECK_Y + 0.58, z + 0.47],
      [bf, DECK_Y + 1.44, z + 0.47], [bf, DECK_Y + 1.44, z - 0.47],
      I.PANEL, 0.3, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    for (const cy of [DECK_Y + 0.66, DECK_Y + 1.38]) {
      W.tube(bf, cy, z - 0.47, bf, cy, z + 0.47, 0.016, 6, I.TRIM, 0.5);        // face rails
    }
    placard(W, bf - P * 0.010, DECK_Y + 1.52, z, 0.18, 0.20, 'x', -P, 'MAIN');
    // The loom that leaves it, dropping to the cable tray.
    loom(W, x - P * 0.24, DECK_Y + 1.56, z + 0.5, z + 2.4, 4, 0.018, 0.9);
  }

  /* Valve manifold: three wheels on a header, each tagged.
   *
   * Tags matter more than the valves. An untagged wheel is a shape; BILGE,
   * TRIM and BALLAST on three identical wheels turn the same geometry into a
   * control panel for a submarine, and tell the player what this vessel can do
   * to itself. */
  {
    const z = -4.5, x = standX(z, S) - S * 0.16;
    W.tube(x, DECK_Y + 0.30, z - 0.62, x, DECK_Y + 0.30, z + 0.62, 0.062, 10, I.TRIM, 0.6);
    const tags = ['BILGE', 'TRIM', 'BALLAST'];
    tags.forEach((t, i) => {
      const vz = z - 0.42 + i * 0.42;
      W.tube(x, DECK_Y + 0.30, vz, x, DECK_Y + 0.56, vz, 0.052, 8, I.TRIM, 0.55);
      W.box(x, DECK_Y + 0.60, vz, 0.13, 0.11, 0.13, 0, I.BRASS, 0.4);          // bonnet
      handwheel(W, x, DECK_Y + 0.76, vz, 0.105, 'y', 0.16);
      placard(W, x - S * 0.075, DECK_Y + 0.58, vz, 0.125, 0.145, 'x', -S, t);
    });
    F.solid(x, DECK_Y + 0.45, z, 0.24, 0.90, 1.30);
    pipeline(W, [
      [x, DECK_Y + 0.30, z + 0.62], [x, DECK_Y + 0.30, z + 1.10],
      [x, DECK_Y - 0.12, z + 1.10],
    ], 0.062);
    // A gauge board over the manifold: three faces the shader already knows.
    W.box(x - S * 0.02, DECK_Y + 1.28, z, 0.055, 0.30, 0.86, 0, I.LOCK, 0.5);
    /* Three dials that read three different things.
     *
     * They were all wired to the same pressure value, so the machinery space
     * had three identical needles standing at an identical angle — which is
     * worse than one dial, because it tells the player the instruments are
     * decoration. The wear slot is unused on a gauge face, so it carries the
     * dial's type instead: 0 pressure, 4 trim, 2 ballast, in eighths. */
    const GTYPE = [0 / 8, 4 / 8, 2 / 8];
    for (let i = 0; i < 3; i++) {
      const gz = z - 0.28 + i * 0.28;
      quad(W,
        [x - S * 0.050, DECK_Y + 1.16, gz - 0.11], [x - S * 0.050, DECK_Y + 1.16, gz + 0.11],
        [x - S * 0.050, DECK_Y + 1.38, gz + 0.11], [x - S * 0.050, DECK_Y + 1.38, gz - 0.11],
        I.GAUGE, GTYPE[i], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      // Bezel in two parts, so the glass sits *in* the board rather than on it.
      ring(W, x - S * 0.048, DECK_Y + 1.27, gz, 0.118, 0.014, 16, 'x', I.BRASS, 0.4);
      ring(W, x - S * 0.028, DECK_Y + 1.27, gz, 0.128, 0.020, 16, 'x', I.TRIM, 0.5);
    }
  }

  /* Workbench with a vice and a tool board.
   *
   * Silhouetted tools on a shadow board, because a hanging spanner is legible
   * as a spanner from its outline alone — and the outline is all the lamp gives
   * you at this distance anyway. */
  {
    const z = -7.5, x = standX(z, P) - P * 0.22;
    F.sbox(x, DECK_Y + 0.44, z, 0.44, 0.88, 1.10, 0, I.LOCK, 0.6);
    W.box(x - P * 0.03, DECK_Y + 0.90, z, 0.50, 0.05, 1.16, 0, I.TRIM, 0.75);  // scarred top
    // Vice, overhanging the edge the way one always is.
    W.box(x - P * 0.20, DECK_Y + 1.00, z + 0.36, 0.20, 0.16, 0.15, 0, I.LOCK, 0.5);
    W.box(x - P * 0.20, DECK_Y + 1.06, z + 0.28, 0.17, 0.10, 0.05, 0, I.TRIM, 0.4);
    W.tube(x - P * 0.20, DECK_Y + 1.00, z + 0.44, x - P * 0.20, DECK_Y + 1.00, z + 0.56,
      0.018, 6, I.TRIM, 0.4);
    // Shadow board.
    W.box(x + P * 0.19, DECK_Y + 1.34, z, 0.030, 0.60, 1.06, 0, I.LOCK, 0.5);
    const tools = [[-0.40, 0.34, 0.030, 0.30], [-0.24, 0.30, 0.026, 0.24],
    [-0.08, 0.36, 0.034, 0.34], [0.12, 0.26, 0.050, 0.16], [0.34, 0.32, 0.024, 0.28]];
    for (const [tz, ty, tw, th] of tools) {
      W.box(x + P * 0.165, DECK_Y + 1.10 + ty, z + tz, 0.022, th, tw, 0, I.TRIM, 0.45);
    }
    placard(W, x + P * 0.172, DECK_Y + 1.62, z, 0.11, 0.09, 'x', -P, 'PLATE');
  }

  // Stores: crates struck down against the after bulkhead.
  crate(F, standX(-8.05, S) - S * 0.26, DECK_Y + 0.22, -8.05, 0.62, 0.44, 0.46);
  crate(F, standX(-8.05, S) - S * 0.24, DECK_Y + 0.60, -8.00, 0.54, 0.32, 0.42, 0.14);
  crate(F, standX(-7.95, P) - P * 0.26, DECK_Y + 0.26, -8.30, 0.70, 0.52, 0.48, -0.09);

  /* Bilge access, at the low point of the compartment where it belongs.
   *
   * A hatch in the deck does something no wall fitting can: it says there is a
   * space under your feet. Eighteen metres of hull with a solid floor is a
   * corridor; the same hull with one plate lifted is a vessel with an inside. */
  {
    const z = -6.15;
    W.box(0.55, DECK_Y + 0.012, z, 0.86, 0.030, 0.86, 0, I.TRIM, 0.7);
    for (const [dx, dz] of [[-0.40, 0], [0.40, 0], [0, -0.40], [0, 0.40]]) {
      W.box(0.55 + dx, DECK_Y + 0.028, z + dz, 0.10, 0.045, 0.10, 0, I.TRIM, 0.6);   // dogs
    }
    ring(W, 0.55, DECK_Y + 0.075, z, 0.085, 0.014, 12, 'y', I.TRIM, 0.5);            // lifting ring
    placard(W, 0.55, DECK_Y + 0.032, z - 0.30, 0.20, 0.10, 'y', 1, 'BILGE');
  }

  // Compartment number, beside the door on the way forward.
  placard(W, standX(-2.95, P) - P * 0.01, DECK_Y + 1.55, -2.95, 0.19, 0.23, 'x', -P, 'ONE');
  extinguisher(F, standX(-3.15, S) - S * 0.10, DECK_Y + 0.55, -3.15, S);
}

/* ------------------------------------------------------ midships: living
 *
 * Compartment 2, z from -2.3 to 4.1. The quiet end, and the one that has to
 * carry the horror.
 *
 * Machinery is impressive; a bunk with the blanket still turned back is
 * frightening, because it is the only object aboard that implies a person who
 * is not here. Everything in this compartment is chosen for that: two berths
 * for a crew of two, one mug, one jacket, one photograph. The player is meant
 * to count them and notice the arithmetic does not include them.
 */
export function midAccommodation(F) {
  const W = F.W;
  const P = -1, S = 1;

  /* Two berths, one above the other, with lee cloths.
   *
   * The lee cloth is the detail that pays: a rectangle of canvas laced to the
   * frame so the sleeper is not thrown out when the boat rolls. Nobody rigs one
   * on a bed. Rigged here, it says "this vessel moves violently and the crew
   * expected it to" in one object with no text attached. */
  {
    const zc = 0.10, len = 1.98, wide = 0.74;
    /* Built into the curve of the hull, not stood on the deck against it.
     *
     * A berth placed at the deck edge leaves a 40 cm wedge of bare plate
     * outboard of it, because the shell is still opening out above deck level —
     * and that wedge is precisely the large empty surface this whole pass exists
     * to remove. Real berths in a round hull are cantilevered off the frames and
     * overhang the deck, which fills the wedge and puts the sleeper's shoulder
     * against the shell where the cold is. */
    const xo = P * Math.min(2.30, shellX(zc, DECK_Y + 0.90));   // outboard face
    const xi = xo - P * wide;                                   // inboard edge
    for (const [by, isLower] of [[DECK_Y + 0.46, true], [DECK_Y + 1.32, false]]) {
      W.box((xo + xi) / 2, by, zc, wide, 0.055, len, 0, I.TRIM, 0.6);            // pan
      quad(W,
        [xo, by + 0.09, zc - len / 2], [xi, by + 0.09, zc - len / 2],
        [xi, by + 0.135, zc + len / 2], [xo, by + 0.135, zc + len / 2],
        I.FABRIC, 0.55, [[0, 0], [1, 0], [1, 1], [0, 1]]);                        // mattress
      // Blanket, turned back at the head. One fold, and it reads as slept in.
      quad(W,
        [xo, by + 0.145, zc - len / 2 + 0.42], [xi, by + 0.145, zc - len / 2 + 0.42],
        [xi, by + 0.150, zc + len / 2 - 0.05], [xo, by + 0.150, zc + len / 2 - 0.05],
        I.FABRIC, 0.75, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      W.box((xo + xi) / 2, by + 0.175, zc - len / 2 + 0.44, wide * 0.98, 0.075, 0.16,
        0, I.FABRIC, 0.7);                                                        // turned edge
      W.box((xo + xi) / 2 - P * 0.06, by + 0.185, zc + len / 2 - 0.24, wide * 0.62, 0.10, 0.34,
        0, I.FABRIC, 0.35);                                                       // pillow
      // Lee cloth on the inboard side, laced up to the frame above.
      quad(W,
        [xi, by + 0.05, zc - 0.66], [xi, by + 0.05, zc + 0.66],
        [xi - P * 0.05, by + 0.42, zc + 0.66], [xi - P * 0.05, by + 0.42, zc - 0.66],
        I.FABRIC, 0.8, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      for (let i = 0; i < 5; i++) {
        const lz = zc - 0.56 + i * 0.28;
        W.tube(xi - P * 0.05, by + 0.42, lz, xi - P * 0.02, by + 0.66, lz, 0.008, 4, I.FABRIC, 0.7);
      }
      if (isLower) F.solid((xo + xi) / 2, by, zc, wide, 0.30, len);
    }
    // Frame: four stanchions and the rails the cloths lace to.
    for (const dz of [-len / 2 + 0.06, len / 2 - 0.06]) {
      W.tube(xi, DECK_Y, zc + dz, xi, DECK_Y + 1.76, zc + dz, 0.026, 8, I.TRIM, 0.5);
    }
    W.tube(xi, DECK_Y + 0.72, zc - len / 2, xi, DECK_Y + 0.72, zc + len / 2, 0.020, 6, I.TRIM, 0.5);
    W.tube(xi, DECK_Y + 1.58, zc - len / 2, xi, DECK_Y + 1.58, zc + len / 2, 0.020, 6, I.TRIM, 0.5);
    // Reading lamp on the lower berth, and boots stowed beneath it.
    W.tube(xo - P * 0.10, DECK_Y + 1.14, zc + 0.74, xo - P * 0.20, DECK_Y + 1.08, zc + 0.74,
      0.022, 6, I.TRIM, 0.4);
    W.tube(xo - P * 0.20, DECK_Y + 1.08, zc + 0.74, xo - P * 0.26, DECK_Y + 1.00, zc + 0.74,
      0.045, 8, I.LOCK, 0.4);
    for (const bz of [-0.10, 0.10]) {
      W.box(xo - P * 0.22, DECK_Y + 0.09, zc - 0.80 + bz, 0.15, 0.18, 0.30, 0.2, I.FABRIC, 0.65);
    }
    // The photograph, taped where the lower bunk's occupant would see it.
    placard(W, xo - P * 0.010, DECK_Y + 0.86, zc - 0.42, 0.17, 0.17, 'x', -P, 'PHOTO');
  }

  /* CO2 scrubber. Life support, and the green lamp the art direction asks for.
   *
   * Positioned so its indicator is the first thing visible when you come
   * forward from the machinery space: green in an otherwise amber-and-grey
   * room, and the only colour in the boat that means "still breathing". */
  {
    const z = -1.95, x = standX(z, P) - P * 0.20;
    cabinet(F, x, DECK_Y + 0.86, z, 0.68, 1.72, 0.40, P, { doors: 1, vent: true, wear: 0.45 });
    const sf = x - P * 0.205;
    quad(W,
      [sf, DECK_Y + 1.46, z - 0.24], [sf, DECK_Y + 1.46, z + 0.24],
      [sf, DECK_Y + 1.70, z + 0.24], [sf, DECK_Y + 1.70, z - 0.24],
      I.PANEL, 0.25, [[0, 0.62], [1, 0.62], [1, 1], [0, 1]]);
    placard(W, sf - P * 0.006, DECK_Y + 1.34, z, 0.19, 0.16, 'x', -P, 'SCRUB');
    // Breathing air return, up into the deckhead trunk.
    pipeline(W, [
      [x, DECK_Y + 1.74, z], [x, 1.86, z], [0.42, 1.86, z],
    ], 0.062);
  }

  /* Mess table with fiddles, and a bench that folds against the hull.
   *
   * Fiddle rails are the single most economical "this is a ship" signal in the
   * whole fit-out: 25 mm of steel round three edges of a table, so crockery
   * does not go on the deck when she rolls. Nobody has ever seen them on
   * furniture ashore, and everyone reads them correctly anyway. */
  {
    const z = -0.75, x = standX(z, S) - S * 0.34;
    F.sbox(x, DECK_Y + 0.36, z, 0.62, 0.72, 1.04, 0, I.LOCK, 0.55);
    W.box(x, DECK_Y + 0.745, z, 0.68, 0.045, 1.10, 0, I.TRIM, 0.5);            // top
    for (const [ex, ez, sx2, sz2] of [
      [0.34, 0, 0.030, 1.10], [-0.34, 0, 0.030, 1.10],
      [0, 0.55, 0.68, 0.030], [0, -0.55, 0.68, 0.030]]) {
      W.tube(x + ex - sx2 / 2, DECK_Y + 0.795, z + ez - sz2 / 2,
        x + ex + sx2 / 2, DECK_Y + 0.795, z + ez + sz2 / 2, 0.014, 6, I.TRIM, 0.4);
    }
    // What is on it: one mug, one folded chart, an ashtray. One of each.
    W.tube(x - S * 0.14, DECK_Y + 0.77, z + 0.22, x - S * 0.14, DECK_Y + 0.86, z + 0.22,
      0.042, 12, I.LOCK, 0.3);
    ring(W, x - S * 0.185, DECK_Y + 0.815, z + 0.22, 0.030, 0.008, 8, 'x', I.LOCK, 0.3);
    placard(W, x + S * 0.10, DECK_Y + 0.772, z - 0.18, 0.30, 0.30, 'y', 1, 'CHART');
    W.tube(x + S * 0.20, DECK_Y + 0.77, z + 0.34, x + S * 0.20, DECK_Y + 0.80, z + 0.34,
      0.052, 10, I.BRASS, 0.5);
    // Bench along the hull.
    F.sbox(x + S * 0.52, DECK_Y + 0.21, z, 0.34, 0.42, 1.16, 0, I.LOCK, 0.6);
    W.box(x + S * 0.52, DECK_Y + 0.435, z, 0.38, 0.05, 1.20, 0, I.FABRIC, 0.6);
  }

  /* Galley: a counter, a sink with a real tap, a kettle, mugs on hooks.
   *
   * Two mugs on hooks and one on the table. That is the crew, counted in
   * crockery — and the empty third hook is worth more than any note left on a
   * desk, because the player does the arithmetic themselves. */
  {
    const z = 1.35, x = standX(z, S) - S * 0.28;
    F.sbox(x, DECK_Y + 0.42, z, 0.56, 0.84, 1.12, 0, I.LOCK, 0.5);
    W.box(x, DECK_Y + 0.855, z, 0.60, 0.03, 1.16, 0, I.TRIM, 0.35);            // stainless top
    // Sink: a recessed pan, and a swan-neck tap behind it.
    W.box(x, DECK_Y + 0.795, z - 0.24, 0.36, 0.10, 0.40, 0, I.TRIM, 0.3);
    pipeline(W, [
      [x + S * 0.22, DECK_Y + 0.87, z - 0.24], [x + S * 0.22, DECK_Y + 1.06, z - 0.24],
      [x + S * 0.04, DECK_Y + 1.10, z - 0.24], [x + S * 0.02, DECK_Y + 1.00, z - 0.24],
    ], 0.016, I.BRASS, 0.35);
    handwheel(W, x + S * 0.22, DECK_Y + 1.09, z - 0.24, 0.048, 'y', 0.05);
    // Kettle.
    W.tube(x - S * 0.06, DECK_Y + 0.87, z + 0.30, x - S * 0.06, DECK_Y + 1.03, z + 0.30,
      0.082, 12, I.TRIM, 0.45);
    W.tube(x - S * 0.06, DECK_Y + 1.03, z + 0.30, x - S * 0.06, DECK_Y + 1.07, z + 0.30,
      0.030, 8, I.TRIM, 0.45);
    W.tube(x - S * 0.13, DECK_Y + 0.95, z + 0.30, x - S * 0.20, DECK_Y + 1.02, z + 0.30,
      0.016, 6, I.TRIM, 0.45);
    // Mug rail above, with two mugs hanging and one hook empty.
    W.tube(x + S * 0.10, DECK_Y + 1.36, z - 0.46, x + S * 0.10, DECK_Y + 1.36, z + 0.46,
      0.012, 6, I.TRIM, 0.4);
    [-0.28, 0.02, 0.32].forEach((mz, i) => {
      W.tube(x + S * 0.10, DECK_Y + 1.36, z + mz, x + S * 0.10, DECK_Y + 1.30, z + mz,
        0.007, 5, I.TRIM, 0.4);
      if (i === 2) return;                                                       // the empty hook
      W.tube(x + S * 0.10, DECK_Y + 1.30, z + mz, x + S * 0.10, DECK_Y + 1.21, z + mz,
        0.040, 10, I.LOCK, 0.35);
    });
    shelf(F, x + S * 0.10, DECK_Y + 1.52, z, 1.00, 0.24, S, 2, 0.30);
    for (let i = 0; i < 7; i++) {                                                // tins
      W.tube(x + S * 0.10, DECK_Y + 1.53, z - 0.42 + i * 0.14,
        x + S * 0.10, DECK_Y + 1.63, z - 0.42 + i * 0.14, 0.045, 10, I.LOCK, 0.5);
    }
  }

  // Medical locker, personal lockers, and the jacket nobody came back for.
  {
    const z = 3.10, x = standX(z, S) - S * 0.17;
    cabinet(F, x, DECK_Y + 1.04, z, 0.52, 0.70, 0.34, S, { doors: 1, plinth: false, wear: 0.3 });
    placard(W, x - S * 0.178, DECK_Y + 1.04, z, 0.20, 0.20, 'x', -S, 'MEDCROSS');
  }
  {
    const z = 2.55, x = standX(z, P) - P * 0.22;
    cabinet(F, x, DECK_Y + 0.84, z, 1.00, 1.68, 0.44, P, { doors: 2 });
    // A jacket on a hook beside them, hanging with a slight twist.
    const jx = x - P * 0.26, jz = z + 0.72;
    W.box(jx, DECK_Y + 1.62, jz, 0.05, 0.05, 0.05, 0, I.TRIM, 0.5);
    quad(W,
      [jx - 0.16, DECK_Y + 1.58, jz - 0.14], [jx + 0.14, DECK_Y + 1.58, jz - 0.10],
      [jx + 0.17, DECK_Y + 0.92, jz - 0.05], [jx - 0.18, DECK_Y + 0.92, jz - 0.12],
      I.FABRIC, 0.85);
    quad(W,
      [jx - 0.18, DECK_Y + 0.92, jz - 0.12], [jx + 0.17, DECK_Y + 0.92, jz - 0.05],
      [jx + 0.15, DECK_Y + 0.94, jz + 0.10], [jx - 0.16, DECK_Y + 0.95, jz + 0.09],
      I.FABRIC, 0.9);
  }

  extinguisher(F, standX(3.85, P) - P * 0.09, DECK_Y + 0.60, 3.85, P);
  placard(W, standX(3.95, S) - S * 0.01, DECK_Y + 1.55, 3.95, 0.19, 0.23, 'x', -S, 'TWO');
  placard(W, standX(-2.15, S) - S * 0.01, DECK_Y + 1.30, -2.15, 0.20, 0.13, 'x', -S, 'HAZARD');
}

/* ------------------------------------------------------------- bow: the helm
 *
 * Compartment 3, z from 4.7 to 8.4, ending at the port.
 *
 * The console was already here and it was not the problem — the problem was
 * that it was alone in a cone of empty steel. What it needed was the rest of a
 * bridge: somewhere to put a chart, something to listen to, and one screen that
 * moves. The sonar earns its place three times over, being the only animated
 * light source in the boat, the only green, and the only object that reports
 * something outside the hull.
 */
export function bowHelm(F) {
  const W = F.W;
  const P = -1, S = 1;
  const CZ = 7.55, TOP = DECK_Y + 0.78;

  // Console: worktop, coaming, and the front panel under it.
  F.sbox(0, TOP, CZ, 2.05, 0.16, 0.74, 0, I.LOCK, 0.5);
  F.sbox(0, DECK_Y + 0.38, CZ + 0.31, 2.05, 0.80, 0.16, 0, I.LOCK, 0.55);
  W.box(0, TOP + 0.10, CZ - 0.36, 2.05, 0.06, 0.05, 0, I.TRIM, 0.4);            // spill coaming

  /* Three analogue faces, kept: depth, and two the player can only guess at.
   *
   * An instrument whose meaning is not given is better than one that is. The
   * needle moving for a reason you cannot name is the entire mechanism of
   * Iron Lung, and it costs a label you simply do not write. */
  // Depth, way and heading — the three numbers a pilot actually steers by.
  const HTYPE = [1 / 8, 5 / 8, 3 / 8];
  [-0.62, -0.30, 0.02].forEach((gx, i) => {
    quad(W,
      [gx - 0.115, TOP + 0.085, CZ - 0.115], [gx + 0.115, TOP + 0.085, CZ - 0.115],
      [gx + 0.115, TOP + 0.085, CZ + 0.115], [gx - 0.115, TOP + 0.085, CZ + 0.115],
      I.GAUGE, HTYPE[i], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    ring(W, gx, TOP + 0.082, CZ, 0.125, 0.014, 16, 'y', I.BRASS, 0.4);
    ring(W, gx, TOP + 0.062, CZ, 0.136, 0.022, 16, 'y', I.TRIM, 0.5);
  });

  /* Sonar: a screen laid into the console at the angle a seated pilot reads.
   *
   * Twenty-two degrees, not flat and not vertical, because a flat screen is a
   * puddle of glare from a standing eye and a vertical one is unreadable from a
   * seated one. The tilt is what makes the same geometry work in both modes. */
  {
    const sz = CZ + 0.06, sx = 0.52, tilt = 0.38, R = 0.20;
    const dy = Math.sin(tilt) * R, dz = Math.cos(tilt) * R;
    quad(W,
      [sx - R, TOP + 0.09 - dy, sz - dz], [sx + R, TOP + 0.09 - dy, sz - dz],
      [sx + R, TOP + 0.09 + dy, sz + dz], [sx - R, TOP + 0.09 + dy, sz + dz],
      I.SCREEN, 0.2, [[-1, -1], [1, -1], [1, 1], [-1, 1]]);
    // Bezel, sitting proud all the way round.
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      W.box(sx + a * R * 1.06, TOP + 0.085 + b * dy * 1.04, sz + b * dz * 1.04,
        a === 0 ? R * 2 : 0.03, 0.05, b === 0 ? R * 2 : 0.03, 0, I.TRIM, 0.4);
    }
    W.box(sx, TOP + 0.085 - dy * 1.10, sz - dz * 1.10, R * 2.1, 0.045, 0.035, 0, I.TRIM, 0.4);
    W.box(sx, TOP + 0.085 + dy * 1.10, sz + dz * 1.10, R * 2.1, 0.045, 0.035, 0, I.TRIM, 0.4);
  }

  // Throttle and ballast levers, and a bank of guarded toggles beside them.
  for (let i = 0; i < 3; i++) {
    const lx = -0.98 + i * 0.10;
    W.box(lx, TOP + 0.05, CZ + 0.16, 0.055, 0.10, 0.20, 0, I.TRIM, 0.5);
    W.tube(lx, TOP + 0.08, CZ + 0.14, lx, TOP + 0.30 - i * 0.04, CZ + 0.02 + i * 0.05,
      0.017, 6, I.TRIM, 0.35);
    W.tube(lx, TOP + 0.30 - i * 0.04, CZ + 0.02 + i * 0.05,
      lx, TOP + 0.34 - i * 0.04, CZ + 0.00 + i * 0.05, 0.033, 8, I.LOCK, 0.3);
  }
  quad(W,
    [0.86, TOP + 0.085, CZ - 0.28], [1.00, TOP + 0.085, CZ - 0.28],
    [1.00, TOP + 0.085, CZ + 0.28], [0.86, TOP + 0.085, CZ + 0.28],
    I.PANEL, 0.3, [[0, 0], [0.34, 0], [0.34, 1], [0, 1]]);

  /* Chart table, sloped, with the chart on it and a lamp over it.
   *
   * Sloped because a chart table is, and because the slope catches the one warm
   * lamp in the bow and throws it back at the player — the brightest thing in
   * the compartment after the sonar, which is exactly the hierarchy a navigator
   * would have built. */
  {
    const z = 5.55, x = standX(z, P) - P * 0.36;
    F.sbox(x, DECK_Y + 0.40, z, 0.68, 0.80, 1.08, 0, I.LOCK, 0.55);
    const lo = DECK_Y + 0.80, hi = DECK_Y + 0.92;
    quad(W,
      [x - 0.34, lo, z - 0.54], [x + 0.34, hi, z - 0.54],
      [x + 0.34, hi, z + 0.54], [x - 0.34, lo, z + 0.54],
      I.TRIM, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    quad(W,
      [x - 0.28, lo + 0.014, z - 0.44], [x + 0.28, hi + 0.014, z - 0.44],
      [x + 0.28, hi + 0.014, z + 0.44], [x - 0.28, lo + 0.014, z + 0.44],
      I.DECAL, 0.4, (() => { const [u0, v0, u1, v1] = decal('CHART'); return [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]; })());
    W.box(x - 0.35, lo - 0.01, z, 0.05, 0.05, 1.08, 0, I.TRIM, 0.45);            // low fiddle
    // Anglepoise over it: two arms and a shade. The only warm light forward.
    W.tube(x + 0.30, DECK_Y + 0.82, z - 0.48, x + 0.30, DECK_Y + 1.28, z - 0.48, 0.018, 6, I.TRIM, 0.4);
    W.tube(x + 0.30, DECK_Y + 1.28, z - 0.48, x - 0.02, DECK_Y + 1.42, z - 0.20, 0.015, 6, I.TRIM, 0.4);
    W.tube(x - 0.02, DECK_Y + 1.42, z - 0.20, x - 0.06, DECK_Y + 1.30, z - 0.02, 0.052, 10, I.LOCK, 0.4);
    // Dividers and a pencil, laid where they were put down.
    W.tube(x - 0.10, lo + 0.10, z + 0.22, x + 0.14, lo + 0.20, z + 0.30, 0.008, 5, I.BRASS, 0.4);
    W.tube(x - 0.06, lo + 0.09, z - 0.16, x + 0.10, lo + 0.16, z - 0.24, 0.006, 5, I.TRIM, 0.4);
  }

  /* Radio stack: three units, each with its own dial, meter and lamp.
   *
   * Stacked in a rack rather than spread out, because a rack has one silhouette
   * and three faces — the cheapest way to get instrument density into a frame
   * without three separate objects competing for the same wall. */
  {
    const z = 5.75, x = standX(z, S) - S * 0.15;
    F.sbox(x, DECK_Y + 0.94, z, 0.30, 1.00, 0.98, 0, I.LOCK, 0.45);
    for (let i = 0; i < 3; i++) {
      const uy = DECK_Y + 0.56 + i * 0.31;
      quad(W,
        [x - S * 0.155, uy - 0.13, z - 0.42], [x - S * 0.155, uy - 0.13, z + 0.42],
        [x - S * 0.155, uy + 0.13, z + 0.42], [x - S * 0.155, uy + 0.13, z - 0.42],
        I.PANEL, 0.28, [[0, 0.34 * i], [1, 0.34 * i], [1, 0.34 * i + 0.32], [0, 0.34 * i + 0.32]]);
      for (const dz of [-0.30, -0.16]) {                                          // tuning knobs
        W.tube(x - S * 0.155, uy - 0.04, z + dz, x - S * 0.195, uy - 0.04, z + dz,
          0.030, 10, I.TRIM, 0.35);
      }
      ring(W, x - S * 0.160, uy + 0.02, z + 0.26, 0.075, 0.009, 12, 'x', I.BRASS, 0.4);
    }
    // Handset on a hook, cord looped.
    W.box(x - S * 0.21, DECK_Y + 1.42, z + 0.30, 0.07, 0.19, 0.06, 0, I.LOCK, 0.4);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      W.tube(x - S * 0.20, DECK_Y + 1.30 + Math.sin(a) * 0.05, z + 0.30 + Math.cos(a) * 0.05,
        x - S * 0.20, DECK_Y + 1.28 + Math.sin(a + 1) * 0.05, z + 0.30 + Math.cos(a + 1) * 0.05,
        0.006, 4, I.TRIM, 0.5);
    }
  }

  // Overhead breaker panel above the console, angled down at the pilot.
  {
    const py = 1.20, pz = 7.30;
    W.box(0, py, pz, 1.50, 0.24, 0.26, 0, I.LOCK, 0.45);
    quad(W,
      [-0.72, py - 0.13, pz - 0.10], [0.72, py - 0.13, pz - 0.10],
      [0.72, py - 0.06, pz + 0.14], [-0.72, py - 0.06, pz + 0.14],
      I.PANEL, 0.28, [[0, 0], [1, 0], [1, 0.30], [0, 0.30]]);
    placard(W, 0, py + 0.126, pz, 0.16, 0.12, 'y', 1, 'VENT');
  }

  // Seat: pan, back, pedestal, and a footrest the pedestal needs.
  F.sbox(0, DECK_Y + 0.46, 6.55, 0.64, 0.10, 0.60, 0, I.LOCK, 0.6);
  W.box(0, DECK_Y + 0.80, 6.26, 0.62, 0.66, 0.09, 0, I.FABRIC, 0.6);
  W.box(0, DECK_Y + 0.50, 6.55, 0.58, 0.06, 0.54, 0, I.FABRIC, 0.55);
  W.tube(0, DECK_Y, 6.55, 0, DECK_Y + 0.42, 6.55, 0.075, 12, I.TRIM, 0.55);
  ring(W, 0, DECK_Y + 0.03, 6.55, 0.26, 0.020, 14, 'y', I.TRIM, 0.6);
  ring(W, 0, DECK_Y + 0.20, 6.85, 0.17, 0.016, 12, 'y', I.TRIM, 0.5);

  placard(W, standX(4.95, P) - P * 0.01, DECK_Y + 1.55, 4.95, 0.19, 0.23, 'x', -P, 'THREE');
  extinguisher(F, standX(4.85, S) - S * 0.09, DECK_Y + 0.58, 4.85, S);
}
