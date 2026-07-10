# Architecture Audit & Divergence Report

Snapshot at the start of the architecture recovery, plus what was migrated. Classifications:
A=static-authoring, B=interaction, C=weather, D=responsive, E=dynamic-visual, F=performance,
G=temporary-hack.

## Blender ↔ code divergences found (runtime overrides of imported objects)

| Override (was in App.jsx) | Class | Correct owner | Resolution |
|---------------------------|-------|---------------|------------|
| `Lamp_Root.position.set(0.70,0.85,-1.22)` | A | Blender | ✅ migrated to `desk_master.blend`; override removed |
| `Camera_Root.position.set(0.43,…)` + `rotation.y=-1.10` | A | Blender | ✅ migrated (`Camera_Root` loc + `rotation_euler.z`); override removed. Bug found: rotation used `+=` and re-stacked on every HMR reload |
| Window meshes `position.y = 0.05` (lift) | A | Blender | ✅ migrated (window meshes Z+0.05); override removed |
| Wall-gap patch plane (added mesh) | G | Blender | ✅ replaced by raising the wall opening's bottom verts to Z 0.90; patch removed |
| `M_CamMetal` matte dark-grey (`metalness/roughness/color`) | A | Blender | ✅ migrated to Blender material; override removed |
| Lamp point-light hardcoded `position=[0.70,1.02,-1.17]` | A→anchor | Blender anchor | ✅ now resolves `LIGHT_ANCHOR_LAMP` from GLB |
| Window glass → transmission/alpha material swap | F | **Code (keep)** | intentional device-tier behavior |
| Foliage `alphaTest` conversion (blossom/forest) | E | **Code (keep)** | required so alpha objects show through transmission glass |
| Render-layer assignment (0/1/2 interior/exterior/glass) | E | **Code (keep)** | lighting isolation logic |
| Procedural material overrides (wall/frame/fence/shade/wood/dust/vibrance) | E | **Code (keep)** | 0-KB load-time exception (see material-strategy) |
| Steam / poster-glass shaders, sky, cursor | E | **Code (keep)** | dynamic |

Result: **all STATIC (A) and TEMPORARY (G) overrides migrated to Blender; only genuinely dynamic
(C/E/F) behavior remains in code.**

## App.jsx structure change
- Before: single 1137-line file (shaders, config, quality, 7 material fns, scene, lights, effects).
- After: **652 lines** + extracted modules:
  - `config/weather.js`, `config/camera.js`, `config/quality.js`, `config/scene.js`
  - `materials/proceduralMaterials.js` (the 7 material fns)
  - `utils/sceneValidation.js`
- Behavior verified identical by screenshot after each extraction.

## Lights audit
Blender has 5 light objects (`SUN_Key`, `TmpSun`, `Area`, `Area.001`, `LAMP_Bulb_Light`) — **all
stripped at runtime.** The 2 AREA lights don't even export (glTF unsupported → warnings). Runtime
creates exactly 3 (sun + ambient in `weather.js`, lamp point light). Decision: **lights stay in
code** (weather-reactive + interactive + reliable intensity). Blender leftovers left as-is (user
choice) — harmless since stripped; documented so they don't mislead.

## Remaining technical debt / next steps
1. Optional: split `App.jsx` scene components (Sky/Lights/DeskScene/effects/WallArt/Cursor3D) into
   `scene/`, `effects/`, `lighting/` modules. Lower priority — App.jsx is now mostly orchestration.
2. Project root is not version-controlled (only `web/`). `.blend`/`.glb` unversioned. Recommend a
   root git repo with git-lfs.
3. `blender/SCENE_CONTRACT.md` has stale values (pre-migration lamp/camera coords, old glass = alpha
   0.14). It's still the authoritative spatial spec; values noted stale in the export-workflow doc.
4. Deferred hybrid-texture art passes (desk wood maps, bark, blossom atlas) — see material-strategy.
5. JS bundle 1.15 MB (318 KB gzip), mostly three.js — consider code-splitting if it grows.
