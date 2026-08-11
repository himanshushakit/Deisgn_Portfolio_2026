// ============================================================================
// CAMERA + SCROLL CONFIG  —  scroll-driven camera waypoints and timeline.
// ----------------------------------------------------------------------------
// Waypoints are in Three.js space (glTF Y-up), read/derived from the Blender
// CAM_* cameras (see blender/SCENE_CONTRACT.md). glTF can't store lens shift, so
// shiftY is applied to the projection matrix in code (CameraController).
//
// Scroll timeline (two phases):
//   Phase A (0 -> PHASE):  laptop lid opens, camera WEBSITE -> SCREEN
//   Phase B (PHASE -> 1):  laptop stays open, camera SCREEN -> STANDEE
// Reverse scroll runs it backwards.
// ============================================================================
import * as THREE from 'three'

export const WEBSITE = {
  pos: new THREE.Vector3(0, 1.2, -0.25), // reference framing: all props visible, small gap under laptop
  quat: new THREE.Quaternion(0, 0, 0, 1),
  fov: 55,       // narrow enough to avoid wide-angle edge distortion
  shiftY: 0.0,
}
export const SCREEN = {
  pos: new THREE.Vector3(0, 1.045, -0.702),            // laptop @1.3x; cam follows
  quat: new THREE.Quaternion(-0.04013, 0, 0, 0.99919), // ~4.6deg down-tilt: screen fills, keyboard cropped ~QWERTY
  fov: 29.86,
  shiftY: 0.0,
}
export const STANDEE = {
  pos: new THREE.Vector3(-0.41, 1.0358, -0.7377),      // moved left with the standee (clear of leather mat)
  quat: new THREE.Quaternion(-0.06976, 0, 0, 0.99756), // straight-on to page (no yaw, 8deg tilt)
  fov: 41.25,
  shiftY: 0.0,
}

// Laptop opens by rotating Laptop_Hinge about local X (same axis/sign as Blender).
export const HINGE_OPEN = THREE.MathUtils.degToRad(-100)

// Scroll timeline (three segments):
//   [0 .. LID_OPEN_END]               Phase A — lid opens, camera WEBSITE -> SCREEN
//   [LID_OPEN_END .. PANEL_HOLD_END]  DWELL   — camera holds at SCREEN; project thumbnails cross-fade
//   [PANEL_HOLD_END .. 1]             Phase B — camera SCREEN -> STANDEE
export const LID_OPEN_END = 0.24
export const PANEL_HOLD_END = 0.76

// Scroll pages for <ScrollControls>. Bumped 7 -> 8 and the dwell widened so each project thumbnail
// gets more physical scroll distance (slower, less-abrupt thumbnail-to-thumbnail transitions) while
// the lid-open + standee segments keep roughly their previous pace.
// Also sizes the mobile path's document-scroll spacer (`--scroll-pages` in styles.css), so both
// paths travel the same timeline length from one constant.
export const SCROLL_PAGES = 8

// Smoothing time (seconds) for the MOBILE scroll source only — there the browser's own document
// scroll drives the timeline (see utils/viewport.js / MobileScrollDriver in App.jsx). Kept far
// shorter than the desktop <ScrollControls damping={0.65}> on purpose: that damping exists to give
// a mouse wheel's discrete clicks some momentum, whereas touch already arrives with native
// inertia — layering 0.65s on top of it reads as the scene lagging behind the finger.
export const MOBILE_SCROLL_SMOOTH = 0.08

export const smootherstep = (x) => {
  x = THREE.MathUtils.clamp(x, 0, 1)
  return x * x * x * (x * (x * 6 - 15) + 10)
}
