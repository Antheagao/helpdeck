import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))

// The widget ships as one self-mounting IIFE bundle: a site embeds it with a
// single <script src="widget.js" defer> tag, no module loader required.
export default defineConfig({
  root: here,
  plugins: [react()],
  // React reads process.env.NODE_ENV, which does not exist in a browser; without
  // this the bundle ships React's development branches (bigger and slower).
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.join(here, 'src', 'main.tsx'),
      name: 'Helpdeck',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
})
