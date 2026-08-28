import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs markdown adversarial corpus — incrementalLex',
  external: process.argv.includes('--external'),
});
