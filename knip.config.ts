import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      // Headless QA entries run via `bun run`: benchmark/comparison drivers and
      // the bench page they build.
      entry: ['scripts/*.ts', 'benchmarks/*.ts'],
      project: ['scripts/**/*.{js,ts}', 'benchmarks/**/*.{js,ts}'],
    },
    'packages/*': {
      entry: ['src/index.{js,ts}'],
      project: ['src/**/*.{js,ts}'],
    },
  },
  // playwright is used from the global install by the benchmark/comparison scripts
  // (not a dep); readlink/which/vite are binaries invoked there.
  ignoreDependencies: ['playwright'],
  ignoreBinaries: ['readlink', 'which', 'vite'],
};

export default config;
