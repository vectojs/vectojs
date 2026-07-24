// Bundle a selection-harness surface into a self-contained page for drive.sh.
//   bun build.ts <surface.ts> [out-dir]
// Aliases @vectojs/* to this repo's package src so the harness runs against the
// working tree. Inlines the JS into index.html to dodge module MIME issues.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..'); // scripts/selection-harness -> repo root
const PKGS = resolve(REPO, 'packages');
const aliasPkgs = ['core', 'ui', 'layout', 'text', 'math', 'animation', 'markdown', 'devtools'];

const surface = process.argv[2] ?? join(HERE, 'surfaces', 'text-surfaces.ts');
const outDir = resolve(process.argv[3] ?? join(HERE, 'page'));

const out = await Bun.build({
  entrypoints: [resolve(surface)],
  target: 'browser',
  minify: true,
  plugins: [
    {
      name: 'vectojs-alias',
      setup(b) {
        b.onResolve({ filter: /^@vectojs\// }, (a) => {
          const pkg = a.path.replace(/^@vectojs\//, '');
          return aliasPkgs.includes(pkg) ? { path: join(PKGS, pkg, 'src', 'index.ts') } : undefined;
        });
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
<html><head><meta charset="utf-8" /><title>selection-harness</title>
<style>html,body{margin:0;background:#0f172a;}canvas{display:block;}</style></head>
<body><canvas id="c" width="700" height="360"></canvas>
<script type="module">${js}</script></body></html>
`;
await Bun.write(join(outDir, 'index.html'), html);
console.log(`built ${outDir}/index.html from ${surface}`);
