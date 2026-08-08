// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts.
//
//   bun run benchmarks/richtext-width-relayout/build.ts [--external]
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs richtext width-only relayout bench',
  external: process.argv.includes('--external'),
});
