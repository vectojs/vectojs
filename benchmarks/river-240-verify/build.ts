import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'river 240Hz verify — 81k@2000 tok/s',
  external: process.argv.includes('--external'),
});
