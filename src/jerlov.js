/* Seawater optics — measured constants, not art-directed guesses.
 *
 * The palette of this game is not chosen. It falls out of these numbers, the
 * same way a photograph's colour falls out of the water it was taken in. Red
 * dies in the first few metres because a(625nm) is thirty times a(450nm), and
 * no amount of colour grading should be used to fake that.
 *
 * Two different coefficients matter and confusing them is the classic error:
 *
 *   c  = a + b   beam attenuation. How a *ray* is lost — the surface you are
 *                looking at, dimmed over the distance to it. Use for Beer's law
 *                along the view ray.
 *   Kd           diffuse downwelling attenuation. How the *ambient field* from
 *                the surface decays with depth. Always smaller than c, because
 *                multiply-scattered photons partly compensate. Use for "how
 *                much daylight is left at this depth".
 *
 * Using c for both makes deep water pitch black far too early. Using Kd for
 * both makes distant geometry stay legible when it should have dissolved.
 *
 * Sources:
 *   Pope & Fry 1997, Applied Optics 36(33):8710  — pure water absorption
 *   Morel 1974 / Solonenko & Mobley 2015 Eq.8a   — molecular scattering
 *   Solonenko & Mobley 2015, Applied Optics 54:5392, Tables 4-8
 *     — inherent optical properties reconstructed for each Jerlov type (±15%)
 *
 * RGB is sampled at R=625nm, G=535nm, B=450nm.
 */

/** Beam attenuation c = a + b, in m^-1, at (625, 535, 450) nm. */
export const EXTINCTION = {
  I:   [0.296, 0.054, 0.022],   // clearest open ocean, horizon ~200 m
  IA:  [0.298, 0.057, 0.028],
  IB:  [0.343, 0.108, 0.092],   // ~50 m visibility. The "beautiful" water.
  II:  [0.584, 0.428, 0.528],   // ~9 m. Milky, scattering-dominated.
  III: [1.085, 1.084, 1.419],
  C1:  [0.597, 0.454, 0.619],   // clear coastal
  C3:  [1.162, 1.194, 1.654],
  C9:  [2.946, 3.673, 5.333],   // harbour, <1 m
};

/** Scattering b, in m^-1, same bands. Single-scattering albedo is b/c. */
export const SCATTER = {
  I:   [0.00104, 0.00185, 0.00381],
  IA:  [0.00256, 0.00381, 0.00631],
  IB:  [0.0468,  0.0553,  0.0680],
  II:  [0.2880,  0.3754,  0.5040],
  III: [0.7880,  1.0280,  1.3800],
  C1:  [0.2930,  0.3830,  0.5140],
  C3:  [0.8550,  1.1140,  1.5000],
  C9:  [2.5100,  3.2760,  4.3900],
};

/* Diffuse downwelling Kd, m^-1, interpolated from Jerlov's tabulated spectra
 * (Solonenko & Mobley Table 4) at our three bands. This is what sets how fast
 * the world goes dark as you descend — the single most important curve in the
 * game, because it is the descent itself. */
export const KD = {
  I:   [0.301, 0.045, 0.019],
  IA:  [0.308, 0.052, 0.026],
  IB:  [0.315, 0.058, 0.034],
  II:  [0.342, 0.085, 0.062],
  III: [0.386, 0.130, 0.122],
  C1:  [0.386, 0.130, 0.174],
  C3:  [0.431, 0.202, 0.288],
  C9:  [0.654, 0.680, 1.560],
};

const lerp3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Blend between two Jerlov types.
 *
 * Real water is not one of nine discrete types — Jerlov's classes are sample
 * points on a continuum, so interpolating between neighbours is legitimate and
 * is how you dial visibility without inventing physics. `turbidity` 0 gives
 * `from`, 1 gives `to`.
 */
export function water(from = 'IB', to = 'II', turbidity = 0.22) {
  const t = Math.min(1, Math.max(0, turbidity));
  const c = lerp3(EXTINCTION[from], EXTINCTION[to], t);
  const b = lerp3(SCATTER[from], SCATTER[to], t);
  const kd = lerp3(KD[from], KD[to], t);
  return {
    extinction: c,
    scatter: b,
    kd,
    // Single-scattering albedo. Near 0 = absorbing (ink), near 1 = milky.
    albedo: [b[0] / c[0], b[1] / c[1], b[2] / c[2]],
  };
}

/**
 * Duntley's contrast-threshold range, ~4.8/c at the most transmissive band.
 * Reported so the harness can assert that a scene's visibility is what the
 * art direction claims rather than what someone eyeballed.
 */
export function visibility(w) {
  return 4.8 / Math.min(...w.extinction);
}

/* Depth zones. These are real oceanographic boundaries, and they are also the
 * act structure: each one looks different because the physics differs, not
 * because a designer picked a new palette. */
export const ZONES = [
  { name: 'epipelagic',  top: 0,    bottom: 200,  label: 'Sunlight' },
  { name: 'mesopelagic', top: 200,  bottom: 1000, label: 'Twilight' },
  { name: 'bathypelagic',top: 1000, bottom: 4000, label: 'Midnight' },
  { name: 'abyssopelagic',top:4000, bottom: 6000, label: 'Abyss' },
  { name: 'hadal',       top: 6000, bottom: 11000,label: 'Hadal' },
];

export function zoneAt(depth) {
  return ZONES.find((z) => depth >= z.top && depth < z.bottom) || ZONES[ZONES.length - 1];
}

/** Ambient pressure in atmospheres. 1 atm at surface, +1 per ~10.06 m. */
export function pressureAt(depth) {
  return 1 + depth / 10.06;
}
