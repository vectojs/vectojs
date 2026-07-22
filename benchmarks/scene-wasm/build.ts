// Bundle entry.ts (full @vectojs/core resolved to workspace SOURCE, so it
// reflects the current G1 changes rather than the published dist) and inline it
// into page/index.html; copy the built wasm into page/. Run before ../run-browsers.sh.
//   bun run benchmarks/scene-wasm/build.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = resolve(HERE, '../../packages');
const WASM = join(PKGS, 'core/src/wasm/vectojs_core.wasm');

if (!existsSync(WASM)) {
  console.error(`Missing ${WASM} — run crates/vectojs-core-rs/build.sh first.`);
  process.exit(1);
}

const out = await Bun.build({
  entrypoints: [join(HERE, 'entry.ts')],
  target: 'browser',
  minify: true,
  plugins: [
    {
      name: 'vecto-src',
      setup(b) {
        b.onResolve({ filter: /^@vectojs\/(core|text|layout|math|animation)$/ }, (a) => ({
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

const js = await out.outputs[0].text();
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>vectojs scene-wasm bench</title>
  </head>
  <body>
    <script type="module">${js}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
copyFileSync(WASM, join(HERE, 'page', 'vectojs_core.wasm'));
console.log('built page/index.html (inline) + page/vectojs_core.wasm');
