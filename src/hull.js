/* The principal dimensions of the boat, and nothing else.
 *
 * These five numbers were in `fitout.js`, which is the right place for them
 * right up until something without a renderer needs to know how big the hull
 * is. `fitout.js` imports `three`, the bare specifier `'three'` resolves
 * through the import map in `index.html`, and node knows nothing about import
 * maps — so every module that wants a hull dimension inherited a browser
 * dependency it had no use for.
 *
 * That mattered the moment the sound layer needed the beam of the boat to work
 * out the frequency of the air inside it. `src/acoustics.js` has to be
 * importable by a test in node with no loader and no build step, because sound
 * is nothing but time constants and the sandbox cannot measure a time constant
 * through a browser. One file with no imports at all fixes that for good, for
 * this subsystem and for the next one.
 *
 * `fitout.js` re-exports every name below, so nothing that already imported
 * them from there had to change.
 */

// Hull geometry. Everything else in the boat is derived from these five numbers.
export const HULL_LEN = 9.0;      // half-length: z from -9 to +9
export const HULL_R = 2.35;       // interior radius at the widest
export const DECK_Y = -1.05;      // deck plane, below the hull axis
export const DECK_HALF = 1.95;    // deck half-width
export const EYE = 1.62;          // standing eye height above the deck
export const HELM = { z: 6.9, y: DECK_Y + 1.18 };   // seated eye at the helm
