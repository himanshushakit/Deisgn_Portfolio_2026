import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base` is read from VITE_BASE so the repo name is never hardcoded here — the deploy workflow
// passes `/<repo-name>/` (derived from the repository itself, so renaming the repo can't break the
// build), and anything else — local dev, `vite preview`, a future custom domain — falls back to '/'.
// A GitHub Pages PROJECT site serves from https://<user>.github.io/<repo>/, so without this every
// bundled asset URL would point at the domain root and 404. Runtime string literals for files in
// public/ are a separate problem that `base` cannot solve; see src/utils/assets.js.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: { port: 5173, open: true },
})
