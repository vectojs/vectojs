// Bundles entry.ts with @vectojs/* resolved to workspace SOURCE and writes
// page/index.html. All of the actual work lives in ../_shared/build.ts.
import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs graph3d integrated frame bench',
  external: process.argv.includes('--external'),
});
