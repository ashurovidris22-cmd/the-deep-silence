import * as THREE from 'three';
import { NOISE, WATER } from './glsl.js';
import { seabedHeight, lightAt, lightAtDepth, SEA_LEVEL } from './terrain.js';
import { rng, SEEDS } from './rng.js';

/* Benthic cover, in three bands, and the middle decision here is a biological
 * one rather than an artistic one.
 *
 * The brief was "vegetation on the seabed". Taken literally on the canyon floor
 * it cannot be done, and the reason is already written into this project: kelp
 * is restricted to the shelf precisely because a photosynthetic organism four
 * hundred metres down would quietly tell the player that none of the optics
 * mean anything. The absorption curve is the one thing here that is not
 * art-directed; putting a plant below the euphotic zone spends its entire
 * credibility for one frame of greenery.
 *
 * So the floor gets what actually grows there, and it happens to look like a
 * garden anyway. Sea pens are feathers on stalks. Glass sponges are white
 * vases. Crinoids are lilies — the common name is "sea lily" and it is not a
 * stretch. Whip corals are three metres of single unbranched stem. All of them
 * are animals, all of them are sessile, all of them read to the eye as flora,
 * and none of them needs a single photon to justify being there.
 *
 * They also solve the composition problem that the station was built to solve,
 * and more cheaply. From the commit that added the steel: "a technically
 * correct render of a canyon floor is a technically correct render of an empty
 * room". Steel fixed that with straight lines. This fixes it with something the
 * lamp can pick out at two metres and lose at eight — near-field silhouette,
 * which is the layer the reference frames are actually built from.
 *
 *   shelf   0-70 m     kelp (already) over a turf understory
 *   slope   70-168 m   the same turf, thinning, reddening, then gone
 *   floor   250 m +    pens, sponges, whips. Bioluminescence as the only accent
 *
 * The band edges are a ramp rather than a threshold. A boolean photic test puts
 * a shaved line across the canyon wall; a ramp gives the descent the thing the
 * terrain notes already ask for — vegetation thins out, then stops, and after
 * that it is rock and silt.
 */

const COMMON_UNIFORMS = () => ({
  uExt: { value: new THREE.Vector3() },
  uKd: { value: new THREE.Vector3() },
  uAlbedo: { value: new THREE.Vector3() },
  uSurfaceIrr: { value: new THREE.Vector3() },
  uSurfaceY: { value: 0 },
  uScatterGain: { value: 1 },
  uAmbientFloor: { value: new THREE.Vector3() },
  uLampPos: { value: new THREE.Vector3() },
  uLampDir: { value: new THREE.Vector3(0, 0, -1) },
  uLampCol: { value: new THREE.Vector3(1, 0.97, 0.92) },
  uLampInt: { value: 90 },
  uLampCos: { value: Math.cos(0.42) },
  uLampSoft: { value: 0.30 },
  uTime: { value: 0 },
});

const smoothstep01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function blocked(clear, x, z) {
  for (const c of clear) {
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) return true;
  }
  return false;
}

/* Low-frequency field for patchiness. Two octaves is plenty — this only has to
 * say "here, not there" at a scale of tens of metres. */
function h2(ix, iy) {
  let n = ix * 374761393 + iy * 668265263;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function patchNoise(x, y) {
  let a = 0.6, sum = 0, norm = 0;
  for (let o = 0; o < 3; o++) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const t = h2(ix, iy) + (h2(ix + 1, iy) - h2(ix, iy)) * sx;
    const b = h2(ix, iy + 1) + (h2(ix + 1, iy + 1) - h2(ix, iy + 1)) * sx;
    sum += a * (t + (b - t) * sy); norm += a;
    x *= 2.07; y *= 2.07; a *= 0.5;
  }
  return sum / norm;
}

const slopeAt = (x, z) => {
  const e = 2.5;
  const dx = seabedHeight(x + e, z) - seabedHeight(x - e, z);
  const dz = seabedHeight(x, z + e) - seabedHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
};

/**
 * Jittered-grid scatter with a per-site acceptance probability.
 *
 * The grid is not a stylistic choice, it is the fix for a bug that invalidated
 * a whole review round: uniform random over a disc has uniform *expected*
 * density and, at these counts, violently uneven actual density — and once the
 * placement was finally seeded and therefore reproducible, the bald patch
 * turned out to sit exactly where the hero camera stands. One site per cell,
 * jittered inside it, is a two-line Poisson approximation.
 *
 * Sessile benthos wants this anyway. Everything here is a filter feeder
 * competing for the same current, so real colonies end up roughly evenly spaced
 * for the same reason kelp does.
 */
function scatter(opts) {
  const {
    seed, centre, radius, sites, clear = [], maxSlope = 0.70,
    density = () => 1, jitter = 0.85, perSite = 1, spread = 0,
  } = opts;
  const rand = rng(seed);
  const out = [];
  const cell = Math.sqrt((Math.PI * radius * radius) / sites);
  const half = Math.ceil(radius / cell);
  for (let gx = -half; gx <= half; gx++) {
    for (let gz = -half; gz <= half; gz++) {
      const lx = (gx + (rand() - 0.5) * jitter) * cell;
      const lz = (gz + (rand() - 0.5) * jitter) * cell;
      if (lx * lx + lz * lz > radius * radius) continue;
      const cx = lx + centre.x, cz = lz + centre.z;
      const n = perSite > 1 ? 1 + ((rand() * perSite) | 0) : 1;
      for (let i = 0; i < n; i++) {
        const x = cx + (rand() - 0.5) * spread;
        const z = cz + (rand() - 0.5) * spread;
        // Draw for every candidate whether it is used or not, so that changing
        // the density function cannot reshuffle the sites that survive it.
        const roll = rand(), s1 = rand(), s2 = rand(), s3 = rand(), s4 = rand();
        /* Cheap tests first, and this is not micro-optimisation.
         *
         * Getting a proper field density means an 1.8 m cell over a 105 m disc,
         * which is thirty thousand candidate sites per species. `slopeAt` costs
         * four `seabedHeight` calls and `seabedHeight` is a dozen octaves of
         * noise, so evaluating it for every candidate is half a million noise
         * evaluations per species at load. The height is needed anyway, so it
         * is taken once and handed to the density function; the slope is only
         * paid for by sites that have already survived everything else. */
        const y = seabedHeight(x, z);
        if (roll > density(x, z, y)) continue;
        if (blocked(clear, x, z)) continue;
        if (slopeAt(x, z) > maxSlope) continue;
        out.push({ x, z, y, r: [s1, s2, s3, s4] });
      }
    }
  }
  return out;
}

/** Wire an instanced geometry from a site list plus named per-instance arrays. */
function instance(base, sites, attrs) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  if (base.attributes.normal) geo.attributes.normal = base.attributes.normal;
  if (base.attributes.uv) geo.attributes.uv = base.attributes.uv;
  const N = sites.length;
  for (const [name, size, fill] of attrs) {
    const arr = new Float32Array(N * size);
    sites.forEach((s, i) => fill(arr, i * size, s, i));
    geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  }
  geo.instanceCount = N;
  return geo;
}

/* ------------------------------------------------------------------- turf
 *
 * The understory, and the thing the shelf was actually missing.
 *
 * Kelp on bare sediment is a stand of masts in a car park: the canopy reads,
 * and then the eye follows a stipe down to nothing. Real kelp forest floor is
 * continuous — coralline crust, red turf, seagrass in the sand patches — and
 * the reason it matters here is scale. A 30 cm tuft at one metre is the only
 * object in a shelf frame small enough to tell you how big everything else is.
 */
export function buildTurf(clear = [], centre = { x: 403, z: 12 }, radius = 58, sites = 3600) {
  const base = new THREE.PlaneGeometry(1, 1, 1, 2);
  base.translate(0, 0.5, 0);

  const list = scatter({
    seed: SEEDS.turf, centre, radius, sites, clear, maxSlope: 0.95,
    perSite: 12, spread: 1.5,
    /* Density follows the light, and the ramp is the whole point of the band.
     * Squared, because cover falls off faster than irradiance does — a plant
     * needs a surplus over its own respiration, not merely a photon. */
    density: (x, z, y) => Math.pow(lightAtDepth(SEA_LEVEL - y), 1.7) * 0.96,
  });

  const geo = instance(base, list, [
    ['aPos', 3, (a, o, s) => { a[o] = s.x; a[o + 1] = s.y - 0.04; a[o + 2] = s.z; }],
    ['aSize', 2, (a, o, s) => {
      a[o] = 0.060 + s.r[0] * 0.140;
      /* Heavy tail rather than a wider uniform range.
       *
       * Real turf is mostly short with occasional tall blades pushing through,
       * and the tall ones are what actually read at four or five metres — a
       * uniform 30 cm sward is a texture, whereas the same mean with a few
       * 90 cm blades in it is a plant community. Same trick as the boulders. */
      a[o + 1] = 0.13 + Math.pow(s.r[1], 2.2) * 0.82;
    }],
    ['aYaw', 1, (a, o, s) => { a[o] = s.r[2] * Math.PI * 2; }],
    ['aVar', 2, (a, o, s, i) => {
      a[o] = s.r[3] * 100;                       // phase
      // Redder with depth: at the bottom of the band the surviving pigments are
      // phycoerythrins, which are the wrong colour for a green so they read
      // brown-black under a lamp. Sampled once here rather than per-fragment.
      a[o + 1] = 1 - Math.min(1, lightAt(s.x, s.z) * 1.25);
    }],
  ]);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec2 aSize; attribute float aYaw; attribute vec2 aVar;
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vRed; varying float vPh;
      void main(){
        float up = uv.y;
        vUp = up; vRed = aVar.y; vPh = aVar.x;
        // Wider at the base, pointed, and never quite zero — a blade that
        // reaches zero width aliases into a dashed line and the chromatic
        // aberration in the composite then splits the dashes into red and blue.
        float taper = max(1.0 - 0.86 * pow(up, 1.5), 0.18);
        vec3 p = vec3(position.x * aSize.x * taper, up * aSize.y, 0.0);
        /* Turf lies over rather than standing up — short blades bend under their
         * own weight and the current, which is what stops it reading as
         * bristles. Pulled back from 0.55 to 0.36: at the heavier lean a 40 cm
         * blade presented about 15 cm of height to a camera two metres up, and
         * the whole understory foreshortened itself into the sediment. */
        p.z += pow(up, 1.6) * aSize.y * 0.36;
        float t = uTime * 0.55 + aVar.x;
        p.x += sin(t) * up * up * aSize.y * 0.16;
        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        vW = aPos + r;
        vN = normalize(vec3(s * 0.6, 0.62, c * 0.6));
        gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vRed; varying float vPh;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      uniform float uTime;
      void main(){
        vec3 green = mix(vec3(0.040,0.068,0.036), vec3(0.070,0.098,0.044), fract(vPh*0.37));
        vec3 red   = mix(vec3(0.062,0.030,0.028), vec3(0.086,0.044,0.030), fract(vPh*0.71));
        vec3 alb = mix(green, red, vRed);
        alb *= 0.58 + 0.62 * vUp;
        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL);
        float ndl = abs(dot(vN, L));
        float trans = pow(max(dot(-vN, L), 0.0), 2.0) * 0.55;
        vec3 lit = alb * uLampCol * (ndl + trans) * atten * cone * lampTransmit(dL);
        vec3 day = ambientAt(vW.y);
        lit += alb * day * (0.20 + 0.62*vUp);
        lit += alb * day * caustic(vW.xz, uTime) * 1.5 * vUp;
        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'turf';
  return m;
}

/* -------------------------------------------------------------------- pens
 *
 * Sea pens: a fleshy quill driven into the silt, pinnules up both sides.
 *
 * These are the single best answer to "vegetation on the abyssal floor". They
 * are colonial anthozoans, they are shaped exactly like the feather a quill pen
 * is cut from, they stand half a metre to a metre and a half, and they live in
 * loose fields on exactly this kind of soft bottom. They also bioluminesce — a
 * wave of green-blue that runs up the rachis when something touches them, which
 * is both real and the only accent colour the art direction permits.
 *
 * Built as real pinnule geometry rather than a textured billboard because the
 * silhouette is the entire recognition cue, and a lamp at two metres in water
 * with twenty metres of visibility gives you silhouette and nothing else.
 */
function penGeometry() {
  const pos = [], nrm = [], uvs = [], idx = [];
  let v = 0;
  const put = (x, y, z, nx, ny, nz, u, w) => {
    pos.push(x, y, z); nrm.push(nx, ny, nz); uvs.push(u, w); return v++;
  };
  const face = (a, b, c, d) => idx.push(a, b, c, a, c, d);

  // Rachis: the central stem, tapering, with a swollen peduncle at the base.
  const SEG = 5;
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG;
    const w = (t) => 0.030 * (1.35 - 0.95 * t) * (t < 0.12 ? 1.0 + (0.12 - t) * 5.0 : 1.0);
    const a = put(-w(t0), t0, 0, 0, 0, 1, 0, t0);
    const b = put(w(t0), t0, 0, 0, 0, 1, 1, t0);
    const c = put(w(t1), t1, 0, 0, 0, 1, 1, t1);
    const d = put(-w(t1), t1, 0, 0, 0, 1, 0, t1);
    face(a, b, c, d);
  }

  /* Pinnules. Longest in the middle, short at both ends — a feather, not a comb.
   * The sine over the run is what gives the whole thing its leaf silhouette, and
   * it is the difference between "sea pen" and "bottle brush". */
  const N = 11;
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const t = 0.20 + f * 0.76;
    const L = 0.34 * Math.sin(Math.PI * Math.pow(f, 0.80)) + 0.02;
    for (const s of [-1, 1]) {
      const x0 = s * 0.020, x1 = s * L;
      const y0 = t, y1 = t + L * 0.62;
      // Slight thickness offset in Z so the two rows do not coincide as one plane.
      const zo = s * 0.008;
      const nz = s * 0.35;
      const a = put(x0, y0, -zo, 0.0, -0.30, nz, 0, t);
      const b = put(x0, y0 + 0.030, zo, 0.0, 0.30, nz, 0, t);
      const c = put(x1, y1 + 0.014, zo * 0.6, 0.0, 0.30, nz, 1, t);
      const d = put(x1, y1, -zo * 0.6, 0.0, -0.30, nz, 1, t);
      face(a, b, c, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export function buildPens(clear = [], centre = { x: 20, z: 8 }, radius = 105, sites = 1050) {
  const base = penGeometry();
  const list = scatter({
    seed: SEEDS.pens, centre, radius, sites, clear, maxSlope: 0.55,
    perSite: 3, spread: 4.2,
    /* Only below the euphotic floor, only on soft ground — sea pens anchor by
     * inflating a bulb in sediment and cannot hold on rock, which is also why
     * the slope limit is tighter here than for the turf.
     *
     * And patchy, which is the fix for the first contact sheet. Spread evenly
     * at a density the triangle budget can afford, a field of pens is three
     * plants per lamp pool — present in the statistics and absent from the
     * picture. Real pennatulacean grounds are strongly clumped, because larvae
     * settle near adults, so the same total count concentrated into patches
     * thirty metres across gives frames that are either a garden or bare silt.
     * Both of those are worth looking at. A uniform sprinkle is neither. */
    density: (x, z, y) => (lightAtDepth(SEA_LEVEL - y) > 0.02 ? 0
      /* A floor of 0.18 under the patch term, not zero.
       *
       * Pure patchiness means half the canyon is bare, and "bare" is a coin
       * flip the player loses by standing in the wrong place — which is what
       * happened to the garden frame. A base rate keeps a scattering of pens
       * everywhere and lets the patches be the difference between a few and a
       * field, which is both what the seabed photographs show and a great deal
       * safer for a camera that has to be pointed somewhere. */
      : 0.18 + 0.68 * smoothstep01(0.44, 0.70, patchNoise(x * 0.021, z * 0.021))),
  });

  const geo = instance(base, list, [
    ['aPos', 3, (a, o, s) => { a[o] = s.x; a[o + 1] = s.y - 0.05; a[o + 2] = s.z; }],
    ['aSize', 2, (a, o, s) => {
      a[o] = 0.55 + s.r[0] * 0.65;                       // width scale
      a[o + 1] = 0.36 + Math.pow(s.r[1], 1.3) * 1.15;    // height, metres
    }],
    ['aYaw', 1, (a, o, s) => { a[o] = s.r[2] * Math.PI * 2; }],
    ['aVar', 2, (a, o, s) => {
      a[o] = s.r[3] * 100;                               // phase
      a[o + 1] = s.r[0] * s.r[3];                        // which ones glow
    }],
  ]);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec2 aSize; attribute float aYaw; attribute vec2 aVar;
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vAcross;
      varying float vPh; varying float vGlow;
      void main(){
        vUp = uv.y; vAcross = uv.x; vPh = aVar.x; vGlow = aVar.y;
        vec3 p = vec3(position.x * aSize.x, position.y, position.z * aSize.x) * vec3(1.0, aSize.y, 1.0);
        /* The current down here is slow and steady, not gusty. One long period,
         * amplitude going as the square of height so the peduncle stays put —
         * a stalk that slides at its base reads as a decal, and these are
         * anchored in mud by a muscular bulb that does not move at all. */
        float t = uTime * 0.21 + aVar.x;
        float amp = vUp * vUp * aSize.y * 0.13;
        p.x += sin(t) * amp;
        p.z += cos(t * 0.71) * amp * 0.7;
        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        vec3 n = normalize(normal);
        vN = normalize(vec3(n.x*c - n.z*s, n.y, n.x*s + n.z*c));
        vW = aPos + r;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vAcross;
      varying float vPh; varying float vGlow;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      uniform float uTime;
      void main(){
        /* Flesh, not plant. Sea pens are pale orange to dusty pink, and getting
         * that right is what stops the floor looking like a lawn that forgot to
         * die: this is the one place in the game where something soft and warm
         * is growing out of cold grey silt, and the colour has to say so. */
        /* Darker than the silt they stand in, not brighter.
         *
         * The first values put the albedo above the sediment's 0.216 once the
         * transmission term was added, so every pen inside the lamp pool
         * clipped to a flat white feather with no tissue in it — brighter than
         * the ground it was supposed to be silhouetted against, which inverts
         * the whole composition. Measured against the seabed rather than picked
         * for prettiness. */
        vec3 warm = mix(vec3(0.106,0.062,0.049), vec3(0.142,0.090,0.068), fract(vPh*0.41));
        vec3 pale = vec3(0.094,0.088,0.084);
        vec3 alb = mix(pale, warm, 0.35 + 0.65*vAcross);
        alb *= 0.72 + 0.42 * vUp;

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL);
        float ndl = abs(dot(vN, L));
        // Thin tissue: a pinnule lit from behind glows along its whole length.
        float trans = pow(max(dot(-vN, L), 0.0), 1.6) * 0.42;
        vec3 lit = alb * uLampCol * (ndl + trans) * atten * cone * lampTransmit(dL);
        lit += alb * ambientAt(vW.y) * (0.30 + 0.50*vUp);

        /* Bioluminescence: a wave running up the rachis, on a long period.
         *
         * Real pennatulaceans fire a peristaltic wave of blue-green light when
         * disturbed, tip to base or base to tip depending on species. It is
         * modelled as one travelling Gaussian because that is all it looks like,
         * and it is the only saturated colour permitted in the whole game.
         *
         * Only some of them, and rarely. A field that all pulses together is an
         * effect; one anemone lighting up eleven metres away while nothing else
         * does is an event, and the player will stop walking. */
        float period = 13.0;
        float ph = fract(uTime / period + vPh * 0.13);
        float firing = smoothstep(0.62, 0.78, vGlow) * smoothstep(0.34, 0.22, ph);
        float wave = exp(-pow((ph * 3.1 - vUp) / 0.17, 2.0));
        vec3 bio = vec3(0.16, 1.0, 0.62) * wave * firing * 2.6;
        lit += bio;

        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'pens';
  return m;
}

/* ----------------------------------------------------------------- sponges
 *
 * Stalked glass sponges. Hexactinellids: a silica lattice built into a vase on
 * a thin stalk, and they are almost white — which in this game makes them the
 * brightest object the lamp will ever find on the canyon floor.
 *
 * That is why they are worth their triangles. Every other deep surface here is
 * a dark value, so the lamp pool has nothing to key against and the eye has no
 * anchor for exposure. One white vase at four metres gives the frame a top end,
 * and the fog immediately becomes legible because there is finally something
 * for it to be measured against.
 */
function spongeGeometry() {
  /* Five stations, not seven. The two that went were both on the smooth part of
   * the flare, where a Catmull-smooth profile and a straight chord differ by
   * under two millimetres — a third of the triangles for a silhouette nobody
   * can tell apart at the distance a lamp reaches. */
  const prof = [
    [0.00, 0.022], [0.22, 0.032], [0.50, 0.090], [0.78, 0.112], [1.00, 0.094],
  ];
  const SIDES = 9;
  const pos = [], nrm = [], uvs = [], idx = [];
  let v = 0;
  for (let i = 0; i < prof.length - 1; i++) {
    const [t0, r0] = prof[i], [t1, r1] = prof[i + 1];
    const dr = (r1 - r0) / Math.max(t1 - t0, 1e-4);
    for (let k = 0; k < SIDES; k++) {
      const a0 = (k / SIDES) * Math.PI * 2, a1 = ((k + 1) / SIDES) * Math.PI * 2;
      const base = v;
      for (const [a, t, r] of [[a0, t0, r0], [a1, t0, r0], [a1, t1, r1], [a0, t1, r1]]) {
        // Normal of a surface of revolution: radial, tilted by the profile slope.
        const nx = Math.cos(a), nz = Math.sin(a);
        const l = Math.hypot(1, dr) || 1;
        pos.push(nx * r, t, nz * r);
        nrm.push(nx / l, -dr / l, nz / l);
        uvs.push(a / (Math.PI * 2), t);
        v++;
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

export function buildSponges(clear = [], centre = { x: 20, z: 8 }, radius = 105, sites = 520) {
  const base = spongeGeometry();
  const list = scatter({
    seed: SEEDS.sponge, centre, radius, sites, clear, maxSlope: 0.85,
    perSite: 2, spread: 2.2,
    // Sponges want hard substrate and current, so they take the steeper ground
    // the pens refuse — which conveniently puts them up the walls as well.
    density: (x, z, y) => (lightAtDepth(SEA_LEVEL - y) > 0.02 ? 0
      : 0.30 + 0.62 * smoothstep01(0.40, 0.70, patchNoise(x * 0.030 + 40, z * 0.030))),
  });

  const geo = instance(base, list, [
    ['aPos', 3, (a, o, s) => { a[o] = s.x; a[o + 1] = s.y - 0.03; a[o + 2] = s.z; }],
    ['aSize', 2, (a, o, s) => {
      a[o] = 0.70 + s.r[0] * 1.05;                        // girth
      a[o + 1] = 0.34 + Math.pow(s.r[1], 1.25) * 0.92;    // height
    }],
    ['aYaw', 1, (a, o, s) => { a[o] = s.r[2] * Math.PI * 2; }],
    ['aVar', 1, (a, o, s) => { a[o] = s.r[3]; }],
  ]);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec2 aSize; attribute float aYaw; attribute float aVar;
      varying vec3 vW; varying vec3 vN; varying vec2 vUV; varying float vVar;
      void main(){
        vUV = uv; vVar = aVar;
        vec3 p = vec3(position.x * aSize.x, position.y * aSize.y, position.z * aSize.x);
        // A slow lean, fixed per instance. Sponges do not sway — they are glass.
        p.x += pow(uv.y, 1.8) * aSize.y * 0.16 * (aVar - 0.5) * 2.0;
        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        vec3 n = normalize(normal);
        vN = normalize(vec3(n.x*c - n.z*s, n.y, n.x*s + n.z*c));
        vW = aPos + r;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying vec2 vUV; varying float vVar;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      void main(){
        float dist = length(cameraPosition - vW);
        float fine = exp(-dist * 0.42);

        /* The skeleton, drawn rather than modelled.
         *
         * A hexactinellid is a woven cage of silica spicules with holes through
         * it, at a scale of a few millimetres — no triangle budget reaches that
         * and it is the entire identity of the animal. Two crossed lattices in
         * the albedo, faded out by distance so they never alias, give the read
         * for nothing: near, it is basketwork; far, it is a pale vase. */
        vec2 q = vec2(vUV.x * 26.0, vUV.y * 15.0);
        float lx = abs(fract(q.x + q.y * 0.5) - 0.5) * 2.0;
        float ly = abs(fract(q.x - q.y * 0.5) - 0.5) * 2.0;
        float mesh = max(smoothstep(0.55, 0.95, lx), smoothstep(0.55, 0.95, ly));

        vec3 alb = mix(vec3(0.300,0.318,0.322), vec3(0.196,0.212,0.222), 1.0 - mesh);
        alb *= 0.80 + 0.34 * fbm(vUV * vec2(8.0, 5.0), 3);
        // Silt collects in the cup and along every upward-facing spicule.
        alb = mix(alb, vec3(0.166,0.156,0.132), clamp(vN.y, 0.0, 1.0) * 0.45);
        alb *= 0.70 + 0.55 * fine * mesh + 0.30 * (1.0 - fine);

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL);
        /* Wrapped hard, and a strong transmission term. Silica glass scatters
         * light through itself, so a sponge lit from any direction glows a
         * little on the side away from the lamp — the cue that says this is not
         * painted steel and not rock. */
        float ndl = clamp(dot(vN, L) * 0.5 + 0.5, 0.0, 1.0);
        float trans = pow(max(dot(-vN, L), 0.0), 1.3) * 0.7;
        vec3 lit = alb * uLampCol * (ndl + trans) * atten * cone * lampTransmit(dL);
        lit += alb * ambientAt(vW.y) * 0.55;
        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'sponges';
  return m;
}

/* ------------------------------------------------------------------- whips
 *
 * Bamboo and whip corals: one unbranched stem, up to three metres, curved by
 * the prevailing current.
 *
 * These do the job kelp does on the shelf, which is the compositional one. The
 * reference frames are a three-part sandwich — a dark shapeless thing near the
 * lens, something legible and lit behind it, nothing at all beyond. On the
 * canyon floor there was nothing tall enough to be the near shape except the
 * station, and the station is in one place. A whip coral is two metres of
 * near-black vertical line that can stand anywhere, and it costs twenty
 * triangles.
 *
 * They all lean the same way, and that is the detail worth having: a current
 * you cannot see, inferred from a hundred stems agreeing about it.
 */
function whipGeometry() {
  const SEG = 9;
  const g = new THREE.PlaneGeometry(1, 1, 1, SEG);
  g.translate(0, 0.5, 0);
  return g;
}

export function buildWhips(clear = [], centre = { x: 20, z: 8 }, radius = 105, sites = 620) {
  const base = whipGeometry();
  const list = scatter({
    seed: SEEDS.whip, centre, radius, sites, clear, maxSlope: 0.75,
    perSite: 3, spread: 3.0,
    /* Whips are the silhouette layer, so they stay comparatively even — a near
     * black vertical is wanted in most frames, not clustered into a thicket the
     * player can walk right past. */
    density: (x, z, y) => (lightAtDepth(SEA_LEVEL - y) > 0.02 ? 0
      : 0.42 + 0.46 * patchNoise(x * 0.017 + 90, z * 0.017)),
  });

  const geo = instance(base, list, [
    ['aPos', 3, (a, o, s) => { a[o] = s.x; a[o + 1] = s.y - 0.06; a[o + 2] = s.z; }],
    ['aSize', 2, (a, o, s) => {
      a[o] = 0.022 + s.r[0] * 0.030;
      a[o + 1] = 0.85 + Math.pow(s.r[1], 1.1) * 2.15;
    }],
    ['aYaw', 1, (a, o, s) => { a[o] = s.r[2] * Math.PI * 2; }],
    ['aVar', 2, (a, o, s) => { a[o] = s.r[3] * 100; a[o + 1] = s.r[0]; }],
  ]);

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec2 aSize; attribute float aYaw; attribute vec2 aVar;
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vPh;
      void main(){
        float up = uv.y;
        vUp = up; vPh = aVar.x;
        float taper = max(1.0 - 0.55 * up, 0.30);
        vec3 p = vec3(position.x * aSize.x * taper, up * aSize.y, 0.0);
        /* One shared current direction, plus a little per-stem disagreement.
         * Written in world axes before the instance yaw is applied, so the lean
         * does not rotate with the stem — otherwise every whip leans a different
         * way and the field reads as random rather than as swept. */
        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        float bend = pow(up, 1.9) * aSize.y;
        r.x += bend * 0.30;
        r.z += bend * 0.13;
        r.x += bend * 0.10 * (aVar.y - 0.5) * 2.0;
        float t = uTime * 0.17 + aVar.x;
        r.x += sin(t) * up * up * aSize.y * 0.055;
        r.z += cos(t * 0.83) * up * up * aSize.y * 0.040;
        vW = aPos + r;
        vN = normalize(vec3(s, 0.22, c));
        gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vPh;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      uniform float uTime;
      void main(){
        /* Banded, because bamboo coral is: alternating nodes of calcite and dark
         * horny gorgonin, which is where the common name comes from. It is also
         * the only length-wise pattern on the canyon floor, so it reads as scale
         * the moment the lamp crosses one. */
        float band = smoothstep(0.35, 0.65, abs(fract(vUp * 26.0 + vPh) - 0.5) * 2.0);
        vec3 alb = mix(vec3(0.030,0.034,0.036), vec3(0.128,0.126,0.116), band);
        alb *= 0.60 + 0.55 * vUp;
        // Polyps: a fine stipple along the stem, visible only up close.
        float polyp = smoothstep(0.72, 0.95, vnoise(vec2(vUp * 90.0, vPh * 7.0)));
        alb += vec3(0.040,0.046,0.040) * polyp;

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL);
        float ndl = abs(dot(vN, L));
        vec3 lit = alb * uLampCol * ndl * atten * cone * lampTransmit(dL);
        lit += alb * ambientAt(vW.y) * (0.24 + 0.40*vUp);
        // Polyps glow faintly and independently — the field never all lights up.
        float g = smoothstep(0.86, 1.0, vnoise(vec2(vUp * 40.0 + uTime * 0.20, vPh)));
        lit += vec3(0.10, 0.62, 0.40) * g * polyp * 0.55;
        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'whips';
  return m;
}
