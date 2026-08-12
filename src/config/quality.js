// ============================================================================
// DEVICE QUALITY TIER  —  performance switching.
// ----------------------------------------------------------------------------
// The clear window uses a physically-based TRANSMISSION material (like the standee
// acrylic). In three r169 the transmission pass re-renders the whole scene at full
// viewport resolution every frame (MSAA + mipmaps) — gorgeous, but ~2x render cost.
// Fine on a capable GPU, can jank low-end/mobile. So detect the device ONCE and on the
// LOW tier fall back to a cheap near-clear alpha pane (our transmission has thickness=0,
// i.e. no refraction distortion — the fallback only loses the subtle Fresnel edge sheen;
// the outside still reads clear + vibrant). We also trim DPR + shadow-map size on LOW.
//
// Tiers today: 'high' | 'low'. (Future: 'medium' + 'static_fallback' — see docs.)
//
// The two tiers are SEPARATE BRANCHES: every `high` value below is literally the desktop's
// current, approved value, so nothing in the LOW tier can trade desktop quality or speed away.
// That property is the whole point of this file — keep it. Mobile work belongs in `low` (and in
// the `html.is-mobile-viewport` CSS block / utils/viewport.js), never in a shared value.
//
// ── HISTORY 1: the naive sharpness attempt that broke everything ──────────────────────
// A 'medium' tier was tried (promote capable phones to dpr 2 + a 2048 shadow map so the render
// stops being upscaled 2.4x on a dpr-3 screen). It was REVERTED — phones stopped loading
// entirely. Raising the pixel count while leaving every per-pixel cost untouched is not a
// sharpness change, it's a multiplier on the whole frame: the 30fps loop also carries N8AO +
// bloom + three grade passes, and (the part that was missed) the EffectComposer's own render
// targets.
//
// ── HISTORY 2: why mobile is sharper now, and where the budget came from ──────────────
// @react-three/postprocessing defaults `multisampling` to 8 and allocates its targets as
// HalfFloatType (RGBA16F = 8 bytes/px, needed for HDR bloom). Mobile was therefore paying for an
// 8x-multisampled HDR buffer — at the old dpr 1.25 that's ~33 MB of render target, and the
// reverted dpr-2 attempt implied ~86 MB, on top of a 4x bigger shadow map and full-res AO. THAT
// is what made phones fail to open, not the pixels themselves.
// So the LOW tier now spends that memory on resolution instead of on multisampling: dpr up to 2
// (2.5x the pixels = the actual fix for blurry text) paid for by multisampling 8 -> 0 (~8x less
// render-target memory and bandwidth), half-res AO, and cheap post-process SMAA to put edge
// antialiasing back. Verified by screenshot diff at matched resolution: the new LOW tier is
// pixel-identical-within-noise to the old one apart from being sharper. The shadow map deliberately
// stays at 1024 — it was part of the reverted attempt and does nothing for text legibility, and the
// logarithmic depth buffer stays ON (see the note on that flag; disabling it broke the poster).
//
// Dial-down order if a weak phone ever struggles (each is one value, no restructuring):
//   1. `smaa: false`   2. lower LOW_DPR_MAX / LOW_PIXEL_BUDGET   3. `aoEnabled: false`.
// All of these are also reachable as query params on a real device — see DEBUG below.
//
// ── LOG DEPTH: off on BOTH tiers, and the single biggest win in this file ──────────────
// `logarithmicDepthBuffer` was on for both tiers. Nothing here needs it — the camera spans near 0.05
// to far 40, an 800:1 range a normal depth buffer handles comfortably — and it is brutally expensive,
// because writing depth per fragment defeats early-Z rejection: occluded fragments get fully shaded
// anyway. This scene has heavy overdraw (room interior + outdoor diorama + transmission glass), so
// nearly every pixel paid for it.
//
// It is far worse on Apple silicon than on a discrete NVIDIA card, which is why the site felt smooth
// on a GTX 1660 Super desktop but ran ~10 fps on a MacBook Pro (M4): tile-based GPUs lean on hidden
// surface removal as their core optimisation, and per-fragment depth writes disable it outright.
// Measured on an M4 at its native Retina 3024x1790 (5.41 MP), p50 frame gap:
//     log depth ON  ->  99.3 ms  (~10 fps)
//     log depth OFF ->  25.0 ms  (~40 fps)      <- same resolution, same everything else
// For scale, dropping to dpr 1.25 (2.11 MP) with log depth ON was still 41.4 ms — WORSE than full
// Retina with it off. So resolution was never the lever to pull here; this flag was.
//
// Turning it off changed exactly one thing on screen, and it wasn't depth precision: 1.5 mm sticker
// offsets and the 2 mm contact shadow diffed clean (0.20 / 0.08 mean against a 0.00 noise floor),
// while the wall poster's 4 mm layers broke badly (48.7 mean, 86% of pixels). The cause was that the
// poster's glass glaze was a raw ShaderMaterial with no logarithmic-depth chunks, so log depth had
// been silently depth-rejecting it all along — the approved poster look depended on that bug. The
// pane is now deleted (see FramedPoster in App.jsx), which is what the user asked for, so there is
// nothing left holding this flag on. ?logdepth=1 re-enables it to re-run the comparison.
// ============================================================================

// ── Debug overrides ──────────────────────────────────────────────────────────────────
// Dial a REAL device in without an edit-and-reload cycle (and A/B the mobile settings against
// the pre-change ones on the same build):
//   ?dpr=<n>        cap the drawing-buffer scale (e.g. ?dpr=1.25 = the old blurry mobile value)
//   ?msaa=0|2|4|8   EffectComposer multisampling
//   ?smaa=0|1       post-process antialiasing on/off
//   ?ao=0|1|half    ambient occlusion off / full-res / half-res
//   ?logdepth=0|1   logarithmic depth buffer (the LOW tier's one visual-risk knob — see below)
//   ?texbias=<n>    mip LOD bias for the résumé / project thumbnails (0 = off, -1 = 2x sharper,
//                   -8 = always the full-size mip; see textureLodBias below)
//   ?aa=0|1         canvas (default-framebuffer) MSAA — see `antialias` below; 1 restores the old
//                   desktop value, for confirming it makes no visual difference
// Same convention as ?hq=1 / ?lq=1 below. Read once at module load; absent = use the tier value.
const Q_PARAMS = (() => {
  try { return new URLSearchParams(window.location.search) } catch (e) { return new URLSearchParams('') }
})()
const qNum = (key) => {
  const v = parseFloat(Q_PARAMS.get(key))
  return Number.isFinite(v) ? v : null
}
const qBool = (key) => {
  const v = Q_PARAMS.get(key)
  return v == null ? null : v !== '0' && v !== 'false'
}

export function detectQualityTier() {
  if (typeof navigator === 'undefined') return 'high'
  try {
    // debug override: ?hq=1 forces HIGH tier, ?lq=1 forces LOW (used to preview the transmission path headlessly)
    if (typeof window !== 'undefined' && window.location) {
      const s = window.location.search || ''
      if (/[?&]hq=1/.test(s)) return 'high'
      if (/[?&]lq=1/.test(s)) return 'low'
    }
    const ua = navigator.userAgent || ''
    const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)
    const cores = navigator.hardwareConcurrency || 8 // undefined (some browsers) -> don't penalize
    const mem = navigator.deviceMemory               // Chrome only; undefined elsewhere
    const lowMem = typeof mem === 'number' && mem <= 2
    let gpu = ''
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
    const weakGpu = /(mali|adreno [1-5]\d\d|powervr|apple a[0-9] gpu|videocore|llvmpipe|swiftshader)/.test(gpu)
    if (mobile || weakGpu || cores <= 3 || lowMem) return 'low'
    return 'high'
  } catch (e) {
    return 'high' // if detection fails, assume capable
  }
}

export const QUALITY = detectQualityTier()
export const HIGH_Q = QUALITY === 'high'

// ── LOW-tier resolution: a PIXEL budget, not a flat dpr ───────────────────────────────
// A flat dpr is the wrong unit across devices: dpr 2 on a phone in landscape (852x393 CSS) is
// 1.34 MP, but the same 2 on a big tablet (1180x820) is 3.9 MP — nearly 3x the frame for no extra
// legibility, on a GPU that isn't 3x faster. So the cap is derived from the viewport: take as much
// scale as fits inside LOW_PIXEL_BUDGET, clamped to LOW_DPR_MAX. Small screens reach the budget;
// larger ones scale themselves down instead of falling over.
// R3F clamps a [min,max] dpr against the device's real devicePixelRatio, so this only ever LOWERS
// what the device would natively ask for — it can never ask a dpr-2 phone to render at 3.
//
// ── Phones now render NATIVE: no upscaling at all ─────────────────────────────────────
// History of this number, because it explains the shape: 1.6 MP originally (with a dpr cap of 2,
// which was the real constraint — a phone got 1704x612 = 1.04 MP and the browser upscaled ~1.5x to
// the panel, which is what made text mushy). Then 2.07 MP with the cap raised to 3, for a
// "1080p-equivalent" frame. Now the budget is raised past what a phone can even ask for, so the dpr
// cap of 3 is what binds and the phone renders at exactly its panel resolution: 2556x918 on an
// iPhone in landscape, upscale factor 1.0. There is no more quality available from resolution on
// that device — this is the ceiling.
// A literal "1920x1080" was never the right target, for the record: a phone in landscape is ~2.78:1,
// not 16:9, so a fixed 16:9 buffer would stretch or letterbox the scene. The drawing buffer must keep
// the viewport's aspect, so what transfers across devices is the PIXEL COUNT, which is what this is.
// The budget still matters for LARGE mobile screens: a tablet asking for dpr 3 would be 8+ MP, so it
// is held to ~2.6 MP instead (an iPad lands on dpr ~1.6).
//
// ── DPR CAP LOWERED 3 -> 2 (2026-08-12): native (dpr 3) was crashing real phones ─────────
// The "render native, no upscaling" state above sounded right but was never load-tested against
// real hardware memory limits, only against desktop-GPU emulation. Reports came in of the live site
// hard-crashing on scroll on real iPhones/Android (Safari's "A problem repeatedly occurred", a
// WebContent OOM kill — confirmed via a real iPhone 12 mini over Safari's remote Web Inspector:
// Timelines showed the tab dying under 1s into load, before the GLB/textures had even been
// requested, ruling out asset weight and pointing at the renderer's own target memory instead).
// Bisected live on-device with the ?dpr= debug override: dpr 3 (native) crashed every time, dpr 2
// did not, across repeated reloads. Every render target in the postprocessing chain (AO, bloom's
// HalfFloat mip chain, SMAA, the composer's own input/output/depth buffers) scales with dpr², so
// dropping 3 -> 2 cuts total render-target memory by (3/2)² ≈ 2.25x — roughly 55% fewer pixels
// pushed through the whole pipeline every frame, not just a softer final image. Only tested on one
// device (iPhone 12 mini, 4GB RAM); phones with less RAM than that were not verified and could
// still be at risk. dpr 2 is still genuine 2x/"retina" density, well above the old 1.25/1.6 blurry
// baselines below. ?dpr= still overrides this for on-device A/B testing.
const LOW_PIXEL_BUDGET = 2.6e6   // above a phone's native ask, so LOW_DPR_MAX binds there; caps tablets
const LOW_DPR_MAX = 2            // real-device memory ceiling, not a devicePixelRatio limit — see above
function lowDprCap() {
  try {
    const w = window.innerWidth || 852
    const h = window.innerHeight || 393
    const fit = Math.sqrt(LOW_PIXEL_BUDGET / Math.max(1, w * h))
    return Math.max(1, Math.min(LOW_DPR_MAX, Math.round(fit * 100) / 100))
  } catch (e) {
    return 1.5 // conservative middle ground if the viewport can't be read
  }
}

// Per-tier render knobs (consumed by App). `high` == the current approved desktop values.
export const QUALITY_PRESETS = {
  high: {
    // 1.75, not 2. A Retina Mac reports devicePixelRatio 2 and so rendered the most pixels of any
    // device we test on: 3024x1790 = 5.41 MP on a 14" MacBook (7.12 MP on a 16"), versus 1.87 MP for
    // a 1080p Windows laptop — ~2.9x the work for the same scene. Shaving the cap to 1.75 gives back
    // ~23% of those pixels (this 14" -> 2646x1566 = 4.14 MP) for a ~1.14x upscale to the panel, which
    // on a display of that density is a very mild softening.
    // A dpr CAP is used here rather than a pixel budget (which is what the LOW tier uses) precisely
    // because it only ever bites on HiDPI screens: anything reporting dpr <= 1.75 — a 1080p laptop at
    // 100/125/150% Windows scaling, a 1440p or 4K desktop monitor at dpr 1 — resolves to exactly the
    // same value it did before and is untouched. A pixel budget would instead have punished large
    // low-dpr monitors, softening a 4K desktop that never had a problem.
    dpr: [1, 1.75],
    shadowMapSize: [2048, 2048],
    // WebGLRenderer flags
    // FALSE, and it costs nothing visually: with EffectComposer in play the scene is rendered into
    // the composer's own targets and the only thing ever drawn to the DEFAULT framebuffer is the
    // final pass's fullscreen triangle, whose edges are off-screen. There are no geometry edges left
    // for the canvas's MSAA to resolve — it just allocates a multisampled default framebuffer nobody
    // benefits from. Verified pixel-identical (?aa=1 restores it). Geometry AA comes from the
    // composer's own `multisampling` below. Frees real VRAM on cards that don't have much.
    antialias: false,
    logarithmicDepthBuffer: false,    // OFF on both tiers — see LOG DEPTH below. Biggest single win.
    // 'high-performance', NOT 'default'. On a hybrid-graphics laptop (Intel iGPU + discrete NVIDIA —
    // e.g. a Dell G3 with UHD 630 + GTX 1050) 'default' lets the browser hand WebGL to the
    // INTEGRATED GPU, which Chrome on Windows routinely does; that iGPU is roughly an order of
    // magnitude slower than the discrete part, which is enough on its own to make a modern gaming
    // laptop feel broken while a desktop of similar vintage is smooth. Single-GPU desktops are
    // unaffected by this (there is nothing else to pick). Costs a little battery on laptops, which is
    // the right trade for a full-screen 3D scene — and the LOW tier already asked for it.
    powerPreference: 'high-performance',
    // post-processing
    multisampling: 8,                 // @react-three/postprocessing's own default
    aoEnabled: true,
    aoHalfRes: false,
    smaa: false,                      // not needed: 8x MSAA already resolves edges
    textureLodBias: 0,                // OFF on desktop: 0 means the shaders aren't patched at all
  },
  low: {
    dpr: [1, lowDprCap()],
    shadowMapSize: [1024, 1024],
    // The default framebuffer's MSAA does nothing here — the composer's final pass draws one
    // fullscreen triangle to it, so there are no geometry edges left for it to resolve. It only
    // costs memory, hence off. (Geometry AA on this tier comes from SMAA below.)
    antialias: false,
    logarithmicDepthBuffer: false,    // see LOG DEPTH below
    powerPreference: 'high-performance', // ask Android for the big GPU rather than the efficiency one
    multisampling: 0,                 // see HISTORY 2 — this is what pays for the higher dpr
    aoEnabled: true,
    aoHalfRes: true,                  // quarter-cost AO; it's a broad soft gradient, not detail
    smaa: true,                       // cheap single-pass edge AA, replacing the 8x MSAA target
    // ── Mip LOD bias for the two TEXT-BEARING textures (résumé + project thumbnails) ──
    // These stay soft on mobile even at dpr 2, and NOT because anything compresses them: measured,
    // the phone downloads and uploads them at full size (1680x2260 / 1600x1081, GPU max texture
    // 8192) — they're simply drawn into far fewer pixels than they contain. The résumé occupies
    // ~456x599 rendered px, i.e. 3.7x minification, so the GPU samples around mip level 1.9 (a
    // ~450px pre-blurred copy) and ~93% of the source detail is discarded before it's ever seen.
    // The honest fix is more render pixels, but dpr 3 exhausts phone memory (it errored on device).
    // So instead: bias the LOD so the sampler reaches for a SHARPER mip than the derivative asks
    // for. Costs zero extra pixels and zero extra memory — it's one number in a shader.
    // -1.0 = one mip sharper (~2x the detail); -8 effectively pins mip 0 (equivalent to disabling
    // mipmaps). The trade is aliasing/shimmer while the camera moves, which is why it's tunable on
    // device with ?texbias= — and why the default is a moderate -1.0 rather than the maximum.
    textureLodBias: -1.0,
  },
}

// Resolved tier knobs, with the debug params applied last so a real device can be dialled in.
export const qp = () => {
  const p = { ...(HIGH_Q ? QUALITY_PRESETS.high : QUALITY_PRESETS.low) }
  const dpr = qNum('dpr')
  if (dpr != null) p.dpr = [1, dpr]
  const msaa = qNum('msaa')
  if (msaa != null) p.multisampling = msaa
  const smaa = qBool('smaa')
  if (smaa != null) p.smaa = smaa
  const logDepth = qBool('logdepth')
  if (logDepth != null) p.logarithmicDepthBuffer = logDepth
  const texBias = qNum('texbias')
  if (texBias != null) p.textureLodBias = texBias
  const aa = qBool('aa')
  if (aa != null) p.antialias = aa
  const ao = Q_PARAMS.get('ao')
  if (ao != null) { p.aoEnabled = ao !== '0' && ao !== 'false'; p.aoHalfRes = ao === 'half' }
  return p
}
