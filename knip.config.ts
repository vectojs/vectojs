import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: [],
      project: ['**/*.{js,ts}'],
    },
    'packages/*': {
      entry: ['src/index.{js,ts}'],
      project: ['src/**/*.{js,ts}'],
    },
    'apps/*': {
      // src/main.ts is the demo router; src/bench.ts is the benchmark entry (bench.html).
      entry: ['src/main.{js,ts}', 'src/bench.ts'],
      project: ['**/*.{js,ts}'],
    },
  },
  // playwright is used from the global install by scripts/benchmark.ts (not a dep);
  // readlink/which are system binaries invoked there.
  ignoreDependencies: ['playwright'],
  ignoreBinaries: ['readlink', 'which'],
};

export default config;
