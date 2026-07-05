import { defineConfig } from 'vitest/config';

// Resolve @vectojs/core to its source so tests run without a built dist or a
// workspace node_modules symlink (mirrors apps/demo/vite.config.ts).
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@vectojs/core': new URL('../core/src/index.ts', import.meta.url).pathname,
    },
  },
});
