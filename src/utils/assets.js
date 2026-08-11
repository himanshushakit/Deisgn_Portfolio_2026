// ============================================================================
// PUBLIC ASSET URLs  —  base-path aware (required for GitHub Pages).
// ----------------------------------------------------------------------------
// Everything in public/ used to be referenced with a hardcoded leading slash ('/scene.glb',
// '/sky/backdrop_night.webp', '/draco/', …). That works when the site is served from a domain
// root, and breaks completely on a GitHub Pages PROJECT site, which serves from a subpath like
// https://<user>.github.io/<repo>/ — '/scene.glb' resolves to the domain root and 404s.
//
// Vite's `base` option does NOT fix this on its own: it rewrites asset URLs in index.html and in
// anything reached through an `import`, but it cannot rewrite a STRING LITERAL inside JS. The GLB,
// the Draco decoder, the sky photos, the project thumbnails, the stickers, the poster art and the
// rain video are all string literals handed to loaders at runtime, so each one has to be resolved
// against the base explicitly. That is what `asset()` is for.
//
// `import.meta.env.BASE_URL` is what Vite injects for the configured base — '/' during local dev
// and for a custom domain, '/<repo>/' for a project Pages site (the deploy workflow passes
// VITE_BASE, see .github/workflows/deploy-pages.yml). It always has a trailing slash, so the
// leading slash is stripped from the path to avoid producing '//'.
// ============================================================================

export const BASE_URL = import.meta.env.BASE_URL || '/'

// asset('scene.glb?v=196') -> '/scene.glb?v=196' in dev, '/<repo>/scene.glb?v=196' on Pages.
// Accepts paths with or without a leading slash so existing call sites read naturally.
export const asset = (path) => `${BASE_URL}${String(path).replace(/^\/+/, '')}`

// The Draco decoder directory passed to useGLTF — same base problem, and it must keep its trailing
// slash because three's DRACOLoader concatenates the wasm/js filenames straight onto it.
export const DRACO_PATH = asset('draco/')
