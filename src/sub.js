import * as THREE from 'three';
import { Welder, structureMaterial, MAT } from './structures.js';
import { loftInto, fairStations } from './loft.js';
import { seabedHeight } from './terrain.js';
import { rng, SEEDS } from './rng.js';

/* A submersible, built by lofting rather than by assembly.
 *
 * Worth stating what changes. The station on the canyon floor is boxes and tubes,
 * and it reads as boxes and tubes under any lighting, because every silhouette is
 * an axis-aligned edge and every junction is two solids intersecting. That is the
 * ceiling the reference skill describes, and no shader gets past it.
 *
 * A hull cannot be made that way at all. This is six control stations, faired
 * into twenty-six with a Catmull-Rom spline, swept as a superellipse whose
 * exponent falls from 3.2 at the stern to 1.8 at the bow — so a shouldered, nearly
 * rectangular tail becomes a rounded nose across one unbroken skin. Joining a
 * cylinder to a sphere cannot produce that transition; there is always a crease
 * where the two curvatures meet.
 *
 * Placed as a wreck, half into the silt and rolled over, for two reasons. It puts
 * the technique on screen immediately without needing a cockpit interior first,
 * and a second vehicle down here says more about what happened than any note
 * could — this is the shape the player is sitting inside, lying on its side.
 */

/** Panel bays cut into the skin: a shallow recess, proud ribs between them. */
function hullRecess(u, v) {
  // Ribs at intervals along the length, a shallow bay between each pair.
  const rib = Math.abs(((v * 6.0) % 1) - 0.5) * 2.0;
  const bay = rib > 0.72 ? 0.0 : -0.035;
  // Keel and deck strakes stand slightly proud: they are the heavy plates.
  const strake = (Math.abs(u - 0.25) < 0.035 || Math.abs(u - 0.75) < 0.035) ? 0.02 : 0.0;
  return bay + strake;
}

export function buildSub(seed = SEEDS.debris ^ 0x51) {
  const rand = rng(seed);
  const W = new Welder();

  /* Six control stations, stern to bow. The exponent sweep is the point: it does
   * the work that a chain of primitives cannot. */
/* Ends taper to a point rather than being capped flat.
   *
   * loftInto() closes an open end with a flat fan, and on a bow 0.62 m across
   * that is a visible disc stuck on the nose. Two extra stations shrinking to
   * almost nothing let the skin close itself, so the nose is a real rounded form
   * and the cap that remains is a few millimetres wide. */
  const control = [
    { z: -5.05, x: 0, y: 0.00, w: 0.10, h: 0.10, sq: 2.2 },
    { z: -4.6, x: 0, y: 0.00, w: 0.85, h: 0.85, sq: 3.3 },
    { z: -3.1, x: 0, y: 0.05, w: 2.00, h: 1.85, sq: 3.0 },
    { z: -0.9, x: 0, y: 0.10, w: 2.52, h: 2.28, sq: 2.6 },
    { z: 1.3, x: 0, y: 0.12, w: 2.50, h: 2.34, sq: 2.3 },
    { z: 3.2, x: 0, y: 0.06, w: 1.96, h: 1.88, sq: 2.0 },
    { z: 4.7, x: 0, y: -0.02, w: 0.62, h: 0.60, sq: 1.7 },
    { z: 5.18, x: 0, y: -0.03, w: 0.09, h: 0.09, sq: 1.5 },
  ];
  /* Sixty-four around, fifty-six along. Measured, not guessed: twenty segments
   * on this diameter is a 39 cm facet and fifty-seven pixels across at six
   * metres; sixty-four brings it to twelve centimetres and eighteen pixels, and
   * with smooth normals it reads as a curve. The whole hull is still under eight
   * thousand triangles — the previous version was not low-poly for any budgetary
   * reason, it was low-poly by oversight. */
  loftInto(W, fairStations(control, 56), {
    count: 64, mat: MAT.HULL, wear: 0.72, recess: hullRecess,
  });

  /* Conning fairing, lofted too. A box here would undo the whole exercise — the
   * eye reads the junction between a curved hull and a flat-sided lump instantly. */
  const sail = [
    { z: -1.9, x: 0, y: 1.05, w: 0.55, h: 0.50, sq: 2.4 },
    { z: -1.0, x: 0, y: 1.28, w: 1.28, h: 0.98, sq: 3.0 },
    { z: 0.6, x: 0, y: 1.32, w: 1.30, h: 1.02, sq: 3.0 },
    { z: 1.6, x: 0, y: 1.10, w: 0.60, h: 0.54, sq: 2.2 },
  ];
  loftInto(W, fairStations(sail, 26), { count: 40, mat: MAT.HULL, wear: 0.6 });

  // Viewport surround at the bow: a proud ring, then the port itself set back.
  W.tube(0, 0.02, 4.16, 0, 0.02, 4.36, 0.46, 44, MAT.STEEL, 0.55);
  W.tube(0, 0.02, 4.30, 0, 0.02, 4.33, 0.40, 44, MAT.GLASS, 0.2);

  // Thruster shroud at the stern, and the stator vanes inside it.
  W.tube(0, 0.0, -4.9, 0, 0.0, -4.35, 0.62, 48, MAT.PIPE, 0.8);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    W.box(Math.cos(a) * 0.3, Math.sin(a) * 0.3, -4.62, 0.06, 0.52, 0.34, a, MAT.STEEL, 0.85);
  }

  // Skids, and the frames that carry them.
  for (const side of [-1, 1]) {
    W.tube(side * 0.95, -1.28, -3.2, side * 0.95, -1.28, 3.4, 0.09, 16, MAT.PIPE, 0.8);
    for (const z of [-2.6, -0.6, 1.4, 3.0]) {
      W.tube(side * 0.78, -0.95, z, side * 0.95, -1.28, z, 0.06, 12, MAT.PIPE, 0.85);
    }
  }

  // Lamp housings on the bow shoulders, dark and dead.
  for (const side of [-1, 1]) {
    W.tube(side * 0.72, 0.42, 3.5, side * 0.86, 0.46, 3.95, 0.17, 22, MAT.STEEL, 0.7);
  }

  // Grab rails along the deck: small, and the only straight lines on the thing,
  // which is exactly why they sell its scale.
  for (const side of [-1, 1]) {
    for (const z of [-2.2, -0.2, 1.8]) {
      W.tube(side * 0.62, 1.02, z - 0.4, side * 0.62, 1.02, z + 0.4, 0.032, 12, MAT.PIPE, 0.85);
    }
  }

  const mesh = new THREE.Mesh(W.geometry(), structureMaterial());
  mesh.frustumCulled = false;
  mesh.name = 'sub';

  /* Lay it in the silt: rolled hard over, nose down, and settled deep enough that
   * the lower flank has clearly been buried for a long time. */
  const x = -36, z = 46;
  const gy = seabedHeight(x, z);
  /* Rolled, but not so far that the hull is a buried lump.
   *
   * At 1.12 rad it lay almost on its side with only the upper flank clear of the
   * silt, which hides the very thing the loft is for: the section changing along
   * the length. Two thirds of that roll keeps the wreck reading as fallen while
   * leaving the profile legible. */
  mesh.position.set(x, gy + 1.85, z);
  mesh.rotation.set(-0.09, 2.35, 0.72, 'YXZ');
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);

  return { mesh, at: [x, gy, z] };
}
