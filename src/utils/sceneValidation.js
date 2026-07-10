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
  'Lamp_Root', 'Camera_Root', 'Laptop_Hinge', 'GEO_LaptopLid',
  'GEO_Wall', 'GEO_WindowGlass', 'GEO_WindowSill',
]

// Semantic material slots the material registry / traverse expects.
const REQUIRED_MATERIALS = [
  'M_Glass', 'M_Wall', 'M_Frame', 'M_LampWood', 'M_LampShade', 'M_LampBulb',
  'M_CamMetal', 'M_OutFence', 'M_Blossom',
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

export function validateScene(scene) {
  if (!isDev() || !scene) return
  const names = new Set()
  const mats = new Set()
  scene.traverse((o) => {
    if (o.name) names.add(o.name)
    const ms = Array.isArray(o.material) ? o.material : [o.material]
    ms.forEach((m) => m && m.name && mats.add(m.name))
  })
  const report = (label, list, have) => {
    const missing = list.filter((n) => !have.has(n))
    if (missing.length) console.warn(`[sceneValidation] missing ${label}: ${missing.join(', ')} — GLB/Blender drift? (see CLAUDE.md)`)
  }
  report('anchors', REQUIRED_ANCHORS, names)
  report('objects', REQUIRED_OBJECTS, names)
  report('materials', REQUIRED_MATERIALS, mats)
}
