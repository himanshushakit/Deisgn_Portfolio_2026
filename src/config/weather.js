// ============================================================================
// WEATHER PRESETS  —  CONFIG SOURCE OF TRUTH for outside look + scene lighting
// ----------------------------------------------------------------------------
// Every preset describes: the scene's key light + ambient fill + fog + exposure + lamp
// default + a `grade` (how much night/fog/rain/sunset material response to apply). The
// outside GEOMETRY never changes between weathers (that lives in Blender) — only these
// values do, and the runtime EASES the live scene state toward the selected preset over
// ~1s (see WeatherDriver in App.jsx).
//
// The scene has exactly THREE lights (see App.jsx): (1) the SUN/MOON directional,
// (2) one room AMBIENT fill (hemisphere), (3) the table lamp. `sun`/`ambient` here are
// weather-driven; presets are numbers-only — NO extra lights, no HDRI.
//
// The VISUAL sky (what you see through the window) is a photo backdrop (see SkyBackdrop
// in App.jsx / web/public/sky/) selected by preset key, cross-fading FAST and independently
// of this file's light values — deliberately decoupled (see CLAUDE.md decision framework:
// interior lighting is code-driven "dynamic behavior", the sky photo is an authored asset).
// `sky.sunDir` is the one exception living here: it still drives the REAL directional light
// (sun/moon) that lights the desk, so interior shading stays physically consistent even
// though the visible sky disc is now baked into the backdrop photo, not computed live.
//
// glTF/three.js world space: +X right, +Y up, window/outside is at -Z (into the scene).
// ============================================================================
export const WEATHER = {
  // ── Bright sunny morning — the default ────────────────────────────────────────────
  sunnyMorning: {
    sky: { sunDir: [0.34, 0.55, -0.76] }, // up + slightly right + toward the window (-Z)
    sun:     { color: '#ffe8bf', intensity: 3.24 },             // (1) warm key sun raking through the window (-Z); -10% from 3.6 so the desk doesn't blow out
    ambient: { color: '#dde2f0', intensity: 1.3, ground: '#f7d29a' }, // (2) hemisphere fill (cool sky / warm bounce); lifted from 1.1 to fill the sun's shadow side (guitar/laptop/left wall) without flattening the key light's direction
    fog:     { color: '#c4d6ea', near: 7.5, far: 26 },          // clear morning haze (distant only)
    exposure: 1.4,
    lamp:    { defaultOn: false, color: '#ffb35a', intensity: 1.0 }, // lamp OFF by default
    grade:   { night: 0.0, fog: 0.0, rain: 0.0, sunset: 0.0 },  // no material grade response
    shadowRadius: 18, // softened from the original 14 so window-frame/tree shadow edges aren't hard-edged
  },

  // ── Foggy morning — quiet, soft, cold early morning with dense atmospheric fog ──────
  foggyMorning: {
    sky: { sunDir: [0.34, 0.55, -0.76] }, // same as morning (sun is diffused away by grade.fog)
    sun:     { color: '#d9dbe1', intensity: 1.22 },             // (1) soft, cool, heavily diffused — almost no harsh shadow; -10% so the sun/ambient gap (contrast) narrows without raising overall room brightness
    ambient: { color: '#c6ccd6', intensity: 1.55, ground: '#c3c0c2' }, // (2) lifted cool fill (soft room, subtle contrast); colour cooled slightly (was #ced1d6/#cabfb2, the ground bounce especially was still warm-beige) so the indoor fill reads consistent with the cool fog outside — intensity untouched, this is a colour-temperature shift, not a brightening
    // near=0.15/far=5.5 overshot: far=5.5 sat INSIDE the house's own depth (4.4-7.5 units out),
    // so its far half hit 100% fog -> a flat pale silhouette with zero visible detail. Pulled far
    // back out so the house stays SOFTLY hazed but recognisable (window/roofline still read),
    // while near stays low so the tree's own depth still picks up a gentle gradient.
    fog:     { color: '#cfc8bd', near: 0.5, far: 12.0 },        // SOFT: distant (house/forest) hazes, doesn't vanish
    exposure: 1.40,
    lamp:    { defaultOn: false, color: '#ffb35a', intensity: 1.0 }, // lamp OFF by default
    // fog was 1.0 (full desaturate+wash, flat regardless of distance) — that killed the nearby
    // cherry tree's colour along with the distant house. Dialed down so nearby objects keep some
    // colour, with the depth-based fade coming mainly from the real distance fog below.
    grade:   { night: 0.0, fog: 0.5, rain: 0.0, sunset: 0.0 },
    shadowRadius: 24, // softer than morning's 18 — misty, low-contrast shadow edges on the desk/sill

  },

  // ── Rainy day — calm, cozy, cinematic overcast afternoon with light rain ────────────
  rainyDay: {
    sky: { sunDir: [0.34, 0.55, -0.76] }, // (no visible sun — diffused away by grade.rain)
    sun:     { color: '#aebccf', intensity: 1.15 },           // (1) soft, cool, heavily diffused key (gentle shadows)
    ambient: { color: '#9aa6bc', intensity: 1.85, ground: '#8a8072' }, // (2) DOMINANT bright cool grey-blue fill (soft, even room); lifted from 1.7 so the desk/laptop/interior don't read too dark, without touching the storm outside
    fog:     { color: '#b8c1cd', near: 4.5, far: 17 },        // cool bright mist: distant forest fades, house slightly hazed
    exposure: 1.34,                                           // bright overcast afternoon (cool day, warm lamp accent)
    lamp:    { defaultOn: false, color: '#ffab52', intensity: 1.15 }, // lamp OFF by default (user can toggle it on)
    grade:   { night: 0.0, fog: 0.0, rain: 1.0, sunset: 0.0 }, // WET material response (darker + slight desat, stays matte)
    shadowRadius: 20, // softened from the 14 baseline so the darkest shadow edges aren't hard, short of Foggy's misty 24
  },

  // ── Golden hour sunset — warm, cinematic, cozy ──────────────────────────────────────
  sunsetGolden: {
    sky: { sunDir: [0.26, 0.10, -0.96] }, // LOW near the horizon, long grazing interior shadows
    sun:     { color: '#ff9640', intensity: 2.6 },            // (1) warm orange-gold HERO, low → long soft shadows
    ambient: { color: '#c3a8c4', intensity: 1.05, ground: '#f2b478' }, // (2) lavender sky fill + warm peach floor bounce (never black); intensity lifted from 0.92 (was the dimmest fill of all 5 presets) and the ground bounce brightened/warmed — this IS the "warm bounce off the desk" channel by design (see Lights() in App.jsx), so it directly fakes reflected sunset light off the wood without a 4th light
    fog:     { color: '#e0a878', near: 5.0, far: 20 },        // warm haze: distant trees fade into golden atmosphere
    exposure: 1.30,                                           // slightly darker than morning, warm & cinematic
    lamp:    { defaultOn: false, color: '#ffb35a', intensity: 1.0 }, // lamp OFF by default (like morning)
    grade:   { night: 0.0, fog: 0.0, rain: 0.0, sunset: 1.0 }, // warm material response
    shadowRadius: 19, // softened from the 14 baseline (incl. the window-frame shadow across the laptop lid) while keeping more edge definition than Rainy/Foggy — preserves the low-sun drama
  },

  // ── Cozy moonlit night ──────────────────────────────────────────────────────────────
  night: {
    // MOON direction — LOWER than the morning sun (which sits above the window opening) so the
    // real moonlight rakes in at a similar low angle to the backdrop photo's moon position.
    sky: { sunDir: [0.33, 0.28, -0.90] },
    sun:     { color: '#8ea6d6', intensity: 0.95 },            // (1) soft cool-blue MOONLIGHT (gentle shadows)
    ambient: { color: '#33466e', intensity: 0.70, ground: '#3a3450' }, // (2) cool blue fill; room never fully black; nudged from 0.62 — very subtle moon-fill lift so the guitar/desk edge/laptop silhouette stay readable without eroding the warm-lamp/cool-moon contrast
    fog:     { color: '#0a1226', near: 7.5, far: 26 },         // dark night-blue haze (distant only)
    exposure: 1.32,                                            // cozy + readable (not underexposed)
    lamp:    { defaultOn: true, color: '#ffab52', intensity: 1.35 }, // lamp ON by default, warmer + cozier
    grade:   { night: 1.0, fog: 0.0, rain: 0.0, sunset: 0.0 }, // full NIGHT material response (cool + darken)
    shadowRadius: 14, // original baseline — untouched by the Morning/Foggy lighting passes
  },
}

// Ordered selector entries (top-center UI): label + preset key. Morning is the default.
// Labels match the Figma weather-selector spec (Foggy/Rainy, not the old Fog/Rain shorthand).
export const PRESETS = [
  { key: 'sunnyMorning', label: 'Morning' },
  { key: 'foggyMorning', label: 'Foggy' },
  { key: 'rainyDay',     label: 'Rainy' },
  { key: 'sunsetGolden', label: 'Sunset' },
  { key: 'night',        label: 'Night' },
]

export const ACTIVE_WEATHER = 'sunnyMorning'   // initial state (App drives switching at runtime)
export const wx = () => WEATHER[ACTIVE_WEATHER]
