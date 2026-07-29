# Handoff

Everything a fresh session needs to continue this project without re-deriving it.
Read this first, then `README.md`, then `git log` — the commit messages are the
reasoning record and are deliberately long.

---

## 1. What this is

A deep-sea horror game that runs in a browser. Three.js + WebGL2, no engine,
**no external assets at all** — every mesh and every texture is generated at
runtime. That constraint has paid for itself repeatedly: no licensing, no
downloads, and the world adapts to itself (catwalk legs find the seabed, kelp
grows only where light reaches).

**Two references, and they are used for different things:**

| Reference | Take | Do NOT take |
|---|---|---|
| **SOMA** | the entire visual bar | — |
| **Barotrauma** | systemic dread: thin hull, finite power, pressure that only rises | its art style |

The user was explicit: realism at SOMA's level, and from Barotrauma only the
*feeling of pressure*, never the look.

### Art direction, read off the reference frames

Recorded here because the original screenshots were chat attachments and will not
survive into a new session:

- Muted blue-green in mid water; at depth a near-black upper field with warm
  olive-brown murk near the bottom; **green bioluminescence as the only accent**
- Few light sources, heavy bloom, visible volumetric cones. Everything else in shadow
- Composition is a three-part sandwich: dark foreground silhouette, lit middle
  ground, nothing behind
- Marine snow always in frame, out of focus in the near field
- Everything man-made is colonised: rust, barnacles, algae, biofouling
- The key mood frame is a catwalk with two red lamps in near-blackness: an almost
  empty picture where only the near geometry reads

---

## 2. Where things live

- **Repo:** `github.com/ashurovidris22-cmd/the-deep-silence`
- **Live:** `ashurovidris22-cmd.github.io/the-deep-silence/`
- **Pages config:** Deploy from a branch → `main` → `/ (root)`. Public repo, so it
  is free. No subscription is needed for any of this.

Useful URLs while working: `?stats=1`, `?pose=<name>`, `?depth=`, `?dof=0`,
`?vsteps=`, `?vscale=`, `?invertY=1`, `?sens=`, `?auto=1`, `?hud=0`.

---

## 3. Environment facts, all verified by testing

These cost real time to discover. Do not re-derive them.

- **npm works** (network access was granted for `registry.npmjs.org`). Three.js is
  **vendored** into `vendor/` so the site has no build step and no runtime CDN
  dependency.
- **The sandbox has no GPU and no display.** Local Playwright renders through
  SwiftShader: pixels are correct, timings are meaningless.
- **Blender is not reachable and cannot be.** Blender MCP needs Blender open with
  a GUI listening on `localhost:9876` on the *user's* machine. There is no display
  in the sandbox and no route to their computer. Lofting in code is the substitute
  and it works — see `src/loft.js`.
- **The cloud browser is capped at exactly 10 fps.** It reports a genuine
  `ANGLE (NVIDIA GeForce RTX 3060 Ti)` and draws correct frames, which makes its
  timing look trustworthy. It reported 10.0 fps with the volumetric pass cut to
  one step at 8% resolution — a change that cannot be free. **A real GPU renderer
  string is necessary but not sufficient; verify a timing environment responds to
  a change you know is expensive.**
- **Real measured performance: 200 fps** on the user's machine at ~2510×1283.
  There is a large budget. That is the only trustworthy number so far.
- **GitHub:** the integration **cannot create repositories** (403). It *can*
  `github__push_files`. Push with `paramsFile`, never inline — compose the JSON
  with a script so the 2.3 MB tree never passes through the agent's output:

```
node /tmp/compose.mjs          # writes /tmp/p2.json from `git ls-files`
ExecuteIntegration github__push_files paramsFile=/tmp/p2.json
```

---

## 4. The harness — use it, do not skip it

Copied in spirit from `achimala/TheLongSilence`, whose real lesson is that the
50-odd scripts in its `tools/` are the product, not the prompt.

```
python3 -m http.server 8123          # serve
node tools/survey.mjs --w 800 --h 450        # the whole review set, one boot
node tools/sheet.mjs shots/[a-z]-*.png --out shots/_sheet.png
node tools/shot.mjs --pairs "name=g.pose('deep');"   # arbitrary expression
```

**The contact sheet is the point.** Both of the worst bugs in this project were
found by seeing the same artefact in all twelve frames at once, and neither was
diagnosable by reading the code — three subsystems in a row looked guilty and
were innocent. `tools/shot.mjs` exists to bisect exactly that.

Under software rendering a frame takes 10–30 s. Use `?vsteps=12&vscale=0.4` while
iterating; take quality verdicts at full settings.

---

## 5. Architecture

```
src/jerlov.js     seawater optics constants, with provenance
src/glsl.js       shared GLSL: noise, the water model, caustics, phase function
src/loft.js       profile sweeping — the technique that beats stacked primitives
src/terrain.js    the canyon: shelf, wall, floor. seabedHeight(), lightAt()
src/props.js      kelp and boulders
src/flora.js      benthic cover in three depth bands — turf, pens, sponges, whips
src/snow.js       marine snow
src/structures.js Welder (CPU mesh builder) + the station on the canyon floor
src/sub.js        the lofted wreck
src/interior.js   the pressure hull: loft, deck, frames, bulkheads, the material
src/fitout.js     everything inside the hull: three compartments, decals, parts
src/controls.js   Pilot: swim mode and walk mode, deliberately separate paths
src/post.js       HDR: volumetric, DOF, bloom, tonemap, dual exposure
src/rng.js        seeded PRNG — see the bug ledger for why this is load-bearing
```

### Where the line between geometry and shading is, and it is arithmetic

The camera is 62 degrees vertical, so a feature of size `s` at distance `d`
covers `s/d * 599` pixels at 720p. Inside the boat the player stands one to
three metres from everything:

| feature | distance | pixels |
|---|---|---|
| 12 mm bolt head | 0.8 m | 9 |
| 12 mm bolt head | 3.0 m | 2.4 |
| 40 cm locker handle | 2.0 m | 120 |

**Above about 1.5 cm, model it. Below, put it in the height field. Either way,
fade the fine bands out with distance or they alias into crawling static.**

### Two conventions worth not re-deriving

- **`IN(s) = -s`.** `s` is which side a fitting is mounted on, +1 starboard.
  Its working face points at the centreline. Getting this wrong is silent.
- **Every furniture builder takes a `Fit`,** and `Fit.sbox` emits the mesh and
  the collision box from one call with one set of dimensions, so they cannot
  drift apart.

### Three non-obvious invariants

1. **`Env` owns all water state.** Every material reads its uniforms from there.
   The moment two surfaces disagree about extinction, the scene stops being one
   body of water.
2. **Depth is derived from position**, never stored. Sink four metres and four
   metres of water appear overhead, with nothing watching for it.
3. **Alpha 0 in the scene pass means "interior".** It drives two things: skip
   depth-of-field, and use the interior exposure instead of the ocean's.

### The physics anchor

Three coefficients doing three different jobs. Conflating them was the source of
several bugs:

| | meaning | used for |
|---|---|---|
| `c = a + b` | beam attenuation | light lost along a view ray |
| `Kd` | diffuse downwelling | how the ambient field fades with depth |
| `b` | scattering, m⁻¹ | the in-scatter integral — **not** the dimensionless `b/c` |

Light is attenuated **on the way out to a surface as well as back**. Skipping
that is why most underwater rendering looks like green fog with a torch in it.

**Water type is the colour control; `surfaceIrr` is the brightness control.** They
look interchangeable and are not — lowering turbidity to gain light walked the
blend toward oceanic water and turned the whole game sapphire.

---

## 6. Bug ledger

Every one of these cost time. They are also in `README.md` and in the commit
messages, at more length.

- **A glowing sphere in every frame** — quadrature of a divergent integral.
  In-scatter goes as `1/d²`; uniform ray-march steps handed that singularity a
  multi-metre width. Fixed with `s²`-warped steps plus an off-axis lamp mount.
- **A dot lattice on every surface** — `fract()` hashes lose precision at
  world-scale coordinates. Wrap the lattice coordinate before hashing.
- **A hard seam at the horizon** — fog evaluated at the far surface's depth.
  In-scatter is dominated by the first few metres.
- **Bright water overhead is not shallower water** — it is the angular dependence
  of forward-scattered downwelling light.
- **`Math.random()` in world generation invalidates the review process.** Every
  load builds a different world, so frames cannot be compared and a critique
  refers to geometry that will not exist next run. Everything goes through
  `src/rng.js`.
- **Seeding immediately proved the hero shot was broken** — uniform-random scatter
  has uniform *expected* density and lumpy actual density, and the bare patch sat
  exactly where the establishing camera stands. Jittered grid.
- **Cartoon low-poly is measurable.** 20 segments on a 2.5 m hull is a 39 cm facet,
  57 px at six metres. Measure facets in pixels before arguing about style. And a
  pressure hull is faired *smooth* — plating reads from the welds, not the
  silhouette. Geometry carries form; material carries construction.
- **Near-field DOF keyed to focus distance hid the whole game.** The lamp only
  reaches a few metres, so the only lit part of the frame was the only blurred
  part.
- **Interior lit in isolation is always wrong**, because the auto-exposure is
  driven by water spanning four orders of magnitude. Hence the dual exposure.
- **A silently culled face is far harder to find than a visibly wrong one.** The
  bulkhead was wound backwards and vanished; the symptom was bolts floating in
  open water.
- **Framing is arithmetic.** At 62° the frame is ±0.40 m tall at the bulkhead, so
  a console at y = −0.30 is simply off-screen. Solve camera headings from the
  geometry rather than guessing them. `yaw = atan2(dx, -dz)`, `pitch =
  atan2(dy, L)` — the interior station table uses an `AIM()` helper for exactly
  this, after the hand-written version missed its subject at every close range.

### OPEN DEFECT — one bright cyan quad inside the machinery space

Introduced somewhere in the exterior-hull pass and **not yet identified**. What is
established, so the next session does not start over:

- It is a flat rectangle roughly 0.9 x 0.8 m on the **port** shell around
  z = -2 to -3.6, visible from the `stern` station (looking aft, port appears on
  the *right* of frame — worth remembering before hunting on the wrong side).
- It carries a soft 6x5 checkerboard, which is the `I.PANEL` breaker lattice, so
  the switchboard face at z = -3.55 and the scrubber face at z = -1.95 are the
  only two candidates.
- It is **absent** from the last pushed build's `u-stern` frame, so it is a
  regression from this session, not something old.
- Three of its four siblings were the exterior hull's fittings coming through
  the pressure hull (fixed — see below); this one survived that fix, so it is
  *not* an exterior penetration.
- Arithmetic says it should not be bright: the panel's albedo tops out at 0.115,
  the deckhead lamp two metres away contributes about 0.12, and the emissive term
  is masked to the bottom eighth of the panel where the indicator lamps are.
  Measured brightness is far above that, so something is adding light that the
  branch does not account for.
- The distance fade added for lattice aliasing does not apply at this range
  (2.5 m), so aliasing is not the cause either.

**Next step is one render, not more reasoning:** add `uDebug == 3` to the
interior fragment shader outputting `vMat / 12.0` as greyscale and shoot the
`stern` station. That names the material in a single frame. Three subsystems have
already looked guilty in this project and been innocent; do not skip the probe.

### Added by the piloting pass

- **Caustics were riding on the bio floor, so they never switched off.**
  `ambientAt()` returns sunlight *plus* the constant bio/thermal glow, and the
  terrain, rocks, turf and the volumetric shafts all keyed their sun effects to
  it. The terrain shader's own comment promised the caustic web would be
  "simply absent on the canyon floor, because that is what happens to the beam
  that makes them" — and there it was at 425 m, a sunlight caustic a hundred and
  fifty metres below the last photon. Split into `sunAt()` (beam only) and
  `ambientAt()` (everything there is to see by). **The intent was written down,
  the code contradicted it, and the frame looked plausible enough that nobody
  checked for months.**
- **The exposure meter and the renderer disagreed about how much light existed.**
  The meter modelled only the daylight term. Below the photic zone that term is
  exactly zero and the bio floor is a hundred per cent of the light, so the
  meter believed it was exposing pure black while the renderer handed it a lit
  scene. Include the floor.
- **Adaptation was symmetric and therefore blinding on the way up.** Measured:
  rise from the floor and the frame reads 250,252,252. A real eye adapts to
  light in under a second and to dark over minutes; one 1.5 s constant for both
  is what produced the whiteout the notes already recorded as "I nearly went
  blind while ascending". Now 0.30 s closing down, 3.0 s opening up.
- **A camera pose has to leave the hull's frame.** Once the pilot could stand in
  a moving vessel, `applyPose` had to clear `pilot.frame` — otherwise the pose's
  world coordinates were treated as hull-local and added to the boat, putting
  every external review frame at 808 m in a canyon that is 425 m deep. **The
  picture looked entirely plausible; only the depth readout caught it**, which
  is the argument for printing numbers next to every frame.
- **A hull pushed straight up out of the ground is a ratchet.** Resolving bottom
  contact by lifting the boat by its penetration, with the horizontal velocity
  left alone, let her drive into the canyon wall and climb it — 350 m in three
  simulated minutes, surfacing at the top. Remove the velocity component going
  into the slope normal instead; a bank can then be driven over and a wall stops
  her dead.
- **The sandbox cannot measure anything with a time constant in it.** Under
  software rendering the page runs at one or two frames a second with `dt`
  clamped to 0.1, so eight seconds of wall clock is under a second of simulated
  time. Every dynamics test — adaptation, acceleration, ballast — has to be run
  as pure maths in node at a fixed 60 Hz. `Vessel` has no renderer dependency
  for exactly this reason.
- **`texture2D` returns a vec4.** Assigning it to a vec3 is a compile error, and
  the whole material silently vanishes.
- **Six instruments that agree perfectly are not redundancy.** Every gauge in the
  boat read `uPressure`, so three needles in the machinery space and three at
  the helm stood at identical angles. A player reads that instantly as "none of
  these is connected to anything". The wear attribute is meaningless on a glass
  dial, so it now carries the dial's type.

### Added by the fit-out and flora pass

- **The volumetric pass was fogging the inside of the boat.** In-scatter is
  computed for a lamp mounted *outside* the hull and was composited
  unconditionally, so every interior frame carried a milky veil that deepened
  down the compartment. It hid for months because the compartments were empty —
  grey haze over grey plate is grey plate. One multiply by the same `notCabin`
  alpha that already exempts the cabin from defocus. **Furnishing the room is
  what made an old lighting bug visible; a defect needs something to be measured
  against before anyone can see it.**
- **A relief pass can be perfectly correct and completely invisible.** The debug
  height view showed crisp weld seams and panel dishing; the lit frame showed a
  flat wall. Two independent causes. First, a stray `0.01` in the bump formula:
  `(h(u+e) − h(u)) / e` *is* the surface slope when both are in metres, so it
  wants multiplying by one, not by a fifth. Second, physically honest
  oil-canning — 1.4 mm across a 0.6 m panel — is a slope of an eighth of a
  degree. A real hull shows that through specular reflection of a bright
  environment and there is no bright environment 420 m down, so under a diffuse
  lamp the deformation has to be exaggerated to about a degree before the eye
  gets anything. **Run `g.dbg(1)` before arguing about whether relief works.**
- **A shader that fails to compile renders nothing and says nothing.** `float
  bead` was declared twice; the whole interior material failed; the boat drew as
  open water. The survey produced thirty frames, the stats still read
  `draws=28 tris=1402k`, and ten of them were the seabed. Read the console.
- **A missing uniform declaration silently deletes a mesh.** The turf shader used
  `uTime` without declaring it, so the entire shelf understory never existed and
  nothing reported it.
- **`active` is a reserved word in GLSL ES.** So are `sample`, `filter`, `input`.
- **JS constants do not exist inside a GLSL template literal.**
  `smoothstep(DECK_Y + 0.55, …)` compiles to an undeclared identifier. Interpolate
  it: `${'$'}{DECK_Y.toFixed(3)}`.
- **Fittings face the centreline, and the sign is silent when wrong.** Fifteen of
  them — the switchboard, both compartment numbers, the medical cross, the
  photograph over the bunk — faced into the shell and rendered as blank grey
  boxes, which reads as "not modelled yet" rather than as a bug.
- **A pipe at 0.62 m is at standing eye height.** `DECK_Y + EYE = 0.57`. Two runs
  of 150 mm pipe crossed the middle of every interior frame a metre from the
  face. Invisible as a fault while the room was empty, because nothing was behind
  them to block.
- **A camera station standing at the same z as a point light.** The forward long
  shot stood at z = 3.4, which is the alarm lamp. The frame came back pink.
- **New poses must be added to `CAM_SPOTS` by hand.** The `garden` frame came back
  as a diffuse glow with one black diagonal across it — a whip coral 30 cm from
  the lens, inside the near-focus ramp. Its own flora-off control frame was
  sharp, which is exactly what a control frame is for.
- **Population density belongs to what the lamp reaches, not to the disc.** 1050
  sites over a 105 m disc is one clump per 33 m² and the lamp lights about 50 m²:
  three plants per frame. The fix is patchiness plus a base rate, because uniform
  density at an affordable triangle count is invisible everywhere at once.
- **`Welder.tube` had no surface coordinates at all.** Every tube in the game —
  every handrail, the ladder, all the pipe runs — sampled its material at one
  single point and came back a smooth plastic rod.
- **`tools/shot.mjs --pairs` must come last on the command line.** It takes every
  following argument that does not start with `--`, so `--pairs "a=x" --w 480`
  quietly adds a pair named `48`.

---

## 7. State, and what is next

**Working:** the canyon (30 m at the rim to 424 m on the floor, all positional),
physically-grounded water, caustics, marine snow, the station with walkways and
towers, a lofted wreck, walk/helm/swim modes, collision against the deck and the
furniture, on-screen controls and contextual prompts.

**Added by the fit-out and flora pass:**

- Three furnished compartments, each given a job first and objects second.
  Stern is machinery: pump skid, HP air bottles, switchboard with live indicator
  lamps, valve manifold with tagged handwheels, workbench and shadow board,
  bilge hatch. Midships is accommodation: two berths with lee cloths, mess table
  with fiddle rails, galley with sink and three mug hooks of which one is empty,
  CO₂ scrubber, medical locker, a jacket nobody came back for. Bow is the helm:
  console, sonar with a decaying sweep, chart table under an anglepoise, radio
  stack, overhead breaker panel.
- Surface relief in the interior material: weld seams on a twelve-strake
  lattice, plate-by-plate tonal variation, oil-canning, edge-aware chipping and
  bolt rings (the Welder now carries each face's half-extents), hand-height
  paint wear, a specular lobe so metal stops being chalk.
- A decal atlas drawn on a canvas at boot — compartment numbers, valve tags,
  a bathymetric chart, a photograph. Runtime-generated, so the no-assets rule
  holds. Text is the point: it is the cheapest thing in the boat that proves a
  person was here.
- Benthic cover in three bands. Kelp density now follows a light ramp rather
  than a boolean at 105 m, a turf understory covers the shelf and thins with
  depth, and the canyon floor gets sea pens, glass sponges and whip corals.
  See `src/flora.js` for why the floor gets animals rather than plants.

**Numbers as they stand:** 28 draw calls, ~1.4 M triangles with the flora in
frame. **The sandbox cannot measure frame rate and the cloud browser is capped —
this needs checking on the user's machine, where the last honest reading was
200 fps at a much lower triangle count.** If it is short, the flora radii in
`main.js` are the dial: they are set to 88 m against a lamp that reaches twelve.

**She is now a vessel.** `src/vessel.js` is the boat as a body: throttle, rudder,
ballast, drag split into surge/sway/heave, bottom contact against the slope
normal. Three decisions carry the feel and all three are cheap —

- **vertical is ballast, not thrust.** Eight-second tank lag, so every depth
  command is committed long before it answers
- **a rudder does nothing at rest.** Steering authority scales with the water
  going past the blade
- **the throttle is a setting, not a key you hold.** Walk aft with way on and she
  is still going

Walking now happens in *hull* coordinates with the camera composed through the
vessel's matrix, which is what lets the deck move and turn under the player. The
old arrangement nailed the boat down specifically so that collision could stay
matrix-free; that trade is now paid off rather than avoided.

Measured at 60 Hz in node: terminal way 4.5 m/s reached in about 25 s, a 24 s
turning circle at full rudder, 1.8 m/s vertical when hard blown so the 400 m
from the floor to the shelf takes roughly four minutes.

**Helm controls:** W/S telegraph, A/D wheel, Space/C blow/flood, Shift for a
faster telegraph, X all stop, E to stand up.

**The user's standing complaints, in their order of importance:**

1. **Unexplained: a player screenshot of the canyon floor came back as a bright
   teal lagoon with sunlight caustics on the seabed — mean sRGB 24,159,176 where
   the same place measures 19,28,35 here.** Red matched and green was forty times
   brighter, which is the spectral signature of *daylight through tens of metres*,
   not of an exposure that opened too far. Not reproducible from this build at
   any depth, in any mode, at either quality setting; a depth sweep of the whole
   water column never produces it with flora in frame. The caustics half is now
   explained and fixed. The brightness half needs the Depth readout from that
   session before anyone theorises further.
2. Sound. Hull creak under pressure would do more for tension than ten more panel
   details.
3. Creatures. Deliberately deferred: procedural organics are the hardest part.
   Technique is known — sine along the spine in the vertex shader, Verlet chains
   for tentacles, radial pulse for jellyfish. The scariest creature is the slowest,
   which is also the cheapest to animate.

**Known weak spots in what was just added,** so the next session does not have to
rediscover them: the mess table and galley counter still read as plain boxes at
two metres and want the same edge treatment the lockers got; the interior is
lit toward the top of its value range and could stand more darkness between the
lamps; and the turf is only just legible at the shelf camera's height.

**How this user gives feedback, and it is good feedback:** blunt, specific, and
usually right. They play the build and report what broke. Take the complaint
literally, find the measurable cause, fix the cause rather than the symptom, and
say plainly when something is a genuine gap rather than a bug. They respond well
to being told what is not fixed.
