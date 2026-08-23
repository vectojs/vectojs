// Bundle entry.ts (with @vectojs/* resolved to workspace SOURCE, so it reflects
// the current Scene.syncContentProjection gate) and inline it into
// page/index.html. Run before ../run-browsers.sh stream-markdown-smd <port>.
//   bun run benchmarks/stream-markdown-smd/build.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, '../../packages');
// `streaming-markdown` is a root devDependency, so Bun resolves it unaided.
// `marked` is NOT: it is a dependency of packages/markdown, so a bare
// `import 'marked'` from this directory does not resolve. Alias it to the exact
// copy @vectojs/markdown itself loads, so the arm measures the version we ship
// against rather than a second hoisted one.

const out = await Bun.build({
  entrypoints: [join(HERE, 'entry.ts')],
  target: 'browser',
  minify: true,
  // react-dom reads this at module scope to pick its production code paths; a
  // bundle without the define runs React's dev build (slower, warning-spewing).
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [
    {
      name: 'vecto-src',
      setup(b) {
        b.onResolve({ filter: /^@vectojs\/(core|text|layout|math|animation|ui)$/ }, (a) => ({
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
      setup(b) {
        b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
      },
    },
  ],
});
if (!out.success) {
  console.error('bundle failed:\n' + out.logs.map(String).join('\n'));
  process.exit(1);
}

const js = await out.outputs[0]!.text();
// dompurify ships the literal string "<script></script>", whose closing tag
// would terminate an INLINE module early and take the whole page down with a
// bare SyntaxError. Escaping the slash keeps the string byte-identical at
// runtime while making it safe to inline.
const safe = js.replaceAll('</script', '<\\/script');
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>vectojs stream-markdown-smd gate bench</title>
  </head>
  <body>
    <script type="module">${safe}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
console.log('built page/index.html (inline)');
