import React, { useLayoutEffect, useRef, useMemo, Suspense } from 'react'
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
      top:      [0.12, 0.40, 0.88],   // zenith blue — saturated to survive ACES desaturation
      horizon:  [0.60, 0.79, 0.97],   // clean blue horizon (less milky white)
      sunDir:   [0.34, 0.55, -0.76],  // up + slightly right + toward the window (-Z)
      sunColor: [1.0, 0.95, 0.84],
      sunSize:  0.006,
      cloud:    0.55,                 // coverage 0..1
      cloudColor: [1.0, 1.0, 1.0],
      cloudSpeed: 0.008,
    },
    // key light = the sun (matches sky sunDir). warm morning.
    // Strong directional key + reduced flat fill => raking morning light, real contrast.
    sun:     { color: '#ffe8bf', intensity: 3.6 },
    ambient: { intensity: 0.44 },
    hemi:    { sky: 0xbcd3ff, ground: 0x6b5a44, intensity: 0.62 },
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
  float glow = pow(sd, 8.0)*0.35 + pow(sd, 160.0)*0.9;
  sky += uSunColor * (disc*1.3 + glow);
  // clouds: project the view dir onto a sky plane and sample drifting fbm
  vec2 uv = d.xz / (d.y*1.4 + 0.35);
  float n = fbm(uv*1.6 + vec2(uTime*uCloudSpeed, uTime*uCloudSpeed*0.6));
  float cover = 1.0 - uCloud;
  float cl = smoothstep(cover, cover+0.35, n) * smoothstep(0.02, 0.22, d.y);
  // sun tints the clouds slightly warm near it
  vec3 cc = mix(uCloudColor, uSunColor, glow*0.6);
  sky = mix(sky, cc, clamp(cl, 0.0, 1.0)*0.92);
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
const GLB_URL = '/scene.glb?v=24'

function DeskScene() {
  const { scene } = useGLTF(GLB_URL)
  const hinge = useRef(null)
  const camera = useThree((s) => s.camera)
  const scroll = useScroll()

  const tmpPos = useRef(new THREE.Vector3()).current
  const tmpQuat = useRef(new THREE.Quaternion()).current

  useLayoutEffect(() => {
    hinge.current = scene.getObjectByName('Laptop_Hinge')
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
    // Clean, see-through window glass: the exported alpha-blend material can look
    // milky, so force clear-glass properties. (Weather-independent.)
    scene.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((m) => {
        if (m && /glass/i.test(m.name)) {
          m.transparent = true
          m.opacity = 0.16
          m.roughness = 0.04
          m.metalness = 0
          m.depthWrite = false
          m.color = new THREE.Color(0.86, 0.92, 1.0)
        }
      })
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
      // Warm, brighten the wall — largest interior surface. Reference walls are a warm
      // sunlit greige, not flat cool grey. (Material colour only; lighting does the rest.)
      if (/wall/i.test(n)) {
        mats.forEach((m) => { if (m && m.color) m.color.setRGB(0.60, 0.52, 0.42) })
      }
      // Tame the practical lamp so it stops dominating the sunny-morning frame.
      // Bulb still blooms (reads as "on") but smaller; shade no longer clips to white.
      mats.forEach((m) => {
        if (!m) return
        if (/lampbulb/i.test(n)) m.emissiveIntensity = 5.0
        else if (/lampshade/i.test(n)) m.emissiveIntensity = Math.min(m.emissiveIntensity ?? 1, 0.55)
      })
    })
  }, [scene])

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

  return <primitive object={scene} />
}

// Wall storytelling art — posters, sticky notes, framed photos on the flat back wall
// (three-Z ≈ -1.49, just in front of the wall at -1.5). Purely additive; gives the
// cozy-designer personality of the reference. Positions tuned to the locked camera.
function WallArt() {
  const tex = useTexture({
    poster: '/art/poster_longway.png',
    keep: '/art/note_keep.png',
    curious: '/art/note_curious.png',
    lake: '/art/photo_lake.png',
    dusk: '/art/photo_dusk.png',
  })
  useMemo(() => {
    Object.values(tex).forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4 })
  }, [tex])
  const Z = -1.43   // just in front of the wall's room-facing surface (~-1.45)
  const Piece = ({ map, x, y, w, h, rot = 0, emissive = 0.22 }) => (
    <mesh position={[x, y, Z]} rotation={[0, 0, rot]}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial
        map={map} emissive="#ffffff" emissiveMap={map} emissiveIntensity={emissive}
        roughness={0.93} metalness={0} transparent alphaTest={0.5}
      />
    </mesh>
  )
  return (
    <group>
      {/* right strip (X 0.55..1.2) */}
      <Piece map={tex.poster} x={0.87} y={1.46} w={0.46} h={0.657} />
      {/* left strip (X -1.2..-0.55) */}
      <Piece map={tex.keep} x={-0.88} y={1.58} w={0.28} h={0.28} rot={0.05} />
      <Piece map={tex.lake} x={-0.9} y={1.19} w={0.32} h={0.24} rot={0.02} />
    </group>
  )
}

function Lights() {
  const w = wx()
  // Key light = the sun. Its direction matches the sky's sunDir so shading agrees
  // with where the sun disc is drawn. (glTF: window/outside at -Z.)
  const sunPos = useMemo(
    () => new THREE.Vector3().fromArray(w.sky.sunDir).multiplyScalar(12),
    []
  )
  return (
    <>
      <ambientLight intensity={w.ambient.intensity} />
      <hemisphereLight args={[w.hemi.sky, w.hemi.ground, w.hemi.intensity]} />
      {/* The SUN — single directional key light, driven by the active weather preset.
          Casts the contact shadows that ground the desk props. Shadow config only —
          colour/intensity/direction are untouched and remain weather-driven. */}
      <directionalLight
        position={sunPos.toArray()}
        color={w.sun.color}
        intensity={w.sun.intensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
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
      {/* faint cool bounce/fill from the room side */}
      <directionalLight position={[-2.0, 1.5, 1.0]} intensity={0.25} color="#cfe0ff" />
      {/* WARM WINDOW BOUNCE — soft daylight spilling in from the window (-Z), lifts the
          interior warmly without erasing the sun's directional shadows. */}
      <pointLight position={[0, 1.35, -1.15]} color="#ffe4b8" intensity={0.85} distance={5} decay={1.4} />
    </>
  )
}

export default function App() {
  return (
    <>
      <Canvas
        shadows
        dpr={[1, 2]}
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
        <fog attach="fog" args={['#c4d6ea', 4.7, 16]} />
        <Sky />
        <Lights />
        <Suspense fallback={null}><WallArt /></Suspense>
        {/* Warm lamp glow. The shade's emissive material + bloom is the visible "lamp is on" source;
            these two point lights add a SUBTLE warm pool low in/under the shade. */}
        <pointLight position={[0.48, 1.05, -1.24]} color="#ffca78" intensity={0.16} distance={0.7} decay={2} />
        <pointLight position={[0.48, 0.96, -1.22]} color="#ffb860" intensity={0.07} distance={0.45} decay={2} />
        {/* Coffee steam rising from the mug (glTF: Blender coffee (-0.52,1.08,0.932) -> (x,z,-y)) */}
        <Steam position={[-0.61, 1.06, -1.08]} />
        <ScrollControls pages={4} damping={0.25}>
          <DeskScene />
        </ScrollControls>
        {/* Soft bloom so the bright bulb glows/blurs through the frosted shade.
            High threshold => only the HDR-bright bulb (emission ~14) blooms, not the daylight window. */}
        <EffectComposer disableNormalPass>
          <Bloom
            intensity={0.32}
            luminanceThreshold={1.1}
            luminanceSmoothing={0.4}
            mipmapBlur
            radius={0.6}
          />
          {/* Restrained sunny-morning grade: gentle contrast + a touch of warmth/saturation. */}
          <BrightnessContrast brightness={0.015} contrast={0.075} />
          <HueSaturation saturation={0.07} />
          <Vignette eskil={false} offset={0.42} darkness={0.34} />
        </EffectComposer>
      </Canvas>

      <div className="readout">scroll 0%</div>
      <div className="hint">
        <span>Scroll to open</span>
        <span className="chevron" />
      </div>
    </>
  )
}

useGLTF.preload(GLB_URL)
