// Bundle entry.ts (with @vectojs/* resolved to workspace SOURCE) and inline it
// into page/index.html. Run before ../run-browsers.sh layout-flex-canvas-ui <port>.
//   bun run comparisons/layout-flex-canvas-ui/build.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, '../../packages');
// `@canvas-ui/core` is a root devDependency; Bun resolves it from node_modules
// without help. Only @vectojs/* needs source aliasing.
//
// Note: @canvas-ui/core@2.0.0 emits `import { __decorate } from 'tslib'` but does
// NOT declare tslib as a dependency, so the bundle fails to resolve it unless
// tslib is installed explicitly. It is therefore a direct devDependency here.

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
    <title>vectojs layout-flex-canvas-ui gate bench</title>
  </head>
  <body>
    <script type="module">${js}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
console.log('built page/index.html (inline)');
