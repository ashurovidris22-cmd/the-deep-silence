# Creatures — options, not decisions

**Most of this file is still unbuilt**, and it remains the record of a design
conversation rather than a plan. `HANDOFF.md` holds what has been decided and
measured; this holds what has only been argued.

Three things have since crossed over, and where they did the argument here
survived contact with a measurement — which is the main reason to keep reading
it. Section 5's acoustic mimic, section 6's first archetype, and section 6's
**siphonophore** are all in the game now (`src/creatures.js`,
`src/siphonophore.js`, `src/chain.js`, gated by `tools/dyn.mjs --only mimic |
creature | chain | colony`). Two corrections earned by building them:

- **Section 2's Verlet warning was right about the failure and wrong about its
  shape.** A thirty-node chain at `dt` 0.1 does not blow up; it goes quietly
  slack, which is worse, because wrong geometry still renders. And the fix is
  not more iterations — it is a substep cap, which also makes the motion
  frame-rate independent. See `chain.js`.
- **Section 4's 38 m figure is load-bearing and must be applied, not just
  quoted.** The colony's first photophore constant was chosen by eye at 1.55
  and arrives at 38 m attenuated to 1.4e-3 — six times under the ambient
  floor, i.e. invisible, in the exact creature whose whole design is "arrives
  as a light". Emission has to be *solved* from the range claim.

The siphonophore is the archetype below that came out closest to its
description: no head, no AI, one draw call, and the water doing the design.

Where a number appears here it has been checked, because an argument with a number
in it survives a handoff and an opinion does not.

---

## 1. The horror is already built. Creatures go *into* it

Three systems that already work are the monster design, not scenery around it. This
is the most important section in the file, because it means the expensive part is
done and the creature is the cheap part.

**Localisation is destroyed outside the hull.** Interaural time difference is head
width over sound speed, and sound speed in water is 4.4x higher, so the cue the
brain uses for direction collapses. `EAR.waterSpread` already implements it as a
shift from direct to diffuse. A creature you can hear and cannot place is the best
mechanic in the build and it costs nothing further.

**Visibility is 26 m at depth**, and that is Duntley's contrast threshold on
measured extinction: `4.8 / 0.183`. So **an animal longer than 26 m can never be
seen whole** — not as a designer's restraint but as optics. The fog does the
monster design. A 45 m animal is only ever a piece of an animal.

**The scrubber is a clock.** 15 litres of usable sorbent, 17 minutes at a cruise.
A creature that makes the player *wait* is spending their air. **Its weapon is
time, not damage** — which means no health bar, no combat, and no weapon art. The
player manages distance, light and breathing, and those are the three things the
build already simulates.

---

## 2. Animation: the Strouhal number is the constant

The project has a constant for optics (Jerlov), one for bubbles (Minnaert) and one
for hull modes (the shell ring frequency). Swimming has one too:

```
St = f A / U  ~=  0.25 to 0.35     for efficient swimmers, from a sprat to a whale
```

So the tailbeat is **derived from the speed** rather than tuned:

```
f = St U / A          U = 1.0 m/s, A = 0.20 m, St = 0.30  ->  f = 1.5 Hz
                      U = 0.3 m/s, A = 0.20 m, St = 0.30  ->  f = 0.45 Hz
```

An animal that speeds up beats faster, and correctly, with no animator involved.
This is the same methodology as the rest of the project pointed at movement, and it
is the reason procedural animation is the right choice here rather than a
compromise: it responds to state continuously, and a baked clip cannot.

### The techniques, in order of value per line of code

Almost all of it belongs in the vertex shader, which means one draw call and zero
CPU per creature.

- **Travelling wave along the body.** Lateral offset `A(s) sin(2 pi (s/lambda - f t))`
  where `s` is arc length. **The amplitude envelope grows toward the tail** — that
  is what real fish do, and a constant envelope is the single most common reason
  procedural swimming looks wrong.
- **One parameter turns an eel into a tuna.** Where the envelope starts is the
  difference between anguilliform (whole body undulates) and carangiform (stiff
  forward, tail only). One shader is a family of animals.
- **Body curvature from yaw rate.** A fish bends into its turn. One line, and
  steering stops reading as sliding.
- **Verlet chains for tentacles and trailing parts.** 8 chains x 12 nodes x 3
  iterations at 60 Hz is nothing on the CPU. The value is not the chain, it is the
  **secondary motion**: appendages lag the body, and lag is the strongest single
  cue for "alive" rather than "animated". At neutral buoyancy gravity is nearly
  zero, so they float and trail rather than hang — which is exactly the deep-sea
  silhouette.
- **Bell pulse with a phase delay by height.** A jellyfish contracts from the rim
  inward, not all at once. That delay is what produces the vortex-ring recoil read.
- **Idle micro-motion, always.** 0.1 to 0.3 Hz of breathing even at rest. A
  perfectly still creature is a model.
- **No squash and stretch.** Volume-preserving bend only; cartoon deformation reads
  as weightless, and weight is the whole point.
- **No keyframes anywhere**, which the no-assets rule already forces and which is
  better here regardless.

### Verification, in keeping with the rest of the harness

All of the above is arithmetic and belongs in `tools/dyn.mjs` before it is ever
looked at: assert that `f` tracks `U` through St, that the amplitude envelope is
monotonic toward the tail, that a Verlet chain is stable at `dt` clamped to 0.1
(it will not be, at three iterations — find out in node, not in a browser), and
that nothing goes NaN when speed is zero.

---

## 3. What makes them frightening — design, not technique

- **Indifference.** The worst thing in the deep is not hunting you; you are
  irrelevant to it. That is SOMA's register and it is much harder to shrug off than
  aggression.
- **It obeys the rules the player obeys.** If it reacts to the lamp — retreats,
  or worse, orients — then the lamp becomes a decision instead of a convenience.
- **The boat is a sanctuary that can be violated.** Hearing something scrape the
  hull *from inside* is the strongest moment available in the current build, and
  the parts exist: `vessel.contact` is already an impact strength, and a strike
  rings the shell at 358 Hz.
- **Sound first, shape later, and the hull inverts the rule.** Outside you hear it
  and cannot place it. Inside you hear it *through* the hull, where the cabin
  acoustics give localisation back. Going inside makes you safer and better
  informed at the same time, which is the correct incentive.

---

## 4. The roster, derived from the optics

Green attenuates at 0.183/m at depth, so it e-folds every 5.5 m: a light is at 1%
of emitted value by 25 m and 0.1% by 38 m. Against the ambient floor (green 0.009)
a bright photophore is still legible at roughly **38 m**, while Duntley visibility
for a *reflective* surface is **26 m**.

**So bioluminescence is visible about one and a half times further than anything
lit.** That single fact sets the whole reveal grammar: **a creature arrives as a
light and resolves into a body only when you close.**

| creature | why it works here |
|---|---|
| **Siphonophore** (real *Apolemia* reach 45 m) | A chain of clones with **no head**. Pure Verlet, nearly free, and 45 m against 26 m visibility means it is physically impossible to see whole |
| **Anglerfish type** | The lure is the permitted green and the body is not lit at all. You swim toward a light and discover it is attached to something |
| **Predatory sea pen** | Sea pens already grow on the floor in `flora.js`. A wrong one is a costume change on existing geometry — horror out of the familiar |
| **Amphipod swarm** | Thousands, instanced, on a carcass. Cheap, and it makes the floor feel populated rather than decorated |
| **Whale fall** | Not alive, but it is **the reason to go down** — section 8 item 4 — and it is what everything else is there for |

---

## 5. The best idea in the conversation: an acoustic mimic

The trunk pinger is 3.1 kHz with an interval that falls from 3.1 s at 130 m to a
quarter-second alongside. It is the player's way home, and they learn to read it
within one excursion.

**Something answers it.** Same frequency, slightly detuned, with an interval that
does not match the range the player is actually at.

Now there are two pingers and no way to tell which one is the boat. It weaponises
the exact instrument the player depends on, it reuses `_ping` in `audio.js` with
two changed numbers, it needs no model and no texture, and it is frightening
before the creature has been seen at all. Acoustic mimicry is also real, which
keeps it on the right side of the project's one rule.

Second-order idea from the same place: the mimic gets *better* the longer it hears
the real pinger.

---

## 6. Order of work

1. ~~**One archetype, complete.**~~ **Built.** Anguilliform swimmer: Strouhal-derived
   tailbeat, a photophore line, lamp-shy. `src/creatures.js`.
2. ~~**Voice and mimicry.**~~ **Built**, and in the right order — the mimic was
   audible for a whole pass before it had a body, which is what the "sound before
   sight" claim was actually asking for.
3. ~~**Siphonophore.**~~ **Built.** `src/siphonophore.js` on `src/chain.js`. It was
   indeed almost free once the solver existed: one draw call, thirty vec3
   uniforms, no CPU per frame beyond the chain itself. The expensive part was
   neither the solver nor the shader but the two arithmetic mistakes above.
4. **Swarm.** Instanced, on the carcass. **This is next.** Note that it needs
   the whale fall to be worth doing — a swarm on nothing is a particle effect —
   so item 4 and the carcass in section 4's table are really one piece of work.

---

## 7. Budget

Measured on the user's hardware: **183 fps standing in the machinery space, 240
swimming, at 2560x1347, with 1.7M triangles and 30 draw calls.** That is three to
four times the 60 fps budget.

- A creature at 5k to 20k triangles, animated entirely in the vertex shader, is one
  draw call and no CPU. **Fifty of them on screen is affordable.**
- Verlet: 100 nodes at 3 iterations and 60 Hz is trivial.
- The thing that would *not* be affordable is CPU skinning of many unique meshes.
  Do not. Vertex shader only.
- WebGPU is not needed for any of this. It becomes interesting at thousands of
  animated creatures or a froxel volumetric, not before.

---

## 8. Rendering headroom, separately

Not creatures, but it came out of the same conversation and it is measured. See
`HANDOFF.md` section 7 for the facts; the short version is that the art direction
in section 1 asks for "everything else in shadow" and **there is not one shadow map
in the project**. With 3-4x headroom sitting unused, a single shadow-casting
projector on the lamp is the largest visual return available — the shadow of a
catwalk moving across the seabed as the player turns their head is the reference
frame this project is built around.
