import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    layout: 'src/layout/index.ts',
    renderer: 'src/renderer/index.ts',
    text: 'src/text/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  splitting: true,
  external: [
    '@vectojs/core',
    '@vectojs/layout',
    '@vectojs/text',
    '@vectojs/math',
    '@vectojs/animation',
  ],
});
