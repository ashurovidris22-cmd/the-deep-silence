import * as THREE from 'three';
import { NOISE, WATER } from './glsl.js';
import { rng, SEEDS } from './rng.js';

/* Marine snow.
 *
 * The single cheapest thing that sells "this is water and not fog". It does
 * three jobs at once: it gives the eye a distance cue in an otherwise
 * featureless volume, it proves the camera is moving through a medium, and in
 * the near field it puts something out of focus in front of the lens, which is
 * what makes a render read as a photograph.
 *
 * Distributed in a box that follows the camera and wraps, so density is
 * constant no matter where you are and no particle is ever wasted off-screen.
 */
export function buildSnow(count = 3400, box = 46, seed = SEEDS.snow) {
  const rand = rng(seed);
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);     // per-flake drift phase
  const size = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    pos[i * 3 + 0] = (rand() - 0.5) * box;
    pos[i * 3 + 1] = (rand() - 0.5) * box;
    pos[i * 3 + 2] = (rand() - 0.5) * box;
    phase[i] = rand() * 1000;
    // Heavy tail: mostly fine detritus, a few big flocs. A uniform size
    // distribution reads as a particle system; this reads as sediment.
    size[i] = 0.006 + Math.pow(rand(), 3.2) * 0.075;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
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
      uBox: { value: box },
      uAnchor: { value: new THREE.Vector3() },
      uPx: { value: 900 },   // viewport height, for size-in-metres projection
    },
    vertexShader: /* glsl */`
      ${NOISE}
      attribute float aSeed; attribute float aSize;
      uniform float uTime, uBox, uPx;
      uniform vec3 uAnchor;
      varying float vFade; varying vec3 vW; varying float vBig;

      void main(){
        vec3 p = position;
        // Slow convection plus a per-flake wobble. Snow does not fall — at
        // depth it hangs and drifts, which is far more unsettling.
        p.y -= uTime * 0.055;
        p.x += sin(uTime*0.14 + aSeed) * 0.35;
        p.z += cos(uTime*0.11 + aSeed*1.7) * 0.35;

        // Wrap into a box centred on the camera.
        vec3 rel = p - uAnchor;
        rel = mod(rel + uBox*0.5, uBox) - uBox*0.5;
        vec3 w = uAnchor + rel;
        vW = w;

        vec4 mv = viewMatrix * vec4(w,1.0);
        float d = -mv.z;
        // Fade in from the wrap boundary and out well before the near plane.
        // A flake is allowed to be an out-of-focus blob; it is not allowed to
        // be a wall.
        vFade = smoothstep(uBox*0.5, uBox*0.34, d) * smoothstep(0.35, 1.30, d);
        vBig = smoothstep(0.04, 0.09, aSize);
        gl_Position = projectionMatrix * mv;
        /* Clamped, and the clamp is load-bearing. Projected size goes as 1/d,
         * so a flake that drifts to within a few centimetres of the lens
         * becomes an 800-pixel disc — and a few hundred of them at once is a
         * solid glowing sphere in the middle of the frame, which is precisely
         * what this produced before the clamp existed. */
        gl_PointSize = clamp(aSize * uPx / max(d, 0.55), 1.0, 42.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      varying float vFade; varying vec3 vW; varying float vBig;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;

      void main(){
        // Soft disc. Hard-edged points are the tell of a cheap particle system.
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float a = pow(1.0 - r, 1.7);

        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        // Falls off fast. These are millimetre flecks a metre from a floodlight;
        // with a gentle falloff the whole near cone turns into one solid sheet.
        float atten = uLampInt / (1.0 + dL*dL*4.5);

        // Detritus is a dull grey-brown, not white. White specks read as dust
        // on the lens; this reads as matter in the water.
        vec3 alb = vec3(0.60, 0.58, 0.52);

        /* Weak on purpose, and clamped below the bloom threshold.
         *
         * Light scattered by particles inside the beam is already computed, once
         * and correctly, by the volumetric pass. Lighting each flake brightly as
         * well counts the same photons twice — and because the flakes sit right
         * next to the lamp they came out around 8.0 in linear HDR, sailed past
         * the bright-pass threshold, and the bloom chain smeared the cone into a
         * single glowing teardrop that appeared in all twelve review frames.
         * The flakes' job is to be discrete specks catching the light; the glow
         * around them belongs to the volume, not to them. */
        vec3 lit = alb * uLampCol * atten * cone * 0.045;
        lit += alb * ambientAt(vW.y) * 0.42;
        lit = min(lit, vec3(0.62));

        vec3 col = applyWater(lit, vW);
        /* Alpha kept low, because these overlap.
         *
         * Thousands of soft discs at up to 0.74 alpha do not read as specks in
         * the water, they composite into a grey veil over the whole frame — the
         * review set showed the identical shot markedly brighter with snow turned
         * off, which is the tell. Individually faint, collectively present. */
        gl_FragColor = vec4(col, a * vFade * (0.15 + 0.24*vBig));
      }`,
  });

  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.name = 'snow';
  return pts;
}
