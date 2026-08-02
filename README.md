# The Deep Silence

A deep-sea horror game that runs in a browser. Three.js + WebGL2, no engine, no
external assets — every mesh and every texture is generated at runtime.

Visual target: the look of **SOMA**. Tension target: the systemic dread of
**Barotrauma** — a thin metal hull, a finite power budget, and pressure that only
ever increases. Not Barotrauma's art style.

**Status: she can be driven, walked around inside, heard, and left.** The optics,
the seabed, the flora, the post chain, a furnished eighteen-metre pressure hull,
the vessel dynamics, the sound layer and a timed excursion outside the hull all
exist. The canyon now has its first inhabitant: the acoustic mimic that learns the
way-home signal eventually resolves into a lamp-shy anguilliform swimmer. The first
complete objective now asks the player to descend to the wreck, free a deep recorder
under exposure, carry it home on the finite scrubber, and live with what the recovery
wakes.

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
src/hull.js         the five principal dimensions, and no imports at all
src/jerlov.js       seawater optics constants, depth zones, pressure
src/life.js         the suit's CO2 scrubber — why you come back
src/acoustics.js    underwater acoustics, and the state-to-sound map. Pure maths
src/audio.js        the synthesiser: owns the AudioContext, decides nothing
src/creatures.js    the acoustic mimic's body and Strouhal-derived swimming
src/recorder.js     the first recovery objective: extraction, carriage and return
src/glsl.js         shared GLSL: noise, the water model, phase function
src/terrain.js      seabed heightfield (CPU, for exact normals) + the light ramp
src/props.js        kelp and boulders — the silhouette layer
src/flora.js        benthic cover in three depth bands
src/snow.js         marine snow
src/structures.js   Welder (CPU mesh builder) + the station on the canyon floor
src/interior.js     the pressure hull and its material
src/fitout.js       everything inside the hull
src/vessel.js       the boat as a body: throttle, rudder, ballast, bottom contact
src/post.js         HDR pipeline: volumetric, bloom, ACES, grain
tools/              the review harness (see below)
reference/          committed baselines: harness output and per-frame numbers
vendor/             three.js, vendored — no build step, no CDN at runtime
```

## Driving her

Take the seat at the bow with **E**, and then:

| key | |
|---|---|
| `W` / `S` | telegraph ahead / astern — a **setting**, not a key you hold |
| `A` / `D` | wheel to port / starboard, springs amidships when released |
| `Space` / `C` | blow / flood ballast — the tank answers in about eight seconds |
| `Shift` | move the telegraph faster |
| `X` | all stop |
| `E` | stand up. She keeps whatever way you left on |
| `M` | mute |
| `V` | at the hatch, go outside. Within five metres of the trunk, come back in |
| `E` | hold beside the deep recorder to release it from its clamps |

Three things make her a vessel rather than a flying box. Vertical is ballast,
not thrust, so every depth command is committed long before it answers. A rudder
does nothing at rest, because steering authority comes from the water going past
the blade. And nothing stops when you let go — set a throttle, walk aft to look
at the pumps, and she is still making way toward whatever is in front of her.

Walking happens in the hull's own coordinates now, with the camera composed
through the vessel's matrix, which is what lets the deck move and turn under
your feet.

## Why the sound is not art-directed either

Same argument as the water, and it pays off the same way. No samples — the
no-assets rule covers audio, so every voice is an oscillator, a filter, or a
buffer of seeded noise. Every frequency comes from a dimension or a material
property that was already in the project:

| what you hear | where it comes from |
|---|---|
| the shell ringing, 358 Hz | `c_L / (2πR)`, the textbook ring frequency of a cylindrical shell |
| plate cracks at 216 / 540 / 863 Hz | flexural modes of a 0.6 m strake at 12 mm — the same panel the interior material dishes for its oil-canning |
| the cabin's hum, 36.5 Hz | a standing wave across the 4.7 m beam |
| the pump, 121 Hz sliding | 5 blades × 1450 rpm, against a *fixed* 100 Hz mains hum |
| the ballast blow, 1.6 → 10.6 kHz | Minnaert resonance of a 2 mm bubble, which goes as √P |

That last row is the one no sound designer would think to do. A bubble is stiffer
under pressure, so **a blow gets shriller the deeper you are** — and once it is
there, the ballast tells you your depth without a gauge.

Two of the voices turned out to be instruments rather than decoration. The creak
rate is driven by the *rate of change* of pressure rather than by pressure, so a
hull at rest at 400 m is quiet (one creak per 25 s) and the same hull descending
at 1.8 m/s is not (three per second) — holding depth is calm, committing to the
bottom is not. And because compression loads the whole shell while relaxation
lets single panels go, descending sounds low and ascending sounds high: you can
hear which way you are moving with your eyes shut.

The thing that is *not* modelled is the obvious one. Sound barely attenuates in
seawater — Thorp gives 0.0014 dB over the twenty metres this game can see — so
the water does not muffle anything, and pretending otherwise would be the audio
equivalent of tinting an oceanic palette green. What actually changes when your
head leaves the hull is your ear: the middle ear is bypassed, bone conduction
takes the top off, and interaural time difference shrinks by the sound-speed
ratio of 4.4, so localisation fails. Outside the boat everything is loud, close,
and coming from nowhere. That is true, and it is worse than muffled.

## Why the air supply is a scrubber and not a tank

The obvious version of "add oxygen" does not survive contact with the depth. A
demand regulator delivers gas at ambient pressure, so consumption by mass scales
with absolute pressure: at 43 atmospheres on the canyon floor, a cylinder good for
an hour at the surface lasts eighty-three seconds. Open circuit is not a thing
that works down here, which is exactly why real deep work is closed-circuit.

On a rebreather the loop is recycled, so oxygen is consumed *metabolically* and is
nearly independent of depth. What runs out is the sorbent that takes the carbon
dioxide back out — so the readout is scrubber life, the failure mode is hypercapnia
rather than suffocation, and the reason to come back is that the canister in the
suit is an emergency one rather than a working rig.

The duration is derived, not balanced: 0.25 kg of Sofnolime at a practical
120 litres of CO₂ per kg, halved because sorbent kinetics fall off badly in 4 °C
water. Fifteen litres usable, against a metabolic output of 0.26 l/min floating
and 1.6 l/min at a sprint. That gives 59 minutes if you hang still and nine if you
thrash, and **moving carefully is worth more than any other decision available out
there** — which is the right pressure for this game and it came out of the
physiology rather than out of a spreadsheet.

The pleasing part is that the boat was already built for it. The machinery space
has had a CO₂ scrubber and an "O2" valve tag in it since the fit-out pass, put
there as set dressing. The mechanic connected to objects that already existed
instead of arriving with its own furniture.

## Why the way home is a light and a sound, and not two of either

Getting lost outside was immediate: visibility is twenty-one metres, the boat was
unlit, and eight strokes away every direction looks the same. The fix is split
across two senses, and the split is not a design flourish — it is the acoustics
model refusing to lie.

Outside the hull, localisation is gone. Interaural time difference is head width
over sound speed, and sound speed is 4.4× higher in water, so the cue the brain
uses for direction shrinks by 4.4 and stops working. A sound out there can honestly
tell you *how far* and cannot honestly tell you *which way*.

So the amber strobe on the conning trunk carries the direction, and a 3.1 kHz
pinger carries the range by repetition rate alone — 3.1 seconds apart at 130 m,
a quarter of a second alongside. A Geiger counter, which is the most legible
distance signal ever built and needs no interface at all. The strobe marks the
*trunk* rather than the middle of the hull, because what a lost swimmer needs is
not the boat, it is the way in.

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

## Continuing this on another machine

Nothing lives outside the repository. Clone it, then:

```
python3 -m http.server 8123
node tools/dyn.mjs                    # needs nothing installed
node tools/listen.mjs --mode graph    # ditto
```

Diff those against `reference/baseline-*.txt`. `HANDOFF.md` section 1b is the full
bootstrap, including which environment facts are specific to the sandbox this was
built in and should be re-tested rather than believed.

Run it: serve the directory and open `index.html`. There is no build.

```
python3 -m http.server 8123
```

URL parameters: `pose`, `depth`, `lamp`, `hud`, `stats`, `dpr`, `vsteps`,
`vscale`, `auto`, `sound`, `music`. `?music=0` keeps every instrument and removes
only the drone, which is a different request from muting.

## The harness

The renderer cannot be judged by reading it. These exist so it can be looked at
systematically instead:

| Tool | Job |
|---|---|
| `tools/boot.mjs` | get a page to *rendering* and be honest when it isn't |
| `tools/shot.mjs` | capture an arbitrary expression — the bisection tool |
| `tools/survey.mjs` | the whole review set from one boot |
| `tools/sheet.mjs` | tile frames into one contact sheet |
| `tools/dyn.mjs` | dynamics as arithmetic, at a fixed 60 Hz. No browser |
| `tools/listen.mjs` | the audio graph: structurally, or as rendered samples |
| `tools/vendorlink.mjs` | make the vendored three.js importable from node, offline |

```
node tools/survey.mjs --w 800 --h 450
node tools/sheet.mjs shots/[a-l]-*.png --out shots/_sheet.png
node tools/dyn.mjs
node tools/listen.mjs --mode graph
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
- **A hull's low modes are infrasonic, and the film soundtrack is wrong.** The
  descending groan was given to the ring-stiffener modes on the assumption that a
  pressure hull's lowest note is a few tens of Hz. At this boat's radius that mode
  is 11 Hz — below hearing — and it had been weighted at 72% of every descending
  event, so descent would have sounded like nothing. `R⁴` in the denominator is
  brutal. What is audible is the shell's ring frequency and the plate modes.
- **The ballast tank answered in one second, not eight.** A rate of `1/8` was then
  multiplied by 8 inside the exponential, cancelling itself, against an intent
  stated in three separate documents. It survived because a one-second lag still
  *feels* like a lag — only a measurement could show that the commitment the whole
  design rests on was not in the build.
- **A continuous voice keyed to a quantity that only asymptotes to zero never
  switches off.** A bottom scrape proportional to speed sat at 0.0017 for ever,
  because a hull aground on a slope never quite stops. Inaudible, unfindable, and
  exactly how a synthesiser acquires a permanent whisper. Sliding friction has a
  breakaway threshold, so below it the right level is *exactly* zero.
- **The vessel and the camera have opposite handedness, and the rudder was never
  reconciled with it.** `Vessel` builds `forward = (sin y, 0, +cos y)`, so positive
  yaw is counter-clockwise seen from above; the camera's positive yaw is clockwise.
  `Pilot.apply()` knew and composed the two with a minus. Nothing checked the
  control: `rudder = +1`, called starboard everywhere, swung the bow to the pilot's
  left — measured `swing · screenRight = -0.986`. The compass ran backwards for the
  same reason, and the console gauge was drawn correctly all along while being lied
  to. **It survived a whole piloting pass because a rudder does nothing at rest.**
- **A gate on the prompt is not a gate on the action.** Coming back aboard was
  unconditional from anywhere in the ocean while the on-screen prompt appeared at
  nine metres, so the rule shown and the rule enforced were different and the
  generous one won silently. Harmless until the scrubber gave the outside stakes,
  at which point a swimmer 300 m out could teleport home and every derived number
  in the life-support model became decoration.
- **The worst masking is in the gap after a loud sound, not under it.** The score's
  ceiling is set by the twenty seconds *after* the boat touches down: the hull stops
  creaking in about a second, the term that lets a busy hull crowd the drone out
  opens straight back up, and the drone itself is still near the top of its range
  because it falls with a 22 s constant. Two envelopes with different time
  constants overlap worst during the decay.

## Where the design thinking lives

`HANDOFF.md` is what has been decided and measured. `DESIGN-CREATURES.md` records
the creature design argument; its first archetype and acoustic mimicry are now in
the game, while the siphonophore, swarm and whale fall remain options. It also
explains why the Strouhal number is the animation constant and why an animal longer
than 26 m can never be seen whole. Kept separate on purpose: one file is fact, the
other is argument.

## Licence

MIT. Contains no third-party assets. `vendor/three.*` is Three.js (MIT).
