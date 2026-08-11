// ============================================================================
// MOBILE VIEWPORT / IMMERSIVE MODE  —  browser-chrome handling (MOBILE ONLY).
// ----------------------------------------------------------------------------
// THE PROBLEM: on a phone the site sat inside a shrunken viewport with the browser's toolbars
// permanently on screen (Safari's top bar; Chrome's top + bottom bars), instead of them sliding
// away as they do on a normal site. The cause is not styling — it's that NOTHING here scrolls the
// document. The desktop experience is driven by drei's <ScrollControls>, which scrolls its OWN
// container inside the canvas, and `body` is `overflow: hidden`. Mobile browsers only collapse
// their toolbars in response to the MAIN FRAME scrolling, so with zero document scroll they stay
// expanded forever, and no amount of viewport meta / height math can move them.
//
// THE FIX, in two parts — both strictly gated on IS_MOBILE_VIEWPORT, so the desktop path runs
// exactly the code it ran before (same ScrollControls, same body, same canvas box):
//   1. On mobile the DOCUMENT is the scroller: `.mobile-scroll-spacer` gives `body` real scroll
//      height, the canvas is lifted out of flow (position: fixed) on top of it, and the 0..1
//      timeline offset is read from window.scrollY by MobileScrollDriver in App.jsx. The browser
//      then auto-hides its toolbars on the first swipe, exactly like any other website — which is
//      also why it can't be done at load: the collapse is a response to a real scroll gesture.
//   2. Where the Fullscreen API actually exists (Android Chrome, iPadOS, installed PWAs) we ALSO
//      request real fullscreen on the first touch, which removes the chrome outright rather than
//      collapsing it, and makes the orientation lock work (browsers only honour the lock while
//      fullscreen or installed).
//
// WHAT IS NOT POSSIBLE, so nobody re-litigates it: an iPhone (Safari AND Chrome — both are WebKit
// there) exposes no way for a web page to hide browser chrome, and no page can load fullscreen
// in-browser. `minimal-ui` was removed in iOS 8 and the Fullscreen API is video-only, which is why
// the feature detection below simply finds nothing to call. The one genuine load-time fullscreen
// path on iPhone is installing the site (Share → Add to Home Screen); manifest.webmanifest already
// declares "display": "fullscreen" + "orientation": "landscape" for exactly that.
// ============================================================================

// Both conditions must hold, and that's deliberate: `pointer: coarse` alone matches a
// touchscreen Windows laptop, which should keep the (working, higher-quality) desktop path.
// Mirrors the detection style in config/quality.js, including the debug override.
function detectMobileViewport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  try {
    // debug: ?mobileview=1 forces the mobile document-scroll path on a desktop browser (so it can
    // be inspected in DevTools device mode); ?mobileview=0 forces the desktop path on a phone.
    const s = window.location?.search || ''
    if (/[?&]mobileview=1/.test(s)) return true
    if (/[?&]mobileview=0/.test(s)) return false
    const ua = navigator.userAgent || ''
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches === true
    const phoneUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)
      // iPadOS defaults to a desktop UA string; touch points are the standard tell.
      || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
    return coarse && phoneUA
  } catch (e) {
    return false // detection failed -> assume desktop, i.e. change nothing
  }
}

export const IS_MOBILE_VIEWPORT = detectMobileViewport()

// Applied at module eval (before React renders) so the `.is-mobile-viewport` rules in styles.css
// are already in effect for the FIRST paint — flipping the class later would relayout the page
// under the boot loader. A class, not a media query, because App.jsx's scroll architecture
// branches on this same flag: one source of truth means CSS and JS can never half-agree.
if (IS_MOBILE_VIEWPORT && typeof document !== 'undefined') {
  document.documentElement.classList.add('is-mobile-viewport')
  try {
    // With the document as the scroller, a reload would otherwise RESTORE the previous scroll
    // position — the loader would then fade to reveal the scene already half-animated. Reset it
    // before anything reads window.scrollY.
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
  } catch (e) { /* non-fatal */ }
}

// `dvh` = the CURRENTLY visible viewport height, so a canvas sized in dvh exactly fills what the
// user can see and grows when the toolbars collapse — no cropping while they're still up, no gap
// once they're gone. Supported since iOS 15.4 / Chrome 108; the `vh` fallback is the toolbar-hidden
// height, which just means the canvas's top strip sits behind the chrome until it collapses.
const MOBILE_CANVAS_HEIGHT = (() => {
  try { return window.CSS?.supports?.('height: 100dvh') ? '100dvh' : '100vh' } catch (e) { return '100vh' }
})()

// Passed INLINE to <Canvas style={…}> rather than set from styles.css: @react-three/fiber writes
// position/width/height straight onto its wrapper div's style attribute, so no stylesheet rule
// could win without !important. `touch-action: pan-y` guarantees a swipe on the canvas still
// scrolls the document (the whole point of the mobile path) while keeping pinch/double-tap zoom
// off it — zooming a fixed-camera WebGL scene only breaks the framing.
export const MOBILE_CANVAS_STYLE = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: MOBILE_CANVAS_HEIGHT,
  touchAction: 'pan-y',
}

// True when launched from the home screen / as an installed app — there is no browser chrome to
// remove in that case, so the fullscreen request below is skipped.
function isStandalone() {
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.matchMedia?.('(display-mode: fullscreen)')?.matches === true
      || window.navigator.standalone === true // iOS's own flag
  } catch (e) { return false }
}

// Best-effort landscape lock. Only permitted while fullscreen or installed, which is why
// initImmersiveFullscreen re-tries it the moment fullscreen actually engages. Rejects harmlessly
// everywhere else — notably iPhone Safari, which is why RotateGate exists as the universal fallback.
export function lockLandscape() {
  try { window.screen?.orientation?.lock?.('landscape')?.catch?.(() => {}) } catch (e) { /* unsupported */ }
}

const GESTURE_EVENTS = ['touchend', 'pointerup', 'click']
const MAX_FULLSCREEN_ATTEMPTS = 3

// Requests real fullscreen on the first user gesture (the API requires user activation — it can
// never fire at load). Returns a cleanup function; safe to call on any platform, since it no-ops
// when the API isn't there (every iPhone browser) or when there's no chrome to hide (installed).
export function initImmersiveFullscreen() {
  const noop = () => {}
  if (!IS_MOBILE_VIEWPORT || typeof document === 'undefined') return noop
  if (isStandalone()) return noop
  const el = document.documentElement
  const request = el.requestFullscreen || el.webkitRequestFullscreen
  if (!request) return noop // iPhone Safari/Chrome: element fullscreen doesn't exist — see header
  let attempts = 0
  const arm = () => GESTURE_EVENTS.forEach((t) => window.addEventListener(t, onGesture, { capture: true, passive: true }))
  const disarm = () => GESTURE_EVENTS.forEach((t) => window.removeEventListener(t, onGesture, { capture: true }))
  function onGesture() {
    disarm() // one shot per gesture; all three event types are listened to, whichever lands first
    attempts += 1
    // navigationUI:'hide' asks Android Chrome to drop its nav bar too, not just the URL bar.
    // webkitRequestFullscreen returns undefined rather than a promise — Promise.resolve normalises.
    Promise.resolve()
      .then(() => request.call(el, { navigationUI: 'hide' }))
      .then(() => lockLandscape()) // now permitted: the lock only works while fullscreen
      .catch(() => {
        // Rejected (gesture not treated as activating, permission policy, user exited…). Re-arm a
        // couple of times so a later tap can still succeed, then stop trying — repeatedly forcing
        // fullscreen back on someone who deliberately swiped out of it would be hostile.
        if (attempts < MAX_FULLSCREEN_ATTEMPTS) arm()
      })
  }
  arm()
  return disarm
}
