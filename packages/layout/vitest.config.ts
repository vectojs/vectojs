import { defineConfig } from 'vitest/config';

// Resolve @vectojs/text to its source so tests run without a built dist or a
// workspace node_modules symlink.
export default defineConfig({
  resolve: {
    alias: {
      '@vectojs/text': new URL('../text/src/index.ts', import.meta.url).pathname,
    },
  },
});
