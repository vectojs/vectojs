import { buildBenchmark } from '../_shared/build';

await buildBenchmark({
  benchRoot: new URL('.', import.meta.url).pathname,
  title: 'vectojs retained Markdown stream',
  external: process.argv.includes('--external'),
});
