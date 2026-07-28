import * as THREE from 'three';
import { NOISE, WATER } from './glsl.js';

/* The seafloor.
 *
 * Built on the CPU so normals are exact. A vertex-displaced plane with
 * screen-space derived normals looks fine on a hero shot and falls apart the
 * moment a lamp grazes it — and a grazing lamp is the only light this game
 * has, so the cheap path is not available.
 */

/* JS twin of the GLSL value noise. These must agree: the shader adds fine
 * detail on top of the CPU heightfield, and if the two use different noise the
 * detail fights the silhouette instead of extending it. */
function hash12(x, y) {
  let px = x * 0.1031, py = y * 0.1030, pz = x * 0.0973;
  px -= Math.floor(px); py -= Math.floor(py); pz -= Math.floor(pz);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d; py += d; pz += d;
  const v = (px + py) * pz;
  return v - Math.floor(v);
}
const smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = smooth(fx), uy = smooth(fy);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
function fbm(x, y, oct = 5) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); n += a; x *= 2.02; y *= 2.02; a *= 0.5; }
  return s / n;
}
function ridged(x, y, oct = 5) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(vnoise(x, y) * 2 - 1); v *= v;
    s += a * v; n += a; x *= 2.03; y *= 2.03; a *= 0.5;
  }
  return s / n;
}

/**
 * Height of the seabed at a world XZ, in metres.
 *
 * Composed rather than summed at one frequency: a broad basin so the floor
 * falls away from the spawn and gives the eye somewhere to descend into, ridged
 * detail for erosion creases, and a fine grain that only reads within lamp
 * range. Exported because the sub has to not fly through it.
 */
export function seabedHeight(x, z) {
  const basin = -34 + 26 * fbm(x * 0.0032, z * 0.0032, 4);
  const ridges = 13 * (ridged(x * 0.011, z * 0.011, 5) - 0.5);
  const dunes = 2.4 * fbm(x * 0.055, z * 0.055, 4);
  const grain = 0.5 * fbm(x * 0.42, z * 0.42, 3);
  return basin + ridges + dunes + grain;
}

export function buildTerrain(size = 620, seg = 340) {
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, seabedHeight(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
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
    },
    vertexShader: /* glsl */`
      varying vec3 vW; varying vec3 vN;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      ${WATER}
      varying vec3 vW; varying vec3 vN;
      uniform vec3 uLampPos, uLampDir, uLampCol; uniform float uLampInt, uLampCos, uLampSoft;
      uniform float uTime;

      void main(){
        /* Noise budget, counted rather than assumed.
         *
         * This shader is the frame. The seabed fills most of every shot, so its
         * per-pixel cost is very nearly the whole cost of the game — and the
         * first version spent about a hundred value-noise lookups here, roughly
         * four hundred hash rounds per pixel. On a real GPU at 1920x1080 that
         * measured ten frames a second, which is not a "needs optimising later"
         * number, it is unshippable.
         *
         * Two changes, no visible loss: sample the detail field at two octaves
         * instead of five (the finest octaves were below a pixel at any distance
         * the water lets you see anyway), and derive albedo, mottle and biofilm
         * from ONE shared low-frequency lookup instead of three independent ones.
         * Nine lookups, down from about a hundred.
         */
        vec2 p = vW.xz;
        float e = 0.4;
        float h  = fbm(p*2.4, 2);
        float hx = fbm((p+vec2(e,0.0))*2.4, 2);
        float hz = fbm((p+vec2(0.0,e))*2.4, 2);
        vec3 n = normalize(vN + vec3(-(hx-h)/e, 0.0, -(hz-h)/e) * 1.15);

        // One shared low-frequency field, read three ways. Independent noise per
        // channel costs three times as much and looks no less arbitrary.
        float lo = fbm(p*0.32, 3);

        // Sediment. Silt settles in the flats, coarser scree shows on slopes —
        // so albedo is driven by the surface normal, not by another noise
        // channel that happens to look busy.
        float flat_ = smoothstep(0.55, 0.96, n.y);
        vec3 silt  = vec3(0.216, 0.203, 0.171);
        vec3 scree = vec3(0.121, 0.124, 0.117);
        vec3 alb = mix(scree, silt, flat_ * (0.55 + 0.45*lo));
        alb *= 0.82 + 0.32 * h;   // reuse the detail field instead of a new one

        // Patchy biofilm. Not everywhere — a uniform green tint reads as a
        // colour grade, whereas patches read as something living. Offset the
        // same field rather than sampling a fresh one.
        float bio = smoothstep(0.54, 0.86, 1.0 - lo) * flat_;
        alb = mix(alb, vec3(0.086,0.132,0.072), bio*0.42);

        // Lamp: cone falloff and inverse square, both honest.
        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        float atten = uLampInt / (1.0 + dL*dL*0.85);
        // Wrapped diffuse — silt is dusty and does not have a hard terminator.
        float ndl = pow(clamp((dot(n,L)+0.28)/1.28, 0.0, 1.0), 1.35);
        vec3 lit = alb * uLampCol * ndl * atten * cone * lampTransmit(dL);

        // Ambient from above, occluded by facing down. Kept at full strength:
        // the seabed is lit by the same field that lights the water, so any
        // factor below 1 makes the floor read as a hole in the fog.
        vec3 daylight = ambientAt(vW.y);
        vec3 amb = daylight * (0.30 + 0.70*clamp(n.y*0.5+0.5,0.0,1.0));
        lit += alb * amb;

        /* Caustics, driven by the daylight term itself.
         *
         * Multiplying by the daylight vector rather than by a hand-written depth
         * fade means they need no rule of their own: bright in ten metres of
         * water, faint at eighty, simply absent below the photic zone, because
         * that is what happens to the beam that makes them. Upward faces only —
         * a caustic on a vertical wall is a decal.
         *
         * (No backticks in here. This is inside a JS template literal, and one
         * stray backtick terminates the shader mid-comment.) */
        float caus = caustic(vW.xz, uTime) * smoothstep(0.15, 0.75, n.y);
        lit += alb * daylight * caus * 2.4;

        gl_FragColor = vec4(applyWater(lit, vW), 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'seabed';
  return mesh;
}
