import * as THREE from 'three';
import { NOISE, WATER } from './glsl.js';
import { seabedHeight } from './terrain.js';
import { rng, SEEDS } from './rng.js';

/* Silhouette layer.
 *
 * Look at any frame of SOMA and the composition is the same three-part
 * sandwich: something black and shapeless close to the lens, something legible
 * and lit in the middle, and nothing at all behind it. The near black shape is
 * doing most of the work — it gives the fog something to be measured against,
 * and it hides the fact that there is no world beyond thirty metres.
 *
 * Instanced with explicit per-instance attributes rather than InstancedMesh, so
 * the shader owns the transform outright and there is no ambiguity about which
 * matrix three did or did not inject.
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

/* Population radius is tied to visibility, not to the size of the map.
 *
 * Scattering props across 150 m when the water only carries 23 m means nine in
 * ten of them are rendered into light that cannot reach the eye — the scene is
 * simultaneously expensive and empty, which is the worst of both. Populate
 * roughly two visibility lengths and spend the budget where it is seen. */
/* Camera spots get a clearance disc.
 *
 * A 0.3 m blade 20 cm from the lens is a black quadrilateral across a third of
 * the frame, and a 6 m boulder centred on the viewpoint is the whole shot. Both
 * happened. Procedural placement has no idea where the camera will be, so the
 * camera has to tell it. */
function blocked(clear, x, z) {
  for (const c of clear) {
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) return true;
  }
  return false;
}

/** Kelp: tall tapered blades in clumps, swaying on a long period. */
export function buildKelp(clumps = 300, radius = 55, clear = [], seed = SEEDS.kelp, accept = null, center = { x: 0, z: 0 }) {
  const rand = rng(seed);
  const SEG = 9;
  const base = new THREE.PlaneGeometry(1, 1, 1, SEG);
  base.translate(0, 0.5, 0); // root at origin so scaling grows upward

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;

  /* Jittered grid, not uniform-random scatter.
   *
   * Uniform random over a disc gives uniform *expected* density and, at these
   * counts, wildly non-uniform actual density: it clusters in some places and
   * leaves bare patches elsewhere. That is fine for gravel and fatal for the
   * thing the composition depends on — with the placement seeded and therefore
   * finally reproducible, the bald patch turned out to sit exactly where the
   * hero camera stands, so the establishing shot was empty water every time.
   * Earlier runs that looked full were unseeded, and simply lucky.
   *
   * One clump per grid cell, jittered inside it, is a two-line Poisson
   * approximation: no clusters, no gaps, still organic. Vegetation wants this
   * anyway — real kelp competes for holdfast space and ends up roughly evenly
   * spaced for exactly the same reason. */
  const blades = [];
  const cell = Math.sqrt((Math.PI * radius * radius) / clumps);
  const half = Math.ceil(radius / cell);
  for (let gx = -half; gx <= half; gx++) {
    for (let gz = -half; gz <= half; gz++) {
      const lx = (gx + (rand() - 0.5) * 0.85) * cell;
      const lz = (gz + (rand() - 0.5) * 0.85) * cell;
      if (lx * lx + lz * lz > radius * radius) continue;
      /* Offset from a centre, because the region that matters is not the origin.
       * The kelp belongs on the shelf; the origin is the canyon floor four
       * hundred metres down. Seeding a disc at the origin and then filtering for
       * daylight rejected every single clump and the shelf came up bare. */
      const cx = lx + center.x;
      const cz = lz + center.z;
      const n = 9 + ((rand() * 18) | 0);
    for (let i = 0; i < n; i++) {
      const ox = cx + (rand() - 0.5) * 3.4;
      const oz = cz + (rand() - 0.5) * 3.4;
      if (blocked(clear, ox, oz)) continue;
      if (accept && !accept(ox, oz)) continue;
      blades.push({
        x: ox, y: seabedHeight(ox, oz) - 0.25, z: oz,
        w: 0.16 + rand() * 0.34,
        h: 1.5 + Math.pow(rand(), 0.8) * 5.4,
        yaw: rand() * Math.PI * 2,
        phase: rand() * 100,
        tint: rand(),
      });
      }
    }
  }

  const N = blades.length;
  const aPos = new Float32Array(N * 3), aSize = new Float32Array(N * 2);
  const aYaw = new Float32Array(N), aPhase = new Float32Array(N), aTint = new Float32Array(N);
  blades.forEach((b, i) => {
    aPos[i * 3] = b.x; aPos[i * 3 + 1] = b.y; aPos[i * 3 + 2] = b.z;
    aSize[i * 2] = b.w; aSize[i * 2 + 1] = b.h;
    aYaw[i] = b.yaw; aPhase[i] = b.phase; aTint[i] = b.tint;
  });
  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 2));
  geo.setAttribute('aYaw', new THREE.InstancedBufferAttribute(aYaw, 1));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 1));
  geo.instanceCount = N;

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec2 aSize;
      attribute float aYaw; attribute float aPhase; attribute float aTint;
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vTint;

      void main(){
        float up = uv.y;
        vUp = up; vTint = aTint;

        /* Taper and ripple, or it is a plank.
         *
         * A constant-width quad reads as sawn timber standing in the mud — which
         * is exactly how the first version looked. Kelp is widest a third of the
         * way up, comes to a point, and has a wavy margin along its length; all
         * three are nearly free here and together they are the whole difference
         * between vegetation and lumber. */
        /* Floored, not tapered to nothing. A blade that reaches zero width goes
         * sub-pixel near the tip, which aliases into a dashed line — and the
         * chromatic aberration in the composite then splits that dash into red
         * and blue fragments, so a plant ends up looking like a broken scanline. */
        float taper = smoothstep(0.0, 0.18, up) * max(1.0 - 0.82*pow(up, 1.7), 0.16);
        float ripple = 1.0 + 0.22 * sin(up * 9.0 + aPhase);
        vec3 p = vec3(position.x * aSize.x * taper * ripple, up * aSize.y, 0.0);

        // A standing blade is never straight; give it a lean that grows with
        // height so the clump has silhouette variety rather than a picket fence.
        p.x += pow(up, 2.0) * aSize.y * 0.13 * (aTint - 0.5) * 2.0;
        p.z += pow(up, 1.7) * aSize.y * 0.09 * sin(aPhase);

        // Sway. Amplitude rises with the square of height so the root stays
        // planted — a blade that slides at its base reads as a decal.
        float t = uTime * 0.32 + aPhase;
        float amp = up*up * aSize.y * 0.10;
        p.x += sin(t) * amp;
        p.z += cos(t*0.77) * amp * 0.66;

        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        vec3 w = aPos + r;
        vW = w;
        // Blades are flat; a face normal is enough and keeps them reading as
        // ribbons rather than tubes.
        vN = normalize(vec3(s, 0.28, c));
        gl_Position = projectionMatrix * viewMatrix * vec4(w,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying float vUp; varying float vTint;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;

      void main(){
        // Very dark. These exist to block light, not to be looked at.
        vec3 alb = mix(vec3(0.031,0.049,0.030), vec3(0.052,0.078,0.041), vTint);
        alb *= 0.55 + 0.65*vUp;   // darker at the root where light never reaches

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL*1.0);
        float ndl = abs(dot(vN, L));
        // Thin tissue transmits — a blade lit from behind glows at the edge.
        float trans = pow(max(dot(-vN, L), 0.0), 2.0) * 0.5;
        vec3 lit = alb * uLampCol * (ndl + trans) * atten * cone * lampTransmit(dL);
        lit += alb * ambientAt(vW.y) * (0.22 + 0.55*vUp);

        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'kelp';
  return m;
}

/** Rocks / boulders. Deformed once on the CPU, varied by instance transform. */
export function buildRocks(count = 440, radius = 72, clear = [], seed = SEEDS.rocks) {
  /* Boulders need somewhere to rest.
   *
   * Dropped onto a fifty-degree canyon wall a sphere sits half in the rock and
   * half in the water and reads as a bug, because nothing in nature balances
   * there — scree collects at the foot of a face, not on it. Sampling the
   * gradient and rejecting steep ground is two lines and removes the whole
   * class of floating-rock artefacts. */
  const slopeAt = (x, z) => {
    const e = 2.5;
    const dx = seabedHeight(x + e, z) - seabedHeight(x - e, z);
    const dz = seabedHeight(x, z + e) - seabedHeight(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  };
  const rand = rng(seed);
  const base = new THREE.IcosahedronGeometry(1, 2);
  const p = base.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Lumpy but convex-ish. Real boulders are faceted by fracture, so the
    // deformation is low frequency and biased flat on top from sediment.
    const n = 0.72 + 0.42 * Math.abs(Math.sin(x * 2.7) * Math.cos(z * 2.1) * Math.sin(y * 1.9));
    p.setXYZ(i, x * n, y * n * 0.72, z * n);
  }
  p.needsUpdate = true;
  base.computeVertexNormals();

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.normal = base.attributes.normal;

  const aPos = new Float32Array(count * 3), aScl = new Float32Array(count * 3);
  const aYaw = new Float32Array(count), aTint = new Float32Array(count);
  let n = 0;
  for (let i = 0; i < count * 3 && n < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Heavy tail, but capped. The old max of 5.2 m meant one instance in a
    // hundred was larger than the entire visible range and read as a wall.
    const s = 0.30 + Math.pow(rand(), 2.8) * 2.3;
    // Clearance scales with the boulder: a big one has to stand further off.
    if (blocked(clear.map((c) => ({ ...c, r: c.r + s })), x, z)) continue;
    // tan(38 deg) ~= 0.78 — beyond that, sediment and boulders slide.
    if (slopeAt(x, z) > 0.78) continue;
    aPos[n * 3] = x;
    aPos[n * 3 + 1] = seabedHeight(x, z) - s * 0.30; // bedded in, not resting on
    aPos[n * 3 + 2] = z;
    aScl[n * 3] = s * (0.8 + rand() * 0.5);
    aScl[n * 3 + 1] = s * (0.6 + rand() * 0.4);
    aScl[n * 3 + 2] = s * (0.8 + rand() * 0.5);
    aYaw[n] = rand() * Math.PI * 2;
    aTint[n] = rand();
    n++;
  }
  count = n;
  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
  geo.setAttribute('aScl', new THREE.InstancedBufferAttribute(aScl, 3));
  geo.setAttribute('aYaw', new THREE.InstancedBufferAttribute(aYaw, 1));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 1));
  geo.instanceCount = count;

  const mat = new THREE.ShaderMaterial({
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec3 aScl; attribute float aYaw; attribute float aTint;
      varying vec3 vW; varying vec3 vN; varying float vTint;
      void main(){
        vec3 p = position * aScl;
        float s = sin(aYaw), c = cos(aYaw);
        vec3 r = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
        vec3 n = normalize(vec3(normal.x*c - normal.z*s, normal.y, normal.x*s + normal.z*c));
        vW = aPos + r; vN = n; vTint = aTint;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN; varying float vTint;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      uniform float uTime;

      void main(){
        vec2 q = vW.xz * 1.4 + vW.y * 0.7;
        float grain = fbm(q*2.2, 4);
        vec3 alb = mix(vec3(0.104,0.101,0.096), vec3(0.163,0.156,0.140), grain);

        // Sediment settles on upward faces and biofilm follows it. Tied to the
        // normal so it always looks deposited rather than painted.
        float up = clamp(vN.y, 0.0, 1.0);
        alb = mix(alb, vec3(0.196,0.184,0.152), up*0.55*smoothstep(0.3,0.9,fbm(q*0.8,3)));
        float bio = smoothstep(0.58,0.9, fbm(q*0.5+11.3,4)) * up;
        alb = mix(alb, vec3(0.074,0.116,0.062), bio*0.5);

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (6.0 + dL*dL*1.0);
        float ndl = max(dot(vN, L), 0.0);
        vec3 lit = alb * uLampCol * ndl * atten * cone * lampTransmit(dL);
        vec3 daylight = ambientAt(vW.y);
        lit += alb * daylight * (0.26 + 0.62*up);
        // Same caustic field as the seabed, so the web runs continuously over a
        // boulder instead of stopping at its outline.
        lit += alb * daylight * caustic(vW.xz, uTime) * smoothstep(0.2, 0.8, vN.y) * 2.0;

        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'rocks';
  return m;
}
