# The Deep Silence

A deep-sea horror game that runs in a browser. Three.js + WebGL2, no engine, no
external assets — every mesh and every texture is generated at runtime.

Visual target: the look of **SOMA**. Tension target: the systemic dread of
**Barotrauma** — a thin metal hull, a finite power budget, and pressure that only
ever increases. Not Barotrauma's art style.

**Status: phase 1 — water.** The optics, the seabed, the silhouette layer and the
post chain exist. The submersible, its interior, the pressure systems and the
inhabitants do not yet.

## Why the water is not art-directed

The palette is not chosen. It is computed from published seawater optics, and the
one decision that mattered was picking the right *kind* of water:

- **Open ocean transmits blue best**, so it renders as sapphire.
- **Shelf water** carries dissolved organics that absorb the blue end, so **green
  survives longest** — and that is the teal every frame of the reference is made
  of.

Getting there by tinting an oceanic palette green would have looked right in one
shot and fallen apart at every other depth. Changing the water type keeps it true
at all depths for free. Constants live in `src/jerlov.js` with their provenance.

Two coefficients do two different jobs, and conflating them is the classic error:

| Symbol | Meaning | Used for |
|---|---|---|
| `c = a + b` | beam attenuation | light lost along a *ray*, over the distance to a surface |
| `Kd` | diffuse downwelling attenuation | how the *ambient field* fades with depth |
| `b` | scattering coefficient (m⁻¹) | the in-scatter integral — **not** the dimensionless albedo `b/c` |

Light is attenuated on the way **out** to a surface as well as on the way back.
Skipping that is why so much underwater rendering looks like green fog with a
torch in it: the lamp keeps its colour and reach, and only the return path gets
tinted. Doubling the optical path is why a real submersible light is useful over
metres rather than tens of metres, and why close surfaces come back warm and
olive while anything further has had the red taken out of it.

## Layout

```
index.html          entry point; reads state from URL params
src/jerlov.js       seawater optics constants, depth zones, pressure
src/glsl.js         shared GLSL: noise, the water model, phase function
src/terrain.js      seabed heightfield (CPU, for exact normals)
src/props.js        kelp and boulders — the silhouette layer
src/snow.js         marine snow
src/post.js         HDR pipeline: volumetric, bloom, ACES, grain
tools/              the review harness (see below)
vendor/             three.js, vendored — no build step, no CDN at runtime
```

Run it: serve the directory and open `index.html`. There is no build.

```
python3 -m http.server 8123
```

URL parameters: `pose`, `depth`, `lamp`, `hud`, `stats`, `dpr`, `vsteps`,
`vscale`, `auto`.

## The harness

The renderer cannot be judged by reading it. These exist so it can be looked at
systematically instead:

| Tool | Job |
|---|---|
| `tools/boot.mjs` | get a page to *rendering* and be honest when it isn't |
| `tools/shot.mjs` | capture an arbitrary expression — the bisection tool |
| `tools/survey.mjs` | the whole review set from one boot |
| `tools/sheet.mjs` | tile frames into one contact sheet |

```
node tools/survey.mjs --w 800 --h 450
node tools/sheet.mjs shots/[a-l]-*.png --out shots/_sheet.png
```

The contact sheet is the point. A reviewer shown one frame comments on that
frame; a reviewer shown twelve at once notices that the same artefact is in all
of them. That is how the two worst bugs here were found, and neither was
diagnosable by reasoning about the code — three subsystems in a row looked guilty
and were innocent.

## Bugs worth remembering

Kept because each one cost real time and each will recur.

- **A glowing sphere in the centre of every frame** was quadrature of a divergent
  integral. In-scatter from a point lamp goes as `1/d²`; with the lamp near the
  eye the integrand diverges at `t=0`, and uniform ray-march steps handed that
  singularity a multi-metre step width. Fixed with `s²`-warped steps, plus
  mounting the lamp off-axis the way real housings do — which is also why divers
  put strobes on arms.
- **A dot lattice crawling over every surface** was `fract()`-based hashing losing
  precision at world-scale coordinates. By the fourth octave the argument is in
  the thousands and the "random" values snap to a grid. Wrap the lattice
  coordinate before hashing.
- **A hard horizontal seam at the horizon** was evaluating the fog colour at the
  *far* surface's depth. In-scatter is dominated by the first few metres, so two
  surfaces hundreds of metres away were being fogged to two different colours.
- **The bright water overhead** is not shallower water. It is the angular
  dependence of forward-scattered downwelling light. Faking it by sampling the
  ambient at a fake height reintroduces the seam.
- **Props scattered over 150 m when visibility is 23 m** made the scene expensive
  and empty at the same time. Population radius belongs to the water, not the map.
- **Structured dither (IGN) needs a temporal filter.** Without one it renders as a
  visible grid. Stills are how this is judged, so use unstructured noise.

## Licence

MIT. Contains no third-party assets. `vendor/three.*` is Three.js (MIT).
