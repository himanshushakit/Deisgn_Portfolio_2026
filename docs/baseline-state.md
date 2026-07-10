# Baseline State (architecture-recovery checkpoint)

Captured at the start of the recovery. Git checkpoint commit: `checkpoint: working state before
architecture recovery` on branch `architecture-recovery` (parent `39e710b`).

## Working functionality (verified preserved throughout)
Interactive 3D scene · closed-laptop hero · scroll-driven camera · scroll-driven lid opening ·
camera dolly to screen · pan to standee · clickable lamp with ON/OFF · runtime lighting ·
sunny-morning environment · interior (desk, window, laptop, standee, mug, lamp, camera prop) ·
exterior (cherry tree, fence, house, forest) · procedural + authored materials · bloom/grade post.

## Metrics
| Metric | Value |
|--------|-------|
| `scene.glb` size | ~2.0 MB (WEBP textures) |
| GLB nodes / meshes / materials / images | 122 / 103 / 41 / 8 |
| glTF extensions | transmission, ior, emissive_strength, specular, sheen, EXT_texture_webp, KHR_lights_punctual |
| `App.jsx` | 1137 lines → 652 after extraction |
| JS bundle (prod) | 1,151 KB (gzip 318 KB) — mostly three.js |
| CSS | 1.8 KB |
| Modules transformed (build) | 696 |
| Dependencies | react 18, three 0.169, @react-three/fiber 8, drei 9, postprocessing 2 |
| Render loop | fixed 30 fps (`frameloop="never"` + FrameLimiter) |
| Quality tiers | high (transmission glass, dpr≤2, shadow 2048) / low (alpha glass, dpr≤1.25, shadow 1024) |

## Not measured headlessly (measure in browser DevTools if needed)
FPS under load, draw calls, triangle count, texture memory, initial network waterfall. The
headless capture harness uses SwiftShader (software GL) → detected as LOW tier, so captures show
the alpha-glass fallback path, not the transmission path.

## Restore
`git checkout architecture-recovery` (or the checkpoint commit). GLB backups on disk:
`public/scene_v31_backup.glb` and `public/scene.glb.v2*.bak`. Blender prior state:
`blender/*.blend1` auto-backups.
