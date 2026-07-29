import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { Welder } from './structures.js';
import { loftInto, fairStations } from './loft.js';
import { seabedHeight } from './terrain.js';
import {
  I, HULL_LEN, HULL_R, DECK_Y, DECK_HALF, EYE, HELM, shellX,
  Fit, buildDecalAtlas, deckhead, sternMachinery, midAccommodation, bowHelm, ring, placardOn,
} from './fitout.js';

/* A submersible you walk around inside.
 *
 * The previous cockpit was a shell glued to the camera — correct as a windscreen,
 * useless as a place. You could not leave the seat, so the vehicle had no
 * interior, only a frame around the view.
 *
 * This is a volume: eighteen metres of pressure hull with a deck through it,
 * three compartments, and a helm at the bow. That distinction is the whole
 * reason SOMA's stations work. A cockpit tells you that you are piloting. Rooms
 * tell you that you are somewhere — and somewhere is what you can be trapped in.
 *
 * Built inside-out with the loft's flip option, so the skin's normals face the
 * cabin and the interior lamps light the room rather than the ocean.
 *
 * Local space: Z runs bow-positive along the hull, Y up from the hull axis, deck
 * at DECK_Y. World placement is a pure translation, which keeps the walking
 * collision arithmetic in the hull's own frame with no matrices involved.
 *
 * ---------------------------------------------------------------------------
 * This file is the hull. src/fitout.js is everything inside it.
 *
 * The split is not tidiness. The standing complaint was that the compartments
 * read as large flat planes, and that has two independent causes which were
 * being confused with each other:
 *
 *   1. nothing in the volume — no objects at conversational distance
 *   2. nothing on the surface — the shader had no normal perturbation at all
 *
 * Cause 2 was invisible while reading the code because the material *looks*
 * detailed: three noise bands in the albedo. But albedo without relief is a
 * printed texture, and the seabed and boulder shaders had both had proper
 * distance-faded bump for months while the room the player stands in had none.
 * A painted steel plate lit by a lamp two metres away is almost entirely
 * shading, so a plate with a constant normal is a flat grey field however it is
 * coloured.
 */

// Re-exported so callers keep importing hull facts from the hull module.
export { HULL_LEN, HULL_R, DECK_Y, DECK_HALF, EYE, HELM };

/** Interior half-width available at a given z and height — the walkable envelope. */
export function hullHalfWidth(z, y) {
  return Math.min(DECK_HALF, shellX(z, y));
}

/* Collision, cached from the build.
 *
 * The furniture and its boxes are emitted by the same calls now, so the list
 * cannot be assembled independently of the geometry — which is exactly what
 * used to go wrong. Anything asking for the solids before the boat is built is
 * asking a question that has no answer yet, and gets an empty room rather than
 * a stale one. */
let SOLIDS = [];
export function interiorSolids() { return SOLIDS; }

function interiorMaterial(atlas) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uPressure: { value: 1 },
      uAlarm: { value: 0 },
      uLamps: { value: 1 },
      uEye: { value: new THREE.Vector3() },   // camera in hull-local space
      uAtlas: { value: atlas },
      uDebug: { value: 0 },
      // Live vessel state, one scalar per dial. See the GAUGE branch.
      uWay: { value: 0 },
      uDepth: { value: 0 },
      uHeading: { value: 0 },
      uBallast: { value: 0.5 },
      uTrim: { value: 0 },
      uAir: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute float aMat; attribute float aWear; attribute vec2 aUV; attribute vec2 aExt;
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear;
      varying vec2 vUV; varying vec2 vExt;
      void main(){
        vP = position; vN = normalize(normal);
        vMat = aMat; vWear = aWear; vUV = aUV; vExt = aExt;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear;
      varying vec2 vUV; varying vec2 vExt;
      uniform float uTime, uPressure, uAlarm, uLamps;
      uniform vec3 uEye;
      uniform sampler2D uAtlas;
      uniform float uDebug;
      uniform float uWay, uHeading, uBallast, uTrim, uAir, uDepth;

      const float PI = 3.14159265;

      /* Distance bands, and they are anti-aliasing rather than optimisation.
       *
       * A 2 mm weld ripple seen from eight metres is a hundredth of a pixel. Left
       * in, it does not render as fine detail — it renders as crawling static,
       * because neighbouring pixels sample uncorrelated points of the same field.
       * Every band below has to be gone before it reaches that distance, which is
       * the same rule the seabed shader follows and for the same reason. */
      float gFine, gMicro, gMid, gPU, gPV;

      /* Weld bead: a Gaussian ridge with the pass ripple laid along it.
       *
       * A weld is not a smooth fillet. It is a row of overlapping puddles left by
       * a moving arc, roughly 8 mm apart, and that periodicity is how the eye
       * identifies it as welded rather than as a moulded seam. One sine. */
      float weld(float d, float w, float ripple){
        float t = d / w;
        return exp(-t*t) * (0.82 + 0.18*ripple);
      }

      /* Height field, in metres, on whichever surface this fragment belongs to.
       *
       * Everything here is between 0.3 mm and 10 mm. Larger than that is modelled
       * as geometry in fitout.js; smaller than that never survives the distance
       * fade. The band exists because at the range a player stands from a
       * bulkhead — one to three metres — a 12 mm feature is nine pixels across,
       * which is far too big to leave out and far too small to build. */
      float heightAt(vec2 p){
        float m = vMat;

        if (m < 0.5) {
          /* Pressure-hull plate. Twelve strakes around, butts every 1.575 m.
           *
           * Twelve because the lattice must divide the loft's own u range
           * exactly, or there is a visible seam down one side of the boat where
           * the parameterisation wraps. Metric widths come from the local
           * circumference, so the bead stays 11 mm wide where the hull tapers
           * instead of shrinking with the parameter. */
          vec2 cuv = vec2(fract(p.x / max(gPU, 1e-3)), fract(p.y / gPV));
          float du = min(cuv.x, 1.0 - cuv.x) * gPU;
          float dv = min(cuv.y, 1.0 - cuv.y) * gPV;
          float h = 0.0;
          h += 0.0052 * weld(du, 0.016, sin(p.y * 620.0));
          h += 0.0048 * weld(dv, 0.017, sin(p.x * 620.0));
          /* Oil-canning: every panel dishes slightly between its welds.
           *
           * Thin plate welded on all four edges cannot stay flat — it buckles a
           * millimetre or two inward as the welds cool and shrink. This is the
           * detail that separates a fabricated steel box from an extruded one,
           * and at 1.3 mm over a 1.2 m bay it is invisible as a shape and
           * unmistakable as a slow shading gradient. */
          /* Four and a half millimetres, not one and a half.
           *
           * The first value was the physically honest one and it was invisible:
           * 1.4 mm across a 0.6 m half-panel is a slope of 0.0023, which is an
           * eighth of a degree, which changes the diffuse response by nothing at
           * all. The debug height view showed the dishing perfectly and the lit
           * frame showed a flat wall — the field was right and the amplitude was
           * two orders of magnitude below the threshold of the shading model.
           *
           * A real hull shows its oil-canning through specular reflection of a
           * bright environment, and there is no bright environment 420 m down.
           * With only a diffuse lamp to reveal it, the deformation has to be
           * exaggerated to about a degree before the eye gets anything. This is
           * a deliberate lie in service of a true impression, and it is the only
           * one in the file. */
          h -= 0.0045 * sin(PI * cuv.x) * sin(PI * cuv.y);
          h += 0.0011 * (fbm(p * 6.0, 2) - 0.5) * gFine;
          h += 0.00040 * (vnoise(p * 58.0) - 0.5) * gMicro;
          return h;
        }

        if (m < 1.5) {
          /* Bar grating. The slots are 9 mm deep, which is the entire reason a
           * deck reads as something you could drop a spanner through. */
          float bx = abs(fract(p.x * 22.0) - 0.5) * 2.0;
          float rz = abs(fract(p.y * 4.0) - 0.5) * 2.0;
          float bar = smoothstep(0.26, 0.52, bx);
          float rod = smoothstep(0.80, 0.94, rz);
          float h = -0.0090 * (1.0 - max(bar, rod));
          h += 0.0016 * rod;
          h += 0.00035 * (vnoise(p * 70.0) - 0.5) * gMicro;
          return h;
        }

        if (m < 2.5) {
          // Pipework and fittings: mill scale, pitting, a little corrosion bloom.
          float h = 0.0010 * (fbm(p * 14.0, 2) - 0.5) * gFine;
          h -= 0.0016 * smoothstep(0.72, 0.95, fbm(p * 5.0 + 3.1, 3)) * vWear * gFine;
          h += 0.00030 * (vnoise(p * 90.0) - 0.5) * gMicro;
          return h;
        }

        if (m > 4.5 && m < 5.5) {
          /* Painted cases. Everything keys off distance to the rim, which is the
           * whole reason the Welder now carries the face's half-extents: damage
           * is positional, and its position is the edge. Chips written with noise
           * alone appear in the middle of panels, where nothing has ever hit.
           *
           * A negative half-extent means that axis wraps — a cylinder has no rim
           * going round it — so that direction is reported as infinitely far
           * from an edge instead of always at one. */
          float ex = vExt.x < 0.0 ? 1e3 : vExt.x - abs(p.x);
          float ey = vExt.y < 0.0 ? 1e3 : vExt.y - abs(p.y);
          float edge = min(ex, ey);
          float h = 0.0;
          h -= 0.0038 * (1.0 - smoothstep(0.0, 0.007, edge));           // chamfer
          h += 0.0020 * (1.0 - smoothstep(0.026, 0.040, edge));         // rim bead
          // Fasteners in a band around the rim, at 90 mm pitch.
          vec2 bp = fract(p / 0.090) - 0.5;
          float bd = length(bp) * 0.090;
          float inBand = step(0.010, edge) * (1.0 - smoothstep(0.030, 0.044, edge));
          h += 0.0022 * (1.0 - smoothstep(0.004, 0.0075, bd)) * inBand;
          h += 0.00055 * (fbm(p * 30.0, 2) - 0.5) * gFine;
          return h;
        }

        if (m > 5.5 && m < 6.5) {
          // Bulkhead plate: a rectangular chart, otherwise the same fabrication.
          vec2 cuv = fract(p / 1.15);
          float du = min(cuv.x, 1.0 - cuv.x) * 1.15;
          float dv = min(cuv.y, 1.0 - cuv.y) * 1.15;
          float h = 0.0030 * weld(du, 0.011, sin(p.y * 760.0));
          h += 0.0030 * weld(dv, 0.012, sin(p.x * 760.0));
          h -= 0.0013 * sin(PI * cuv.x) * sin(PI * cuv.y);
          h += 0.0010 * (fbm(p * 6.0, 2) - 0.5) * gFine;
          return h;
        }

        if (m > 6.5 && m < 7.5) {
          // Soft goods: a coarse weave and slow folds. No hard edges anywhere.
          float h = 0.0026 * (fbm(p * 9.0, 3) - 0.5);
          h += 0.0009 * (vnoise(p * 46.0) - 0.5) * gFine;
          return h;
        }

        if (m > 10.5) {
          // Brass: soft, so it dents rather than chips, and it polishes bright.
          return 0.0007 * (fbm(p * 22.0, 2) - 0.5) * gFine;
        }

        return 0.0;
      }

      /* Point source inside the hull.
       *
       * Twenty-two, not 2.4, and the factor of ten is not a fudge: these are
       * cabin lamps competing with an exposure the ocean sets. At four hundred
       * metres the auto-exposure opens to roughly 1.9, tuned for a lamp pool
       * outside. An interior lit to a physically sensible 0.05 lands below the
       * tone curve's toe and comes out the same near-black as the water. */
      vec3 lampAt(vec3 lp, vec3 col, float pw, vec3 alb, vec3 n, vec3 V, float gloss){
        vec3 d = lp - vP;
        float dd = length(d);
        vec3 L = d / max(dd, 1e-4);
        float ndl = max(dot(n, L), 0.0) * 0.72 + 0.28;
        float fall = pw / (0.85 + dd*dd);
        vec3 o = alb * col * ndl * fall;
        /* One specular lobe, and it is not decoration.
         *
         * Every metal object in here was Lambertian, which is the same BRDF as
         * chalk. A handrail with no highlight cannot be told from a painted rod,
         * and the whole point of a brass valve wheel is that it catches the lamp.
         * Blinn-Phong is wrong in the ways that do not matter at this distance. */
        if (gloss > 1.0) {
          vec3 H = normalize(L + V);
          o += col * pow(max(dot(n, H), 0.0), gloss) * fall * (gloss * 0.0016);
        }
        return o;
      }

      void main(){
        float dist = length(uEye - vP);
        gFine  = exp(-dist * 0.34);
        gMid   = exp(-dist * 0.13);
        gMicro = exp(-dist * 1.05);

        /* Surface chart: a 2D coordinate in metres, plus the frame it lives in.
         *
         * There is no tangent attribute and there does not need to be. Every
         * surface in this hull is one of three analytic kinds — a cylinder about
         * Z, an axis-aligned box face, or the deck — and for each of them the
         * tangent frame is known exactly. Deriving normals from screen-space
         * derivatives instead would look right in a screenshot and fall apart
         * under a grazing lamp, which is the only light down here. */
        vec2 q; vec3 T, B;
        float m = vMat;

        if (m < 0.5) {
          // Cylindrical: 12 strakes around whatever the local circumference is.
          float rr = max(length(vP.xy), 0.35);
          float circ = 6.2831853 * rr;
          gPU = circ / 12.0;
          gPV = 1.575;
          q  = vec2(vUV.x * 2.0 * gPU, vUV.y);
          vec3 rd = normalize(vec3(vP.xy, 0.0));
          T = vec3(-rd.y, rd.x, 0.0);
          B = vec3(0.0, 0.0, 1.0);
        } else if (m < 1.5) {
          q = vUV; T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 0.0, 1.0);
        } else if (m > 5.5 && m < 6.5) {
          q = vUV; T = vec3(1.0, 0.0, 0.0); B = vec3(0.0, 1.0, 0.0);
        } else {
          /* Box faces and tubes: the two axes the face actually spans, matching
           * the Welder's own uvOf exactly. Guessing here rather than mirroring it
           * is how bar grating ends up running across a walkway instead of along
           * it — the same bug this convention was introduced to fix. */
          vec3 an = abs(vN);
          q = vUV;
          if (an.y > 0.5)      { T = vec3(1.0,0.0,0.0); B = vec3(0.0,0.0,1.0); }
          else if (an.x > 0.5) { T = vec3(0.0,0.0,1.0); B = vec3(0.0,1.0,0.0); }
          else                 { T = vec3(1.0,0.0,0.0); B = vec3(0.0,1.0,0.0); }
        }

        // Perturb. Analytic differences in surface space, faded with distance.
        float e = 0.0035;
        float h0 = heightAt(q);
        float hu = heightAt(q + vec2(e, 0.0));
        float hv = heightAt(q + vec2(0.0, e));
        /* Strength is 1.0 at full effect, and that is not a taste setting.
         *
         * (h(u+e) - h(u)) / e IS the surface gradient when h and u are both in
         * metres, so multiplying it by one gives the true tilt: a 3.3 mm weld
         * bead over an 11 mm flank is a slope of 0.30, which is seventeen
         * degrees. The first version carried an extra 0.01 that left it at 0.19
         * of that — three degrees — and three degrees of normal tilt under a
         * diffuse lamp is invisible. The whole relief pass rendered as a
         * perfectly smooth wall, which read as the pass not working at all.
         *
         * Faded toward 0.22 with distance, because a 17-degree facet 3 mm wide
         * is aliasing once it is under a pixel. */
        float bumpK = 0.26 + 1.40 * gMid;
        vec3 n = normalize(vN - (T * (hu - h0) + B * (hv - h0)) * (bumpK / e));
        vec3 V = normalize(uEye - vP);

        vec3 col; float emis = 0.0; float gloss = 0.0;

        if (m < 0.5) {
          /* Painted hull plate. Condensation and rust streaks run downward,
           * because water condenses on cold steel and runs — which is also the
           * cheapest way to tell the eye which way is up in a curved room. */
          float grime = fbm(vUV * vec2(3.0, 9.0), 3);
          vec3 paint = vec3(0.100, 0.106, 0.102);
          vec3 rust  = vec3(0.118, 0.070, 0.044);
          float low = smoothstep(0.6, -0.6, vP.y);
          col = mix(paint, rust, smoothstep(0.52, 0.88, grime) * (0.35 + 0.55*low));
          col *= 0.86 + 0.28 * fbm(vUV * 24.0, 2) * gFine;
          /* Plate-by-plate tonal variation, and it is the cheapest flatness
           * breaker in the file.
           *
           * A hull is not one surface, it is sixty plates rolled from several
           * batches and painted by several people over several years. Giving
           * each strake bay its own tone puts a visible boundary at every weld
           * whether or not the relief is resolvable at that distance, which
           * means the wall reads as fabricated even across a room. One hash. */
          vec2 bay = floor(vec2(vUV.x * 2.0, vUV.y / 1.575));
          float batch = hash12(bay * 3.7);
          col *= 0.82 + 0.36 * batch;
          // The weld itself: proud, unpainted, and darker than the paint round it.
          float seam = smoothstep(0.0010, 0.0042, h0);
          col = mix(col, col * 0.58 + vec3(0.016, 0.015, 0.014), seam);
          /* Hand height, and this is the most human mark in the boat.
           *
           * Everyone who walks a moving hull braces on the wall at roughly the
           * same height, so the paint there is polished to bare metal in a band
           * about half a metre wide. It costs one smoothstep on world Y and it
           * is the only thing in the fit-out that records the crew's bodies
           * rather than their possessions. */
          float hand = exp(-pow((vP.y - 0.10) / 0.30, 2.0));
          float rub = hand * smoothstep(0.42, 0.78, fbm(vUV * vec2(1.4, 3.0) + 7.7, 3));
          col = mix(col, vec3(0.150, 0.152, 0.147), rub * 0.55);
          gloss = 14.0 + 40.0 * rub;
          // Condensation beads, only close enough to resolve them.
          float bead = smoothstep(0.90, 0.99, vnoise(vUV * vec2(30.0, 90.0)));
          col += vec3(0.020, 0.024, 0.026) * bead * gMicro;

        } else if (m < 1.5) {
          /* Deck grating, in deck coordinates.
           *
           * Directional, and running fore-and-aft the way a real deck is laid, so
           * walking along the boat reads as travelling over a surface rather than
           * sliding across a texture. */
          /* Parallax, and it is what turns painted stripes into holes.
           *
           * The slots were 9 mm deep in the height field and completely flat in
           * the albedo, so from a standing eye the deck read as a striped
           * surface rather than as something you could drop a spanner through.
           * Offsetting the lookup along the view direction by the slot depth is
           * the cheapest possible parallax — one madd — and because the eye
           * position is already in hull space here it costs nothing to set up. */
          vec3 vd = normalize(vP - uEye);
          vec2 par = vd.xz / max(-vd.y, 0.25) * 0.010;
          float slot = abs(fract((vUV.x + par.x) * 22.0) - 0.5) * 2.0;
          float rod  = abs(fract((vUV.y + par.y) * 4.0) - 0.5) * 2.0;
          float solid = max(smoothstep(0.30,0.60,slot), smoothstep(0.82,0.95,rod));
          /* Fade the slots toward the mean with distance.
           *
           * 22 bars per metre seen down a deck at a grazing angle puts the
           * period well under a pixel four metres away, and an unfiltered
           * periodic pattern under a pixel does not average out — it beats
           * against the sample grid and renders as rows of crawling dashes.
           * That artefact is exactly what the seabed shader's distance bands
           * exist to prevent, and the deck had none of them.
           *
           * Grazing angle matters as much as distance: it is the foreshortening
           * that compresses the period, so the fade keys off both. */
          float graze = clamp(abs(normalize(uEye - vP).y), 0.05, 1.0);
          float legible = clamp(graze * 3.4 * exp(-dist * 0.16), 0.0, 1.0);
          solid = mix(0.62, solid, legible);
          col = vec3(0.072, 0.076, 0.074) * (0.22 + 0.95 * solid);
          // Wear polish down the centreline: this is where everyone walks.
          float walk = exp(-abs(vP.x) * 1.6);
          col *= 1.0 + 0.55 * walk * gFine;
          gloss = 8.0 + 46.0 * walk;

        } else if (m < 2.5) {
          col = vec3(0.118, 0.120, 0.124) * (0.82 + 0.40 * fbm(vUV * 8.0, 2));
          // Corrosion where the wear attribute says this fitting has been left.
          float ox = smoothstep(0.66, 0.94, fbm(vUV * 5.0 + 3.1, 3)) * vWear;
          col = mix(col, vec3(0.110, 0.062, 0.038), ox * 0.55);
          gloss = mix(70.0, 10.0, vWear);

        } else if (m > 2.5 && m < 3.5) {
          /* Instrument face. Six dials, six different quantities.
           *
           * Every gauge in the boat used to read uPressure, so the machinery
           * space had three identical needles at an identical angle and the
           * helm had three more. Six instruments agreeing perfectly is not
           * redundancy, it is a statement that none of them is connected to
           * anything — and a player reads that instantly even if they could not
           * say why. The wear attribute is meaningless on a glass dial, so it
           * carries the type. */
          vec2 g = vUV * 2.0 - 1.0;
          if (length(g) > 1.0) discard;
          int gt = int(vWear * 8.0 + 0.5);
          float frac = 0.0;
          bool compass = false;
          if (gt == 0)      frac = clamp(uPressure / 620.0, 0.0, 1.05);   // sea pressure
          else if (gt == 1) frac = clamp(uDepth / 1200.0, 0.0, 1.05);        // depth
          else if (gt == 2) frac = clamp(uBallast, 0.0, 1.0);             // tank state
          else if (gt == 3) { frac = fract(uHeading / 360.0); compass = true; }
          else if (gt == 4) frac = clamp(uTrim * 0.5 + 0.5, 0.0, 1.0);    // rate of change of depth
          else              frac = clamp((uWay + 1.5) / 6.5, 0.0, 1.05);  // way through the water

          col = vec3(0.028, 0.032, 0.034);
          float ang = atan(g.y, g.x), r = length(g);
          float nDiv = compass ? 36.0 : 24.0;
          float ticks = abs(fract((ang + 3.14159)/6.2832 * nDiv) - 0.5) * 2.0;
          col += vec3(0.28,0.32,0.31) * smoothstep(0.86,0.98,ticks) * smoothstep(0.62,0.72,r) * (1.0-smoothstep(0.88,0.96,r));
          /* A compass reads all the way round; everything else sweeps 270
           * degrees between two stops, because a dial with a dead sector tells
           * you at a glance which way is "more". */
          float na = compass ? (1.5708 - frac * 6.2832) : (-2.356 + frac * 4.712);
          vec2 nd = vec2(cos(na), sin(na));
          float across = abs(g.x*nd.y - g.y*nd.x), along = dot(g, nd);
          float needle = (along > -0.06 && along < 0.82) ? smoothstep(0.055,0.012,across) : 0.0;
          vec3 nCol = compass ? vec3(0.92,0.36,0.22)
                              : mix(vec3(0.85,0.86,0.82), vec3(1.0,0.28,0.16), smoothstep(0.72,1.0,frac));
          col += nCol * needle * 1.6;
          // A red arc over the last fifth of the scale on the pressure dial.
          if (gt == 0) {
            float redA = smoothstep(0.80, 0.82, (ang + 2.356) / 4.712);
            col += vec3(0.35,0.05,0.03) * redA * smoothstep(0.74,0.80,r) * (1.0-smoothstep(0.86,0.92,r));
          }
          emis = 0.9;

        } else if (m > 3.5 && m < 4.5) {
          // The bow port, from the inside: mostly clear, scuffed at the rim.
          col = vec3(0.030, 0.052, 0.050) * (0.6 + 0.8 * fbm(vUV * 22.0, 3));
          emis = 0.05;
          gloss = 160.0;

        } else if (m < 5.5) {
          /* Equipment cases: painted, chipped along every edge people knock —
           * and now actually along the edges, because the rim distance is known
           * rather than approximated with a noise field. */
          float edge = min(vExt.x < 0.0 ? 1e3 : vExt.x - abs(vUV.x),
                           vExt.y < 0.0 ? 1e3 : vExt.y - abs(vUV.y));
          float chip = fbm(vUV * 7.0, 3);
          col = mix(vec3(0.088, 0.096, 0.092), vec3(0.130, 0.126, 0.112), smoothstep(0.55,0.85,chip));
          float worn = (1.0 - smoothstep(0.0, 0.020, edge)) * smoothstep(0.35, 0.75, fbm(vUV * 16.0 + 2.3, 3));
          col = mix(col, vec3(0.146, 0.140, 0.128), worn * 0.85 * vWear);   // bare metal
          col = mix(col, vec3(0.101, 0.058, 0.036), smoothstep(0.62, 0.92, chip) * vWear * 0.45);
          gloss = 22.0 + 60.0 * worn;

        } else if (m < 6.5) {
          // Bulkhead plate: the same paint and the same fabrication, flat chart.
          float grime = fbm(vUV * vec2(4.0, 7.0), 3);
          /* Rust pulled back from 0.55 to 0.34.
           *
           * At the old weight the bulkhead came out pink — the rust term and
           * the plate-batch term multiply, so adding tonal variation on top of
           * a heavy oxide tint pushed whole panels into salmon. Two effects that
           * were each reasonable alone. */
          col = mix(vec3(0.096, 0.102, 0.098), vec3(0.108, 0.066, 0.044),
                    smoothstep(0.55, 0.90, grime) * 0.34);
          vec2 bbay = floor(vUV / 1.15);
          col *= 0.80 + 0.38 * hash12(bbay * 5.1 + 19.0);
          float bseam = smoothstep(0.0010, 0.0040, h0);
          col = mix(col, col * 0.58 + vec3(0.015, 0.014, 0.013), bseam);
          /* Boot scuff along the bottom half metre.
           *
           * Everyone steps over the coaming and everyone catches the plate on
           * the way through, so the paint below knee height on a bulkhead is
           * always the most damaged surface in a vessel. It also does something
           * a weld cannot: it puts a horizontal at a known height, which gives
           * a two-metre disc of steel a floor and therefore a scale. */
          float scuff = smoothstep(${(DECK_Y + 0.55).toFixed(3)}, ${DECK_Y.toFixed(3)}, vUV.y)
                      * smoothstep(0.40, 0.78, fbm(vUV * vec2(9.0, 3.0) + 4.4, 3));
          col = mix(col, vec3(0.132, 0.126, 0.116), scuff * 0.55);
          gloss = 14.0 + 30.0 * scuff;

        } else if (m < 7.5) {
          /* Soft goods. Matte, warmer than anything else aboard, and the only
           * surfaces in the boat with no specular at all — which is exactly how
           * the eye separates cloth from painted steel under one hard lamp. */
          float weave = fbm(vUV * 40.0, 2);
          vec3 canvas = vec3(0.128, 0.118, 0.096);
          vec3 wool   = vec3(0.086, 0.082, 0.078);
          col = mix(canvas, wool, vWear);
          col *= 0.82 + 0.34 * weave * gFine;
          col *= 0.88 + 0.24 * fbm(vUV * 6.0, 3);
          gloss = 0.0;

        } else if (m < 8.5) {
          /* Sonar. The only moving light in the boat, and the only thing aboard
           * that reports the world outside without a window.
           *
           * The sweep decays behind the head rather than being a spinning line,
           * because that is what a phosphor does and because the decay is what
           * makes returns linger and fade — which is the entire visual grammar of
           * "something is out there and I saw it a second ago". */
          float r = length(vUV);
          if (r > 1.0) discard;
          vec3 phos = vec3(0.16, 1.0, 0.34);
          col = vec3(0.008, 0.028, 0.014);
          float a = atan(vUV.y, vUV.x);
          float sweep = uTime * 1.15;
          float rel = mod(sweep - a, 6.2831853);
          col += phos * 0.55 * exp(-rel * 2.6);                        // decaying tail
          col += phos * 1.30 * smoothstep(0.10, 0.0, rel);             // the head
          // Range rings and the bearing cross.
          float rings = abs(fract(r * 4.0) - 0.5) * 2.0;
          col += phos * 0.16 * smoothstep(0.90, 1.0, rings);
          col += phos * 0.13 * (smoothstep(0.988, 1.0, abs(cos(a))) + smoothstep(0.988, 1.0, abs(sin(a))));
          /* Three returns. Two are the canyon walls, which is why they sit at
           * fixed bearings; the third is not, and it moves. Nothing in the game
           * ever explains it. */
          for (int k = 0; k < 3; k++) {
            float fk = float(k);
            float ba = fk * 2.1 + 0.6 + (k == 2 ? sin(uTime * 0.11) * 0.9 : 0.0);
            float br = 0.34 + fk * 0.21 + (k == 2 ? sin(uTime * 0.07) * 0.08 : 0.0);
            vec2 bp = vec2(cos(ba), sin(ba)) * br;
            float d = length(vUV - bp);
            float age = exp(-mod(sweep - ba, 6.2831853) * 1.5);
            col += phos * (k == 2 ? 1.5 : 1.0) * age * exp(-pow(d / 0.055, 2.0));
          }
          col *= 0.72 + 0.28 * fbm(vUV * 30.0 + uTime * 3.0, 2);       // scan noise
          emis = 3.4;

        } else if (m < 9.5) {
          /* Switchboards. Rows of breakers and a strip of indicator lamps.
           *
           * One of them is amber and one is dead, and that asymmetry is doing
           * almost all of the work: a wall of identical green lamps is wallpaper,
           * whereas four green, one amber and one out is a machine reporting a
           * state — in a room with nobody in it to have caused it. */
          vec2 g = vUV;
          col = vec3(0.070, 0.074, 0.076);
          /* Breaker toggles on a lattice, faded with distance.
           *
           * Thirty toggles across a 0.9 m panel is a 3 cm period; seen down the
           * length of the compartment at a grazing angle that is well under a
           * pixel, and an unfiltered periodic pattern under a pixel does not
           * average — it beats against the sample grid. The switchboard read as
           * a flat bright dotted rectangle from six metres away while being
           * perfectly correct from one. Exactly the artefact the deck grating
           * had, in exactly the same shape, and the same one-line answer. */
          float pFade = clamp(3.2 * exp(-length(uEye - vP) * 0.28), 0.0, 1.0);
          vec2 bc = fract(g * vec2(6.0, 5.0)) - 0.5;
          float body = (1.0 - smoothstep(0.24, 0.30, abs(bc.x))) * (1.0 - smoothstep(0.16, 0.22, abs(bc.y)));
          body = mix(0.42, body, pFade);
          col = mix(col, vec3(0.115, 0.118, 0.112), body);
          float lever = (1.0 - smoothstep(0.05, 0.08, abs(bc.x))) * (1.0 - smoothstep(0.07, 0.11, abs(bc.y - 0.03)));
          col = mix(col, vec3(0.030, 0.032, 0.030), lever * body * pFade);
          gloss = 26.0;
          // Indicator row along the bottom eighth of the panel.
          float lampRow = 1.0 - smoothstep(0.06, 0.10, abs(g.y - 0.075));
          float idx = floor(g.x * 8.0);
          vec2 lc = vec2(fract(g.x * 8.0) - 0.5, (g.y - 0.075) * 8.0);
          // The indicator row keeps its own, gentler fade: a lamp that vanishes
          // with distance is wrong, but a lamp that aliases is worse.
          float bulb = (1.0 - smoothstep(0.22, 0.30, length(lc)))
                     * clamp(1.6 * exp(-length(uEye - vP) * 0.13), 0.0, 1.0);
          float pick = hash11(idx * 3.7 + floor(g.y * 3.0) * 11.3);
          vec3 lampCol = pick > 0.80 ? vec3(1.0, 0.62, 0.10)
                       : pick < 0.14 ? vec3(0.10, 0.10, 0.10)
                                     : vec3(0.16, 1.0, 0.36);
          // One lamp is failing. It is not the amber one.
          float flick = pick > 0.62 && pick < 0.70
            ? step(0.35, fract(sin(floor(uTime * 9.0) * 12.9898) * 43758.5453)) : 1.0;
          col += lampCol * bulb * lampRow * 1.5 * flick;
          emis += 1.9 * bulb * lampRow * flick;

        } else if (m < 10.5) {
          /* Stencils, placards, the chart, the photograph.
           *
           * Sampled from a canvas drawn at boot. Text is why: the whole material
           * system here can produce convincing steel and cannot produce the word
           * BILGE, and a stencilled word is the cheapest object in the fit-out
           * that proves a person was here. Composited against the paint rather
           * than alpha-blended, because the scene pass has no blending — alpha
           * carries the interior flag. */
          vec4 t = texture2D(uAtlas, vUV);
          vec3 host = mix(vec3(0.100, 0.106, 0.102), vec3(0.118, 0.070, 0.044),
                          smoothstep(0.55, 0.90, fbm(vUV * 34.0, 3)) * 0.4);
          // Paint wears off a stencil unevenly; the thin bits go first.
          float keep = t.a * (0.55 + 0.55 * fbm(vUV * 46.0 + 1.7, 3));
          col = mix(host, t.rgb * 0.62, clamp(keep, 0.0, 1.0));
          gloss = 6.0;

        } else {
          /* Brass. The only warm metal aboard, and the reason it is here at all:
           * everything else is grey-green painted steel under one cold lamp, so
           * hue has nothing to separate. A handful of brass objects are the only
           * things in the boat that differ from their surroundings in colour
           * rather than in brightness — which is what stops a monochrome room
           * reading as a single moulded surface. */
          /* Scaled hard on u, because on a pipe u is arc length.
           *
           * A 28 mm brass line has a circumference of 88 mm, so fbm at nine times
           * u moved by 0.8 of a noise period all the way round it — effectively
           * constant across the tube and varying only along its length. The HP
           * air run therefore came out as flat yellow plastic with a few
           * lengthwise bands. Forty times on u gives the patina real variation
           * around the pipe, which is where a highlight needs something to
           * break against. */
          float tarnish = smoothstep(0.40, 0.86, fbm(vec2(vUV.x * 34.0, vUV.y * 7.0), 3));
          vec3 bright = vec3(0.42, 0.31, 0.13);
          vec3 dull   = vec3(0.140, 0.116, 0.070);
          col = mix(bright, dull, tarnish * (0.35 + 0.65 * vWear));
          // Polished where a hand grips: the high points keep their shine.
          col += vec3(0.10, 0.075, 0.030) * smoothstep(0.0002, 0.0008, h0) * gFine;
          /* Grazing-angle brightening. Polished metal at a glancing incidence
           * returns nearly everything, which is what puts the bright rim down
           * the side of a pipe and is most of what separates brass from paint
           * in a still frame. Two lines, no environment map. */
          float fres = pow(1.0 - clamp(abs(dot(normalize(vN), V)), 0.0, 1.0), 3.0);
          col += vec3(0.30, 0.23, 0.10) * fres * (1.0 - tarnish * 0.6);
          gloss = mix(180.0, 40.0, tarnish);
        }

        /* Three deckhead lamps down the centreline, plus the alarm.
         *
         * Spaced so there are pools of light and darkness between them. A room
         * lit evenly has no depth and nowhere to be afraid of; the gaps are the
         * point, and they are what makes an eighteen-metre hull feel long. */
        vec3 lit = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec3 lp = vec3(0.0, 1.55, -5.2 + float(i) * 5.6);
          lit += lampAt(lp, vec3(1.0, 0.88, 0.70), 6.2 * uLamps, col, n, V, gloss);
        }

        /* Local sources. Small, coloured, and each attached to a thing that is
         * actually modelled — a lamp with no visible fitting reads as a bug.
         * Their positions are constants because they are bolted to the boat. */
        lit += lampAt(vec3(-1.32, -0.05,  5.55), vec3(1.00, 0.70, 0.40), 0.62 * uLamps, col, n, V, gloss);
        lit += lampAt(vec3( 0.52, -0.18,  7.55), vec3(0.22, 1.00, 0.40), 0.34, col, n, V, gloss);
        lit += lampAt(vec3(-1.62,  0.22, -1.95), vec3(0.26, 1.00, 0.44), 0.26, col, n, V, gloss);
        lit += lampAt(vec3(-1.92,  0.05, -3.55), vec3(0.34, 1.00, 0.42), 0.24, col, n, V, gloss);
        lit += lampAt(vec3(-1.72, -0.10,  0.84), vec3(1.00, 0.76, 0.46), 0.30 * uLamps, col, n, V, gloss);

        vec3 rp = vec3(0.0, 1.35, 3.4);
        vec3 rd2 = rp - vP; float rdd = length(rd2);
        float rn = max(dot(n, rd2 / max(rdd,1e-4)), 0.0) * 0.7 + 0.3;
        float throb = 0.55 + 0.45 * sin(uTime * 2.1);
        lit += col * vec3(1.0, 0.09, 0.05) * uAlarm * throb * rn * (3.4 / (0.85 + rdd*rdd));

        /* A flat bounce term. Not physically motivated — it stands in for the light
         * that has bounced off the deck and the far wall, which nothing here
         * computes. Without it, every surface facing away from all three lamps is
         * pure black, and a steel tube lit by three point sources and nothing else
         * reads as a cave rather than a room.
         *
         * Weighted by the perturbed normal's upward component, so the underside of
         * every pipe and shelf stays darker than its top. Ambient applied flat is
         * what makes procedural interiors look like they are lit from inside the
         * geometry — it erases exactly the contact shading that says two objects
         * are touching. */
        float sky = 0.62 + 0.38 * n.y;
        lit += col * vec3(0.075, 0.080, 0.086) * sky;
        /* Crevice darkening from the height field, for free.
         *
         * Anything sitting below its local plane gets less of that bounce, which
         * is a one-line stand-in for ambient occlusion and does most of what one
         * would: weld roots go dark, grating slots go dark, and the chamfer round
         * every locker door reads as a shadow line rather than as a grey stripe. */
        lit *= 1.0 - 0.55 * smoothstep(0.0, -0.0035, h0) * (0.25 + 0.75 * gMid);
        lit += col * emis * 2.2;

        /* Diagnostics, and they earn their two branches.
         *
         * Whether the relief pass is working is not answerable by looking at a
         * lit frame: a weld bead is a nine-pixel band whose only effect is an
         * eleven per cent shading change, so "I cannot see it" is equally
         * consistent with a broken chart, a wrong sign, a factor-of-five error
         * in the strength, and with it being perfectly fine and simply subtle.
         * Four of those were true at various points this session. One uniform
         * answers the question in a single frame.
         *
         *   g.dbg(1)  height field, 1 mm per grey step
         *   g.dbg(2)  perturbed normal
         */
        if (uDebug > 0.5) {
          if (uDebug > 2.5) {
            /* Material id as a colour ramp. The probe the ledger asked for.
             *
             * "Which material is that" is not answerable by reasoning — three
             * subsystems in this project have looked guilty and been innocent.
             * One frame in this mode names it. Red counts the id in fours, green
             * the remainder, so 0-11 are all distinguishable by eye. */
            gl_FragColor = vec4(floor(vMat / 4.0) / 3.0, fract(vMat / 4.0), 0.35, 0.0);
            return;
          }
          gl_FragColor = uDebug < 1.5
            ? vec4(vec3(0.5 + h0 * 220.0), 0.0)
            : vec4(n * 0.5 + 0.5, 0.0);
          return;
        }
        gl_FragColor = vec4(lit, 0.0);   // alpha 0: interior is exempt from defocus
      }`,
  });
}

/** Deck plate with fore-and-aft grating, plus its side curbs. */
function deck(W) {
  const segs = 26;
  for (let i = 0; i < segs; i++) {
    const z0 = -HULL_LEN + (i / segs) * HULL_LEN * 2;
    const z1 = -HULL_LEN + ((i + 1) / segs) * HULL_LEN * 2;
    const w0 = hullHalfWidth(z0, DECK_Y), w1 = hullHalfWidth(z1, DECK_Y);
    if (w0 < 0.2 || w1 < 0.2) continue;
    const base = W.v;
    W._push(-w0, DECK_Y, z0, 0, 1, 0, I.DECK, 0.5, -w0, z0);
    W._push(w0, DECK_Y, z0, 0, 1, 0, I.DECK, 0.5, w0, z0);
    W._push(w1, DECK_Y, z1, 0, 1, 0, I.DECK, 0.5, w1, z1);
    W._push(-w1, DECK_Y, z1, 0, 1, 0, I.DECK, 0.5, -w1, z1);
    W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // Curbs where the deck meets the curve of the hull.
    for (const s of [-1, 1]) {
      W.box(s * (w0 + 0.04), DECK_Y + 0.09, (z0 + z1) / 2, 0.08, 0.18, (z1 - z0), 0, I.TRIM, 0.6);
    }
  }
}

/** Ring frame against the hull: the ribs a pressure hull is built around. */
function frame(W, z) {
  const seg = 34;
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(z) / HULL_LEN, 3.2))) - 0.03;
  for (let i = 0; i < seg; i++) {
    const a0 = -0.25 + (i / seg) * (Math.PI + 0.5);
    const a1 = -0.25 + ((i + 1) / seg) * (Math.PI + 0.5);
    W.tube(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z,
      0.055, 8, I.TRIM, 0.6);
  }
}

/** Bulkhead with a doorway: what makes three compartments out of one tube. */
function bulkhead(W, z, doorW = 0.82, doorH = 1.95) {
  const seg = 30;
  const r = HULL_R * Math.sqrt(Math.max(0.06, 1 - Math.pow(Math.abs(z) / HULL_LEN, 3.2)));
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    for (const [aa, bb] of [[a0, a1]]) {
      const p0 = [Math.cos(aa) * r, Math.sin(aa) * r];
      const p1 = [Math.cos(bb) * r, Math.sin(bb) * r];
      // Skip the wedge the doorway occupies.
      const inDoor = (p) => Math.abs(p[0]) < doorW / 2 && p[1] > DECK_Y && p[1] < DECK_Y + doorH;
      if (inDoor(p0) && inDoor(p1)) continue;
      const base = W.v;
      W._push(p0[0], p0[1], z, 0, 0, 1, I.BULK, 0.6, p0[0], p0[1]);
      W._push(p1[0], p1[1], z, 0, 0, 1, I.BULK, 0.6, p1[0], p1[1]);
      W._push(p1[0] * 0.30, Math.max(p1[1] * 0.30, DECK_Y + doorH), z, 0, 0, 1, I.BULK, 0.6, p1[0] * 0.3, Math.max(p1[1] * 0.3, DECK_Y + doorH));
      W._push(p0[0] * 0.30, Math.max(p0[1] * 0.30, DECK_Y + doorH), z, 0, 0, 1, I.BULK, 0.6, p0[0] * 0.3, Math.max(p0[1] * 0.3, DECK_Y + doorH));
      W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  // Door frame: the coaming you step over.
  W.box(0, DECK_Y + 0.09, z, doorW + 0.22, 0.18, 0.14, 0, I.TRIM, 0.7);
  W.box(0, DECK_Y + doorH, z, doorW + 0.22, 0.12, 0.14, 0, I.TRIM, 0.7);
  for (const s of [-1, 1]) {
    W.box(s * (doorW / 2 + 0.07), DECK_Y + doorH / 2, z, 0.12, doorH, 0.14, 0, I.TRIM, 0.7);
  }
  /* Vertical stiffeners, and this is the fix for the flattest frame in the set.
   *
   * A bulkhead is the one surface in the boat with no curvature and nothing on
   * it, and it is two metres from the eye when you look down the compartment —
   * so the shot straight forward came back as a pale rectangle with a doorway
   * drawn on it. Relief in the shader cannot rescue that: the problem is not
   * that the plate lacks texture, it is that the object lacks structure.
   *
   * Real bulkheads are stiffened, because a flat plate is the worst possible
   * shape for resisting a pressure differential and the whole point of the
   * thing is to hold one. T-bars on 0.55 m centres, stopping clear of the
   * doorway, are what the plate needs to exist at all — and they turn a blank
   * wall into a set of receding verticals that read the moment a lamp crosses
   * them. Structure first, then material. */
  /* Both faces, not one.
   *
   * The first attempt put them on the side facing away from midships, which is
   * defensible engineering and useless here: the player only ever approaches a
   * bulkhead from the inside of a compartment, so every stiffener was on the
   * face nobody can see and the frame came back as flat as before. Symmetry
   * costs eight boxes and means the wall has structure from whichever
   * compartment you are standing in. */
  for (const sd of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const bx = i * 0.55;
      if (Math.abs(bx) < doorW / 2 + 0.20) continue;
      const half = Math.sqrt(Math.max(0, r * r - bx * bx)) - 0.05;
      if (half < 0.25) continue;
      const face = z + sd * 0.09;
      W.box(bx, 0, face, 0.09, half * 2, 0.045, 0, I.TRIM, 0.6);                       // web
      W.box(bx, 0, face + sd * 0.05, 0.16, half * 2, 0.022, 0, I.TRIM, 0.6);           // flange
      W.box(bx, DECK_Y + 0.14, face, 0.16, 0.28, 0.10, 0, I.TRIM, 0.65);               // bracket foot
    }
    /* And something to look at beside the door on each side. A bulkhead is
     * where a crew pins things, because it is the only flat wall aboard. */
    placardOn(W, -1.30, DECK_Y + 1.05, z + sd * 0.13, sd, 'HAZARD', 0.24, 0.16);
    placardOn(W, 1.34, DECK_Y + 1.22, z + sd * 0.13, sd, 'PLATE', 0.20, 0.26);
    placardOn(W, 1.34, DECK_Y + 0.86, z + sd * 0.13, sd, 'VENT', 0.14, 0.11);
  }
  // Two pipe penetrations, because services have to get through a bulkhead.
  for (const [px, py] of [[-1.35, 0.95], [1.30, 0.72]]) {
    W.tube(px, py, z - 0.22, px, py, z + 0.22, 0.085, 12, I.TRIM, 0.6);
    for (const fz of [z - 0.14, z + 0.14]) {
      W.tube(px, py, fz - 0.02, px, py, fz + 0.02, 0.135, 14, I.TRIM, 0.55);
    }
  }

  /* Dogs around the coaming: the eight levers that clamp a watertight door.
   *
   * Not decoration. The door itself is not modelled — it is stowed open, which
   * is why you can walk through — but the dogs are what make the *opening* read
   * as something that can be shut, and a compartment that can be sealed is a
   * compartment that can be flooded. */
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dx = Math.cos(a) * (doorW / 2 + 0.16);
    const dy = DECK_Y + doorH / 2 + Math.sin(a) * (doorH / 2 + 0.10);
    W.box(dx, dy, z + 0.10, 0.05, 0.05, 0.09, 0, I.TRIM, 0.55);
    W.tube(dx, dy, z + 0.13, dx + Math.cos(a + 1.2) * 0.11, dy + Math.sin(a + 1.2) * 0.11, z + 0.13,
      0.017, 6, I.TRIM, 0.45);
  }
}

export function buildInterior() {
  const W = new Welder();
  const F = new Fit(W);
  const atlas = buildDecalAtlas();

  /* The pressure hull, inside out. Sections taper at both ends so the space
   * narrows toward the helm and the machinery, which is what stops an eighteen
   * metre tube reading as a corridor with no shape. */
  const control = [
    { z: -HULL_LEN - 0.4, w: 0.5, h: 0.5, sq: 2.0 },
    { z: -HULL_LEN + 1.6, w: 3.5, h: 3.4, sq: 2.4 },
    { z: -3.5, w: 4.66, h: 4.6, sq: 2.5 },
    { z: 2.0, w: 4.70, h: 4.66, sq: 2.4 },
    { z: 6.2, w: 4.10, h: 4.00, sq: 2.2 },
    /* The nose stops at the port instead of pinching past it.
     *
     * It used to run on to z = 9.5 and close to 0.4 m, and since the bow is left
     * uncapped so the helm can see out, *that* 40 cm pinhole was the view. The
     * acrylic ring at 0.92 m sat a metre behind it in the dark, framing nothing.
     * A player photographed the result: a small blown-out disc glowing in the
     * middle of a black wall, which is a porthole on a ship's side, not the
     * forward window a submersible's bow compartment exists for.
     *
     * Ending the loft at the port makes the opening the window: 1.95 m across,
     * which at the seated eye 1.6 m back fills 62 degrees — the whole frame. */
    { z: HULL_LEN - 0.55, w: 1.95, h: 1.90, sq: 1.9 },
  ];
  loftInto(W, fairStations(control, 46), {
    count: 54, mat: I.HULL, wear: 0.6, flip: true, capBow: false, capStern: false,
  });

  deck(W);
  for (const z of [-7.4, -5.6, -3.8, -0.4, 1.4, 3.2, 5.0, 6.6]) frame(W, z);
  bulkhead(W, -2.6);
  bulkhead(W, 4.4);

  /* The bow port, and it is the reason the boat is worth walking to the front of.
   * A ring of acrylic set into the tapering nose, so the helm looks straight out
   * into the water the rest of the game happens in. */
  /* Sized to the opening it frames, not to a number chosen before the opening
   * existed. The loft now ends at PZ with a 1.95 m section, so the acrylic bears
   * on a ring just outside that and the retaining bolts sit outside again. */
  const PZ = HULL_LEN - 0.55;
  W.tube(0, 0.0, PZ - 0.10, 0, 0.0, PZ - 0.02, 1.00, 60, I.ACRYL, 0.3);
  W.tube(0, 0.0, PZ - 0.16, 0, 0.0, PZ - 0.06, 1.07, 60, I.TRIM, 0.5);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    W.box(Math.cos(a) * 1.12, Math.sin(a) * 1.12, PZ - 0.11, 0.055, 0.055, 0.06, a, I.TRIM, 0.6);
  }

  // Ladder to the top hatch, amidships.
  for (let i = 0; i < 9; i++) {
    const y = DECK_Y + 0.25 + i * 0.28;
    W.tube(-0.24, y, -1.5, 0.24, y, -1.5, 0.022, 8, I.TRIM, 0.55);
  }
  for (const s of [-1, 1]) {
    W.tube(s * 0.26, DECK_Y + 0.2, -1.5, s * 0.26, 1.85, -1.5, 0.030, 10, I.TRIM, 0.55);
  }
  W.tube(0, 2.02, -1.5, 0, 2.14, -1.5, 0.42, 30, I.TRIM, 0.6);
  ring(W, 0, 2.00, -1.5, 0.50, 0.030, 20, 'y', I.TRIM, 0.6);

  // Deckhead lamp housings, so the light comes from something visible.
  for (const z of [-5.2, 0.4, 6.0]) {
    W.tube(0, 1.62, z - 0.20, 0, 1.62, z + 0.20, 0.09, 16, I.TRIM, 0.5);
    // A wire guard over each, which is what turns a bare tube into a fitting.
    for (let i = 0; i < 7; i++) {
      const a = -0.4 + (i / 6) * (Math.PI + 0.8);
      W.tube(Math.cos(a) * 0.14, 1.62 + Math.sin(a) * 0.14 - 0.02, z - 0.22,
        Math.cos(a) * 0.14, 1.62 + Math.sin(a) * 0.14 - 0.02, z + 0.22, 0.008, 4, I.TRIM, 0.5);
    }
  }
  W.tube(0, 1.42, 3.4, 0, 1.42, 3.52, 0.06, 12, I.TRIM, 0.6);

  /* Fit-out. Three compartments with three jobs, plus the services overhead.
   *
   * Order matters only for readability — everything welds into the same buffer
   * and the whole boat is still one draw call. */
  deckhead(F);
  sternMachinery(F);
  midAccommodation(F);
  bowHelm(F);

  // Bulkhead cheeks and the ladder well, which have no builder of their own.
  for (const z of [-2.6, 4.4]) {
    const doorW = 0.82, doorH = 1.95;
    F.solid(-1.55, DECK_Y + 1.4, z, 2.0, 2.8, 0.30);
    F.solid(1.55, DECK_Y + 1.4, z, 2.0, 2.8, 0.30);
    F.solid(0, DECK_Y + doorH + 0.45, z, doorW + 0.4, 0.9, 0.30);
  }
  F.solid(0, DECK_Y + 1.0, -1.5, 0.62, 2.2, 0.20);
  SOLIDS = F.solids;

  const mesh = new THREE.Mesh(W.geometry(), interiorMaterial(atlas));
  mesh.frustumCulled = false;
  mesh.name = 'interior';

  /* Sit the boat on the canyon floor. A pure translation, deliberately: walking
   * collision then works directly in hull coordinates with no inverse transform
   * anywhere in the movement code. */
  const ox = 74, oz = 8;
  /* Launched with water under the keel, not resting in it.
   *
   * At +2.5 the keel sits ten centimetres *below* the contact height, so the
   * vessel spawned aground: the bottom-contact branch fired on frame one and
   * its scrape drag ate the thrust, which read as a boat that would not move.
   * The hull half-section is 2.35 and the contact margin 0.15, so anything
   * under about 2.75 starts dug in. */
  const oy = seabedHeight(ox, oz) + 3.4;
  mesh.position.set(ox, oy, oz);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);

  return {
    mesh,
    mat: mesh.material,
    origin: new THREE.Vector3(ox, oy, oz),
    deckY: DECK_Y,
    helm: HELM,
    solids: F.solids,
  };
}
