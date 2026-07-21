import { defineConfig } from 'vitest/config';

// Resolve @vectojs/core (and the engines it re-exports) to source so tests run
// against the monorepo source without any built dists.
const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
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
