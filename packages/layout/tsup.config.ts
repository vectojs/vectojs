import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  splitting: true,
  external: ['@vectojs/text'],
});
