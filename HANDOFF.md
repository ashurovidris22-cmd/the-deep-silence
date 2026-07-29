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

Useful URLs while working: `?stats=1`, `?pose=<name>`, `?dof=0`, `?vsteps=`,
`?vscale=`, `?invertY=1`, `?sens=`, `?auto=1`, `?hud=0`, `?sound=0`, `?music=0`.
**`?music=0` leaves every instrument and takes only the drone**, which is a
different request from muting and is the one most likely to be wanted.

**`?depth=` now requires `?auto=1`,** and that is deliberate — see the ledger. It
moves the sea surface to fake a depth, which desynchronises the world from the
player's position, and it cost three review rounds when a stray copy of it in a
URL put a human's whole session at 14 m while they stood on the canyon floor.

---

## 3. Environment facts, all verified by testing

These cost real time to discover. Do not re-derive them.

- **npm access is granted per session and does not carry over.** A previous
  session recorded "npm works" here; the next one opened a fresh clone and got
  `403 Forbidden` on `registry.npmjs.org`, with `node_modules/` in .gitignore.
  Every Playwright tool in `tools/` was unrunnable, and so was every arithmetic
  test — which are the only valid way to measure anything with a time constant.
  Ask for `registry.npmjs.org` *and* `cdn.playwright.dev` (the browser binary
  comes from the second, not the first) at the start of a session that needs
  frames, and do not assume it will be granted.
- **The harness no longer needs npm at all.** On the session that discovered this,
  `cdn.playwright.dev` was granted and `registry.npmjs.org` was not — a browser and
  no way to drive it. Both halves are now solved locally:
  - the browser downloads from `https://playwright.azureedge.net/builds/chromium/1181/chromium-linux.zip`,
    which 307-redirects to `playwright.download.prss.microsoft.com`. Unzip it and
    export `CHROME_PATH=/tmp/cr/chrome-linux/chrome`.
  - `tools/cdp.mjs` is a dependency-free DevTools client — node 22+ ships a global
    `WebSocket`, and the whole surface `tools/` uses is fifteen methods.
    `vendorlink.ensurePlaywright()` points the bare specifier `playwright` at it,
    and `boot.mjs` calls that before importing. **If a real Playwright is
    installed it wins**; the shim is only a fallback and is marked by its version
    string `0.0.0-cdp-shim`.
- **`node tools/vendorlink.mjs` removes that dependency for node tests.** Three.js
  is **vendored** into `vendor/` so the site has no build step and no runtime CDN
  dependency — and `vendor/three.module.js` imports cleanly under node, so the
  tool writes the eight lines of `node_modules/three` packaging that let a bare
  `import 'three'` resolve. Offline, idempotent, called automatically by
  `dyn.mjs` and `listen.mjs`. **A node arithmetic test now needs no network at
  all.**
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
node tools/dyn.mjs                   # dynamics, as arithmetic. No browser.
node tools/listen.mjs --mode graph   # the audio graph builds, structurally
node tools/listen.mjs --mode render --scene descent   # real samples, needs a browser
```

**The contact sheet is the point.** Both of the worst bugs in this project were
found by seeing the same artefact in all twelve frames at once, and neither was
diagnosable by reading the code — three subsystems in a row looked guilty and
were innocent. `tools/shot.mjs` exists to bisect exactly that.

Under software rendering a frame takes 10–30 s. Use `?vsteps=12&vscale=0.4` while
iterating; take quality verdicts at full settings.

**The sandbox cannot settle a frame, and this invalidates naive A/B comparison.**
Four rounds of bisection were spent on a beacon that turned out to be measuring
neither the beacon nor anything else:

- **Auto-exposure adapts over three *simulated* seconds.** Software rendering runs
  at roughly half a frame a second with `dt` clamped to 0.1, so a settled exposure
  is thirty frames and about five minutes away. Two captures taken a few frames
  apart differ by their adaptation state, and that difference is *larger* than a
  small light's contribution. Measured drift between two captures of the same
  pose: exposure 2.161 to 3.266.
- **`settle` is in milliseconds and may contain zero frames.** Two reads two
  seconds apart returned byte-identical state because no frame had run between
  them, which read as "the value is frozen" and sent the search into the wrong
  subsystem entirely. **Wait on `g.frames`, not on the clock.**
- **The grain pass gives ±80 on a channel sum, per frame.** Any pixel diff below
  that is noise. An early "the beacon washes the whole frame, 443k pixels differ"
  was entirely this.

So: pixel-diff two captures only for *large* differences, wait on frame counts,
and prefer reading numbers out of the page over comparing images.

**An unnamed object cannot be found by an instrument.** A probe went looking for
the trunk strobe by shape — "the Points group with one vertex" — and found
something else, then reported for four rounds that the strobe was frozen and
invisible. `boatBeacon` and `boatBeaconPoints` are named now, and the strobe is in
`g.setLayer` as `boatbeacon`, because a light you cannot switch off cannot be
cleared as a suspect in an exposure question.

**In-game instruments, because the sandbox cannot see everything:**

- **F3** — the diagnostic panel. fps, resolution, draws, triangles, depth, zone,
  visibility, pressure, mode, lamp, exposure, depth band, the sun term at the eye,
  camera and vessel positions, heading, way, throttle, ballast, ground contact,
  the sound layer's state, and life support: scrubber percentage, projected minutes,
  litres per minute, breathing rate and range to the trunk.
  Built after three sessions of failing to answer a question that this panel
  settled in one screenshot. **When asking the player for a measurement, ask for
  a photograph of this rather than for a description.**
- `g.dbg(1)` height field, `g.dbg(2)` perturbed normal, `g.dbg(3)` material id —
  inside the boat. "Which material is that" is not answerable by reasoning.
- `g.inside(name)` for the eleven interior stations, `g.outside(deg, dist, h)` for
  a camera aimed at the hull from the water, `g.setLayer(name, false)` to switch a
  subsystem off. **The layer toggles are a debugging instrument, not a review
  convenience** — they identified two bugs this week in one frame each after
  reasoning had failed on both.

**Some questions are arithmetic, not pictures.** "Is this fitting inside that
hull" was answered by checking 27 placements against the drawn profile in node in
one second, after a screenshot round had failed to settle it. `src/vessel.js` has
no renderer dependency for the same reason: the sandbox runs at 1–2 fps with `dt`
clamped, so eight seconds of wall clock is under a second of simulated time and
*every* dynamics test has to run as pure maths at a fixed 60 Hz.

**`tools/dyn.mjs` is that rule with a handle on it.** Eight scenarios driving the
*real* `Vessel` at a fixed 60 Hz — derived constants, the ballast tank, a full
descent, the telegraph, the blow, the silence on the floor, the descent/ascent
asymmetry, and a released-voices check. It found two bugs on its first run and
one of them was in the vessel, not in the new code. Add a scenario rather than
reasoning about a time constant.

**Sound is measured the same way, and for a stronger reason: there is no sound
card here at all.** `src/acoustics.js` holds the whole state-to-parameter map as
pure arithmetic with no `AudioContext` and no `three` in it, so `dyn.mjs` can
print what the synthesiser is being told. `tools/listen.mjs` covers the other
half in two honest modes — `--mode graph` builds the graph against a stub and
proves the code path runs and no automation gets a NaN; `--mode render` rebuilds
it inside an `OfflineAudioContext` in headless Chromium, which renders faster
than real time, and reports RMS, peak, crest factor, clipping and energy per
octave. **`graph` mode prints a banner saying what it did not establish, because
a structural pass that looks like a measurement is worse than no pass at all.**

---

## 5. Architecture

```
src/hull.js       the five principal dimensions, and no imports at all
src/jerlov.js     seawater optics constants, with provenance
src/acoustics.js  underwater acoustics constants + the state-to-sound map. Pure
src/audio.js      the synthesiser: owns the AudioContext, decides nothing
src/life.js       the suit's CO2 scrubber. Pure arithmetic, no imports at all
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

### SOLVED — the bright teal canyon floor, after three sessions

The diagnostic panel answered it in one screenshot, and the answer was not in any
shader:

```
depth 14.0 m   epipelagic   vis 21.4 m   2 atm
mode walk   lamp 0.18   exposure 0.080   band -410 m
sun at eye  2.0e-1  9.5e+0  1.1e+1
eye  75 -384 13   surface -370
```

**`band -410`.** The depth band had put the sea surface at y = -370 — three
hundred and seventy metres *below* mean sea level, and fourteen metres above a
player standing on the canyon floor at y = -384. So the game was correctly
rendering fourteen metres of water: full daylight, caustics on the seabed, bright
teal, red mostly absorbed. Every measurement I took of that screenshot was right;
the scene simply was not at the depth the geometry said.

How it happened: `setDepthBand(m)` solves `band = m + cameraY - SEA_LEVEL` and was
unclamped, so asking for 14 m while the camera sat at -384 gave -410. It was
wired to a `?depth=` URL parameter, so a pasted link put a human's whole session
at the wrong depth for as long as the tab stayed open — even though the
function's own comment says "Normal play never calls this".

Two fixes, and the second matters more than the first: the band is clamped at
zero, because a surface below sea level has no meaning in a world where depth is
derived from position; and the parameter is gated behind `auto=1` so a review
tool cannot reach a player.

**The lesson is about instruments, not about clamps.** Three review rounds chased
this as a shader bug — caustics, exposure metering, adaptation dynamics — and two
of those rounds produced real fixes for real bugs that were not this one. What
found it was printing `depth` next to `eye y` and noticing they disagreed. The
project's own notes had already written the warning: *"Setting depth as an
independent number would have let the two disagree, so that swimming downward
changed the view without changing the water."* The band **is** that independent
number. When a value can be set instead of derived, print it beside the thing it
should agree with.

### The bow port was a 40 cm hole, not a window

The interior loft ran past the port to z = 9.5 and closed to 0.4 m, and since the
bow is left uncapped so the helm can see out, *that pinhole was the view*. The
acrylic ring sat a metre behind it in the dark framing nothing. A player
photographed it: a small blown-out disc glowing in the middle of a black wall,
which is a porthole in a ship's side, not the forward window a bow compartment
exists for.

The loft now ends at the port with a 1.95 m section, so the opening **is** the
window — at the seated eye 1.6 m back it fills the whole frame. The exterior
carries its skin to the same station and glazes it with a disc facing outward:
from the water you see glass in a steel surround, and from the helm the same
polygon is back-facing and culled, so the view out is untouched. That also closes
a hole the previous version left — with the cabin culled from outside, an open bow
meant looking into an empty shell.

### Added by the bug-report pass

Four things a player reported in one message, and three of them were one theme:
**anything that is not the seabed had no physical or visual boundary.**

- **The cabin was visible from outside the boat.** `interiorMaterial` is
  DoubleSide — it has to be, because the deck, the bulkheads and every piece of
  furniture is a single-sided quad — so the pressure hull's inside-out skin also
  renders from *outside*. And it renders wrongly there by construction: the cabin
  writes alpha 0, which exempts it from the water and hands it the indoor
  exposure. From the water it appeared as a pale fog-free blob in a scene that has
  fog, and where the exterior skin tapers faster than the interior one — at both
  ends — pieces stuck out past the real hull as detached glowing plates. Reported
  as "strange glowing things on the outside of the sub", which is exactly what
  they were. Now gated on the eye being inside the hull envelope, tested against
  the geometry rather than against the mode, because the review cameras are
  outside the boat without being in swim mode. It also stops drawing 30k
  triangles of furniture whenever nobody is aboard.
- **Swimming collided with the heightfield and with nothing else.** The station,
  the wreck and the player's own submarine were all fog you could pass through.
  A hull you can walk around inside and then swim straight through says the whole
  world is a painting. Capsules and boxes now, derived in the builders from the
  same locals that placed the geometry, so they cannot drift out of agreement
  with what is drawn. The boat's capsule is rebuilt every frame from HULL_LEN
  because the boat moves.
- **The swimmer had an edge of the world and the vessel had none.** 280 m for one
  and nothing for the other, so the boat could be driven straight through a
  boundary the player bounced off. Both use `WORLD_R` now, and it is set from the
  terrain mesh rather than by feel: `buildTerrain` spans 1200 m so the ground
  exists to 600, and stopping at 520 leaves 80 m of margin so the limit is never
  the visible mesh edge.

**Lesson worth keeping:** the layer toggles are a debugging instrument, not just a
review convenience. `g.setLayer('hull', false)` identified the glowing plates in
one frame after two rounds of reasoning had failed — switching a subsystem off is
still the fastest way to find out what is drawing something.

### CLOSED — the bright cyan quads were the exterior showing through

Identified by bisection, not by argument: one frame with `g.setLayer('hull',
false)` and every teal panel vanished. They were the exterior hull's saddle
tanks, vents and trunk, seen from inside the cabin and lit by the *outdoor* water
material, which is why they were teal in a room that has no fog.

The interesting part is why the first fix did not take. Fittings were placed
against `shellX`, the analytic half-width the interior and the walking collision
use — but the skin is lofted through `fairStations`, and Catmull-Rom overshoots
its control points. Measured over 60 stations, **the drawn skin stands up to
385 mm outside `shellX + PLATE`**, worst at the tapered ends, while every
clearance was between 80 and 260 mm. The formula and the geometry were two
independent derivations of "where is the hull", and they disagreed by more than
the margin.

Fixed by measuring against the geometry: `skinX` reads the same faired station
list that `loftInto` consumes, so a fitting cannot be inside a skin built from
the same numbers. It samples a *band* of y rather than a point, because a 0.6 m
tank near the bow has its lower corner in a section 30 cm wider than its centre —
with a point sample the tightest clearance was still minus 78 mm.

Verified as arithmetic rather than as a screenshot: all 27 placements checked
against the drawn profile, tightest clearance +65 mm. For a question of the form
"is this inside that", a number is a stronger answer than a frame — and it costs
a second instead of four minutes.

### Added by the first session that could actually look and listen

Two sessions of work had shipped unheard and unphotographed. Running the
instruments found six things, and three of them were in the instruments.

- **`resume()` on an `OfflineAudioContext` throws.** It reports `state ===
  'suspended'` until `startRendering`, so the live-context recovery path — which
  retries a suspended context once a second — filled the console with
  `InvalidStateError` on the very first render. `typeof ctx.startRendering` is the
  discriminator the API gives you.
- **`listen.mjs` silently rendered a different scene than the one asked for.** The
  in-page scene table was a *copy* of the node one; a scene added to one and not
  the other fell through `scenes[name] || scenes.descent` and printed the
  requested name over another scene's numbers. Ten minutes were spent reading a
  spectrum that belonged to `descent`. The tool now has one table, sampled in node
  and passed in, and it exits on an unknown name. **This is the exact failure
  `boot.mjs`'s own header warns about, reproduced inside the harness.**
- **"Energy by octave" was one 0.25 Hz bin.** For a drone that is fine; for
  broadband noise it is a single sample of a random variable, and it reported
  500 Hz thirty decibels above its neighbours. Nine probes a semitone apart,
  averaged in power, per band.
- **A band average under-reads a transient by its duty cycle.** The 3.1 kHz pinger
  sat 40 dB down and looked filtered out; it is a 0.13 s ping every two seconds,
  which is six per cent, or -12 dB before anything else. Isolating it in its own
  scene showed it healthy. The `EAR.waterTilt` change from 1700 to 4500 Hz stands
  on the physics — underwater hearing loss is broadband, not a roll-off — but the
  evidence that prompted it was a misread.
- **An amber lamp is a green lamp.** Measured: the emitted (1.00, 0.42, 0.16)
  arrives at 11.3 m as (0.095, 0.459, 0.135), because red is attenuated five times
  harder. Amber had been chosen precisely so the trunk strobe could not be mistaken
  for bioluminescence, and the water undoes that. **No colour fixes it** — beyond a
  few metres this water passes only green. The distinction has to be carried by
  rhythm: two quick pulses and a gap, which nothing living does.
- **`minutesLeft` could read negative.** `co2` overshoots capacity inside the tick
  that spends the last of it, and a frame caught the wrist unit reading
  "0% · -2.4 MIN" — an instrument that goes negative at the moment the player most
  needs to trust it. Clamped.

**Cleared, not fixed:** the blown white pool under the lamp in most survey frames
is *not* from this pass. Bisected with the new layer toggle — 4982 blown pixels
with the strobe on, 4983 with it off, and `draws` 30 against 29 confirming the
toggle bit. It is the pre-existing look of the lamp, and whether it is too hot is
an art call rather than a defect.

### Added by the steering and excursion pass

- **The vessel and the camera have opposite handedness, and only two of the three
  places that care had been reconciled.** `Vessel` builds `forward = (sin y, 0,
  +cos y)`, so positive yaw carries the bow from +Z toward +X, which seen from
  above is *counter*-clockwise. `Pilot.apply()` knows this and composes the two
  bases with a minus, with ten lines of comment. Nothing ever checked the
  *control* or the *readout* against it:
  - `rudder = +1`, which every name in the file calls starboard, swung the bow to
    the pilot's **left**. Measured at full ahead, `swing · screenRight = -0.986`.
    A player reported it as "steering is inverted" and it was, exactly.
  - a turn to starboard ran the compass **backwards** — 0 to 279.7 degrees — and
    that value feeds `iu.uHeading`, so the console gauge was mirrored too. The
    dial was drawn correctly all along; it was being lied to.
  - the `heading` docstring claimed "clockwise seen from above", which it never was.

  Both fixed with one sign each, and no geometry touched — `forward()`, `toWorld()`,
  `toLocal()` and `applyTo()` stay mutually consistent. **It survived the entire
  piloting pass because a rudder does nothing at rest**, so nothing that was not
  actually under way could have noticed. `tools/dyn.mjs --only helm` now asserts
  both signs against the *imported* camera basis.
- **The basis formula existed five times.** Three copies of the look direction in
  `controls.js` and two of the strafe vector, one of which was its own negative
  (that was the old A/D-swapped-while-walking bug). A steering test that writes it
  out a sixth time proves only that two copies of a mistake agree, so it is now
  `headingDir()` and `screenRight()`, exported, and the test imports them.
- **Re-entry to the boat was unconditional while the prompt was gated.** `V` from
  anywhere in the ocean put you back inside; the on-screen prompt appeared at nine
  metres. So the rule the player was shown and the rule the code enforced were
  different, and the generous one won silently. Harmless while there was nothing
  at stake outside — and the whole loop the moment the canister became the reason
  to come back, because a swimmer 300 m out with a spent scrubber could simply
  teleport home and every number in `life.js` would have been decoration. Now five
  metres of the *trunk*, and the prompt calls the same function with the same
  threshold. **A gate on the prompt is not a gate on the action.**
- **The worst masking is not under the loudest sound, it is in the gap after it.**
  The score's ceiling was set by a case nobody would look for: the boat touches
  down, the loading rate collapses, the hull stops creaking and the "busy hull
  crowds the score" term opens back up — but the drone is still near the top of
  its range, because it falls with a 22 s constant while the hull went quiet in
  one. Twenty seconds of full-level score over a silent hull, which is precisely
  when a creak has to be heard. Raising the crowd term did nothing for the margin;
  the ceiling had to come down. **Two envelopes with different time constants
  produce their worst overlap during the decay, not during the peak.**
- **Ducking the score on every event silenced it exactly when the game was
  frightening.** A descent creaks three times a second, so a per-event duck held
  the drone at a quarter of its level for the entire descent — measured 0.007
  against a ceiling of 0.052. Split into two mechanisms: a busy hull *crowds* it
  down smoothly (it is ambience), and only a big transient or the alarm ducks it
  sharply (those are information). An ordinary creak now does neither.
- **A leak checker that cannot see half the voices reports a clean run.** The stub
  `AudioContext` in `listen.mjs` made oscillator `start`/`stop` no-ops, so
  `onended` never fired for the pinger or the alarm and sixteen voices "leaked" in
  the stub while the real graph was fine. Fixed by making the stub end them, which
  is the only reason the check means anything.

### Added by the sound pass

All three of these were found by arithmetic, and the first two were found before
a single sample had been synthesised. That is the whole argument for building the
mapping layer as pure numbers.

- **A hull's low modes are infrasonic, and the film soundtrack is wrong.** The
  first draft gave the descending groan to the ring-stiffener modes on the
  assumption that a pressure hull's lowest note is a few tens of Hz. Measured at
  this boat's radius, `ringMode(2)` is **11.3 Hz** and the next is 32 — and it
  was weighted at 72% of every descending event, so **descent would have sounded
  like nothing** and the search would have started in the audio graph. `R⁴` in
  the denominator is brutal; a real submarine carries heavy ring frames precisely
  because a 2.35 m shell is that floppy in bending. What is actually audible is
  the shell's ring frequency `c_L/(2πR)` = **358 Hz** and the 0.6 m plate modes
  at 216/540/863 Hz. The 11 Hz number is kept in the file as `OVALLING` because
  it is the reason the low end of a creak comes from the transient's onset rather
  than from a resonance.
- **The ballast tank answered in one second, not eight.** `BALLAST_RATE = 1/8`
  was then multiplied by 8 inside the exponential, so the rate was applied twice
  and cancelled: measured τ = 1.00 s against an intent stated in `vessel.js`'s own
  header, in the README and in this file. **An eightfold error survived because a
  one-second lag still feels like a lag** — the whole "every depth command is
  committed long before it answers" argument was not actually in the build, and
  only a number could show it. Now 8.02 s measured, 95% at 24 s. Found while
  asking how long the ballast hiss should last, which is the sound layer
  measuring the vessel.
- **A continuous voice keyed to a quantity that only asymptotes to zero never
  switches off.** The bottom scrape was proportional to `|way|`, and a hull
  aground on a slope never quite stops — she settles at 17 mm/s and stays there,
  so the voice sat at 0.0017 for ever. Inaudible, unfindable, and precisely how a
  synthesiser acquires a permanent whisper nobody can trace. The physical answer
  is also the right one: sliding friction has a breakaway threshold, so below
  8 cm/s the correct level is exactly zero rather than nearly zero. **Every
  continuous voice needs a gate at the threshold of audibility**, and
  `tools/dyn.mjs` has a released-voices scenario now because nothing else was
  ever going to catch this.
- **`AudioParam` has no `.context`.** Reaching for one to get `currentTime`
  yielded `undefined`, so every parameter change was scheduled at time zero.
  It works in Chrome — a start time in the past means "now" — which is exactly
  the kind of accident that survives until a browser tightens up. Pass the time.
- **A peaking filter in parallel with its own dry path is +6 dB.** It already
  passes the whole signal and adds a bump; hanging it alongside doubles
  everything below the bump and gets the level wrong before the budget has had a
  chance to be obeyed. In series.

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

## 7. State

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

**Performance, finally measured on real hardware at 2560x1347:**

| where | fps | draws | triangles |
|---|---|---|---|
| standing in the machinery space | 183 | 30 | 1743k |
| swimming outside | 240 | 29 | 1714k |
| walking while making 2.35 m/s | 196 | 30 | 1743k |

Three times the 60 fps budget with a million triangles of flora and a second
hull in. **The flora radii do not need trimming** — that dial can stay where it
is, and there is room for creatures.

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
faster telegraph, X all stop, E to stand up. **M mutes.** V at the hatch to go
outside, and V within five metres of the trunk to come back in.

**Leaving the boat is an excursion now, not a change of camera.** Three pieces,
and they only work together — a reason to come back without a way home is a
punishment, and a way home without a reason is scenery.

- **The limit is the suit's CO2 scrubber, not a gas supply**, and that is forced
  rather than chosen: a demand regulator delivers at ambient pressure, so at 43
  atmospheres an hour's cylinder lasts eighty-three seconds. Deep work is
  closed-circuit, oxygen is consumed metabolically and is nearly depth-independent,
  and what runs out is the sorbent. Which is why the boat has a scrubber and an
  "O2" valve tag already sitting in the machinery space — the fiction was built
  before the mechanic. Duration is derived in `src/life.js` from 0.25 kg of
  Sofnolime at 120 l/kg, halved for 4 °C water: **15 litres of CO2 usable.**
  Measured: 59 minutes floating, 32 at a gentle drift, **17 at a cruise**, 9 at a
  sprint. Moving carefully is worth more than any other decision out there, and it
  falls out of the physiology rather than being balanced in.
- **At zero: hypercapnia, then you wake up on a bunk.** The vignette closes over
  the last eight per cent of the canister, breathing goes to 43 a minute, four
  seconds of fade, and you come round in the accommodation with a fresh canister.
  Time is the only thing lost — there is no save system to reload and no death to
  reload it from. Coming back *voluntarily* costs a 22 s canister swap, so the
  readout does not snap to full at the hatch.
- **Direction is light, distance is sound, and that split is the acoustics being
  obeyed.** Outside the hull localisation is gone — interaural time difference
  shrinks by the 4.4× sound-speed ratio — so a sound out there can honestly say
  *how far* and cannot say *which way*. So: an amber strobe on the trunk carries
  the bearing (amber because green is reserved for bioluminescence, and a green
  light on the boat would read as something alive), and a 3.1 kHz pinger carries
  the range by repetition rate alone, Geiger-counter style, from 3.1 s apart at
  130 m down to a quarter-second alongside. Plus a wrist readout with a relative
  bearing arrow, because a compass bearing is a number you then have to solve
  against your own heading, in the dark, while running out of scrubber.

**She has a score now, and it is capped by measurement.** Asked for as "tense
music, tastefully", against a sound layer whose entire thesis is that silence is
the art direction. Three rules keep it honest: it is tuned to the boat (root =
the cabin's 36.5 Hz transverse air mode, top = the shell's 358.4 Hz ring
frequency, a ratio of 9.82 — nearly but not quite three octaves and a third, so
the drone is slightly inharmonic because the hull is); it is driven by state
rather than by a timeline (loading rate, sorbent left, distance from home, and
depth weighted *low* on purpose, because being deep is a constant and a constant
is not tension); and it gets out of the way of every instrument by two separate
mechanisms — a busy hull crowds it down smoothly, a big transient ducks it
sharply. `?music=0` removes it and leaves everything else.

The gate is enforced rather than asserted: `node tools/dyn.mjs --only score`
measures the quietest creak against everything continuous at depth and fails below
6 dB. It reads **6.5 dB**. On the shelf it reads −0.5 dB, and that is physics, not
a defect — surface agitation noise is loudest in the shallows while hull stress is
lowest there. It is also not where the game lives.

**She has a voice now.** `src/acoustics.js` + `src/audio.js`, and the same rule as
the water: the noise floor is not chosen, it is computed. Every frequency comes
from a dimension or a material property already in the project — the shell rings
at `c_L/(2πR)` = 358 Hz, the cabin's air hums at the beam of the boat (36.5 Hz,
while the 18 m length is 9.5 Hz and inaudible, which is why walking forward does
not change it), the pump's blade note is 5 blades × 1450 rpm = 121 Hz against a
fixed 100 Hz mains hum, and the ballast bubbles sit at the Minnaert frequency for
the *current* pressure, so a blow climbs from 1.6 kHz at the surface to 10.6 kHz
on the floor on its own. Three numbers in the file are judgement calls and they
are labelled and grouped, in the same spirit as `Env.scatterGain`.

Six voices, each tied to a physical cause, and two of them are instruments:

- **The creak rate is driven by dP/dt, not by pressure.** A hull at rest at 400 m
  is in equilibrium and quiet: 1 creak per 25 s. The same hull descending at
  1.81 m/s is redistributing stress through every weld: 3.1 per second. Holding
  depth is calm and committing to the bottom is not, and it costs one term.
- **Descent and ascent do not sound alike.** Increasing compression loads the
  whole shell, so it answers low and rings on; relaxing lets single panels go,
  which is short and high. Measured 74% groan going down, 25% going up — **you
  can hear which way you are moving with your eyes shut.**
- **The ballast hiss is the gauge for a tank you cannot see.** Gain comes straight
  from `ballastCmd - ballast`, so a 1.2 s press is audible for 26 s and stops when
  the transfer actually finishes.
- **Outside the hull is not muffled, it is unlocalised.** Thorp says the sea is
  transparent over the 20 m this game can see — 0.0014 dB — so the change when
  your head leaves the boat is the *ear*: the middle ear is bypassed, bone
  conduction takes the top off, and interaural time difference shrinks by the
  sound-speed ratio 4.4, so localisation fails. Loud, close, and coming from
  nowhere is both true and worse than muffled.

Interior versus water is gated on the **geometry** — the same `aboard` test the
cabin's visibility uses — never on `game.mode`, because the review cameras stand
outside the boat without being in swim mode.

Loudness budget, measured rather than intended: the floor at rest sits at 0.040
against a grounding at 0.55, which is 15 dB under the quietest creak. **A sound is
only frightening against silence**, so that table in `acoustics.js` is a gate.

## 8. What to do next, in order

1. **Judge the sound and the frames with a human.** Both have now been *measured*
   — `tools/listen.mjs --mode render` across six scenes and a 33-frame survey with
   contact sheets — and the numbers are healthy: no clipping anywhere, the pump's
   62.5 and 125 Hz peaks are the 100 Hz mains hum and the 121 Hz blade note, the
   ballast blow peaks at 8 kHz exactly as the Minnaert scaling predicts, and the
   interior frames still draw 31 calls and 1743k triangles. What no measurement can
   settle is whether it *sounds* and *looks* right. Put headphones on, and look at
   `shots/_sheet-world.png` and `shots/_sheet-boat.png`.
2. **Decide about the lamp's blown pool.** In most exterior frames the seabed under
   the lamp is pure white over about 1.4% of the frame with 6% near-white. It
   predates this work and it may be the intended "heavy bloom, few light sources"
   look — but seen twenty frames at a time it is the most repeated feature in the
   set, which is exactly the signal the contact sheet exists to give.
3. **The trunk strobe is unproven.** It is positioned, named, toggleable and its
   colour attribute is driven correctly (k = 0.12 dark, 15.12 at full flash, 26.7 px
   at 12 m, and the GL point-size limit is 1023 so it is not being clamped). Whether
   it reads as a light on screen could not be established here, because exposure
   adaptation and grain both swamp it — see section 4. **Judge it on hardware, and
   be ready to delete it**: at 21 m visibility a light cannot be the long-range cue
   anyway, and the wrist unit's bearing arrow is what actually prevents getting
   lost. The arrow is verified working: bearing 042°, range 45 m, checked against
   the geometry by hand.
3. **Creatures.** Procedural organics are the hardest thing in the project and
   there is finally headroom — 183 fps leaves room. Technique is known and written
   down: a sine along the spine in the vertex shader, Verlet chains for tentacles,
   a radial pulse for jellyfish. The scariest creature is the slowest, which is
   also the cheapest to animate. **They now have a soundscape to arrive into**,
   and a creature you hear before you see is a different animal.
4. **A reason to go *down*.** Half of this closed: leaving the hull now has a
   clock on it and a way home, so an excursion is a decision. But that is a reason
   to come *back*, and the descent itself still asks for nothing — she can be
   driven, the zones exist, the pressure model is real and now audible, and no
   part of the game wants the player at 400 m. Still a design gap rather than a
   rendering one, and still the largest thing between "impressive" and "a game".
   The excursion loop is the obvious hook to hang it on: something down there that
   has to be reached on foot, far enough from the boat that fifteen minutes of
   sorbent is a real budget.
5. **Interior polish, the known weak spots.** The mess table and the galley
   counter still read as plain boxes at two metres and want the edge treatment
   the lockers got. The cabin is lit toward the top of its value range and could
   stand more darkness between the lamps.

### Open, small, and honestly not urgent

- **Boulders have no collision.** There are 500-plus instances and the terrain
  underneath them already blocks, so swimming through one is possible but rarely
  noticed. If it becomes annoying, the pattern is in `station.blockers`.
- **The turf is only just legible** at the shelf camera's height.
- **`g.outside()` leaves `game.mode` alone,** so the diagnostic panel reports
  `mode walk` while the review camera is outside the boat. Harness-only cosmetic.
- **The bed's low rumble does not fade with depth,** by design — Wenz's low band
  is roughly depth-blind while surface agitation is not, which is what takes the
  hiss away over a descent. But the exponential that does the fading has no
  citation behind it; it is one of the three labelled judgement calls.
- **No spatialisation.** Losing localisation outside the hull is implemented as a
  shift from direct to diffuse rather than with real panning, which is the honest
  cheap version of the effect and may be enough. If creatures need a direction,
  that is when to reach for `PannerNode`.
- **The dive-band keys `[` and `]` are still advertised on the boot card** but the
  band is review-only now and gated behind `auto=1`. Cosmetic, and it predates
  this pass.

**How this user gives feedback, and it is good feedback:** blunt, specific, and
usually right. They play the build and report what broke. Take the complaint
literally, find the measurable cause, fix the cause rather than the symptom, and
say plainly when something is a genuine gap rather than a bug. They respond well
to being told what is not fixed.
