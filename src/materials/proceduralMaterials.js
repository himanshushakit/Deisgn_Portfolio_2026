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

// ── Procedural stucco/troweled-plaster wall ─────────────────────────────────────────
// Warm sandy-beige plaster: fine granular grain (sprayed tooth) over a slow low-freq
// mottle (uneven hand application) + a cheap screen-space bump so the tooth catches sun.
export function applyStuccoWall(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.78, 0.68, 0.57) // light creamy plaster (linear); shader mottles it
  m.roughness = 0.96
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBump = { value: 1.9 }
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
        // FINE sprayed-plaster tooth: a dense high-freq speckle (the "pop"), contrast-pushed
        // so each grain reads as a distinct pit, layered over mid + coarse structure.
        float speckle(vec2 p){ float n = vnoise(p * 230.0); return n * n; }   // sharp dense dots
        float tooth(vec2 p){ return 0.50 * speckle(p) + 0.30 * fbm(p * 90.0) + 0.20 * fbm(p * 34.0); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 wuv = vWallPos.xy;                 // back wall lies in the XY plane
        float grain = tooth(wuv);
        float mott  = fbm(wuv * 3.2);           // slow troweled unevenness
        diffuseColor.rgb *= (0.84 + 0.26 * grain);   // fine granular light/shade (subtle on the pale wall)
        diffuseColor.rgb *= (0.94 + 0.12 * mott);    // large hand-applied patches
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.03, 1.00, 0.96), grain); // gently warm the high spots
        // Contact shadow (ambient occlusion) where the desk meets the wall: darken the wall
        // just above the desk's back edge (Y=0.85), fading up, only across the desk width.
        float aoBand = 1.0 - smoothstep(0.85, 1.06, vWallPos.y);      // strong at the desk line, fades up
        float aoX = smoothstep(1.18, 1.0, abs(vWallPos.x));           // only behind the desk (|x| < ~1.1)
        diffuseColor.rgb *= mix(1.0, 0.66, aoBand * aoX);             // subtle crevice darkening`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float hgt = tooth(vWallPos.xy);
          vec3 bmp = vec3(dFdx(hgt), dFdy(hgt), 0.0) * uBump;
          normal = normalize(normal - bmp);       // strong fine tooth bump -> each grain catches the sun
        }`)
  }
  m.customProgramCacheKey = () => 'stucco-wall'
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
  m.roughness = 0.72
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBumpW = { value: 0.45 }
    shader.uniforms.uMode = { value: mode }
    shader.uniforms.uCtr = { value: new THREE.Vector2(cx, cy) }
    shader.uniforms.uHalf = { value: new THREE.Vector2(hw, hh) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWoodPos;
        uniform float uBumpW; uniform float uMode; uniform vec2 uCtr; uniform vec2 uHalf;
        float hw(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nw(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hw(i), b = hw(i + vec2(1,0)), c = hw(i + vec2(0,1)), d = hw(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbmw(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nw(p); p *= 2.03; a *= 0.5; } return s; }
        // FINE grain. grainV = vertical streaks (fast in X); grainH = horizontal (fast in Y).
        float grainV(vec2 wp){ return 0.6 * fbmw(vec2(wp.x * 78.0, wp.y * 8.0)) + 0.4 * fbmw(vec2(wp.x * 175.0, wp.y * 18.0)); }
        float grainH(vec2 wp){ return 0.6 * fbmw(vec2(wp.x * 8.0, wp.y * 78.0)) + 0.4 * fbmw(vec2(wp.x * 18.0, wp.y * 175.0)); }
        float woodGrain(vec2 wp){
          if (uMode < 0.5) return grainV(wp);
          if (uMode < 1.5) return grainH(wp);
          vec2 nrm = (wp - uCtr) / max(uHalf, vec2(1e-3));     // auto (ring): pick by which edge
          float t = smoothstep(-0.15, 0.15, abs(nrm.y) - abs(nrm.x)); // near top/bottom -> horizontal
          return mix(grainV(wp), grainH(wp), t);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gWood = woodGrain(vWoodPos.xy);
        float weather = fbmw(vWoodPos.xy * 2.6);              // broad patchy whitewash
        diffuseColor.rgb *= (0.93 + 0.08 * gWood);            // very subtle grain light/dark
        float line = smoothstep(0.30, 0.62, gWood);           // grain valleys -> faint tint lines
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.95, 0.92, 0.87), diffuseColor.rgb, line); // faint wood tone showing through
        diffuseColor.rgb *= (0.97 + 0.05 * weather);          // gentle uneven paint thickness`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 bmp = vec3(dFdx(gWood), dFdy(gWood), 0.0) * uBumpW;
          normal = normalize(normal - bmp);                   // faint grain relief
        }`)
  }
  m.customProgramCacheKey = () => 'whitewash-wood'
  m.needsUpdate = true
}

// ── Procedural rustic fence-plank wood ──────────────────────────────────────────────
// Weathered vertical pickets: per-plank tone variation, vertical grain, dark seams,
// occasional knots + weathering streaks + a grain bump. World-space (X across planks,
// Z up the grain) so it tiles across the whole fence.
export function applyFenceWood(m) {
  if (!m.isMeshStandardMaterial) return
  if (m.color) m.color.setRGB(0.30, 0.19, 0.11) // warm weathered brown (linear); shader varies it
  m.roughness = 0.92
  m.metalness = 0.0
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPlankW = { value: 0.105 }  // physical picket pitch (measured)
    shader.uniforms.uPlankOff = { value: -3.243 } // first picket start X -> cell seams fall in the gaps
    shader.uniforms.uCover = { value: 0.81 }     // board width / pitch (0.085/0.105)
    shader.uniforms.uBumpF = { value: 0.9 }
    shader.uniforms.uLineCount = { value: 6.0 }  // dark grain lines per board
    shader.uniforms.uLineStr = { value: 0.72 }   // how dark the grain lines get
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFencePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFencePos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFencePos;
        uniform float uPlankW; uniform float uPlankOff; uniform float uCover; uniform float uBumpF;
        uniform float uLineCount; uniform float uLineStr;
        float hf1(float n){ return fract(sin(n * 127.1) * 43758.5453); }
        float hf2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 34.56); return fract(p.x * p.y); }
        float nf(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = hf2(i), b = hf2(i + vec2(1,0)), c = hf2(i + vec2(0,1)), d = hf2(i + vec2(1,1));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        float fbmf(vec2 p){ float s = 0.0, a = 0.5; for(int k = 0; k < 5; k++){ s += a * nf(p); p *= 2.03; a *= 0.5; } return s; }
        // returns grain value in .x, and the per-fragment brightness multiplier composited in the color chunk
        float fenceGrain(vec3 wp, out float edge, out vec3 tone, out float line){
          float t = (wp.x - uPlankOff) / uPlankW;   // aligned to the physical pickets
          float pid = floor(t);
          float fx = fract(t);                       // board surface occupies 0..uCover
          float r1 = hf1(pid), r2 = hf1(pid + 37.0), gph = r1 * 12.0;
          float fu = fx / uCover;                    // 0..1 across the board itself
          // soft base grain (stretched along Z)
          float g = 0.60 * fbmf(vec2(fu * 9.0 + gph, wp.z * 1.5)) + 0.40 * fbmf(vec2(fu * 24.0 + gph, wp.z * 3.6));
          // ── DARK vertical grain lines: a set of wandering lines running up the board ──
          float warp = fbmf(vec2(fu * 4.0 + gph, wp.z * 0.6)) * 0.20;   // gentle wander (not ruler-straight)
          float lc = (fu + warp) * uLineCount + gph;
          float lf = abs(fract(lc) - 0.5) * 2.0;                        // 0 at a line centre, 1 between
          line = 1.0 - smoothstep(0.0, 0.34, lf);                       // thin dark line
          line *= 0.45 + 0.55 * hf1(floor(lc) * 1.3 + gph);            // each line a different darkness
          line *= smoothstep(0.12, 0.55, fbmf(vec2(floor(lc) * 2.0, wp.z * 2.2))); // break/fade along length
          // per-board tone: lightness + warm-vs-sungreyed (stronger variation)
          float light = 0.72 + 0.52 * r1;
          float greyness = smoothstep(0.5, 0.95, r2);
          tone = mix(vec3(1.10, 0.90, 0.72), vec3(0.94, 0.93, 0.92), greyness) * light;
          // subtle shadow down each board's side edges (depth)
          edge = min(smoothstep(0.0, 0.06, fu), smoothstep(1.0, 0.94, fu));
          // occasional knot: dark ring at a per-board position
          vec2 kc = vec2(0.30 + 0.4 * r2, mix(-0.2, 0.9, hf1(pid + 11.0)));
          float kd = length((vec2(fu, wp.z) - kc) * vec2(1.0, 0.7));
          float knot = (1.0 - smoothstep(0.02, 0.09, kd)) * step(0.55, hf1(pid + 5.0));
          g = mix(g, 0.12, knot * 0.85);
          g = g - line * 0.5;                                           // lines recess into the board (for bump)
          return g;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fEdge; vec3 fTone; float fLine;
        float fG = fenceGrain(vFencePos, fEdge, fTone, fLine);
        diffuseColor.rgb *= fTone;                       // per-board colour variation
        diffuseColor.rgb *= (0.80 + 0.28 * clamp(fG, 0.0, 1.0)); // soft grain light/dark
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.34, 0.24, 0.17), fLine * uLineStr); // DARK brown grain lines
        diffuseColor.rgb *= mix(0.6, 1.0, fEdge);        // subtle side-edge shadow (gaps are real geo)
        float wstreak = fbmf(vec2(fract((vFencePos.x - uPlankOff) / uPlankW) * 4.0, vFencePos.z * 0.8));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.10, 1.06, 1.0), smoothstep(0.62, 0.92, wstreak) * 0.5);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float e; vec3 tn; float ln; float h = fenceGrain(vFencePos, e, tn, ln);
          vec3 bmp = vec3(dFdx(h), dFdy(h), 0.0) * uBumpF;
          normal = normalize(normal - bmp);
        }`)
  }
  m.customProgramCacheKey = () => 'fence-wood'
  m.needsUpdate = true
}

// ── Pleated fabric lampshade ────────────────────────────────────────────────────────
// Classic box-pleat shade: many vertical accordion folds around the cone, built from the
// azimuthal angle about the shade axis (cosine profile). Shades the fabric AND perturbs
// the normal so folds catch real light; the warm emissive glow (when lit) is modulated by
// the same pattern so pleats read while glowing. cx/cz = shade world-space centre (axis).
export function applyPleatedShade(m, cx, cz) {
  if (!m.isMeshStandardMaterial) return
  m.transparent = false
  m.opacity = 1.0
  m.depthWrite = true
  m.roughness = 0.9
  m.metalness = 0.0
  if (m.color) m.color.setRGB(0.93, 0.89, 0.80)      // off-white / warm cream fabric
  if (m.emissive) m.emissive.setRGB(1.0, 0.86, 0.62) // warm glow colour when lit
  m.emissiveIntensity = LAMP_SHADE_GLOW
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShadeCtr = { value: new THREE.Vector2(cx, cz) }
    shader.uniforms.uPleats = { value: 34.0 }      // number of folds around the cone
    shader.uniforms.uPleatDepth = { value: 0.20 }  // SOFT diffuse crease shading (off-state relief)
    shader.uniforms.uGlowDepth = { value: 0.42 }   // stronger crease darkening on the GLOW (on-state read)
    shader.uniforms.uReliefStr = { value: 0.9 }    // normal-bump strength for the folds (gentle)
    shader.uniforms.uGrain = { value: 0.06 }       // fine woven-fabric roughness amount
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
  m.customProgramCacheKey = () => 'pleated-shade'
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
export function applyOutsideVibrance(m, sat = 1.3) {
  if (!m.isMeshStandardMaterial || m.userData._vib) return
  m.userData._vib = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader) => {
    if (prev) prev(shader)
    shader.uniforms.uSat = { value: sat }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSat;')
      .replace('#include <tonemapping_fragment>', `#include <tonemapping_fragment>
        { float _l = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = max(mix(vec3(_l), gl_FragColor.rgb, uSat), 0.0); } // saturate exterior`)
  }
  m.customProgramCacheKey = () => 'outside-vib'
  m.needsUpdate = true
}
