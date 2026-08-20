import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/core': new URL('../core/src/index.ts', import.meta.url).pathname,
      '@vectojs/ui': new URL('../ui/src/index.ts', import.meta.url).pathname,
      '@vectojs/animation': new URL('../animation/src/index.ts', import.meta.url).pathname,
      '@vectojs/math': new URL('../math/src/index.ts', import.meta.url).pathname,
      '@vectojs/text': new URL('../text/src/index.ts', import.meta.url).pathname,
      '@vectojs/layout': new URL('../layout/src/index.ts', import.meta.url).pathname,
    },
  },
});
