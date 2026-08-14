import { defineConfig } from 'vitest/config';

const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/desktop': pkgSrc('desktop'),
      '@vectojs/ui': pkgSrc('ui'),
      '@vectojs/styles': pkgSrc('styles'),
      '@vectojs/core': pkgSrc('core'),
      '@vectojs/layout': pkgSrc('layout'),
      '@vectojs/text': pkgSrc('text'),
      '@vectojs/math': pkgSrc('math'),
      '@vectojs/animation': pkgSrc('animation'),
    },
  },
});
