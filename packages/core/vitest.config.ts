import { defineConfig } from 'vitest/config';

// Resolve the extracted @vectojs/* engines to their source so tests run without
// built dists or workspace node_modules symlinks.
const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/layout': pkgSrc('layout'),
      '@vectojs/text': pkgSrc('text'),
      '@vectojs/math': pkgSrc('math'),
      '@vectojs/animation': pkgSrc('animation'),
    },
  },
});
