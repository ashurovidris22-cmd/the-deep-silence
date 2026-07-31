/* Shared GLSL. Every material in the game injects WATER so that fogging is
 * computed one way in one place — the moment two surfaces disagree about how
 * light dies, the illusion of a single body of water is gone. */

/** Hash / value noise / fbm. No texture lookups, so it works in any pass. */
export const NOISE = /* glsl */`
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3=fract(p3*0.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }

/* Lattice coordinates are wrapped before hashing.
 *
 * These hashes are fract()-based, so their precision collapses once the input
 * grows: by the fourth octave of fbm at world scale the argument is in the
 * thousands, fract() runs out of mantissa, and the "random" values snap onto a
 * regular grid. On screen that is a lattice of dots crawling over every
 * surface — which looks exactly like a broken material and is in fact a broken
 * hash. Wrapping onto a 289-unit torus keeps the argument small. The repeat is
 * an order of magnitude beyond anything the water lets you see. */
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  vec2 i0=mod(i,289.0), i1=mod(i+1.0,289.0);
  return mix(mix(hash12(vec2(i0.x,i0.y)),hash12(vec2(i1.x,i0.y)),u.x),
             mix(hash12(vec2(i0.x,i1.y)),hash12(vec2(i1.x,i1.y)),u.x),u.y);
}

float vnoise3(vec3 p){
  vec3 i=floor(p), f=fract(p);
  vec3 u=f*f*(3.0-2.0*f);
  vec3 a=mod(i,289.0), b=mod(i+1.0,289.0);
  float n000=hash13(vec3(a.x,a.y,a.z)), n100=hash13(vec3(b.x,a.y,a.z));
  float n010=hash13(vec3(a.x,b.y,a.z)), n110=hash13(vec3(b.x,b.y,a.z));
  float n001=hash13(vec3(a.x,a.y,b.z)), n101=hash13(vec3(b.x,a.y,b.z));
  float n011=hash13(vec3(a.x,b.y,b.z)), n111=hash13(vec3(b.x,b.y,b.z));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y),
             mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y),u.z);
}

float fbm(vec2 p, int oct){
  float a=0.5, s=0.0, n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*vnoise(p); n+=a; p*=2.02; a*=0.5; }
  return s/max(n,1e-4);
}

/* Ridged noise. Erosion leaves creases, not dunes; plain fbm reads as cloth. */
float ridged(vec2 p, int oct){
  float a=0.5, s=0.0, n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break;
    float v=1.0-abs(vnoise(p)*2.0-1.0); v*=v;
    s+=a*v; n+=a; p*=2.03; a*=0.5; }
  return s/max(n,1e-4);
}

/* Interleaved gradient noise — the cheapest dither that does not band or
 * crawl. Used to offset raymarch start points so 32 steps look like 200. */
float ign(vec2 px){ return fract(52.9829189*fract(dot(px,vec2(0.06711056,0.00583715)))); }

/* Caustics.
 *
 * The bright web crawling over a sunlit seabed is the surface acting as a lens:
 * wave curvature focuses sunlight into caustic sheets. Tracing that honestly
 * means refracting through an animated surface, which is not worth it — but the
 * *shape* is characteristic and cheap to imitate. Two low-frequency fields
 * drifting against each other, and the ridge where they cross, raised to a
 * power: that gives the thin interlocking filaments rather than blobs.
 *
 * Tied to the daylight term by the caller, so it dies with the sunlight instead
 * of needing its own depth rule. Caustics require a direct beam; below a couple
 * of hundred metres there is none, and they must simply not be there. */
float caustic(vec2 p, float t){
  /* The two fields must be genuinely decorrelated, and that is the whole trick.
   *
   * Sampled at the same frequency with only a small time offset they are very
   * nearly the same field, so their difference is ~0 everywhere: 1 - |a-b|*k
   * comes out near 1 across the entire seabed and the result is a uniform lift
   * in brightness rather than a pattern. Large fixed spatial offsets make them
   * independent, so |a-b| ranges widely and the thin ridge where a and b happen
   * to cross becomes the caustic filament. */
  float a = fbm(p*0.55 + vec2( 11.3,  4.7) + vec2(t*0.045, t*0.031), 2);
  float b = fbm(p*0.55 + vec2(-37.2, 18.6) - vec2(t*0.037, t*0.052), 2);
  float w = pow(max(1.0 - abs(a - b) * 3.4, 0.0), 4.0);
  // A finer, faster pair so the strands have structure inside them.
  float a2 = fbm(p*1.9 + vec2( 61.5, -23.1) + vec2(t*0.085, -t*0.062), 2);
  float b2 = fbm(p*1.9 + vec2(-14.8,  52.4) - vec2(t*0.051, t*0.094), 2);
  float w2 = pow(max(1.0 - abs(a2 - b2) * 3.9, 0.0), 5.0);
  return w * 0.78 + w2 * 0.42;
}

/* Downwelling shafts, for use inside the ray march.
 *
 * Deliberately trigonometric rather than fbm-based: this is evaluated once per
 * march step, so a version costing eight hash rounds would cost two hundred and
 * fifty per pixel. Four sines buy the same broad interlocking columns at a
 * fraction of that, and the volume is blurred afterwards anyway. */
float shaftMask(vec2 p, float t){
  float s1 = sin(p.x*1.15 + t*0.13) * sin(p.y*0.95 - t*0.11);
  float s2 = sin(p.x*0.47 - t*0.07 + 1.7) * sin(p.y*0.58 + t*0.09);
  return pow(max(0.0, 0.5 + 0.5*(s1*0.62 + s2*0.38)), 3.0);
}
`;

/**
 * The water model. Two coefficients, used for two different jobs.
 *
 *   uExt  beam attenuation c=a+b : kills the light travelling from a surface
 *                                  to the eye, over the view distance.
 *   uKd   diffuse attenuation    : kills the daylight field as it descends,
 *                                  which is a function of depth, not distance.
 *
 * In-scattered light is what you actually see when nothing is there: the
 * ambient field at that depth, redirected into the eye by particles. So the
 * "fog colour" is not a constant — it darkens and shifts blue as you descend,
 * for free, because it is computed from depth every frame.
 */
export const WATER = /* glsl */`
uniform vec3  uExt;        // beam attenuation c = a+b, m^-1
uniform vec3  uKd;         // diffuse downwelling attenuation, m^-1
uniform vec3  uAlbedo;     // single-scattering albedo b/c, dimensionless
uniform vec3  uScat;       // scattering coefficient b, m^-1
uniform vec3  uSurfaceIrr; // irradiance just under the surface (linear HDR)
uniform float uSurfaceY;   // world Y of the sea surface
uniform float uScatterGain;
uniform vec3  uAmbientFloor; // bio/thermal glow that survives with no sun

/* Sunlight remaining at a given world height, and nothing else.
 *
 * Split out from ambientAt because the two are used for different jobs and
 * conflating them broke a documented promise. Caustics and downwelling shafts
 * are made *by the sun* — the terrain shader's own comment says they should be
 * "simply absent on the canyon floor, because that is what happens to the beam
 * that makes them". They were not absent: ambientAt adds the bio floor, which
 * never decays, so the caustic web kept riding on it at four hundred metres
 * where there has not been a photon of sunlight for a hundred and fifty. A
 * canyon floor with a sunlight caustic on it discredits the whole optical
 * model in one glance. */
vec3 sunAt(float worldY){
  float d = max(0.0, uSurfaceY - worldY);
  return uSurfaceIrr * exp(-uKd * d);
}

// Everything there is to see by: sunlight, plus the bio and thermal glow that
// survives when the sun does not. Use this for shading; use sunAt for anything
// that is specifically an effect of the beam.
vec3 ambientAt(float worldY){
  return sunAt(worldY) + uAmbientFloor;
}

// Colour of infinitely deep water in this direction — the fog colour.
vec3 waterInscatter(float worldY){
  return uAlbedo * ambientAt(worldY) * uScatterGain;
}

/* Beer-Lambert over the view ray, plus in-scatter filling in behind it.
 *
 * The in-scatter is sampled at an effective height, not at the surface being
 * looked at. Contribution from distance s along the ray is weighted by
 * exp(-c*s), so with a mean free path of about five metres almost all of it
 * comes from the water immediately in front of the lens — the far endpoint's
 * depth is nearly irrelevant. Evaluating at the endpoint instead put a visible
 * horizontal seam across the frame wherever distant seabed met open water,
 * because the two were being fogged to two different colours despite both being
 * hundreds of metres away and therefore both pure fog. */
/* Angular dependence of the in-scattered field.
 *
 * The water overhead genuinely is brighter than the water below, but not because
 * a ray pointed up passes through shallower water — at these distances the
 * in-scatter is dominated by the few metres in front of the lens either way. It
 * is brighter because the ambient field is downwelling and marine particles
 * scatter strongly forward: a ray aimed up the light's direction of travel
 * collects far more of it than one aimed at the seabed. Modelling it as an
 * angular term keeps the gradient while leaving the horizon continuous, which
 * sampling the ambient at a fake height did not. */
float inscatterAniso(vec3 dir){
  float u = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  // Centred so a horizontal ray comes out near 1.0. Anything else silently
  // rescales the exposure of the entire game while pretending to be a gradient.
  return mix(0.34, 1.85, pow(u, 1.3));
}

vec3 applyWater(vec3 color, vec3 worldPos){
  vec3 d = worldPos - cameraPosition;
  float dist = length(d);
  vec3 dir = d / max(dist, 1e-4);
  vec3 T = exp(-uExt * dist);
  float mfp = 1.0 / max(uExt.g, 1e-3);
  float w = clamp(mfp / max(dist, 1e-3), 0.0, 1.0);
  float yEff = mix(cameraPosition.y, worldPos.y, w);
  return color * T + waterInscatter(yEff) * inscatterAniso(dir) * (1.0 - T);
}

/* Light is attenuated on the way OUT to the surface as well as on the way back.
 *
 * Skipping this is the single most common shortcut in underwater rendering and
 * it is why so much of it looks like green fog with a torch in it: the lamp then
 * behaves like a lamp in air, keeping its colour and reach, and only the return
 * path is tinted. Applying it doubles the effective optical path, which is
 * exactly why real submersible lights are useful over metres rather than tens of
 * metres — and it is what makes close surfaces come back warm and olive while
 * anything past a few metres has had the red taken out of it. */
vec3 lampTransmit(float distToLamp){
  return exp(-uExt * distToLamp);
}

// Henyey-Greenstein phase. Marine particles are strongly forward-scattering
// (g~0.9), which is why a lamp pointed away from you is nearly invisible and
// one pointed at you blinds — the halo is physics, not a lens effect.
float phaseHG(float cosT, float g){
  float g2 = g*g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0*g*cosT, 1.5));
}
`;

/** The lamp: one owner for the cone, and the occlusion test that goes with it.
 *
 * Before this chunk existed the cone falloff was written out ten times across
 * six files - flora four times, props twice, and once each in post, snow,
 * structures and terrain - and every copy declared its own uniform block. They
 * had already drifted: all six sets of defaults still said cos(0.42), intensity
 * 90 and softness 0.30, while the live values in Env are cos(0.74), 900 and
 * 0.34. Nothing showed, because Env.applyTo overwrites them every tick - but a
 * material that ever failed to register would have rendered a 24 degree cone at
 * a tenth of the intensity, and looked merely wrong rather than broken.
 *
 * Attenuation is deliberately NOT folded in here. The three forms in the
 * codebase differ for reasons rather than by drift: surfaces use 1/(6 + d^2)
 * where the 6 is a finite lens rather than a mathematical point, the volumetric
 * march uses 1/(1 + 0.9 d^2), and marine snow uses 1/(1 + 4.5 d^2) to keep
 * particles from lighting up across the whole beam. One owner per fact means
 * one owner for the cone; it does not mean pretending three facts are one.
 */
export const LAMP = /* glsl */`
uniform vec3 uLampPos;
uniform vec3 uLampDir;
uniform vec3 uLampCol;
uniform float uLampInt;
uniform float uLampCos;
uniform float uLampSoft;

uniform sampler2D uShadowMap;
uniform mat4 uLampVP;
uniform float uShadowSize;
uniform float uShadowTanHalf;
uniform float uShadowNear;
uniform float uShadowFar;
uniform float uShadowOn;
uniform float uShadowBiasScale;

/* The cone. Brightest on axis, zero at uLampCos - uLampSoft brightens the core
 * inward, it does not widen the edge. */
float lampCone(vec3 L){
  return smoothstep(uLampCos, uLampCos + uLampSoft, dot(-L, normalize(uLampDir)));
}

// Stored depth -> metres along the lamp's forward axis.
float lampLinear(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uShadowNear * uShadowFar) /
         (uShadowFar + uShadowNear - z * (uShadowFar - uShadowNear));
}

/* Is this point lit by the lamp, or is something in the way?
 * Returns 1 for lit, 0 for fully occluded.
 *
 * The comparison is done in metres rather than in depth-buffer units, so the
 * bias below can be a real distance derived from real geometry instead of a
 * magic constant.
 *
 * Bias is slope-scaled, and the scale is the texel's own footprint. One texel
 * covers 2*d*tan(half)/N metres at distance d - 1.8 cm at ten metres on a
 * 1024 map - and a surface tilted by theta rises by that footprint times
 * tan(theta) across it, which is exactly the depth difference that shows up as
 * acne. The clamp on that slope term is stated once, at the line that applies
 * it, and deliberately not repeated here: this comment said four texels while
 * the code said twelve for as long as both existed, which is one fact written
 * down in two places and then allowed to disagree with itself. */
float lampShadow(vec3 worldPos, vec3 n){
  if(uShadowOn < 0.5) return 1.0;
  /* ?shadows=2 forces full occlusion. A bisect handle, not a feature: if the
   * frame does not change with this on, the fault is upstream of the lookup -
   * the uniforms are not arriving - and no amount of staring at the projection
   * maths will find it. */
  /* Note the upper bound. Without it this early-out swallows every mode above
   * it, and modes 3, 4 and 5 below are unreachable code that silently reports
   * mode 2's answer instead - which is exactly what happened, three times, and
   * was read as three independent confirmations. */
  if(uShadowOn > 1.5 && uShadowOn < 2.5) return 0.0;

  /* Normal offset, sized by the texel's own footprint at this distance.
   *
   * Moving the sample point off the surface along its normal is what actually
   * cures grazing-angle acne; depth bias alone cannot, because at 85 degrees
   * the depth error across one texel is larger than any bias small enough to
   * keep contact shadows attached. Two texels of offset is the standard figure
   * and is a real distance here: 3.6 cm at ten metres on a 1024 map. */
  float d0 = distance(uLampPos, worldPos);
  float texel0 = 2.0 * d0 * uShadowTanHalf / uShadowSize;
  vec4 lp = uLampVP * vec4(worldPos + n * texel0 * 2.0, 1.0);
  if(lp.w <= 0.0) return 1.0;                 // behind the lamp
  vec3 ndc = lp.xyz / lp.w;
  if(any(greaterThan(abs(ndc.xy), vec2(1.0)))) return 1.0;   // outside the map
  vec2 uv0 = ndc.xy * 0.5 + 0.5;

  float dist = lp.w;                          // metres along the lamp axis
  if(dist >= uShadowFar) return 1.0;          // past the visibility limit

  /* ?shadows=4 returns the stored depth itself as the light factor.
   *
   * Mode 2 returns above all three early-outs, so it can only show that the
   * uniforms arrive and that the pixel is lamp-lit. It cannot tell an empty
   * shadow map from a full one - and an EMPTY map is the dangerous case,
   * because it holds 1.0 everywhere, so every depth test passes and every
   * pixel comes out lit, which is indistinguishable from "nothing is occluding
   * anything". Under this mode an empty map darkens nothing at all while a
   * populated one paints a gradient, so the two finally separate. */
  if(uShadowOn > 5.5){
    /* ?shadows=6 asks whether the map and the matrix that reads it agree.
     *
     * A lamp-lit floor pixel is, by definition, the nearest surface along its
     * own ray from the lamp, so the depth pass must have written that pixel's
     * OWN depth into the map. Comparing the stored value against ndc.z from the
     * same uLampVP tests exactly that, and does it in window units, so it is
     * immune to any disagreement about near, far or fov between the pass camera
     * and these uniforms - which a comparison in metres is not. Dark means the
     * map disagrees with its own matrix, i.e. the two are not the same camera. */
    float own = ndc.z * 0.5 + 0.5;
    float stored = texture2D(uShadowMap, uv0).x;
    return abs(stored - own) < 0.002 ? 1.0 : 0.0;
  }
  if(uShadowOn > 4.5){
    /* ?shadows=5 is a picture of the map's CONTENTS: black wherever the stored
     * depth is nearer than the far plane, i.e. wherever a caster was actually
     * drawn into the map, and unchanged where the map is still at its cleared
     * value. Mode 4 gives the depth as a brightness, which is ambiguous at both
     * ends; this one answers the single question "was anything rendered here". */
    return step(0.999, texture2D(uShadowMap, uv0).x);
  }
  if(uShadowOn > 3.5) return texture2D(uShadowMap, uv0).x;

  /* ?shadows=3 darkens everything the map actually covers, whatever the depth
   * test then says: its footprint on screen, and nothing else. */
  if(uShadowOn > 2.5) return 0.0;

  vec3 L = normalize(uLampPos - worldPos);
  float ndl = clamp(dot(n, L), 0.0, 1.0);
  float texelWorld = 2.0 * dist * uShadowTanHalf / uShadowSize;
  float slope = sqrt(max(0.0, 1.0 - ndl*ndl)) / max(ndl, 0.05);
  /* Twelve texels, not four.
   *
   * Four was chosen on the argument that by 85 degrees of incidence the ndl
   * term has taken the light to nothing anyway, so the shortfall could not
   * show. That argument came from Lambert, and the seabed does not use Lambert:
   * silt is dusty and has no hard terminator, so terrain.js wraps the diffuse
   * as (dot(n,L)+0.28)/1.28, which is still 0.22 at ninety degrees. The light
   * was very much still there, and so was the acne - a measured 26 percent of
   * the floor frame, which vanished when the bias was raised, which is the
   * signature of a bias failure rather than a shadow.
   *
   * Twelve is the measured requirement at 85 degrees (11.4), rounded up. */
  float bias = (texelWorld * min(slope, 12.0) + texelWorld * 0.5) * uShadowBiasScale;

  vec2 uv = uv0;
  vec2 texel = vec2(1.0 / uShadowSize);

  /* 3x3 PCF. Not for softness - the penumbra it invents is 5 cm at ten metres,
   * while the 18 cm lens of a real flood would cast 72 cm at the same distance,
   * so this is thirteen times too hard to be mistaken for physics. It is here
   * to hide the texel grid on the edge, and the honest soft shadow is a
   * separate job. */
  float lit = 0.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      float s = texture2D(uShadowMap, uv + vec2(float(x), float(y)) * texel).x;
      lit += (dist - bias <= lampLinear(s)) ? 1.0 : 0.0;
    }
  }
  return lit / 9.0;
}
`;

/** Fullscreen triangle. One vertex shader for every post pass. */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Reconstruct view-space depth from a non-linear depth buffer sample. */
export const DEPTH_UTIL = /* glsl */`
uniform float uNear;
uniform float uFar;
float linearDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
`;
