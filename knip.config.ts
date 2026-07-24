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
    'packages/markdown': {
      // MarkdownWorker.ts is the source of truth compiled into the generated
      // MarkdownWorkerSource.ts by scripts/build-worker.js at build time — the
      // only reference is a runtime path knip cannot trace.
      entry: ['src/index.{js,ts}', 'src/MarkdownWorker.ts'],
      project: ['src/**/*.{js,ts}'],
    },
    'packages/video-exporter': {
      entry: ['demo/main.ts'],
      project: ['src/**/*.ts', 'demo/**/*.ts'],
    },
  },
  // playwright is used from the global install by the benchmark/comparison scripts
  // (not a dep). oxfmt is NOT listed: knip traces it through the `format` /
  // `format:check` root scripts, so ignoring it is redundant and knip flags the
  // stale entry ("Remove from ignoreDependencies").
  ignoreDependencies: ['playwright'],
  ignoreBinaries: ['readlink', 'which', 'vite'],
};

export default config;
