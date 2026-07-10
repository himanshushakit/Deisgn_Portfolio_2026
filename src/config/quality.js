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
// ============================================================================
export function detectQualityTier() {
  if (typeof navigator === 'undefined') return 'high'
  try {
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

// Per-tier render knobs (consumed by App / lighting).
export const QUALITY_PRESETS = {
  high: { dpr: [1, 2],    shadowMapSize: [2048, 2048] },
  low:  { dpr: [1, 1.25], shadowMapSize: [1024, 1024] },
}
export const qp = () => (HIGH_Q ? QUALITY_PRESETS.high : QUALITY_PRESETS.low)
