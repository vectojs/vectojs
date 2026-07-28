/**
 * The one benchmark bundler, shared by every benchmark directory.
 *
 * This replaced 17 near-identical `build.ts` files: each was 55 lines of which 47
 * were the same, differing only in a comment and an HTML `<title>`. That is enough
 * duplication that a fix to the workspace-source resolution had to be applied
 * everywhere to actually hold. The eight wasm benchmarks keep their own build,
 * because they additionally copy a `.wasm` artifact into `page/` and that is real
 * logic rather than boilerplate.
 *
 * The `@vectojs/*` → workspace `src/` resolution is the point of the plugin: a
 * benchmark must measure the source in this checkout, not a published build, or it
 * cannot answer whether a change in this branch helped.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PKGS = resolve(new URL('../..', import.meta.url).pathname, 'packages');

export interface BuildBenchmarkOptions {
  /** Benchmark directory, absolute or relative to `benchmarks/`. */
  benchRoot: string;
  /** Title for the generated document. Defaults to the directory name. */
  title?: string;
  /** Entry file inside the benchmark directory. Defaults to `entry.ts`. */
  entry?: string;
  /**
   * Emit the bundle as a separate file with an external source map instead of
   * inlining it into the HTML.
   *
   * Inlining puts the whole bundle in `<script type="module">`, which makes a
   * Chrome performance profile or a Gecko profile attribute everything to
   * `(index):1` with no mapping back to `Scene.ts` or `entry.ts`. Measurement runs
   * do not care; a profiling run is unreadable without it.
   */
  external?: boolean;
}

function sourcePlugin() {
  return {
    name: 'vecto-src',
    setup(b: {
      onResolve(opts: { filter: RegExp }, cb: (a: { path: string }) => { path: string }): void;
    }) {
      // Subpath exports first: `@vectojs/devtools/headless` must resolve to
      // `devtools/src/headless.ts`, not to `devtools/headless/src/index.ts`. The
      // bare-name rule below would mangle it, and the per-benchmark builds this
      // replaced each carried their own hand-written rule for it.
      b.onResolve({ filter: /^@vectojs\/[a-z0-9-]+\/[a-z0-9/-]+$/ }, (a) => {
        const [, pkg, ...rest] = a.path.split('/');
        return { path: join(PKGS, pkg!, 'src', `${rest.join('/')}.ts`) };
      });
      b.onResolve(
        { filter: /^@vectojs\/(core|text|layout|math|animation|ui|markdown|three|devtools)$/ },
        (a) => ({
          path: join(PKGS, a.path.replace('@vectojs/', ''), 'src/index.ts'),
        }),
      );

      // `marked` is a dependency of @vectojs/markdown, not of benchmarks/, so a
      // bare specifier does not resolve from here. Benchmarks that time the lexer
      // import it directly, hence the explicit resolution.
      b.onResolve({ filter: /^marked$/ }, () => ({
        path: Bun.resolveSync('marked', join(PKGS, 'markdown')),
      }));
    },
  };
}

function document(title: string, script: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    ${script}
  </body>
</html>
`;
}

/** Bundle a benchmark's entry and write its `page/index.html`. */
export async function buildBenchmark(options: BuildBenchmarkOptions): Promise<void> {
  const benchRoot = resolve(
    options.benchRoot.startsWith('/')
      ? options.benchRoot
      : join(new URL('..', import.meta.url).pathname, options.benchRoot),
  );
  const name = benchRoot.split('/').filter(Boolean).pop() ?? 'benchmark';
  const entry = join(benchRoot, options.entry ?? 'entry.ts');
  if (!existsSync(entry)) throw new Error(`no entry at ${entry}`);
  const pageRoot = join(benchRoot, 'page');
  const title = options.title ?? `vectojs ${name} bench`;

  if (options.external) {
    const out = await Bun.build({
      entrypoints: [entry],
      outdir: pageRoot,
      target: 'browser',
      minify: true,
      sourcemap: 'external',
      naming: 'benchmark.[ext]',
      plugins: [sourcePlugin()] as never,
    });
    if (!out.success) throw new Error('bundle failed:\n' + out.logs.map(String).join('\n'));
    await Bun.write(
      join(pageRoot, 'index.html'),
      document(title, '<script type="module" src="./benchmark.js"></script>'),
    );
    console.log('built page/index.html + benchmark.js (external, source-mapped)');
    return;
  }

  const out = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: true,
    plugins: [sourcePlugin()] as never,
  });
  if (!out.success) throw new Error('bundle failed:\n' + out.logs.map(String).join('\n'));
  const js = await out.outputs[0]!.text();
  await Bun.write(
    join(pageRoot, 'index.html'),
    document(title, `<script type="module">${js}</script>`),
  );
  console.log('built page/index.html (inline)');
}

/** CLI: `bun run benchmarks/_shared/build.ts <bench-dir> [--external]`. */
if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: build.ts <bench-dir> [--external]');
    process.exit(1);
  }
  try {
    await buildBenchmark({
      benchRoot: resolve(process.cwd(), dir),
      external: process.argv.includes('--external'),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
