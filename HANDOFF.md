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
src/terrain.js    the canyon: shelf, wall, floor. Also seabedHeight() for collision
src/props.js      kelp and boulders
src/snow.js       marine snow
src/structures.js Welder (CPU mesh builder) + the station on the canyon floor
src/sub.js        the lofted wreck
src/interior.js   the walkable boat: hull, deck, compartments, helm
src/controls.js   Pilot: swim mode and walk mode, deliberately separate paths
src/post.js       HDR: volumetric, DOF, bloom, tonemap, dual exposure
src/rng.js        seeded PRNG — see the bug ledger for why this is load-bearing
```

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
  geometry rather than guessing them.

---

## 7. State, and what is next

**Working:** the canyon (30 m at the rim to 424 m on the floor, all positional),
physically-grounded water, caustics, marine snow, kelp restricted to the photic
zone, the station with walkways and towers, a lofted wreck, a walkable
submersible with three compartments and a helm, walk/helm/swim modes, collision
against the deck and the furniture, on-screen controls and contextual prompts.

**The user's standing complaints, in their order of importance:**

1. **The interior is under-detailed.** This is the live one. The hull and fittings
   exist but the compartments are close to empty, so surfaces read as large flat
   areas up close. It needs the things a real boat is mostly made of: bunks, a
   table with fiddles, instrument cabinets with lamps, extinguishers, cable looms,
   racking with crates, loose gear, stencilled labels, handprints in the paint —
   plus small geometry on the walls themselves: rivets, doublers, trunking.
   **This is a content pass, not a shader problem.**
2. Piloting the boat from the helm seat. The seat currently only changes the
   viewpoint; the vehicle does not move.
3. Sound. Hull creak under pressure would do more for tension than ten more panel
   details.
4. Creatures. Deliberately deferred: procedural organics are the hardest part.
   Technique is known — sine along the spine in the vertex shader, Verlet chains
   for tentacles, radial pulse for jellyfish. The scariest creature is the slowest,
   which is also the cheapest to animate.

**How this user gives feedback, and it is good feedback:** blunt, specific, and
usually right. They play the build and report what broke. Take the complaint
literally, find the measurable cause, fix the cause rather than the symptom, and
say plainly when something is a genuine gap rather than a bug. They respond well
to being told what is not fixed.
