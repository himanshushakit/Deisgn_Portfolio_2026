// ============================================================================
// SCENE / ART-DIRECTION TUNING  —  CONFIG SOURCE OF TRUTH for tunable runtime values.
// ----------------------------------------------------------------------------
// Centralized so future iteration + weather work changes numbers here, not scattered
// JSX. These are the current APPROVED sunny-morning values. Weather presets may later
// override the post/fog/lamp blocks per-state (see config/weather.js schema).
// ============================================================================

// Bump the ?v= whenever scene.glb is re-exported so the browser can't serve a stale cache.
export const GLB_URL = '/scene.glb?v=34'

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
  color: '#ffbf6e',
  intensity: 0.9,                // when ON; 0 when OFF
  distance: 2.2,
  decay: 1.6,
}
// Lamp shade emissive when lit — kept above the bloom luminanceThreshold so the frosted
// shade picks up a soft warm bloom halo, without the daylight window blooming.
export const LAMP_SHADE_GLOW = 1.6
export const LAMP_BULB_EMISSIVE = 5.0

// Coffee steam billboard position (three-space; above the mug).
export const STEAM_POSITION = [-0.61, 1.06, -1.08]

// Post-processing grade (restrained sunny-morning look).
export const POST = {
  bloom: { intensity: 0.55, luminanceThreshold: 1.05, luminanceSmoothing: 0.5, radius: 0.8 },
  brightnessContrast: { brightness: 0.015, contrast: 0.075 },
  hueSaturation: { saturation: 0.07 },
  vignette: { offset: 0.42, darkness: 0.34 },
}
