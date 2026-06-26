/**
 * Vecto-UI rendering benchmark driver.
 *
 * Bundles the demo `bench.ts` entry with Bun.build (resolving `@vecto-ui/core`
 * to its TS source), serves it from an in-process Bun.serve, opens it in a
 * headless Chrome (via the globally-installed Playwright + the system
 * google-chrome-stable, with frame-rate limiting disabled), renders N entities
 * for several N, and reports per-frame render cost.
 *
 * The in-process server (no spawned Vite/Node child) keeps the run to a single
 * heavy subprocess — the browser — so it stays within sandboxed/CI process and
 * memory limits where a separate dev-server child would be killed.
 *
 * Usage:  bun run scripts/benchmark.ts [--n=1000,10000,100000] [--frames=120]
 * Output: a markdown table on stdout + JSON at scripts/.bench-results.json
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ENTRY = resolve(HERE, '../apps/demo/src/bench.ts');
const CORE_SRC = resolve(HERE, '../packages/core/src/index.ts');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as const;
  }),
);
const COUNTS = (args.get('n') ?? '1000,10000,100000').split(',').map(Number);
const FRAMES = Number(args.get('frames') ?? 120);
const WORLD = args.get('world') ?? '1';
const RENDER = args.get('render') ?? 'always';
const BATCH = args.get('batch') ?? '0';
const BACKEND = args.get('backend') ?? 'canvas';
const SHAPE = args.get('shape') ?? 'circle';
// `--uncapped` removes the browser's vsync cap to read true sub-16 ms per-frame
// cost (the methodology behind the README table). It pegs a CPU core, so it can
// trip sandbox/CI process watchdogs — off by default; the capped run still tells
// you whether N sustains 60 fps.
const UNCAPPED = Boolean(args.get('uncapped'));

function loadPlaywright() {
  const pkgDir = dirname(execSync('readlink -f "$(which playwright)"').toString().trim());
  const require = createRequire(join(pkgDir, 'package.json'));
  return require(pkgDir) as typeof import('playwright');
}

function chromePath(): string {
  return execSync('readlink -f "$(which google-chrome-stable)"').toString().trim();
}

/** Bundle `bench.ts` to a self-contained browser script (core resolved to source). */
async function buildBench(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [BENCH_ENTRY],
    target: 'browser',
    minify: true,
    plugins: [
      {
        name: 'vecto-core-src',
        setup(b) {
          b.onResolve({ filter: /^@vecto-ui\/core$/ }, () => ({ path: CORE_SRC }));
        },
      },
    ],
  });
  if (!out.success) {
    throw new Error('bench bundle failed:\n' + out.logs.map(String).join('\n'));
  }
  return out.outputs[0].text();
}

type BenchResult = {
  n: number;
  frames: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxFps: number;
  sustains60: boolean;
  glActive?: boolean;
};

async function main() {
  console.log('Bundling bench entry…');
  const js = await buildBench();
  const html =
    '<!doctype html><html><head><meta charset="utf-8"></head>' +
    `<body><div id="app"></div><script type="module">${js}</script></body></html>`;

  const server = Bun.serve({
    port: 0, // ephemeral; bench.ts reads its params from the URL query string
    fetch: () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const base = server.url.origin;
  console.log(`Serving bench at ${base}`);

  const { chromium } = loadPlaywright();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const results: BenchResult[] = [];

  try {
    console.log('Launching headless Chrome…');
    // By default rendering runs under the browser's normal vsync cap (~60 Hz): a
    // frame that fits the budget reports ~16.6 ms ("comfortably ≥60 fps") rather
    // than its true sub-16 ms cost, while a frame that *exceeds* the budget reports
    // its real interval — enough to answer "does N sustain 60 fps". Pass
    // `--uncapped` to read true sub-16 ms cost (pegs a CPU core; see UNCAPPED).
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        ...(UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
      ],
    });

    for (const n of COUNTS) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(
        `${base}/?n=${n}&frames=${FRAMES}&world=${WORLD}&render=${RENDER}&batch=${BATCH}&backend=${BACKEND}&shape=${SHAPE}`,
        {
          waitUntil: 'load',
        },
      );
      await page.waitForFunction(
        () => (window as { __BENCH_DONE__?: boolean }).__BENCH_DONE__,
        null,
        {
          timeout: 120_000,
        },
      );
      const r = (await page.evaluate(
        () => (window as { __BENCH__?: BenchResult }).__BENCH__,
      )) as BenchResult;
      results.push(r);
      console.log(
        `n=${String(n).padStart(7)}  mean=${r.meanMs.toFixed(2)}ms  p95=${r.p95Ms.toFixed(2)}ms  maxFps=${r.maxFps}  60fps=${r.sustains60 ? 'yes' : 'no'}  gl=${r.glActive ? 'on' : 'off'}`,
      );
      await page.close();
    }
  } finally {
    await browser?.close();
    server.stop(true);
  }

  const table = [
    '| Entities | mean ms/frame | p50 | p95 | max FPS | sustains 60fps |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.n.toLocaleString()} | ${r.meanMs} | ${r.p50Ms} | ${r.p95Ms} | ${r.maxFps} | ${r.sustains60 ? 'yes' : 'no'} |`,
    ),
  ].join('\n');

  console.log('\n' + table + '\n');
  writeFileSync(join(HERE, '.bench-results.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote ${join(HERE, '.bench-results.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
