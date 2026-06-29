import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    layout: 'src/layout/index.ts',
    renderer: 'src/renderer/index.ts',
    text: 'src/text/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: true,
  external: ['@vecto-ui/core'],
});
