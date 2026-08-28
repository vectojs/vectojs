// Bundle entry.ts (with @vectojs/* resolved to workspace SOURCE, so it reflects
// the current Scene.syncContentProjection gate) and inline it into
// page/index.html. Run before ../run-browsers.sh stream-markdown-smd <port>.
//   bun run benchmarks/stream-markdown-smd/build.ts
// Also bundles entry-e2e.ts → page/e2e.html when that file exists (CTX-0559:
// chunk→worker→lex→reconcile→shape→layout→render, p50/p95/p99 per stage).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, '../../packages');
// `streaming-markdown` is a root devDependency, so Bun resolves it unaided.
// `marked` is NOT: it is a dependency of packages/markdown, so a bare
// `import 'marked'` from this directory does not resolve. Alias it to the exact
// copy @vectojs/markdown itself loads, so the arm measures the version we ship
// against rather than a second hoisted one.

const plugins: any[] = [
  {
    name: 'vecto-src',
    setup(b: any) {
      b.onResolve({ filter: /^@vectojs\/(core|text|layout|math|animation|ui)$/ }, (a: any) => ({
        path: join(PKGS, a.path.replace('@vectojs/', ''), 'src/index.ts'),
      }));
      b.onResolve({ filter: /^marked$/ }, () => ({
        path: join(PKGS, 'markdown/node_modules/marked/lib/marked.esm.js'),
      }));
    },
  },
  {
    // @ant-design/x-markdown's ES build imports its own stylesheet. The suite
    // measures parse/stream cost, not styling, so CSS becomes an empty module
    // rather than a second bundler pipeline.
    name: 'css-shim',
    setup(b: any) {
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    },
  },
];

async function bundle(entry: string, outName: string, title: string) {
  const entryPath = join(HERE, entry);
  if (!existsSync(entryPath)) {
    console.log(`skip ${entry} (not found)`);
    return;
  }
  const out = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins,
  } as any);
  if (!out.success) {
    console.error(`bundle failed for ${entry}:\n` + (out as any).logs.map(String).join('\n'));
    process.exit(1);
  }
  const js = await (out as any).outputs[0]!.text();
  const safe = js.replaceAll('</script', '<\\/script');
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <script type="module">${safe}</script>
  </body>
</html>
`;
  await Bun.write(join(HERE, 'page', outName), html);
  console.log(`built page/${outName} from ${entry} (inline)`);
}

// Always build the parse-only gate bench.
await bundle('entry.ts', 'index.html', 'vectojs stream-markdown-smd gate bench');
// CTX-0559 e2e pipeline bench: per-stage p50/p95/p99 via performance.measure
await bundle('entry-e2e.ts', 'e2e.html', 'vectojs stream-markdown-smd e2e pipeline bench');
// If --e2e is passed, also make e2e the default index so run-browsers.sh without
// a path change exercises the e2e entry. This keeps the runner's hardcoded
// "/" URL working for the requested comparison.
if (process.argv.includes('--e2e')) {
  const { readFileSync } = await import('node:fs');
  const e2eHtml = readFileSync(join(HERE, 'page', 'e2e.html'), 'utf8');
  await Bun.write(join(HERE, 'page', 'index.html'), e2eHtml);
  console.log('overwrote page/index.html with e2e build (--e2e flag)');
}
