// Bundle entry.ts (with @vectojs/* resolved to workspace SOURCE, so it reflects
// the current Scene.syncContentProjection gate) and inline it into
// page/index.html. Run before ../run-browsers.sh markdown-stream-transfer <port>.
//   bun run benchmarks/markdown-stream-transfer/build.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, '../../packages');

const out = await Bun.build({
  entrypoints: [join(HERE, 'entry.ts')],
  target: 'browser',
  minify: true,
  plugins: [
    {
      name: 'vecto-src',
      setup(b) {
        b.onResolve(
          {
            filter: /^@vectojs\/(core|text|layout|math|animation|ui|markdown)$/,
          },
          (a) => ({
            path: join(PKGS, a.path.replace('@vectojs/', ''), 'src/index.ts'),
          }),
        );
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
    <title>vectojs markdown-stream-transfer gate bench</title>
  </head>
  <body>
    <script type="module">${js}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
console.log('built page/index.html (inline)');
