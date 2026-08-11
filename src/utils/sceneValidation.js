// ============================================================================
// DEV-ONLY SCENE VALIDATION  —  catches Blender/GLB drift early.
// ----------------------------------------------------------------------------
// Runs once after the GLB loads (DeskScene). Warns (never throws, never ships cost to
// production) if the authored contract has drifted — a required anchor/object/material
// went missing or got renamed on re-export. The runtime matches GLB content by NAME, so a
// silent rename is exactly the kind of regression this catches.
//
// It also documents the STATIC TRANSFORM OVERRIDE ALLOWLIST: the only objects whose
// transform may be mutated at runtime (because the change is dynamic, not authoring). Any
// other imported object being moved/rotated/scaled in code is a re-divergence smell and
// should instead be changed in Blender (see CLAUDE.md decision framework).
// ============================================================================
import { LAMP_LIGHT } from '../config/scene.js'

// Empties the runtime resolves by name (positions owned by Blender).
const REQUIRED_ANCHORS = [LAMP_LIGHT.anchor] // 'LIGHT_ANCHOR_LAMP'

// Key authored objects the runtime looks up by name.
const REQUIRED_OBJECTS = [
  'NewLamp_Root', 'Camera_Root', 'Laptop_Hinge', 'GEO_LaptopLid',
  'GEO_Wall', 'GEO_WindowGlass', 'GEO_WindowSill',
  'GEO_SkyBackdrop', // weather photo backdrop slot (GEO_FogCard mist overlay was removed — see App.jsx)
]

// Semantic material slots the material registry / traverse expects.
const REQUIRED_MATERIALS = [
  'M_Glass', 'M_Wall', 'M_Frame', 'M_LampWood_New', 'M_LampStemPlastic',
  'M_CamMetal', 'M_OutFencePainted',
]

// The ONLY runtime transform mutations that are sanctioned (dynamic behavior, not authoring).
// Everything else must be authored in Blender. Keep this list tiny and intentional.
export const TRANSFORM_OVERRIDE_ALLOWLIST = [
  'Laptop_Hinge',       // scroll-driven lid opening (rotation.x)
  // the active render camera is animated by CameraController (not a GLB object) — allowed
  // future: 'TREE_WIND_ROOT' / branch bones (wind), particle systems.
]

const isDev = () => {
  try { return !!(import.meta && import.meta.env && import.meta.env.DEV) } catch (e) { return false }
}

// ── Why the authored names are SNAPSHOTTED rather than read live ──────────────────────
// useGLTF CACHES the loaded scene, and DeskScene mutates that cached object in place: the window
// glass is swapped for a device-tier material, camera parts get per-mesh clones, procedural
// materials are attached. So the AUTHORED content is only observable before that traverse runs —
// and only on the first mount, because a hot reload re-runs the effect against the same,
// already-mutated scene. Read live, the validator ends up reporting the runtime's own edits as
// Blender drift. That is not hypothetical: it warned `missing materials: M_Glass` on every load,
// because DeskScene had replaced M_Glass moments earlier in the same effect. A validator that
// cries wolf every boot is worse than no validator, since it trains you to ignore the one time it
// is right. Snapshot once per scene object (WeakMap: no leak, and a new GLB_URL ?v= gets a fresh
// scene and so a fresh snapshot), then validate against the snapshot forever after.
const authoredSnapshots = new WeakMap() // scene -> { names: Set, mats: Set }

function authoredNames(scene) {
  const cached = authoredSnapshots.get(scene)
  if (cached) return cached
  const names = new Set()
  const mats = new Set()
  scene.traverse((o) => {
    if (o.name) names.add(o.name)
    const ms = Array.isArray(o.material) ? o.material : [o.material]
    ms.forEach((m) => m && m.name && mats.add(m.name))
  })
  const snap = { names, mats }
  authoredSnapshots.set(scene, snap)
  return snap
}

// IMPORTANT: call this BEFORE any runtime material/object mutation of `scene` (see above) — in
// DeskScene it is the first statement of the setup effect, not the last.
export function validateScene(scene) {
  if (!isDev() || !scene) return
  const { names, mats } = authoredNames(scene)
  const report = (label, list, have) => {
    const missing = list.filter((n) => !have.has(n))
    if (missing.length) console.warn(`[sceneValidation] missing ${label}: ${missing.join(', ')} — GLB/Blender drift? (see CLAUDE.md)`)
  }
  report('anchors', REQUIRED_ANCHORS, names)
  report('objects', REQUIRED_OBJECTS, names)
  report('materials', REQUIRED_MATERIALS, mats)
}
