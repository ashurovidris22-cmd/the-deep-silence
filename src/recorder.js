import * as THREE from 'three';
import { WATER, LAMP } from './glsl.js';

/* The first reason to leave the hull.
 *
 * A recorder is better than a generic collectible here because it is evidence:
 * somebody put it beside the wreck, it kept listening after they did not come
 * back, and recovering it is the action that lets the acoustic mimic answer more
 * aggressively. The interaction is held rather than tapped, so finding the box
 * and committing to four exposed seconds are two different decisions. */
export const RECOVERY_TIME = 4.2;
export const INTERACT_RANGE = 2.15;
export const CARRY_EFFORT = 0.22;       // extra metabolic O2, litres/min

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class RecorderState {
  constructor(position = { x: 0, y: 0, z: 0 }) {
    this.position = new THREE.Vector3(position.x, position.y, position.z);
    this.home = this.position.clone();
    this.phase = 'sealed';              // sealed | extracting | carried | returned
    this.progress = 0;
    this.carrier = null;
    this.recovered = false;
  }

  get carrying() { return this.phase === 'carried'; }
  get complete() { return this.phase === 'returned'; }
  get disturbance() {
    return this.complete ? 0 : this.carrying ? 1 : this.phase === 'extracting' ? 0.45 : 0;
  }
  rangeTo(p) { return this.position.distanceTo(p); }

  begin(p) {
    if (this.phase !== 'sealed' || this.rangeTo(p) > INTERACT_RANGE) return false;
    this.phase = 'extracting';
    return true;
  }

  update(dt, { swimmer, holding = false, outside = false }) {
    if (this.phase === 'extracting') {
      if (!outside || !holding || this.rangeTo(swimmer) > INTERACT_RANGE + 0.35) {
        this.phase = 'sealed';
        this.progress = Math.max(0, this.progress - dt * 1.8);
      } else {
        this.progress = clamp01(this.progress + dt / RECOVERY_TIME);
        if (this.progress >= 1) {
          this.phase = 'carried';
          this.recovered = true;
        }
      }
    }
    if (this.phase === 'carried') {
      this.position.copy(swimmer).add(new THREE.Vector3(0.34, -0.42, -0.18));
    }
  }

  deliver(aboard) {
    if (!aboard || this.phase !== 'carried') return false;
    this.phase = 'returned';
    this.carrier = null;
    return true;
  }

  drop(p) {
    if (this.phase !== 'carried') return false;
    this.phase = 'sealed';
    this.progress = 0;
    this.position.copy(p);
    return true;
  }
}

function recorderMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uExt: { value: new THREE.Vector3() }, uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() }, uScat: { value: new THREE.Vector3() },
      uSurfaceIrr: { value: new THREE.Vector3() }, uSurfaceY: { value: 0 },
      uScatterGain: { value: 1 }, uAmbientFloor: { value: new THREE.Vector3() },
      uLampPos: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0,0,-1) },
      uLampCol: { value: new THREE.Vector3(1,0.97,0.92) }, uLampInt: { value: 900 },
      uLampCos: { value: Math.cos(0.74) }, uLampSoft: { value: 0.34 },
      uShadowMap: { value: null }, uLampVP: { value: new THREE.Matrix4() },
      uShadowSize: { value: 1024 }, uShadowTanHalf: { value: Math.tan(0.74) },
      uShadowNear: { value: 0.25 }, uShadowFar: { value: 30 }, uShadowOn: { value: 0 },
      uShadowBiasScale: { value: 1 }, uTime: { value: 0 }, uRecovered: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vW, vN;
      void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;
        vN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      ${LAMP}
      varying vec3 vW, vN; uniform float uTime, uRecovered;
      void main(){
        vec3 L=uLampPos-vW; float d=length(L); vec3 ld=L/max(d,0.001);
        float light=lampCone(-ld)*clamp((dot(normalize(vN),ld)+0.18)/1.18,0.0,1.0)
          *uLampInt/(6.0+d*d)*lampShadow(vW,normalize(vN));
        vec3 lit=uLampCol*light*lampTransmit(d);
        vec3 base=vec3(0.024,0.031,0.028)*(ambientAt(vW.y)+lit);
        float pulse=pow(max(0.0,sin(uTime*2.35)),18.0)*(1.0-uRecovered);
        vec3 lamp=vec3(2.8,0.36,0.045)*pulse;
        gl_FragColor=vec4(applyWater(base+lamp,vW),1.0);
      }`,
  });
}

export class DeepRecorder extends RecorderState {
  constructor(env, position) {
    super(position);
    this.root = new THREE.Group(); this.root.name = 'deepRecorder';
    this.material = recorderMaterial(); env.register(this.material);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.15, 12), this.material);
    body.rotation.z = Math.PI / 2;
    const cage = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.055, 6, 16), this.material);
    cage.rotation.y = Math.PI / 2;
    const capA = cage.clone(); capA.position.x = -0.48;
    const capB = cage.clone(); capB.position.x = 0.48;
    this.root.add(body, capA, capB);
    this.root.position.copy(this.position);
    this.root.rotation.set(0.18, -0.62, 0.24);
  }

  update(dt, state) {
    super.update(dt, state);
    this.root.visible = !this.complete;
    this.root.position.copy(this.position);
    if (this.carrying) {
      this.root.rotation.x += dt * 0.7;
      this.root.rotation.z += dt * 0.5;
    }
    this.material.uniforms.uRecovered.value = this.recovered ? 1 : 0;
  }
}
