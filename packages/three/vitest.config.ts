import { defineConfig } from 'vitest/config';

// Resolve @vecto-ui/core to its source so tests run against the monorepo source.
export default defineConfig({
  resolve: {
    alias: {
      '@vecto-ui/core': new URL('../core/src/index.ts', import.meta.url).pathname,
    },
  },
});
