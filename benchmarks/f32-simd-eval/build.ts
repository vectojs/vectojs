// Bundle entry.ts -> inline page/index.html + copy the wasm. Mirrors
// benchmarks/core-wasm/build.ts (same @core alias + inline-to-dodge-MIME trick).
//   bun run benchmarks/f32-simd-eval/build.ts
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_WASM_DIR = resolve(HERE, '../../packages/core/src/wasm');
const WASM = join(CORE_WASM_DIR, 'vectojs_core.wasm');

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
      name: 'core-wasm-alias',
      setup(b) {
        b.onResolve({ filter: /^@core\// }, (a) => ({
          path: join(CORE_WASM_DIR, a.path.replace(/^@core\//, '') + '.ts'),
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
    <title>vectojs f32-simd-eval bench</title>
  </head>
  <body>
    <script type="module">${js}</script>
  </body>
</html>
`;
await Bun.write(join(HERE, 'page', 'index.html'), html);
copyFileSync(WASM, join(HERE, 'page', 'vectojs_core.wasm'));
console.log('built page/index.html (inline) + page/vectojs_core.wasm');
