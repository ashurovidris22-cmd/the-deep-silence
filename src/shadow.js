import * as THREE from 'three';

/* One shadow-casting projector on the lamp, and nothing else.
 *
 * Section 7 of HANDOFF.md records that there is not one shadow map anywhere in
 * src/, and that the art direction's "everything else in shadow" was therefore
 * unimplemented. This file is that clause, and it is deliberately the only
 * owner of it: the depth pass, the camera that renders it, and the uniforms
 * that carry it into the shading all live here.
 *
 * There are no three.js lights in this project - the lamp is a cone evaluated
 * in shader code - so none of three.js's shadow machinery applies. What follows
 * is the whole mechanism, and every number in it is derived from values that
 * already exist in the scene rather than chosen to look right.
 *
 *
 * FIELD OF VIEW comes from the cone itself. The lit term is
 *   cone = smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, lampDir))
 * so the light is brightest on axis and reaches exactly zero at uLampCos. The
 * map has to cover that outer edge and nothing beyond it: at env.lampCos =
 * cos(0.74) the half-angle is 42.4 deg and the fov is 84.8 deg.
 *
 * Getting this backwards is expensive, and it happened during design. Reading
 * uLampSoft as widening the cone outward gives a 133 deg fov, at which 1024^2
 * puts 0.9 texels across a catwalk grating bar at ten metres - a shadow with
 * nothing to draw it with. uLampSoft brightens the core inward; it does not
 * widen the edge.
 *
 *
 * RESOLUTION follows from what has to survive. At 84.8 deg a 1024^2 map is
 *   4.5 texels across a 4 cm grating bar at  5 m
 *   2.2                                     10 m
 *   1.0                                     21 m
 * Two texels is the floor for reading as a shadow rather than as noise, so the
 * grating holds to about ten metres and dissolves by the visibility limit -
 * which is honest, because the water has dissolved it too. 2048^2 would buy one
 * more octave for four times the fill; 512^2 loses the grating entirely.
 *
 *
 * FAR PLANE is the visibility limit, not an arbitrary distance. Past it the
 * lamp's light has already been absorbed, so an occluder out there cannot
 * darken anything the player can see, and spending depth range on it costs
 * precision everywhere nearer. env.visibility is the Duntley figure the rest of
 * the renderer already uses - 21.45 m on the shelf, 26.3 m at 424 m.
 *
 * NEAR PLANE is 0.25 m: closer than the lamp housing itself, and far enough out
 * that perspective depth precision at the far plane stays at a fifth of a
 * millimetre, which is two orders below any bias the slope will ask for.
 *
 *
 * MEASURED COST, 800x450, software rasteriser, canyon floor:
 *   pass off   30 draws  1714k tris
 *   pass on    36 draws  2367k tris
 * Six casters, and the depth pass is rendered after renderer.info.reset() on
 * purpose so that it shows up in the counts the survey harness reads. A cost
 * that hides from the instrument is a cost nobody finds later.
 */

/* three.js layers are entirely unused in this project - g.setLayer works by
 * name and toggles .visible - so this number is free. Casters opt in, which
 * means the default is "does not cast": a new mesh cannot silently start
 * costing fill in a pass its author never thought about. */
export const SHADOW_LAYER = 3;

/** Mark an object and its descendants as shadow casters. */
export function castsShadow(obj) {
  if (!obj) return obj;
  obj.traverse((o) => o.layers.enable(SHADOW_LAYER));
  return obj;
}

export class LampShadow {
  constructor(renderer, { size = 1024, near = 0.25 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.near = near;

    /* Depth only. The colour attachment is one texel because a render target
     * must have one; nothing ever samples it, and colorWrite is off in the
     * override material so nothing is even written to it. */
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.rt.texture.generateMipmaps = false;
    this.rt.depthTexture = new THREE.DepthTexture(size, size);
    this.rt.depthTexture.format = THREE.DepthFormat;
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.rt.depthTexture.minFilter = THREE.NearestFilter;
    this.rt.depthTexture.magFilter = THREE.NearestFilter;

    // fov and far are overwritten from the live lamp every update.
    this.cam = new THREE.PerspectiveCamera(85, 1, near, 30);
    this.cam.layers.set(SHADOW_LAYER);

    /* Depth-only override. A MeshBasicMaterial still writes depth, costs no
     * shading, and - crucially - sidesteps every ShaderMaterial in the scene,
     * which is what keeps this pass at roughly the cost of its fill rather than
     * a second full evaluation of the water model. */
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });

    this.viewProj = new THREE.Matrix4();
    this.on = 1;
    this.biasScale = 1;

    this.uniforms = {
      uShadowMap: { value: this.rt.depthTexture },
      uLampVP: { value: this.viewProj },
      uShadowSize: { value: size },
      uShadowTanHalf: { value: Math.tan(0.74) },
      uShadowNear: { value: near },
      uShadowFar: { value: 30 },
      uShadowOn: { value: 1 },
      /* A multiplier on the derived bias, exposed as ?shadowbias=. Not a tuning
       * knob to be left at whatever looks best - it is how self-shadow acne is
       * told apart from a real cast shadow. Acne is a bias failure and largely
       * disappears when the bias is raised several fold; a real shadow does
       * not. Anything other than 1.0 in a committed build means the derivation
       * in glsl.js is wrong and should be fixed rather than scaled. */
      uShadowBiasScale: { value: 1 },
    };

    this._target = new THREE.Vector3();
  }

  /** Write this pass's uniforms into a material that declares them. */
  applyTo(u) {
    if (!u || !u.uShadowMap) return;
    u.uShadowMap.value = this.rt.depthTexture;
    u.uLampVP.value.copy(this.viewProj);
    u.uShadowSize.value = this.size;
    u.uShadowTanHalf.value = this.uniforms.uShadowTanHalf.value;
    u.uShadowNear.value = this.near;
    u.uShadowFar.value = this.uniforms.uShadowFar.value;
    u.uShadowOn.value = this.on;
    u.uShadowBiasScale.value = this.biasScale;
  }

  /**
   * Render the depth of every caster as seen from the lamp.
   * Call once per frame, before the scene is drawn.
   */
  update(scene, env) {
    const r = this.renderer;

    /* Switched off means costing nothing, not merely being ignored downstream.
     * The first version gated only the shader lookup, and the two survey runs
     * came back with identical draw and triangle counts - 36 and 2367k either
     * way - which is the signature of a pass that is still rendering into a map
     * nobody reads. A control that does not change the instrument is not a
     * control. With this early-out, shadows=0 measures 30 draws and 1714k
     * triangles: the pre-shadow baseline exactly. */
    if (!this.on) { this.uniforms.uShadowOn.value = 0; return; }
    this.uniforms.uShadowOn.value = 1;

    /* The lamp is head-mounted (main.js sets env.lampPos from the camera), so
     * the shadow camera is rebuilt every frame rather than cached. There is no
     * cheaper option: a light that moves with the eye has no static frustum. */
    const half = Math.acos(Math.max(-1, Math.min(1, env.lampCos)));
    const far = Math.max(8, env.visibility || 25);

    this.cam.fov = (2 * half) * 180 / Math.PI;
    this.cam.near = this.near;
    this.cam.far = far;
    this.cam.position.copy(env.lampPos);
    this._target.copy(env.lampPos).add(env.lampDir);
    this.cam.lookAt(this._target);
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld(true);

    this.viewProj.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    this.uniforms.uShadowTanHalf.value = Math.tan(half);
    this.uniforms.uShadowFar.value = far;
    this.uniforms.uShadowNear.value = this.near;

    const prevOverride = scene.overrideMaterial;
    const prevTarget = r.getRenderTarget();

    scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.rt);
    r.clear(true, true, false);
    r.render(scene, this.cam);

    scene.overrideMaterial = prevOverride;
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rt.dispose();
    this.depthMat.dispose();
  }
}
