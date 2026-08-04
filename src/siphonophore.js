import * as THREE from 'three';
import { WATER, LAMP } from './glsl.js';
import { VerletChain } from './chain.js';

/* The siphonophore. Second archetype, and the one the optics designed.
 *
 * `DESIGN-CREATURES.md` argues for it on three grounds and all three are
 * arithmetic rather than taste:
 *
 *  - **A colony has no head.** Apolemia is a chain of clones, so there is
 *    nothing to model a face on and nothing for the player to read intent from.
 *    That is the horror: indifference, in a shape that cannot even look at you.
 *  - **45 m of animal against 26 m of water.** Duntley contrast visibility here
 *    is 4.8/c = 26 m, so at most 58% of it can be in frame at once and the ends
 *    are always in fog. The fog does the monster design; no restraint required.
 *  - **It is nearly free.** One Verlet chain, one draw call, and the whole body
 *    is swept in the vertex shader from thirty node positions. The scariest
 *    creature is the slowest, which is also the cheapest to animate.
 *
 * Nothing here hunts. It drifts on its own path and does not know the player
 * exists — the mimic in `creatures.js` is the one that reacts. Two creatures
 * that both respond to you are two of the same creature.
 */

/* Apolemia's published reach. Not rounded up for effect: the argument in the
 * design file is specifically that a real animal is already longer than this
 * water can show, and inflating it would give that argument away. */
export const COLONY_LENGTH = 45.0;
export const NODE_SPACING = 1.5;
export const NODES = Math.round(COLONY_LENGTH / NODE_SPACING) + 1;   // 31

/* Green e-folds every 5.5 m at depth, so a bright photophore against the
 * ambient floor is still legible at about 38 m — one and a half times the
 * reflective range. This is the number that sets the reveal grammar for every
 * creature in the roster: it arrives as a light and becomes a body later. */
export const BIOLUM_RANGE = 38.0;

/* A drifter, not a swimmer. A cruising player makes 4.4 m/s, so at this speed
 * the colony is 25x slower and could not pursue anything if it wanted to —
 * which is the point, and is why it needs no AI at all. */
export const DRIFT_SPEED = 0.17;

/* Beyond this, the colony is not merely unseen — it is unseeable, and may be
 * quietly moved.
 *
 * It drifts on a closed path bounded at about 37 m from wherever it was born,
 * so without this the animal existed in exactly one place in the world: the
 * spot where the player first happened to leave the boat. Drive three hundred
 * metres down the canyon and swim out, and there is no siphonophore in the
 * game any more, for good.
 *
 * Re-seeding is only honest if it cannot be witnessed, and 80 m clears that by
 * a wide margin. Green e-folds every 5.5 m, so a crest emitted at 8.4 arrives
 * from 80 m at 8.4*e^(-0.183*80) = 3.6e-6 — four orders of magnitude below the
 * ambient floor of 0.009. The re-spawn lands it at BIOLUM_RANGE + 8 = 46 m,
 * which is also under the floor (1.8e-3), so neither the departure nor the
 * arrival is a pop. It becomes visible only by drifting closer, which is the
 * reveal grammar the whole roster is built on. */
export const RESEED_RANGE = 80.0;

/* The luminescent wave: spatial frequency (crests per unit body) and temporal
 * frequency (crest travel per second). One owner for both numbers — the
 * fragment shader below interpolates these same constants, so the JS function
 * the harness measures and the wave the player sees cannot drift apart. */
export const PULSE_K = 5.5;
export const PULSE_W = 0.42;

/** Where a pulse is along the body at arc position s and time t.
 *
 * A travelling wave, not a synchronised flash. Real siphonophore luminescence
 * propagates along the stem, and the difference is the whole read: everything
 * blinking together is a string of lights, a wave passing down is a nervous
 * system. Exported because dyn.mjs asserts that the crest actually travels. */
export function pulseAt(s, t) {
  const phase = s * PULSE_K - t * PULSE_W;
  return Math.pow(Math.max(0, Math.sin(phase * Math.PI * 2)), 6.0);
}

/**
 * Is the colony there at all?
 *
 * Three gates, and each one is a rule the project already holds:
 *  - inside the hull you are safe and it is not drawn (the boat is sanctuary)
 *  - above the photic zone it does not belong — the same argument that keeps
 *    kelp on the shelf and animals on the floor, applied to the animal
 *  - never within 30 m, because a thing that is 45 m long has to be arrived at
 *    rather than spawned on top of, and because it has no business being near
 *    the hatch the player is running for
 */
export function colonyPresence({ outside, depth, range }) {
  if (!outside) return 0;
  const deep = Math.max(0, Math.min(1, (depth - 180) / 90));
  const clear = Math.max(0, Math.min(1, (range - 30) / 14));
  return deep * clear;
}

/* ------------------------------------------------------------------ geometry
 *
 * A tube with arc position baked in, swept along the chain in the vertex
 * shader. The CPU updates thirty vec3 uniforms per frame and nothing else —
 * no skinning, no geometry rebuild, which is what the budget section of the
 * design file insists on. */
function colonyGeometry(sides = 7) {
  const rings = 64;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const s = r / rings;
    for (let i = 0; i < sides; i++) {
      // position carries nothing but the parameterisation; the shader places it
      pos.push(0, 0, 0);
      uv.push(i / sides, s);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < sides; i++) {
      const a = r * sides + i, b = r * sides + (i + 1) % sides;
      const c = (r + 1) * sides + (i + 1) % sides, d = (r + 1) * sides + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  /* Never culled. The bounding volume would have to be recomputed every frame
   * from the chain, and a 45 m animal whose middle is on screen while both ends
   * are outside the frustum is precisely the case three.js would get wrong. */
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

function colonyMaterial() {
  const nodes = [];
  for (let i = 0; i < NODES; i++) nodes.push(new THREE.Vector3());
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uExt: { value: new THREE.Vector3() }, uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() }, uScat: { value: new THREE.Vector3() },
      uSurfaceIrr: { value: new THREE.Vector3() }, uSurfaceY: { value: 0 },
      uScatterGain: { value: 1 }, uAmbientFloor: { value: new THREE.Vector3() },
      uLampPos: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0, 0, -1) },
      uLampCol: { value: new THREE.Vector3(1, 0.97, 0.92) }, uLampInt: { value: 900 },
      uLampR0: { value: 20 },
      uLampCos: { value: Math.cos(0.74) }, uLampSoft: { value: 0.34 },
      uShadowMap: { value: null }, uLampVP: { value: new THREE.Matrix4() },
      uShadowSize: { value: 1024 }, uShadowTanHalf: { value: Math.tan(0.74) },
      uShadowNear: { value: 0.25 }, uShadowFar: { value: 30 }, uShadowOn: { value: 0 },
      uShadowBiasScale: { value: 1 },
      uTime: { value: 0 }, uReveal: { value: 0 },
      uNodes: { value: nodes },
    },
    vertexShader: /* glsl */`
      uniform vec3 uNodes[${NODES}];
      uniform float uTime;
      varying vec3 vW, vN; varying float vS; varying float vRing;

      void main(){
        float s = uv.y;
        float a = uv.x * 6.2831853;

        /* Sample the chain. Node positions are world-space already, so the
         * model matrix is identity and deliberately unused — the chain IS the
         * transform, and running it through a second one would give the body
         * two owners of where it is. */
        float fi = s * float(${NODES - 1});
        int i0 = int(floor(fi));
        int i1 = min(i0 + 1, ${NODES - 1});
        float ft = fi - float(i0);
        vec3 p0 = uNodes[i0], p1 = uNodes[i1];
        vec3 centre = mix(p0, p1, ft);

        /* Frame from the local tangent. A parallel-transported frame would be
         * better and costs a CPU pass down the chain; this is a body of
         * revolution with no texture running along it, so the twist a naive
         * frame introduces is invisible. The up reference is tilted off
         * vertical so a colony drifting horizontally never hits the degenerate
         * case where the tangent is parallel to it. */
        vec3 tang = normalize(p1 - p0 + vec3(1e-5));
        vec3 ref = normalize(vec3(0.19, 0.97, 0.14));
        vec3 bi = normalize(cross(tang, ref));
        vec3 nor = normalize(cross(bi, tang));

        /* Radius: thickest a third of the way down and tapering to nothing at
         * both ends, because a colony has a nectosome that does the swimming
         * and a siphosome that trails. Never exactly zero — a degenerate ring
         * gives the normal nothing to be computed from. */
        float bulk = sin(3.14159 * pow(s, 0.65));
        float rad = 0.035 + 0.30 * pow(max(0.0, bulk), 1.25);
        // Gentle peristalsis, so it is never a rigid rod.
        rad *= 1.0 + 0.14 * sin(s * 22.0 - uTime * 1.1);

        vec3 off = (cos(a) * bi + sin(a) * nor) * rad;
        vec3 w = centre + off;
        vW = w; vN = normalize(off); vS = s; vRing = uv.x;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      ${LAMP}
      varying vec3 vW, vN; varying float vS; varying float vRing;
      uniform float uTime, uReveal;

      void main(){
        vec3 L = uLampPos - vW; float d = length(L); vec3 ld = L / max(d, 0.001);
        float diffuse = clamp((dot(normalize(vN), ld) + 0.42) / 1.42, 0.0, 1.0);
        /* Gelatinous tissue transmits. A siphonophore lit from behind glows
         * along its whole width, which is the cue that says this is not a rope
         * — the same transmission term the sea pens and sponges already use. */
        float trans = pow(max(0.0, dot(-normalize(vN), ld)), 1.5) * 0.7;
        float lit = lampCone(-ld) * (diffuse + trans) * lampAtten(d);
        vec3 flesh = vec3(0.030, 0.041, 0.047) * (0.72 + 0.28 * sin(vS * 130.0));
        vec3 color = flesh * (ambientAt(vW.y) + uLampCol * lit * lampTransmit(d));

        /* The photophores, and they are the reason this thing is legible at
         * 38 m when its body is not. One pulse travelling down the stem, and a
         * second slower one behind it, so the rhythm never resolves into a
         * period the player can count — which is what separates it from the
         * trunk strobe's deliberate two-pulse cadence.
         *
         * The emission is sized by the BIOLUM_RANGE claim rather than by
         * taste, because the first draft failed its own arithmetic: at 1.55
         * emitted, a crest arrived at 38 m attenuated by e^-6.95 to 1.4e-3 —
         * six times UNDER the ambient floor's green of 0.009, invisible. For
         * the crest to sit at the floor after 38 m of water it must leave at
         * about 0.009 / e^-6.95 = 8.4. Dazzling up close is not a bug: a
         * bright point in a dark sea is what bioluminescence is. */
        float p = max(0.0, sin((vS * ${PULSE_K.toFixed(2)} - uTime * ${PULSE_W.toFixed(2)}) * 6.2831853));
        float glow = pow(p, 6.0) + 0.35 * pow(max(0.0, sin((vS * 3.1 - uTime * 0.19) * 6.2831853)), 10.0);
        // Concentrated on the flanks: a line of light, not a glowing tube.
        float flank = pow(1.0 - abs(cos(vRing * 6.2831853)), 3.0);
        color += vec3(0.19, 8.4, 5.0) * glow * flank * (0.22 + 0.78 * uReveal);

        /* Alpha rises with reveal AND with the body's own bulk, so the tapered
         * ends fade out instead of terminating in a hard edge. A 45 m animal
         * that stops abruptly at its tip reads as a model that ran out. */
        float body = smoothstep(0.0, 0.10, vS) * smoothstep(1.0, 0.88, vS);
        gl_FragColor = vec4(applyWater(color, vW), uReveal * (0.30 + 0.70 * body));
      }`,
  });
}

export class Siphonophore {
  constructor(env) {
    this.root = new THREE.Group();
    this.root.name = 'siphonophore';
    this.material = colonyMaterial();
    env.register(this.material);
    this.mesh = new THREE.Mesh(colonyGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'siphonophoreBody';
    this.root.add(this.mesh);
    this.root.visible = false;

    this.chain = null;
    this.t = Math.PI * 0.37;          // an arbitrary point on its own path
    this.anchor = new THREE.Vector3();
    this._seed = new THREE.Vector3();
  }

  /** Distance from a point to the nearest node, in metres.
   *
   * The nearest, not the head: the animal is 45 m long, so its far end can be
   * eighty metres away while a coil of it is twenty metres from your face.
   * Asking about one end would move it out from under the player. */
  nearestNode(p) {
    if (!this.chain) return Infinity;
    const c = this.chain.pos;
    let best = Infinity;
    for (let i = 0; i < NODES; i++) {
      const dx = c[i * 3] - p.x, dy = c[i * 3 + 1] - p.y, dz = c[i * 3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  /* Its path, and it is a function of nothing but time. No player term appears
   * here on purpose: the moment a drifter reacts to you it becomes a hunter,
   * and the roster already has one of those. */
  _path(t, out) {
    return out.set(
      Math.sin(t * 0.21) * 26 + Math.sin(t * 0.083) * 11,
      Math.sin(t * 0.13) * 3.4,
      Math.cos(t * 0.17) * 24 + Math.cos(t * 0.061) * 13,
    );
  }

  /** Place it once, and build the chain there.
   *
   * Birth is pushed out past the photophore range, so the colony always enters
   * the world as a light at the very edge of legibility rather than
   * materialising in open view — the reveal grammar enforced by construction
   * instead of by hoping the path never wanders close. */
  _spawn(swimmer) {
    this._seed = swimmer.clone();
    this._path(this.t, this.anchor).add(this._seed);
    const away = this.anchor.clone().sub(swimmer);
    const want = BIOLUM_RANGE + 8;
    if (away.length() < want) {
      this._seed.addScaledVector(away.normalize(), want - away.length());
      this._path(this.t, this.anchor).add(this._seed);
    }
    this.chain = new VerletChain(NODES, NODE_SPACING,
      [this.anchor.x, this.anchor.y, this.anchor.z], [0, -0.15, -0.99]);
  }

  update(dt, { swimmer, outside, depth }) {
    /* Range gates the SPAWN, not the encounter. Before the chain exists the
     * question is "may it appear" and the answer includes distance — that is
     * what colonyPresence's range term is for, and _spawn guarantees the value
     * passed here. Once it exists, swimming toward it must resolve the body,
     * not delete it: an animal that vanishes when approached is a ghost, and
     * the design asks for an animal that does not care. */
    const presence = colonyPresence({
      outside, depth, range: this.chain ? Infinity : BIOLUM_RANGE + 8,
    });
    const u = this.material.uniforms;
    /* Slow both ways. The mimic fades in over 1.8 s because it is arriving;
     * this one takes 6 s because a thing that never approaches should also
     * never appear — you notice it has been there. */
    u.uReveal.value += (presence - u.uReveal.value) * (1 - Math.exp(-dt / 6.0));
    /* Both terms, and the first one is the sanctuary rule.
     *
     * Gating visibility on the *decayed* reveal alone let the colony keep
     * drawing for the ~26 s it takes a 6 s exponential to fall under the
     * threshold — and `presence` goes to zero the instant the player is inside
     * the hull, so those 26 seconds are spent rendering a 45 m animal through
     * the bow port of the room that is supposed to be safe. `colonyPresence`'s
     * own docstring says "inside the hull you are safe and it is not drawn";
     * this is the line that has to enforce it, and it did not.
     *
     * `creatures.js` had it right already: the mimic keys `root.visible` off
     * presence and lets uReveal handle only the alpha. Two creatures, one
     * pattern — the second copy was written from memory instead of from the
     * first, which is how they came to disagree.
     *
     * Measured in the review set: `C-fwd` (looking forward through the port)
     * read 188.6 with the colony bleeding through against 184.2 without it,
     * and flipped between the two depending on whether an outdoor pose had
     * been shot before it. A frame whose brightness depends on the previous
     * frame is not a frame you can review. */
    this.root.visible = presence > 0.012 && u.uReveal.value > 0.012;
    if (!this.root.visible) return;

    /* Let go of a colony that has been left behind, so the next one can be born
     * within reach. Its path is bounded at ~37 m from where it spawned, so
     * without this the animal belongs permanently to the first patch of water
     * the player ever swam in — take the boat anywhere else and the creature is
     * simply not in the game. See RESEED_RANGE for why this cannot be seen. */
    if (this.chain && this.nearestNode(swimmer) > RESEED_RANGE) this.chain = null;
    if (!this.chain) this._spawn(swimmer);

    this.t += dt * DRIFT_SPEED;
    this._path(this.t, this.anchor).add(this._seed);
    this.chain.update(dt, [this.anchor.x, this.anchor.y, this.anchor.z]);

    const nodes = u.uNodes.value;
    for (let i = 0; i < NODES; i++) {
      nodes[i].set(this.chain.pos[i * 3], this.chain.pos[i * 3 + 1], this.chain.pos[i * 3 + 2]);
    }
    u.uTime.value += dt;
  }
}
