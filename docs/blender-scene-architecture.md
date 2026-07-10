# Blender Scene Architecture

## File strategy (master + linked assets — already in place)
```
room_shell.blend         COL_ROOM_SHELL   (walls, window frame/glass/sill/casing)
laptop.blend             COL_LAPTOP       (base + Laptop_Hinge → lid; the opening hierarchy)
outside_environment.blend COL_OUTSIDE     (fence, house, forest cards, ground, pole)
cherry_tree.blend        COL_CHERRY_TREE  (trunk, branches, blossom clusters)
lamp.blend               COL_LAMP         (wooden lamp + LIGHT_ANCHOR_LAMP)
camera_prop.blend        COL_CAMERA       (vintage SLR)
mug.blend                COL_MUG          desk_mat.blend  COL_DESKMAT   standee.blend  COL_STANDEE
        │  (all LINKED, not appended)
        ▼
desk_master.blend  ← LINKED_ASSETS holds all COL_*; REFERENCES (REF_ greybox) is EXCLUDED from
                     the view layer; CAMERAS (CAM_*) + LIGHTING. EXPORT FROM HERE.
```
`desk_master.blend` owns: composition, static positions/rotations/scales, hierarchy, pivots,
anchors, material assignments. It does **not** own runtime weather lighting, post, rain/fog,
interactive lamp state, or scroll-driven camera behavior (all code-side).

## Collections & export scope
`use_visible=True` on export reproduces the shipped GLB scope: everything in `LINKED_ASSETS`,
`CAMERAS`, `LIGHTING` exports; `REFERENCES` (the `REF_*` greybox guides) is excluded from the view
layer so it stays out of the GLB. Keep new authored objects in an appropriate `COL_*`; keep guides
in `REFERENCES`.

## Anchors (empties the runtime resolves)
- `LIGHT_ANCHOR_LAMP` — child of `Lamp_Root`; world pos = lamp point-light pos. **Implemented.**
- Candidates to add when the matching system is built (create only when needed, don't pre-create):
  `CAMERA_TARGET_LAPTOP`, `CAMERA_TARGET_HERO`, `WINDOW_CENTER`, `RAIN_VOLUME` / `FOG_VOLUME`,
  `PETAL_EMITTER`, `TREE_WIND_ROOT`, `SUN_TARGET`. (`Laptop_Hinge`, `CAM_*` cameras already exist.)

## Lighting in Blender
Runtime lighting is code-owned (3 lights). Blender's `SUN_Key`/`TmpSun`/`Area`/`Area.001`/
`LAMP_Bulb_Light` are all stripped at load. They currently remain in the file (user choice). If you
want the file to stop implying it controls runtime light, move look-dev lights into a
`91_LOOKDEV_LIGHTS` collection marked "LOOKDEV ONLY — DO NOT EXPORT" and exclude it from the view
layer (or export with `export_lights=False`).

## Units / spatial spec
See `blender/SCENE_CONTRACT.md` (authoritative for units, key heights, window/opening dims,
laptop hinge axis, camera waypoints, render aspect, scroll timeline). Note the stale numeric values
flagged in `glb-export-workflow.md` (lamp/camera/window/glass changed during the recovery).
