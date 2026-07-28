import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { Welder } from './structures.js';
import { loftInto, fairStations } from './loft.js';

/* The cabin, and why it changes the game rather than decorating it.
 *
 * Until now the player has been a disembodied camera in open water. Everything
 * on screen is out there, at a distance, and nothing is between the viewer and
 * it. That is why the pressure has been an abstraction: a number in the corner.
 *
 * A cockpit puts a boundary in every frame. The frightening thing about being
 * four hundred metres down is not the dark, it is the forty millimetres of
 * acrylic holding forty atmospheres off your face — and that only exists as a
 * feeling if the acrylic is visible at the edges of the shot at all times. This
 * is the Barotrauma half of the brief: not its art, its systemic dread. A thin
 * metal box, a finite power budget, and a number that only ever goes up.
 *
 * Interior surfaces are deliberately NOT water-fogged. They are in air, a
 * half-metre from the eye. Running them through applyWater would tint the
 * instrument panel teal and put four hundred metres of ocean between the pilot
 * and their own console.
 */

const P_SHELL = 0.0;   // painted interior plate
const P_ACRYL = 1.0;   // viewport, seen edge-on as thickness
const P_GAUGE = 2.0;   // instrument face, self-lit
const P_TRIM = 3.0;   // bare alloy: frames, handles, fasteners

/** Flat annulus in the XY plane at a given z: the front bulkhead with its port. */
function annulus(W, z, rIn, rOut, seg, mat, wear, nz = 1) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const base = W.v;
    W._push(c0 * rIn, s0 * rIn, z, 0, 0, nz, mat, wear, a0, rIn);
    W._push(c1 * rIn, s1 * rIn, z, 0, 0, nz, mat, wear, a1, rIn);
    W._push(c1 * rOut, s1 * rOut, z, 0, 0, nz, mat, wear, a1, rOut);
    W._push(c0 * rOut, s0 * rOut, z, 0, 0, nz, mat, wear, a0, rOut);
    /* Winding, and it was backwards.
     *
     * Going anticlockwise in XY and then outward in radius produces a triangle
     * whose geometric normal is -Z, so with a +Z normal declared and back-face
     * culling on, the whole bulkhead was discarded. The symptom was not a missing
     * wall — it was a ring of retaining bolts and a pair of frames apparently
     * floating in open water, because the only parts of the cockpit still drawing
     * were the ones built from tubes and boxes. A face that is silently absent is
     * much harder to spot than one that is visibly wrong. */
    if (nz > 0) W.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Flat quad from four corners, with an explicit normal. */
function quad(W, a, b, c, d, n, mat, wear) {
  const base = W.v;
  W._push(a[0], a[1], a[2], n[0], n[1], n[2], mat, wear, 0, 0);
  W._push(b[0], b[1], b[2], n[0], n[1], n[2], mat, wear, 1, 0);
  W._push(c[0], c[1], c[2], n[0], n[1], n[2], mat, wear, 1, 1);
  W._push(d[0], d[1], d[2], n[0], n[1], n[2], mat, wear, 0, 1);
  W.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function cabinMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPressure: { value: 1 },     // atmospheres, drives the gauge and the cracks
      uDepth: { value: 0 },
      uAlarm: { value: 0 },        // 0..1, red emergency lighting
      uCabinLight: { value: 1 },   // the one working interior lamp
    },
    vertexShader: /* glsl */`
      attribute float aMat; attribute float aWear; attribute vec2 aUV;
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear; varying vec2 vUV;
      void main(){
        // Local space is what matters here: the cabin rides the camera, so world
        // coordinates would drag every texture across it as the vehicle moves.
        vP = position; vN = normalize(normal);
        vMat = aMat; vWear = aWear; vUV = aUV;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${NOISE}
      varying vec3 vP; varying vec3 vN; varying float vMat; varying float vWear; varying vec2 vUV;
      uniform float uTime, uPressure, uDepth, uAlarm, uCabinLight;

      // Small fixed-width digit renderer, so the depth readout is a real number
      // rather than a texture of one. Seven segments, addressed by bit.
      float seg7(vec2 p, int d){
        int m = 0;
        if(d==0) m=63; else if(d==1) m=6; else if(d==2) m=91; else if(d==3) m=79;
        else if(d==4) m=102; else if(d==5) m=109; else if(d==6) m=125;
        else if(d==7) m=7; else if(d==8) m=127; else m=111;
        float on = 0.0;
        // a,b,c,d,e,f,g as thin rectangles in a 0..1 box
        vec4 bars[7];
        bars[0]=vec4(0.18,0.86,0.82,0.94); bars[1]=vec4(0.80,0.50,0.92,0.86);
        bars[2]=vec4(0.80,0.14,0.92,0.50); bars[3]=vec4(0.18,0.06,0.82,0.18);
        bars[4]=vec4(0.08,0.14,0.20,0.50); bars[5]=vec4(0.08,0.50,0.20,0.86);
        bars[6]=vec4(0.18,0.46,0.82,0.58);
        for(int i=0;i<7;i++){
          int bit = int(pow(2.0,float(i)));
          if(m/bit - (m/(bit*2))*2 == 1){
            vec4 b = bars[i];
            if(p.x>b.x && p.x<b.z && p.y>b.y && p.y<b.w) on = 1.0;
          }
        }
        return on;
      }

      void main(){
        vec3 col;
        float emissive = 0.0;

        if (vMat > 1.5 && vMat < 2.5) {
          /* Instrument faces, and they read the real state.
           *
           * The needle angle comes from the actual pressure uniform, so the dial
           * is an output of the simulation rather than a picture of a dial. That
           * matters more than it sounds: a gauge that moves when you descend is
           * the cheapest possible way to tell the player the number is real. */
          vec2 q = vUV * 2.0 - 1.0;
          float r = length(q);
          if (r > 1.0) discard;
          col = vec3(0.030, 0.034, 0.036);

          // Tick marks around the dial.
          float ang = atan(q.y, q.x);
          float ticks = abs(fract((ang + 3.14159) / 6.2832 * 24.0) - 0.5) * 2.0;
          float tickMask = smoothstep(0.86, 0.98, ticks) * smoothstep(0.62, 0.72, r) * (1.0 - smoothstep(0.88, 0.96, r));
          col += vec3(0.30, 0.34, 0.33) * tickMask;

          // Needle: pressure mapped over 270 degrees, resting at the lower left.
          float frac = clamp(uPressure / 620.0, 0.0, 1.05);
          float na = -2.356 + frac * 4.712;
          vec2 nd = vec2(cos(na), sin(na));
          float along = dot(q, nd);
          float across = abs(q.x * nd.y - q.y * nd.x);
          float needle = (along > -0.06 && along < 0.82) ? smoothstep(0.055, 0.012, across) : 0.0;
          vec3 needleCol = mix(vec3(0.85,0.86,0.82), vec3(1.0,0.28,0.16), smoothstep(0.72, 1.0, frac));
          col += needleCol * needle * 1.6;

          // Redline arc near the hull's rated limit.
          float red = smoothstep(0.80, 0.84, (ang + 3.14159)/6.2832) * smoothstep(0.66, 0.74, r) * (1.0-smoothstep(0.86,0.93,r));
          col += vec3(0.55,0.06,0.03) * red;
          emissive = 0.85;

        } else if (vMat > 0.5 && vMat < 1.5) {
          /* The acrylic, seen as thickness at the rim of the port.
           *
           * Forty millimetres of it is the only thing between the cabin and the
           * pressure, and the edge is where you see that it has depth — cast
           * acrylic goes faintly green through its thickness and picks up
           * scuffing from decades of handling. */
          float scuff = fbm(vUV * 26.0, 3);
          col = mix(vec3(0.055, 0.088, 0.086), vec3(0.10, 0.15, 0.145), scuff);
          /* Crazing that grows with pressure.
           *
           * Deliberately never quite legible: fine crack figures appear in the
           * outer millimetres as the load rises. It is the one element in the
           * cabin whose job is to be noticed peripherally and worried about. */
          float crack = smoothstep(0.62, 0.78, fbm(vUV * vec2(38.0, 4.0), 3));
          col += vec3(0.20, 0.26, 0.25) * crack * smoothstep(120.0, 560.0, uPressure);
          emissive = 0.10;

        } else if (vMat > 2.5) {
          // Bare alloy trim: frames, latches, fasteners.
          col = vec3(0.112, 0.114, 0.118) * (0.80 + 0.45 * fbm(vUV * 9.0, 2));

        } else {
          // Painted interior plate, worn through on the edges people touch.
          float wearN = fbm(vUV * 5.5, 3);
          vec3 paint = vec3(0.098, 0.102, 0.096);
          vec3 bare  = vec3(0.132, 0.124, 0.110);
          col = mix(paint, bare, smoothstep(0.52, 0.86, wearN) * vWear);
        }

        /* Interior lighting: one working lamp overhead, plus the alarm.
         *
         * Two sources and no ambient, because a cabin lit from everywhere reads
         * as a studio. The red is placed behind and above so it rims the frames
         * and leaves the console readable — an alarm that drowns the instruments
         * is a design error, not atmosphere. */
        vec3 lampPos = vec3(0.0, 0.46, -0.10);
        vec3 toL = lampPos - vP;
        float dL = length(toL);
        vec3 L = toL / max(dL, 1e-4);
        float ndl = max(dot(vN, L), 0.0) * 0.75 + 0.25;
        /* Strong enough to actually read by.
         * Interior lighting competes with an auto-exposure tuned for a lamp pool
         * outside; at 0.85 the cabin sat below the tone curve's toe and the whole
         * cockpit came back as a silhouette with a few bright fixings in it. */
/* Calibrated against the auto-exposure, not in isolation.
         *
         * The exposure is driven by the water outside, which spans four orders of
         * magnitude between the shelf and the canyon floor. An interior bright
         * enough to read on its own at depth is a blown white box in daylight —
         * which is what 2.2 gave. At this level the cockpit sits as a dark frame
         * against bright water up top, and becomes the lit thing once the water
         * goes black, which is the correct relationship in both places. */
        vec3 warm = vec3(1.0, 0.86, 0.66) * uCabinLight * (0.85 / (0.30 + dL*dL));

        vec3 redPos = vec3(0.0, 0.40, 0.30);
        vec3 toR = redPos - vP;
        float dR = length(toR);
        float ndr = max(dot(vN, normalize(toR)), 0.0) * 0.7 + 0.3;
        // Slow throb, not a strobe: a strobe reads as an arcade cabinet.
        float throb = 0.55 + 0.45 * sin(uTime * 2.1);
        vec3 red = vec3(1.0, 0.10, 0.06) * uAlarm * throb * (1.1 / (0.30 + dR*dR));

        vec3 lit = col * (warm * ndl + red * ndr) + col * emissive * 2.2;
        // A trace of the outside leaking in through the port, so the cabin is not
        // a sealed diorama with a picture in it.
        lit += col * vec3(0.010, 0.024, 0.030) * max(0.0, -vN.z);

        // Alpha 0 marks this as cockpit: the composite skips defocus here, since
        // the near blur would otherwise smear the entire interior into paste.
        gl_FragColor = vec4(pow(max(lit, 0.0), vec3(1.0)), 0.0);
      }`,
  });
}

/**
 * Build the cockpit, in camera-local space: the eye at the origin, looking -Z.
 *
 * Everything is close. At a 62 degree field of view the frame is only about
 * 0.72 m wide at the bulkhead, so a few centimetres decides whether a frame
 * member is a subtle edge or a bar across the middle of the screen.
 */
export function buildCabin() {
  const W = new Welder();
  const Z = -0.66;          // bulkhead plane
  const R = 0.325;          // clear aperture of the port

  // Front bulkhead: a plate with the port cut out of it.
  annulus(W, Z, R, 1.5, 40, P_SHELL, 0.55, 1);

  /* Port assembly: the aperture ring, then the acrylic thickness behind it, then
   * the retaining flange. Built as three concentric rings so the port reads as an
   * assembly with depth rather than a hole in a wall. */
  W.tube(0, 0, Z, 0, 0, Z + 0.055, R, 44, P_ACRYL, 0.3);
  W.tube(0, 0, Z + 0.055, 0, 0, Z + 0.075, R + 0.012, 44, P_TRIM, 0.5);
  annulus(W, Z + 0.075, R + 0.012, R + 0.085, 40, P_TRIM, 0.5, 1);
  // Retaining bolts around the flange.
/* Bolts sit down on the flange, not out in front of it.
   *
   * At 22 mm and standing 20 mm proud of a nearly black bulkhead they read as a
   * ring of pale cubes floating in the dark — the plate behind them was too dim
   * to attach them to anything. Halved, and pushed back so they are barely proud. */
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    W.box(Math.cos(a) * (R + 0.048), Math.sin(a) * (R + 0.048), Z + 0.069,
      0.012, 0.012, 0.008, a, P_TRIM, 0.6);
  }

  /* Console, angled up toward the pilot. Sits low so it never crosses the port,
   * which is the one part of the frame that must stay clear. */
/* Framing is arithmetic here, not taste.
   *
   * Vertical field of view is 62 degrees, so at the bulkhead the visible frame is
   * only +-0.40 m tall. A console at y = -0.30 down there is simply below the
   * screen, which is where the first version put it — present in the model,
   * invisible in play. Brought forward to z = -0.28, where the half-height is
   * 0.17, its top edge lands exactly on the bottom of frame and the gauges sit
   * just inside it. */
  const cy0 = -0.155, cz0 = -0.28, cy1 = -0.335, cz1 = -0.55;
  quad(W,
    [-0.46, cy0, cz0], [0.46, cy0, cz0], [0.46, cy1, cz1], [-0.46, cy1, cz1],
    [0, 0.86, 0.51], P_SHELL, 0.75);
  // Front lip and side cheeks give it thickness.
  quad(W,
    [-0.46, cy1, cz1], [0.46, cy1, cz1], [0.46, cy1 - 0.16, cz1], [-0.46, cy1 - 0.16, cz1],
    [0, 0, 1], P_SHELL, 0.6);

  /* Gauges. Three, because a wall of dials is a cliche and three reads as a
   * vehicle that does one job. */
  const gaugeAt = (gx, r) => {
    const t = 0.5;
    const y = cy0 + (cy1 - cy0) * t, z = cz0 + (cz1 - cz0) * t;
    // Face sits just proud of the console, tilted with it.
    for (let i = 0; i < 28; i++) {
      const a0 = (i / 28) * Math.PI * 2, a1 = ((i + 1) / 28) * Math.PI * 2;
      const pt = (a) => {
        const lx = gx + Math.cos(a) * r;
        const ly = y + Math.sin(a) * r * 0.51;
        const lz = z + Math.sin(a) * r * 0.86 + 0.012;
        return [lx, ly, lz];
      };
      const c = W._push(gx, y + 0.012, z + 0.020, 0, 0.86, 0.51, P_GAUGE, 0.2, 0.5, 0.5);
      const p0 = pt(a0), p1 = pt(a1);
      const v0 = W._push(p0[0], p0[1], p0[2], 0, 0.86, 0.51, P_GAUGE, 0.2,
        0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5);
      const v1 = W._push(p1[0], p1[1], p1[2], 0, 0.86, 0.51, P_GAUGE, 0.2,
        0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5);
      W.idx.push(c, v0, v1);
    }
    // Bezel.
    W.tube(gx, y + 0.012, z + 0.010, gx, y + 0.014, z + 0.024, r * 1.10, 24, P_TRIM, 0.5);
  };
  gaugeAt(-0.235, 0.072);
  gaugeAt(0.0, 0.086);
  gaugeAt(0.235, 0.072);

  // Switch banks either side, small and dense: the texture of a working machine.
  for (let i = 0; i < 10; i++) {
    const gx = -0.40 + (i % 5) * 0.035;
    const row = Math.floor(i / 5);
    W.box(gx, cy0 - 0.055 - row * 0.045, cz0 - 0.075 - row * 0.026,
      0.016, 0.026, 0.014, 0, P_TRIM, 0.4);
    W.box(gx + 0.30 + (i % 5) * 0.0, cy0 - 0.055 - row * 0.045, cz0 - 0.075 - row * 0.026,
      0.016, 0.026, 0.014, 0, P_TRIM, 0.4);
  }

  /* Overhead: the one working lamp housing, and the alarm beside it. Modelled
   * because the light has to come from something the player can see. */
  W.tube(0, 0.455, -0.06, 0, 0.455, -0.16, 0.048, 14, P_TRIM, 0.5);
  W.tube(0, 0.40, 0.26, 0, 0.40, 0.34, 0.038, 12, P_TRIM, 0.6);

  /* Ribs. Curved, following the pressure hull's section, which is what makes the
   * cabin feel like the inside of a cylinder rather than a room. */
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const a = (-0.85 + (i / 8) * 1.7);
      const rr = 0.68;
      const x = side * Math.cos(a) * rr * 0.92;
      const y = Math.sin(a) * rr;
      const x2 = side * Math.cos(a + 0.2) * rr * 0.92;
      const y2 = Math.sin(a + 0.2) * rr;
      W.tube(x, y, Z + 0.06, x2, y2, Z + 0.06, 0.026, 6, P_TRIM, 0.55);
    }
    // Longitudinal stringer running back past the pilot.
    W.tube(side * 0.60, 0.30, Z + 0.05, side * 0.66, 0.26, 0.55, 0.030, 6, P_TRIM, 0.6);
  }

  const mesh = new THREE.Mesh(W.geometry(), cabinMaterial());
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.name = 'cabin';
  return { mesh, mat: mesh.material };
}
