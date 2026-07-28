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
src/terrain.js      seabed heightfield (CPU, for exact normals) + the light ramp
src/props.js        kelp and boulders — the silhouette layer
src/flora.js        benthic cover in three depth bands
src/snow.js         marine snow
src/structures.js   Welder (CPU mesh builder) + the station on the canyon floor
src/interior.js     the pressure hull and its material
src/fitout.js       everything inside the hull
src/post.js         HDR pipeline: volumetric, bloom, ACES, grain
tools/              the review harness (see below)
vendor/             three.js, vendored — no build step, no CDN at runtime
```

## Why the canyon floor has no plants on it

The brief was "vegetation on the seabed", and on the floor of a 440 m canyon
that cannot be done. Kelp is restricted to the shelf here for a specific reason:
a photosynthetic organism below the euphotic zone would quietly tell the player
that none of the optics mean anything, and the absorption curve is the one thing
in this renderer that is not art-directed.

So the floor gets what actually grows there, and it looks like a garden anyway.
Sea pens are feathers on stalks. Glass sponges are white vases. Whip corals are
three metres of unbranched stem. All animals, all sessile, all read to the eye
as flora, and none of them needs a photon to justify being there. The
bioluminescent pulse that runs up a sea pen's rachis is real, and it is the only
saturated colour the art direction permits.

The band edges are a ramp rather than a threshold. A boolean photic test draws a
shaved horizontal line across the canyon wall at a depth the player cannot
perceive; a ramp gives the descent the transition the terrain was designed
around — the cover thins, reddens, gives out, and after that it is rock and silt.

## Why the interior needed two different fixes

The complaint was that the compartments read as large flat planes. That has two
independent causes and they fail differently:

- **Nothing in the volume.** No objects at conversational distance. This is a
  content pass, and it is `src/fitout.js`.
- **Nothing on the surface.** The interior material had no normal perturbation at
  all — three noise bands in the albedo and a constant normal. Albedo without
  relief is a printed texture, and a painted plate lit by a lamp two metres away
  is almost entirely shading.

The second was invisible while reading the code, because the material *looks*
detailed. Where geometry stops and shading starts is arithmetic: at 62° over
720 px, a feature of size `s` at distance `d` covers `s/d * 599` pixels, so a
12 mm bolt head is nine pixels at 0.8 m and two at three metres. Above about
1.5 cm, model it; below, put it in a height field; either way fade the fine
bands with distance or they alias into crawling static.

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
- **The volumetric pass was fogging the inside of the boat.** In-scatter computed
  for a lamp mounted outside the hull, composited over the cabin as well. It hid
  for months because the compartments were empty — grey haze over grey plate is
  grey plate. Furnishing the room is what made it visible.
- **A relief pass can be perfectly correct and completely invisible.** The debug
  height view showed crisp welds; the lit frame showed a flat wall. `(h(u+e) −
  h(u))/e` is the slope when both are in metres, and it was being multiplied by
  a fifth. Separately, honest oil-canning of 1.4 mm across a 0.6 m panel is an
  eighth of a degree — real hulls show that through specular reflection of a
  bright environment, and there is none at 420 m.
- **A shader that fails to compile renders nothing and reports nothing.** One
  duplicated variable name took out the whole interior; the survey produced
  thirty frames and ten of them were the seabed, with the draw counts unchanged.

## Licence

MIT. Contains no third-party assets. `vendor/three.*` is Three.js (MIT).
