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

// Daylight remaining at a given world height.
vec3 ambientAt(float worldY){
  float d = max(0.0, uSurfaceY - worldY);
  return uSurfaceIrr * exp(-uKd * d) + uAmbientFloor;
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
