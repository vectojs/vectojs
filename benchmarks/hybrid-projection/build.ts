// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts.
//
//   bun run benchmarks/hybrid-projection/build.ts [--external]
//
// `--external` emits benchmark.js plus a source map instead of inlining, which a
// performance profile needs to attribute frames to real files.
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs hybrid content projection bench',
  external: process.argv.includes('--external'),
});
