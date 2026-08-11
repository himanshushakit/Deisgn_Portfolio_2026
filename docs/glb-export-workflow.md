# GLB Export Workflow

`web/public/scene.glb` is a **build artifact** regenerated from `blender/desk_master.blend`.
Never hand-edit it. `desk_master.blend` links the per-asset `.blend` collections (room_shell,
laptop, outside_environment, lamp, camera_prop, mug, standee, desk_mat) under `LINKED_ASSETS`.

## Steps
1. **Edit the right file.** Geometry/material of an asset → its own `.blend` (e.g. `lamp.blend`).
   Composition / static placement / anchors → `desk_master.blend`. Save the file(s).
2. **Export** from `desk_master.blend` (via Blender MCP `execute_blender_code` or Blender UI).
   IMPORTANT: the runtime loads with a `/draco/` decoder, so you MUST enable Draco — omitting it
   bloats the GLB ~8× (≈10 MB → ≈78 MB). And when running headless via MCP, wrap the op in a
   VIEW_3D `temp_override` or it throws `AttributeError: 'Context' object has no attribute 'active_object'`.
   ```python
   import bpy
   bpy.ops.wm.save_mainfile()
   win = bpy.context.window_manager.windows[0]
   area = next((a for a in win.screen.areas if a.type=='VIEW_3D'), None) or win.screen.areas[0]
   if area.type != 'VIEW_3D': area.type = 'VIEW_3D'
   region = next((r for r in area.regions if r.type=='WINDOW'), None)
   with bpy.context.temp_override(window=win, area=area, region=region):
       bpy.ops.export_scene.gltf(
           filepath='/Users/bachatt/Desktop/Portfolio 2026/web/public/scene.glb',
           export_format='GLB',
           use_visible=True,          # excludes the excluded REFERENCES collection + hidden guides
           export_apply=True,         # apply modifiers (bakes them into the mesh)
           export_cameras=True,       # CAM_* waypoints
           export_lights=True,        # (stripped at runtime, but harmless)
           export_extras=True,
           export_image_format='WEBP',# keep textures small (load time)
           export_yup=True,
           export_draco_mesh_compression_enable=True,  # REQUIRED (runtime uses /draco/ decoder)
           export_draco_mesh_compression_level=6)
   ```
3. **Bump the cache-bust:** increment `?v=` on `GLB_URL` in `src/config/scene.js`.
4. **Verify** (runtime matches GLB content by NAME, so drift breaks silently):
   - node names + material names survive (41 materials expected);
   - required anchors present (`LIGHT_ANCHOR_LAMP`);
   - `dev` console shows no `[sceneValidation]` warnings.
5. **Screenshot-compare** the locked sunny-morning frame; keep or revert.

## Coordinate mapping (Blender Z-up → glTF/three Y-up)
- Position: `three = (bx, bz, -by)`  ⇔  `blender = (three_x, -three_z, three_y)`
- Rotation about the vertical axis: three `rotation.y` == Blender `rotation_euler.z` (same sign).

## Anchors (named empties the runtime resolves by name)
- `LIGHT_ANCHOR_LAMP` — child of `Lamp_Root`; world position = lamp point-light position. Move the
  lamp in Blender and the light follows on next export, no code change.
- To add an anchor: create an Empty, parent it to the relevant object, place it, ensure it's in a
  visible (non-excluded) collection so `use_visible=True` exports it, then read it in code with
  `scene.getObjectByName(name)` + `getWorldPosition()`.

## Gotchas (from `blender/SCENE_CONTRACT.md`, still true)
- **Modifiers don't export unless applied/baked.** `export_apply=True` bakes them at export. (The
  contract's old warning about `export_apply=True` dropping linked objects did NOT reproduce with
  the current Blender/exporter — the full linked scene exported correctly and was verified in the
  browser. If a future export ever drops linked objects, bake modifiers in each asset `.blend`
  instead and export with `export_apply=False`.)
- **AREA lights don't export** (glTF unsupported) — expected warnings, ignorable (lights are
  stripped at runtime anyway).
- **External textures kept unpacked** where library-linking caused stale/zero pixels (desk-mat,
  forest cards). WEBP export handles the packed ones.

## Stale references
`blender/SCENE_CONTRACT.md` predates this recovery. Stale values: lamp `Lamp_Root (0.48,1.28,…)`
(now `0.70,1.22,…`), camera `Camera_Root (0.66,…,-72°)` (now `0.43,…,-1.10 rad`), window Z (now
+0.05), `M_Glass` "alpha 0.14" (now runtime transmission/alpha swap), `M_CamMetal` "satin silver"
(now matte dark grey). The contract's *spatial spec / cameras / hinge / layers* remain authoritative.
