// ============================================================================
// SCENE / ART-DIRECTION TUNING  —  CONFIG SOURCE OF TRUTH for tunable runtime values.
// ----------------------------------------------------------------------------
// Centralized so future iteration + weather work changes numbers here, not scattered
// JSX. These are the current APPROVED sunny-morning values. Weather presets may later
// override the post/fog/lamp blocks per-state (see config/weather.js schema).
// ============================================================================

// Bump the ?v= whenever scene.glb is re-exported so the browser can't serve a stale cache.
export const GLB_URL = '/scene.glb?v=196'

// Renderer.
export const BACKGROUND_COLOR = '#cddcf2'
export const TONE_MAPPING_EXPOSURE = 1.4
export const RENDER_FPS = 30 // fixed-cadence render loop (see FrameLimiter)

// Atmospheric fog: distant exterior (house/forest/hills) hazes toward sky colour.
// near keeps the whole interior + tree/fence crisp; only far layers soften. The custom
// Sky shader ignores fog so the sky stays vivid.
export const FOG = { color: '#c4d6ea', near: 7.5, far: 26 }

// Table lamp — the warm point light inside the shade (LIGHT 3 of 3). Position is resolved
// at runtime from the Blender anchor LIGHT_ANCHOR_LAMP (falls back to POSITION if missing).
export const LAMP_LIGHT = {
  anchor: 'LIGHT_ANCHOR_LAMP',
  position: [0.70, 1.02, -1.17], // fallback only (three-space) if the anchor isn't in the GLB
  color: '#ffb862',              // deeper tungsten warm (stronger warm/cool contrast vs the cool fill)
  intensity: 1.0,                // when ON; 0 when OFF (tuned for the physical decay below)
  distance: 3.2,                 // reaches across the right of the desk then falls off; nudged from 3.0 so nearby props pick up a touch more glow
  decay: 1.8,                    // partway back toward the softer 1.6 (from 2.0) — gentler near-field falloff so nearby objects read a softer glow, short of losing the "physical" feel entirely
}
// Lamp shade emissive when lit — kept above the bloom luminanceThreshold so the frosted
// shade picks up a soft warm bloom halo, without the daylight window blooming.
export const LAMP_SHADE_GLOW = 1.6
export const LAMP_BULB_EMISSIVE = 5.0

// Coffee steam billboard position (three-space; above the mug).
export const STEAM_POSITION = [-0.61, 1.06, -1.08]

// Ambient occlusion (N8AO pass) — soft, broad CONTACT grounding: darkens the desk/wall junction,
// under the sill, and where props touch the desk (laptop/mug/camera/lamp base). Tuned to the
// scene's real world scale (metres) for a painterly soft-shadow read, NOT hard game-like SSAO
// outlines. Keep radius broad + intensity moderate so it reads as depth, not dirt.
export const AO = {
  radius: 0.30,          // world metres — LOCAL: contact reads right at object bases, not a broad room-darkening
  distanceFalloff: 1.0,  // falloff as a fraction of radius (soft fade)
  intensity: 1.6,        // firm-but-readable contact under props/desk/sill; local (never a room-wide darken).
  // NOTE: the AO buffer's resolution is NOT here — it's a per-device performance knob, not art
  // direction, so it lives with the other tier knobs as `aoHalfRes` in config/quality.js
  // (full-res on desktop, half-res on mobile to help pay for the higher render resolution).
  quality: 'performance',
  color: 'black',
}

// Post-processing grade (restrained sunny-morning look).
export const POST = {
  bloom: { intensity: 0.38, luminanceThreshold: 1.2, luminanceSmoothing: 0.5, radius: 0.8 },
  brightnessContrast: { brightness: 0.015, contrast: 0.075 },
  hueSaturation: { saturation: 0.07 },
  vignette: { offset: 0.42, darkness: 0.34 },
}
