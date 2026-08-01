# The main.js shadow wiring

**Status: not yet applied to `src/main.js` in this repository.** Apply it, run
the gate, commit `main.js`, and delete this file. It is a workaround for a
transport that could not send a patch, not a document with a future.

Everything else is already committed: `src/shadow.js` (the pass), the `LAMP`
chunk in `src/glsl.js` (the cone and the occlusion test), and two receivers,
`src/terrain.js` and `src/structures.js`. What is missing is the sixty lines in
`main.js` that construct the pass, choose the casters, drive it each frame, and
expose the diagnostics. Until they are in, `uShadowOn` stays 0 everywhere and
the game renders exactly as it did before shadows existed.

Six insertions. Each anchor below is a line that exists in the committed
`main.js`; insert the new text immediately after it, except where stated.

## 1. Import

After:

```js
import { FS_VERT, WATER } from './glsl.js';
```

Insert:

```js
import { LampShadow, castsShadow } from './shadow.js';
```

## 2. Construction

After:

```js
const post = new Post(renderer);
```

Insert:

```js

/* The lamp's shadow. 1024^2 is the smallest map that keeps two texels across a
 * catwalk grating bar at ten metres; see src/shadow.js for the arithmetic.
 * ?shadows=0 switches the pass off, because a subsystem you cannot switch off
 * cannot be cleared of causing something. */
const lampShadow = new LampShadow(renderer, { size: qNum('shadowsize', 1024) });
lampShadow.on = qNum('shadows', 1);
lampShadow.biasScale = qNum('shadowbias', 1);

/* Multiplier on the lamp's 0.72 m mounting arm. A diagnostic, not a setting:
 * a lamp at the eye casts shadows that hide exactly behind the things casting
 * them, so "no shadow visible" and "no shadow computed" look identical from
 * the outside. Swinging the lamp out on a long arm separates them - if a
 * shadow appears at 8 m of arm and never at 0.72 m, the pass works and the rig
 * geometry is what hides it. Anything but 1 in a committed build is wrong. */
let lampArm = qNum('lamparm', 1);
```

## 3. Who casts

After:

```js
scene.add(ext.mesh);
```

(the one following `const ext = buildExterior();`), insert:

```js

/* Who casts. Opt-in, and the list is short on purpose.
 *
 * The depth pass replaces every material with a plain one, which means it has
 * no idea about alpha cutouts - so kelp, turf, sea pens, sponges and whips
 * would each cast the solid rectangle of their billboard rather than their
 * silhouette. Marine snow would cast three thousand of them. What is left is
 * everything with real geometry: the seabed and its rocks, the installation and
 * its walkway, the wreck, and the boat inside and out.
 *
 * Foliage shadows are not being skipped because they are cheap to skip - kelp
 * moving across a lit seabed is exactly the kind of thing the art direction
 * asks for. They need the cutout carried into the depth pass, which is a
 * second override material, and that is a separate piece of work. */
for (const o of [terrain, rocks, station.mesh, sub.mesh, boat.mesh, ext.mesh]) castsShadow(o);
```

## 4. Harness

Inside the `window.__game` object literal, after:

```js
  setLamp: (v) => { game.lampOn = v; syncWater(); },
```

insert:

```js
  /* 0 off, 1 normal, 2 force every lit surface into shadow. Numeric rather
   * than boolean: written as `v ? 1 : 0` this silently collapsed the bisect
   * mode into ordinary shadows, which is a control that lies about what it is
   * doing - the worst kind to have in a diagnostic. */
  setShadows: (v) => { lampShadow.on = +v; },
  setShadowBias: (v) => { lampShadow.biasScale = v; },
  setLampArm: (v) => { lampArm = v; },
  /* What the shadow pass actually is, right now, read out of the live scene.
   *
   * Two frame measurements contradicted each other - the map read as empty
   * under one probe and as never occluding under another - and a contradiction
   * between two pictures is not settled by taking a third. This reports the
   * uniforms themselves: how many registered materials even declare the shadow
   * block, how many have a map bound, and what the pass thinks its own state
   * is. */
  shadowInfo: () => ({
    on: lampShadow.on,
    size: lampShadow.size,
    near: lampShadow.uniforms.uShadowNear.value,
    far: +lampShadow.uniforms.uShadowFar.value.toFixed(2),
    tanHalf: +lampShadow.uniforms.uShadowTanHalf.value.toFixed(4),
    registered: env.materials.length,
    declaring: env.materials.filter((u) => u.uShadowMap).length,
    mapBound: env.materials.filter((u) => u.uShadowMap && u.uShadowMap.value).length,
    onInMats: env.materials.filter((u) => u.uShadowOn).map((u) => u.uShadowOn.value),
    rtSize: [lampShadow.rt.width, lampShadow.rt.height],
    depthType: lampShadow.rt.depthTexture && lampShadow.rt.depthTexture.type,
    lampPos: env.lampPos.toArray().map((x) => +x.toFixed(2)),
    lampDir: env.lampDir.toArray().map((x) => +x.toFixed(3)),
    vp: lampShadow.viewProj.elements.map((x) => +x.toFixed(3)),
  }),
```

The next line should be `setWater: (a, b, t) => env.setWater(a, b, t),`.

## 5. The lamp arm becomes a variable

In the per-frame lamp aiming, replace:

```js
    .addScaledVector(right, 0.72)
```

with:

```js
    .addScaledVector(right, 0.72 * lampArm)
```

Nothing else in that block changes. The committed value of `lampArm` is 1, so
the rig geometry is unaltered.

## 6. The frame hook

After:

```js
  renderer.info.reset();
```

insert:

```js

  /* Depth from the lamp, then broadcast. After info.reset, so the pass pays for
   * itself in the draw and triangle counts the survey reads - a cost that hides
   * from the instrument is a cost nobody will find later.
   *
   * After the lamp has been aimed and everything has moved for this frame: the
   * lamp rides the hull, so a map rendered before the boat finished moving is a
   * map of where the shadow was last frame. */
  lampShadow.update(scene, env);
  for (const u of env.materials) lampShadow.applyTo(u);
```

The next line should be `post.render(scene, camera, env);`.

## After applying

```
node --check src/main.js
node tools/dyn.mjs      # expect 172 lines identical to reference/baseline-dyn.txt
node tools/listen.mjs --mode graph   # expect 19 lines identical to the baseline
```

Strip comment lines and leading blanks from **both** sides before diffing. An
asymmetric strip fabricates a one-line difference and has already cost one
false gate failure.

Then render `m-catwalk` at `?shadows=0` and `?shadows=1` and block-compare. The
expected result is below; if the patch is in and the catwalk comes back clean,
something is wrong.

---

# Machine notes, session of 1 August 2026

These are about the sandbox and the method. The reasoning about the game is in
the commit bodies, where it belongs.

## The shadow question is answered

The depth pass is correct, aligned, populated and correctly sampled. This was
established with four diagnostic modes in `lampShadow`, each answering a
question the previous one could not, at pose `G-hulls`:

| mode | question | result |
|---|---|---|
| 3 | does the map cover the lit floor | 12.86 % darkened, largest 107.3 - yes |
| 4 | what depth is stored there | delta -0.11, below noise - just under 1.0 |
| 5 | was anything rendered into it | 12.64 %, largest 105.7 - yes, 0.99 to 0.999 |
| 6 | does the map agree with the matrix reading it | 0.21 %, below noise - yes, to 0.002 |

Mode 6 is the answer. The stored depth at every lamp-lit pixel is that pixel's
own depth, because a head-mounted lamp is coaxial with the eye: the first
surface the lamp sees along a ray is the surface the camera sees along it.
There is nothing to shadow. This is a property of the rig, not a bug.

Shadows can therefore only appear where light passes through a gap the eye can
also see through. In this scene that is bar grating, 3 cm slots.

## The first measured shadow

Pose `m-catwalk`, 800x450, shadows off against on, 16x16 block means:

```
delta -0.06   darkened >5 0.43%  >15 0.14%  >30 0.07%
largest darkening 32.2   largest brightening 6.2
region rows 22..22 of 28, cols 23..24 of 50
```

Bias sweep, the test that separates a shadow from acne:

```
0.25x  largest 33.5   same two blocks
4x     largest 31.6   same two blocks
16x    largest 32.7   same two blocks
```

Sixty-four-fold change, no movement. Compare the acne measured earlier at
`e-floor` over the same range: 26.07 % -> 5.64 % -> 0.00 %. Acne lives at a
fraction of a texel and dies of bias; a real occluder does not notice.

`n-station` and `o-wreck` came back at 5.7 and 9.1 largest, i.e. nothing, which
is the coaxial-lamp result and is expected.

## Traps in this sandbox, all of them paid for

**Edits silently revert.** The editor returns success with a correct snippet
and the change is later absent from disk. Seen three times. Re-grep every edit
in the same shell command as the run that depends on it.

**The sandbox has been wiped mid-session, twice.** Push work as soon as it is
proven. Never accumulate.

**A frame takes about twenty seconds** under SwiftShader. Any harness call that
toggles state and screenshots 1.4 s later photographs the frame rendered before
the toggle. Every harness-driven shadow test taken that way was invalid. Use
fresh boots through URL parameters, or poll `window.__game.frames` until it
advances by two.

**A test that changes the illumination cannot be the control for it.** The
lamp-arm test at 8x moved the frame mean from 162.85 to 81.96 because the lit
patch left the frame. It measured nothing.

**Per-pixel diffs measure grain.** The renderer has no temporal filter and
grain runs to +/-80 per channel sum. Block-average at 16x16; the floor is then
about +/-6 and anything above 15 is real.

**An unbounded early-out makes later modes unreachable.** `if (uShadowOn > 1.5)
return 0.0;` swallowed modes 3, 4 and 5, which all silently reported mode 2's
answer. Three near-identical numbers from three probes that ask different
questions is the signature of dead code, not of agreement.

**`tools/survey.mjs --only` takes exactly one pose name**, one browser launch
each, about twenty seconds a frame.

**`g` exists only inside the setup string** that `bootGame` evaluates.
Everywhere else use `window.__game`.

**Background servers do not survive between shell calls.** Start them in the
same command, in a subshell: `(python3 -m http.server 8123 >/dev/null 2>&1 &)
&& sleep 2 && ...`. Note the parentheses; `&&` before a bare `&` moves the
shell out of the working directory.

**No DNS and no egress.** A `/dev/tcp` probe will claim otherwise; it is
lying. `curl --resolve` returns 000.

## Known stale documentation

`HANDOFF.md` section 7 states "There are no shadows. Not one shadow map
anywhere in `src/`." Both halves are now false. Section 8 item 4 asks for the
shadow projector; it is built. Neither has been rewritten, because `HANDOFF.md`
is 70 KB and this transport sends whole files only. Rewrite section 7 to say:
one spotlight shadow map on the lamp, 1024^2, five receivers, coaxial with the
eye and therefore visible only through grating.

## What is next

1. Apply the patch above, verify, commit `main.js`, delete this file.
2. More receivers, in descending value: `props.js` (two cone sites),
   `flora.js` (four), `snow.js`, `post.js`. Each still carries the stale
   defaults `uLampInt: 90`, `uLampCos: Math.cos(0.42)`, `uLampSoft: 0.30`;
   correct them to 900, `cos(0.74)`, 0.34 while migrating.
3. Keep the three attenuation forms distinct. Surfaces `1/(6 + d^2)`,
   volumetric `1/(1 + 0.9 d^2)`, snow `1/(1 + 4.5 d^2)`, flora `1/(6 + d^2)`.
   They differ for reasons, not by drift.
4. Decide whether the volumetric march samples the shadow map. A beam bitten by
   the catwalk is the largest visual return still available; it costs a lookup
   inside a 64-step loop. Measure before deciding.
5. A second override material with alpha cutouts, so foliage can cast.
6. A fixed second light offset from the eye would produce shadows everywhere
   rather than only through grating. That is a judgement call about the art
   direction, not an optimisation, and should be labelled as one.
