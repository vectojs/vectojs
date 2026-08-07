import { defineConfig } from 'vitest/config';

// Resolve workspace siblings to source so tests run without built dists
// (mirrors packages/ui/vitest.config.ts).
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@vectojs/core': new URL('../core/src/index.ts', import.meta.url).pathname,
      '@vectojs/layout': new URL('../layout/src/index.ts', import.meta.url).pathname,
      '@vectojs/text': new URL('../text/src/index.ts', import.meta.url).pathname,
      '@vectojs/math': new URL('../math/src/index.ts', import.meta.url).pathname,
      '@vectojs/animation': new URL('../animation/src/index.ts', import.meta.url).pathname,
      '@vectojs/ui': new URL('../ui/src/index.ts', import.meta.url).pathname,
      '@vectojs/markdown': new URL('../markdown/src/index.ts', import.meta.url).pathname,
      // markdown's math path lazily imports @vectojs/tex; because the alias
      // above resolves markdown to source, that import is resolved under *this*
      // config and needs its own entry.
      '@vectojs/tex': new URL('../tex/src/index.ts', import.meta.url).pathname,
      '@vectojs/devtools/headless': new URL('./src/headless.ts', import.meta.url).pathname,
    },
  },
});
