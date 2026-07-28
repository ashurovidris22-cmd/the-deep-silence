import * as THREE from 'three';
import { NOISE, WATER } from './glsl.js';

/* The seabed, and the shape of the whole game.
 *
 * The first version was a gently rolling plain spanning about forty metres of
 * vertical range. That is not a small world, it is a world with no descent in it:
 * depth is derived from position, so forty metres of relief means the water can
 * only ever change by forty metres' worth and every frame looks like the last.
 *
 * This is a submarine canyon instead — the real geography of the setting, and the
 * only one that makes the optics do any work. A photic shelf at about sixty
 * metres, a wall falling away for four hundred, and a silted floor at the bottom
 * where no daylight arrives at all. Swimming down it takes you from teal
 * afternoon to absolute black without a single scripted transition, because the
 * absorption curve does all of it.
 *
 * Built on the CPU so normals are exact. A vertex-displaced plane with
 * screen-space derived normals looks fine on a hero shot and falls apart the
 * moment a lamp grazes it — and a grazing lamp is the only light down there.
 */

/* JS twin of the GLSL value noise. These must agree: the shader adds fine
 * detail on top of the CPU heightfield, and if the two disagree the detail
 * fights the silhouette instead of extending it. */
function hash12(x, y) {
  let px = x * 0.1031, py = y * 0.1030, pz = x * 0.0973;
  px -= Math.floor(px); py -= Math.floor(py); pz -= Math.floor(pz);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d; py += d; pz += d;
  const v = (px + py) * pz;
  return v - Math.floor(v);
}
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = smooth(fx), uy = smooth(fy);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  return top + ((c + (d - c) * ux) - top) * uy;
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

/* World layout, in metres. Absolute Y, because depth is now a property of where
 * you are rather than a number the game carries around separately. */
export const SEA_LEVEL = 40;      // world Y of the surface
export const SHELF_Y = -10;       // ~62 m deep: kelp, caustics, daylight
export const CANYON_Y = -398;     // ~438 m deep: silt, no sun at all
export const CANYON_HALF = 96;    // half-width of the flat floor
export const RIM = 330;           // where the wall meets the shelf

/**
 * Height of the seabed at a world XZ, in metres.
 *
 * The canyon runs along Z so that the walls are always to either side and the
 * player can descend by simply following the slope down — no waypoint needed,
 * because gravity and curiosity point the same way.
 */
export function seabedHeight(x, z) {
  // Canyon axis meanders, so the trench is not a straight ditch.
  const axis = 46 * (fbm(z * 0.0016 + 7.3, 11.1, 3) - 0.5);
  const ax = Math.abs(x - axis);

  // Cross-section: flat floor, steep wall, then shelf.
  const t = sstep(CANYON_HALF, RIM, ax);

  const shelf = SHELF_Y + 13 * fbm(x * 0.0042, z * 0.0042, 4)
                        + 5.5 * (ridged(x * 0.013, z * 0.013, 4) - 0.5);
  const floor = CANYON_Y + 22 * fbm(x * 0.0031 + 3.1, z * 0.0031, 4);

  // Cosine-eased wall rather than a linear ramp: gives a concave foot where
  // scree would pile and a convex lip at the rim, which is what erosion leaves.
  const wall = floor + (shelf - floor) * (0.5 - 0.5 * Math.cos(Math.PI * t));

  // Wall relief. Amplitude scales with slope so the shelf stays calm while the
  // face gets the buttresses and gullies that make a cliff read as rock.
  const slope = 4 * t * (1 - t);
  const gullies = 34 * slope * (ridged(x * 0.0075 + 21.7, z * 0.0075, 5) - 0.5);
  const benches = 11 * slope * (fbm(x * 0.019, z * 0.019, 3) - 0.5);

  const dunes = 2.6 * fbm(x * 0.055, z * 0.055, 4) * (1 - slope * 0.6);
  const grain = 0.55 * fbm(x * 0.42, z * 0.42, 3);

  return wall + gullies + benches + dunes + grain;
}

/** True where there is enough light for kelp. Used to keep flora on the shelf. */
export function isPhotic(x, z) {
  return SEA_LEVEL - seabedHeight(x, z) < 105;
}

export function buildTerrain(size = 1200, seg = 480) {
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
      uScat: { value: new THREE.Vector3() },
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
         * per-pixel cost is very nearly the whole cost of the game. Two octaves
         * for the detail field (the finer ones are sub-pixel at any distance the
         * water permits) and ONE shared low-frequency lookup feeding albedo,
         * mottle and biofilm rather than three independent ones. */
        vec2 p = vW.xz;
        float e = 0.4;
        float h  = fbm(p*2.4, 2);
        float hx = fbm((p+vec2(e,0.0))*2.4, 2);
        float hz = fbm((p+vec2(0.0,e))*2.4, 2);
        vec3 n = normalize(vN + vec3(-(hx-h)/e, 0.0, -(hz-h)/e) * 1.15);

        float lo = fbm(p*0.32, 3);
        float flat_ = smoothstep(0.55, 0.96, n.y);

        /* Bedding planes on the steep faces.
         *
         * A canyon wall is not a rock-coloured slope, it is stacked sediment cut
         * open — so the banding runs with world height and shows only where the
         * face is steep enough to expose it. Keyed to vW.y rather than to a
         * texture coordinate, which means every stratum is continuous across the
         * whole cliff instead of stopping at a mesh seam. */
        float steep = 1.0 - flat_;
        float bandN = fbm(vec2(vW.y*0.11, lo*2.0), 2);
        float strata = sin(vW.y * 0.42 + bandN * 5.0);
        strata = smoothstep(-0.15, 0.65, strata);

        vec3 silt  = vec3(0.216, 0.203, 0.171);
        vec3 scree = vec3(0.121, 0.124, 0.117);
        vec3 rockA = vec3(0.148, 0.139, 0.126);
        vec3 rockB = vec3(0.088, 0.091, 0.096);

        vec3 alb = mix(scree, silt, flat_ * (0.55 + 0.45*lo));
        alb = mix(alb, mix(rockB, rockA, strata), steep * 0.82);
        alb *= 0.82 + 0.32 * h;

        // Patchy biofilm on the flats only. A uniform green tint reads as a
        // colour grade; patches read as something living.
        float bio = smoothstep(0.54, 0.86, 1.0 - lo) * flat_;
        alb = mix(alb, vec3(0.086,0.132,0.072), bio*0.42);

        // Lamp: cone falloff, inverse square, and attenuation over the outward
        // path as well as the return.
        vec3  toL = uLampPos - vW;
        float dL  = length(toL);
        vec3  L   = toL / max(dL,1e-4);
        float cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
        /* Finite source size, not a mathematical point.
         *
         * A real floodlight has a lens some tens of centimetres across, so the
         * 1/d^2 hotspot is capped rather than divergent. Written as a point the
         * pool went to nineteen in linear HDR two metres out and clipped to a
         * flat white blob with no readable ground in it — while six metres away,
         * after the doubled optical path, there was almost nothing. The r0 term
         * flattens that ratio from about forty to one down to something a tone
         * curve can actually hold. */
        float atten = uLampInt / (6.0 + dL*dL*1.0);
        // Wrapped diffuse — silt is dusty and has no hard terminator.
        float ndl = pow(clamp((dot(n,L)+0.28)/1.28, 0.0, 1.0), 1.35);
        vec3 lit = alb * uLampCol * ndl * atten * cone * lampTransmit(dL);

        vec3 daylight = ambientAt(vW.y);
        lit += alb * daylight * (0.30 + 0.70*clamp(n.y*0.5+0.5,0.0,1.0));

        /* Caustics, driven by the daylight term itself.
         *
         * Multiplying by the daylight vector rather than by a hand-written depth
         * fade means they need no rule of their own: bright on the shelf, faint
         * at the rim, simply absent on the canyon floor, because that is what
         * happens to the beam that makes them. Upward faces only — a caustic on
         * a vertical wall is a decal.
         *
         * (No backticks in here: this is inside a JS template literal.) */
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
