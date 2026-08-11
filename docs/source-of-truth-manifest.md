# Source-of-Truth Manifest

Per-system ownership. When you change a system, change it at its source (see `CLAUDE.md`).

| System | Source of truth |
|--------|-----------------|
| Room geometry (walls, window opening, sill/casing) | `blender/room_shell.blend` → `desk_master.blend` |
| Laptop geometry + hinge pivot | `blender/laptop.blend` |
| Desk composition / prop placement | `blender/desk_master.blend` (links the asset collections) |
| Exterior geometry (tree, fence, house, forest, ground) | `blender/outside_environment.blend`, `cherry_tree.blend` |
| Lamp / camera-prop / mug / standee / desk-mat geometry | `blender/lamp.blend` / `camera_prop.blend` / `mug.blend` / `standee.blend` / `desk_mat.blend` |
| Lamp position | Blender `Lamp_Root` (desk_master) |
| Lamp **light** position | Blender anchor `LIGHT_ANCHOR_LAMP` (parented to lamp) → resolved by `LampLight` in `App.jsx` |
| Camera-prop position + rotation | Blender `Camera_Root` (desk_master) |
| Window vertical position + wall opening | Blender (window meshes lifted +0.05 Z; wall opening bottom raised to Z 0.90) |
| Camera-prop material (matte dark grey) | Blender material `M_CamMetal` |
| Desk-mat leather look | Authored textures `blender/textures/leather_basecolor.png` + `leather_normal.png` |
| Distant forest cards | Authored textures `blender/textures/forest_near.png` + `forest_far.png` |
| Wall art (poster / note / photo) | Authored PNGs `web/public/art/*` (R3F planes in `WallArt`) |
| Résumé paper / screen | White target planes (HTML/render-target destined) |
| Wall / window-frame / fence / lamp-wood / lamp-shade / glass-dust / outside-vibrance surfaces | **Runtime GLSL** `src/materials/proceduralMaterials.js` |
| Window glass (clear/transmission + LOW-tier fallback) | Runtime — `DeskScene` in `App.jsx` (device-tier dependent) |
| Sunny-morning lighting (sun + ambient) | `src/config/weather.js` (`WEATHER.sunnyMorning`) |
| Lamp light params (color/intensity/distance/decay) | `src/config/scene.js` (`LAMP_LIGHT`) |
| Fog / background / exposure / post-processing grade | `src/config/scene.js` (`FOG`, `BACKGROUND_COLOR`, `TONE_MAPPING_EXPOSURE`, `POST`) |
| Camera scroll waypoints + hinge-open angle + timeline | `src/config/camera.js` (`WEBSITE`/`SCREEN`/`STANDEE`, `HINGE_OPEN`, `PHASE`) |
| Device quality tiers (dpr, shadow map) | `src/config/quality.js` (`QUALITY_PRESETS`) |
| Scroll interaction / camera animation | `DeskScene` `useFrame` in `App.jsx` |
| Scroll SOURCE (desktop = drei ScrollControls, mobile = the document itself) | `src/utils/viewport.js` (`IS_MOBILE_VIEWPORT`) + `MobileScrollDriver` in `App.jsx`; timeline length `SCROLL_PAGES`, mobile smoothing `MOBILE_SCROLL_SMOOTH` (`config/camera.js`) |
| Mobile browser-chrome handling (document scroll, fullscreen request, landscape lock) | `src/utils/viewport.js` + the `html.is-mobile-viewport` block in `styles.css` |
| Laptop opening behavior | `DeskScene` (rotates `Laptop_Hinge`) |
| Lamp on/off interaction | `DeskScene` click handler + `App` `lampOn` state |
| Sky (gradient/sun/clouds) | `Sky` shader in `App.jsx` (driven by `weather.js`) |
| Coffee steam / poster glass glaze | Runtime shaders in `App.jsx` |
| Bloom / vignette / grade | `EffectComposer` in `App.jsx` (params in `config/scene.js` `POST`) |
