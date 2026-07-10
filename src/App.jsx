import React, { useLayoutEffect, useRef, useMemo, useState, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, ScrollControls, useScroll, Billboard, useTexture } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette, BrightnessContrast, HueSaturation } from '@react-three/postprocessing'
import * as THREE from 'three'

// --- Animated coffee steam (procedural rising-wisps shader on a billboard) ---
const STEAM_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const STEAM_FRAG = `
uniform float uTime; uniform float uOpacity; varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 p){ float v=0.0, amp=0.5; for(int i=0;i<5;i++){ v+=amp*noise(p); p*=2.0; amp*=0.5; } return v; }
void main(){
  vec2 uv = vUv;
  float t = uTime;
  // two noise octaves rising at different speeds + sway = billowing looping smoke
  float sway = sin(uv.y*4.0 + t*0.9)*0.12 * uv.y;      // more sway higher up
  vec2 p1 = vec2(uv.x*3.5 + sway, uv.y*4.5 - t*0.5);
  vec2 p2 = vec2(uv.x*6.0 - sway, uv.y*7.0 - t*0.85);
  float n = fbm(p1)*0.65 + fbm(p2)*0.35;
  n = pow(clamp(n,0.0,1.0), 1.4);                       // contrast -> defined wisps
  // vertical envelope: start right at the cup, fade out near the top
  float envY = smoothstep(0.0,0.12,uv.y) * (1.0 - smoothstep(0.55,1.0,uv.y));
  // horizontal plume: wide at base, narrowing as it rises
  float w = mix(0.45,0.12,uv.y);
  float envX = smoothstep(w,0.0, abs(uv.x-0.5));
  float a = clamp(n*envY*envX, 0.0, 1.0) * uOpacity;
  gl_FragColor = vec4(vec3(0.96,0.97,1.0), a);
}
`
function Steam({ position }) {
  const mat = useRef()
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uOpacity: { value: 0.72 } }), [])
  useFrame((_, dt) => { if (mat.current) mat.current.uniforms.uTime.value += Math.min(dt, 0.05) })
  return (
    <Billboard position={position}>
      <mesh>
        <planeGeometry args={[0.15, 0.28]} />
        <shaderMaterial
          ref={mat}
          transparent
          depthWrite={false}
          uniforms={uniforms}
          vertexShader={STEAM_VERT}
          fragmentShader={STEAM_FRAG}
        />
      </mesh>
    </Billboard>
  )
}

// ============================================================================
// WEATHER SYSTEM  (extensible — add presets later: sunset, rainy, foggy, night, cloudy)
// Every preset fully describes the OUTSIDE look: sky gradient + sun + clouds + the
// scene's key light + ambient/fill + optional fog. The outside GEOMETRY never changes
// between weathers — only these lighting/atmosphere values do. Switch by changing
// ACTIVE_WEATHER (later: drive from UI state).
// glTF/three.js world space: +X right, +Y up, window/outside is at -Z (into the scene).
// ============================================================================
const WEATHER = {
  sunnyMorning: {
    sky: {
      top:      [0.09, 0.38, 0.94],   // deeper saturated zenith blue (more vibrant sky)
      horizon:  [0.52, 0.76, 0.98],   // clean blue horizon (less milky white)
      sunDir:   [0.34, 0.55, -0.76],  // up + slightly right + toward the window (-Z)
      sunColor: [1.0, 0.95, 0.84],
      sunSize:  0.006,
      cloud:    0.40,                 // coverage 0..1 — mostly blue with a few puffy clouds
      cloudColor: [1.0, 1.0, 1.0],
      cloudSpeed: 0.008,
    },
    // ── The scene has exactly THREE lights (see Lights() + the lamp in App): (1) the SUN,
    // (2) a single room AMBIENT fill, (3) the table lamp. Both values below are weather-driven —
    // other weather presets just change these numbers; no other lights to juggle.
    sun:     { color: '#ffe8bf', intensity: 3.6 },   // (1) sunlight raking in through the window (-Z)
    ambient: { color: '#e7e3f0', intensity: 0.9 },   // (2) subtle room ambient (bounced sky/ceiling fill)
    fog:     null,                    // clear morning (rainy/foggy presets will set this later)
  },
}
const ACTIVE_WEATHER = 'sunnyMorning'
const wx = () => WEATHER[ACTIVE_WEATHER]

// --- Procedural sky dome (gradient + sun disc/glow + drifting fbm clouds) ---
// Follows the camera so it acts as an infinite skybox; only visible through the window.
const SKY_VERT = `
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
const SKY_FRAG = `
precision highp float;
varying vec3 vDir;
uniform vec3 uTop, uHorizon, uSunDir, uSunColor, uCloudColor;
uniform float uSunSize, uCloud, uCloudSpeed, uTime;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.02; a*=0.5;} return v; }
void main(){
  vec3 d = normalize(vDir);
  // vertical gradient by elevation — reach the saturated zenith colour sooner so the
  // mid-sky visible through the window reads as blue, not pale horizon.
  vec3 sky = mix(uHorizon, uTop, smoothstep(-0.05, 0.5, d.y));
  // sun disc + glow
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize*0.25, sd);
  // Softer sun: smaller broad bloom + gentler halo so the sky isn't washed to white
  // (blown highlights read as pale/desaturated — subtler light lets the blue stay vivid).
  float glow = pow(sd, 10.0)*0.18 + pow(sd, 200.0)*0.55;
  sky += uSunColor * (disc*1.05 + glow);
  // clouds: big puffy cumulus. Low-freq base shape + higher-freq detail, tight
  // smoothstep => defined billowy edges rather than a thin haze.
  vec2 uv = d.xz / (d.y*1.2 + 0.30);
  float base = fbm(uv*0.85 + vec2(uTime*uCloudSpeed, uTime*uCloudSpeed*0.5));
  float detail = fbm(uv*2.3 + 3.0);
  float n = base*0.78 + detail*0.22;
  float cover = 1.0 - uCloud;
  float cl = smoothstep(cover, cover+0.16, n) * smoothstep(0.02, 0.20, d.y);
  // shade cloud undersides slightly, brighten tops toward the sun for volume
  float shade = smoothstep(cover-0.05, cover+0.30, n);
  vec3 cc = mix(uCloudColor*0.82, uCloudColor, shade);
  cc = mix(cc, uSunColor, glow*0.5);
  sky = mix(sky, cc, clamp(cl, 0.0, 1.0)*0.96);
  gl_FragColor = vec4(sky, 1.0);
}
`
function Sky() {
  const mat = useRef()
  const mesh = useRef()
  const camera = useThree((s) => s.camera)
  const s = wx().sky
  const uniforms = useMemo(() => ({
    uTop:       { value: new THREE.Color().fromArray(s.top) },
    uHorizon:   { value: new THREE.Color().fromArray(s.horizon) },
    uSunDir:    { value: new THREE.Vector3().fromArray(s.sunDir) },
    uSunColor:  { value: new THREE.Color().fromArray(s.sunColor) },
    uCloudColor:{ value: new THREE.Color().fromArray(s.cloudColor) },
    uSunSize:   { value: s.sunSize },
    uCloud:     { value: s.cloud },
    uCloudSpeed:{ value: s.cloudSpeed },
    uTime:      { value: 0 },
  }), [])
  useFrame((_, dt) => {
    if (mat.current) mat.current.uniforms.uTime.value += Math.min(dt, 0.05)
    if (mesh.current) mesh.current.position.copy(camera.position) // infinite skybox
  })
  return (
    <mesh ref={mesh} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[30, 32, 16]} />
      <shaderMaterial ref={mat} side={THREE.BackSide} depthWrite={false}
        uniforms={uniforms} vertexShader={SKY_VERT} fragmentShader={SKY_FRAG} />
    </mesh>
  )
}

// --- Camera waypoints, read straight from scene.glb (glTF Y-up = Three.js space) ---
// Scroll timeline has two phases:
//   Phase A (0 -> 0.5): laptop opens, camera WEBSITE -> SCREEN
//   Phase B (0.5 -> 1): laptop stays open, camera SCREEN -> STANDEE
// Reverse scroll runs it backwards (standee -> open laptop -> laptop closes -> start).
// glTF can't store lens shift, so shiftY is applied to the projection in code.
const WEBSITE = {
  pos: new THREE.Vector3(0, 1.2, -0.25), // reference framing: all props visible, small gap under laptop
  quat: new THREE.Quaternion(0, 0, 0, 1),
  fov: 55, // narrower than before (was 73.94 ultra-wide) -> kills the wide-angle edge distortion
  shiftY: 0.0, // window was shortened so its white top frame stays in-frame at this distance
}
const SCREEN = {
  pos: new THREE.Vector3(0, 1.045, -0.702), // laptop @1.3x, moved +0.05 toward window; cam follows
  quat: new THREE.Quaternion(-0.04013, 0, 0, 0.99919), // ~4.6deg down-tilt: screen fills, keyboard cropped ~QWERTY row
  fov: 29.86,
  shiftY: 0.0,
}
const STANDEE = {
  pos: new THREE.Vector3(-0.41, 1.0358, -0.7377), // moved left 0.06 with the standee (clear of the leather mat)
  quat: new THREE.Quaternion(-0.06976, 0, 0, 0.99756), // straight-on to page (no yaw, 8deg tilt)
  fov: 41.25,
  shiftY: 0.0,
}
// Laptop opens by rotating Laptop_Hinge about local X (same axis/sign as Blender)
const HINGE_OPEN = THREE.MathUtils.degToRad(-100)
const PHASE = 0.5 // scroll split between the two phases

const smootherstep = (x) => {
  x = THREE.MathUtils.clamp(x, 0, 1)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

// Bump GLB_VERSION whenever scene.glb is re-exported so the browser can't serve a stale cached copy.
const GLB_URL = '/scene.glb?v=32'

// Lamp shade emissive when lit — kept above the bloom luminanceThreshold so the frosted shade
// picks up a soft warm bloom halo (the "glow"), without the daylight window blooming.
const LAMP_SHADE_GLOW = 1.6

// ── Device quality tier ─────────────────────────────────────────────────────────────
// The clear window uses a physically-based TRANSMISSION material (like the standee acrylic).
// In three r169 the transmission pass re-renders the whole scene at full viewport resolution
// every frame (MSAA + mipmaps) — gorgeous, but ~2x the render cost. That's fine on a capable
// GPU but can jank low-end / mobile. So we detect the device once and, on the LOW tier, fall
// back to a cheap near-clear alpha pane instead (our transmission has thickness=0, i.e. no
// refraction distortion — so the only thing the fallback loses is the subtle Fresnel edge
// sheen; the outside still reads just as clear + vibrant). We also trim DPR + shadow map there.
function detectQualityTier() {
  if (typeof navigator === 'undefined') return 'high'
  try {
    const ua = navigator.userAgent || ''
    const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)
    const cores = navigator.hardwareConcurrency || 8 // undefined (some browsers) -> don't penalize
    const mem = navigator.deviceMemory               // Chrome only; undefined elsewhere
    const lowMem = typeof mem === 'number' && mem <= 2 // only penalize genuinely constrained RAM
    let gpu = ''
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
    // software renderers + known-weak mobile GPUs -> transmission would jank
    const weakGpu = /(mali|adreno [1-5]\d\d|powervr|apple a[0-9] gpu|videocore|llvmpipe|swiftshader)/.test(gpu)
    // Mobile (any) and software/weak GPUs use the cheap fallback — transmission is a full-frame
    // re-render, worst on those. Desktops with real GPUs (incl. Safari/FF where deviceMemory is
    // unknown) keep the premium transmission look.
    if (mobile || weakGpu || cores <= 3 || lowMem) return 'low'
    return 'high'
  } catch (e) {
    return 'high'                                    // if detection fails, assume capable
  }
}
const QUALITY = detectQualityTier()
const HIGH_Q = QUALITY === 'high'

// ── Procedural stucco/troweled-plaster wall (runtime GLSL, 0 KB download) ──────────
// Warm sandy-beige plaster matching Ai references/photo-wall-texture-pattern: a fine
// granular grain (the sprayed/troweled tooth) over a slow low-freq mottle (uneven hand
// application), plus a cheap screen-space bump so the tooth catches the sun. Applied by
// mutating the GLB wall material in place via onBeforeCompile — no image maps, no GLB weight.
function applyStuccoWall(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.78, 0.68, 0.57) // light creamy skin-tone plaster (linear); shader mottles it
  m.roughness = 0.96
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBump = { value: 1.9 }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWallPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWallPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWallPos;
        uniform float uBump;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = h21(i), b = h21(i + vec2(1,0)), c = h21(i + vec2(0,1)), d = h21(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
        // FINE sprayed-plaster tooth: a dense high-freq speckle (the "pop"), contrast-pushed
        // so each grain reads as a distinct pit, layered over mid + coarse structure.
        float speckle(vec2 p){ float n = vnoise(p * 230.0); return n * n; }   // sharp dense dots
        float tooth(vec2 p){ return 0.50 * speckle(p) + 0.30 * fbm(p * 90.0) + 0.20 * fbm(p * 34.0); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 wuv = vWallPos.xy;                 // back wall lies in the XY plane
        float grain = tooth(wuv);
        float mott  = fbm(wuv * 3.2);           // slow troweled unevenness
        diffuseColor.rgb *= (0.84 + 0.26 * grain);   // fine granular light/shade (subtle on the pale wall)
        diffuseColor.rgb *= (0.94 + 0.12 * mott);    // large hand-applied patches
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.03, 1.00, 0.96), grain); // gently warm the high spots
        // Contact shadow (ambient occlusion) where the desk meets the wall: darken the wall
        // just above the desk's back edge (Y=0.85), fading up, only across the desk width.
        float aoBand = 1.0 - smoothstep(0.85, 1.06, vWallPos.y);      // strong at the desk line, fades up
        float aoX = smoothstep(1.18, 1.0, abs(vWallPos.x));           // only behind the desk (|x| < ~1.1)
        diffuseColor.rgb *= mix(1.0, 0.66, aoBand * aoX);             // subtle crevice darkening`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hgt = tooth(vWallPos.xy);
          vec3 bmp = vec3(dFdx(hgt), dFdy(hgt), 0.0) * uBump;
          normal = normalize(normal - bmp);       // strong fine tooth bump -> each grain catches the sun
        }`)
  }
  m.customProgramCacheKey = () => 'stucco-wall'
  m.needsUpdate = true
}

// ── Procedural whitewashed / limed-wood window frame (runtime GLSL, 0 KB download) ──
// White painted wood with subtle darker grain running vertically along the members (the
// prominent stiles + central divider), a broad patchy whitewash unevenness, and a faint
// grain bump. Ref: Ai references/white wooden frame with textures. Applied by mutating the
// GLB frame material in place — no image maps, no GLB weight (matches the desk/wall approach).
// mode: 0 = vertical grain, 1 = horizontal grain, 2 = auto (per-fragment by ring position).
// ctr/half describe the member's world-space bbox (used by auto to tell which side a
// fragment sits on). Grain runs along each member's LONG axis so top/bottom rails read
// horizontal and left/right stiles read vertical.
function applyWhitewashWood(m, opts = {}) {
  if (!m.isMeshStandardMaterial) return
  const { mode = 0, cx = 0, cy = 0, hw = 1, hh = 1 } = opts
  if (m.color) m.color.setRGB(0.87, 0.85, 0.80) // warm off-white paint (linear); shader adds grain
  m.roughness = 0.72
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBumpW = { value: 0.45 }
    shader.uniforms.uMode = { value: mode }
    shader.uniforms.uCtr = { value: new THREE.Vector2(cx, cy) }
    shader.uniforms.uHalf = { value: new THREE.Vector2(hw, hh) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWoodPos;
        uniform float uBumpW; uniform float uMode; uniform vec2 uCtr; uniform vec2 uHalf;
        float hw(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nw(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hw(i), b = hw(i + vec2(1,0)), c = hw(i + vec2(0,1)), d = hw(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbmw(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nw(p); p *= 2.03; a *= 0.5; } return s; }
        // FINE grain. grainV = vertical streaks (fast in X); grainH = horizontal (fast in Y).
        float grainV(vec2 wp){ return 0.6 * fbmw(vec2(wp.x * 78.0, wp.y * 8.0)) + 0.4 * fbmw(vec2(wp.x * 175.0, wp.y * 18.0)); }
        float grainH(vec2 wp){ return 0.6 * fbmw(vec2(wp.x * 8.0, wp.y * 78.0)) + 0.4 * fbmw(vec2(wp.x * 18.0, wp.y * 175.0)); }
        float woodGrain(vec2 wp){
          if (uMode < 0.5) return grainV(wp);
          if (uMode < 1.5) return grainH(wp);
          vec2 nrm = (wp - uCtr) / max(uHalf, vec2(1e-3));     // auto (ring): pick by which edge
          float t = smoothstep(-0.15, 0.15, abs(nrm.y) - abs(nrm.x)); // near top/bottom -> horizontal
          return mix(grainV(wp), grainH(wp), t);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gWood = woodGrain(vWoodPos.xy);
        float weather = fbmw(vWoodPos.xy * 2.6);              // broad patchy whitewash
        diffuseColor.rgb *= (0.93 + 0.08 * gWood);            // very subtle grain light/dark
        float line = smoothstep(0.30, 0.62, gWood);           // grain valleys -> faint tint lines
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.95, 0.92, 0.87), diffuseColor.rgb, line); // faint wood tone showing through
        diffuseColor.rgb *= (0.97 + 0.05 * weather);          // gentle uneven paint thickness`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 bmp = vec3(dFdx(gWood), dFdy(gWood), 0.0) * uBumpW;
          normal = normalize(normal - bmp);                   // faint grain relief
        }`)
  }
  m.customProgramCacheKey = () => 'whitewash-wood'
  m.needsUpdate = true
}

// ── Procedural rustic fence-plank wood (runtime GLSL, 0 KB download) ────────────────
// Weathered vertical pickets: per-plank tone variation (some warmer, some sun-greyed),
// vertical grain running up each board, dark seams between planks, occasional knots and
// faint weathering streaks + a grain bump. World-space (X across planks, Z up the grain),
// so it tiles correctly across the whole fence. Ref: Ai references/wooden-fence.
function applyFenceWood(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.30, 0.19, 0.11) // warm weathered brown (linear); shader varies it
  m.roughness = 0.92
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPlankW = { value: 0.105 }  // physical picket pitch (measured)
    shader.uniforms.uPlankOff = { value: -3.243 } // first picket start X -> cell seams fall in the gaps
    shader.uniforms.uCover = { value: 0.81 }     // board width / pitch (0.085/0.105)
    shader.uniforms.uBumpF = { value: 0.9 }
    shader.uniforms.uLineCount = { value: 6.0 }  // dark grain lines per board
    shader.uniforms.uLineStr = { value: 0.72 }   // how dark the grain lines get
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFencePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFencePos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFencePos;
        uniform float uPlankW; uniform float uPlankOff; uniform float uCover; uniform float uBumpF;
        uniform float uLineCount; uniform float uLineStr;
        float hf1(float n){ return fract(sin(n * 127.1) * 43758.5453); }
        float hf2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nf(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hf2(i), b = hf2(i + vec2(1,0)), c = hf2(i + vec2(0,1)), d = hf2(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbmf(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nf(p); p *= 2.03; a *= 0.5; } return s; }
        // returns grain value in .x, and the per-fragment brightness multiplier composited in the color chunk
        float fenceGrain(vec3 wp, out float edge, out vec3 tone, out float line){
          float t = (wp.x - uPlankOff) / uPlankW;   // aligned to the physical pickets
          float pid = floor(t);
          float fx = fract(t);                       // board surface occupies 0..uCover
          float r1 = hf1(pid), r2 = hf1(pid + 37.0), gph = r1 * 12.0;
          float fu = fx / uCover;                    // 0..1 across the board itself
          // soft base grain (stretched along Z)
          float g = 0.60 * fbmf(vec2(fu * 9.0 + gph, wp.z * 1.5)) + 0.40 * fbmf(vec2(fu * 24.0 + gph, wp.z * 3.6));
          // ── DARK vertical grain lines: a set of wandering lines running up the board ──
          float warp = fbmf(vec2(fu * 4.0 + gph, wp.z * 0.6)) * 0.20;   // gentle wander (not ruler-straight)
          float lc = (fu + warp) * uLineCount + gph;
          float lf = abs(fract(lc) - 0.5) * 2.0;                        // 0 at a line centre, 1 between
          line = 1.0 - smoothstep(0.0, 0.34, lf);                       // thin dark line
          line *= 0.45 + 0.55 * hf1(floor(lc) * 1.3 + gph);            // each line a different darkness
          line *= smoothstep(0.12, 0.55, fbmf(vec2(floor(lc) * 2.0, wp.z * 2.2))); // break/fade along length
          // per-board tone: lightness + warm-vs-sungreyed (stronger variation)
          float light = 0.72 + 0.52 * r1;
          float greyness = smoothstep(0.5, 0.95, r2);
          tone = mix(vec3(1.10, 0.90, 0.72), vec3(0.94, 0.93, 0.92), greyness) * light;
          // subtle shadow down each board's side edges (depth)
          edge = min(smoothstep(0.0, 0.06, fu), smoothstep(1.0, 0.94, fu));
          // occasional knot: dark ring at a per-board position
          vec2 kc = vec2(0.30 + 0.4 * r2, mix(-0.2, 0.9, hf1(pid + 11.0)));
          float kd = length((vec2(fu, wp.z) - kc) * vec2(1.0, 0.7));
          float knot = (1.0 - smoothstep(0.02, 0.09, kd)) * step(0.55, hf1(pid + 5.0));
          g = mix(g, 0.12, knot * 0.85);
          g = g - line * 0.5;                                           // lines recess into the board (for bump)
          return g;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fEdge; vec3 fTone; float fLine;
        float fG = fenceGrain(vFencePos, fEdge, fTone, fLine);
        diffuseColor.rgb *= fTone;                       // per-board colour variation
        diffuseColor.rgb *= (0.80 + 0.28 * clamp(fG, 0.0, 1.0)); // soft grain light/dark
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.34, 0.24, 0.17), fLine * uLineStr); // DARK brown grain lines
        diffuseColor.rgb *= mix(0.6, 1.0, fEdge);        // subtle side-edge shadow (gaps are real geo)
        float wstreak = fbmf(vec2(fract((vFencePos.x - uPlankOff) / uPlankW) * 4.0, vFencePos.z * 0.8));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.10, 1.06, 1.0), smoothstep(0.62, 0.92, wstreak) * 0.5);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float e; vec3 tn; float ln; float h = fenceGrain(vFencePos, e, tn, ln);
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * uBumpF;
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'fence-wood'
  m.needsUpdate = true
}

// ── Pleated fabric lampshade (runtime GLSL, 0 KB) ───────────────────────────────────
// Classic box-pleat shade: many vertical accordion folds running around the cone. Built
// from the azimuthal angle around the shade's vertical axis — a repeating triangle wave
// gives the fold profile (crease = dark valley, ridge = lit), which both shades the fabric
// and perturbs the surface normal so the folds catch real light in 3D. The warm emissive
// glow (when lit) is modulated by the same pattern so the pleats read while glowing too.
// cx/cz = shade world-space centre (axis) so the angle is measured about the true centre.
// Ref: Ai references/pleated lampshade. Replaces the plain opaque-shade setup.
function applyPleatedShade(m, cx, cz) {
  if (!m.isMeshStandardMaterial) return
  m.transparent = false
  m.opacity = 1.0
  m.depthWrite = true
  m.roughness = 0.9
  m.metalness = 0.0
  if (m.color) m.color.setRGB(0.93, 0.89, 0.80)      // off-white / warm cream fabric
  if (m.emissive) m.emissive.setRGB(1.0, 0.86, 0.62) // warm glow colour when lit
  m.emissiveIntensity = LAMP_SHADE_GLOW
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShadeCtr = { value: new THREE.Vector2(cx, cz) }
    shader.uniforms.uPleats = { value: 34.0 }      // number of folds around the cone
    shader.uniforms.uPleatDepth = { value: 0.20 }  // SOFT diffuse crease shading (off-state relief)
    shader.uniforms.uGlowDepth = { value: 0.42 }   // stronger crease darkening on the GLOW (on-state read)
    shader.uniforms.uReliefStr = { value: 0.9 }    // normal-bump strength for the folds (gentle)
    shader.uniforms.uGrain = { value: 0.06 }       // fine woven-fabric roughness amount
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShadePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vShadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vShadePos;
        uniform vec2 uShadeCtr; uniform float uPleats; uniform float uPleatDepth;
        uniform float uGlowDepth; uniform float uReliefStr; uniform float uGrain;
        // azimuth around the shade axis -> smooth ROUNDED fold (0 at a crease, 1 at a ridge)
        float pleatWave(vec3 p){
          float a = atan(p.x - uShadeCtr.x, p.z - uShadeCtr.y);
          return 0.5 + 0.5 * cos(a * uPleats);   // cosine = naturally soft, no hard edges
        }
        // cheap value noise for a fine woven-fabric grain
        float shHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        float shNoise(vec3 x){
          vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(shHash(i+vec3(0,0,0)),shHash(i+vec3(1,0,0)),f.x),
                         mix(shHash(i+vec3(0,1,0)),shHash(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(shHash(i+vec3(0,0,1)),shHash(i+vec3(1,0,1)),f.x),
                         mix(shHash(i+vec3(0,1,1)),shHash(i+vec3(1,1,1)),f.x),f.y),f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float plt = pleatWave(vShadePos);
        // gentle rounded fold shading only — no sharp seam line, so creases stay soft when unlit
        diffuseColor.rgb *= mix(1.0 - uPleatDepth, 1.0, plt);
        // fine woven grain: subtle brightness speckle across the fabric
        float grain = shNoise(vShadePos * 220.0);
        diffuseColor.rgb *= 1.0 + (grain - 0.5) * uGrain * 2.0;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float plt = pleatWave(vShadePos);
          // deeper crease darkening on the GLOW so pleats still read clearly while lit
          totalEmissiveRadiance *= mix(1.0 - uGlowDepth, 1.0, plt);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float h = pleatWave(vShadePos);
          float g = shNoise(vShadePos * 220.0);
          // gentle fold relief + faint grain roughness in the surface normal
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * uReliefStr
                   + vec3(dFdx(g), dFdy(g), 0.0) * uGrain * 1.5;
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'pleated-shade'
  m.needsUpdate = true
}

// ── Lamp wooden stem + base: polished honey-wood grain (runtime GLSL, 0 KB) ──────────
// The lamp's wooden parts (M_LampWood: stem, disc, base) ship as a flat solid colour.
// This paints procedural straight wood grain — warm honey tones, wavy figure lines, fine
// pore speckle and a touch of grain relief — so it reads as polished wood, not plastic.
// Pattern is a function of horizontal world position (constant along Y) => vertical streaks
// on the upright stem and a clean plank grain across the base.
function applyLampWood(m) {
  if (!m.isMeshStandardMaterial) return
  m.metalness = 0.0
  m.roughness = 0.5                 // polished-but-matte varnish
  if (m.color) m.color.setRGB(1, 1, 1) // let the shader drive colour fully
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLineFreq = { value: 95.0 } // grain lines per world unit (dense = fine grain)
    shader.uniforms.uFigFreq = { value: 6.0 }   // broad wavy-figure frequency
    shader.uniforms.uWarp = { value: 0.5 }      // how much the figure bends the grain lines
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWoodPos;
        uniform float uLineFreq; uniform float uFigFreq; uniform float uWarp;
        float wHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float wNoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(wHash(i), wHash(i+vec2(1,0)), f.x),
                     mix(wHash(i+vec2(0,1)), wHash(i+vec2(1,1)), f.x), f.y); }
        float wFbm(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<4;i++){ s += a*wNoise(p); p *= 2.0; a *= 0.5; } return s; }
        // fine vertical wood streaks: grain runs along Y, varies with horizontal position.
        // Lines are warped by a low-freq figure so they gently wave like real grain.
        float woodLines(vec2 xz){
          float fig = wFbm(xz * uFigFreq);
          float l = 0.5 + 0.5 * sin((xz.x * uLineFreq + fig * uWarp * uLineFreq) * 0.06283185);
          return pow(l, 2.0);   // thin dark grain lines between broad light bands
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 xz = vWoodPos.xz;
        float fig = wFbm(xz * uFigFreq);
        float lines = woodLines(xz);
        float pore = wFbm(xz * 120.0 + vWoodPos.y * 3.0);         // fine pore speckle
        vec3 lightWood = vec3(0.80, 0.48, 0.20);                   // honey highlight
        vec3 darkWood  = vec3(0.37, 0.18, 0.07);                   // grain line
        vec3 wood = mix(darkWood, lightWood, clamp(lines * 0.75 + fig * 0.3, 0.0, 1.0));
        wood *= 0.88 + pore * 0.22;                                // subtle tonal variation
        diffuseColor.rgb = wood;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float pr = wFbm(vWoodPos.xz * 120.0 + vWoodPos.y * 3.0);
          roughnessFactor = clamp(roughnessFactor + (pr - 0.5) * 0.18, 0.3, 0.7); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float h = woodLines(vWoodPos.xz);
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * 0.08;    // faint grain relief
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'lamp-wood'
  m.needsUpdate = true
}

// ── Window-glass dust: sparse subtle speckles clustered at the bottom of the pane ─────
// Runtime GLSL (0 KB). Concentrated toward the lower edge (pow(lower,6)) with sparse
// fine spots + a faint haze; renders as tiny frosted specks (local roughness bump) plus a
// whisper of light tint, so the glass reads as real glass without veiling the outside view.
// minY/maxY are the glass mesh's world-space vertical bounds (0 = bottom, 1 = top).
function applyGlassDust(m, minY, maxY, minX, maxX) {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader)
    shader.uniforms.uGMinY = { value: minY }
    shader.uniforms.uGMaxY = { value: maxY }
    shader.uniforms.uGMinX = { value: minX }
    shader.uniforms.uGMaxX = { value: maxX }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGDustPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGDustPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGDustPos; uniform float uGMinY; uniform float uGMaxY; uniform float uGMinX; uniform float uGMaxX;
        float gdHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float gdNoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(gdHash(i), gdHash(i+vec2(1,0)), f.x),
                     mix(gdHash(i+vec2(0,1)), gdHash(i+vec2(1,1)), f.x), f.y); }
        float glassDust(vec3 p){
          float h  = clamp((p.y - uGMinY) / max(uGMaxY - uGMinY, 1e-3), 0.0, 1.0); // 0 bottom, 1 top
          float nx = clamp((p.x - uGMinX) / max(uGMaxX - uGMinX, 1e-3), 0.0, 1.0); // 0 left, 1 right
          float leftBoost = smoothstep(0.55, 0.0, nx);          // stronger toward the left
          float bottomMask = pow(1.0 - h, 5.0) * (1.0 + leftBoost * 1.1); // bottom, extra on left
          float topLeftMask = smoothstep(0.5, 1.0, h) * smoothstep(0.5, 0.0, nx) * 0.8; // left-top cluster
          float mask = bottomMask + topLeftMask;
          float spots = smoothstep(0.86, 0.99, gdNoise(p.xy * 165.0))   // fine specks
                      + smoothstep(0.90, 0.995, gdNoise(p.xy * 320.0)) * 0.7; // extra finer specks
          float haze  = smoothstep(0.85, 1.0, gdNoise(p.xy * 60.0)) * 0.35; // faint low haze
          return clamp((spots + haze) * mask, 0.0, 1.0);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float gd = glassDust(vGDustPos); roughnessFactor = mix(roughnessFactor, 0.55, gd * 0.9); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float gd = glassDust(vGDustPos);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.89, 0.91), gd * 0.5);
          diffuseColor.a = mix(diffuseColor.a, 0.42, gd); }`)
  }
  m.customProgramCacheKey = () => 'glass-dust'
  m.needsUpdate = true
}

// ── Outside-scene vibrance boost (runtime GLSL, 0 KB) ───────────────────────────────
// The exterior objects (cherry tree, house, roof, hills, forest, ground) are lit by the
// same daylight as the room; through ACES tonemapping their midtones read a touch flat.
// This lifts their saturation AFTER tonemapping so the view through the window pops —
// deeper pinks/greens/blues — without touching the interior. Applied only to exterior
// meshes (fence/window frame/wall keep their own procedural materials untouched).
function applyOutsideVibrance(m, sat = 1.3) {
  if (!m.isMeshStandardMaterial || m.userData._vib) return
  m.userData._vib = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader)
    shader.uniforms.uSat = { value: sat }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSat;')
      .replace('#include <tonemapping_fragment>', `#include <tonemapping_fragment>
        { float _l = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = max(mix(vec3(_l), gl_FragColor.rgb, uSat), 0.0); } // saturate exterior`)
  }
  m.customProgramCacheKey = () => 'outside-vib'
  m.needsUpdate = true
}

function DeskScene({ lampOn, setLampOn }) {
  const { scene } = useGLTF(GLB_URL)
  const hinge = useRef(null)
  const camera = useThree((s) => s.camera)
  const scroll = useScroll()

  const tmpPos = useRef(new THREE.Vector3()).current
  const tmpQuat = useRef(new THREE.Quaternion()).current
  // Lamp emissive materials, collected during setup so the on/off tap can toggle them.
  const lampMats = useRef({ bulb: [], shade: [] }).current

  useLayoutEffect(() => {
    hinge.current = scene.getObjectByName('Laptop_Hinge')
    // NOTE: lamp/camera placement + rotation, the window lift, the window-opening wall fix, and
    // the camera's matte dark-grey finish now live in the Blender source (.blend) and are baked
    // into scene.glb. Keep object transforms/structure/material assignments in Blender; this file
    // only carries the runtime procedural materials (load-time) and device-tier glass swap.
    // Remove the exported camera nodes so they can't interfere
    ;['CAM_Website', 'CAM_Screen', 'CAM_Standee'].forEach((n) => {
      const c = scene.getObjectByName(n)
      if (c && c.parent) c.parent.remove(c)
    })
    // Strip any imported glTF lights (e.g. the lamp bulb) — we drive the warm
    // lamp light from React below for precise, tunable intensity.
    const lights = []
    scene.traverse((o) => { if (o.isLight) lights.push(o) })
    lights.forEach((l) => l.parent && l.parent.remove(l))
    // Window glass — HIGH tier: physically-based TRANSMISSION material, identical in approach
    // to the standee's clear acrylic (M_Acrylic: transmission=1, ior=1.45). Real refractive
    // glass renders the scene behind it, so the outside reads genuinely clear + vibrant.
    // thickness=0 keeps the view undistorted; a touch of roughness + the sun give edge sheen.
    // LOW tier: a cheap near-clear alpha pane (no transmission pass) — since thickness=0 there's
    // no refraction to lose, so the view looks the same, minus only the faint Fresnel edge sheen.
    // The sun still glints off it (roughness 0.04) so it reads as glass. Excludes M_CamGlass.
    const windowGlassMat = HIGH_Q
      ? new THREE.MeshPhysicalMaterial({
          transmission: 1.0,
          ior: 1.45,
          thickness: 0.0,
          roughness: 0.04,
          metalness: 0.0,
          color: new THREE.Color(0.92, 0.95, 0.99),
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.90, 0.94, 1.0),
          transparent: true,
          opacity: 0.06,              // ~94% see-through -> outside stays vibrant, no extra pass
          roughness: 0.85,            // matte -> no sharp specular hot-spot from any light
          metalness: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
    const isWinGlass = (m) => m && /glass/i.test(m.name) && !/cam/i.test(m.name)
    // Pre-scan the window glass world-space vertical bounds so the dust knows where the
    // "bottom" of the pane is, then attach the subtle bottom-clustered dust to the shared mat.
    let gMinY = Infinity, gMaxY = -Infinity, gMinX = Infinity, gMaxX = -Infinity
    scene.traverse((o) => {
      if (!o.isMesh) return
      const oms = Array.isArray(o.material) ? o.material : [o.material]
      if (!oms.some(isWinGlass)) return
      o.updateWorldMatrix(true, false)
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      gMinY = Math.min(gMinY, bb.min.y); gMaxY = Math.max(gMaxY, bb.max.y)
      gMinX = Math.min(gMinX, bb.min.x); gMaxX = Math.max(gMaxX, bb.max.x)
    })
    if (gMaxY > gMinY) applyGlassDust(windowGlassMat, gMinY, gMaxY, gMinX, gMaxX)
    scene.traverse((o) => {
      if (!o.isMesh) return
      let hasGlass = false
      if (Array.isArray(o.material)) {
        o.material = o.material.map((m) => (isWinGlass(m) ? (hasGlass = true, windowGlassMat) : m))
      } else if (isWinGlass(o.material)) {
        o.material = windowGlassMat
        hasGlass = true
      }
      // Window glass -> render LAYER 2: lit by ambient only (no sun, no lamp), so no directional
      // light ever casts a specular hot-spot on the pane. Camera renders layer 2 (see Lights).
      if (hasGlass) o.layers.set(2)
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      // Contact-shadow grounding: the desk RECEIVES shadows; the props on it CAST
      // (and receive). Environment/tree/window are left out — they don't need to
      // cast onto the desk and it keeps the shadow map tight + cheap.
      const n = o.name.toLowerCase()
      const isDesk = /desk/.test(n)
      const isEnv = /wall|window|casing|sill|divider|frame|out|forest|fence|hill|house|roof|bush|pine|ground|chimney|pole|wire|vent|bl_|canopy|branch|trunk/.test(n)
      if (isDesk) {
        o.receiveShadow = true
      } else if (!isEnv) {
        o.castShadow = true
        o.receiveShadow = true
      }
      // Wall — largest interior surface. Warm sandy-beige STUCCO/troweled-plaster,
      // authored as a runtime GLSL procedural material (NO baked texture -> 0 KB
      // download): fine granular grain + coarse troweled mottling + subtle bump so
      // it catches the directional sun. Ref: Ai references/photo-wall-texture-pattern.
      if (/wall/i.test(n)) {
        mats.forEach((m) => { if (m) applyStuccoWall(m) })
      }
      // (Camera M_CamMetal matte dark-grey finish now lives in the .blend / scene.glb.)
      // Window frame/divider/sill/casing — whitewashed wood grain (NOT the glass). Grain
      // runs along each member's long axis: derive the member's world bbox aspect and pick
      // horizontal grain for wide members, vertical for tall, per-fragment auto for square rings.
      if (/window(frame|divider|sill|casing)/i.test(n)) {
        o.updateWorldMatrix(true, false)
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
        const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
        const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2
        const hw = Math.max((bb.max.x - bb.min.x) / 2, 1e-3), hh = Math.max((bb.max.y - bb.min.y) / 2, 1e-3)
        const mode = hw > hh * 1.5 ? 1 : hh > hw * 1.5 ? 0 : 2 // wide->H, tall->V, square->auto
        const applied = mats.map((m) => {
          if (!m) return m
          const c = m.clone()                                  // per-mesh material -> per-member uniforms
          applyWhitewashWood(c, { mode, cx, cy, hw, hh })
          return c
        })
        o.material = Array.isArray(o.material) ? applied : applied[0]
      }
      // Wooden fence pickets — rustic weathered plank wood.
      if (/outfence/i.test(n)) {
        mats.forEach((m) => { if (m) applyFenceWood(m) })
      }
      // Alpha-CUTOUT foliage (cherry blossoms + distant forest billboards). The GLB tags
      // these alpha-BLEND, but transmissive glass can't capture blended objects into its
      // refraction buffer (they get skipped -> the blossoms vanished behind the window).
      // Switch them to alphaTest cutout so they render as OPAQUE and show through the glass.
      mats.forEach((m) => {
        if (m && /blossom|forest/i.test(m.name)) {
          m.transparent = false
          m.alphaTest = 0.45
          m.depthWrite = true
          m.needsUpdate = true
        }
      })
      // Exterior scene objects — cherry tree, house, roof, hills, forest, ground: lift
      // their saturation so the view through the (now clear) glass reads vibrant. Excludes
      // the fence (own shader) and all interior surfaces.
      const isOutsideObj = /forest|hill|house|roof|pine|ground|chimney|canopy|branch|trunk|tree|blossom|leaf|petal/.test(n)
        || (/out/.test(n) && !/outfence/.test(n))
      if (isOutsideObj) {
        mats.forEach((m) => { if (m) applyOutsideVibrance(m, 1.3) })
      }
      // Render-layer scheme so the (interior) lamp lights the room naturally but never the
      // outdoor diorama through the window:
      //   layer 0 = interior (default) — lit by lamp + sun + ambient, rendered by camera.
      //   layer 1 = exterior (outside scene + fence) — lit by sun + ambient, NOT the lamp.
      //   layer 2 = window glass — lit by ambient only (no directional light -> spot-free pane).
      // Interior meshes keep the default layer 0, so the lamp (layer 0) lights ALL of them
      // (walls, camera, laptop, posters…) with no per-object tagging. Only exterior + glass move.
      const isExterior = isOutsideObj || /outfence/.test(n)
      if (isExterior) o.layers.set(1)
      // Tame the practical lamp so it stops dominating the sunny-morning frame.
      // Bulb still blooms (reads as "on") but smaller; shade no longer clips to white.
      // Collect the emissive materials so the on/off tap can drive them (see effect below).
      mats.forEach((m) => {
        if (!m) return
        // Wooden stem + base + disc (M_LampWood) -> procedural honey-wood grain.
        if (/lampwood/i.test(m.name)) { applyLampWood(m) }
        if (/lampbulb/i.test(n)) { m.emissiveIntensity = 5.0; lampMats.bulb.push(m) }
        else if (/lampshade/i.test(n)) {
          // OPAQUE PLEATED fabric shade (see applyPleatedShade). Opaque so the bulb globe is
          // hidden; vertical accordion folds (runtime GLSL) give it real fabric texture instead
          // of a bland smooth cone; glows warmly when lit. Centre = shade world-bbox axis.
          o.updateWorldMatrix(true, false)
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
          const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
          applyPleatedShade(m, (bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2)
          lampMats.shade.push(m)
        }
      })
    })
  }, [scene])

  // Drive the lamp bulb/shade glow from the on/off state. When off, the emissive drops
  // to 0 (bulb stops blooming, shade stops glowing); the warm point lights are cut in App.
  useLayoutEffect(() => {
    lampMats.bulb.forEach((m) => { m.emissiveIntensity = lampOn ? 5.0 : 0; m.needsUpdate = true })
    lampMats.shade.forEach((m) => { m.emissiveIntensity = lampOn ? LAMP_SHADE_GLOW : 0; m.needsUpdate = true })
  }, [lampOn])

  // Tap the lamp (any of its parts) to toggle its light. stopPropagation so the tap
  // doesn't fall through to anything behind it. Pointer cursor signals it's interactive.
  const onLampPointer = (over) => (e) => {
    if (!/lamp/i.test(e.object.name)) return
    e.stopPropagation()
    document.documentElement.classList.toggle('cursor-hot', over) // grow the custom cursor
  }
  const onSceneClick = (e) => {
    if (!/lamp/i.test(e.object.name)) return
    e.stopPropagation()
    setLampOn((v) => !v)
  }

  useFrame(() => {
    const p = scroll.offset          // raw 0..1
    const clamp = THREE.MathUtils.clamp
    const pa = smootherstep(clamp(p / PHASE, 0, 1))          // phase A (laptop open)
    const pb = smootherstep(clamp((p - PHASE) / (1 - PHASE), 0, 1)) // phase B (pan to standee)

    // Laptop lid opens during phase A only
    if (hinge.current) hinge.current.rotation.x = THREE.MathUtils.lerp(0, HINGE_OPEN, pa)

    // Camera: phase A WEBSITE->SCREEN, phase B SCREEN->STANDEE
    const inB = p >= PHASE
    const from = inB ? SCREEN : WEBSITE
    const to = inB ? STANDEE : SCREEN
    const k = inB ? pb : pa

    tmpPos.lerpVectors(from.pos, to.pos, k)
    camera.position.copy(tmpPos)
    tmpQuat.slerpQuaternions(from.quat, to.quat, k)
    camera.quaternion.copy(tmpQuat)

    camera.fov = THREE.MathUtils.lerp(from.fov, to.fov, k)
    camera.updateProjectionMatrix()
    // Replicate Blender's vertical lens shift (off-center frustum). NDC scales with aspect.
    const shiftY = THREE.MathUtils.lerp(from.shiftY, to.shiftY, k)
    camera.projectionMatrix.elements[9] += 2 * shiftY * camera.aspect

    // DOM overlays (dev aids)
    const hintEl = document.querySelector('.hint')
    if (hintEl) hintEl.style.opacity = String(Math.max(0, 1 - p * 4))
    const ro = document.querySelector('.readout')
    if (ro) {
      const stage = !inB ? `lid ${(pa * 100).toFixed(0)}% open` : `standee ${(pb * 100).toFixed(0)}%`
      ro.textContent = `scroll ${(p * 100).toFixed(0)}%  ·  ${stage}`
    }
  })

  return (
    <primitive
      object={scene}
      onClick={onSceneClick}
      onPointerOver={onLampPointer(true)}
      onPointerOut={onLampPointer(false)}
    />
  )
}

// Glass glaze for framed posters — a mostly-clear transparent pane with soft diagonal
// light glints (fakes a window reflection on the glass). Runtime GLSL, 0 KB download.
const GLASS_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const GLASS_FRAG = `
varying vec2 vUv;
void main(){
  // diagonal coordinate (upper-left bright, like light raking across the glass)
  float diag = clamp(vUv.x * 0.62 + (1.0 - vUv.y) * 0.82, 0.0, 1.6);
  float broad = smoothstep(1.10, 0.05, diag) * 0.16;                 // broad bright sheen (half the pane glows)
  float s1 = exp(-pow((diag - 0.50) / 0.075, 2.0)) * 0.60;           // wide primary reflection band
  float s2 = exp(-pow((diag - 0.66) / 0.030, 2.0)) * 0.34;           // bright secondary streak
  float s3 = exp(-pow((diag - 0.30) / 0.020, 2.0)) * 0.20;           // thin leading streak
  // rim sheen: glass catches light along its edges -> reads clearly as a pane
  float d = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5));
  float rim = smoothstep(0.42, 0.5, d) * 0.22;
  float edge = smoothstep(0.5, 0.49, d);                             // clip to pane
  float a = (0.07 + broad + s1 + s2 + s3 + rim) * edge;
  gl_FragColor = vec4(vec3(1.0), min(a, 0.92));
}
`

// A framed poster: black molding + white mat + SWAPPABLE poster art, all under glass.
// w,h = OUTER frame footprint (keeps the wall layout stable). The poster art (`map`) is
// the only thing that changes on swap — the black frame, white mat and glass glaze are
// structural and persist across every poster automatically. Give me new art later and I
// just repoint `map`; the frame stays intact.
function FramedPoster({ map, x, y, w, h, rot = 0, z = -1.43, frame = 0.02, mat = 0.016, emissive = 0.16 }) {
  const mW = w - frame * 2, mH = h - frame * 2         // white mat opening
  const aW = mW - mat * 2, aH = mH - mat * 2           // poster art
  const dz = 0.004
  return (
    <group position={[x, y, z]} rotation={[0, 0, rot]}>
      {/* black frame molding (slight metallic sheen -> subtle beveled highlight) */}
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#0b0b0d" roughness={0.34} metalness={0.4} />
      </mesh>
      {/* white mat / passe-partout */}
      <mesh position={[0, 0, dz]}>
        <planeGeometry args={[mW, mH]} />
        <meshStandardMaterial color="#f3f0ea" roughness={0.92} metalness={0} />
      </mesh>
      {/* poster art — the swappable placeholder */}
      <mesh position={[0, 0, dz * 2]}>
        <planeGeometry args={[aW, aH]} />
        <meshStandardMaterial
          map={map} emissive="#ffffff" emissiveMap={map} emissiveIntensity={emissive}
          roughness={0.86} metalness={0}
        />
      </mesh>
      {/* glass glaze with light reflection (covers the mat opening) */}
      <mesh position={[0, 0, dz * 3]}>
        <planeGeometry args={[mW, mH]} />
        <shaderMaterial
          transparent depthWrite={false}
          vertexShader={GLASS_VERT} fragmentShader={GLASS_FRAG}
        />
      </mesh>
    </group>
  )
}

// Wall storytelling art — framed posters/photos + a casual sticky note on the back wall
// (three-Z ≈ -1.43, just in front of the wall). Gives the cozy-designer personality of
// the reference. Positions tuned to the locked camera.
function WallArt() {
  const tex = useTexture({
    poster: '/art/poster_longway.png',
    keep: '/art/note_keep.png',
    lake: '/art/photo_lake.png',
  })
  useMemo(() => {
    Object.values(tex).forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4 })
  }, [tex])
  const Z = -1.43   // just in front of the wall's room-facing surface (~-1.45)
  return (
    <group>
      {/* right strip (X 0.55..1.2) — framed poster (placeholder art, swap later) */}
      <FramedPoster map={tex.poster} x={0.87} y={1.46} w={0.50} h={0.70} />
      {/* left strip (X -1.2..-0.55) — framed photo (placeholder art, swap later) */}
      <FramedPoster map={tex.lake} x={-0.9} y={1.17} w={0.36} h={0.28} rot={0.02} />
      {/* casual sticky note — intentionally unframed */}
      <mesh position={[-0.88, 1.62, Z]} rotation={[0, 0, 0.05]}>
        <planeGeometry args={[0.28, 0.28]} />
        <meshStandardMaterial
          map={tex.keep} emissive="#ffffff" emissiveMap={tex.keep} emissiveIntensity={0.22}
          roughness={0.93} metalness={0} transparent alphaTest={0.5}
        />
      </mesh>
    </group>
  )
}

function Lights() {
  const w = wx()
  const camera = useThree((s) => s.camera)
  const sunRef = useRef()
  const ambRef = useRef()
  // Key light = the sun. Its direction matches the sky's sunDir so shading agrees
  // with where the sun disc is drawn. (glTF: window/outside at -Z.)
  const sunPos = useMemo(
    () => new THREE.Vector3().fromArray(w.sky.sunDir).multiplyScalar(12),
    []
  )
  // Layer scheme (see DeskScene): 0 = interior, 1 = exterior, 2 = window glass.
  // - Camera renders all three (0 by default; enable 1 + 2).
  // - Sun lights interior (0) + exterior (1), but NOT the glass (2) -> no specular spot on the pane.
  // - Ambient lights everything (flat fill, no speculars) so exterior + glass are never black.
  // - The lamp (in App) stays on layer 0 only -> lights the interior naturally, never the outdoors.
  useLayoutEffect(() => {
    camera.layers.enable(1)
    camera.layers.enable(2)
    sunRef.current?.layers.enable(1)
    ambRef.current?.layers.enable(1)
    ambRef.current?.layers.enable(2)
  }, [camera])
  return (
    <>
      {/* LIGHT 2 of 3 — the room's single AMBIENT fill (soft bounced sky/ceiling light). The
          ONLY flat fill in the scene; subtle + weather-driven. Lifts the camera-facing sides
          that the sun (coming from the window) leaves in shadow. */}
      <ambientLight ref={ambRef} color={w.ambient.color} intensity={w.ambient.intensity} />
      {/* LIGHT 1 of 3 — the SUN. Single directional key, raking in through the window (-Z);
          colour/intensity are weather-driven. Casts the contact shadows that ground the props. */}
      <directionalLight
        ref={sunRef}
        position={sunPos.toArray()}
        color={w.sun.color}
        intensity={w.sun.intensity}
        castShadow
        shadow-mapSize={HIGH_Q ? [2048, 2048] : [1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-camera-near={0.5}
        shadow-camera-far={30}
        shadow-camera-left={-3}
        shadow-camera-right={3}
        shadow-camera-top={3}
        shadow-camera-bottom={-3}
      />
    </>
  )
}

// Custom 3D blurred-glass cursor. A floating orb that eases toward the pointer (giving a
// soft trailing/parallax feel), blurs the scene behind it, and scales on press. DOM-only.
function Cursor3D() {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let mx = window.innerWidth / 2, my = window.innerHeight / 2
    let x = mx, y = my, raf, shown = false
    const move = (e) => { mx = e.clientX; my = e.clientY; if (!shown) { el.style.opacity = '1'; shown = true } }
    const down = () => el.classList.add('down')
    const up = () => el.classList.remove('down')
    const leave = () => { el.style.opacity = '0'; shown = false }
    const loop = () => {
      // ease toward the pointer; snappier factor + rounding = smooth, non-jittery follow
      x += (mx - x) * 0.32; y += (my - y) * 0.32
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`
      raf = requestAnimationFrame(loop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    document.addEventListener('mouseleave', leave)
    loop()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      document.removeEventListener('mouseleave', leave)
    }
  }, [])
  return <div ref={ref} className="cursor3d" aria-hidden="true"><div className="cursor3d-orb" /></div>
}

// Cap the 3D render loop to a fixed FPS. With Canvas frameloop="never", R3F only draws
// when we call advance(); we call it on a steady cadence, so the scene renders at a
// consistent rate (a stable 30fps budget reads smoother than a 60fps target that drops
// frames). Drives useFrame (camera/scroll/hinge) + postprocessing at the same rate.
function FrameLimiter({ fps = 30 }) {
  const advance = useThree((s) => s.advance)
  useLayoutEffect(() => {
    let raf, last = -1e9
    const interval = 1000 / fps
    const loop = (t) => {
      raf = requestAnimationFrame(loop)
      if (t - last >= interval) { last = t; advance(t) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [advance, fps])
  return null
}

export default function App() {
  const [lampOn, setLampOn] = useState(true)
  return (
    <>
      <Canvas
        shadows
        frameloop="never"
        dpr={HIGH_Q ? [1, 2] : [1, 1.25]}
        gl={{
          antialias: true,
          logarithmicDepthBuffer: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.4,
        }}
        camera={{ position: [0, 1.2, -0.25], fov: 55, near: 0.05, far: 40 }}
      >
        <color attach="background" args={['#cddcf2']} />
        {/* Atmospheric perspective: distant exterior (house/forest/hills) hazes toward
            sky colour. near=4.7 keeps the whole interior + tree/fence crisp; only the
            far layers soften. Custom Sky shader ignores fog, so the sky stays vivid. */}
        <fog attach="fog" args={['#c4d6ea', 7.5, 26]} />
        <FrameLimiter fps={30} />
        <Sky />
        <Lights />
        <Suspense fallback={null}><WallArt /></Suspense>
        {/* LIGHT 3 of 3 — the TABLE LAMP. A single warm point light in the shade; the shade/bulb
            emissive + bloom give the visible "lamp is on" glow. Cut to 0 when the lamp is tapped off.
            Stays on the default layer 0, so it lights all INTERIOR meshes naturally (wall, camera,
            laptop, posters…). Exterior + glass are on layers 1/2, so the lamp never reaches the
            outdoor diorama through the window (no stray fence hot-spot). */}
        <pointLight
          position={[0.70, 1.02, -1.17]} color="#ffbf6e" intensity={lampOn ? 0.9 : 0} distance={2.2} decay={1.6}
        />
        {/* Coffee steam rising from the mug (glTF: Blender coffee (-0.52,1.08,0.932) -> (x,z,-y)) */}
        <Steam position={[-0.61, 1.06, -1.08]} />
        <ScrollControls pages={4} damping={0.25}>
          <DeskScene lampOn={lampOn} setLampOn={setLampOn} />
        </ScrollControls>
        {/* Soft bloom so the lit shade + bulb glow warmly. Threshold kept just above daylight
            luminance so only the glowing lamp (shade emissive 1.6 + bulb) blooms, not the window. */}
        <EffectComposer disableNormalPass>
          <Bloom
            intensity={0.55}
            luminanceThreshold={1.05}
            luminanceSmoothing={0.5}
            mipmapBlur
            radius={0.8}
          />
          {/* Restrained sunny-morning grade: gentle contrast + a touch of warmth/saturation. */}
          <BrightnessContrast brightness={0.015} contrast={0.075} />
          <HueSaturation saturation={0.07} />
          <Vignette eskil={false} offset={0.42} darkness={0.34} />
        </EffectComposer>
      </Canvas>

      <Cursor3D />

      <div className="readout">scroll 0%</div>
      <div className="hint">
        <span>Scroll to open</span>
        <span className="chevron" />
      </div>
    </>
  )
}

useGLTF.preload(GLB_URL)
