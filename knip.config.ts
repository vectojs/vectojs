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
  // (not a dep); readlink/which/vite are binaries invoked by project scripts.
  // oxfmt is a CLI formatter invoked directly (never imported), like playwright.
  ignoreDependencies: ['playwright', 'oxfmt'],
  ignoreBinaries: ['readlink', 'which', 'vite'],
};

export default config;
