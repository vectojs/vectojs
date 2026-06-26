/**
 * Vecto-UI rendering benchmark driver.
 *
 * Spins up the demo Vite dev server, opens `bench.html` in a headless Chrome
 * (via the globally-installed Playwright + the system google-chrome-stable, with
 * frame-rate limiting disabled), renders N entities for several N, and reports
 * per-frame render cost.
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
const DEMO_DIR = resolve(HERE, '../apps/demo');
const PORT = 5199;

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

function loadPlaywright() {
  const pkgDir = dirname(execSync('readlink -f "$(which playwright)"').toString().trim());
  const require = createRequire(join(pkgDir, 'package.json'));
  return require(pkgDir) as typeof import('playwright');
}

function chromePath(): string {
  return execSync('readlink -f "$(which google-chrome-stable)"').toString().trim();
}

async function waitForServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Vite dev server did not start within ${timeoutMs}ms`);
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
  console.log('Starting Vite dev server…');
  const vite = Bun.spawn(['bun', 'run', 'dev', '--port', String(PORT), '--strictPort'], {
    cwd: DEMO_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const base = `http://localhost:${PORT}`;
  const { chromium } = loadPlaywright();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const results: BenchResult[] = [];

  try {
    await waitForServer(`${base}/bench.html`);
    console.log('Launching headless Chrome…');
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: [
        '--no-sandbox',
        '--disable-frame-rate-limit',
        '--disable-gpu-vsync',
        '--disable-background-timer-throttling',
      ],
    });

    for (const n of COUNTS) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(
        `${base}/bench.html?n=${n}&frames=${FRAMES}&world=${WORLD}&render=${RENDER}&batch=${BATCH}&backend=${BACKEND}`,
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
    vite.kill();
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
