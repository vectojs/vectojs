// Bundles entry.ts with @vectojs/* and `marked` resolved to workspace SOURCE and
// writes page/index.html. All of the actual work lives in ../_shared/build.ts.
//
//   bun run benchmarks/markdown-stream-math/build.ts [--external]
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs markdown streaming math lex bench',
  external: process.argv.includes('--external'),
});
