/* Seeded PRNG.
 *
 * Every piece of procedural placement in this game goes through here, and that
 * is not a style preference — it is what makes the review process valid.
 *
 * With Math.random() the world is rebuilt differently on every page load. The
 * consequences are worse than "the layout varies":
 *
 *   - The review set is not a review set. Two runs of the survey photograph two
 *     different worlds, so a frame cannot be compared against yesterday's frame
 *     and a pixel-difference regression gate is impossible to build.
 *   - A judge's criticism cannot be acted on. "The kelp on the left is too
 *     sparse" refers to kelp that will not exist next run.
 *   - Bugs stop being reproducible. This was found when a pose that was full of
 *     kelp locally came up as empty water on another machine — which looked
 *     exactly like a shader failure on unfamiliar hardware, and was not.
 *
 * mulberry32: one multiply-xorshift round, 2^32 period, passes gjrand's smallcrush.
 * Far better than needed for scattering boulders, and it is four lines.
 */
export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Named streams. Each subsystem draws from its own generator so that changing
 * the kelp count cannot shift every boulder — otherwise adding one plant
 * reshuffles the entire world and every approved frame silently changes. */
export const SEEDS = {
  kelp: 0x5eed0001,
  rocks: 0x5eed0002,
  snow: 0x5eed0003,
  debris: 0x5eed0004,
};
