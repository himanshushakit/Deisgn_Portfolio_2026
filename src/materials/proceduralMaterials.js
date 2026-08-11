// ============================================================================
// PROCEDURAL MATERIAL REGISTRY  —  runtime GLSL material overrides (CODE source of truth).
// ----------------------------------------------------------------------------
// These mutate GLB-imported MeshStandardMaterials in place via onBeforeCompile to add
// procedural surface detail with ZERO download weight (no baked image maps). They are the
// deliberate exception to "author visuals as textures": kept in code because baking them
// would inflate the GLB and hurt portfolio load time (see docs/material-strategy.md and
// the no-baked-textures decision). Applied from the DeskScene traverse, matched by GLB
// material/object name.
//
// Each fn is pure (takes a material, mutates it) so they're trivially unit-swappable and
// testable. Coordinate convention inside shaders: world-space position varyings.
// ============================================================================
import * as THREE from 'three'
import { LAMP_SHADE_GLOW } from '../config/scene.js'

// ── Shared "sun-kiss" injection for exterior objects ────────────────────────────────
// Adds a warm ADDITIVE glow on surfaces facing the sun (+ a soft sunlit rim on grazing
// edges), so the tree/house/fence catch the low morning light on their sun-facing sides and
// read lively instead of flatly lit. Driven by the world sun direction (matches weather sunDir,
// up + right + toward the window). Injected into a material's onBeforeCompile shader.
//
// WEATHER-AWARE: the warm glow is a SUNNY effect — moonlight (night) is cool/soft and fog
// scatters direct sun away, so BOTH fade the kiss. Each material's uSunAmt uniform (+ morning
// base) is registered below; the weather driver calls setOutsideWeather(night, fog) each frame.
const _sunKissUniforms = []      // [{ u: uSunAmt uniform, base: morning amount }]
const _outsideNightUniforms = [] // [uNight uniform] on the vibrance materials (cool night grade)
const _outsideFogUniforms = []   // [uFog uniform]   on the vibrance materials (desaturate + wash)
const _outsideRainUniforms = []  // [uRain uniform]  on the vibrance materials (darker wet grade)
export function setOutsideWeather(night, fog, rain) {
  const n = Math.min(Math.max(night, 0), 1)
  const f = Math.min(Math.max(fog, 0), 1)
  const r = Math.min(Math.max(rain || 0, 0), 1)
  const k = (1.0 - n * 0.92) * (1.0 - f * 0.85) * (1.0 - r * 0.9)   // sun-kiss killed by night + fog + rain
  for (const e of _sunKissUniforms) e.u.value = e.base * k
  for (const u of _outsideNightUniforms) u.value = n   // cool + darken exterior albedo toward night
  for (const u of _outsideFogUniforms) u.value = f     // desaturate + wash exterior albedo toward fog
  for (const u of _outsideRainUniforms) u.value = r    // darken + slight desat exterior albedo toward rain (wet)
}

// NOTE: an earlier "hero-object readability floor" lived here — a per-material additive emissive
// (tinted by the surface's own albedo, scaled up at night/fog/rain) meant to stop the laptop,
// desk, camera, guitar and standee from crushing to black in the dim presets. It was REMOVED
// because emissive fundamentally cannot "behave with the light": it ignores light direction,
// colour and on/off state. That produced four separate regressions — it flattened the laptop's
// metallic specular, turned the standee's clear acrylic milky, self-lit the warm desk bright
// orange under cool moonlight, and left the camera's leather body glowing neutral grey with the
// lamp off. Legibility in dark presets is handled by the AMBIENT hemisphere fill instead
// (weather.js `ambient.intensity`), which is a real light and so responds correctly to weather
// and to the lamp. If a prop ever reads too dark, raise that — never add emissive.

function _addSunKiss(shader, sunDir = [0.34, 0.55, -0.76], col = [1.0, 0.72, 0.36], amt = 1.35) {
  shader.uniforms.uSunDir = { value: new THREE.Vector3(sunDir[0], sunDir[1], sunDir[2]).normalize() }
  shader.uniforms.uSunCol = { value: new THREE.Color(col[0], col[1], col[2]) }
  shader.uniforms.uSunAmt = { value: amt }
  _sunKissUniforms.push({ u: shader.uniforms.uSunAmt, base: amt })
  if (!/varying vec3 vSunN;/.test(shader.vertexShader)) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSunN;\nvarying vec3 vSunWP;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vSunN = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSunWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
  }
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunCol;\nuniform float uSunAmt;\nvarying vec3 vSunN;\nvarying vec3 vSunWP;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      { vec3 N = normalize(vSunN); vec3 V = normalize(cameraPosition - vSunWP);
        float ndl = max(dot(N, uSunDir), 0.0);               // how much the surface faces the sun
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);     // grazing-edge falloff
        float kiss = ndl * ndl * 0.85 + rim * ndl * 0.7;     // warm on sun-facing faces + sunlit edges
        // Tint the glow by the surface's OWN colour (× albedo) so it lights each object in its
        // own hue instead of adding white — keeps saturation (pink blossoms glow warm-pink, not pale).
        totalEmissiveRadiance += diffuseColor.rgb * uSunCol * (kiss * uSunAmt); }`)
}
// ── Procedural whitewashed / limewashed BRICK wall ──────────────────────────────────
// Warm cream painted-brick: running-bond courses with recessed mortar joints, per-brick
// tone/warmth variation, a fine painted tooth over the faces, and a broad limewash mottle.
// Bricks read proud, joints recessed (screen-space bump) so the courses catch the sun.
// Ref: Ai references/wall reference.png (limewashed ivory brick). Keeps the desk-line AO band.
export function applyBrickWall(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.94, 0.83, 0.63) // bright warm ivory limewash (linear); shader varies it
  m.roughness = 0.92
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBump = { value: 1.5 }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWallPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWallPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWallPos;
        uniform float uBump;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = h21(i), b = h21(i + vec2(1,0)), c = h21(i + vec2(0,1)), d = h21(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
        // fine painted tooth (rough surface grain) on the brick faces
        float speckle(vec2 p){ float n = vnoise(p * 210.0); return n * n; }
        float tooth(vec2 p){ return 0.45 * speckle(p) + 0.32 * fbm(p * 80.0) + 0.23 * fbm(p * 30.0); }
        // running-bond brick face mask: returns face(1)/joint(0) + writes brick id + local f
        const float BW = 0.148, BH = 0.053;      // brick length / row height (world metres) — ~0.8x, same ratio
        const float MW = 0.055, MH = 0.10;       // mortar joint width (fraction of cell)
        float brickFace(vec2 uv, out vec2 bid){
          float rowf = floor(uv.y / BH);
          float cx = uv.x / BW + mod(rowf, 2.0) * 0.5;   // half-brick offset on alternate rows (rows stay grid-aligned)
          vec2 cell = vec2(cx, uv.y / BH);
          bid = floor(cell);
          vec2 f = fract(cell);
          // per-brick SUBTLE size variation (few %): jitter the mortar inset per brick so widths/
          // heights differ slightly. The cell grid is unchanged, so courses stay perfectly straight.
          float mw = MW + (h21(bid + 1.7) - 0.5) * 0.028;   // brick width  ~±2.5%
          float mh = MH + (h21(bid + 4.3) - 0.5) * 0.045;   // brick height ~±2.5%
          // tiny edge irregularity on a SMALL % of bricks only (~15%), never broken/chipped
          float flag = step(0.85, h21(bid + 9.9));
          vec2 fw = f + flag * (vec2(vnoise(uv * vec2(55.0, 18.0)), vnoise(uv * vec2(18.0, 55.0))) - 0.5) * 0.03;
          float ex = smoothstep(0.0, mw, fw.x) * (1.0 - smoothstep(1.0 - mw, 1.0, fw.x));
          float ey = smoothstep(0.0, mh, fw.y) * (1.0 - smoothstep(1.0 - mh, 1.0, fw.y));
          return ex * ey;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 wuv = vWallPos.xy;                 // back wall lies in the XY plane
        vec2 bid;
        float face = brickFace(wuv, bid);       // 1 = brick face, 0 = mortar joint
        float joint = 1.0 - face;
        float bt  = h21(bid + 3.7);             // per-brick lightness
        float bt2 = h21(bid * 1.7 + 9.1);       // per-brick warmth
        float fine  = fbm(wuv * 70.0);          // fine painted-surface unevenness
        float micro = vnoise(wuv * 240.0);      // very fine tooth — breaks the perfectly flat look
        float wash  = fbm(wuv * 2.2);           // broad faint unevenness (worn paint)
        vec3 col = diffuseColor.rgb;
        // SUBTLE per-brick colour variation (~2-5%) so no two bricks read identical
        col *= (0.975 + 0.05 * bt);
        col = mix(col, col * vec3(1.03, 1.00, 0.965), bt2 * 0.5);   // a few bricks a touch warmer
        // very fine surface noise + faint worn-paint unevenness (only felt subconsciously)
        col *= (0.97 + 0.05 * fine);
        col *= (0.985 + 0.03 * micro);
        col *= (0.965 + 0.06 * wash);
        // Mortar: a bit more visible than fully-blended, but still warm-grey + darker (never bright grout)
        col = mix(col, col * vec3(0.79, 0.77, 0.73), joint * 0.68);
        diffuseColor.rgb = col;
        // Contact shadow (ambient occlusion) where the desk meets the wall: darken the wall
        // just above the desk's back edge (Y=0.85), fading up, only across the desk width.
        float aoBand = 1.0 - smoothstep(0.85, 1.06, vWallPos.y);
        float aoX = smoothstep(1.18, 1.0, abs(vWallPos.x));
        diffuseColor.rgb *= mix(1.0, 0.66, aoBand * aoX);`)
      // Matte with only a soft, slightly-uneven grazing highlight — never glossy.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float rv = fbm(wuv * 55.0); roughnessFactor = clamp(roughnessFactor - 0.05 + 0.05 * rv, 0.82, 0.97); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 bid2;
          float faceE = brickFace(vWallPos.xy, bid2);   // smooth mask -> ramps at edges = soft chamfer, not a sharp step
          float fineH = fbm(vWallPos.xy * 70.0);
          float depth = (h21(bid2 + 2.9) - 0.5) * 0.18; // per-brick proud/recess — minimal depth variation
          float hgt = faceE * (0.60 + depth) + fineH * 0.22; // gently proud, chamfered bricks + fine surface (no deep cracks)
          vec3 bmp = vec3(dFdx(hgt), dFdy(hgt), 0.0) * uBump;
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'brick-wall'
  m.needsUpdate = true
}

// ── Procedural whitewashed / limed-wood window frame ────────────────────────────────
// White painted wood: subtle darker grain along the members, a broad patchy whitewash
// unevenness, and a faint grain bump. mode: 0=vertical grain, 1=horizontal, 2=auto (by ring).
// ctr/half describe the member's world-space bbox (used by auto to tell which side a
// fragment sits on) so grain runs along each member's LONG axis.
export function applyWhitewashWood(m, opts = {}) {
  if (!m.isMeshStandardMaterial) return
  const { mode = 0, cx = 0, cy = 0, hw = 1, hh = 1 } = opts
  if (m.color) m.color.setRGB(0.87, 0.85, 0.80) // warm off-white paint (linear); shader adds grain
  m.roughness = 0.62   // a touch glossier so each bevel picks up a soft sun sheen -> bevels read distinctly
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBumpW = { value: 0.68 }
    shader.uniforms.uMode = { value: mode }
    shader.uniforms.uCtr = { value: new THREE.Vector2(cx, cy) }
    shader.uniforms.uHalf = { value: new THREE.Vector2(hw, hh) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPos;\nvarying vec3 vWoodN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vWoodN = normalize(mat3(modelMatrix) * objectNormal);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWoodPos;
        varying vec3 vWoodN;
        uniform float uBumpW; uniform float uMode; uniform vec2 uCtr; uniform vec2 uHalf;
        float hw(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nw(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hw(i), b = hw(i + vec2(1,0)), c = hw(i + vec2(0,1)), d = hw(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbmw(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nw(p); p *= 2.03; a *= 0.5; } return s; }
        // streaks run ALONG 'a' (slow), vary fast ACROSS 'b'
        float grain2(float a, float b){ return 0.6 * fbmw(vec2(a * 8.0, b * 78.0)) + 0.4 * fbmw(vec2(a * 18.0, b * 175.0)); }
        // TRIPLANAR grain so the streaks run along each member's LONG axis on EVERY face —
        // including the horizontal top/underside 'soffit' reveal that a flat X/Y grain got wrong
        // (that soffit was the mis-oriented, off-colour top rail). uMode: 0 = grain along world Y
        // (vertical member), 1 = along world X (horizontal member), 2 = ring (top/bottom rails -> X,
        // side stiles -> Y, chosen per fragment). Same grain everywhere -> consistent tone too.
        float woodGrain(vec3 P, vec3 N){
          float railMix;
          if (uMode < 0.5) railMix = 0.0;
          else if (uMode < 1.5) railMix = 1.0;
          else { vec2 nrm = (P.xy - uCtr) / max(uHalf, vec2(1e-3)); railMix = smoothstep(-0.1, 0.1, abs(nrm.y) - abs(nrm.x)); }
          vec3 an = abs(normalize(N)); float ws = an.x + an.y + an.z + 1e-4;
          float gXY = grain2(mix(P.y, P.x, railMix), mix(P.x, P.y, railMix)); // front/back faces
          float gXZ = grain2(P.x, P.z);                                       // horizontal soffit/top -> along X
          float gZY = grain2(P.y, P.z);                                       // side reveals -> along Y
          return (gZY * an.x + gXZ * an.y + gXY * an.z) / ws;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gWood = woodGrain(vWoodPos, vWoodN);
        // broad patchiness sampled on ALL axes so it reads the same on every face (no soffit degeneracy)
        float weather = fbmw(vec2(vWoodPos.x + vWoodPos.z, vWoodPos.y + vWoodPos.z) * 2.6);
        diffuseColor.rgb *= (0.88 + 0.19 * gWood);            // grain light/dark — a touch more visible streaks
        float line = smoothstep(0.32, 0.60, gWood);           // grain valleys -> tint lines
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.95, 0.92, 0.88), diffuseColor.rgb, line); // slightly deeper warm grain tone
        diffuseColor.rgb *= (0.975 + 0.05 * weather);         // subtle uneven paint thickness`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 bmp = vec3(dFdx(gWood), dFdy(gWood), 0.0) * uBumpW;
          normal = normalize(normal - bmp);                   // faint grain relief
        }`)
  }
  m.customProgramCacheKey = () => 'whitewash-wood-tri'
  m.needsUpdate = true
}

// ── Frosted ribbed-glass lampshade ──────────────────────────────────────────────────
// OPAQUE frosted glass with vertical FLUTED RIBS (the curvy folds) around the cone, built
// from the azimuthal angle about the shade axis (cosine profile). Cool milky-white with a
// smooth glassy sheen (no woven-fabric grain) so it reads as frosted/ribbed glass, not paper;
// opaque so the bulb inside is NOT visible. The warm emissive glow (when lit) is modulated by
// the same rib pattern so the flutes read while glowing. cx/cz = shade world-space centre (axis).
export function applyPleatedShade(m, cx, cz) {
  if (!m.isMeshStandardMaterial) return
  m.transparent = false
  m.opacity = 1.0
  m.depthWrite = true
  m.roughness = 0.42               // smooth frosted-glass sheen (was matte fabric 0.9)
  m.metalness = 0.0
  if (m.color) m.color.setRGB(0.90, 0.93, 0.97)      // cool milky frosted-glass white
  if (m.emissive) m.emissive.setRGB(1.0, 0.87, 0.62) // warm glow colour when lit
  m.emissiveIntensity = LAMP_SHADE_GLOW
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShadeCtr = { value: new THREE.Vector2(cx, cz) }
    shader.uniforms.uPleats = { value: 34.0 }      // number of vertical glass ribs around the cone
    shader.uniforms.uPleatDepth = { value: 0.16 }  // SOFT rib shading (off-state relief)
    shader.uniforms.uGlowDepth = { value: 0.38 }   // rib darkening on the GLOW (on-state read)
    shader.uniforms.uReliefStr = { value: 0.75 }   // normal-bump strength for the ribs (gentle)
    shader.uniforms.uGrain = { value: 0.0 }        // no woven grain (glass, not fabric)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShadePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vShadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vShadePos;
        uniform vec2 uShadeCtr; uniform float uPleats; uniform float uPleatDepth;
        uniform float uGlowDepth; uniform float uReliefStr; uniform float uGrain;
        // azimuth around the shade axis -> smooth ROUNDED fold (0 at a crease, 1 at a ridge)
        float pleatWave(vec3 p){
          float a = atan(p.x - uShadeCtr.x, p.z - uShadeCtr.y);
          return 0.5 + 0.5 * cos(a * uPleats);   // cosine = naturally soft, no hard edges
        }
        // cheap value noise for a fine woven-fabric grain
        float shHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        float shNoise(vec3 x){
          vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(shHash(i+vec3(0,0,0)),shHash(i+vec3(1,0,0)),f.x),
                         mix(shHash(i+vec3(0,1,0)),shHash(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(shHash(i+vec3(0,0,1)),shHash(i+vec3(1,0,1)),f.x),
                         mix(shHash(i+vec3(0,1,1)),shHash(i+vec3(1,1,1)),f.x),f.y),f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float plt = pleatWave(vShadePos);
        // gentle rounded fold shading only — no sharp seam line, so creases stay soft when unlit
        diffuseColor.rgb *= mix(1.0 - uPleatDepth, 1.0, plt);
        // fine woven grain: subtle brightness speckle across the fabric
        float grain = shNoise(vShadePos * 220.0);
        diffuseColor.rgb *= 1.0 + (grain - 0.5) * uGrain * 2.0;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float plt = pleatWave(vShadePos);
          // deeper crease darkening on the GLOW so pleats still read clearly while lit
          totalEmissiveRadiance *= mix(1.0 - uGlowDepth, 1.0, plt);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float h = pleatWave(vShadePos);
          float g = shNoise(vShadePos * 220.0);
          // gentle fold relief + faint grain roughness in the surface normal
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * uReliefStr
                   + vec3(dFdx(g), dFdy(g), 0.0) * uGrain * 1.5;
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'frosted-ribbed-shade'
  m.needsUpdate = true
}

// ── Lamp wooden stem + base: polished honey-wood grain ──────────────────────────────
// M_LampWood (stem, disc, base) ships as a flat solid colour. Paints straight wood grain —
// honey tones, wavy figure lines, fine pore speckle, grain relief. Pattern = fn of
// horizontal world position (constant along Y) => vertical streaks on the stem, plank
// grain across the base.
export function applyLampWood(m) {
  if (!m.isMeshStandardMaterial) return
  m.metalness = 0.0
  m.roughness = 0.5                 // polished-but-matte varnish
  if (m.color) m.color.setRGB(1, 1, 1) // let the shader drive colour fully
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLineFreq = { value: 95.0 } // grain lines per world unit (dense = fine grain)
    shader.uniforms.uFigFreq = { value: 6.0 }   // broad wavy-figure frequency
    shader.uniforms.uWarp = { value: 0.5 }      // how much the figure bends the grain lines
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWoodPos;
        uniform float uLineFreq; uniform float uFigFreq; uniform float uWarp;
        float wHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float wNoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(wHash(i), wHash(i+vec2(1,0)), f.x),
                     mix(wHash(i+vec2(0,1)), wHash(i+vec2(1,1)), f.x), f.y); }
        float wFbm(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<4;i++){ s += a*wNoise(p); p *= 2.0; a *= 0.5; } return s; }
        // fine vertical wood streaks: grain runs along Y, varies with horizontal position.
        // Lines are warped by a low-freq figure so they gently wave like real grain.
        float woodLines(vec2 xz){
          float fig = wFbm(xz * uFigFreq);
          float l = 0.5 + 0.5 * sin((xz.x * uLineFreq + fig * uWarp * uLineFreq) * 0.06283185);
          return pow(l, 2.0);   // thin dark grain lines between broad light bands
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 xz = vWoodPos.xz;
        float fig = wFbm(xz * uFigFreq);
        float lines = woodLines(xz);
        float pore = wFbm(xz * 120.0 + vWoodPos.y * 3.0);         // fine pore speckle
        vec3 lightWood = vec3(0.80, 0.48, 0.20);                   // honey highlight
        vec3 darkWood  = vec3(0.37, 0.18, 0.07);                   // grain line
        vec3 wood = mix(darkWood, lightWood, clamp(lines * 0.75 + fig * 0.3, 0.0, 1.0));
        wood *= 0.88 + pore * 0.22;                                // subtle tonal variation
        diffuseColor.rgb = wood;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float pr = wFbm(vWoodPos.xz * 120.0 + vWoodPos.y * 3.0);
          roughnessFactor = clamp(roughnessFactor + (pr - 0.5) * 0.18, 0.3, 0.7); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float h = woodLines(vWoodPos.xz);
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * 0.08;    // faint grain relief
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'lamp-wood'
  m.needsUpdate = true
}

// ── Window-glass dust: sparse subtle speckles clustered at the bottom of the pane ─────
// Concentrated toward the lower edge (pow(1-h,5)) + left side, with sparse fine spots +
// faint haze; renders as tiny frosted specks (local roughness bump) + a whisper of tint,
// so the glass reads as real glass without veiling the view. min/max X/Y are the glass
// mesh's world-space bounds. Chains any prior onBeforeCompile (e.g. the glass material).
export function applyGlassDust(m, minY, maxY, minX, maxX) {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader)
    shader.uniforms.uGMinY = { value: minY }
    shader.uniforms.uGMaxY = { value: maxY }
    shader.uniforms.uGMinX = { value: minX }
    shader.uniforms.uGMaxX = { value: maxX }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGDustPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGDustPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGDustPos; uniform float uGMinY; uniform float uGMaxY; uniform float uGMinX; uniform float uGMaxX;
        float gdHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float gdNoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
          return mix(mix(gdHash(i), gdHash(i+vec2(1,0)), f.x),
                     mix(gdHash(i+vec2(0,1)), gdHash(i+vec2(1,1)), f.x), f.y); }
        float glassDust(vec3 p){
          float h  = clamp((p.y - uGMinY) / max(uGMaxY - uGMinY, 1e-3), 0.0, 1.0); // 0 bottom, 1 top
          float nx = clamp((p.x - uGMinX) / max(uGMaxX - uGMinX, 1e-3), 0.0, 1.0); // 0 left, 1 right
          float leftBoost = smoothstep(0.55, 0.0, nx);          // stronger toward the left
          float bottomMask = pow(1.0 - h, 5.0) * (1.0 + leftBoost * 1.1); // bottom, extra on left
          float topLeftMask = smoothstep(0.5, 1.0, h) * smoothstep(0.5, 0.0, nx) * 0.8; // left-top cluster
          float mask = bottomMask + topLeftMask;
          float spots = smoothstep(0.86, 0.99, gdNoise(p.xy * 165.0))   // fine specks
                      + smoothstep(0.90, 0.995, gdNoise(p.xy * 320.0)) * 0.7; // extra finer specks
          float haze  = smoothstep(0.85, 1.0, gdNoise(p.xy * 60.0)) * 0.35; // faint low haze
          return clamp((spots + haze) * mask, 0.0, 1.0);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float gd = glassDust(vGDustPos); roughnessFactor = mix(roughnessFactor, 0.55, gd * 0.9); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float gd = glassDust(vGDustPos);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.89, 0.91), gd * 0.5);
          diffuseColor.a = mix(diffuseColor.a, 0.42, gd); }`)
  }
  m.customProgramCacheKey = () => 'glass-dust'
  m.needsUpdate = true
}

// ── Outside-scene vibrance boost ────────────────────────────────────────────────────
// Exterior objects read a touch flat through ACES tonemapping; this lifts their saturation
// AFTER tonemapping so the view through the window pops, without touching the interior.
export function applyOutsideVibrance(m, sat = 1.3, sunAmt = 1.35, houseWindows = false) {
  if (!m.isMeshStandardMaterial || m.userData._vib) return
  m.userData._vib = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader)
    shader.uniforms.uSat = { value: sat }
    shader.uniforms.uNight = { value: 0 }               // 0 day; driven to 1 at night (setOutsideWeather)
    shader.uniforms.uFog = { value: 0 }                 // 0 clear; driven to 1 in fog  (setOutsideWeather)
    shader.uniforms.uRain = { value: 0 }                // 0 dry; driven to 1 in rain  (setOutsideWeather)
    _outsideNightUniforms.push(shader.uniforms.uNight)
    _outsideFogUniforms.push(shader.uniforms.uFog)
    _outsideRainUniforms.push(shader.uniforms.uRain)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSat;\nuniform float uNight;\nuniform float uFog;\nuniform float uRain;')
      // Saturate the ALBEDO (pre-lighting) so the boost survives the room window's TRANSMISSION pass.
      // A post-tonemap saturate was a no-op through the transmissive glass (which is why the scene used
      // to need a second clear "vibrance pane"). Boosting the base colour instead needs no extra geometry.
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float _l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = max(mix(vec3(_l), diffuseColor.rgb, uSat), 0.0);  // saturate exterior albedo
          // Night grade: shift the albedo toward a cool moonlit tint + darken, so red blossoms
          // read as a muted dark silhouette, grass goes near-black, house/fence cool and dim —
          // NOT the vivid daylight-saturated hue the 2.2x sat boost above gives them. The mix was
          // only 0.38 (62% of the OVER-saturated colour survived) + a mild 0.80 darken, which read
          // as blossoms/grass still looking sunlit at night; pushed much further toward monochrome
          // + darker to match real moonlight (low colour, low luminance).
          float _ln = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 _cool = mix(diffuseColor.rgb, vec3(_ln) * vec3(0.74, 0.82, 1.06), 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, _cool * 0.55, uNight);
          // Fog grade: DESATURATE + wash toward pale cool grey so the tree/grass/fence lose their
          // punch and blend into the atmospheric haze (distance fade is added by scene fog on top).
          float _lf = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 _wash = mix(diffuseColor.rgb, vec3(_lf), 0.45);            // pull toward grey
          _wash = mix(_wash, vec3(0.80, 0.78, 0.74), 0.20);              // slight wash toward pale
          diffuseColor.rgb = mix(diffuseColor.rgb, _wash, uFog);
          // Rain (wet) grade: DARKER albedo + slight desat + faint cool — surfaces read damp under
          // overcast light. Stays MATTE (no gloss added); glossiness would fight the flat sky.
          float _lr = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 _wet = mix(diffuseColor.rgb, vec3(_lr), 0.14) * 0.78;      // slight desat + darker
          _wet *= vec3(0.96, 0.98, 1.04);                                // faint cool cast
          diffuseColor.rgb = mix(diffuseColor.rgb, _wet, uRain); }`)
    // HOUSE WINDOWS (night only): make the near-black window regions of the baked house mesh emit
    // a warm interior glow, so it reads as lit rooms + light spilling through the front glass. Keyed
    // on albedo luminance (windows are the darkest pixels) so no per-window geometry is needed; ×uNight
    // so it only lights at night. Bright enough (>bloom threshold) to bloom softly through the window.
    if (houseWindows) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        { float _wl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          // ONLY the near-black window GLASS glows softly. Windows are the DARKEST pixels (near 0);
          // the roof/eave/trim speckles are only borderline-dark, so a TIGHT low threshold keeps the
          // window panes lit while dropping the scattered speckles. (fwidth flatness fails here — the
          // distant house minifies its texture so every pixel reads as high-gradient.)
          float win = smoothstep(0.011, 0.002, _wl);
          totalEmissiveRadiance += vec3(1.0, 0.62, 0.30) * win * uNight * 1.15; }` )
    }
    _addSunKiss(shader, undefined, undefined, sunAmt)   // warm sun-facing glow (per-material strength)
  }
  m.customProgramCacheKey = () => (houseWindows ? 'outside-vib-house' : 'outside-vib')
  m.needsUpdate = true
}

// ── Matte anodised ALUMINIUM (MacBook lid + base) ───────────────────────────────────
// Clean, SMOOTH matte aluminium (no brushed texture) — a uniform light silver that takes
// the sun as a soft, even gradient (bright toward the light, gently darker away) and holds
// its shape without blowing to white. Physically-plausible metalness kept a hair below pure
// so form-shading reads. Ref: locked laptop reference (smooth even silver, no streaks).
// Plain material calibration (no onBeforeCompile) so the surface stays perfectly even.
export function applyLaptopAluminum(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.115, 0.121, 0.137) // deep space-grey (one step darker), even + premium
  m.metalness = 0.45                            // slightly lower so the dark base tone reads through the reflection even under the strongest key light (still plausible anodised alu)
  m.roughness = 0.56                            // slightly broader satin sheen — softens the sun's specular hotspot so the surface reads as brushed metal, not a blown highlight
  m.envMapIntensity = 0.5                       // calm the environment mirror so the sun doesn't dominate
  m.needsUpdate = true
}

// ── Camera component materials — one physical identity per part ──────────────────────
// The camera GLB ships every part near-black (base ~0.02–0.04) so it reads as one blob and
// vanishes in shadow. These give each component a distinct, NON-black material that responds
// differently to the same light (matte body vs metallic barrel vs glass vs machined rings vs
// gunmetal buttons), so the camera stays readable when partially shadowed. Richness, not
// brightness — bases stay dark, but metalness/roughness/Fresnel differ per part. Runtime GLSL.
// Keyed by OBJECT name in App (shared mats are cloned per mesh first). Stylized (LiS) look.
function _camVary(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCamP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vCamN = normalize(mat3(modelMatrix) * objectNormal);')
}
const _CAM_NOISE = `
  float hc(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
  float nc(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hc(i), b = hc(i + vec2(1,0)), c = hc(i + vec2(0,1)), d = hc(i + vec2(1,1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }`

// Shared procedural LEATHER grain (0 KB) — triplanar pebbled grain (Voronoi cells + fine
// micro-grain) driving tone + roughness + a screen-space NORMAL BUMP so it catches light like
// real leather. Base colour/metalness come from the GLB material. Used by M_CamLeather AND
// M_CamBody (the body is now brown leather). Grain computed once into `_leaG` then reused.
function _addLeatherGrain(sh) {
  _camVary(sh)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;${_CAM_NOISE}
      float voroL(vec2 p){ vec2 i=floor(p), f=fract(p); float md=8.0;
        for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec2 g=vec2(float(x),float(y));
          vec2 o=vec2(hc(i+g), hc(i+g+3.7)); float d=length(g+o-f); md=min(md,d);} return md; }
      float leaC(vec2 p){ float cell=smoothstep(0.0,0.55,voroL(p*340.0));      // rounded pebbles
        float micro=nc(p*900.0)*0.5+nc(p*1900.0)*0.5; return cell*0.72+micro*0.28; }
      float leaF(vec3 P){ vec3 bw=abs(normalize(vCamN)); bw/=(bw.x+bw.y+bw.z+1e-4);  // triplanar
        return leaC(P.zy)*bw.x + leaC(P.xz)*bw.y + leaC(P.xy)*bw.z; }
      float _leaG;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      { _leaG = leaF(vCamP); diffuseColor.rgb *= (0.80 + 0.40 * _leaG); }`)   // pebbled tone variation
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      { roughnessFactor = clamp(0.95 - 0.16 * _leaG, 0.78, 0.99); }`)          // pebble tops a touch less matte
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec3 b = vec3(dFdx(_leaG), dFdy(_leaG), 0.0) * 0.9; normal = normalize(normal - b); }`)  // grain BUMP catches light
}

// Derives a light-catching BUMP from the material's OWN baked colour texture (leather image):
// perturbs the normal by the screen-space gradient of the sampled albedo luminance, so the grain
// in the leather photo reads as real relief instead of a flat print. 0 KB, matches the pattern.
function _addImageBump(sh, strength = 3.5) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { float _h = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 _b = vec3(dFdx(_h), dFdy(_h), 0.0) * ${strength.toFixed(1)};
        normal = normalize(normal - _b); }`)
}

// Camera body — DARK grey/black solid (M_CamBody in the GLB). Leather is only on the front face
// (M_CamLeather). Nothing to add here; base colour/finish come from the GLB.
export function applyCamBody(m) {
  if (!m.isMeshStandardMaterial) return
  m.envMapIntensity = 0.5
  m.needsUpdate = true
}

// Lens barrel — dark ANODISED METAL with a softer, slightly elongated reflection.
export function applyCamBarrel(m) {
  if (!m.isMeshStandardMaterial) return
  // Base props from the GLB (M_CamLens = silver in camera_prop.blend). Detail-only below.
  m.onBeforeCompile = (sh) => { _camVary(sh)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;${_CAM_NOISE}`)
      // elongate the highlight: fine variation around the barrel, smooth along its axis
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float a = nc(vec2(vCamP.y * 240.0, vCamP.x * 26.0)); roughnessFactor = clamp(roughnessFactor + (a - 0.5) * 0.12, 0.24, 0.48); }`)
  }
  m.customProgramCacheKey = () => 'cam-barrel'; m.needsUpdate = true
}

// Lens glass — physically-plausible dark glass with a cool FRESNEL rim so the edge always
// catches light (never pure black) and it reads as glass, not a black disc.
export function applyCamGlass(m) {
  if (!m.isMeshStandardMaterial) return
  // Base props from the GLB (M_CamGlass = dark glass in camera_prop.blend). Detail-only below.
  m.onBeforeCompile = (sh) => { _camVary(sh)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 V = normalize(cameraPosition - vCamP);
          float fres = pow(1.0 - max(dot(normalize(vCamN), V), 0.0), 3.0);
          totalEmissiveRadiance += vec3(0.10, 0.14, 0.20) * fres; }`)   // cool glass rim sheen
  }
  m.customProgramCacheKey = () => 'cam-glass'; m.needsUpdate = true
}

// Focus rings — MACHINED CONCENTRIC GROOVES: alternating shiny ridges / matte valleys stacked
// along the lens axis (world -Z), so the ridges catch fine highlights.
export function applyCamRing(m) {
  if (!m.isMeshStandardMaterial) return
  // Base props from the GLB (M_CamMetal = chrome-silver in camera_prop.blend). Detail-only below.
  m.onBeforeCompile = (sh) => { _camVary(sh)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;')
      // gentle concentric grooves — low frequency to avoid aliasing/stippling on the small ring
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float grv = abs(sin(vCamP.z * 90.0)); roughnessFactor = clamp(0.30 + 0.28 * grv, 0.28, 0.62); }`)
  }
  m.customProgramCacheKey = () => 'cam-ring'; m.needsUpdate = true
}

// Buttons + dials — brighter GUNMETAL with a higher metallic response (crisper highlights).
export function applyCamButton(m) {
  if (!m.isMeshStandardMaterial) return
  // Base props from the GLB (M_CamDial = bright chrome in camera_prop.blend). Detail-only below.
  m.onBeforeCompile = (sh) => { _camVary(sh)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCamP;\nvarying vec3 vCamN;${_CAM_NOISE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float g = nc(vCamP.xy * 700.0) * 0.5 + nc(vCamP.zy * 700.0) * 0.5; roughnessFactor = clamp(roughnessFactor + (g - 0.5) * 0.08, 0.26, 0.42); }`)
  }
  m.customProgramCacheKey = () => 'cam-button'; m.needsUpdate = true
}

// Body leatherette wrap — BLACK matte grained LEATHER (base from GLB M_CamLeather). Fully
// procedural (0 KB): a TRIPLANAR pebbled grain = Voronoi cells (the raised leather pebbles) +
// fine micro-grain, driving tone + roughness + a NORMAL BUMP (screen-space derivative, like the
// fence) so the grain catches light and reads as real leather, not a flat black slab. The grain
// is computed once into `_leaG` and reused (color→roughness→normal all run after it).
export function applyCamLeather(m) {
  if (!m.isMeshStandardMaterial) return
  m.envMapIntensity = 0.5   // base colour is the baked leather image from the GLB
  m.onBeforeCompile = (sh) => { _addImageBump(sh) }   // grain catches light (relief from the image)
  m.customProgramCacheKey = () => 'cam-leather-img'
  m.needsUpdate = true
}

// ── Dark-wood grain for the painted picket fence ────────────────────────────────────
// The downloaded fence ships a flat painted texture; tinting it brown alone reads flat. This
// overlays procedural WOOD GRAIN on the baked albedo: vertical streaks running along the picket
// length (Z), plank-to-plank tone variation, a warm/cool grain shift, roughness variation and a
// faint grain bump so it catches grazing light. Runtime GLSL, 0 KB. Applied to M_OutFencePainted.
export function applyFenceWoodGrain(m) {
  if (!m.isMeshStandardMaterial || m.userData._fw) return
  m.userData._fw = true
  if (m.color) m.color.setRGB(0.22, 0.12, 0.06) // dark brown tint over the baked picket texture
  m.roughness = 0.82
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFP;
        float hf(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nf(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hf(i), b = hf(i + vec2(1,0)), c = hf(i + vec2(0,1)), d = hf(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbf(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nf(p); p *= 2.03; a *= 0.5; } return s; }
        // wood grain: streaks run ALONG the picket length (Z, slow) and vary fast ACROSS width (X)
        float woodF(vec3 P){ return 0.62 * fbf(vec2(P.x * 60.0, P.z * 9.0)) + 0.38 * fbf(vec2(P.x * 140.0, P.z * 20.0)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gw = woodF(vFP);
        float plank = hf(vec2(floor(vFP.x * 7.5), 3.1));      // per-plank tone
        diffuseColor.rgb *= (0.74 + 0.40 * gw);               // grain light/dark streaks
        diffuseColor.rgb *= (0.88 + 0.22 * plank);            // plank-to-plank variation
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 0.92, 0.72), smoothstep(0.5, 0.8, gw) * 0.45); // warm grain highs`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        { float gw = woodF(vFP); roughnessFactor = clamp(0.72 + 0.20 * gw, 0.6, 0.95); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { float gw = woodF(vFP); vec3 b = vec3(dFdx(gw), dFdy(gw), 0.0) * 0.9; normal = normalize(normal - b); }`)
    _addSunKiss(shader)   // same warm sun-facing glow as the tree/house so the fence matches
  }
  m.customProgramCacheKey = () => 'fence-wood'
  m.needsUpdate = true
}
