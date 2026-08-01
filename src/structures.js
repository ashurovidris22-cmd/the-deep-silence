import * as THREE from 'three';
import { NOISE, WATER, LAMP } from './glsl.js';
import { seabedHeight } from './terrain.js';
import { rng, SEEDS } from './rng.js';

/* Man-made wreckage, and the reason the deep needed it.
 *
 * Four hundred metres down there is no daylight, so the only things in frame are
 * whatever the lamp finds. With nothing but sediment and boulders down there, a
 * technically correct render of a canyon floor is a technically correct render of
 * an empty room — and no amount of shader work fixes that, because the problem is
 * that there is nothing to light.
 *
 * Steel fixes it for a specific reason: it is the only thing in the scene with
 * straight lines. Rock, silt and kelp are all noise-derived, so they share a
 * visual grammar and the eye has no reference for scale or for how sharp the
 * image really is. One rusted handrail gives it both, and simultaneously says
 * somebody was here — which is the entire emotional content of the reference
 * frames: a walkway, two red lamps, and otherwise nothing.
 *
 * Everything is welded into one merged mesh on the CPU. A few thousand boxes as
 * separate objects would be a few thousand draw calls; merged, the whole
 * installation is one.
 */

// Material ids, carried per-vertex and branched on in the shader.
const M_STEEL = 0.0;   // painted plate, mostly gone to rust
const M_GRATE = 1.0;   // walkway grating: darker, holes implied by texture
const M_PIPE = 2.0;    // bare pipe, heavier scale
const M_CONC = 3.0;    // concrete ballast blocks
const M_HULL = 4.0;    // lofted pressure hull: plated, seamed, painted
const M_GLASS = 5.0;   // viewport
export const MAT = { STEEL: M_STEEL, GRATE: M_GRATE, PIPE: M_PIPE, CONC: M_CONC, HULL: M_HULL, GLASS: M_GLASS };

export class Welder {
  constructor() {
    this.pos = []; this.nrm = []; this.mat = []; this.wear = []; this.uv = []; this.idx = [];
    this.ext = [];
    this.v = 0;
  }

  /* Local surface coordinates, per face.
   *
   * Needed because bar grating is directional and the walkways are yawed at
   * arbitrary angles. Keyed to world axes the slots ignore the walkway and the
   * deck reads as ceramic tile; keyed to the panel's own axes they run along it
   * the way rolled steel actually does. Two floats a vertex to stop a handrail
   * looking like a bathroom floor. */
  /* `ex, ey` are the face's own half-extents, in the same metres as the UV.
   *
   * Added because "chipped along every edge people knock" cannot be written
   * without knowing where the edge is. Faked with fbm it produces chips in the
   * middle of panels, which reads as dirt rather than as damage — wear is
   * positional, and the position it cares about is the rim. With the extents in
   * hand the shader gets `edge = 1 - min(dist to either edge)/w` for free, and
   * that one term drives chamfers, bolt rings, recessed door panels and paint
   * loss all at once. Two more floats a vertex to stop a locker looking like a
   * printed box. */
  _push(x, y, z, nx, ny, nz, m, w, u = 0, v = 0, ex = 0, ey = 0) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz);
    this.mat.push(m); this.wear.push(w); this.uv.push(u, v); this.ext.push(ex, ey);
    return this.v++;
  }

  /** Axis-aligned box, then yawed about its own centre. */
  box(cx, cy, cz, sx, sy, sz, yaw = 0, m = M_STEEL, wear = 0.5) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rot = (x, z) => [x * c - z * s, x * s + z * c];
    // six faces, each with its own normal — sharing vertices would smooth the
    // edges, and a handrail with rounded corners reads as plastic
    const faces = [
      [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [0, 0, 1]],
      [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [0, 0, -1]],
      [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [1, 0, 0]],
      [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-1, 0, 0]],
      [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], [0, 1, 0]],
      [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0]],
    ];
    for (const f of faces) {
      const [nx0, ny0, nz0] = f[4];
      const [rnx, rnz] = rot(nx0, nz0);
      const base = this.v;
      // Face-local UVs in metres: pick the two axes the face actually spans.
      const uvOf = (px, py, pz) => (
        Math.abs(ny0) > 0.5 ? [px, pz]
          : Math.abs(nx0) > 0.5 ? [pz, py]
            : [px, py]
      );
      // The same two axes, as half-extents, so the shader knows where the rim is.
      const [ex, ey] = Math.abs(ny0) > 0.5 ? [hx, hz]
        : Math.abs(nx0) > 0.5 ? [hz, hy]
          : [hx, hy];
      for (let k = 0; k < 4; k++) {
        const [px, py, pz] = f[k];
        const [rx, rz] = rot(px, pz);
        const [uu, vv] = uvOf(px, py, pz);
        this._push(cx + rx, cy + py, cz + rz, rnx, ny0, rnz, m, wear, uu, vv, ex, ey);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Cylinder between two points. Sides only — the ends are never seen. */
  tube(x0, y0, z0, x1, y1, z1, r, sides = 8, m = M_PIPE, wear = 0.5) {
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const len = Math.hypot(ax, ay, az) || 1e-4;
    const d = [ax / len, ay / len, az / len];
    // Any vector not parallel to the axis will do for the first tangent.
    let up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [
      d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0],
    ];
    const ul = Math.hypot(...u) || 1e-4;
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    const w = [
      d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0],
    ];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const ring = (a) => {
        const nx = u[0] * Math.cos(a) + w[0] * Math.sin(a);
        const ny = u[1] * Math.cos(a) + w[1] * Math.sin(a);
        const nz = u[2] * Math.cos(a) + w[2] * Math.sin(a);
        return [nx, ny, nz];
      };
      const n0 = ring(a0), n1 = ring(a1);
      const base = this.v;
      /* Surface coordinates on a pipe: arc length around, metres along.
       *
       * These were left at zero, which meant every tube in the game — every
       * handrail, every pipe run, the whole ladder — sampled its material at one
       * single point and came back perfectly uniform. A pipe with no coordinate
       * cannot have a seam weld, a flange, or scale that runs along it, so it
       * reads as a smooth plastic rod no matter what the fragment shader does.
       * Arc length rather than angle, so the texel size is the same on a 4 cm
       * rung and a 30 cm main. */
      /* Half-extent -1 on the u axis means "this direction wraps".
       *
       * A cylinder has no rim going round it, and saying so matters: the painted
       * case material derives its chipping, its bolt band and its chamfer from
       * the distance to the nearest edge, and for a tube the u coordinate runs
       * 0..2*pi*r while the half-extent was a single facet's width. So
       * `ext.x - abs(u)` came out negative at nearly every fragment and the
       * shader treated the entire surface of an air bottle as a knocked corner —
       * which is exactly why the two HP bottles were the flattest, most
       * featureless objects in the machinery space. The axial extent is real and
       * stays; the circumferential one is now flagged as absent. */
      const uA = a0 * r, uB = a1 * r, hl = len / 2;
      this._push(x0 + n0[0] * r, y0 + n0[1] * r, z0 + n0[2] * r, n0[0], n0[1], n0[2], m, wear, uA, -hl, -1, hl);
      this._push(x0 + n1[0] * r, y0 + n1[1] * r, z0 + n1[2] * r, n1[0], n1[1], n1[2], m, wear, uB, -hl, -1, hl);
      this._push(x1 + n1[0] * r, y1 + n1[1] * r, z1 + n1[2] * r, n1[0], n1[1], n1[2], m, wear, uB, hl, -1, hl);
      this._push(x1 + n0[0] * r, y1 + n0[1] * r, z1 + n0[2] * r, n0[0], n0[1], n0[2], m, wear, uA, hl, -1, hl);
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Flat disc facing +Z or -Z. For capping an opening with glass. */
  disc(cx, cy, cz, r, sides = 32, face = 1, m = M_GLASS, wear = 0.3) {
    const c = this._push(cx, cy, cz, 0, 0, face, m, wear, 0, 0, r, r);
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const p = (a) => this._push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz,
        0, 0, face, m, wear, Math.cos(a) * r, Math.sin(a) * r, r, r);
      const v0 = p(a0), v1 = p(a1);
      if (face > 0) this.idx.push(c, v0, v1); else this.idx.push(c, v1, v0);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    g.setAttribute('aWear', new THREE.Float32BufferAttribute(this.wear, 1));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aExt', new THREE.Float32BufferAttribute(this.ext, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/* ---------------------------------------------------------------- assemblies */

/** Walkway: grating deck on cross-bearers, stanchions and a top rail each side. */
function catwalk(W, rand, x0, z0, x1, z1, y, width = 2.1) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const ux = dx / len, uz = dz / len;
  const px = -uz, pz = ux;                       // perpendicular, in plan
  const bays = Math.max(1, Math.round(len / 2.4));

  for (let i = 0; i < bays; i++) {
    const t0 = i / bays, tc = (i + 0.5) / bays;
    const cx = x0 + dx * tc, cz = z0 + dz * tc;
    /* Sag, plus a bay that has given way entirely.
     *
     * A perfectly level walkway four hundred metres down has not been there
     * long. The catenary is what says decades; the missing bay is what says
     * nobody is maintaining it, and it costs one branch. */
    const sag = -1.5 * Math.sin(Math.PI * tc) * (0.6 + 0.8 * rand());
    const gone = rand() < 0.11;
    if (!gone) {
      W.box(cx, y + sag, cz, width, 0.10, 2.3, yaw, M_GRATE, 0.4 + 0.5 * rand());
    }
    // cross-bearer under the deck
    W.box(cx, y + sag - 0.16, cz, width + 0.16, 0.16, 0.14, yaw, M_STEEL, 0.6);

    // stanchions and rails, both sides
    for (const side of [-1, 1]) {
      const sx = cx + px * (width / 2) * side, sz = cz + pz * (width / 2) * side;
      const standing = rand() > 0.13;
      if (standing) {
        W.box(sx, y + sag + 0.52, sz, 0.09, 1.04, 0.09, yaw, M_STEEL, 0.7);
        // top rail spans the bay
        W.tube(sx - ux * 1.15, y + sag + 1.02, sz - uz * 1.15,
               sx + ux * 1.15, y + sag + 1.02, sz + uz * 1.15,
               0.045, 6, M_PIPE, 0.8);
      }
    }
  }

  // Legs down to the seabed, every few bays.
  for (let i = 0; i <= bays; i += 3) {
    const tc = i / bays;
    const cx = x0 + dx * tc, cz = z0 + dz * tc;
    const sag = -1.5 * Math.sin(Math.PI * tc);
    for (const side of [-1, 1]) {
      const lx = cx + px * (width / 2 - 0.2) * side, lz = cz + pz * (width / 2 - 0.2) * side;
      const gy = seabedHeight(lx, lz);
      if (y + sag - gy > 0.6) {
        W.tube(lx, y + sag - 0.2, lz, lx, gy - 0.4, lz, 0.11, 6, M_PIPE, 0.75);
      }
    }
  }
  return { yaw, ux, uz, px, pz, len };
}

/** Lattice tower: four legs, horizontal rings, diagonal bracing. */
function truss(W, rand, x, z, h, side = 1.9) {
  const gy = seabedHeight(x, z);
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [
    x + a * side / 2, z + b * side / 2,
  ]);
  for (const [lx, lz] of legs) {
    W.tube(lx, gy - 0.5, lz, lx, gy + h, lz, 0.10, 6, M_PIPE, 0.7);
  }
  const rings = Math.max(2, Math.round(h / 2.6));
  for (let r = 0; r <= rings; r++) {
    const ry = gy + (h * r) / rings;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
      W.tube(ax, ry, az, bx, ry, bz, 0.055, 5, M_PIPE, 0.8);
      // one diagonal per face per bay, alternating direction
      if (r < rings) {
        const ny = gy + (h * (r + 1)) / rings;
        const flip = (r + i) % 2 === 0;
        if (flip) W.tube(ax, ry, az, bx, ny, bz, 0.045, 4, M_PIPE, 0.85);
        else W.tube(bx, ry, bz, ax, ny, az, 0.045, 4, M_PIPE, 0.85);
      }
    }
  }
  return { top: gy + h };
}

/** Pipe run on concrete saddles. */
function pipeRun(W, rand, x0, z0, x1, z1, r = 0.34) {
  const n = 7;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const y = seabedHeight(x, z) + r + 0.5;
    if (prev) {
      W.tube(prev[0], prev[1], prev[2], x, y, z, r, 10, M_PIPE, 0.6 + 0.35 * rand());
      // flange at the joint
      W.tube(x, y, z, x + (x - prev[0]) * 0.04, y, z + (z - prev[2]) * 0.04,
             r * 1.35, 10, M_STEEL, 0.7);
    }
    W.box(x, seabedHeight(x, z) + 0.25, z, 0.9, 0.5, 0.7, 0, M_CONC, 0.5);
    prev = [x, y, z];
  }
}

/** Scattered plate, drum and girder debris. */
function debris(W, rand, cx, cz, spread, count) {
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * spread;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    const gy = seabedHeight(x, z);
    const kind = rand();
    const yaw = rand() * Math.PI * 2;
    if (kind < 0.45) {
      // hull plate, half buried and tilted
      W.box(x, gy + 0.08, z, 1.4 + rand() * 2.6, 0.09, 1.0 + rand() * 1.8, yaw, M_STEEL, 0.8);
    } else if (kind < 0.75) {
      // drum lying over
      W.tube(x, gy + 0.32, z, x + Math.cos(yaw) * 0.85, gy + 0.32, z + Math.sin(yaw) * 0.85,
             0.32, 9, M_PIPE, 0.85);
    } else {
      // girder, one end in the silt
      W.box(x, gy + 0.5 + rand() * 0.6, z, 0.22, 0.22, 2.5 + rand() * 3.5, yaw, M_STEEL, 0.75);
    }
  }
}

/* ------------------------------------------------------------------- material */

export function structureMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uExt: { value: new THREE.Vector3() },
      uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() },
      uScat: { value: new THREE.Vector3() },
      uSurfaceIrr: { value: new THREE.Vector3() },
      uSurfaceY: { value: 0 },
      uScatterGain: { value: 1 },
      uAmbientFloor: { value: new THREE.Vector3() },
      uLampPos: { value: new THREE.Vector3() },
      uLampDir: { value: new THREE.Vector3(0, 0, -1) },
      uLampCol: { value: new THREE.Vector3(1, 0.97, 0.92) },
      /* These three are the live values, not the historical ones.
       *
       * They read 90, cos(0.42) and 0.30 until this migration - a tenth of the
       * intensity and a 24 degree cone against the real 84.8 - and it never
       * showed because Env.applyTo overwrites them every tick. A default that
       * is only ever wrong when something else fails is a trap laid for the
       * next failure, not a default. */
      uLampInt: { value: 900 },
      uLampCos: { value: Math.cos(0.74) },
      uLampSoft: { value: 0.34 },
      /* The shadow block, with the map absent and the test off, so the material
       * compiles and renders standalone; main.js binds the map and raises
       * uShadowOn once the pass exists. Same defaults as terrain.js, and for
       * the same reason. */
      uShadowMap: { value: null },
      uLampVP: { value: new THREE.Matrix4() },
      uShadowSize: { value: 1024 },
      uShadowTanHalf: { value: Math.tan(0.74) },
      uShadowNear: { value: 0.25 },
      uShadowFar: { value: 30 },
      uShadowOn: { value: 0 },
      uShadowBiasScale: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aMat; attribute float aWear; attribute vec2 aUV;
      varying vec3 vW; varying vec3 vN; varying float vMat; varying float vWear;
      varying vec2 vUV;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal);
        vMat = aMat; vWear = aWear; vUV = aUV;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      ${LAMP}
      varying vec3 vW; varying vec3 vN; varying float vMat; varying float vWear;
      varying vec2 vUV;
      uniform float uTime;

      void main(){
        float dist = length(cameraPosition - vW);
        float fine = exp(-dist * 0.55);
        float mid  = exp(-dist * 0.11);

        /* Triplanar, because none of this geometry has UVs.
         *
         * Boxes and tubes are welded straight into world space with no texture
         * coordinates at all, so the material has to be a function of position.
         * Blending three world-plane projections by the normal costs three noise
         * lookups instead of one and avoids the stretching a single projection
         * gives on vertical faces — which on a handrail is the whole surface. */
        vec3 an = abs(vN);
        vec3 bw = an / max(an.x + an.y + an.z, 1e-4);
        float sc = 2.6;
        float pat = bw.x * fbm(vW.zy*sc, 2) + bw.y * fbm(vW.xz*sc, 2) + bw.z * fbm(vW.xy*sc, 2);
        float pat2 = bw.x * vnoise(vW.zy*13.0) + bw.y * vnoise(vW.xz*13.0) + bw.z * vnoise(vW.xy*13.0);

        bool isGrate = vMat > 0.5 && vMat < 1.5;
        bool isConc  = vMat > 2.5;

        // Base substrate.
        vec3 steel = vec3(0.084, 0.086, 0.090);
        vec3 conc  = vec3(0.132, 0.129, 0.120);
        vec3 alb = isConc ? conc : steel;

        /* Rust, and it grows from the wet places.
         *
         * Weighted downward: water sits and drips, so corrosion runs from the
         * undersides and lower edges upward, not evenly over everything. Rust is
         * also brighter and warmer than the steel under it, which is what makes
         * it read at all in water that has already removed the red — the lamp is
         * the only thing that puts red back, so rust only shows where the lamp
         * reaches. That is a real and useful coupling: corrosion is a detail you
         * discover by going close, not something visible across the room. */
        float wet = clamp(0.55 - vN.y*0.55, 0.0, 1.0);
        float rust = smoothstep(0.34, 0.72, pat*0.75 + wet*0.5 + vWear*0.35);
        vec3 rustCol = mix(vec3(0.152, 0.074, 0.036), vec3(0.226, 0.121, 0.058), pat2);
        alb = mix(alb, rustCol, rust * (isConc ? 0.35 : 0.92));

        // Surviving paint: hazard yellow, mostly gone. Sparse on purpose.
        float paint = (1.0 - rust) * smoothstep(0.62, 0.78, pat) * (1.0 - vWear);
        alb = mix(alb, vec3(0.196, 0.150, 0.036), paint * 0.75);

        /* Biofouling and barnacles.
         *
         * Encrustation is what turns "a metal box" into "a metal box that has been
         * here thirty years", and it is the single most valuable detail on the
         * whole structure. Barnacles favour upward faces and edges; the film
         * favours everything. Both fade with distance, like every other fine
         * term, so they never alias. */
        float film = smoothstep(0.40, 0.80, pat) * clamp(vN.y*0.6+0.4, 0.0, 1.0);
        alb = mix(alb, vec3(0.062, 0.086, 0.054), film * 0.42);
        float barn = smoothstep(0.72, 0.95, pat2) * clamp(vN.y, 0.0, 1.0);
        alb = mix(alb, vec3(0.30, 0.295, 0.268), barn * 0.85 * mid);

        /* Plate seams on the lofted hull.
         *
         * A loft gives one continuous surface, which is correct and also reads as
         * a single moulded pod unless the plating is put back. The UVs carry arc
         * position and length in metres, so a seam every bay in each direction
         * lands where a welded strake actually would — and the dark line is a
         * recess catching no light, not a painted stripe. */
        if (vMat > 3.5 && vMat < 4.5) {
          float seamU = abs(fract(vUV.x * 1.0) - 0.5) * 2.0;
          float seamV = abs(fract(vUV.y * 0.62) - 0.5) * 2.0;
          float seam = min(smoothstep(0.0, 0.14, seamU), smoothstep(0.0, 0.09, seamV));
          alb *= 0.46 + 0.54 * seam;
          // Weld beads sit slightly proud and catch the lamp along their length.
          float bead = (1.0 - smoothstep(0.02, 0.12, seamV)) * 0.5;
          alb += vec3(0.035) * bead * mid;
        }

        // Grating reads darker and stripier than plate.
        if (isGrate) {
          /* Bar grating, in the panel's own coordinates.
           *
           * Load-bearing bars every 3 cm one way, thin cross rods every 15 cm the
           * other, and the space between them nearly black because it is a hole
           * with four hundred metres of water behind it. Two comparable sine
           * fields multiplied in world space gave a quilt; this gives slots. */
          float slot = abs(fract(vUV.x * 33.0) - 0.5) * 2.0;   // 0 at slot centre
          float rod  = abs(fract(vUV.y * 6.5) - 0.5) * 2.0;
          float solid = max(smoothstep(0.34, 0.62, slot), smoothstep(0.80, 0.94, rod));
          alb *= 0.10 + 0.90 * solid;
        }

        /* Normals perturbed by the same fields that colour it.
         *
         * Barnacles that are only a colour read as a decal. Deriving the bump
         * from the encrustation pattern means the lamp catches the crust and the
         * shape agrees with the shading. */
        float e = 0.05;
        float b0 = pat2;
        float bx = bw.x * vnoise((vW.zy+vec2(e,0.0))*13.0) + bw.y * vnoise((vW.xz+vec2(e,0.0))*13.0) + bw.z * vnoise((vW.xy+vec2(e,0.0))*13.0);
        float bz = bw.x * vnoise((vW.zy+vec2(0.0,e))*13.0) + bw.y * vnoise((vW.xz+vec2(0.0,e))*13.0) + bw.z * vnoise((vW.xy+vec2(0.0,e))*13.0);
        vec3 n = normalize(vN + vec3(-(bx-b0)/e, 0.0, -(bz-b0)/e) * 0.10 * mid);

        // Lamp: cone, finite-size falloff, attenuation both ways.
        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = lampCone(L);
        float atten = uLampInt / (6.0 + dL*dL*1.0);
        float ndl = max(dot(n, L), 0.0);
        /* The occlusion term multiplies the lamp itself, so it takes the wet
         * specular below with it. A highlight surviving inside a shadow is the
         * classic tell of a shadow bolted onto diffuse only, and on wet metal -
         * which is nearly all specular at grazing angles - it would be the most
         * visible thing in the frame. */
        vec3 lamp = uLampCol * atten * cone * lampTransmit(dL) * lampShadow(vW, n);
        vec3 lit = alb * lamp * ndl;

        /* Wet specular. Submerged metal is always wet, and the sheen is the
         * strongest single cue that a surface is metal rather than stone — but
         * rust and crust are matte, so it has to be masked by them or the whole
         * structure looks freshly galvanised. */
        vec3 V = normalize(cameraPosition - vW);
        vec3 H = normalize(V + L);
        float gloss = (1.0 - rust*0.85) * (1.0 - film*0.7) * (isConc ? 0.15 : 1.0);
        /* Narrower and weaker. At 0.55 the handrails blew to flat white wherever the
         * lamp caught them square, which loses the very silhouette they exist to
         * provide — a wet-metal cue that erases the metal is not a cue. */
        float spec = pow(max(dot(n, H), 0.0), 68.0) * gloss * 0.22;
        lit += lamp * spec;

        lit += alb * ambientAt(vW.y) * (0.28 + 0.6*clamp(n.y*0.5+0.5, 0.0, 1.0));

        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });
}

/* --------------------------------------------------------------------- build */

/**
 * The installation on the canyon floor.
 *
 * Laid out so the walkway leads away from the lit platform into the dark, which
 * is the composition the reference frames are built on: a handrail, two red
 * lamps far off, and nothing else. Returns the mesh plus the world positions of
 * its hazard lights so the caller can add them as emissive beacons.
 */
export function buildStation(seed = SEEDS.debris) {
  const rand = rng(seed);
  const W = new Welder();
  const lights = [];
  /* Collision volumes, derived from the same locals that place the geometry.
   *
   * Swimming collided with the heightfield and nothing else, so the whole
   * installation was fog — you could pass through the platform, the towers and
   * the walkway. A dozen primitives taken from the numbers already in this
   * function arrive at the same answer a mesh collider would, and cannot drift
   * out of agreement with what is drawn. */
  const blockers = [];

  const px = 30, pz = -18;
  const deckY = seabedHeight(px, pz) + 6.4;

  // Platform: grating deck on a box frame, with legs.
  for (let i = -3; i <= 3; i++) {
    for (let j = -2; j <= 2; j++) {
      if (rand() < 0.06) continue;   // a few panels gone
      W.box(px + i * 2.2, deckY, pz + j * 2.2, 2.15, 0.12, 2.15, 0, M_GRATE, 0.3 + 0.6 * rand());
    }
  }
  for (let i = -3; i <= 3; i++) {
    W.box(px + i * 2.2, deckY - 0.22, pz, 0.18, 0.30, 11.2, 0, M_STEEL, 0.6);
  }
  // The deck as one slab, plus its four legs.
  blockers.push({ k: 'box', c: [px, deckY, pz], h: [7.8, 0.5, 5.8] });
  for (const [lx, lz] of [[-7.2, -5.2], [7.2, -5.2], [7.2, 5.2], [-7.2, 5.2]]) {
    const gx = px + lx, gz = pz + lz;
    const gy = seabedHeight(gx, gz);
    W.tube(gx, deckY - 0.3, gz, gx, gy - 0.6, gz, 0.19, 8, M_PIPE, 0.7);
    W.box(gx, gy + 0.3, gz, 1.5, 0.6, 1.5, 0, M_CONC, 0.4);
    blockers.push({ k: 'cap', a: [gx, gy, gz], b: [gx, deckY, gz], r: 0.45 });
  }
  // Handrail around three sides of the deck, so the fourth reads as the way on.
  for (let i = -3; i <= 3; i++) {
    const sx = px + i * 2.2;
    W.box(sx, deckY + 0.58, pz - 5.6, 0.09, 1.05, 0.09, 0, M_STEEL, 0.7);
    W.tube(sx - 1.1, deckY + 1.06, pz - 5.6, sx + 1.1, deckY + 1.06, pz - 5.6, 0.045, 6, M_PIPE, 0.8);
  }

  // Two towers, and their lamps are the far red points in the dark.
  const tA = truss(W, rand, px - 9.5, pz + 2.0, 17 + rand() * 4);
  const tB = truss(W, rand, px + 9.0, pz - 7.5, 13 + rand() * 4);
  for (const [tx, tz, top] of [[px - 9.5, pz + 2.0, tA.top], [px + 9.0, pz - 7.5, tB.top]]) {
    blockers.push({ k: 'cap', a: [tx, seabedHeight(tx, tz) - 0.5, tz], b: [tx, top, tz], r: 1.5 });
  }
  lights.push({ pos: [px - 9.5, tA.top + 0.4, pz + 2.0], col: [300, 42, 16], size: 0.28 });
  lights.push({ pos: [px + 9.0, tB.top + 0.4, pz - 7.5], col: [300, 42, 16], size: 0.28 });

  /* The walkway out into nothing. Its blocker is a capsule along the run rather
   * than a box, because the walkway is yawed and an axis-aligned box round a
   * diagonal 80 m long would wall off a quarter of the canyon. */
  catwalk(W, rand, px, pz + 6.2, px - 26, pz + 74, deckY - 0.4);
  blockers.push({ k: 'cap', a: [px, deckY - 0.4, pz + 6.2], b: [px - 26, deckY - 0.4, pz + 74], r: 1.3 });
  // A second, shorter run at an angle, half collapsed.
  catwalk(W, rand, px - 6, pz - 6.5, px - 44, pz - 30, deckY - 1.8);
  blockers.push({ k: 'cap', a: [px - 6, deckY - 1.8, pz - 6.5], b: [px - 44, deckY - 1.8, pz - 30], r: 1.3 });

  // Two working lamps on the deck: something has power, which is worse.
  lights.push({ pos: [px - 5.5, deckY + 1.9, pz + 4.6], col: [150, 190, 205], size: 0.34 });
  lights.push({ pos: [px + 4.0, deckY + 1.9, pz - 3.0], col: [110, 140, 152], size: 0.26 });

  pipeRun(W, rand, px + 6, pz + 8, px + 52, pz + 62);
  debris(W, rand, px, pz, 26, 34);
  debris(W, rand, px - 30, pz + 50, 18, 16);

  const geo = W.geometry();
  const mesh = new THREE.Mesh(geo, structureMaterial());
  mesh.frustumCulled = false;
  mesh.name = 'station';
  return { mesh, lights, blockers };
}
