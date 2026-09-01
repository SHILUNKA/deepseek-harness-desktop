import { defineConfig } from 'tsdown'

/**
 * The desktop app ships one entry: the Electron main process referenced by
 * package.json `main`. The root tsdown builds only `lib/types/index.js`, so
 * this override points at `lib/types/main.js` instead; its reachable modules
 * bundle with it. `electron` stays external — the runtime injects it, and
 * bundling it would replace that injection with a broken copy.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
})
