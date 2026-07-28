import * as THREE from 'three';
import { water, visibility, zoneAt, pressureAt } from './jerlov.js';
import { buildTerrain, seabedHeight } from './terrain.js';
import { buildKelp, buildRocks } from './props.js';
import { buildSnow } from './snow.js';
import { Post } from './post.js';
import { FS_VERT, WATER } from './glsl.js';

const qs = new URLSearchParams(location.search);
const qNum = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d);
const qStr = (k, d) => (qs.get(k) ?? d);

/* ------------------------------------------------------------------ env
 * One owner for the water state. Every material asks this object for its
 * uniforms rather than keeping its own copy, because the instant the seabed
 * and the marine snow disagree about extinction the scene stops being one
 * body of water and becomes two layers pretending. */
class Env {
  constructor() {
    this.surfaceY = 0;
    /* Coastal, not oceanic — and this is the single most important line in the
     * file. Open ocean (Jerlov I-II) transmits blue best, so it renders as
     * sapphire. The look we are after is shelf water: dissolved organics absorb
     * the blue end, green survives longest, and the result is the teal every
     * frame of the reference is built from. Reaching that by tinting an oceanic
     * palette green would have been a lie that fell apart the moment the depth
     * changed; changing the water type keeps it true at every depth for free. */
    this.setWater('IB', 'C1', 0.35);
    // Irradiance just below the surface, linear HDR, daylight-ish and cool.
    this.surfaceIrr = new THREE.Vector3(8.2, 10.8, 12.4);
    // What is left when the sun is gone: faint bio-glow and thermal seep.
    // Never zero. Pure black reads as a broken renderer, not as darkness.
    this.ambientFloor = new THREE.Vector3(0.0007, 0.0018, 0.0027);
    /* Single-scattering albedo already says how much light the medium returns,
     * but the ambient field feeding it is a crude hemispheric constant rather
     * than a real radiance distribution. Left at 1.0 the fog comes out several
     * times brighter than the surfaces it is supposed to be veiling, and every
     * frame flattens into one colour. This is the honest fudge factor for that
     * approximation, and it is the only one. */
    this.scatterGain = 0.34;

    this.lampPos = new THREE.Vector3();
    this.lampDir = new THREE.Vector3(0, 0, -1);
    this.lampCol = new THREE.Vector3(1.0, 0.95, 0.88);
    /* Bright, because a real one is. Now that light is attenuated on the way out
     * as well as the way back, the optical path to a surface six metres away is
     * twelve metres of coastal water — about a twelfth of the green gets through
     * and essentially none of the red. A value tuned for single-path attenuation
     * leaves the whole scene a dim smudge; this is what it costs to be correct. */
    this.lampInt = 620;
    this.lampCos = Math.cos(0.46);
    this.lampSoft = 0.34;

    this.points = [];
    this._mats = [];
  }

  setWater(a, b, t) {
    this.w = water(a, b, t);
    this.ext = new THREE.Vector3(...this.w.extinction);
    this.kd = new THREE.Vector3(...this.w.kd);
    this.albedo = new THREE.Vector3(...this.w.albedo);
    this.scat = new THREE.Vector3(...this.w.scatter);
    this.visibility = visibility(this.w);
  }

  register(mat) { if (mat && mat.uniforms) this._mats.push(mat.uniforms); }

  applyTo(u) {
    if (u.uExt) u.uExt.value.copy(this.ext);
    if (u.uKd) u.uKd.value.copy(this.kd);
    if (u.uAlbedo) u.uAlbedo.value.copy(this.albedo);
    if (u.uScat) u.uScat.value.copy(this.scat);
    if (u.uSurfaceIrr) u.uSurfaceIrr.value.copy(this.surfaceIrr);
    if (u.uSurfaceY) u.uSurfaceY.value = this.surfaceY;
    if (u.uScatterGain) u.uScatterGain.value = this.scatterGain;
    if (u.uAmbientFloor) u.uAmbientFloor.value.copy(this.ambientFloor);
    if (u.uLampPos) u.uLampPos.value.copy(this.lampPos);
    if (u.uLampDir) u.uLampDir.value.copy(this.lampDir);
    if (u.uLampCol) u.uLampCol.value.copy(this.lampCol);
    if (u.uLampInt) u.uLampInt.value = this.lampInt;
    if (u.uLampCos) u.uLampCos.value = this.lampCos;
    if (u.uLampSoft) u.uLampSoft.value = this.lampSoft;
    if (u.uPointCount) {
      u.uPointCount.value = Math.min(4, this.points.length);
      for (let i = 0; i < Math.min(4, this.points.length); i++) {
        u.uPointPos.value[i].copy(this.points[i].pos);
        u.uPointCol.value[i].copy(this.points[i].col);
      }
    }
  }

  tick(t) {
    for (const u of this._mats) { this.applyTo(u); if (u.uTime) u.uTime.value = t; }
  }
}

/* --------------------------------------------------------------- backdrop
 * The colour of infinitely deep water in every direction. Drawn as a
 * full-screen surface behind everything at the far plane, using the same
 * in-scatter function the geometry uses — so the horizon where a rock
 * dissolves into nothing is continuous rather than a visible fog boundary. */
function buildBackdrop(env) {
  const mat = new THREE.ShaderMaterial({
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    uniforms: {
      uExt: { value: new THREE.Vector3() }, uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() }, uSurfaceIrr: { value: new THREE.Vector3() },
      uSurfaceY: { value: 0 }, uScatterGain: { value: 1 },
      uAmbientFloor: { value: new THREE.Vector3() },
      uCamY: { value: 0 }, uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() }, uTime: { value: 0 },
    },
    vertexShader: FS_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      varying vec2 vUv;
      uniform mat4 uInvProj, uInvView; uniform float uCamY;
      void main(){
        vec4 clip = vec4(vUv*2.0-1.0, -1.0, 1.0);
        vec4 vp = uInvProj*clip; vp/=vp.w;
        vec3 dir = normalize((uInvView*vec4(normalize(vp.xyz),0.0)).xyz);
        /* Sampled one mean free path along the ray — the same effective height
         * applyWater() uses for fully-fogged geometry. Any other choice makes
         * the open water and the distant seabed disagree, and the disagreement
         * shows up as a hard horizon line. */
        float mfp = 1.0 / max(uExt.g, 1e-3);
        float y = uCamY + dir.y * mfp;
        gl_FragColor = vec4(waterInscatter(y), 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  const g = m.geometry;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  m.frustumCulled = false;
  m.renderOrder = -1000;
  m.name = 'backdrop';
  return m;
}

/* ---------------------------------------------------------------- beacons
 * Distant working lights. Deliberately tiny geometry with an enormous HDR
 * value: the bloom pass turns them into the soft blown discs that read as
 * "something man-made, far away, still powered" — which is the entire emotional
 * content of SOMA's establishing shots. */
function buildBeacons(env, specs) {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uExt: { value: new THREE.Vector3() }, uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() }, uSurfaceIrr: { value: new THREE.Vector3() },
      uSurfaceY: { value: 0 }, uScatterGain: { value: 1 },
      uAmbientFloor: { value: new THREE.Vector3() }, uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute float aSize;
      varying vec3 vC; varying vec3 vW;
      void main(){
        vC = aCol; vW = position;
        vec4 mv = viewMatrix * vec4(position,1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(2.0, aSize * 700.0 / max(-mv.z, 1.0));
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      varying vec3 vC; varying vec3 vW;
      void main(){
        vec2 c = gl_PointCoord-0.5; float r = length(c)*2.0;
        if(r>1.0) discard;
        float a = pow(1.0-r, 2.2);
        float dist = length(cameraPosition - vW);
        // The lamp is a source, so it is attenuated but not in-scattered into:
        // its own light does not fill in behind itself.
        vec3 col = vC * exp(-uExt*dist);
        gl_FragColor = vec4(col*a, a);
      }`,
  });
  const g = new THREE.BufferGeometry();
  const pos = [], col = [], siz = [];
  for (const s of specs) {
    pos.push(s.pos[0], s.pos[1], s.pos[2]);
    col.push(s.col[0], s.col[1], s.col[2]);
    siz.push(s.size ?? 0.5);
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(siz), 1));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  group.add(pts);
  group.userData.mat = mat;
  return group;
}

/* ------------------------------------------------------------------- boot */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance', alpha: false,
});
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // composite encodes manually
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 900);

const env = new Env();
const post = new Post(renderer);
/* Volumetric cost is steps x resolution and nothing else, so it is the one
 * dial worth exposing. The review harness runs on a software rasteriser where
 * 32 steps at half res takes a minute a frame; real GPUs do not care. Quality
 * verdicts must still be taken at full settings — this is for iteration speed,
 * not for making the numbers look good. */
post.matVol.uniforms.uSteps.value = qNum('vsteps', 32);
post.volScale = qNum('vscale', 0.5);
renderer.info.autoReset = false; // post does many passes; count them all

const backdrop = buildBackdrop(env);
scene.add(backdrop);

/* Where the camera will stand. Kept in sync with POSES below by hand, which is
 * a smell — but the alternative is building props lazily after the pose table,
 * and props that rebuild on every pose change cost more than this duplication. */
const CAM_SPOTS = [
  { x: 4, z: 26, r: 3.0 }, { x: 0, z: 8, r: 3.0 }, { x: -6, z: 4, r: 3.0 },
  { x: 0, z: 0, r: 3.5 }, { x: -12, z: 14, r: 3.0 }, { x: 18, z: 40, r: 3.5 },
];

const terrain = buildTerrain();
const kelp = buildKelp(300, 55, CAM_SPOTS);
const rocks = buildRocks(440, 72, CAM_SPOTS);
const snow = buildSnow();
scene.add(terrain, kelp, rocks, snow);

/* Distances are set against the water, not against the map.
 *
 * A working light 100 m away in water with 23 m visibility is not dim — it is
 * absent, by a factor of ten billion. These sit at one to two visibility
 * lengths, where Beer's law still leaves something, and carry enormous HDR
 * values because that is what an actual floodlight is: a small object several
 * hundred times brighter than anything around it. The bloom pass turns that
 * into the blown disc the eye reads as "powered, and far away". */
const beaconSpecs = [
  { pos: [26, -14, -30], col: [220, 300, 330], size: 0.55 },
  { pos: [30, -16, -33], col: [150, 200, 225], size: 0.34 },
  { pos: [21, -19, -36], col: [260, 90, 30], size: 0.30 },   // red hazard marker
  { pos: [-27, -17, -34], col: [40, 210, 90], size: 0.40 },  // bio / green sodium
  { pos: [-31, -21, -39], col: [26, 150, 66], size: 0.26 },
];
const beacons = buildBeacons(env, beaconSpecs);
scene.add(beacons);

env.points = [
  { pos: new THREE.Vector3(26, -14, -30), col: new THREE.Vector3(9.0, 12.0, 13.5) },
  { pos: new THREE.Vector3(-27, -17, -34), col: new THREE.Vector3(1.8, 8.5, 3.6) },
];

for (const o of [terrain, kelp, rocks, snow, backdrop]) env.register(o.material);
env.register(beacons.userData.mat);

/* -------------------------------------------------------------------- poses
 * Named camera set-ups. These are the review set: each one exists to expose a
 * different failure mode, and together they are what a judge is shown. A pose
 * that cannot fail is not worth shooting. */
/* Heights are given above the local seabed, never as absolute Y.
 *
 * An absolute height is a promise about terrain that procedural terrain does
 * not keep: move the noise seed and every carefully framed shot is either
 * buried or floating in open water. Worse, it produced exactly the failure this
 * set was written to catch — a camera nine metres up, aimed level, with the
 * entire cast of the scene sitting below the horizon as dark shapes on a dark
 * floor. Framing underwater is about putting something solid between the lens
 * and the one bright thing in the world, which is the water overhead.
 *
 * x,z  where on the map            h      metres above the seabed there
 * yaw  degrees, 0 = -Z             pitch  degrees, + = looking up
 */
const POSES = {
  // Kelp against bright water. The whole absorption curve is on screen at
  // once — near blades nearly black, mid water teal, far water dissolving.
  kelp: { x: 4, z: 26, h: 2.2, yaw: 12, pitch: 6, depth: 38, lamp: 0.22 },
  // Deep and nearly lightless. Proves the game can be dark without being
  // broken: if this frame is pure black, the ambient floor is wrong.
  /* Aimed down, because at this depth there is nothing else to aim at.
   * With visibility at eighteen metres the lamp's useful reach is a handful of
   * metres of doubled optical path — point it at the horizon and the frame is
   * empty by construction, which is a badly chosen shot rather than a dark one. */
  dark: { x: 0, z: 8, h: 1.9, yaw: -8, pitch: -16, depth: 940, lamp: 1.0 },
  // Lamp raking the seabed. Grazing light is the hardest test of the terrain
  // normals, and grazing light is the only light this game has.
  floor: { x: -6, z: 4, h: 1.3, yaw: 20, pitch: -22, depth: 420, lamp: 1.0 },
  // Looking down into nothing. Tests that "nothing" still has structure.
  descent: { x: 0, z: 0, h: 7.5, yaw: 0, pitch: -46, depth: 52, lamp: 0.8 },
  // Lamp thrown across the frame to catch the cone side-on: shaft test.
  shafts: { x: -12, z: 14, h: 2.7, yaw: 46, pitch: -19, depth: 310, lamp: 1.0 },
  // Wide establishing: terrain silhouette against the brighter water above.
  wide: { x: 18, z: 40, h: 4.5, yaw: -22, pitch: 4, depth: 42, lamp: 0.25 },
};

let curPose = 'kelp';
const D2R = Math.PI / 180;

function applyPose(name) {
  const p = POSES[name] || POSES.kelp;
  curPose = name;
  const y = seabedHeight(p.x, p.z) + p.h;
  camera.position.set(p.x, y, p.z);
  // Explicit yaw/pitch rather than lookAt: a look target moves the framing
  // whenever the camera moves, so two poses that share a target quietly become
  // two different shots when the terrain under them differs.
  const yaw = p.yaw * D2R, pitch = p.pitch * D2R;
  const dir = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
  camera.lookAt(camera.position.clone().add(dir));
  game.depth = p.depth;
  game.lampOn = p.lamp;
  syncDepth();
}

/* Depth is expressed by moving the sea surface, not the camera. The camera
 * stays near the terrain (which is authored around y=0) while `surfaceY` rises
 * far overhead — so the optics get a true 900 m of water above them without
 * needing a 900 m tall mesh or any floating-point heroics. */
function syncDepth() {
  env.surfaceY = camera.position.y + game.depth;
  const z = zoneAt(game.depth);
  /* Clearer with depth, not murkier.
   *
   * Turbidity is a surface phenomenon — river outflow, resuspended sediment and
   * the whole photosynthetic layer live in the top tens of metres. Below that
   * the water genuinely clears. Running it the other way, as this did at first,
   * is both wrong and bad design: it shortens the lamp's reach exactly as the
   * lamp becomes the only light you have, so the descent gets progressively less
   * legible. This way visibility roughly doubles on the way down, which reads as
   * the world opening up around you while the darkness closes in. */
  const turb = Math.max(0.10, 0.34 - game.depth / 2600);
  env.setWater('IB', 'C1', turb);
  env.lampInt = 620 * game.lampOn;
  game.zone = z.name;
  game.pressure = pressureAt(game.depth);
}

/* ------------------------------------------------------------------ resize */
let W = 1, H = 1;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, game.maxDpr);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (w === W && h === H) return;
  W = w; H = h;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  post.setSize(w, h);
  snow.material.uniforms.uPx.value = h;
}

/* -------------------------------------------------------------------- game */
const game = {
  started: false,
  depth: qNum('depth', 62),
  lampOn: qNum('lamp', 0.0),
  maxDpr: qNum('dpr', 2),
  zone: '', pressure: 1,
  fps: 0, frames: 0,
  time: 0,
  poses: Object.keys(POSES),
  scene, camera, renderer, env, post,
  pose: (n) => { applyPose(n); },
  setDepth: (m) => { game.depth = m; syncDepth(); },
  setLamp: (v) => { game.lampOn = v; syncDepth(); },
  setWater: (a, b, t) => env.setWater(a, b, t),
  visibility: () => env.visibility,
  setLayer: (name, on) => {
    const o = { kelp, rocks, snow, terrain, beacons }[name];
    if (o) o.visible = on;
    if (name === 'hud') document.getElementById('hud').hidden = !on;
  },
  // Sample the rendered frame's colour at a set of distances. The harness uses
  // this to check the absorption curve against Jerlov numerically instead of
  // arguing about whether the water "looks right".
  probeExtinction: () => ({
    extinction: env.ext.toArray(),
    kd: env.kd.toArray(),
    albedo: env.albedo.toArray(),
    visibility: env.visibility,
    surfaceY: env.surfaceY,
    depth: game.depth,
  }),
};
window.__game = game;

/* -------------------------------------------------------------------- loop */
const clock = new THREE.Clock();
let fpsT = 0, fpsN = 0;

function frame() {
  requestAnimationFrame(frame);
  if (!game.started) return;
  resize();

  const dt = Math.min(clock.getDelta(), 0.1);
  game.time += dt;
  env.tick(game.time);

  /* Lamp rides the housing, not the eye.
   *
   * Mounted forward and below the port, the way a real submersible carries it.
   * Besides being true, an off-axis lamp means the cone is seen slightly from
   * the side — so the beam reads as a shaft in the water rather than as a glow
   * centred perfectly on the crosshair. */
  const view = camera.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0)).normalize();

  /* Mounted out on the hull and aimed down, the way it is actually done.
   *
   * A lamp beside the lens fires its beam straight back into it: the water
   * between you and everything else lights up and you are looking at your own
   * backscatter. Underwater photographers solve this by putting strobes on long
   * arms, and submersibles by hanging floods off the frame well away from the
   * port. Doing the same here moves the illuminated cone off the optical axis,
   * so the beam reads as a shaft crossing the frame instead of a bright disc
   * pasted over the middle of it. */
  env.lampPos.copy(camera.position)
    .addScaledVector(view, 1.15)
    .addScaledVector(right, 0.72)
    .add(new THREE.Vector3(0, -0.42, 0));
  // Aimed down-forward, not along the view axis.
  env.lampDir.copy(view).addScaledVector(new THREE.Vector3(0, -1, 0), 0.17).normalize();
  /* Keep the marine-snow volume centred on the viewer. Without this the box
   * stays wherever it was built and the "constant density everywhere" promise
   * quietly becomes "a cloud sitting at the origin" — which, once the camera
   * stood inside it, filled the frame. */
  snow.material.uniforms.uAnchor.value.copy(camera.position);
  backdrop.material.uniforms.uCamY.value = camera.position.y;
  backdrop.material.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
  backdrop.material.uniforms.uInvView.value.copy(camera.matrixWorld);
  post.matVol.uniforms.uTime.value = game.time;
  post.matComp.uniforms.uTime.value = game.time;

  renderer.info.reset();
  post.render(scene, camera, env);

  game.frames++; fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { game.fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }

  const hud = document.getElementById('hud');
  if (!hud.hidden) {
    document.getElementById('hDepth').textContent = Math.round(game.depth);
  }
  const st = document.getElementById('stats');
  if (!st.hidden) {
    st.textContent = `${game.fps.toFixed(0)} fps  ${W}x${H}\n`
      + `${curPose}  ${Math.round(game.depth)} m  ${game.zone}\n`
      + `vis ${env.visibility.toFixed(1)} m  ${game.pressure.toFixed(0)} atm`;
  }
}

/* -------------------------------------------------------------------- start */
function begin() {
  document.getElementById('boot').style.opacity = '0';
  setTimeout(() => { document.getElementById('boot').style.display = 'none'; }, 950);
  if (qStr('hud', '1') === '1') document.getElementById('hud').hidden = false;
  if (qStr('stats', '0') === '1') document.getElementById('stats').hidden = false;
  game.started = true;
  clock.getDelta();
}

applyPose(qStr('pose', 'kelp'));
if (qs.has('depth')) { game.depth = qNum('depth', 62); syncDepth(); }
resize();

// Warm the shaders before showing the button. A first frame that takes two
// seconds to compile reads as a stutter if it happens after the player commits.
requestAnimationFrame(() => {
  const prog = document.getElementById('bootProg');
  prog.textContent = 'compiling shaders';
  renderer.compile(scene, camera);
  prog.textContent = `${Math.round(env.visibility)} m visibility · ready`;
  const b = document.getElementById('bootStart');
  b.hidden = false;
  b.addEventListener('click', begin);
  if (qStr('auto', '0') === '1') begin();
});

frame();
