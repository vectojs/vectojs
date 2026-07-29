import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs markdown-stream-controller',
  external: process.argv.includes('--external'),
});
