// ============================================================================
// WEATHER PRESETS  —  CONFIG SOURCE OF TRUTH for outside look + scene lighting
// ----------------------------------------------------------------------------
// Every preset fully describes the OUTSIDE look: sky gradient + sun + clouds + the
// scene's key light + ambient fill + optional fog. The outside GEOMETRY never changes
// between weathers (that lives in Blender) — only these lighting/atmosphere values do.
//
// The scene has exactly THREE lights (see lighting/): (1) the SUN, (2) one room AMBIENT
// fill, (3) the table lamp. `sun` + `ambient` here are weather-driven; a new weather is
// just a new numbers-only preset — no extra lights to juggle.
//
// glTF/three.js world space: +X right, +Y up, window/outside is at -Z (into the scene).
// Extend with: sunset, rainyDay, foggyMorning, night, cloudyAfternoon (schema below).
// ============================================================================
export const WEATHER = {
  sunnyMorning: {
    sky: {
      top:        [0.09, 0.38, 0.94],  // deeper saturated zenith blue
      horizon:    [0.52, 0.76, 0.98],  // clean blue horizon (less milky white)
      sunDir:     [0.34, 0.55, -0.76], // up + slightly right + toward the window (-Z)
      sunColor:   [1.0, 0.95, 0.84],
      sunSize:    0.006,
      cloud:      0.40,                // coverage 0..1
      cloudColor: [1.0, 1.0, 1.0],
      cloudSpeed: 0.008,
    },
    sun:     { color: '#ffe8bf', intensity: 3.6 }, // (1) sunlight raking through the window (-Z)
    ambient: { color: '#e7e3f0', intensity: 0.9 }, // (2) subtle room ambient (bounced sky/ceiling)
    fog:     null,                                 // clear morning (rainy/foggy will set this)
  },
  // Weather preset schema (fill these in when building the other five states):
  //   sky:     { top, horizon, sunDir, sunColor, sunSize, cloud, cloudColor, cloudSpeed }
  //   sun:     { color, intensity }
  //   ambient: { color, intensity }
  //   lamp:    { defaultOn?, intensity?, color? }   (optional per-weather lamp override)
  //   fog:     null | { color, near, far }
  //   effects: { rain?, particles?, clouds?, stars? }  (optional; wire up when implemented)
  //   post:    { exposure?, bloom?, grade? }           (optional per-weather grade override)
}

export const ACTIVE_WEATHER = 'sunnyMorning'

// Current active weather preset. (Later: drive ACTIVE_WEATHER from UI/scroll state.)
export const wx = () => WEATHER[ACTIVE_WEATHER]
