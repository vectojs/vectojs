// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts.
//
//   bun run benchmarks/per-primitive-paths/build.ts [--external]
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs per-primitive path audit bench',
  external: process.argv.includes('--external'),
});
