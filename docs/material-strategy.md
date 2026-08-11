# Material Strategy (hybrid, browser-first)

The project uses neither extreme (all-texture nor all-procedural). Guiding rule: **choose the
simplest implementation that hits the locked look without hurting load time.** The user
prioritizes portfolio load time, so cheap surface detail stays procedural (0 KB); authored
textures are used where they materially beat procedural.

## Legend
- **Runtime GLSL** — `onBeforeCompile` override in `src/materials/proceduralMaterials.js` (0 KB).
- **Authored** — baked image texture (WEBP/PNG) in the GLB or `public/`.
- **PBR** — plain MeshStandard params (color/roughness/metalness) set in Blender.

| Material | Objects | Strategy | Static (authored/procedural) | Dynamic (runtime) | Notes |
|----------|---------|----------|------------------------------|-------------------|-------|
| `M_Wall` | back wall | Runtime GLSL | stucco tooth + mottle + bump (`applyStuccoWall`) | weather tint (future) | 0 KB; procedural beats a big unique wall texture |
| `M_Frame` (window frame/sill/casing) | window trim | Runtime GLSL | whitewash wood grain (`applyWhitewashWood`) | — | grain runs along each member's long axis |
| `M_Glass` | window glass | Runtime material | — | transmission (HIGH) / alpha (LOW) + dust (`applyGlassDust`) | device-tier; see window-glass-transmission |
| `M_OutFence` | fence pickets | Runtime GLSL | rustic plank grain (`applyFenceWood`) | weather tint (future) | tiles across pickets by world X |
| `M_LampWood` | lamp stem/base | Runtime GLSL | honey wood grain (`applyLampWood`) | — | |
| `M_LampShade` | lamp shade | Runtime GLSL | pleated fabric + weave (`applyPleatedShade`) | emissive glow gated by lamp on/off | off-white cream |
| `M_LampBulb` | bulb | PBR emissive | Blender emissive | on/off (emissiveIntensity) | blooms |
| `M_CamMetal` | camera top/rings | PBR | Blender: matte dark grey | — | migrated to Blender |
| `M_CamBody` | camera body | PBR | Blender dark leatherette | — | procedural grain is Blender-only (doesn't export) |
| exterior (`M_OutHouse/Roof/Hill/Pine/…`, `M_Blossom`, `M_TreeBark`) | outside diorama | PBR + Runtime | Blender colors; `M_Blossom` alpha-cutout | vibrance boost (`applyOutsideVibrance`), wind (future) | blossoms/forest must be alpha-CUTOUT to show through transmission glass |
| `M_DeskMat` | leather pad | **Authored** | `leather_basecolor.png` + `leather_normal.png` | PBR response | procedural bump doesn't export → baked |
| Distant forest | 2 cards | **Authored** | `forest_near.png` / `forest_far.png` (alpha CLIP→MASK) | — | 2.5D painted cards |
| Wall art | posters/note/photo | **Authored** | `public/art/*.png` | slight emissive | swappable |
| `MAT_DESK_STYLIZED_WOOD` | desk top | **Authored** (baked WEBP) | desk base color | PBR | candidate for hybrid roughness/normal upgrade later |

## Deferred hybrid upgrades (manual-art passes, NOT regressions)
These currently look good with their procedural/PBR stand-ins; upgrade to authored maps only if
the locked camera demands it, and measure download vs. GPU vs. visual gain first:
- Desk wood: add authored roughness + subtle normal alongside the base color.
- Tree bark: painterly base color + roughness + subtle normal.
- Cherry blossoms: optimized atlas + packed utility map + translucency approximation.

## Texture delivery guidance
Base color = sRGB; roughness/normal/AO = linear. Prefer WEBP/AVIF for 2D, KTX2/Basis for 3D maps
where beneficial. Channel-pack ORM (AO/Rough/Metal) when it reduces payload without hurting
maintainability. 2K only for hero surfaces that visibly fail at 1K from the locked camera; 512–1K
for secondary. Atlas blossoms/vegetation. Always visually compare before/after compression.
