import { defineConfig } from 'vitest/config';

// Resolve @vectojs/core (and the engines it re-exports) to source so tests run
// without a built dist or a workspace node_modules symlink (mirrors
// apps/demo/vite.config.ts).
const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@vectojs/core': pkgSrc('core'),
      '@vectojs/layout': pkgSrc('layout'),
      '@vectojs/text': pkgSrc('text'),
      '@vectojs/math': pkgSrc('math'),
      '@vectojs/animation': pkgSrc('animation'),
    },
  },
});
