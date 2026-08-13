import React, { useLayoutEffect, useEffect, useRef, useMemo, useState, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, ScrollControls, useScroll, Billboard, useTexture } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette, BrightnessContrast, HueSaturation, N8AO, SMAA } from '@react-three/postprocessing'
import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
RectAreaLightUniformsLib.init() // required for RectAreaLight (the open-laptop screen glow) to work

// ── Extracted modules (architecture recovery): config = tunable art-direction,
// materials = runtime procedural material registry. See CLAUDE.md / docs/.
import { WEATHER, PRESETS } from './config/weather.js'
import { WEBSITE, SCREEN, STANDEE, HINGE_OPEN, LID_OPEN_END, PANEL_HOLD_END, SCROLL_PAGES, MOBILE_SCROLL_SMOOTH, smootherstep } from './config/camera.js'
import { HIGH_Q, qp } from './config/quality.js'
// Mip LOD bias applied to the two text-bearing textures (résumé + project thumbnails). 0 on the
// desktop tier, which means the shaders below are left COMPLETELY unpatched there — see the long
// note on `textureLodBias` in config/quality.js for why this exists and what it trades.
const TEX_LOD_BIAS = qp().textureLodBias || 0
// texture2D()'s optional third argument is a mip LOD bias, valid in fragment shaders in both
// GLSL ES 1.00 and 3.00 (three aliases texture2D -> texture under GLSL3), so this needs no
// per-version branching. Emits the plain 2-arg call when the bias is 0 so desktop shader source is
// byte-identical to what it was before this existed.
const sampleBiased = (tex, uv) => (TEX_LOD_BIAS ? `texture2D(${tex}, ${uv}, uLodBias)` : `texture2D(${tex}, ${uv})`)
import { GLB_URL, LAMP_SHADE_GLOW, BACKGROUND_COLOR, TONE_MAPPING_EXPOSURE, RENDER_FPS, FOG, LAMP_LIGHT, STEAM_POSITION, POST, AO } from './config/scene.js'
import { applyBrickWall, applyWhitewashWood, applyFenceWoodGrain, applyPleatedShade, applyLampWood, applyGlassDust, applyOutsideVibrance, applyLaptopAluminum, applyCamBody, applyCamBarrel, applyCamGlass, applyCamRing, applyCamButton, applyCamLeather, setOutsideWeather } from './materials/proceduralMaterials.js'
import { validateScene } from './utils/sceneValidation.js'
import { asset, DRACO_PATH } from './utils/assets.js'
import { IS_MOBILE_VIEWPORT, MOBILE_CANVAS_STYLE, initImmersiveFullscreen, lockLandscape } from './utils/viewport.js'
import brandLogo from './assets/brand-logo.svg'
import Lottie from 'lottie-react'
import scrollDownArrows from './assets/scroll-down-arrows.json'

// ── Boot-time asset loading progress (consumed by the Loader component near the bottom) ────
// A plain module-scope object (not React state) because it must start listening on
// THREE.DefaultLoadingManager BEFORE any of this file's useGLTF.preload/useTexture.preload
// calls run below — several fire at MODULE-EVAL time, before React even mounts, so a listener
// attached inside a useEffect would miss their itemStart and undercount. useGLTF/useTexture
// both construct their underlying THREE loaders with no explicit manager argument, so they
// default to (and share) THREE.DefaultLoadingManager — confirmed against the installed
// three/@react-three/fiber source, not assumed.
const bootLoad = { progress: 0, done: false, listeners: new Set() }
const _notifyBootLoad = () => bootLoad.listeners.forEach((fn) => fn())
THREE.DefaultLoadingManager.onStart = () => { bootLoad.done = false; _notifyBootLoad() }
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  // Capped at 99 until onLoad actually fires — itemsTotal can still grow as later Suspense
  // children mount and start their own loads, so loaded===total isn't trustworthy as "truly
  // everything is done" until the manager itself says so.
  bootLoad.progress = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : bootLoad.progress
  _notifyBootLoad()
}
THREE.DefaultLoadingManager.onLoad = () => { bootLoad.progress = 100; bootLoad.done = true; _notifyBootLoad() }
// Subscribes a component to the module-scope bootLoad object above.
function useBootLoad() {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    bootLoad.listeners.add(fn)
    return () => bootLoad.listeners.delete(fn)
  }, [])
  return bootLoad
}

// --- Animated coffee steam (procedural rising-wisps shader on a billboard) ---
// Patched onto MeshBasicMaterial's own stock shader via onBeforeCompile (helpers spliced
// in after `#include <common>`, output before `#include <dithering_fragment>`) — same
// fix as the rain overlay: a bare transparent ShaderMaterial silently failed to render
// anywhere in this scene (confirmed with the rain effect), while patching a couple of
// lines into MeshBasicMaterial's own template renders fine.
const STEAM_HELPERS_GLSL = `
uniform float uTime; uniform float uOpacity; uniform float uNight; uniform float uFog;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 p){ float v=0.0, amp=0.5; for(int i=0;i<5;i++){ v+=amp*noise(p); p*=2.0; amp*=0.5; } return v; }
`
const STEAM_OUTPUT_GLSL = `
{
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
  // weather response: a flat bright-white wisp reads as a glued-on decal in the dark —
  // cool + dim it toward night, and fold it into the fog haze a touch, so it sits IN the
  // scene's lighting instead of floating on top of it regardless of weather.
  vec3 dayCol = vec3(0.88, 0.89, 0.93);
  vec3 nightCol = vec3(0.46, 0.52, 0.64);
  vec3 col = mix(dayCol, nightCol, uNight);
  col = mix(col, vec3(0.80, 0.81, 0.82), uFog * 0.5);
  a *= mix(1.0, 0.5, uNight);                            // less visible against a dark room
  gl_FragColor = vec4(col, a);
}
`
function Steam({ weather }) {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const shaderRef = useRef()
  // Auto-place at the actual coffee surface (GEO_MugCoffee's world bbox), not a hand-tuned
  // offset — a hardcoded position drifts out of sync whenever the mug moves in Blender
  // (exactly what happened: the steam was floating well off to the side of the cup).
  const position = useMemo(() => {
    const g = scene.getObjectByName('GEO_MugCoffee') || scene.getObjectByName('GEO_Mug')
    if (g) {
      g.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(g)
      const c = box.getCenter(new THREE.Vector3())
      return [c.x, box.max.y + 0.02, c.z]
    }
    return STEAM_POSITION
  }, [scene])
  const material = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    m.defines = { USE_UV: '' }   // force the vUv varying stock MeshBasicMaterial only emits when a map is set
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 }
      shader.uniforms.uOpacity = { value: 0.42 }
      shader.uniforms.uNight = { value: 0 }
      shader.uniforms.uFog = { value: 0 }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${STEAM_HELPERS_GLSL}`)
        .replace('#include <dithering_fragment>', `${STEAM_OUTPUT_GLSL}\n#include <dithering_fragment>`)
      shaderRef.current = shader
    }
    m.customProgramCacheKey = () => 'steamOverlay'
    return m
  }, [])
  useEffect(() => () => material.dispose(), [material])
  useFrame((_, dt) => {
    if (shaderRef.current) {
      const L = weather.current.live
      shaderRef.current.uniforms.uTime.value += Math.min(dt, 0.05)
      shaderRef.current.uniforms.uNight.value = L.night
      shaderRef.current.uniforms.uFog.value = L.fog
    }
  })
  return (
    <Billboard position={position}>
      <mesh material={material}>
        <planeGeometry args={[0.13, 0.18]} />
      </mesh>
    </Billboard>
  )
}

// Soft CONTACT SHADOW decal under the laptop base — a subtle dark radial-gradient plane laid
// just above the desk mat. The laptop sits flush/into the mat, so nothing grounds it; this
// fakes the soft occlusion the base would drop from the ambient + sun, killing the "floating"
// read. depthWrite off; the laptop occludes the centre, only the soft halo shows on the mat.
// Laptop-SHAPED soft contact shadow: a rounded rectangle matching the laptop footprint, darkest
// right at the contact edge and fading to a subtle penumbra. Reads as real ambient occlusion where
// the base meets the mat (not a flat blob). The laptop occludes the interior; only the soft ring
// around its edge shows on the mat. depthWrite off so it never z-fights the mat. Patched onto
// MeshBasicMaterial via onBeforeCompile — same fix as rain/steam (a bare transparent
// ShaderMaterial silently failed to render anywhere in this scene).
const CONTACT_HELPERS_GLSL = `
uniform float uMax;
float sdRoundBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
`
const CONTACT_OUTPUT_GLSL = `
{
  vec2 p = (vUv - 0.5) * 2.0;                                // -1..1 across the plane
  float d = sdRoundBox(p, vec2(0.62, 0.62), 0.20);           // rounded footprint (matches the laptop base)
  // darkest right at the contact edge (d≈0), soft penumbra outward; a faint core under the base.
  float a = uMax * (1.0 - smoothstep(-0.12, 0.42, d));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`
function LaptopContactShadow() {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const shaderRef = useRef()
  // Auto-place at the laptop's actual base (its bbox bottom = the mat surface) so the plane sits
  // JUST above the mat — no hand-tuned height. Sized 1.6× the footprint so the penumbra has room.
  const place = useMemo(() => {
    const box = new THREE.Box3(); let found = false
    scene.traverse((o) => {
      if (o.isMesh && /laptop/i.test(o.name)) { o.updateWorldMatrix(true, false); box.expandByObject(o); found = true }
    })
    if (!found) return { pos: [0.0, 0.856, -1.17], size: [0.82, 0.66] }
    const c = box.getCenter(new THREE.Vector3())
    const s = box.getSize(new THREE.Vector3())
    return { pos: [c.x, box.min.y + 0.002, c.z], size: [Math.max(s.x, 0.1) * 1.6, Math.max(s.z, 0.1) * 1.6] }
  }, [scene])
  const material = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    m.toneMapped = false
    m.defines = { USE_UV: '' }   // force the vUv varying stock MeshBasicMaterial only emits when a map is set
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uMax = { value: 0.5 }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CONTACT_HELPERS_GLSL}`)
        .replace('#include <dithering_fragment>', `${CONTACT_OUTPUT_GLSL}\n#include <dithering_fragment>`)
      shaderRef.current = shader
    }
    m.customProgramCacheKey = () => 'contactShadow'
    return m
  }, [])
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh position={place.pos} rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <planeGeometry args={place.size} />
    </mesh>
  )
}


// --- Video RAIN card: a looping video (grey streaks on black) mapped onto GEO_RainCard, a
// plane authored in Blender sitting just outside the window wall (see SCENE_CONTRACT.md).
// Physical placement lives in Blender (source of truth for the physical world); this just
// plays the loop and fades it with the live `rain` amount, so it's invisible in every other
// preset. Replaces an earlier procedural GLSL rain shader — a bare transparent ShaderMaterial
// silently failed to render anywhere in this scene (confirmed with solid opaque test output),
// so the effect is authored as pre-rendered video instead.
//
// SAFARI FIX (2026-08-11): rain.webm is VP9, which Safari (desktop + iOS) does not decode in
// <video> at all — it silently fails to play, leaving the VideoTexture sampling an
// uninitialized/blank GPU texture, which read as a solid white blowout across the whole
// window. Chrome/Firefox decode VP9 fine. Fixed by giving the <video> a second <source> in
// H.264 MP4 (rain.mp4) — universally supported, including Safari — and letting the browser
// pick whichever it can actually play, via native <source> fallback (not a JS canPlayType
// guess). Also: the video has NO alpha channel (plain black background, not a transparent
// WebM) — "transparent" was never coming from the video itself, so the black square used to
// render solid black/washed over the window; now handled with additive blending: black
// contributes nothing, only the bright rain streaks add light, which is the actual (and only
// broadly browser-compatible) way to make a black-background overlay video read as transparent.
function VideoRain({ weather }) {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const materialRef = useRef()
  const video = useMemo(() => {
    const v = document.createElement('video')
    // <source> fallback (not v.src) so the browser itself picks a codec it can decode —
    // Safari skips the vp9 webm and falls through to the h264 mp4 automatically.
    const webm = document.createElement('source')
    webm.src = asset('rain.webm')
    webm.type = 'video/webm; codecs="vp9"'
    const mp4 = document.createElement('source')
    mp4.src = asset('rain.mp4')
    mp4.type = 'video/mp4; codecs="avc1.42E01E"'
    v.appendChild(webm)
    v.appendChild(mp4)
    v.loop = true
    v.muted = true
    v.playsInline = true
    v.autoplay = true
    // Kept off-screen but attached to the DOM (not display:none) — Chrome deprioritizes /
    // irregularly schedules decode for a <video> that's never in the layout tree, which read
    // as stutter here even though the texture upload itself was fine. (Attached in the effect
    // below, not here — see why.)
    v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px'
    return v // PURE: build the element only. No DOM insertion, no playback — see below.
  }, [])
  // Inserting into the DOM and starting playback are SIDE EFFECTS and so belong in an effect, not
  // in the useMemo above. They used to live there, and StrictMode (which double-invokes render, and
  // therefore useMemo) consequently appended and played a second, orphaned <video> that nothing
  // held a reference to — so nothing could ever pause or remove it. Measured in dev: three <video>
  // elements alive, two of them decoding forever in the background. Effects get cleaned up
  // properly, so this keeps it at exactly one. Runs before the texture effect below (effects fire
  // in declaration order), so the element is in the tree and loading by the time it's sampled.
  // Inserting into the DOM and starting playback are SIDE EFFECTS, so they belong in an effect
  // rather than in the useMemo above where they used to live. StrictMode double-invokes render (and
  // therefore useMemo), so doing them there appended and played a SECOND, orphaned <video> that
  // nothing held a reference to and nothing could ever pause or remove: measured three elements
  // alive in dev, two of them decoding forever in the background. Effects are torn down properly, so
  // this stays at exactly one. Runs before the texture effect below (effects fire in declaration
  // order), so the element is in the tree and loading by the time it's sampled.
  useEffect(() => {
    document.body.appendChild(video)
    video.load()
    video.play().catch(() => {})
    return () => { video.pause(); video.remove() }
  }, [video])
  useEffect(() => {
    const card = scene.getObjectByName('GEO_RainCard')
    if (!card) { console.warn('[VideoRain] GEO_RainCard not found — add it in Blender and re-export scene.glb (see CLAUDE.md)'); return }
    const texture = new THREE.VideoTexture(video)
    texture.colorSpace = THREE.SRGBColorSpace
    // AdditiveBlending: the video is grey streaks on a plain black background (no alpha
    // channel) — additive makes black contribute nothing so only the streaks show, instead of
    // the whole plane (background included) fading in as a flat wash. depthWrite already off.
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false,
    })
    card.material = material
    materialRef.current = material
    // The window glass is a physically-based transmission material (see-through via light
    // transmission, not alpha) — opaque + depth-writing at the buffer level, so it would fully
    // occlude the card sitting behind it outside the wall. Turning depthTest off on the card
    // (tried earlier) fixed that but also broke correct occlusion by the window divider and the
    // laptop when scrolled into view — it drew over literally everything. The narrow fix: stop
    // the glass specifically from writing depth, so real occluders (divider, laptop, frame)
    // still work and the card only needs a normal depth test against them.
    const glass = scene.getObjectByName('GEO_WindowGlass')
    if (glass) glass.material.depthWrite = false
    return () => { material.dispose(); texture.dispose() }
  }, [scene, video])
  useFrame(() => {
    if (!materialRef.current) return
    materialRef.current.opacity = weather.current.live.rain
    // This app renders on a throttled manual loop (frameloop="never" + FrameLimiter's own
    // advance() cadence), decoupled from VideoTexture's own requestVideoFrameCallback clock.
    // Relying on that callback to flag needsUpdate meant we sometimes rendered a frame or two
    // stale/duplicated relative to the video's real position — read as stutter. Forcing an
    // update here guarantees every render we actually draw grabs the video's current frame.
    //
    // The readyState check is the one THREE.VideoTexture.update() would do for us and which setting
    // needsUpdate by hand bypasses: before the video has decoded its first frame there is nothing to
    // upload, and every single render logged `WebGL: INVALID_VALUE: texImage2D: no video`. Only
    // console noise — but noise is precisely what makes a real warning easy to miss.
    //
    // Deliberately NOT also pausing the video in the four non-rainy presets, though its frames are
    // then being decoded and uploaded for a fully transparent card. It looks like free savings and
    // isn't: a <video> paused while still buffering can wedge permanently — networkState IDLE,
    // readyState stuck below HAVE_CURRENT_DATA, unpaused, currentTime frozen at 0, no error raised
    // anywhere — and nothing short of a fresh load() recovers it (measured; StrictMode reproduces it
    // every dev boot). Risking a silently dead rain effect to save some decode on the one preset
    // where it isn't visible is a bad trade, so playback is left alone.
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      materialRef.current.map.needsUpdate = true
    }
  })
  return null
}


// --- Sky backdrop: a photo, not a procedural dome ---------------------------------------
// GEO_SkyBackdrop is a wide plane authored in Blender far behind the outdoor diorama (see
// desk_master.blend) — Blender owns its physical placement/size; this owns WHICH photo is on
// it and how it cross-fades, which is dynamic/weather-driven behavior (CLAUDE.md decision
// framework). Replaces the old procedural gradient+sun/moon+stars+baked-cloud dome entirely:
// each photo already contains its own full sky (gradient, clouds, sun/moon, stars for night).
// The REAL interior directional light (sun/moon) stays fully independent — see Lights below,
// still driven by weather.js's `sky.sunDir`/`sun.color`/`sun.intensity` — so switching the
// backdrop photo never touches how the room itself is actually lit.
const SKY_BACKDROP_URLS = {
  sunnyMorning: asset('sky/backdrop_sunnyMorning.webp'),
  foggyMorning: asset('sky/backdrop_foggyMorning.webp'),
  rainyDay: asset('sky/backdrop_rainyDay.webp'),
  sunsetGolden: asset('sky/backdrop_sunsetGolden.webp'),
  night: asset('sky/backdrop_night.webp'),
}
// GEO_SkyBackdrop's authored size (Blender) vs the source photos' native size — used to crop
// the wider-than-plane photos to "cover" without stretching. Keep in sync with Blender if the
// backdrop plane is resized (see desk_master.blend / add_backdrop_planes.py).
const BACKDROP_PLANE_ASPECT = 40 / 30
const BACKDROP_PHOTO_ASPECT = 1491 / 1054
// Per-photo UV offset (applied on TOP of the shared cover-crop) — each photo was framed
// independently, so a subject (e.g. the moon in the night photo, up near its top-right) can
// land outside the window's actual visible slice of the shared plane. This is a per-PHOTO
// composition fix, so it lives in code, not in Blender (which only controls the one shared
// plane's physical placement — moving it there would shift all 5 photos equally).
const BACKDROP_UV_OFFSET = {
  sunnyMorning: [0, 0],
  foggyMorning: [0, 0],
  rainyDay: [0, 0],
  // sun core measured at u=0.574, v=0.024 (near-bottom, slightly right of centre) in the source
  // photo. Shift left to centre it horizontally; -0.10 vertically put it right behind the fence
  // /house roofline (fully hidden) — pulled up further so it clears the roofline and reads as a
  // visible low sun near the bottom of the window instead of a hidden glow.
  sunsetGolden: [-0.07, -0.30],
  night: [0.16, 0.07], // shift the sampled window right+up so the moon (near the photo's own
                        // top-right) lands inside the visible window instead of just off-frame
}
const BACKDROP_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const BACKDROP_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexFrom, uTexTo;
uniform float uMix;
uniform vec2 uCover;
uniform vec2 uOffsetFrom, uOffsetTo;
void main(){
  vec2 base = (vUv - 0.5) * uCover + 0.5;
  vec3 a = texture2D(uTexFrom, base + uOffsetFrom).rgb;
  vec3 b = texture2D(uTexTo, base + uOffsetTo).rgb;
  gl_FragColor = vec4(mix(a, b, uMix), 1.0);
}
`
function SkyBackdrop({ weather }) {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const matRef = useRef()
  const texMap = useTexture(SKY_BACKDROP_URLS)
  useMemo(() => {
    Object.values(texMap).forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
      t.needsUpdate = true
    })
  }, [texMap])
  const getTex = (key) => texMap[key] || texMap.sunnyMorning
  const getOffset = (key) => BACKDROP_UV_OFFSET[key] || [0, 0]
  const cover = useMemo(() => {
    // "background-size: cover" crop, computed once from the fixed plane/photo aspect ratio.
    return BACKDROP_PLANE_ASPECT < BACKDROP_PHOTO_ASPECT
      ? new THREE.Vector2(BACKDROP_PLANE_ASPECT / BACKDROP_PHOTO_ASPECT, 1)
      : new THREE.Vector2(1, BACKDROP_PHOTO_ASPECT / BACKDROP_PLANE_ASPECT)
  }, [])
  const uniforms = useMemo(() => ({
    uTexFrom: { value: getTex(weather.current.bgFromKey) },
    uTexTo:   { value: getTex(weather.current.bgToKey) },
    uMix:     { value: weather.current.bgMix },
    uCover:   { value: cover },
    uOffsetFrom: { value: new THREE.Vector2(...getOffset(weather.current.bgFromKey)) },
    uOffsetTo:   { value: new THREE.Vector2(...getOffset(weather.current.bgToKey)) },
  }), [])
  useEffect(() => {
    const card = scene.getObjectByName('GEO_SkyBackdrop')
    if (!card) { console.warn('[SkyBackdrop] GEO_SkyBackdrop not found — add it in Blender and re-export scene.glb (see CLAUDE.md)'); return }
    // Raw, non-transparent ShaderMaterial — the proven-working pattern in this scene/renderer
    // (the old sky dome used the same approach successfully). It never references scene fog,
    // which matters here: the backdrop sits ~33 world units out, beyond every weather's
    // fog.far, so a built-in material would need explicit fog:false to avoid washing to the
    // fog colour — a raw custom shader is naturally immune since it doesn't include fog code.
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG, side: THREE.DoubleSide,
    })
    card.material = material
    card.castShadow = false
    card.receiveShadow = false
    matRef.current = material
    return () => material.dispose()
  }, [scene, uniforms])
  useFrame(() => {
    const u = matRef.current?.uniforms
    if (!u) return
    u.uTexFrom.value = getTex(weather.current.bgFromKey)
    u.uTexTo.value = getTex(weather.current.bgToKey)
    u.uMix.value = weather.current.bgMix
    u.uOffsetFrom.value.set(...getOffset(weather.current.bgFromKey))
    u.uOffsetTo.value.set(...getOffset(weather.current.bgToKey))
  })
  return null
}

// NOTE: an earlier "fog mist overlay" card (a flat photo just behind the window, same slot
// pattern as the rain video) was removed — even at low opacity it washed the cherry tree/house
// behind it toward flat white, fighting the natural depth-based fade the scene's real distance
// fog (see FOG in scene.js / weather.js `fog.near/far`) already does correctly on its own
// (near stays clear, far fades) — see GEO_FogCard in desk_master.blend (now hidden, unused).

// ── Weather live-state (preset-agnostic interpolation) ──────────────────────────────
// The scene keeps ONE `live` snapshot of every weather-driven value + a `targetLive` snapshot
// of the SELECTED preset. Each frame WeatherDriver eases live→targetLive (exponential
// smoothing, ~1s settle), so switching between ANY presets — or re-selecting mid-transition —
// is always smooth. Lights/LampLight read `live`; no React re-render drives the animation.
// (The sky BACKDROP crosses over on its own separate, faster timer — see bgMix/kFast.)
function makeLive(p) {
  return {
    sunColor: new THREE.Color(p.sun.color), sunI: p.sun.intensity,
    ambColor: new THREE.Color(p.ambient.color),
    ambGround: new THREE.Color(p.ambient.ground || p.ambient.color), ambI: p.ambient.intensity,
    sunDir: new THREE.Vector3().fromArray(p.sky.sunDir).normalize(),
    fogColor: new THREE.Color(p.fog.color), fogNear: p.fog.near, fogFar: p.fog.far,
    exposure: p.exposure, lampColor: new THREE.Color(p.lamp.color), lampI: p.lamp.intensity,
    night: p.grade.night, fog: p.grade.fog, rain: p.grade.rain || 0, sunset: p.grade.sunset || 0,
    shadowRadius: p.shadowRadius ?? 14,
  }
}
const _lerpN = (a, b, k) => a + (b - a) * k
// Ease every field of live snapshot L toward target snapshot T by fraction k (0..1).
function easeLive(L, T, k) {
  L.sunColor.lerp(T.sunColor, k); L.sunI = _lerpN(L.sunI, T.sunI, k)
  L.ambColor.lerp(T.ambColor, k); L.ambGround.lerp(T.ambGround, k); L.ambI = _lerpN(L.ambI, T.ambI, k)
  L.sunDir.lerp(T.sunDir, k).normalize()
  L.fogColor.lerp(T.fogColor, k); L.fogNear = _lerpN(L.fogNear, T.fogNear, k); L.fogFar = _lerpN(L.fogFar, T.fogFar, k)
  L.exposure = _lerpN(L.exposure, T.exposure, k); L.lampColor.lerp(T.lampColor, k); L.lampI = _lerpN(L.lampI, T.lampI, k)
  L.night = _lerpN(L.night, T.night, k); L.fog = _lerpN(L.fog, T.fog, k); L.rain = _lerpN(L.rain, T.rain, k)
  L.sunset = _lerpN(L.sunset, T.sunset, k)
  L.shadowRadius = _lerpN(L.shadowRadius, T.shadowRadius, k)
}




// Debug aid: ?scroll=<0..1> pins the scroll offset (lid/camera) so headless capture can shoot a
// fixed state (e.g. ?scroll=0.5 = lid fully open, camera at the screen). null = live scroll.
const DBG_SCROLL = (() => { try { const v = new URLSearchParams(location.search).get('scroll'); return v != null ? Math.min(1, Math.max(0, parseFloat(v))) : null } catch (e) { return null } })()

// ── MOBILE scroll source: the browser's own document scroll ──────────────────────────────
// On the mobile path there is no <ScrollControls> (see App) — the DOCUMENT scrolls, which is the
// only thing that makes a mobile browser collapse its toolbars (full reasoning in
// utils/viewport.js). This produces the same thing ScrollControls hands DeskScene: a smoothed
// 0..1 offset, read via `mobileScroll.offset`. Module scope, not React state, for the same reason
// the weather snapshot is: it's read every frame inside useFrame and must never re-render the tree.
const mobileScroll = { offset: 0 }
function MobileScrollDriver() {
  const max = useRef(0)
  useLayoutEffect(() => {
    // scrollHeight forces a layout pass, so the scrollable range is measured on mount + on the
    // events that can actually change it — never per frame. The visualViewport resize is the one
    // that fires when the toolbars collapse (window resize alone can miss it on iOS).
    const measure = () => { max.current = Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [])
  useFrame((_, dt) => {
    const target = max.current > 0 ? THREE.MathUtils.clamp(window.scrollY / max.current, 0, 1) : 0
    // Frame-rate-independent exponential smoothing, same form as WeatherDriver's easing.
    mobileScroll.offset += (target - mobileScroll.offset) * (1 - Math.exp(-Math.min(dt, 0.1) / MOBILE_SCROLL_SMOOTH))
  })
  return null
}

// ── Scroll-depth analytics: GA4 custom event at 25/50/75/100% scroll progress ────────────────
// Reads the SAME normalized 0..1 progress DeskScene's camera/scroll animation already runs on
// (scroll.offset on desktop from ScrollControls, mobileScroll.offset on mobile from the real
// document scroll) rather than raw pixel scroll — the two paths scroll completely different
// containers at completely different pixel ranges, so "percent scrolled" only means the same
// thing on both if it's read from this shared, already-normalized value, not window.scrollY.
// GA4's own built-in "scroll" enhanced-measurement event listens to the document/window scroll,
// which is real on mobile but not on desktop (ScrollControls scrolls its own private off-screen
// container) — so it can't be relied on here either; this fires a plain custom event manually
// instead, named to avoid colliding with GA4's built-in one.
// One-shot per threshold per page load: a ref (not state), since this runs every frame and must
// never trigger a re-render. `window.gtag` may not exist yet (script is `async`, or blocked by
// an ad blocker/tracking prevention) — every call is guarded, never assumed present.
const SCROLL_DEPTH_THRESHOLDS = [25, 50, 75, 100]
function ScrollAnalytics() {
  const scroll = useScroll()   // null on mobile (no <ScrollControls> there) — see App/DeskScene
  const fired = useRef(new Set())
  useFrame(() => {
    if (DBG_SCROLL != null) return   // ?scroll= debug/headless capture pins -> not a real visit
    const p = scroll ? scroll.offset : mobileScroll.offset
    const pct = Math.round(p * 100)
    for (const threshold of SCROLL_DEPTH_THRESHOLDS) {
      if (pct >= threshold && !fired.current.has(threshold)) {
        fired.current.add(threshold)
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'scroll_depth', { percent_scrolled: threshold })
        }
      }
    }
  })
  return null
}

// Portfolio projects shown ON the laptop screen. As the user scrolls through the SCREEN dwell,
// the thumbnails cross-fade in order; clicking the screen opens the current project's case study
// in a NEW tab. Add more here (same 1.48:1 thumbnail frame) to extend the reel.
const PROJECTS = [
  { name: 'SBNRI revmap', thumb: asset('projects/sbnri.png'), url: 'https://www.figma.com/proto/jzS2IyxvAHpRGq1Tw7vZ5k/PPTs?node-id=131-12134&viewport=116%2C374%2C0.17&t=XTolNU1KEmk37Cuf-1&scaling=contain&content-scaling=fixed&page-id=131%3A12073' },
  { name: 'Pinelabs POS', thumb: asset('projects/pinelabs.png'), url: 'https://www.figma.com/proto/UG9EtRhwPyYKmknhHvhEJq/Portfolio-Website?page-id=3787%3A4489&node-id=3787-4490&viewport=-15571%2C174%2C0.4&t=bFGy284DuOVPumnN-1&scaling=contain&content-scaling=fixed' },
  { name: 'Pinelabs TMS', thumb: asset('projects/pinelabs-tms.png'), url: 'https://www.figma.com/proto/UG9EtRhwPyYKmknhHvhEJq/Portfolio-Website?page-id=3687%3A2924&node-id=3687-3497&viewport=344%2C534%2C0.04&t=ape4QqqhklKEhhx0-1&scaling=contain&content-scaling=fixed' },
  { name: 'Christmas Campaign', thumb: asset('projects/sbnri-christmas.png'), url: 'https://www.figma.com/proto/RiU7UIEjiiE1YgoJYORCK6/Christmas-Bonanza-PPT?page-id=0%3A1%3Fnode-id%3D30-25930&viewport=2699%2C-1299%2C0.46&t=rNobZYksRAHUk422-1&scaling=contain&content-scaling=fixed&node-id=30-25930' },
]

function DeskScene({ lampOn, setLampOn }) {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const hinge = useRef(null)
  const camera = useThree((s) => s.camera)
  // null on the MOBILE path — there's no <ScrollControls> provider there, the document scrolls
  // instead (see MobileScrollDriver above). drei's useScroll is a plain useContext with a null
  // default, so calling it unconditionally is safe and keeps the hook order identical on both paths.
  const scroll = useScroll()

  // Project thumbnails shown ON the laptop display (mapped onto GEO_ScreenSurface's UVs, so they're
  // always coplanar + locked to the screen at any lid angle). flipY=true orients them upright.
  const projTex = useTexture(PROJECTS.map((p) => p.thumb))
  // Configured ONCE (useMemo), not in the component body. This previously ran on every render, so
  // `needsUpdate = true` was re-applied to all four 1600x1081 thumbnails on EVERY React re-render —
  // and needsUpdate forces three to re-upload the whole texture and regenerate its mipmaps. That
  // meant every weather click and every lamp toggle pushed ~28 MB to the GPU and rebuilt four
  // mipmap chains before it could draw, which is what froze the frame just before each transition.
  // The flag is only needed once, so the initial upload picks up flipY/colorSpace.
  useMemo(() => {
    projTex.forEach((tx) => {
      tx.colorSpace = THREE.SRGBColorSpace; tx.flipY = true; tx.anisotropy = 8; tx.needsUpdate = true
    })
  }, [projTex])
  // Résumé mapped onto the standee page (GEO_StandeePage, UVs span 0..1 from local X→U, Z→V).
  // flipY=false orients it upright (V maps local Z, unlike the laptop screen's local-Y mapping).
  const resumeTex = useTexture(asset('projects/resume.png?v=3'))
  useMemo(() => {
    resumeTex.colorSpace = THREE.SRGBColorSpace
    resumeTex.flipY = false
    resumeTex.anisotropy = 8
  }, [resumeTex])
  // Live cross-fade state for the screen shader (set in onBeforeCompile) + the project currently
  // shown (read by the click handler to open the right case study).
  const screenUniforms = useRef(null)
  const curProject = useRef(0)
  // The open laptop screen behaves as a subtle white light source: a point light tracked to the
  // screen mesh, ramping with how open the lid is (see useFrame).
  const screenLight = useRef()
  const screenObj = useRef(null)
  const scrLightPos = useRef(new THREE.Vector3()).current
  const scrLightNrm = useRef(new THREE.Vector3()).current

  const tmpPos = useRef(new THREE.Vector3()).current
  const tmpQuat = useRef(new THREE.Quaternion()).current
  // Lamp emissive materials, collected during setup so the on/off tap can toggle them.
  const lampMats = useRef({ bulb: [], shade: [] }).current

  useLayoutEffect(() => {
    // FIRST, before anything below mutates the cached GLB scene: snapshot + check the AUTHORED
    // content. Run last (as it used to be) it reported this very function's own material swaps as
    // Blender drift — see the long note in sceneValidation.js.
    validateScene(scene) // dev-only: warn on missing anchors/objects/materials (GLB drift)
    hinge.current = scene.getObjectByName('Laptop_Hinge')
    screenObj.current = scene.getObjectByName('GEO_ScreenSurface')
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
    // NAMED (it used to be anonymous) for two reasons: it's identifiable when inspecting materials,
    // and `isWinGlass` below matches on /glass/i — so after a hot reload, which re-runs this effect
    // against the already-swapped cached scene, the glass is still recognised and re-processed.
    // Previously the second run failed to match its own anonymous material, silently skipping the
    // glass-dust pass and leaving a freshly built material unused. Deliberately NOT called
    // 'M_Glass': that's the authored Blender slot name, and reusing it here would let this runtime
    // material satisfy sceneValidation's check for the real thing (a false negative).
    const windowGlassMat = HIGH_Q
      ? new THREE.MeshPhysicalMaterial({
          name: 'M_Glass_Runtime',
          transmission: 1.0,
          ior: 1.45,
          thickness: 0.0,
          roughness: 0.04,
          metalness: 0.0,
          color: new THREE.Color(0.92, 0.95, 0.99),
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          name: 'M_Glass_Runtime',
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
      const swap = (m) => {
        if (isWinGlass(m)) { hasGlass = true; return windowGlassMat }
        return m
      }
      if (Array.isArray(o.material)) {
        o.material = o.material.map(swap)
      } else {
        const sm = swap(o.material)
        if (sm !== o.material) o.material = sm
      }
      // Window glass -> render LAYER 2: lit by ambient only (no sun, no lamp), so no directional
      // light ever casts a specular hot-spot on the pane. Camera renders layer 2 (see Lights).
      if (hasGlass) o.layers.set(2)
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      // Scene distance fog (rootScene.fog) should ONLY ever visually reach the outside world
      // seen through the window — never the room itself. Rather than opt OUT specific interior
      // objects (fragile — anything missed, like the window frame, still fogs), default fog OFF
      // for literally everything here, then opt IN only the small, well-defined exterior set
      // below (isExterior). Opt-in is the safe default; opt-out isn't.
      mats.forEach((m) => { if (m) m.fog = false })
      // Contact-shadow grounding: the desk RECEIVES shadows; the props on it CAST
      // (and receive). Environment/tree/window are left out — they don't need to
      // cast onto the desk and it keeps the shadow map tight + cheap.
      const n = o.name.toLowerCase()
      const isDesk = /desk|table/.test(n)   // desk surface + the new dinner-table top: receive shadows, don't cast
      // raincard: the video-texture rain plane behind the window — a decal, not physical
      // geometry, so it must neither cast (was darkening the whole desk, blocking the sun
      // through the window it sits behind) nor receive shadows.
      const isEnv = /wall|window|casing|sill|divider|frame|out|forest|fence|hill|house|roof|bush|pine|ground|chimney|pole|wire|vent|branch|trunk|raincard|skybackdrop/.test(n)
      // The SOLID window assembly (sill/casing/frame/divider — NOT the transparent glass) casts the
      // sun's contact shadow onto the rear desk: the sill now physically overhangs (Blender), so its
      // shadow anchors the desk to the wall. The interior wall only RECEIVES (contact shadow + AO) —
      // it deliberately does NOT cast, so the room isn't reduced to a window-only light pool (keeps
      // the approved sunny-morning brightness). Glass + exterior stay non-shadowing (see layers).
      const isWindowSolid = /window(frame|divider|sill|casing)/.test(n)
      const isInteriorWall = /wall/.test(n)
      if (isDesk) {
        o.receiveShadow = true
      } else if (isWindowSolid) {
        o.castShadow = true
        o.receiveShadow = true
      } else if (isInteriorWall) {
        o.receiveShadow = true
      } else if (!isEnv) {
        o.castShadow = true
        o.receiveShadow = true
      }
      // Wall — largest interior surface. Warm ivory LIMEWASHED BRICK, authored as a
      // runtime GLSL procedural material (NO baked texture -> 0 KB download): running-bond
      // courses + recessed mortar joints + rough painted tooth + bump so it catches the
      // directional sun. Ref: Ai references/wall reference.png.
      if (/wall/i.test(n)) {
        mats.forEach((m) => { if (m) applyBrickWall(m) })
      }
      // Laptop lid/base/hinge/trackpad — premium matte dark-silver anodised ALUMINIUM (runtime
      // GLSL, 0 KB). Keyed by material name; hinge + trackpad share the SAME material so they
      // stay consistent with the body colour. Even soft highlight, holds shape, no clipping.
      mats.forEach((m) => { if (m && /aluminum|hinge|trackpad/i.test(m.name)) applyLaptopAluminum(m) })
      // NOTE: the desk/table, desk mat, camera, guitar and standee hardware are deliberately lit
      // ONLY by the scene — see the removed-mechanism note in proceduralMaterials.js for why the
      // emissive "readability floor" that used to lift them was taken out.
      // Laptop DISPLAY — the project reel, mapped onto GEO_ScreenSurface (UVs from Blender span
      // 0..1 on the front/back faces). A tiny GLSL VERTICAL SLIDE samples TWO project thumbnails as
      // a filmstrip: as uMix 0->1 (driven by scroll during the SCREEN dwell) the current thumbnail
      // (uTexA) slides UP and off the top while the next (uTexB) enters from the BOTTOM — like a
      // real laptop scroll. Self-lit (emissive) so it reads like a real screen in any weather.
      // uTexA/uTexB/uMix are updated per-frame from the scroll timeline (see useFrame).
      if (n === 'geo_screensurface') {
        mats.forEach((m) => {
          if (!m) return
          m.emissive = new THREE.Color(0xffffff)
          m.metalness = 0.0
          m.roughness = 0.5
          m.toneMapped = true
          m.onBeforeCompile = (shader) => {
            shader.uniforms.uTexA = { value: projTex[0] }
            shader.uniforms.uTexB = { value: projTex[Math.min(1, projTex.length - 1)] }
            shader.uniforms.uMix = { value: 0 }
            shader.uniforms.uGlow = { value: 1.0 }
            // Mobile only (0 on desktop -> uniform not declared, plain 2-arg sampling below).
            if (TEX_LOD_BIAS) shader.uniforms.uLodBias = { value: TEX_LOD_BIAS }
            screenUniforms.current = shader.uniforms
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>', '#include <common>\nvarying vec2 vScreenUv;')
              .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vScreenUv = uv;')
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>', `#include <common>\nuniform sampler2D uTexA;\nuniform sampler2D uTexB;\nuniform float uMix;\nuniform float uGlow;\nvarying vec2 vScreenUv;\nvec3 _scr = vec3(0.0);${TEX_LOD_BIAS ? '\nuniform float uLodBias;' : ''}`)
              .replace('#include <map_fragment>', `
                // filmstrip scroll: current (A) shifts up by uMix, next (B) follows one screen below.
                float _y = vScreenUv.y;
                vec3 _col = (_y >= uMix)
                  ? ${sampleBiased('uTexA', 'vec2(vScreenUv.x, _y - uMix)')}.rgb        // A's lower part, top of screen
                  : ${sampleBiased('uTexB', 'vec2(vScreenUv.x, _y - uMix + 1.0)')}.rgb; // B's upper part, bottom of screen
                diffuseColor.rgb = vec3(0.0); // display is EMISSIVE-ONLY: not re-lit by the room, so
                _scr = _col;                  // brightness is fully controlled -> crisp, no double-exposure
              `)
              .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = _scr * uGlow;')
          }
          // Bias is part of the KEY: it changes the generated source, so two different biases must
          // never share a compiled program.
          m.customProgramCacheKey = () => `project-screen-reel|lod${TEX_LOD_BIAS}`
          m.needsUpdate = true
        })
      }
      // Standee PAGE — the résumé, mapped onto GEO_StandeePage (UVs from Blender span 0..1). Unlike
      // the laptop SCREEN (a self-lit display), this is a PRINTED page: it's lit mainly by the scene
      // (matte paper albedo → picks up the warm sun, ambient + window shadows so it sits in the
      // scene), with only a small emissive FLOOR so it never goes pitch-black in dark weather.
      if (n === 'geo_standeepage') {
        mats.forEach((m) => {
          if (!m) return
          m.map = resumeTex
          m.emissive = new THREE.Color(0xffffff)
          m.emissiveMap = resumeTex
          m.emissiveIntensity = 0.15   // subtle readability floor; scene lighting dominates
          m.metalness = 0.0
          m.roughness = 0.9            // matte printed paper
          m.toneMapped = true
          // MOBILE only: sharpen the printed text by biasing the mip LOD (see TEX_LOD_BIAS above).
          // This is the worst-affected surface in the scene — the page is drawn into ~456x599 px
          // from a 1680x2260 texture, so the sampler lands on a ~450px pre-blurred mip. The patch
          // is built FROM three's own ShaderChunk source rather than a hand-copied version of it,
          // so it can't drift from the installed three, and if the replace target ever changes the
          // chunk is simply inlined unmodified (the bias quietly stops applying — never a broken
          // shader). Skipped entirely when the bias is 0, i.e. desktop keeps stock shaders.
          if (TEX_LOD_BIAS) {
            m.onBeforeCompile = (shader) => {
              shader.uniforms.uLodBias = { value: TEX_LOD_BIAS }
              const biasedMap = THREE.ShaderChunk.map_fragment
                .replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, uLodBias )')
              const biasedEmissive = THREE.ShaderChunk.emissivemap_fragment
                .replace('texture2D( emissiveMap, vEmissiveMapUv )', 'texture2D( emissiveMap, vEmissiveMapUv, uLodBias )')
              shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nuniform float uLodBias;')
                .replace('#include <map_fragment>', biasedMap)
                .replace('#include <emissivemap_fragment>', biasedEmissive)
            }
            m.customProgramCacheKey = () => `standee-page|lod${TEX_LOD_BIAS}`
          }
          m.needsUpdate = true
        })
      }
      // Camera — one physical material identity per component. M_CamMetal/M_CamDial are shared
      // across parts, so CLONE each mesh's material before applying its part-specific finish.
      // Runtime GLSL (0 KB); no pure black; parts respond differently so the camera reads in shadow.
      const camFn = {
        geo_cambody: applyCamBody, geo_camtop: applyCamBody, geo_camprism: applyCamBody,
        geo_camleatherl: applyCamLeather, geo_camleatherr: applyCamLeather,
        geo_camlensbarrel: applyCamBarrel, geo_camlensglass: applyCamGlass,
        geo_camlensring1: applyCamRing, geo_camlensring2: applyCamRing,
        geo_camshutterbtn: applyCamButton, geo_camshutterdial: applyCamButton, geo_camrewind: applyCamButton,
      }[n]
      if (camFn) {
        const cloned = mats.map((mm) => (mm ? mm.clone() : mm))
        // route per material: the body mesh carries a leather slot (its side/back faces) — give
        // that the leatherette finish; everything else gets the object's part finish (camFn).
        cloned.forEach((mm) => {
          if (!mm) return
          if (/leather/i.test(mm.name)) applyCamLeather(mm); else camFn(mm)
        })
        o.material = Array.isArray(o.material) ? cloned : cloned[0]
      }
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
      // Wooden fence — dark-brown WOOD GRAIN (tint + procedural vertical grain so it reads as
      // textured wood, not flat paint). Own shader/cache-key -> excluded from the vibrance pass below.
      mats.forEach((m) => { if (m && /outfencepainted/i.test(m.name)) applyFenceWoodGrain(m) })
      // Alpha-CUTOUT foliage. Transmissive glass can't capture alpha-BLEND objects into its
      // refraction buffer (they get skipped -> vanish/thin out behind the window). The forest
      // billboards AND the cherry-blossom petals (v176CherryFlower ships as glTF BLEND) must be
      // switched to alphaTest CUTOUT so they render OPAQUE and fully show through the glass —
      // otherwise the canopy reads far sparser in-browser than it does in Blender.
      mats.forEach((m) => {
        if (m && (/forest/i.test(m.name) || (/cherryflower/i.test(m.name) && !/stalk/i.test(m.name)))) {
          m.transparent = false
          m.alphaTest = 0.45
          m.depthWrite = true
          m.needsUpdate = true
        }
      })
      // Exterior scene objects — cherry tree, house, roof, hills, forest, ground: lift
      // their saturation so the view through the (now clear) glass reads vibrant. Excludes
      // the fence (own shader) and all interior surfaces.
      const isOutsideObj = /forest|hill|house|roof|pine|ground|chimney|branch|trunk|tree/.test(n)
        || (/out/.test(n) && !/outfence/.test(n))             // (the fence has its own wood-grain shader; excluded from vibrance)
      // NOTE: the cherry tree + house are now downloaded glTF models with their own BAKED
      // textures (materials v176Cherry* / M_OutHouseMain) — no runtime bark/cabin shaders.
      // Power wires — UNLIT flat black. MeshBasicMaterial ignores all lights, so the thin
      // cylindrical wires never catch a moving specular glint from the sun as the camera scrolls;
      // they stay a crisp constant pitch-black line.
      if (mats.some((m) => m && /outwire/i.test(m.name))) {
        o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.015, 0.015, 0.018) })
      }
      if (isOutsideObj) {
        mats.forEach((m) => {
          if (m && !/outwire/i.test(m.name)) {
            const sunAmt = /cherry/i.test(m.name) ? 0.55 : 1.35  // gentler sun-kiss on the tree blossoms
            const houseWin = /house/i.test(m.name)               // warm window glow (night only) on the hut
            applyOutsideVibrance(m, 2.2, sunAmt, houseWin)
          }
        })
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
      // Opt exterior mats BACK IN to scene distance fog (everything defaulted to fog=false
      // above) — this is the only place fog ends up visually enabled, and only for the small,
      // well-defined outside set (tree/house/fence/hill/ground/forest), never the room.
      if (isExterior) mats.forEach((m) => { if (m) m.fog = true })
      // Tame the practical lamp so it stops dominating the sunny-morning frame.
      // Bulb still blooms (reads as "on") but smaller; shade no longer clips to white.
      // Collect the emissive materials so the on/off tap can drive them (see effect below).
      mats.forEach((m) => {
        if (!m) return
        // Wooden stem + base + disc (M_LampWood) -> procedural honey-wood grain.
        if (/lampwood/i.test(m.name)) { applyLampWood(m) }
        if (/lampbulb/i.test(n)) { m.emissiveIntensity = 5.0; lampMats.bulb.push(m) }
        else if (/lampshade/i.test(n)) {
          // FROSTED ribbed-GLASS shade (applyPleatedShade): opaque cool milky-white glass with
          // vertical fluted ribs (the curvy texture). Opaque -> the bulb inside is NOT visible;
          // glows warm when lit (emissiveIntensity toggled below) + blooms. Centre = shade axis.
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
  // NOTE: deliberately no `m.needsUpdate = true` here. emissiveIntensity is a UNIFORM — three
  // uploads it from the material every frame, so nothing needs invalidating. Setting needsUpdate
  // forces three to re-derive the program for that material (rebuild its properties, recompute the
  // cache key, re-bind uniforms) which can flush the GPU pipeline mid-frame. It matters because
  // this effect is on the hot path for BOTH interactions that stutter: the lamp toggle, and any
  // weather change (which resets the lamp to the preset's default and so re-runs this).
  // needsUpdate is only required when a material's STRUCTURE changes — a map added/removed, a
  // define or flag flipped — never for a uniform value.
  useLayoutEffect(() => {
    lampMats.bulb.forEach((m) => { m.emissiveIntensity = lampOn ? 5.0 : 0 })
    lampMats.shade.forEach((m) => { m.emissiveIntensity = lampOn ? LAMP_SHADE_GLOW : 0 })
  }, [lampOn])

  // Interactive props: the lamp (toggles its light) and the laptop screen (the whole project
  // thumbnail is clickable — opens the case study). stopPropagation so the tap doesn't fall
  // through; pointer cursor signals it's interactive.
  const isHot = (name) => /lamp/i.test(name) || /screensurface/i.test(name)
  const onLampPointer = (over) => (e) => {
    if (!isHot(e.object.name)) return
    e.stopPropagation()
    document.documentElement.classList.toggle('cursor-hot', over)
  }
  const onSceneClick = (e) => {
    if (/screensurface/i.test(e.object.name)) {
      e.stopPropagation()
      const project = PROJECTS[curProject.current]
      // GA4 custom event, one per click on the laptop screen — project_name is whichever
      // thumbnail is currently on screen (curProject, kept in sync with the scroll-driven
      // cross-fade in the useFrame below), same pattern/guard as ScrollAnalytics' scroll_depth.
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'project_click', { project_name: project.name })
      }
      window.open(project.url, '_blank', 'noopener') // the project currently on screen
      return
    }
    if (!/lamp/i.test(e.object.name)) return
    e.stopPropagation()
    setLampOn((v) => !v)   // lamp toggles independently of the weather selector
  }

  useFrame(() => {
    // raw 0..1 — from ScrollControls on desktop, from the document scroll on mobile (DBG_SCROLL pins it for capture)
    const p = DBG_SCROLL != null ? DBG_SCROLL : (scroll ? scroll.offset : mobileScroll.offset)
    const clamp = THREE.MathUtils.clamp
    const pa = smootherstep(clamp(p / LID_OPEN_END, 0, 1))                                   // phase A (lid opens)
    const pb = smootherstep(clamp((p - PANEL_HOLD_END) / (1 - PANEL_HOLD_END), 0, 1))        // phase B (pan to standee)

    // Laptop lid opens during phase A only
    if (hinge.current) hinge.current.rotation.x = THREE.MathUtils.lerp(0, HINGE_OPEN, pa)

    // Open screen = subtle white light source. A RectAreaLight sits ON the screen plane emitting
    // FORWARD into the room (along the screen's face normal) — so it casts a gentle glow on the
    // keyboard/base/desk WITHOUT over-lighting the screen itself (a point light would blast it).
    // Intensity ramps with how open the lid is (pa) and fades as the camera leaves (phase B).
    if (screenLight.current && screenObj.current) {
      const m = screenObj.current.matrixWorld
      scrLightPos.setFromMatrixPosition(m)
      scrLightNrm.setFromMatrixColumn(m, 1).normalize()          // local Y = screen face normal
      if (scrLightNrm.z < 0) scrLightNrm.negate()                // face toward the room/viewer
      screenLight.current.position.copy(scrLightPos).addScaledVector(scrLightNrm, 0.01)
      screenLight.current.lookAt(scrLightPos.x + scrLightNrm.x, scrLightPos.y + scrLightNrm.y, scrLightPos.z + scrLightNrm.z)
      screenLight.current.intensity = pa * (1 - pb) * 1.6        // very subtle; only while lid open
    }

    // Camera: phase A WEBSITE->SCREEN, DWELL holds at SCREEN (pa clamps to 1), phase B SCREEN->STANDEE
    const inB = p >= PANEL_HOLD_END
    const from = inB ? SCREEN : WEBSITE
    const to = inB ? STANDEE : SCREEN
    const k = inB ? pb : pa

    // Project reel: cross-fade the thumbnails across the SCREEN dwell. Each project holds, then
    // transitions to the next. Drives the shader uMix + tracks which project is currently shown.
    if (screenUniforms.current && PROJECTS.length > 1) {
      const N = PROJECTS.length
      const dwell = clamp((p - LID_OPEN_END) / (PANEL_HOLD_END - LID_OPEN_END), 0, 1)
      const pos = dwell * (N - 1)                       // 0 .. N-1
      let i = Math.min(Math.floor(pos), N - 2)
      const frac = smootherstep(clamp((pos - i - 0.2) / 0.6, 0, 1)) // hold, then ease to next
      screenUniforms.current.uTexA.value = projTex[i]
      screenUniforms.current.uTexB.value = projTex[i + 1]
      screenUniforms.current.uMix.value = frac
      curProject.current = frac < 0.5 ? i : i + 1
    }

    tmpPos.lerpVectors(from.pos, to.pos, k)
    camera.position.copy(tmpPos)
    tmpQuat.slerpQuaternions(from.quat, to.quat, k)
    camera.quaternion.copy(tmpQuat)

    camera.fov = THREE.MathUtils.lerp(from.fov, to.fov, k)
    camera.updateProjectionMatrix()
    // Replicate Blender's vertical lens shift (off-center frustum). NDC scales with aspect.
    const shiftY = THREE.MathUtils.lerp(from.shiftY, to.shiftY, k)
    camera.projectionMatrix.elements[9] += 2 * shiftY * camera.aspect

    // DOM overlay (dev aid)
    const hintEl = document.querySelector('.hint')
    if (hintEl) hintEl.style.opacity = String(Math.max(0, 1 - p * 4))
  })

  return (
    <>
      <primitive
        object={scene}
        onClick={onSceneClick}
        onPointerOver={onLampPointer(true)}
        onPointerOut={onLampPointer(false)}
      />
      {/* Subtle white glow cast forward by the open laptop screen (positioned/ramped in useFrame). */}
      <rectAreaLight ref={screenLight} args={['#ffffff', 0, 0.29, 0.2]} intensity={0} />
    </>
  )
}

// A framed poster: black molding + white mat + SWAPPABLE poster art. w,h = OUTER frame footprint
// (keeps the wall layout stable). The poster art (`map`) is the only thing that changes on swap —
// the black frame and white mat are structural and persist across every poster automatically. Give
// me new art later and I just repoint `map`; the frame stays intact.
// (The glass glaze shader that used to live here was deleted with the pane — see the note inside.)
function FramedPoster({ map, x, y, w, h, rot = 0, z = -1.43, frame = 0.02, mat = 0.016, emissive = 0.16 }) {
  const mW = w - frame * 2, mH = h - frame * 2         // white mat opening
  const aW = mW - mat * 2, aH = mH - mat * 2           // poster art
  const dz = 0.004
  return (
    <group position={[x, y, z]} rotation={[0, 0, rot]}>
      {/* black frame molding (slight metallic sheen -> subtle beveled highlight) */}
      {/* fog={false} on all three — scene distance fog is opt-in only for the small exterior
          set (see DeskScene); this wall poster is loaded outside that traversal so it needs
          its own explicit exemption, same as WallGuitar below. */}
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#0b0b0d" roughness={0.34} metalness={0.4} fog={false} />
      </mesh>
      {/* white mat / passe-partout */}
      <mesh position={[0, 0, dz]}>
        <planeGeometry args={[mW, mH]} />
        <meshStandardMaterial color="#f3f0ea" roughness={0.92} metalness={0} fog={false} />
      </mesh>
      {/* poster art — the swappable placeholder */}
      <mesh position={[0, 0, dz * 2]}>
        <planeGeometry args={[aW, aH]} />
        <meshStandardMaterial
          map={map} emissive="#ffffff" emissiveMap={map} emissiveIntensity={emissive}
          roughness={0.86} metalness={0} fog={false}
        />
      </mesh>
      {/* NO glass glaze. There used to be a transparent pane here with diagonal light glints, and
          it was removed deliberately (2026-08-11): it was a raw ShaderMaterial, which meant it did
          not include three's logarithmic-depth shader chunks, so under `logarithmicDepthBuffer` its
          depth comparison disagreed with every other material in the scene and it was being silently
          depth-rejected. The tidy poster everyone had approved was therefore an accident of that
          mismatch — at its authored strength the glaze reaches alpha 0.92, a near-opaque white streak
          straight across the artwork, which is exactly what appeared the moment log depth was turned
          off for performance. Poster + black frame is the intended look, so the pane is gone rather
          than being re-tuned to imitate being broken. */}
    </group>
  )
}

// Wall storytelling art — framed posters/photos + a casual sticky note on the back wall
// (three-Z ≈ -1.43, just in front of the wall). Gives the cozy-designer personality of
// the reference. Positions tuned to the locked camera.
function WallArt() {
  const tex = useTexture({
    poster: asset('art/poster_longway.png'),
  })
  useMemo(() => {
    Object.values(tex).forEach((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4 })
  }, [tex])
  return (
    <group>
      {/* right strip (X 0.55..1.2) — framed poster (placeholder art, swap later) */}
      <FramedPoster map={tex.poster} x={0.87} y={1.46} w={0.50} h={0.70} />
      {/* LEFT wall — the framed photo + "keep designing" sticky note were removed 2026-07-30;
          the user will specify replacement props for this space later. */}
    </group>
  )
}

// Acoustic guitar hung on the LEFT wall — a ready-made GLB (no Draco), loaded separately so it
// doesn't bloat scene.glb. It's already ~1 m tall + Y-up with its front facing +Z (the camera),
// so it just needs positioning flat against the wall (back near three-Z ≈ -1.45). Lit by the scene.
function WallGuitar() {
  const { scene } = useGLTF(asset('models/acoustic_guitar.glb'))
  const model = useMemo(() => {
    const m = scene.clone(true)
    // Scene distance fog is opt-in only for the small exterior set (see DeskScene) — this
    // model is loaded standalone outside that traversal, so its materials default to THREE's
    // normal fog=true and need their own explicit exemption.
    m.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((mm) => { if (mm) mm.fog = false })
    })
    return m
  }, [scene])
  return <primitive object={model} position={[-0.9, 0.95, -1.40]} scale={0.9} />
}
useGLTF.preload(asset('models/acoustic_guitar.glb'))

// --- Laptop lid stickers: paper stickers on the OUTER (closed-facing) lid surface ----------
// Layout is read from the FIGMA SOURCE OF TRUTH: frame 234:990 in Portfolio-2026, whose
// "laptop lid" background rect is 735 x 511 px. Every value below is a fraction of that frame,
// so the layout scales to the real lid automatically:
//   u    = sticker centre X / 735   (0 = left edge)
//   v    = sticker centre Y / 511   (0 = hinge/back edge, 1 = front/near edge — Figma's frame
//          top maps to the hinge side, matching the Laptop_backside.png reference photo)
//   size = FULL-IMAGE width / 735, i.e. including each PNG's transparent padding. Figma crops
//          that padding away via object-cover (e.g. Astronaut's node is 126px showing the image
//          at 124.16%, so the uncropped image is 126 x 1.2416 = 156.4px), so the padding is
//          scaled back IN here — our planes map the whole PNG, padding included.
//   rotDeg = clockwise rotation in degrees.
// Rotations were cross-checked against the node bounding boxes rather than trusted blind: for a
// w0 x h0 rect rotated by t, bbox W = |w0*cos t| + |h0*sin t|. Claude: 117*(|cos|+|sin|) = 159.825
// -> |cos|+|sin| = 1.366 -> t = 150 (or 30). Figma's reported origin-corner (176.825, 130.325)
// only matches -150 deg (Figma CCW) = 150 deg clockwise, which rules out the 30 deg alternative.
// The same check confirms Astronaut -150, Figma sticker 165, IITR -20.84. Cherry has no rotation
// but IS mirrored vertically (-scale-y-100 in Figma) -> flipY.
const LAPTOP_STICKERS = [
  { url: asset('stickers/claude.png'),    u: 0.13185, v: 0.21313, size:  87.276 / 735, rotDeg: 150,    ratio: 468 / 468 },
  { url: asset('stickers/figma.png'),     u: 0.23934, v: 0.47936, size:  89.372 / 735, rotDeg: 165,    ratio: 368 / 440 },
  { url: asset('stickers/cherry.png'),    u: 0.50068, v: 0.50098, size:  78.000 / 735, rotDeg: 0,      ratio: 312 / 312, flipY: true },
  { url: asset('stickers/astronaut.png'), u: 0.14422, v: 0.81801, size: 118.347 / 735, rotDeg: -150,   ratio: 504 / 504 },
  { url: asset('stickers/iitr.png'),      u: 0.39613, v: 0.78700, size: 117.763 / 735, rotDeg: -20.84, ratio: 572 / 572 },
]
// The lid ROTATES via Laptop_Hinge during scroll (opening) — these can't be independent
// world-space planes like WallArt/FramedPoster (those only work because the wall never moves).
// They're computed ONCE from the lid's CLOSED-state world bounding box (hinge angle is always 0
// at mount — scroll starts at 0, same "measure once while closed" trick LaptopContactShadow uses
// for the desk-mat placement), then added as CHILDREN of the lid mesh so they inherit its hinge
// rotation for free from then on, whatever angle it's later opened to.
function LaptopStickers() {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const textures = useTexture(LAPTOP_STICKERS.map((s) => s.url))
  useEffect(() => {
    const lid = scene.getObjectByName('GEO_LaptopLid')
    if (!lid) { console.warn('[LaptopStickers] GEO_LaptopLid not found — add it in Blender and re-export scene.glb (see CLAUDE.md)'); return }
    lid.updateWorldMatrix(true, false)
    const box = new THREE.Box3().setFromObject(lid)
    const width = box.max.x - box.min.x
    const depth = box.max.z - box.min.z
    const topY = box.max.y
    const lidWorldQuat = lid.getWorldQuaternion(new THREE.Quaternion())
    const group = new THREE.Group()
    group.name = 'GEO_LaptopStickers'
    LAPTOP_STICKERS.forEach((s, i) => {
      const tex = textures[i]
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 8
      // size is a FRACTION of the Figma frame width -> scale it by the lid's real world width so
      // the layout tracks the lid's actual dimensions. (This multiply was missing before: `size`
      // was passed to PlaneGeometry as raw metres while documented as a fraction, which is why
      // Figma's true fractions rendered as ~20cm stickers on a ~41cm lid.)
      const planeW = s.size * width
      const planeH = (s.size / s.ratio) * width
      // Matte paper, lit ENTIRELY by the scene — no emissive, no readability floor. The floor
      // (used on the laptop/desk/guitar) adds a flat emissive lift that RISES at night, so the
      // stickers were self-lit: they got brighter as the lid got darker, which is exactly why they
      // read as pasted-on decals instead of paper stuck to the metal. Paper on a dark lid SHOULD
      // fall into shadow with it, so these deliberately opt out of that treatment.
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.08, depthWrite: false,
        roughness: 0.85, metalness: 0, side: THREE.DoubleSide, fog: false,
      })
      const geo = new THREE.PlaneGeometry(planeW, planeH)
      // Cherry is mirrored vertically in the Figma source. Flip the UVs rather than using
      // mesh.scale.y = -1: a negative scale also flips the NORMAL, which would light the sticker
      // from behind (reading dark) now that it's fully scene-lit rather than emissive.
      if (s.flipY) {
        const uv = geo.attributes.uv
        for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - uv.getY(k))
        uv.needsUpdate = true
      }
      const mesh = new THREE.Mesh(geo, mat)
      // Take the sun's cast shadows (window frame / tree) like the lid underneath does — the lid
      // gets receiveShadow in the DeskScene traverse, but these are added afterwards so they need
      // it set explicitly. castShadow stays OFF: they're 1.5mm-offset decals, and self-shadowing
      // onto the lid directly beneath them would just produce acne.
      mesh.receiveShadow = true
      mesh.castShadow = false
      const worldPos = new THREE.Vector3(box.min.x + s.u * width, topY + 0.0015, box.min.z + s.v * depth)
      mesh.position.copy(lid.worldToLocal(worldPos))
      // Plane default normal is +Z; rotate -90 deg about X to lay it flat (normal -> world +Y,
      // local +Y -> world -Z i.e. "image up" points to the hinge/back edge, matching the
      // reference photo's orientation), with the sticker's own clockwise rotation applied FIRST
      // (about the plane's own normal, before flattening) so it rotates in-plane, not tilts out.
      const worldQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 2, 0, THREE.MathUtils.degToRad(-s.rotDeg))
      )
      mesh.quaternion.copy(lidWorldQuat.clone().invert().multiply(worldQuat))
      group.add(mesh)
    })
    lid.add(group)
    return () => {
      lid.remove(group)
      group.traverse((o) => { o.material?.dispose(); o.geometry?.dispose() })
    }
  }, [scene, textures])
  return null
}
useTexture.preload(LAPTOP_STICKERS.map((s) => s.url))

function Lights({ weather }) {
  const M = WEATHER.sunnyMorning
  const camera = useThree((s) => s.camera)
  const sunRef = useRef()
  const ambRef = useRef()
  // Key light = the sun (day) / moon (night) — ONE directional. Its direction follows the live
  // sky sunDir so shading agrees with where the disc/moon is drawn (glTF: window/outside at -Z).
  const sunPos = useMemo(
    () => new THREE.Vector3().fromArray(M.sky.sunDir).multiplyScalar(12),
    []
  )
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const L = weather.current.live
    if (sunRef.current) {
      sunRef.current.color.copy(L.sunColor)
      sunRef.current.intensity = L.sunI
      // Move the key light with the sun/moon so shading + the disc stay aligned.
      sunRef.current.position.copy(tmp.copy(L.sunDir).multiplyScalar(12))
      // Per-weather shadow softness (e.g. Foggy wants softer edges than Morning) — eased like
      // every other live value so switching presets transitions smoothly, not with a hard cut.
      sunRef.current.shadow.radius = L.shadowRadius
    }
    if (ambRef.current) {
      ambRef.current.color.copy(L.ambColor)
      ambRef.current.groundColor.copy(L.ambGround)
      ambRef.current.intensity = L.ambI
    }
  })
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
      {/* LIGHT 2 of 3 — the room's single AMBIENT fill, now a HEMISPHERE so the fill has
          direction: cool sky/window bounce from above (w.ambient.color) vs. warm floor/desk
          bounce from below (w.ambient.ground). This fakes subtle indirect bounce + warm/cool
          separation and kills the flat evenly-lit look — still ONE fill light, weather-driven. */}
      <hemisphereLight
        ref={ambRef}
        color={M.ambient.color}
        groundColor={M.ambient.ground || M.ambient.color}
        intensity={M.ambient.intensity}
      />
      {/* LIGHT 1 of 3 — the SUN. Single directional key, raking in through the window (-Z);
          colour/intensity are weather-driven. Casts the contact shadows that ground the props. */}
      <directionalLight
        ref={sunRef}
        position={sunPos.toArray()}
        color={M.sun.color}
        intensity={M.sun.intensity}
        castShadow
        shadow-mapSize={qp().shadowMapSize}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={M.shadowRadius}
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

// LIGHT 3 of 3 — the TABLE LAMP point light. Resolves its position from the Blender anchor
// LIGHT_ANCHOR_LAMP (parented to the lamp in desk_master.blend), so moving the lamp in Blender
// moves the light with ZERO code change (falls back to LAMP_LIGHT.position if the anchor is
// missing). Stays on the default layer 0 so it lights interior meshes only (see Lights). The
// warm shade/bulb emissive + bloom give the visible glow; this light does the actual spill.
function LampLight({ on, weather }) {
  const { scene } = useGLTF(GLB_URL, DRACO_PATH)
  const ref = useRef()
  const pos = useMemo(() => {
    const a = scene.getObjectByName(LAMP_LIGHT.anchor)
    if (a) {
      a.updateWorldMatrix(true, false)
      return a.getWorldPosition(new THREE.Vector3()).toArray()
    }
    if (typeof console !== 'undefined') console.warn(`[scene] anchor '${LAMP_LIGHT.anchor}' not found in GLB — using fallback lamp light position`)
    return LAMP_LIGHT.position
  }, [scene])
  // The lamp reuses the same point light (no new light); its colour + strength follow the live
  // weather snapshot (warmer + cozier at night). Falloff (distance/decay) is unchanged.
  useFrame(() => {
    if (!ref.current) return
    const L = weather.current.live
    ref.current.color.copy(L.lampColor)
    ref.current.intensity = on ? L.lampI * LAMP_LIGHT.intensity : 0
  })
  return (
    <pointLight
      ref={ref}
      position={pos}
      color={LAMP_LIGHT.color}
      intensity={on ? LAMP_LIGHT.intensity : 0}
      distance={LAMP_LIGHT.distance}
      decay={LAMP_LIGHT.decay}
    />
  )
}

// Drives the weather cross-fade. Lights/material-grade values ease on the slower ~1s settle
// (frame-rate-independent exponential smoothing) as before; the sky BACKDROP photo and the fog
// mist overlay ease on their OWN faster timer (kFast, ~0.25s settle) — deliberately decoupled
// per spec: "backdrop easing out and in, but quickly, not as slow as the lights".
function WeatherDriver({ weather }) {
  const gl = useThree((s) => s.gl)
  const rootScene = useThree((s) => s.scene)
  useFrame((_, dt) => {
    const w = weather.current
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 5.5)    // lights/fog/material grade — ~1s settle
    const kFast = 1 - Math.exp(-Math.min(dt, 0.1) * 16) // backdrop photo crossfade — ~0.25s settle
    easeLive(w.live, w.targetLive, k)
    w.bgMix = _lerpN(w.bgMix, 1, kFast)
    const L = w.live
    gl.toneMappingExposure = L.exposure
    if (rootScene.fog) { rootScene.fog.color.copy(L.fogColor); rootScene.fog.near = L.fogNear; rootScene.fog.far = L.fogFar }
    if (rootScene.background && rootScene.background.isColor) rootScene.background.copy(L.fogColor)
    setOutsideWeather(L.night, L.fog, L.rain)
  })
  return null
}

// Glass-pill weather tab bar (bottom-right, out of the window's sightline — the earlier
// top-center placement sat in the middle of the view). Figma "2nd iteration" spec: fixed-size
// tabs (no hover/idle resizing), unselected labels dimmed to 60% opacity. Selection is shown
// by a single highlight pill that SLIDES between tab positions (translateX, one element) rather
// than each tab toggling its own background — reads as one continuous motion when switching.
function WeatherSelector({ preset, setPreset }) {
  const selectedIndex = Math.max(0, PRESETS.findIndex((p) => p.key === preset))
  // The highlight's geometry is owned entirely by CSS (--tab-w per breakpoint, see styles.css);
  // JS passes only the selected INDEX as --sel. Measuring the tab in JS instead was a source of
  // real bugs: a resize/rotate reads offsetLeft before the newly-matched breakpoint has reflowed,
  // so the highlight ended up offset by the padding delta (2px) or kept a stale width — and
  // neither a resize listener nor a ResizeObserver+rAF fixed it reliably. With the widths in CSS
  // there is nothing to synchronise, so the breakpoints can never desync it.
  return (
    <div className="weather-select" style={{ '--sel': selectedIndex }}>
      <div className="weather-select-highlight" />
      {PRESETS.map((p) => (
        <button
          key={p.key}
          className={p.key === preset ? 'active' : ''}
          onClick={() => setPreset(p.key)}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

// Personal-branding glass badge (bottom-right, fixed size — Figma "Logo" spec). At rest it's
// just the logo in its glass pill; hovering reveals the "©2026 …" credit line growing out to
// its left (the logo itself never moves), and it collapses back the moment the pointer leaves
// the whole badge (logo + revealed text share one hover region, so drifting onto the text
// while reading it doesn't hide it).
// On MOBILE there is no hover, so the credit line is revealed by TAPPING the logo (Figma mobile
// spec: 215:861 idle -> 215:957 tapped) and dismissed by tapping it again or anywhere outside.
// Desktop keeps the hover behaviour; the two are independent (`hovered || tapped`), so a mouse
// user is unaffected and a touch user never needs a hover that will never arrive.
// How long the tapped credit line stays up before collapsing on its own.
const CREDIT_AUTO_HIDE_MS = 2000
// ?credit=1 pins the credit line open so headless capture can shoot the tapped state (same
// debug-param convention as ?scroll= / ?weather= / ?hq=). Read once at module load; it also
// suppresses the auto-hide below, otherwise the pinned state would vanish 2s into a capture.
const CREDIT_PINNED = (() => {
  try { return new URLSearchParams(location.search).get('credit') === '1' } catch (e) { return false }
})()
function BrandBadge() {
  const [hovered, setHovered] = useState(false)
  const [tapped, setTapped] = useState(CREDIT_PINNED)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!tapped) return
    // pointerdown (not click) so the dismiss lands before the canvas handles the gesture.
    const onOutside = (e) => { if (!rootRef.current?.contains(e.target)) setTapped(false) }
    document.addEventListener('pointerdown', onOutside)
    return () => document.removeEventListener('pointerdown', onOutside)
  }, [tapped])
  // Auto-collapse a short while after the tap. Touch has no pointer-leave to close it, so
  // without this it sits open indefinitely. Tapping the logo again or anywhere outside still
  // dismisses it immediately — this only adds the timeout path (the cleanup cancels the timer
  // whenever `tapped` flips back, so a manual dismiss doesn't leave a stray timer behind).
  useEffect(() => {
    if (!tapped || CREDIT_PINNED) return
    const t = setTimeout(() => setTapped(false), CREDIT_AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [tapped])
  const visible = hovered || tapped
  return (
    <div
      className="brand-badge"
      ref={rootRef}
      // Pointer events filtered to real hover-capable devices. Touchscreens fire COMPATIBILITY
      // mouseenter on tap and never a matching mouseleave, so with onMouseEnter the `hovered`
      // flag latched on permanently after the first tap — `visible = hovered || tapped` then
      // stayed true and neither the auto-hide timer nor a second tap could close the credit line.
      onPointerEnter={(e) => { if (e.pointerType !== 'touch') setHovered(true) }}
      onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHovered(false) }}
    >
      {/* The space before <br /> matters: mobile hides the break (see styles.css) and collapsing
          the two lines without it produced "Shakit.All Rights Reserved.". Desktop keeps the
          two-line layout — a trailing space before a forced break hangs and doesn't shift the
          right-aligned text. */}
      <span className={`brand-badge-text${visible ? ' is-visible' : ''}`}>
        ©2026 Himanshu Shakit.{' '}<br />All Rights Reserved.
      </span>
      <button
        type="button"
        className="brand-badge-logo"
        aria-label="Copyright information"
        aria-expanded={visible}
        onPointerDown={(e) => e.stopPropagation()}   // don't let the outside-dismiss see our own tap
        onClick={() => setTapped((v) => !v)}
      >
        <img src={brandLogo} alt="Himanshu Shakit" width={30} height={24} />
      </button>
    </div>
  )
}

// Boot loader — Figma "Loader - Desktop/Mobile - 0% / In Between / 100%" (nodes 242:1030,
// 247:1146, 247:1153, 242:1097, 247:1160, 247:1167). Covers the whole screen from first
// paint; the progress bar tracks REAL asset loading (see useBootLoad above), not a scripted
// animation, so it actually reflects how close the scene is to being render-ready. Once
// loading completes, holds briefly (LOADER_HOLD_MS) so the fill visibly reaches 100% rather
// than snapping, then fades — the Canvas underneath has been mounted and rendering the whole
// time (nothing is deferred), so by the time the fade starts every material's shader has
// already compiled on a real frame behind this opaque cover, and the reveal itself is instant.
const LOADER_HOLD_MS = 300       // pause at 100% before the fade starts (reads as deliberate, not a snap)
const LOADER_FADE_MS = 700       // must match .loader-screen's CSS transition duration
const LOADER_MAX_WAIT_MS = 20000 // safety: force-reveal even if some asset never resolves
function Loader() {
  const boot = useBootLoad()
  const [hidden, setHidden] = useState(false)
  const [mounted, setMounted] = useState(true)
  // Freeze scrolling while the cover is up (styles.css keys off `.is-booting`, and only applies it
  // on the mobile path where the document is the scroller). Without it a swipe during load runs the
  // timeline forward behind the cover, so the reveal lands on a half-open laptop instead of the
  // composed hero frame. Released as soon as the fade starts, not after it finishes.
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('is-booting', !hidden)
    return () => root.classList.remove('is-booting')
  }, [hidden])
  useEffect(() => {
    let holdTimer, unmountTimer
    const maxTimer = setTimeout(() => {
      if (!bootLoad.done) { bootLoad.progress = 100; bootLoad.done = true; _notifyBootLoad() }
    }, LOADER_MAX_WAIT_MS)
    if (boot.done) {
      holdTimer = setTimeout(() => {
        setHidden(true)
        unmountTimer = setTimeout(() => setMounted(false), LOADER_FADE_MS)
      }, LOADER_HOLD_MS)
    }
    return () => { clearTimeout(holdTimer); clearTimeout(unmountTimer); clearTimeout(maxTimer) }
  }, [boot.done])
  if (!mounted) return null
  return (
    <div className={`loader-screen${hidden ? ' is-hidden' : ''}`} role="status" aria-live="polite" aria-label="Loading">
      <div className="loader-text">
        <p className="loader-title">Hey, I’m Himanshu</p>
        <p className="loader-subtitle">Just a sec, Pulling up a chair...</p>
      </div>
      <div className="loader-track">
        <div className="loader-fill" style={{ width: `${boot.progress}%` }} />
      </div>
    </div>
  )
}

// Portrait fallback for phones. Genuine landscape locking only exists for installed PWAs (the
// manifest's "orientation") and via screen.orientation.lock() on Android while fullscreen — iOS
// Safari has no such API at all, so a portrait visitor is asked to rotate. Visibility is pure CSS
// (see .rotate-gate media query), which means it reacts to rotation with no JS/resize listener.
function RotateGate() {
  return (
    <div className="rotate-gate">
      <div className="rotate-gate-phone" />
      <p className="rotate-gate-title">
        Rotate to view
        <span className="rotate-gate-sub">Best experienced on a laptop/desktop</span>
      </p>
    </div>
  )
}

// Mobile viewport housekeeping, all of it best-effort and all of it a no-op on desktop:
//  - landscape lock, for the platforms that permit it (installed PWAs / Android Chrome in
//    fullscreen). Rejects harmlessly everywhere else — notably iPhone Safari, which is exactly why
//    RotateGate above exists as the universal fallback.
//  - real fullscreen on the first touch where the API exists, which is what actually removes the
//    browser's toolbars rather than just letting them collapse (see utils/viewport.js for the full
//    picture, including why an iPhone can't be made to load fullscreen in-browser at all).
function useImmersiveViewport() {
  useEffect(() => {
    lockLandscape()                     // covers the already-installed case
    return initImmersiveFullscreen()    // arms a one-shot gesture listener; returns its cleanup
  }, [])
}

// ── WebGL context-loss recovery (2026-08-13) ────────────────────────────────────────────────
// Neither three.js nor @react-three/fiber does anything on their own when the GPU context is
// lost — confirmed by reading the r3f source, there is no 'webglcontextlost' listener anywhere
// in it. Without one, a lost context (the browser reclaiming GPU memory under pressure — the
// most likely cause on real phones given this scene's texture/render-target weight) leaves the
// canvas permanently black forever with the rest of the page (weather selector, etc.) still
// alive and responsive — which is exactly the "loads fine, then goes black" reports from real
// devices (iPhone 14, others), as distinct from the earlier full-tab-crash reports.
// Actually re-uploading every texture/material/shader in this scene by hand after restoration
// is a large, fragile undertaking for a portfolio site, so the fallback here is a clean reload
// instead — the same outcome a first visit gets, just automatic. `preventDefault()` on the
// lost-context event is required for the browser to even attempt restoration at all; harmless
// to call even though we don't rely on restoration succeeding, since a reload is already queued.
// Capped at 2 auto-reloads per tab session (sessionStorage, so a fresh tab/visit gets a full
// budget again) so a device that's fundamentally over the memory budget can't loop forever —
// past the cap it just leaves the black canvas rather than reload-looping.
const WEBGL_RELOAD_KEY = 'webglReloadCount'
const WEBGL_RELOAD_MAX = 2
function useWebGLContextRecovery(canvas) {
  useEffect(() => {
    if (!canvas) return
    const onLost = (e) => {
      e.preventDefault()
      let count = 0
      try { count = Number(sessionStorage.getItem(WEBGL_RELOAD_KEY) || '0') } catch (err) {}
      console.warn(`[webgl] context lost (reload ${count + 1}/${WEBGL_RELOAD_MAX})`)
      if (count >= WEBGL_RELOAD_MAX) return
      try { sessionStorage.setItem(WEBGL_RELOAD_KEY, String(count + 1)) } catch (err) {}
      window.location.reload()
    }
    canvas.addEventListener('webglcontextlost', onLost, false)
    return () => canvas.removeEventListener('webglcontextlost', onLost, false)
  }, [canvas])
}

export default function App() {
  // Weather: one of the presets in PRESETS. The 3D components read `weather.current.live`
  // each frame (eased toward `targetLive` by WeatherDriver over ~1s). `preset` is the discrete
  // UI selection driven by the top-left selector. Deep-link: ?weather=<key> (or legacy ?night).
  const bootPreset = useMemo(() => {
    try {
      const q = new URLSearchParams(location.search)
      const w = q.get('weather')
      if (w && WEATHER[w]) return w
      if (q.has('night')) return 'night'
      if (q.has('fog')) return 'foggyMorning'
    } catch (e) {}
    return 'sunnyMorning'
  }, [])
  const weather = useRef(null)
  if (!weather.current) {
    weather.current = {
      live: makeLive(WEATHER[bootPreset]), targetLive: makeLive(WEATHER[bootPreset]),
      // Backdrop photo crossfade (see SkyBackdrop/WeatherDriver): from==to at boot, mix=1 ->
      // settled, no fade.
      bgFromKey: bootPreset, bgToKey: bootPreset, bgMix: 1,
    }
  }
  const [preset, setPreset] = useState(bootPreset)
  const [lampOn, setLampOn] = useState(WEATHER[bootPreset].lamp.defaultOn)
  // Resolved once: the device tier's render knobs (+ any ?dpr/?msaa/?smaa/?ao debug override).
  // On desktop every value here is the approved HIGH one, so this reads exactly as before.
  const Q = useMemo(() => qp(), [])
  useImmersiveViewport()   // best-effort landscape lock + fullscreen; RotateGate covers the refusals
  // Set once via Canvas's onCreated below, once the real WebGL context/canvas element exists.
  const [glCanvas, setGlCanvas] = useState(null)
  useWebGLContextRecovery(glCanvas)

  // On a weather switch: point the transition at the new preset, and reset the lamp to that
  // weather's DEFAULT (night ON; morning + fog OFF). Manual lamp taps in between stay independent.
  useEffect(() => {
    weather.current.targetLive = makeLive(WEATHER[preset])
    weather.current.bgFromKey = weather.current.bgToKey
    weather.current.bgToKey = preset
    weather.current.bgMix = 0
    setLampOn(WEATHER[preset].lamp.defaultOn)
  }, [preset])

  return (
    <>
      {/* Glass-pill weather selector (bottom-left). Selecting a tab smoothly transitions the
          whole scene. The lamp toggle is separate. */}
      <WeatherSelector preset={preset} setPreset={setPreset} />
      {/* Personal-branding badge (bottom-right) — logo only at rest; the credit line reveals on
          hover (desktop) or on TAP (mobile, per Figma 215:957). */}
      <BrandBadge />
      {/* Phone in portrait -> "rotate your device" (CSS-gated; see .rotate-gate in styles.css). */}
      <RotateGate />
      {/* Boot loader — opaque, sits above everything (including RotateGate) until real asset
          loading completes; see Loader/useBootLoad above. */}
      <Loader />
      <Canvas
        shadows
        frameloop="never"
        dpr={Q.dpr}
        // MOBILE only: lift the canvas out of the document flow (fixed, sized in dvh) so the tall
        // scroll spacer below can give `body` real scroll height without pushing the scene off
        // screen. undefined on desktop -> fiber's own relative/100%/100% box, untouched.
        style={IS_MOBILE_VIEWPORT ? MOBILE_CANVAS_STYLE : undefined}
        // Renderer flags are per-tier (config/quality.js). HIGH keeps antialias + the default power
        // preference; LOW trades antialias away to pay for a ~2.5x higher-resolution frame.
        // logarithmicDepthBuffer is now false on BOTH tiers — it was the single biggest cost in the
        // renderer (~4x on Apple GPUs, which is why a MacBook ran the scene at ~10 fps while a GTX
        // 1660 Super desktop was smooth). See the LOG DEPTH note in config/quality.js.
        gl={{
          antialias: Q.antialias,
          logarithmicDepthBuffer: Q.logarithmicDepthBuffer,
          powerPreference: Q.powerPreference,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: TONE_MAPPING_EXPOSURE,
        }}
        camera={{ position: WEBSITE.pos.toArray(), fov: WEBSITE.fov, near: 0.05, far: 40 }}
        // Hands the real <canvas> element to useWebGLContextRecovery above, once it exists.
        onCreated={(state) => setGlCanvas(state.gl.domElement)}
      >
        <color attach="background" args={[BACKGROUND_COLOR]} />
        {/* Atmospheric perspective: distant exterior hazes toward sky colour; near keeps the
            whole interior + tree/fence crisp. The sky backdrop plane sits beyond fog.far on
            purpose and ignores fog entirely (see SkyBackdrop), so the photo stays vivid. */}
        <fog attach="fog" args={[FOG.color, FOG.near, FOG.far]} />
        <FrameLimiter fps={RENDER_FPS} />
        <WeatherDriver weather={weather} />
        {/* Photo sky backdrop on GEO_SkyBackdrop (far behind the outdoor diorama, authored in
            Blender) — cross-fades between weather photos on its own fast timer (see WeatherDriver). */}
        <Suspense fallback={null}><SkyBackdrop weather={weather} /></Suspense>
        <Lights weather={weather} />
        <Suspense fallback={null}><WallArt /></Suspense>
        <Suspense fallback={null}><WallGuitar /></Suspense>
        <LampLight on={lampOn} weather={weather} />
        {/* Coffee steam rising from the mug. */}
        <Suspense fallback={null}><Steam weather={weather} /></Suspense>
        {/* Soft contact shadow grounding the laptop base to the desk mat. */}
        <LaptopContactShadow />
        {/* Paper stickers on the outer (closed-facing) laptop lid — see Laptop_backside.png. */}
        <Suspense fallback={null}><LaptopStickers /></Suspense>
        {/* Looping rain video on GEO_RainCard (behind the window wall, authored in Blender) —
            only visible in the rainy preset. */}
        <Suspense fallback={null}><VideoRain weather={weather} /></Suspense>
        {/* Scroll source. DESKTOP: drei's <ScrollControls>, unchanged — damping = smoothing time (s)
            for scroll.offset -> input; higher = floatier momentum "smooth scroll" (Lenis-style, like
            pinelabs.com). Everything scroll-driven (lid, camera, project slide) reads this eased
            value, so the whole scroll glides + settles.
            MOBILE: ScrollControls is deliberately NOT mounted — it would scroll its own private
            container, and a mobile browser only hides its toolbars when the DOCUMENT scrolls. There
            the document is the scroller and MobileScrollDriver derives the same offset from
            window.scrollY (see utils/viewport.js). */}
        {IS_MOBILE_VIEWPORT ? (
          <>
            <MobileScrollDriver />
            <ScrollAnalytics />
            <DeskScene lampOn={lampOn} setLampOn={setLampOn} />
          </>
        ) : (
          <ScrollControls pages={SCROLL_PAGES} damping={0.65}>
            <ScrollAnalytics />
            <DeskScene lampOn={lampOn} setLampOn={setLampOn} />
          </ScrollControls>
        )}
        {/* Soft bloom so the lit shade + bulb glow warmly. Threshold kept just above daylight
            luminance so only the glowing lamp blooms, not the window. Grade values in config/scene.js POST. */}
        {/* multisampling is per-tier (config/quality.js). HIGH = 8, which is this library's own
            default, so desktop renders into exactly the target it always did. LOW = 0: the composer
            allocates HalfFloat (RGBA16F, 8 bytes/px) targets for HDR bloom, so an 8x-multisampled
            one is what was quietly eating the mobile memory budget — dropping it is what buys the
            higher dpr, and <SMAA> below puts the edge antialiasing back for a fraction of the cost. */}
        {/* SAFARI/WEBKIT FIX (2026-08-12): `postprocessing` is pinned to 6.38.3 in package.json
            (not a range) — 6.39.0 introduced a "stable depth texture" blit (EffectComposer.
            blitDepthBuffer, for passes that set needsDepthTexture — N8AO always does, and so does
            SMAAEffect) that WebKit's stricter WebGL2 validation rejects every single frame:
            "glBlitFramebuffer: Read and write depth stencil attachments cannot be the same image."
            Chrome/Firefox silently tolerate the same call, which is why this only ever showed up in
            Safari (desktop AND iOS — reproduced on both with Playwright's WebKit engine, independent
            of device tier/multisampling). On a real iPhone the failing call every frame is what was
            crashing the tab (Safari's "A Problem Occurred" reload) shortly after scrolling starts.
            Still broken as of postprocessing 6.39.4 (latest at the time). 6.38.3 predates that blit
            path entirely. Do NOT let this drift back onto a ^6.39/^7 range without re-testing in
            actual Safari — `npm outdated` will always show it as behind. */}
        <EffectComposer disableNormalPass multisampling={Q.multisampling}>
          {/* Ambient occlusion FIRST — soft broad contact grounding (desk/wall junction, under the
              sill, under props). World-scale radius for a painterly soft-shadow read, not hard SSAO
              outlines. Runs before bloom/grade so the darkening is graded with the frame. */}
          {Q.aoEnabled && (
            <N8AO
              aoRadius={AO.radius}
              distanceFalloff={AO.distanceFalloff}
              intensity={AO.intensity}
              quality={AO.quality}
              // Half-res AO on the LOW tier only: this pass is a broad soft gradient, so it loses
              // nothing legible at half resolution, and it's ~4x cheaper — more budget for pixels.
              halfRes={Q.aoHalfRes}
              color={AO.color}
              screenSpaceRadius={false}
            />
          )}
          <Bloom
            intensity={POST.bloom.intensity}
            luminanceThreshold={POST.bloom.luminanceThreshold}
            luminanceSmoothing={POST.bloom.luminanceSmoothing}
            mipmapBlur
            radius={POST.bloom.radius}
          />
          <BrightnessContrast brightness={POST.brightnessContrast.brightness} contrast={POST.brightnessContrast.contrast} />
          <HueSaturation saturation={POST.hueSaturation.saturation} />
          <Vignette eskil={false} offset={POST.vignette.offset} darkness={POST.vignette.darkness} />
          {/* LOW tier only, and LAST so it antialiases the final graded image. Replaces the 8x MSAA
              target that tier no longer allocates: one screen-space edge-detect + blend pass instead
              of 8 samples per pixel of HDR memory. Never mounted on desktop (MSAA handles it there),
              so it cannot add a pass to the desktop chain. */}
          {Q.smaa && <SMAA />}
        </EffectComposer>
      </Canvas>

      {/* MOBILE only: the sole reason `body` has any scroll height. The canvas above is fixed on top
          of this, so the spacer is invisible and inert — it exists purely so the browser has a real
          main-frame scroll to respond to (which is what collapses its toolbars) and so
          MobileScrollDriver has a range to map window.scrollY over. Height mirrors
          <ScrollControls pages> via SCROLL_PAGES, so both paths travel the same timeline length. */}
      {IS_MOBILE_VIEWPORT && (
        <div className="mobile-scroll-spacer" aria-hidden="true" style={{ '--scroll-pages': SCROLL_PAGES }} />
      )}

      <div className="hint">
        <span>Scroll to open</span>
        {/* The source .lottie has a lot of empty canvas padding around the actual chevrons
            (measured: content occupies roughly the center 20-23 units of the 100x100 canvas) —
            crop it to a true 24x24 by rendering it oversized and clipping, same technique
            Figma used for the reference GIF (scale + negative offset + overflow hidden). */}
        <div className="hint-arrows">
          <Lottie animationData={scrollDownArrows} loop autoplay className="hint-arrows-inner" />
        </div>
      </div>
    </>
  )
}

useGLTF.preload(GLB_URL, DRACO_PATH)
