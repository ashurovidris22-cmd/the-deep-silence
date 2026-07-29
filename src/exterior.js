import * as THREE from 'three';
import { Welder, structureMaterial, MAT } from './structures.js';
import { loftInto, fairStations } from './loft.js';
import { HULL_LEN, HULL_R, shellX } from './fitout.js';

/* The outside of the boat you have been living in.
 *
 * There was not one. `buildInterior` lofts a single skin with its normals turned
 * inward, which is exactly right for a room and means the vessel has no exterior
 * at all — every polygon faces the cabin. That was invisible while she was
 * bolted to the canyon floor and you could only leave through a hatch onto her
 * own back. The moment she could be driven, and swum away from, it became the
 * most obvious hole in the game: a submarine you can watch from outside, that
 * isn't there.
 *
 * Built as a second skin at the same stations plus plating thickness, so the two
 * cannot drift apart — the numbers come from the same HULL_R and HULL_LEN the
 * interior and the collision use. Drawn with the outdoor material, because
 * unlike the cabin this surface is *in* the water and has to obey the same
 * absorption, in-scatter and lamp attenuation as the seabed does.
 *
 * The nose is deliberately left open. The interior's acrylic port sits at
 * z = 8.45 and the helm looks straight through it; capping the exterior would
 * put a steel disc across the one view the bow compartment exists for. Ending
 * the loft short and ringing the opening reads as a recessed viewport from
 * outside and changes nothing from inside.
 */

const PLATE = 0.13;          // plating and frame depth, metres
const W_MAX = HULL_R * 2;    // interior full width at the widest station

/* Outboard of the skin, by construction rather than by eye.
 *
 * Every external fitting has to clear the *pressure hull*, and the pressure hull
 * is a tapering superellipse — so a fitting placed at a constant x is inside the
 * cabin amidships and outside it at the ends, or the reverse. The first pass put
 * the saddle tanks, the riser vents, the skid struts and the whole conning trunk
 * at fixed offsets, and from inside the boat they came through the wall: bright
 * teal rectangles hanging in the machinery space, lit by the *outdoor* water
 * material because that is what they are made of.
 *
 * That is a whole class of bug rather than four separate ones, and it has one
 * answer: ask the hull where its skin is at the y and z you are about to build
 * at, and add the clearance you need. `shellX` is the same function the interior
 * and the walking collision use, so the three cannot disagree. */
const outboard = (z, y, clear) => shellX(z, y) + PLATE + clear;

export function buildExterior() {
  const W = new Welder();

  /* The same seven stations as the cabin, widened by the plating.
   *
   * Two extra at the stern let the skin close itself into a real point instead
   * of taking loftInto's flat cap, which on a 0.6 m tail is a visible disc stuck
   * on the end — the same lesson the wreck's control list records. */
  const g = PLATE * 2;
  const control = [
    { z: -HULL_LEN - 1.5, w: 0.10, h: 0.10, sq: 2.0 },
    { z: -HULL_LEN - 0.9, w: 1.30 + g, h: 1.30 + g, sq: 2.2 },
    { z: -HULL_LEN + 1.6, w: 3.50 + g, h: 3.40 + g, sq: 2.4 },
    { z: -3.5, w: 4.66 + g, h: 4.60 + g, sq: 2.5 },
    { z: 2.0, w: W_MAX + g, h: 4.66 + g, sq: 2.4 },
    { z: 6.2, w: 4.10 + g, h: 4.00 + g, sq: 2.2 },
    { z: 7.9, w: 2.70 + g, h: 2.60 + g, sq: 1.9 },
  ];
  /* Sixty-four around. Measured rather than chosen: twenty segments on a 4.9 m
   * beam is a 77 cm facet, which at ten metres is over a hundred pixels of flat
   * shading — the definition of the low-poly look. Sixty-four brings it to
   * 24 cm, and with smooth normals it reads as a curve. */
  loftInto(W, fairStations(control, 54), {
    count: 64, mat: MAT.HULL, wear: 0.55, capBow: false, capStern: false,
  });

  /* Saddle ballast tanks along both flanks, with free-flood vents underneath.
   *
   * These are the tanks the helm's Space and C keys actually operate, so they
   * are worth being able to see. Vents on the bottom and riser holes on top is
   * how a real one works — water in at the keel, air out at the crown — and it
   * gives the flank a row of dark punctuation that sells the hull's length. */
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const z = -7.2 + i * 1.8;
      W.box(side * outboard(z, -0.55, 0.19), -0.55, z, 0.34, 0.62, 1.15, 0, MAT.STEEL, 0.6);
      const vx = side * outboard(z, -0.88, 0.12);
      W.tube(vx, -0.88, z, vx + side * 0.05, -0.86, z, 0.10, 10, MAT.PIPE, 0.8);
      const rx = side * outboard(z, 0.42, 0.08);
      W.tube(rx, 0.42, z, rx + side * 0.05, 0.44, z, 0.055, 8, MAT.PIPE, 0.75);
    }
  }

  /* Conning trunk over the hatch, at the top of the ladder.
   *
   * z = -1.5 is not a chosen number: it is where the ladder is, which is where
   * the hatch is, which is where you surface when you press V. A tower anywhere
   * else would mean climbing out of the hull through solid plate. */
  /* A cylinder standing on the crown, not a fairing lofted into it.
   *
   * The lofted version was the worst of the four penetrations: a superellipse
   * always closes at the bottom, so however high the station is placed its lower
   * point is on the tower's axis — and the axis runs straight down through the
   * cabin. It came out as a large bright box standing in the middle of the
   * machinery space. A tube starting *above* the crown cannot do that, and the
   * hull skin hides the join from outside. */
  const HZ = -1.5;
  const crown = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(HZ) / HULL_LEN, 3.2)));
  const TB = crown + 0.06;                 // trunk base, clear of the pressure hull
  W.tube(0, TB, HZ, 0, TB + 0.62, HZ, 0.64, 34, MAT.HULL, 0.5);
  W.tube(0, TB - 0.02, HZ, 0, TB + 0.10, HZ, 0.76, 34, MAT.STEEL, 0.6);   // flared base
  // The hatch itself, its coaming and the dogs round it.
  W.tube(0, TB + 0.62, HZ, 0, TB + 0.70, HZ, 0.68, 30, MAT.STEEL, 0.6);
  W.tube(0, TB + 0.70, HZ, 0, TB + 0.76, HZ, 0.58, 28, MAT.STEEL, 0.5);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    W.box(Math.cos(a) * 0.70, TB + 0.66, HZ + Math.sin(a) * 0.70, 0.07, 0.07, 0.07, a, MAT.PIPE, 0.6);
  }
  // Grab rails along the crown, the only straight lines on her.
  for (const side of [-1, 1]) {
    const gx = side * 0.80;
    W.tube(gx, crown - 0.22, HZ - 2.6, gx, crown - 0.22, HZ + 2.4, 0.030, 10, MAT.PIPE, 0.7);
  }

  /* Bow port surround: a proud ring round the opening the loft leaves. */
  W.tube(0, 0.10, 7.96, 0, 0.10, 8.12, 1.34, 48, MAT.STEEL, 0.5);
  W.tube(0, 0.10, 8.10, 0, 0.10, 8.16, 1.22, 48, MAT.PIPE, 0.45);

  /* Floodlights on the bow shoulders, off-axis exactly as the lighting code
   * mounts them — a lamp beside the lens fires its beam back into it, which is
   * why divers put strobes on arms and submersibles hang floods off the frame. */
  for (const side of [-1, 1]) {
    const lx = side * outboard(6.9, -0.35, 0.26);
    const lx2 = side * outboard(7.5, -0.42, 0.26);
    W.tube(lx, -0.35, 6.9, lx2, -0.42, 7.6, 0.24, 20, MAT.STEEL, 0.55);
    W.tube(lx2, -0.42, 7.6, lx2 * 1.01, -0.43, 7.68, 0.26, 20, MAT.GLASS, 0.2);
    W.tube(lx, -0.35, 6.9, side * outboard(6.5, -0.20, 0.04), -0.20, 6.5, 0.06, 8, MAT.PIPE, 0.7);
  }

  /* Landing skids. She sits on the bottom, so she needs something to sit on —
   * and they are also what makes the hull read as a vehicle rather than a pipe. */
  for (const side of [-1, 1]) {
    W.tube(side * 1.62, -2.62, -5.6, side * 1.62, -2.62, 5.4, 0.14, 14, MAT.PIPE, 0.72);
    for (const z of [-4.8, -2.2, 0.6, 3.2, 5.0]) {
      W.tube(side * outboard(z, -1.90, 0.10), -1.90, z,
        side * 1.62, -2.62, z, 0.085, 10, MAT.PIPE, 0.78);
    }
    W.tube(side * 1.62, -2.62, 5.4, side * outboard(6.2, -1.80, 0.10), -1.80, 6.2, 0.13, 12, MAT.PIPE, 0.7);
  }

  /* Thruster: a shroud and its stator vanes. The rotor is a separate mesh so it
   * can turn — see below. */
  const TZ = -HULL_LEN - 0.55;
  W.tube(0, 0, TZ - 0.55, 0, 0, TZ + 0.30, 1.02, 40, MAT.PIPE, 0.7);
  W.tube(0, 0, TZ - 0.60, 0, 0, TZ - 0.52, 1.10, 40, MAT.STEEL, 0.6);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    W.box(Math.cos(a) * 0.76, Math.sin(a) * 0.76, TZ + 0.14, 0.07, 0.52, 0.40, a, MAT.STEEL, 0.75);
  }
  // Control surfaces: a rudder on the centreline and a pair of stern planes.
  W.box(0, 1.45, TZ + 0.55, 0.10, 1.30, 1.10, 0, MAT.STEEL, 0.6);
  for (const side of [-1, 1]) {
    W.box(side * 1.35, 0.05, TZ + 0.62, 1.55, 0.09, 0.95, 0, MAT.STEEL, 0.6);
  }

  const mesh = new THREE.Mesh(W.geometry(), structureMaterial());
  mesh.frustumCulled = false;
  mesh.name = 'exterior';
  /* Front faces only, which is what keeps this invisible from inside.
   *
   * The outdoor material does not set `side`, so it defaults to FrontSide: every
   * polygon here faces outward, so from the cabin they are all back-facing and
   * culled. That is the whole reason a second skin costs nothing when you are
   * indoors, and why it does not need switching off by hand. */

  /* The rotor, as its own mesh purely so that it can spin.
   *
   * Feedback, and the cheapest kind there is. Sitting at the helm you cannot see
   * the stern, but swim out with the telegraph set and a turning propeller tells
   * you the boat is under power far more directly than any instrument inside —
   * and it is the only moving part on the whole exterior. */
  const PW = new Welder();
  PW.tube(0, 0, 0, 0, 0, 0.22, 0.20, 16, MAT.STEEL, 0.55);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    /* Blades set at a pitch. A flat blade is a paddle; the twist is what makes
     * it read as something that screws itself through water. */
    PW.box(Math.cos(a) * 0.52, Math.sin(a) * 0.52, 0.10,
      0.13, 0.92, 0.30, a + 0.55, MAT.STEEL, 0.5);
  }
  const prop = new THREE.Mesh(PW.geometry(), structureMaterial());
  prop.frustumCulled = false;
  prop.name = 'prop';
  prop.position.set(0, 0, TZ - 0.05);
  mesh.add(prop);

  return { mesh, prop, material: mesh.material, propMaterial: prop.material };
}
