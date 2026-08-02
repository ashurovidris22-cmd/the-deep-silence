import * as THREE from 'three';
import { WATER, LAMP } from './glsl.js';

/* The first inhabitant: the body that eventually answers for the acoustic mimic.
 *
 * It is not a pursuing enemy. It learns the trunk signal, stays outside a useful
 * view of the whole animal, and crosses the edge of the lamp only after the player
 * has spent enough time teaching it. Its weapon remains time: turning to inspect
 * it costs scrubber life, while shining the lamp at it makes it bend away rather
 * than attack.
 *
 * Movement is derived from the Strouhal relation used by efficient swimmers:
 * St = f A / U. Nothing here owns a hand-tuned animation rate. */
export const STROUHAL = 0.30;
export const BODY_LENGTH = 13.5;
export const TAIL_AMPLITUDE = 1.35;

export function tailbeatFrequency(speed, amplitude = TAIL_AMPLITUDE) {
  return Math.max(0, STROUHAL * Math.max(0, speed) / Math.max(0.01, amplitude));
}

/* Stiff skull, increasingly flexible rear body. Monotonic by construction, and
 * exported because the arithmetic belongs in the dynamics harness. */
export function amplitudeEnvelope(s) {
  const x = Math.max(0, Math.min(1, s));
  return Math.pow(Math.max(0, (x - 0.16) / 0.84), 1.7);
}

export function mimicPresence(learnSeconds, range) {
  const learned = Math.max(0, Math.min(1, (learnSeconds - 28) / 52));
  const openWater = Math.max(0, Math.min(1, (range - 18) / 20));
  return learned * openWater;
}

function bodyGeometry() {
  /* A tapered chain of elliptical rings, head at +Z and tail at -Z. Keeping arc
   * position as aBody lets the vertex shader bend the real mesh without skinning. */
  const rings = 34, sides = 18;
  const pos = [], nrm = [], along = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const s = r / rings;              // 0 tail, 1 head
    const z = (s - 0.5) * BODY_LENGTH;
    const bulk = Math.sin(Math.PI * Math.pow(s, 0.82));
    const rx = 0.10 + 0.82 * Math.pow(Math.max(0, bulk), 0.72);
    const ry = 0.08 + 0.54 * Math.pow(Math.max(0, bulk), 0.85);
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2;
      pos.push(Math.cos(a) * rx, Math.sin(a) * ry, z);
      nrm.push(Math.cos(a), Math.sin(a), 0);
      along.push(s);
    }
  }
  for (let r = 0; r < rings; r++) for (let i = 0; i < sides; i++) {
    const a = r * sides + i, b = r * sides + (i + 1) % sides;
    const c = (r + 1) * sides + (i + 1) % sides, d = (r + 1) * sides + i;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBody', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

function creatureMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uExt: { value: new THREE.Vector3() }, uKd: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3() }, uScat: { value: new THREE.Vector3() },
      uSurfaceIrr: { value: new THREE.Vector3() }, uSurfaceY: { value: 0 },
      uScatterGain: { value: 1 }, uAmbientFloor: { value: new THREE.Vector3() },
      uLampPos: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0, 0, -1) },
      uLampCol: { value: new THREE.Vector3(1, 0.97, 0.92) }, uLampInt: { value: 900 },
      uLampCos: { value: Math.cos(0.74) }, uLampSoft: { value: 0.34 },
      uShadowMap: { value: null }, uLampVP: { value: new THREE.Matrix4() },
      uShadowSize: { value: 1024 }, uShadowTanHalf: { value: Math.tan(0.74) },
      uShadowNear: { value: 0.25 }, uShadowFar: { value: 30 }, uShadowOn: { value: 0 },
      uShadowBiasScale: { value: 1 },
      uTime: { value: 0 }, uFrequency: { value: 0.4 }, uSpeed: { value: 0.8 },
      uReveal: { value: 0 },
    },
    transparent: true,
    vertexShader: /* glsl */`
      attribute float aBody;
      varying vec3 vW, vN; varying float vBody;
      uniform float uTime, uFrequency, uSpeed;
      void main(){
        float tail = pow(clamp((0.84-aBody)/0.84,0.0,1.0),1.7);
        float phase = 6.2831853 * (aBody * 1.18 - uFrequency * uTime);
        vec3 p = position;
        p.x += sin(phase) * tail * ${TAIL_AMPLITUDE.toFixed(2)};
        p.y += sin(phase * 0.5 + 1.7) * tail * 0.16;
        vec4 w = modelMatrix * vec4(p,1.0);
        vW=w.xyz; vN=normalize(mat3(modelMatrix)*normal); vBody=aBody;
        gl_Position=projectionMatrix*viewMatrix*w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      ${WATER}
      ${LAMP}
      varying vec3 vW, vN; varying float vBody;
      uniform float uTime, uReveal;
      void main(){
        vec3 L=uLampPos-vW; float d=length(L); vec3 ld=L/max(d,0.001);
        float cone=lampCone(-ld);
        float diffuse=clamp((dot(normalize(vN),ld)+0.20)/1.20,0.0,1.0);
        float light=cone*diffuse*uLampInt/(6.0+d*d)*lampShadow(vW,normalize(vN));
        vec3 lit=uLampCol*light*lampTransmit(d);
        vec3 skin=mix(vec3(0.007,0.010,0.012),vec3(0.020,0.032,0.029),smoothstep(0.25,0.95,vBody));
        skin*=0.72+0.28*sin(vBody*48.0+sin(vBody*13.0));
        vec3 color=skin*(ambientAt(vW.y)+lit);
        /* Photophores arrive before the reflective body. A broken, asymmetric line
         * cannot be confused with the trunk's two-pulse strobe. */
        float beads=pow(max(0.0,sin(vBody*88.0-0.7)),22.0);
        float flank=pow(1.0-abs(normalize(vN).y),5.0);
        float pulse=0.45+0.55*pow(max(0.0,sin(uTime*0.73+vBody*9.0)),3.0);
        color += vec3(0.02,1.8,1.15)*beads*flank*pulse*(0.15+0.85*uReveal);
        gl_FragColor=vec4(applyWater(color,vW),uReveal);
      }`,
  });
}

export class AcousticMimic {
  constructor(env) {
    this.root = new THREE.Group(); this.root.name = 'acousticMimic';
    this.material = creatureMaterial(); env.register(this.material);
    this.body = new THREE.Mesh(bodyGeometry(), this.material);
    this.body.frustumCulled = false; this.root.add(this.body);
    this.root.visible = false; this.spawned = false;
    this.angle = 1.3; this.radius = 32; this.speed = 0.9;
    this.target = new THREE.Vector3(); this.heading = new THREE.Vector3(0,0,1);
    this._wanted = new THREE.Vector3(); this._away = new THREE.Vector3();
  }

  update(dt, { swimmer, boatRange, outside, lampPos, lampDir, learn, disturbance = 0 }) {
    /* Pulling the recorder free broadcasts vibration through its frame. It does
     * not spawn a pursuer; it lets the existing observer close sooner and swim
     * harder, preserving the creature's rule while making recovery consequential. */
    const basePresence = outside ? mimicPresence(learn, boatRange) : 0;
    const presence = Math.max(basePresence, outside && boatRange > 18 ? disturbance * 0.72 : 0);
    this.root.visible = presence > 0.015;
    this.material.uniforms.uReveal.value += (presence - this.material.uniforms.uReveal.value)
      * (1 - Math.exp(-dt / 1.8));
    if (!this.root.visible) return;
    if (!this.spawned) {
      this.root.position.set(swimmer.x + Math.cos(this.angle) * this.radius,
        swimmer.y + 1.4, swimmer.z + Math.sin(this.angle) * this.radius);
      this.spawned = true;
    }

    /* It closes only to the edge of useful visibility. The better it has learned,
     * the more of the body may resolve, but the whole 13.5 m animal is never offered
     * broadside in clear water. */
    const desiredRadius = 31 - presence * 13 - disturbance * 2.5;
    this.radius += (desiredRadius - this.radius) * (1 - Math.exp(-dt / 8));
    this.speed = 0.72 + presence * 0.72 + disturbance * 0.28;
    this.angle += dt * this.speed / Math.max(8, this.radius);
    this.target.set(swimmer.x + Math.cos(this.angle) * this.radius,
      swimmer.y + Math.sin(this.angle * 0.47) * 2.2,
      swimmer.z + Math.sin(this.angle) * this.radius);

    /* Light is a decision. If the swimmer catches it in the cone at short range,
     * it shears away instead of charging, spending distance and time. */
    this._away.copy(this.root.position).sub(lampPos);
    const dist = this._away.length();
    const caught = dist < 24 && this._away.normalize().dot(lampDir) > 0.78;
    if (caught) this.target.addScaledVector(this._away, 9.0);

    this._wanted.copy(this.target).sub(this.root.position);
    const step = Math.min(this._wanted.length(), this.speed * dt);
    if (step > 1e-4) {
      this.heading.lerp(this._wanted.normalize(), 1 - Math.exp(-dt / 1.1)).normalize();
      this.root.position.addScaledVector(this.heading, step);
      this.root.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), this.heading);
    }
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uSpeed.value = this.speed;
    this.material.uniforms.uFrequency.value = tailbeatFrequency(this.speed);
  }
}
