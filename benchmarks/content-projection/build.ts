// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts — this file
// was 55 lines of which 47 were identical across 24 benchmarks.
//
//   bun run benchmarks/content-projection/build.ts [--external]
//
// `--external` emits benchmark.js plus a source map instead of inlining, which a
// performance profile needs to attribute frames to real files.
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs content-projection gate bench',
  external: process.argv.includes('--external'),
});
