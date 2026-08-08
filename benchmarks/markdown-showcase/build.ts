// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts.
//
//   bun run benchmarks/markdown-showcase/build.ts [--external]
//
// This is not a measurement page — see entry.ts. It is a visual showcase and the
// capture target for capture-showcase.ts, and it reuses the benchmark bundler
// only because that bundler is what resolves `@vectojs/*` to this checkout's
// `src/`, which is the property a screenshot gate needs: a baseline has to be an
// image of THIS branch, not of a published build.
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs markdown construct showcase',
  external: process.argv.includes('--external'),
});
