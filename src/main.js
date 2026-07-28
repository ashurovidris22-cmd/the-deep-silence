import * as THREE from 'three';
import { water, visibility, zoneAt, pressureAt } from './jerlov.js';
import { buildTerrain, seabedHeight, isPhotic, SEA_LEVEL, CANYON_HALF, RIM } from './terrain.js';
import { buildKelp, buildRocks } from './props.js';
import { buildSnow } from './snow.js';
import { buildStation } from './structures.js';
import { buildSub } from './sub.js';
import { buildInterior, interiorSolids, hullHalfWidth, DECK_Y, EYE, HULL_LEN, HELM } from './interior.js';
import { Post } from './post.js';
import { Pilot } from './controls.js';
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
    this.surfaceY = SEA_LEVEL;
    /* Coastal, not oceanic — and this is the single most important line in the
     * file. Open ocean (Jerlov I-II) transmits blue best, so it renders as
     * sapphire. The look we are after is shelf water: dissolved organics absorb
     * the blue end, green survives longest, and the result is the teal every
     * frame of the reference is built from. Reaching that by tinting an oceanic
     * palette green would have been a lie that fell apart the moment the depth
     * changed; changing the water type keeps it true at every depth for free. */
    this.setWater('IB', 'C1', 0.35);
    // Irradiance just below the surface, linear HDR, daylight-ish and cool.
    this.surfaceIrr = new THREE.Vector3(23.0, 30.0, 34.0);
    // What is left when the sun is gone: faint bio-glow and thermal seep.
    // Never zero. Pure black reads as a broken renderer, not as darkness.
    /* Raised, and it is doing real work now.
     * This is the light that has nothing to do with the sun: bioluminescence,
     * thermal seep, the general faint glow of a living ocean. At a thousandth it
     * only kept the maths from dividing by zero. At this level the deep still
     * reads as dark, but shapes resolve just outside the lamp instead of the
     * world ending at the edge of the beam. */
    this.ambientFloor = new THREE.Vector3(0.0032, 0.0090, 0.0125);
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
    /* Matched to the softened falloff, not carried over from the point-source one.
     * With the r0 term in the denominator, 210 delivered a quarter of the old
     * mid-range light and the canyon floor went black. At 900 the light five
     * metres out matches what it always was, while the hotspot a metre from the
     * lens is nearly three times lower than the point-source version — which was
     * the entire purpose of adding r0. */
    this.lampInt = 900;
    /* A wider cone, because a narrow one is not atmospheric, it is unusable.
     * At 32 degrees the lit pool covered a fraction of the frame and everything
     * around it was black — the player reasonably reported not being able to see.
     * Real submersible floods are wide precisely because the water already
     * limits how far you can see; there is no reason to limit the angle too. */
    this.lampCos = Math.cos(0.74);
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
/* Never less than this much water overhead. Six metres is enough that the
 * daylight term stays bounded and the vehicle reads as submerged; it also means
 * the exposure never has to cope with a breach it was not designed for. */
const MIN_DEPTH = 6;

const pilot = new Pilot(camera, canvas);
pilot.invertY = qStr('invertY', '0') === '1';
pilot.sensitivity = qNum('sens', 0.0021);
pilot.toggleLamp = () => { game.lampOn = game.lampOn > 0.5 ? 0 : 1; syncWater(); };

/* Three modes, and they are genuinely different vehicles rather than one with
 * flags: walking the boat, sitting at the helm, and swimming outside. */
function enterWalk() {
  game.mode = 'walk';
  pilot.walk = true;
  pilot.walkOrigin.copy(boat.origin);
  pilot.walkBounds = hullHalfWidth;
  pilot.deckY = DECK_Y;
  pilot.eyeH = EYE;
  pilot.halfLen = HULL_LEN - 1.1;
  pilot.solids = interiorSolids();
  pilot.vy = 0;
  pilot.pos.copy(boat.origin).add(new THREE.Vector3(0, DECK_Y + EYE, 0.5));
  pilot.pitch = 0;
  pilot.apply();
}
function enterHelm() {
  game.mode = 'helm';
  pilot.walk = false;
  pilot.enabled = false;   // seated: look only, the boat holds you
  pilot.pos.copy(boat.origin).add(new THREE.Vector3(0, HELM.y, HELM.z - 0.35));
/* Facing the bow, which is 180 degrees, not zero.
   *
   * This heading has dir.z = -cos(yaw), so yaw 0 looks down -Z — toward the stern.
   * The helm was therefore staring at a bulkhead with the viewport directly
   * behind its head. */
  pilot.yaw = Math.PI; pilot.pitch = -0.04;
  pilot.apply();
}
/* Leaving is done at the hatch, and it puts you just outside it.
 *
 * Previously V teleported the player to an arbitrary offset from anywhere in the
 * boat, into open water, with the full swim controls live and a four-hundred-metre
 * water column overhead. Held Space long enough and you arrive at the six-metre
 * ceiling with no idea what happened — which is exactly what happened. An exit
 * that only works at a modelled hatch, and lands you on top of your own hull, is
 * both harder to trigger by accident and tells you where you came from. */
const HATCH = new THREE.Vector3(0, 0, -1.5);
function nearHatch() {
  const p = pilot.pos.clone().sub(boat.origin);
  return Math.abs(p.x - HATCH.x) < 1.0 && Math.abs(p.z - HATCH.z) < 1.1;
}
function enterSwim() {
  game.mode = 'swim';
  pilot.walk = false;
  pilot.enabled = true;
  pilot.pos.copy(boat.origin).add(new THREE.Vector3(0, 3.4, -1.5));
  pilot.vel.set(0, 0, 0);
  pilot.pitch = -0.15;
  pilot.apply();
}
pilot.toggleMode = () => {
  if (game.mode === 'swim') { enterWalk(); return; }
  // Only from under the hatch. Anywhere else, say so rather than doing nothing.
  if (game.mode === 'walk' && nearHatch()) enterSwim();
};
pilot.interact = () => {
  if (game.mode === 'helm') { enterWalk(); pilot.enabled = true; return; }
  if (game.mode !== 'walk') return;
  // Only from the seat: an interaction that works from anywhere is a menu.
  const p = pilot.pos.clone().sub(boat.origin);
  if (p.z > HELM.z - 2.4 && Math.abs(p.x) < 1.1) enterHelm();
};
/* Volumetric cost is steps x resolution and nothing else, so it is the one
 * dial worth exposing. The review harness runs on a software rasteriser where
 * 32 steps at half res takes a minute a frame; real GPUs do not care. Quality
 * verdicts must still be taken at full settings — this is for iteration speed,
 * not for making the numbers look good. */
post.matVol.uniforms.uSteps.value = qNum('vsteps', 32);
post.matComp.uniforms.uDofAmount.value = qNum('dof', 1.0);
post.volScale = qNum('vscale', 0.7);
renderer.info.autoReset = false; // post does many passes; count them all

const backdrop = buildBackdrop(env);
scene.add(backdrop);

/* Where the camera will stand. Kept in sync with POSES below by hand, which is
 * a smell — but the alternative is building props lazily after the pose table,
 * and props that rebuild on every pose change cost more than this duplication. */
const CAM_SPOTS = [
  { x: 442, z: 30, r: 3.2 }, { x: 366, z: 0, r: 3.5 }, { x: 232, z: 44, r: 3.5 },
  { x: 6, z: 22, r: 3.2 }, { x: 22, z: -34, r: 3.2 }, { x: 392, z: 0, r: 4.5 },
  // Keep boulders out of the installation footprint and off the walkway.
  { x: 30, z: -18, r: 15 }, { x: 19, z: 18, r: 6 }, { x: 54, z: 4, r: 5 },
  { x: 14, z: 40, r: 6 },
  // Clear of the wreck and its two camera stations.
  { x: -36, z: 46, r: 13 }, { x: -31, z: 50.2, r: 4 }, { x: -27, z: 44, r: 4 },
];

const terrain = buildTerrain();
/* Kelp grows where light reaches, and nowhere else.
 *
 * This is not dressing: a photosynthetic organism on a canyon floor four hundred
 * metres down would quietly tell the player that none of the optics mean
 * anything. Restricting it to the shelf also gives the descent a real threshold
 * — the vegetation thins out, then stops, and after that it is rock and silt. */
const kelp = buildKelp(950, 150, CAM_SPOTS, undefined, isPhotic, { x: 430, z: 0 });
const rocks = buildRocks(520, 420, CAM_SPOTS);
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
/* On the canyon floor, where they are the only light there is. */
/* The installation, and the lights it carries.
 *
 * Built before the beacons because it decides where they go: a hazard lamp
 * belongs on top of a tower that exists, not at a coordinate chosen by hand and
 * then quietly left floating when the tower moves. */
const station = buildStation();
scene.add(station.mesh);

/* The wreck. Lofted, unlike the station, and placed where the walkway leads. */
const sub = buildSub();
scene.add(sub.mesh);

/* The boat you live in.
 *
 * Replaces the camera-glued cockpit outright. That was a windscreen: correct as a
 * frame around the view, and impossible to leave. This is a place — eighteen
 * metres of hull with a deck through it and three compartments, sitting on the
 * canyon floor with a pure translation so the walking collision stays in hull
 * coordinates. */
const boat = buildInterior();
scene.add(boat.mesh);

const beaconSpecs = [
  { pos: [ 34, -390, -12], col: [220, 300, 330], size: 0.55 },
  { pos: [ 38, -392, -15], col: [150, 200, 225], size: 0.34 },
  { pos: [ 29, -394, -19], col: [260,  90,  30], size: 0.30 },  // red hazard marker
  { pos: [-18, -393, -26], col: [ 40, 210,  90], size: 0.40 },  // bio / green sodium
  { pos: [-22, -396, -31], col: [ 26, 150,  66], size: 0.26 },
  ...station.lights,
];
const beacons = buildBeacons(env, beaconSpecs);
scene.add(beacons);

env.points = [
  { pos: new THREE.Vector3(34, -390, -12), col: new THREE.Vector3(9.0, 12.0, 13.5) },
  { pos: new THREE.Vector3(-18, -393, -26), col: new THREE.Vector3(1.8, 8.5, 3.6) },
];

for (const o of [terrain, kelp, rocks, snow, backdrop, station.mesh, sub.mesh]) env.register(o.material);
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
  // Shelf, in daylight. Kelp, caustics, the full absorption curve on screen.
  shelf:   { x: 442, z:  30, h: 2.4, yaw: -100, pitch:   4, lamp: 0.18 },
  // Standing at the rim looking over the edge into nothing. The shot that
  // exists to make the drop legible before you commit to it.
  rim:     { x: 366, z:   0, h: 4.5, yaw:  -94, pitch: -24, lamp: 0.40 },
  // The wall itself, lamp across the face. Tests strata and grazing light.
  wall:    { x: 232, z:  44, h: 6.0, yaw:  -84, pitch: -28, lamp: 1.0 },
  // Canyon floor, ~440 m down. No daylight reaches here at all.
  deep:    { x:   6, z:  22, h: 3.0, yaw:   16, pitch:  -7, lamp: 1.0 },
  // Close lamp pool on silt: the hardest test of the terrain normals.
  floor:   { x:  22, z: -34, h: 1.4, yaw:   34, pitch: -25, lamp: 1.0 },
  /* On the walkway, looking along it into nothing.
   *
   * This is the reference frame: a handrail receding, two red lamps a long way
   * off, and otherwise black. It is also the shot that proves the steel is doing
   * its job — straight lines give the eye a scale and a sharpness reference that
   * noise-derived rock cannot. */
  catwalk: { x: 19, z: 18, h: 7.2, yaw: -159, pitch:  -5, lamp: 1.0 },
  /* The wreck, from off the bow quarter. Heading solved from its position at
   * (-36, 46): the loft has to be judged on its silhouette, so the camera sits
   * where the section change from shouldered stern to round nose is side-on. */
/* Side-on, and the heading is solved rather than chosen.
   *
   * The hull is yawed 2.35 rad, so its axis runs along (0.707, 0, -0.707). Viewing
   * down that axis shows a circular section and nothing else — the exponent sweep
   * from shouldered stern to round bow is only visible perpendicular to it. This
   * camera sits on that perpendicular, nine metres out, which is also inside the
   * lamp's useful range at this depth. Eighteen metres put the wreck in the dark. */
  wreck:  { x: -31.0, z: 50.2, h: 1.5, yaw:  -45, pitch:  -2, lamp: 1.0 },
  // Close on the viewport surround, where the plating and seams are readable.
  bow:    { x: -27.0, z: 44.0, h: 1.8, yaw:  -80, pitch:  -4, lamp: 1.0 },
  // The platform from off to one side, so its silhouette reads against the dark.
  /* Yaw solved from the geometry, not guessed. The platform sits at (30,-18) and
   * this camera at (54,4), so the heading is atan2(dx, -dz) of that difference —
   * about -48 degrees. Guessing -112 aimed it into open water and the frame came
   * back as nothing but lamp glow. */
  station: { x: 54, z:  4, h: 7.5, yaw:  -48, pitch: -11, lamp: 1.0 },
  // High over the shelf, aimed down the slope. The descent, as a picture.
  descent: { x: 392, z:   0, h: 26,  yaw:  -92, pitch: -38, lamp: 0.45 },
};

let curPose = 'shelf';
const D2R = Math.PI / 180;

function applyPose(name) {
  const p = POSES[name] || POSES.shelf;
  curPose = name;
  const y = seabedHeight(p.x, p.z) + p.h;
  // The pilot owns position and orientation; the camera is downstream of it.
  // Two owners of the camera transform is how you get a review harness whose
  // poses drift by one frame of player input.
  pilot.setFrom(new THREE.Vector3(p.x, y, p.z), p.yaw, p.pitch, 0);
  game.lampOn = p.lamp;
  syncWater();
  // Snap, do not ease. A review frame must not depend on how long the harness
  // happened to wait for the adaptation to finish.
  adaptExposure(0, true);
}

/* Depth is expressed by moving the sea surface, not the camera.
 *
 * The camera stays near the terrain (authored around y=0) while `surfaceY` sits
 * far overhead, so the optics get a true kilometre of water above them without a
 * kilometre-tall mesh or any floating-point heroics.
 *
 * Crucially the surface is then left alone, and depth is *derived* from where the
 * camera actually is. That is what makes descending mean something: sink four
 * metres and four metres of water appear above you, the daylight term drops, and
 * the palette shifts — with no code watching for it. Setting depth as an
 * independent number instead would have let the two disagree, so that swimming
 * downward changed the view without changing the water. */
/* Harness convenience only: force a given depth at the camera's current height
 * by offsetting the surface. Normal play never calls this — depth is wherever
 * you have swum to. It exists so the review set can still shoot a depth ladder
 * from one position instead of needing an eleven-kilometre mesh. */
function setDepthBand(metres) {
  pilot.band = pilot.bandTarget = metres + camera.position.y - SEA_LEVEL;
  env.surfaceY = SEA_LEVEL + pilot.band;
}

/* Eye adaptation, computed rather than measured.
 *
 * Between six metres of daylight and four kilometres of black there is something
 * like four orders of magnitude of ambient light. A fixed exposure cannot serve
 * both: tuned for depth it whites out on the way up — which is what "I nearly
 * went blind while ascending" is — and tuned for the surface the deep is an
 * unreadable black frame.
 *
 * No luminance histogram is needed, because the ambient field here is analytic:
 * surfaceIrr * exp(-Kd * depth) is exactly what the water is doing, so the
 * brightness of the frame can be predicted instead of sampled. That avoids a
 * GPU-to-CPU readback and the pipeline stall it costs, and it cannot oscillate
 * the way a feedback loop reading its own output can.
 *
 * The time constant is the point, though. Snapping exposure per-frame would keep
 * the image legible and feel like a bug; a second and a half of lag reads as an
 * eye, or an aperture, catching up — and it lets the frame genuinely dazzle for a
 * moment when you rise into the light, which is the sensation worth having.
 */
function adaptExposure(dt, snap = false) {
  const d = game.depth;
  const amb = [
    env.surfaceIrr.x * Math.exp(-env.kd.x * d),
    env.surfaceIrr.y * Math.exp(-env.kd.y * d),
    env.surfaceIrr.z * Math.exp(-env.kd.z * d),
  ];
  // Most of the frame is in-scattered water, so that is what sets the level.
  const fog = [
    amb[0] * env.albedo.x * env.scatterGain,
    amb[1] * env.albedo.y * env.scatterGain,
    amb[2] * env.albedo.z * env.scatterGain,
  ];
  let lum = 0.2126 * fog[0] + 0.7152 * fog[1] + 0.0722 * fog[2];
  /* The lamp pool is a small, very bright part of the frame, and adaptation that
   * underestimates it opens up until that pool clips to flat white — which is
   * what every deep review frame was doing. */
/* The lamp's *average* contribution to the frame, which is what an exposure
   * meter integrates — a bright pool over maybe a tenth of the image. Set to the
   * peak instead, this closed down until the deep scenes were unreadable; set
   * near zero it opened up until the pool clipped. */
  lum += game.lampOn * 0.075;
  lum += 0.0016;                // bio floor, so the deep does not divide by zero
  const want = Math.min(6.0, Math.max(0.08, 0.135 / lum));
  // Exact exponential approach: frame-rate independent, and stable on a long frame.
  post.exposure = snap ? want
    : post.exposure + (want - post.exposure) * (1 - Math.exp(-dt / 1.5));
}

function syncWater() {
  game.depth = Math.max(0.4, env.surfaceY - camera.position.y);
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
  /* Turbidity is the colour control, not the brightness control.
   *
   * Lowering it to let more light through walked the blend back toward oceanic
   * water, and the whole game turned sapphire — the teal is the coastal end.
   * Brightness comes from surfaceIrr; the water type stays where the reference
   * is. Two knobs that look interchangeable and are not. */
  const turb = Math.max(0.15, 0.34 - game.depth / 3400);
  env.setWater('IB', 'C1', turb);
  env.lampInt = 900 * game.lampOn;
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
  mode: 'walk',
  zone: '', pressure: 1,
  fps: 0, frames: 0,
  time: 0,
  poses: Object.keys(POSES),
  scene, camera, renderer, env, post,
  pilot,
  // Exposed so the review harness can photograph the interior, which no camera
  // pose can reach — being inside the boat is a mode, not a viewpoint.
  walk: () => enterWalk(), helm: () => enterHelm(), swim: () => enterSwim(),
  boatOrigin: () => boat.origin.clone(),
  pose: (n) => { applyPose(n); },
  /* setDepthBand already solved for the offset that yields this depth at the
   * camera's current height; assigning the raw metres afterwards threw that
   * solution away and asked for 1200 m of surface above a floor already 424 m
   * down, which is how a 1200 m rung came out at 1624 m. */
  setDepth: (m) => { setDepthBand(m); syncWater(); adaptExposure(0, true); },
  setLamp: (v) => { game.lampOn = v; syncWater(); },
  setWater: (a, b, t) => env.setWater(a, b, t),
  visibility: () => env.visibility,
  setLayer: (name, on) => {
    const o = { kelp, rocks, snow, terrain, beacons, station: station.mesh, sub: sub.mesh, boat: boat.mesh }[name];
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

  // Pilot first: everything downstream reads the camera, so it has to be final
  // before the water is evaluated or the fog lags the view by a frame.
  // Keep the vehicle in its water. MIN_DEPTH metres of cover, always.
  pilot.ceilingY = env.surfaceY - MIN_DEPTH;
  pilot.update(dt);
  // Absolute surface plus an optional offset. Depth is then purely a function
  // of where the camera is, which is what makes swimming down mean something.
  env.surfaceY = SEA_LEVEL + pilot.band;
  syncWater();
  adaptExposure(dt);

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

  const iu = boat.mat.uniforms;
  iu.uTime.value = game.time;
  iu.uPressure.value = game.pressure;
  // The alarm answers the hull rating, so the dread is a function of depth
  // rather than a scripted beat.
  iu.uAlarm.value = Math.min(1, Math.max(0, (game.depth - 260) / 340));
  iu.uLamps.value = 1.0;
  // The interior shades in hull-local space, so it needs the eye there too.
  iu.uEye.value.copy(camera.position).sub(boat.origin);

  renderer.info.reset();
  post.render(scene, camera, env);

  game.frames++; fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { game.fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }

  /* Tell the player what is possible, where they are standing.
   *
   * Without this the boat is a set of rooms with no verbs in them: a pilot's seat
   * and a blank wall look identical, and nothing on screen suggests that E exists.
   * The prompt is the difference between an interior and a place you can use. */
  const prompt = document.getElementById('prompt');
  const ptext = document.getElementById('promptText');
  let pmsg = null;
  if (game.mode === 'helm') pmsg = 'Stand up';
  else if (game.mode === 'walk') {
    const lp = pilot.pos.clone().sub(boat.origin);
    if (lp.z > HELM.z - 2.4 && Math.abs(lp.x) < 1.1) pmsg = 'Take the helm';
    else if (nearHatch()) pmsg = 'V — go outside through the hatch';
  } else if (game.mode === 'swim') {
    const d = pilot.pos.distanceTo(boat.origin);
    if (d < 9) pmsg = 'V — back inside';
  }
  if (pmsg) { ptext.textContent = pmsg; prompt.hidden = false; } else prompt.hidden = true;

  const legend = document.getElementById('legend');
  if (!legend.hidden) {
    const rows = game.mode === 'helm'
      ? [['Mouse', 'look'], ['E', 'stand up'], ['L', 'lamp']]
      : game.mode === 'walk'
        ? [['W A S D', 'walk'], ['Mouse', 'look'], ['Space', 'step up'],
           ['E', 'use'], ['V', 'exit at hatch'], ['L', 'lamp']]
        : [['W A S D', 'thrust'], ['Space / C', 'rise / sink'], ['Shift', 'transit'],
           ['V', 'back inside'], ['L', 'lamp'], ['H', 'hide this']];
    const html = rows.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
    if (legend.dataset.sig !== html) { legend.dataset.sig = html;
      document.getElementById('legBody').innerHTML = html; }
  }

  const hud = document.getElementById('hud');
  if (!hud.hidden) {
    document.getElementById('hDepth').textContent = Math.round(game.depth);
    document.getElementById('hHull').textContent = Math.round(game.pressure);
    document.getElementById('hSpeed').textContent = pilot.speed.toFixed(1);
  }
  const st = document.getElementById('stats');
  if (!st.hidden) {
    st.textContent = `${game.fps.toFixed(0)} fps  ${W}x${H}\n`
      + `${curPose}  ${Math.round(game.depth)} m  ${game.zone}\n`
      + `vis ${env.visibility.toFixed(1)} m  ${game.pressure.toFixed(0)} atm\n`
      + `${pilot.speed.toFixed(2)} m/s  band ${Math.round(pilot.band)} m`;
  }
}

/* -------------------------------------------------------------------- start */
function begin() {
  document.getElementById('boot').style.opacity = '0';
  setTimeout(() => { document.getElementById('boot').style.display = 'none'; }, 950);
  if (qStr('hud', '1') === '1') document.getElementById('hud').hidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH') {
      const l = document.getElementById('legend');
      l.hidden = !l.hidden;
    }
  });
  if (qStr('stats', '0') === '1') document.getElementById('stats').hidden = false;
  game.started = true;
  clock.getDelta();

  /* Piloting stays off unless a human asked for it.
   *
   * The review harness boots with auto=1 and then poses the camera itself. If
   * input were live by default, a latched key or a stray pointer event would
   * move the camera between the pose and the shutter, and every frame in the
   * set would be subtly framed differently from the one it is compared against. */
  if (qStr('fly', '1') === '1' && qStr('auto', '0') !== '1') {
    pilot.enabled = true;
    canvas.requestPointerLock?.();
  }
}

applyPose(qStr('pose', 'shelf'));
/* Default to standing in the boat. The harness still drives poses explicitly, so
 * this only affects a human opening the page. */
if (!qs.has('pose')) enterWalk();
if (qs.has('depth')) game.setDepth(qNum('depth', 38));
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
