/**
 * Run a benchmark page and print its console output, exceptions, and results.
 *
 * `run-browsers.sh` is the right tool for a measurement run: it drives real
 * Chrome and Firefox on a dedicated Hyprland workspace with the real GPU. But
 * when a page throws, that script gives no diagnosis — the page simply never
 * POSTs, the runner waits out its timeout, and the browser console is
 * unreachable. A silent hang looks exactly like a slow benchmark, which is a bad
 * failure mode to debug through.
 *
 * This is the debug counterpart: headless, single engine, console and
 * `pageerror` forwarded to stdout. Numbers from here are NOT quotable (headless
 * falls back to software raster) — use it only to make a page run, then measure
 * with `run-browsers.sh`.
 *
 *   bun run benchmarks/debug-page.ts <bench-dir> <port> [--timeout 120]
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolved through @vectojs/core's node_modules: puppeteer-core is that
// package's devDependency (it drives the e2e suite), not a benchmarks/ one, so a
// bare specifier does not resolve from here.
import puppeteer from '../packages/core/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const bench = process.argv[2];
const port = process.argv[3];
if (!bench || !port) {
  console.error('usage: bun run benchmarks/debug-page.ts <bench-dir> <port> [--timeout N]');
  process.exit(2);
}
const tIdx = process.argv.indexOf('--timeout');
const timeoutSec = tIdx > 0 ? Number(process.argv[tIdx + 1]) : 120;

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium';

const server = spawn('bun', ['run', 'serve.ts'], {
  cwd: join(HERE, bench),
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d: Buffer) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d: Buffer) => process.stderr.write(`[server!] ${d}`));

const shutdown = () => {
  server.kill('SIGTERM');
};
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

await new Promise((r) => setTimeout(r, 1500));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

let sawError = false;
page.on('console', (msg: { type: () => string; text: () => string }) => {
  const t = msg.type();
  if (t === 'error') sawError = true;
  console.log(`[${t}] ${msg.text().slice(0, 600)}`);
});
page.on('pageerror', (err: Error) => {
  sawError = true;
  console.log(
    `[pageerror] ${err.message}\n${(err.stack ?? '').split('\n').slice(1, 6).join('\n')}`,
  );
});
page.on(
  'requestfailed',
  (req: { url: () => string; failure: () => { errorText: string } | null }) => {
    console.log(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`);
  },
);

console.log(`--- loading http://127.0.0.1:${port}/ (timeout ${timeoutSec}s) ---`);
try {
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
} catch (e) {
  console.log(`[goto failed] ${String(e)}`);
}

// The page closes itself after POSTing results, so waiting for the tab to
// disappear is the completion signal. A timeout here means it never finished.
const done = await Promise.race([
  page
    .waitForFunction('document.querySelector("pre")?.textContent?.includes("userAgent")', {
      timeout: timeoutSec * 1000,
      polling: 500,
    })
    .then(() => 'complete' as const)
    .catch(() => 'timeout' as const),
  new Promise<'closed'>((r) => page.on('close', () => r('closed'))),
]);

console.log(`--- ${done} (errors seen: ${sawError}) ---`);
if (done === 'timeout') {
  // Print whatever partial output the page managed, which usually localises the
  // stall to a specific row of the sweep.
  try {
    const txt = await page.$eval('pre', (el: Element) => el.textContent ?? '');
    console.log(`--- partial output (${txt.length} chars) ---\n${txt.slice(-1500)}`);
  } catch {
    console.log('--- no <pre> content: the page failed before producing any rows ---');
  }
}

await browser.close().catch(() => {});
server.kill('SIGTERM');
process.exit(done === 'complete' ? 0 : 1);
