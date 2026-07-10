import React, { useLayoutEffect, useRef, useMemo, useState, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, ScrollControls, useScroll, Billboard, useTexture } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette, BrightnessContrast, HueSaturation } from '@react-three/postprocessing'
import * as THREE from 'three'

// ── Extracted modules (architecture recovery): config = tunable art-direction,
// materials = runtime procedural material registry. See CLAUDE.md / docs/.
import { wx } from './config/weather.js'
import { WEBSITE, SCREEN, STANDEE, HINGE_OPEN, PHASE, SCROLL_PAGES, smootherstep } from './config/camera.js'
import { HIGH_Q, qp } from './config/quality.js'
import { GLB_URL, LAMP_SHADE_GLOW, BACKGROUND_COLOR, TONE_MAPPING_EXPOSURE, RENDER_FPS, FOG, LAMP_LIGHT, STEAM_POSITION, POST } from './config/scene.js'
import { applyStuccoWall, applyWhitewashWood, applyFenceWood, applyPleatedShade, applyLampWood, applyGlassDust, applyOutsideVibrance } from './materials/proceduralMaterials.js'

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
        shadow-mapSize={qp().shadowMapSize}
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

// LIGHT 3 of 3 — the TABLE LAMP point light. Resolves its position from the Blender anchor
// LIGHT_ANCHOR_LAMP (parented to the lamp in desk_master.blend), so moving the lamp in Blender
// moves the light with ZERO code change (falls back to LAMP_LIGHT.position if the anchor is
// missing). Stays on the default layer 0 so it lights interior meshes only (see Lights). The
// warm shade/bulb emissive + bloom give the visible glow; this light does the actual spill.
function LampLight({ on }) {
  const { scene } = useGLTF(GLB_URL)
  const pos = useMemo(() => {
    const a = scene.getObjectByName(LAMP_LIGHT.anchor)
    if (a) {
      a.updateWorldMatrix(true, false)
      return a.getWorldPosition(new THREE.Vector3()).toArray()
    }
    if (typeof console !== 'undefined') console.warn(`[scene] anchor '${LAMP_LIGHT.anchor}' not found in GLB — using fallback lamp light position`)
    return LAMP_LIGHT.position
  }, [scene])
  return (
    <pointLight
      position={pos}
      color={LAMP_LIGHT.color}
      intensity={on ? LAMP_LIGHT.intensity : 0}
      distance={LAMP_LIGHT.distance}
      decay={LAMP_LIGHT.decay}
    />
  )
}

export default function App() {
  const [lampOn, setLampOn] = useState(true)
  return (
    <>
      <Canvas
        shadows
        frameloop="never"
        dpr={qp().dpr}
        gl={{
          antialias: true,
          logarithmicDepthBuffer: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: TONE_MAPPING_EXPOSURE,
        }}
        camera={{ position: WEBSITE.pos.toArray(), fov: WEBSITE.fov, near: 0.05, far: 40 }}
      >
        <color attach="background" args={[BACKGROUND_COLOR]} />
        {/* Atmospheric perspective: distant exterior hazes toward sky colour; near keeps the
            whole interior + tree/fence crisp. Custom Sky shader ignores fog, so sky stays vivid. */}
        <fog attach="fog" args={[FOG.color, FOG.near, FOG.far]} />
        <FrameLimiter fps={RENDER_FPS} />
        <Sky />
        <Lights />
        <Suspense fallback={null}><WallArt /></Suspense>
        <LampLight on={lampOn} />
        {/* Coffee steam rising from the mug. */}
        <Steam position={STEAM_POSITION} />
        <ScrollControls pages={SCROLL_PAGES} damping={0.25}>
          <DeskScene lampOn={lampOn} setLampOn={setLampOn} />
        </ScrollControls>
        {/* Soft bloom so the lit shade + bulb glow warmly. Threshold kept just above daylight
            luminance so only the glowing lamp blooms, not the window. Grade values in config/scene.js POST. */}
        <EffectComposer disableNormalPass>
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
