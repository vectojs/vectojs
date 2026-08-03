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
  ],
});
if (!out.success) {
  console.error('bundle failed:\n' + out.logs.map(String).join('\n'));
  process.exit(1);
}

const js = await out.outputs[0]!.text();
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>vectojs stream-markdown-smd gate bench</title>
  </head>
  <body>
    <script type="module">${js}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
console.log('built page/index.html (inline)');
