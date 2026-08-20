import { defineConfig } from 'vitest/config';

const pkgSrc = (name: string) => new URL(`../${name}/src/index.ts`, import.meta.url).pathname;

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@vectojs/core': pkgSrc('core'),
      '@vectojs/ui': pkgSrc('ui'),
      '@vectojs/layout': pkgSrc('layout'),
      '@vectojs/text': pkgSrc('text'),
      '@vectojs/math': pkgSrc('math'),
      '@vectojs/animation': pkgSrc('animation'),
    },
  },
});
