import { defineConfig } from 'vite';

// Resolve the workspace package to its TypeScript source so the demo (and the
// benchmark page) work in both `vite dev` and `vite build` without relying on a
// pre-built dist/ or a node_modules workspace symlink. This also gives HMR into
// @vecto-ui/core source during development.
export default defineConfig({
  resolve: {
    alias: {
      '@vecto-ui/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
});
