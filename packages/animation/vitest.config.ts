import { defineConfig } from 'vitest/config';

// Resolve @vectojs/math to its source so tests run without a built dist or a
// workspace node_modules symlink.
export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/math': new URL('../math/src/index.ts', import.meta.url).pathname,
    },
  },
});
