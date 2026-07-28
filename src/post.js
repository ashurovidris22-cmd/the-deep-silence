import * as THREE from 'three';
import { NOISE, WATER, FS_VERT } from './glsl.js';

/* The post chain is not "polish". Underwater, most of what the eye reads —
 * the lamp's cone, the halo around a distant light, the way highlights bleed —
 * happens in the medium between the surface and the lens, not on the surface.
 * Render the geometry without this and you get a diorama in green soup.
 *
 *   scene (HDR + depth)
 *     -> volumetric   raymarch the lamp cone against scene depth, half res
 *     -> bloom        progressive down/up sample, HDR-correct
 *     -> composite    tonemap, grain, vignette, chromatic aberration
 */

const MIPS = 5;

function fsQuad() {
  // Single triangle, not two. No diagonal seam, and the GPU shades each pixel
  // exactly once instead of twice along the quad's shared edge.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 0, 0, 2,
  ]), 2));
  return g;
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(fsQuad(), null);
    this.quad.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.sceneQ = new THREE.Scene();
    this.sceneQ.add(this.quad);

    this.volScale = 0.5;
    this.bloomStrength = 0.62;
    this.exposure = 1.0;

    this._makeTargets(2, 2);
    this._makeMaterials();
  }

  _rt(w, h, depth = false) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
    });
    if (depth) {
      rt.depthTexture = new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0));
      rt.depthTexture.type = THREE.UnsignedIntType;
    }
    return rt;
  }

  _makeTargets(w, h) {
    this.rtScene = this._rt(w, h, true);
    this.rtVol = this._rt(w * this.volScale, h * this.volScale);
    this.rtVol2 = this._rt(w * this.volScale, h * this.volScale);
    this.rtBright = this._rt(w / 2, h / 2);
    this.rtDof = this._rt(w / 2, h / 2);
    this.rtDof2 = this._rt(w / 2, h / 2);
    this.mips = [];
    for (let i = 0; i < MIPS; i++) {
      this.mips.push(this._rt(w / (4 << i), h / (4 << i)));
    }
    this.rtUp = [];
    for (let i = 0; i < MIPS; i++) {
      this.rtUp.push(this._rt(w / (4 << i), h / (4 << i)));
    }
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.rtScene.setSize(w, h);
    if (this.rtScene.depthTexture) this.rtScene.depthTexture.image = { width: w, height: h };
    this.rtVol.setSize(Math.max(1, (w * this.volScale) | 0), Math.max(1, (h * this.volScale) | 0));
    this.rtVol2.setSize(Math.max(1, (w * this.volScale) | 0), Math.max(1, (h * this.volScale) | 0));
    this.rtBright.setSize(Math.max(1, w / 2 | 0), Math.max(1, h / 2 | 0));
    this.rtDof.setSize(Math.max(1, w / 2 | 0), Math.max(1, h / 2 | 0));
    this.rtDof2.setSize(Math.max(1, w / 2 | 0), Math.max(1, h / 2 | 0));
    for (let i = 0; i < MIPS; i++) {
      const d = 4 << i;
      this.mips[i].setSize(Math.max(1, w / d | 0), Math.max(1, h / d | 0));
      this.rtUp[i].setSize(Math.max(1, w / d | 0), Math.max(1, h / d | 0));
    }
  }

  _makeMaterials() {
    // ---------------------------------------------------------- volumetric
    // Marches the view ray and asks, at each step, how much lamp light is
    // being scattered toward the eye from that point. The forward-scattering
    // phase function is what makes the beam a solid shaft rather than a glow.
    this.matVol = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uNear: { value: 0.1 }, uFar: { value: 900 },
        uRes: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uSteps: { value: 32 },
        uMaxDist: { value: 70 },
        uTMin: { value: 0.45 },
        /* One honest gain, and only one. uLampInt is a shading intensity with a
         * 1/(1+kd^2) falloff rather than a photometric quantity, so a single
         * scalar is needed to reconcile it with a physical volume integral. With
         * the dimensions now correct this number no longer has to be re-tuned
         * every time the water type changes — which is the whole point of
         * fixing units rather than turning the knob until it looks right. */
        uVolStrength: { value: 0.0125 },
        uExt: { value: new THREE.Vector3() },
        uKd: { value: new THREE.Vector3() },
        uAlbedo: { value: new THREE.Vector3() },
        uScat: { value: new THREE.Vector3() },
        uSurfaceIrr: { value: new THREE.Vector3() },
        uSurfaceY: { value: 0 },
        uScatterGain: { value: 1 },
        uAmbientFloor: { value: new THREE.Vector3() },
        uLampPos: { value: new THREE.Vector3() },
        uLampDir: { value: new THREE.Vector3(0, 0, -1) },
        uLampCol: { value: new THREE.Vector3(1, 0.97, 0.92) },
        uLampInt: { value: 90 },
        uLampCos: { value: Math.cos(0.42) },
        uLampSoft: { value: 0.30 },
        uG: { value: 0.72 },
        uPointPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uPointCol: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uPointCount: { value: 0 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        ${NOISE}
        ${WATER}
        varying vec2 vUv;
        uniform sampler2D tDepth;
        uniform mat4 uInvProj, uInvView;
        uniform vec3 uCamPos; uniform float uNear, uFar; uniform vec2 uRes;
        uniform float uTime, uSteps, uMaxDist, uG, uTMin, uVolStrength;
        uniform vec3 uLampPos, uLampDir, uLampCol;
        uniform float uLampInt, uLampCos, uLampSoft;
        uniform vec3 uPointPos[4]; uniform vec3 uPointCol[4]; uniform int uPointCount;

        float linDepth(float d){
          float z = d*2.0-1.0;
          return (2.0*uNear*uFar)/(uFar+uNear - z*(uFar-uNear));
        }

        void main(){
          // View ray through this pixel, in world space.
          vec4 clip = vec4(vUv*2.0-1.0, -1.0, 1.0);
          vec4 vpos = uInvProj * clip; vpos /= vpos.w;
          vec3 dirV = normalize(vpos.xyz);
          vec3 dir  = normalize((uInvView * vec4(dirV,0.0)).xyz);

          float dRaw = texture2D(tDepth, vUv).r;
          float sceneDist = (dRaw >= 1.0) ? uMaxDist : linDepth(dRaw) / max(-dirV.z, 1e-3);
          float far = min(sceneDist, uMaxDist);

          int steps = int(uSteps);
          /* Start the march at a finite distance, and never at zero.
           *
           * Scattered radiance from a point lamp goes as 1/d^2, so with the
           * lamp anywhere near the eye the integrand diverges at t=0 — and the
           * forward-scattering phase function peaks in the same place, on the
           * same axis. A coarse march then hands that singularity a multi-metre
           * step width and writes the result into one enormous additive disc
           * dead centre of frame. That is not a lighting bug, it is quadrature
           * of a divergent integral. A real housing puts its lamp some way from
           * the port, so beginning at that offset is both the fix and the truth.
           */
          float near0 = uTMin;
          float span = max(far - near0, 0.0);
          float fsteps = float(steps);
          /* White-noise jitter, deliberately not interleaved gradient noise.
           *
           * IGN is the better choice when a temporal filter is going to average
           * it away — it is low-discrepancy precisely because it is a regular
           * lattice. There is no temporal filter here, and stills are how this
           * game is judged, so that lattice renders as a visible grid of dots
           * across the beam. Unstructured noise of the same magnitude reads as
           * grain instead, and the blur below removes most of it. */
          float jitter = hash12(gl_FragCoord.xy + fract(uTime)*137.0);

          vec3 acc = vec3(0.0);
          vec3 lampDirN = normalize(uLampDir);

          for(int i=0;i<64;i++){
            if(i>=steps) break;

            /* Quadratic step distribution, and this is the whole fix.
             *
             * The integrand falls as 1/d^2 from the lamp, so essentially all of
             * its mass sits in the first couple of metres. Uniform steps sample
             * that spike once and then multiply it by the full step width — with
             * twelve steps over seventy metres that is a near-field value scaled
             * by 5.8 m, which overstates the true integral by orders of
             * magnitude and lands as a saturated blob in the middle of every
             * single frame. Warping s^2 clusters samples where the mass is and
             * gives each one its own honest width. */
            float s0 = float(i)/fsteps, s1 = float(i+1)/fsteps;
            float t0 = near0 + span*s0*s0;
            float t1 = near0 + span*s1*s1;
            float dt = t1 - t0;
            float t = mix(t0, t1, jitter);
            vec3 p = uCamPos + dir*t;

            // Transmittance from the eye to this sample.
            vec3 Tv = exp(-uExt * t);

            // --- cone lamp
            vec3 toL = uLampPos - p;
            float dL = length(toL);
            vec3 L = toL/max(dL,1e-4);
            float cone = smoothstep(uLampCos, uLampCos+uLampSoft, dot(-L, lampDirN));
            if(cone > 0.0){
              vec3 Tl = exp(-uExt * dL);              // eye <- sample <- lamp
              float att = uLampInt/(1.0+dL*dL*0.9);
              float ph = phaseHG(dot(dir, -L), uG);
              /* Scattering coefficient b, not the albedo b/c.
               *
               * dt is in metres, so the coefficient in front of it has to be in
               * inverse metres for the product to be dimensionless. uAlbedo is
               * dimensionless already, so using it here left the integral
               * scaled by a length — roughly four times too large in the green,
               * and wrong in a way that changed whenever the water type did. */
              acc += uLampCol * att * cone * ph * Tv * Tl * uScat * dt;
            }

            /* --- downwelling shafts from the surface
             *
             * The same in-scatter integral, but with the sun as the source
             * instead of the lamp. Light propagates downward, so the phase angle
             * against a view ray is just dir.y: look up and you are staring
             * along the direction the photons are already travelling, which is
             * where a forward-scattering medium sends most of them. That single
             * term is why the water above reads as columns rather than a wash,
             * and why turning to look up is worth doing.
             *
             * Modulated by ambientAt(), so the shafts fade with the daylight
             * that makes them and are simply gone below the photic zone. */
            /* Weak, because the output is clamped and this term is the one most
             * able to saturate it. At full strength in shallow water it exceeded
             * the clamp across the whole frame, so every shaft flattened into
             * one even sheet — the modulation was still being computed and then
             * thrown away by the ceiling. A term meant to give structure must sit
             * well below the limit, not against it. */
            /* sunAt, not ambientAt — same bug as the caustics.
             * The comment above already says these shafts are "simply gone
             * below the photic zone". With the bio floor folded in they were
             * not: the volume kept integrating a downwelling beam in water the
             * sun stopped reaching a hundred and fifty metres higher up. */
            vec3 down = sunAt(p.y);
            float m = shaftMask(p.xz, uTime);
            acc += down * m * phaseHG(dir.y, 0.45) * Tv * uScat * dt * 1.15;

            // --- omni sources (distant station lamps, bio clusters)
            for(int k=0;k<4;k++){
              if(k>=uPointCount) break;
              vec3 tp = uPointPos[k]-p;
              float dp = length(tp);
              vec3 Lp = tp/max(dp,1e-4);
              vec3 Tp = exp(-uExt*dp);
              float attp = 1.0/(1.0+dp*dp*0.30);
              float php = phaseHG(dot(dir,-Lp), uG*0.6);
              acc += uPointCol[k]*attp*php*Tv*Tp*uScat*dt;
            }
          }
          // Clamped before it leaves the pass. A single sample that lands very
          // near a source can still spike; letting that reach the bloom chain
          // turns one bad pixel into a bright cloud several hundred wide. Kept
          // low deliberately: if this clamp is doing visible work, the
          // quadrature above is wrong and should be fixed instead of capped.
          acc = min(acc * uVolStrength, vec3(0.85));
          gl_FragColor = vec4(max(acc, 0.0), 1.0);
        }`,
    });

    // ------------------------------------------------------------- bright
    this.matBright = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.85 }, uKnee: { value: 0.55 } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform sampler2D tSrc; uniform float uThreshold, uKnee;
        void main(){
          vec3 c = texture2D(tSrc, vUv).rgb;
          float l = dot(c, vec3(0.2126,0.7152,0.0722));
          // Soft knee: a hard threshold makes bloom pop on and off as a light
          // drifts past the cutoff, which reads as flicker.
          float s = clamp((l - uThreshold + uKnee) / (2.0*uKnee), 0.0, 1.0);
          float w = max(s*s*(l>uThreshold?1.0:0.0), max(l-uThreshold,0.0)/max(l,1e-4));
          gl_FragColor = vec4(c * w, 1.0);
        }`,
    });

    const blurFS = /* glsl */`
      precision highp float; varying vec2 vUv;
      uniform sampler2D tSrc; uniform vec2 uTexel;
      void main(){
        // 13-tap Kawase-style down/upsample. Wide, cheap, and does not shimmer.
        vec3 s = vec3(0.0);
        s += texture2D(tSrc, vUv).rgb * 0.25;
        s += texture2D(tSrc, vUv + uTexel*vec2( 1.0, 1.0)).rgb * 0.125;
        s += texture2D(tSrc, vUv + uTexel*vec2(-1.0, 1.0)).rgb * 0.125;
        s += texture2D(tSrc, vUv + uTexel*vec2( 1.0,-1.0)).rgb * 0.125;
        s += texture2D(tSrc, vUv + uTexel*vec2(-1.0,-1.0)).rgb * 0.125;
        s += texture2D(tSrc, vUv + uTexel*vec2( 2.0, 0.0)).rgb * 0.0625;
        s += texture2D(tSrc, vUv + uTexel*vec2(-2.0, 0.0)).rgb * 0.0625;
        s += texture2D(tSrc, vUv + uTexel*vec2( 0.0, 2.0)).rgb * 0.0625;
        s += texture2D(tSrc, vUv + uTexel*vec2( 0.0,-2.0)).rgb * 0.0625;
        gl_FragColor = vec4(s, 1.0);
      }`;
    this.matBlur = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT, fragmentShader: blurFS,
    });
    this.matAdd = new THREE.ShaderMaterial({
      uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 1 } },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */`
        precision highp float; varying vec2 vUv;
        uniform sampler2D tA, tB; uniform float uMix;
        void main(){ gl_FragColor = vec4(texture2D(tA,vUv).rgb + texture2D(tB,vUv).rgb*uMix, 1.0); }`,
    });

    // ---------------------------------------------------------- composite
    this.matComp = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tVol: { value: null }, tBloom: { value: null },
        tDof: { value: null }, tDepth: { value: null },
        uNear: { value: 0.1 }, uFar: { value: 900 },
        /* Focus a few metres out, which is where a submersible's lamp actually
         * puts anything worth looking at. */
        uFocus: { value: 5.0 }, uDofAmount: { value: 0.85 },
        uExposure: { value: 1.0 }, uExposureIn: { value: 1.05 }, uBloom: { value: 0.62 },
        uGrain: { value: 0.011 }, uVignette: { value: 0.28 }, uCA: { value: 0.0016 },
        uTime: { value: 0 }, uRes: { value: new THREE.Vector2() },
        uLift: { value: new THREE.Vector3(0.004, 0.008, 0.012) },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */`
        precision highp float;
        ${NOISE}
        varying vec2 vUv;
        uniform sampler2D tScene, tVol, tBloom, tDof, tDepth;
        uniform float uExposure, uExposureIn, uBloom, uGrain, uVignette, uCA, uTime;
        uniform float uNear, uFar, uFocus, uDofAmount;
        uniform vec2 uRes; uniform vec3 uLift;

        // ACES fitted (Stephen Hill). Keeps saturated highlights from turning
        // into flat white discs, which matters because every light in this game
        // is a small very bright thing seen through fog.
        vec3 RRTAndODTFit(vec3 v){
          vec3 a = v*(v+0.0245786)-0.000090537;
          vec3 b = v*(0.983729*v+0.4329510)+0.238081;
          return a/b;
        }
        vec3 ACESFitted(vec3 c){
          const mat3 IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
          const mat3 OUT= mat3( 1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
          c = IN*c; c = RRTAndODTFit(c); c = OUT*c;
          return clamp(c, 0.0, 1.0);
        }

        void main(){
          vec2 uv = vUv;
          vec2 d = uv - 0.5;
          float r2 = dot(d,d);

          // Chromatic aberration, radial and tiny. Real housings have it; the
          // point is that it is only visible at the corners.
          vec2 off = d * uCA * r2 * 4.0;
          vec3 col;
          col.r = texture2D(tScene, uv + off).r;
          col.g = texture2D(tScene, uv).g;
          col.b = texture2D(tScene, uv - off).b;

          /* Depth of field, and it is the near field that matters.
           *
           * The single strongest cue that a frame was photographed rather than
           * rendered is something out of focus in front of the lens. Underwater
           * that is free content: the marine snow drifting a handful of
           * centimetres from the port is exactly what a real housing cannot hold
           * in focus. Far blur is kept mild because the fog is already doing that
           * job honestly and doubling it just reads as mush.
           */
          float dRaw = texture2D(tDepth, uv).r;
          float zl = (2.0*uNear*uFar) / (uFar + uNear - (dRaw*2.0-1.0)*(uFar-uNear));
          /* Near blur confined to the first metre and a half.
           *
           * Keyed off the focus distance this ramped from five metres inward, so
           * roughly half of everything three metres away was already smeared —
           * and since the lamp only reaches a few metres, that meant the only
           * lit part of the frame was the blurred part. Reported, reasonably, as
           * not being able to see anything. A real housing holds focus over most
           * of its useful range and loses it only right against the port, which
           * is also the only place the effect is worth having. */
          float nearCoc = smoothstep(1.5, 0.3, zl);
          float farCoc  = smoothstep(uFocus*3.0, uFocus*10.0, zl) * 0.30;
          /* Skip defocus on the cockpit.
           *
           * The interior sits half a metre from the eye, well inside the near
           * blur, so it would be smeared into paste — and it is the one surface
           * the player needs to read. The scene pass writes alpha 1 everywhere
           * except the cabin, which writes 0, so one multiply excludes it without
           * a second render target or a stencil. */
          float notCabin = texture2D(tScene, uv).a;
          float coc = clamp((nearCoc + farCoc) * uDofAmount, 0.0, 1.0) * notCabin;
          col = mix(col, texture2D(tDof, uv).rgb, coc);

          /* In-scatter belongs to water, and there is none inside the boat.
           *
           * This was added unconditionally, so the volumetric integral computed
           * for a lamp mounted on the outside of the hull was being composited
           * over the cabin as well. The result was a milky veil across every
           * interior frame that got stronger with distance down the compartment
           * — exactly like fog, because it was fog, indoors.
           *
           * It hid for a long time because the compartments were empty: with
           * nothing in them, a grey haze over grey plate is just grey plate.
           * Furnishing the boat is what made it visible, which is the same
           * lesson as the contact sheet — a defect needs something to be
           * measured against before anyone can see it.
           *
           * Same alpha, same one multiply as the defocus exemption above. */
          col += texture2D(tVol, uv).rgb * notCabin;
          col += texture2D(tBloom, uv).rgb * uBloom;

/* Two exposures, selected by the same alpha that exempts the cockpit from
           * defocus.
           *
           * The auto-exposure is driven by the water, which spans four orders of
           * magnitude between the shelf and the canyon floor. The interior is in
           * air, lit by its own lamps, and has no business being metered against
           * the ocean — held to the outside meter it is either a black hole at
           * depth or a white box in the shallows, and no amount of tuning the
           * cabin lights fixes it because the target keeps moving. Giving the
           * inside a fixed stop is what a real camera through a porthole cannot
           * do, and exactly what an eye adapting to a lit room does. */
          col *= mix(uExposureIn, uExposure, notCabin);
          col = ACESFitted(col);

          // Lift the blacks slightly and cool them. Pure black in water is a
          // lie — there is always some scatter — and a crushed frame reads as
          // a rendering bug rather than as darkness.
          col += uLift * (1.0 - col);

          col *= 1.0 - uVignette * smoothstep(0.12, 0.78, r2);

          // Grain, in linear-ish space before encode, scaled by darkness. Sensor
          // noise lives in the shadows; uniform grain looks like a filter.
          float g = hash12(gl_FragCoord.xy + fract(uTime)*719.7) - 0.5;
          col += g * uGrain * (1.0 - smoothstep(0.0, 0.6, dot(col,vec3(0.333))));

          gl_FragColor = vec4(pow(max(col,0.0), vec3(1.0/2.2)), 1.0);
        }`,
    });
  }

  _draw(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this.sceneQ, this.cam);
  }

  render(scene, camera, env) {
    const r = this.renderer;

    // 1. scene -> HDR
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);

    // 2. volumetric
    const v = this.matVol.uniforms;
    v.tDepth.value = this.rtScene.depthTexture;
    v.uInvProj.value.copy(camera.projectionMatrixInverse);
    v.uInvView.value.copy(camera.matrixWorld);
    v.uCamPos.value.copy(camera.position);
    v.uNear.value = camera.near; v.uFar.value = camera.far;
    v.uRes.value.set(this.w, this.h);
    env.applyTo(v);
    this._draw(this.matVol, this.rtVol);

    // Blur the volume before it is composited. A raymarch this coarse is noisy
    // by construction; the beam has no high-frequency detail to preserve, so
    // there is nothing to lose and a great deal of sampling noise to remove.
    this.matBlur.uniforms.tSrc.value = this.rtVol.texture;
    this.matBlur.uniforms.uTexel.value.set(1 / this.rtVol.width, 1 / this.rtVol.height);
    this._draw(this.matBlur, this.rtVol2);

    // 3. defocus source: two wide taps at half res. Cheap, and a circular
    //    bokeh is wasted on a medium that has no hard highlights anyway.
    this.matBlur.uniforms.tSrc.value = this.rtScene.texture;
    this.matBlur.uniforms.uTexel.value.set(1.6 / this.w, 1.6 / this.h);
    this._draw(this.matBlur, this.rtDof);
    this.matBlur.uniforms.tSrc.value = this.rtDof.texture;
    this.matBlur.uniforms.uTexel.value.set(2.4 / this.rtDof.width, 2.4 / this.rtDof.height);
    this._draw(this.matBlur, this.rtDof2);

    // 4. bloom: bright pass, then a down/up pyramid
    this.matBright.uniforms.tSrc.value = this.rtScene.texture;
    this._draw(this.matBright, this.rtBright);

    let src = this.rtBright;
    for (let i = 0; i < MIPS; i++) {
      this.matBlur.uniforms.tSrc.value = src.texture;
      this.matBlur.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._draw(this.matBlur, this.mips[i]);
      src = this.mips[i];
    }
    // Upsample back, adding each coarser level into the finer one. This is what
    // gives bloom a long soft tail instead of one blurry halo.
    let up = this.mips[MIPS - 1];
    for (let i = MIPS - 2; i >= 0; i--) {
      this.matAdd.uniforms.tA.value = this.mips[i].texture;
      this.matAdd.uniforms.tB.value = up.texture;
      this.matAdd.uniforms.uMix.value = 0.78;
      this._draw(this.matAdd, this.rtUp[i]);
      up = this.rtUp[i];
    }

    // 4. composite to screen
    const c = this.matComp.uniforms;
    c.tScene.value = this.rtScene.texture;
    c.tVol.value = this.rtVol2.texture;
    c.tBloom.value = up.texture;
    c.tDof.value = this.rtDof2.texture;
    c.tDepth.value = this.rtScene.depthTexture;
    c.uNear.value = camera.near; c.uFar.value = camera.far;
    c.uRes.value.set(this.w, this.h);
    c.uExposure.value = this.exposure;
    c.uBloom.value = this.bloomStrength;
    this._draw(this.matComp, null);
  }
}
