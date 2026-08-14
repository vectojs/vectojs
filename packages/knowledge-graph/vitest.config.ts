import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/graph3d': new URL('../graph3d/src/index.ts', import.meta.url).pathname,
    },
  },
});
