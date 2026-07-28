/* Lofting: sweep a varying cross-section and bridge it into one skin.
 *
 * This is the single highest-impact modelling technique in the reference
 * project's skill file, and it is stated there as a hard limit rather than a
 * preference:
 *
 *   "Loft cross-sections; never stack primitives. ... primitive assembly has a
 *    hard ceiling, and no amount of lighting or framing gets you past it."
 *
 * The station on the canyon floor is stacked primitives, and it hits that
 * ceiling exactly: boxes and tubes read as boxes and tubes no matter how well
 * they are lit, because every silhouette is an axis-aligned edge and every
 * junction is an intersection rather than a transition. A hull cannot be built
 * that way at all. A hull is one continuous surface whose section changes along
 * its length — which is what this file makes.
 *
 * Two ideas do most of the work:
 *
 *  1. A superellipse profile with a *variable exponent*. At 2 it is an ellipse,
 *     and as it rises it approaches a rectangle. Sweeping that exponent along
 *     the length lets a boxy stern become a rounded bow through one continuous
 *     skin, with no seam anywhere — the thing you cannot do by joining a cylinder
 *     to a sphere.
 *
 *  2. Normals faceted around the section but smooth along it. That is not a
 *     compromise between flat and smooth shading, it is specifically what rolled
 *     steel plate looks like: each plate is flat across its width and curves
 *     along the hull. Smoothing both ways gives an inflatable; faceting both ways
 *     gives a gemstone.
 */

/**
 * Superellipse ring, in section-local metres.
 *
 * `sq` is the exponent: 2 is a true ellipse, 4 is noticeably shouldered, 8 reads
 * as a rounded rectangle. Values below 2 give the pinched, cushion-like sections
 * that suit a pressure hull's tapered ends.
 */
export function ringProfile(w, h, sq, count) {
  const pts = [];
  const e = 2 / Math.max(0.35, sq);
  const a = w * 0.5, b = h * 0.5;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    pts.push([
      a * Math.sign(ct) * Math.pow(Math.abs(ct), e),
      b * Math.sign(st) * Math.pow(Math.abs(st), e),
    ]);
  }
  return pts;
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1e-6;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Sweep `stations` into a closed skin and weld it into `W`.
 *
 * Each station is `{ z, x?, y?, w, h, sq, roll? }`. The axis runs along Z; `x`
 * and `y` offset the section so the hull can have a rising deck line or a
 * drooping bow without any station having to be rotated.
 *
 * `recess(u, v)` is optional and returns a radial offset in metres, evaluated per
 * vertex. That is how panel bays and trenches are cut *into* the skin rather than
 * stuck onto it — the reference skill's second technique, and the reason a hull
 * reads as plated rather than as a smooth pod with decals.
 */
export function loftInto(W, stations, {
  count = 18, mat = 0, wear = 0.5, recess = null, capBow = true, capStern = true,
  facet = false, flip = false,
} = {}) {
  /* `flip` turns the skin inside out: normals reversed and winding swapped.
   *
   * Needed the moment the camera goes inside the loft. A hull viewed from within
   * is the same surface with the other face toward you, and rendering it with
   * BackSide alone is not enough — the normals would still point away, so every
   * interior lamp would light the outside of the boat. */
  const S = stations.length;

  // 1. All ring points in 3D.
  const P = stations.map((s) => {
    const prof = ringProfile(s.w, s.h, s.sq, count);
    const roll = s.roll || 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    return prof.map(([px, py], i) => {
      const rx = px * cr - py * sr, ry = px * sr + py * cr;
      let p = [(s.x || 0) + rx, (s.y || 0) + ry, s.z];
      if (recess) {
        // Radial push, along the section's own outward direction.
        const d = norm3([rx, ry, 0]);
        const off = recess(i / count, (s.z - stations[0].z) / (stations[S - 1].z - stations[0].z));
        p = [p[0] + d[0] * off, p[1] + d[1] * off, p[2]];
      }
      return p;
    });
  });

  /* 2. One normal per (station, strip): faceted around, smooth along.
   *
   * The normal is computed from the strip's own quad, so it is constant across
   * the plate's width — that is the faceting. Then it is averaged with the same
   * strip's normals at the neighbouring stations, which is the smoothing. Doing
   * it in that order is the whole trick; averaging around the ring as well would
   * erase the plates. */
  const N = [];
  for (let j = 0; j < S; j++) {
    N.push([]);
    for (let i = 0; i < count; i++) {
      const i1 = (i + 1) % count;
      const jn = Math.min(S - 1, j + 1), jp = Math.max(0, j - 1);
      const around = sub3(P[j][i1], P[j][i]);
      const along = sub3(P[jn === j ? j : jn][i], P[jp === j ? j : jp][i]);
      let n = norm3(cross3(around, along));
      // Orient outward: away from the section centre.
      const cx = stations[j].x || 0, cy = stations[j].y || 0;
      const out = [P[j][i][0] - cx, P[j][i][1] - cy, 0];
      if (n[0] * out[0] + n[1] * out[1] < 0) n = [-n[0], -n[1], -n[2]];
      N[j].push(n);
    }
  }
  // Longitudinal smoothing pass, per strip.
  const NS = N.map((row) => row.slice());
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < count; i++) {
      const a = N[Math.max(0, j - 1)][i], b = N[j][i], c = N[Math.min(S - 1, j + 1)][i];
      NS[j][i] = norm3([a[0] + b[0] * 2 + c[0], a[1] + b[1] * 2 + c[1], a[2] + b[2] * 2 + c[2]]);
    }
  }

  /* 2b. Smooth around the section as well, unless faceting is asked for.
   *
   * The first version faceted around on the theory that this is what rolled plate
   * looks like. That reasoning was wrong for a pressure hull, and the result was
   * measurably so: twenty segments on a 2.5 m hull is a 39 cm facet, which at six
   * metres is fifty-seven pixels wide. Flat-shaded fifty-seven-pixel facets are
   * the definition of the cartoon low-poly look, and no material hides them.
   *
   * A pressure vessel is rolled and then faired smooth, precisely because a
   * crease is a stress riser — real ones have no facets to find. So the plating
   * has to be read from the welds, which the shader already draws from the loft's
   * own UVs, rather than from the silhouette. Geometry carries the form; the
   * material carries the construction. */
  const VN = NS;
  if (!facet) {
    for (let j = 0; j < S; j++) {
      const row = [];
      for (let i = 0; i < count; i++) {
        const a = NS[j][(i - 1 + count) % count], b = NS[j][i];
        row.push(norm3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]));
      }
      VN[j] = row;
    }
  }

  // 3. Bridge consecutive rings. Each strip gets its own vertices so the plate
  //    edges stay crisp.
  const zTotal = Math.abs(stations[S - 1].z - stations[0].z) || 1;
  for (let j = 0; j < S - 1; j++) {
    for (let i = 0; i < count; i++) {
      const i1 = (i + 1) % count;
      const u0 = i / count, u1 = (i + 1) / count;
      const v0 = Math.abs(stations[j].z - stations[0].z) / zTotal;
      const v1 = Math.abs(stations[j + 1].z - stations[0].z) / zTotal;
      const base = W.v;
      const put = (pt, n, u, v) => W._push(pt[0], pt[1], pt[2], n[0], n[1], n[2], mat, wear, u, v);
      const f = flip ? -1 : 1;
      const nA = facet ? NS[j][i] : VN[j][i];
      const nB = facet ? NS[j][i] : VN[j][(i + 1) % count];
      const nC = facet ? NS[j + 1][i] : VN[j + 1][(i + 1) % count];
      const nD = facet ? NS[j + 1][i] : VN[j + 1][i];
      const fl = (n) => [n[0] * f, n[1] * f, n[2] * f];
      put(P[j][i], fl(nA), u0 * 6.0, v0 * zTotal);
      put(P[j][i1], fl(nB), u1 * 6.0, v0 * zTotal);
      put(P[j + 1][i1], fl(nC), u1 * 6.0, v1 * zTotal);
      put(P[j + 1][i], fl(nD), u0 * 6.0, v1 * zTotal);
      if (flip) W.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  // 4. Caps. Flat fans, only needed where a station has real area.
  const cap = (j, flip) => {
    const s = stations[j];
    const cx = s.x || 0, cy = s.y || 0;
    const nz = flip ? -1 : 1;
    const c = W._push(cx, cy, s.z, 0, 0, nz, mat, wear, 0, 0);
    for (let i = 0; i < count; i++) {
      const i1 = (i + 1) % count;
      const a = W._push(P[j][i][0], P[j][i][1], P[j][i][2], 0, 0, nz, mat, wear, 0, 0);
      const b = W._push(P[j][i1][0], P[j][i1][1], P[j][i1][2], 0, 0, nz, mat, wear, 0, 0);
      if (flip) W.idx.push(c, b, a); else W.idx.push(c, a, b);
    }
  };
  if (capStern && stations[0].w > 0.02) cap(0, true);
  if (capBow && stations[S - 1].w > 0.02) cap(S - 1, false);

  return P;
}

/**
 * Resample a small set of control stations into a dense smooth run.
 *
 * Authoring twenty stations by hand is how a hull ends up with visible kinks; six
 * control points interpolated with a cubic gives a fair curve, which is what a
 * shipwright's spline was for. Interpolates every field, so squareness and the
 * deck line fair together with the width.
 */
export function fairStations(control, steps = 26) {
  const keys = ['z', 'x', 'y', 'w', 'h', 'sq', 'roll'];
  const n = control.length;
  const at = (arr, i) => arr[Math.max(0, Math.min(n - 1, i))];
  const out = [];
  for (let s = 0; s < steps; s++) {
    const t = (s / (steps - 1)) * (n - 1);
    const i = Math.floor(t), f = t - i;
    const p0 = at(control, i - 1), p1 = at(control, i);
    const p2 = at(control, i + 1), p3 = at(control, i + 2);
    const st = {};
    for (const k of keys) {
      const a = p0[k] ?? 0, b = p1[k] ?? 0, c = p2[k] ?? 0, d = p3[k] ?? 0;
      // Catmull-Rom: passes through the control points, C1 continuous.
      st[k] = 0.5 * ((2 * b) + (-a + c) * f
        + (2 * a - 5 * b + 4 * c - d) * f * f
        + (-a + 3 * b - 3 * c + d) * f * f * f);
    }
    out.push(st);
  }
  return out;
}
