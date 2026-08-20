import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs hero production scheduler bench',
  external: process.argv.includes('--external'),
});
