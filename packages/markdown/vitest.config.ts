import { defineConfig } from 'vitest/config';

// Resolve @vectojs/* workspace siblings to source so tests run without built
// dists (mirrors packages/ui/vitest.config.ts).
const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/ui': pkgSrc('ui'),
      '@vectojs/core': pkgSrc('core'),
      '@vectojs/layout': pkgSrc('layout'),
      '@vectojs/text': pkgSrc('text'),
      '@vectojs/math': pkgSrc('math'),
      '@vectojs/animation': pkgSrc('animation'),
    },
  },
});
