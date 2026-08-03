/**
 * Code-block glyph atlas DPR gate, on both engines.
 *
 * The code grid blits from a shared `GlyphRasterAtlas` whose slots are device
 * pixels at a fixed ratio. That atlas used to be a module-level singleton
 * capturing `devicePixelRatio` at first use with no rebuild path, so a browser
 * zoom left it rasterized at the old ratio while the DPR-scaled context resampled
 * every blit — measured in Firefox 153 on one live page, 100% → 133% moved the
 * renderer 1.579 → 2.068 while the atlas stayed 1.579, and peak edge contrast
 * inside the code block fell 171 → 139 → 73 across 100/133/500% while prose held
 * 255. Only code went soft, which is why it read as a font bug.
 *
 * This asserts both halves, at three ratios, **without reloading the page** —
 * a reload would build a fresh atlas at the new ratio and pass trivially, which
 * is precisely the case that was never broken:
 *
 *  1. `blitScale === 1`, the mechanism.
 *  2. Code contrast holds within 10% of its first-ratio value, the symptom, with
 *     prose measured alongside as a control arm.
 *
 * Headless is adequate here because both engines rasterize text on the CPU and
 * the assertion is a *ratio between states of the same page*, not an absolute
 * quality figure. Quotable per-frame numbers still come from
 * `benchmarks/run-browsers.sh`.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/** Mirrors `CodeAtlasProbe` in the fixture. */
interface Probe {
  sceneDpr: number;
  atlasDpr: number | null;
  blitScale: number | null;
  atlasResets: number | null;
  atlasSlots: number | null;
  codeContrast: number;
  proseContrast: number;
  backingWidth: number;
}

function isProbe(value: unknown): value is Probe {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Probe).sceneDpr === 'number' &&
    typeof (value as Probe).codeContrast === 'number' &&
    typeof (value as Probe).proseContrast === 'number' &&
    typeof (value as Probe).backingWidth === 'number'
  );
}

const VIEWPORT = { width: 640, height: 480 };
/** 100%, 133% and 500% of this host's base ratio, the states the defect was measured at. */
const RATIOS = [1.579, 2.068, 4.286];

/**
 * Wait for a rendered frame, not merely for rAF ticks.
 *
 * An idle `always`-mode scene auto-throttles to **2 FPS**, so a "wait three rAF
 * callbacks" helper returns inside 50 ms having rendered nothing — measured: the
 * code block's render count stayed at 2 across a whole DPR change, which read
 * exactly like the atlas ignoring the change. This polls the fixture's own render
 * counter instead, which is the only signal that a repaint actually happened.
 */
async function settle(page: Page): Promise<void> {
  const before = await page.evaluate(() =>
    (window as unknown as { __codeRenderCount(): number }).__codeRenderCount(),
  );
  await page.waitForFunction(
    (baseline: number) =>
      (window as unknown as { __codeRenderCount(): number }).__codeRenderCount() > baseline,
    { timeout: 10_000, polling: 'raf' },
    before,
  );
}

async function read(page: Page): Promise<Probe> {
  const value: unknown = await page.evaluate(() =>
    (window as unknown as { __codeAtlasProbe(): unknown }).__codeAtlasProbe(),
  );
  assert.ok(isProbe(value), `probe returned ${JSON.stringify(value)}`);
  return value;
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { ...VIEWPORT, deviceScaleFactor: RATIOS[0] },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });
    await settle(page);

    const samples: Probe[] = [];
    for (const [index, ratio] of RATIOS.entries()) {
      if (index > 0) {
        // The live DPR change. No reload: the atlas must follow a zoom on a page
        // that is already running, which is what the singleton could not do.
        await page.setViewport({ ...VIEWPORT, deviceScaleFactor: ratio });
        // Then reallocate the backing store, exactly as `Scene`'s own
        // `(resolution: Ndppx)` watcher does — it calls `resize(width, height)`.
        //
        // Driven explicitly because the *trigger* is not reproducible in this
        // harness on every engine: measured with a standalone probe, a
        // `setViewport` DPR change fires that media query in headed Chrome,
        // headless Firefox and headed Firefox, but **never in headless Chrome**,
        // which is what CI runs. Waiting on it would make this gate silently
        // vacuous on one engine. What is under test here is the atlas following
        // the renderer's applied ratio; `Scene`'s media-query wiring is its own
        // concern and predates this.
        await page.evaluate(() => (window as unknown as { __resizeScene(): void }).__resizeScene());
        await settle(page);
      }
      const sample = await read(page);
      samples.push(sample);

      assert.ok(
        Math.abs(sample.sceneDpr - ratio) < 0.01,
        `${browserCase.name} at ${ratio}: renderer reports ${sample.sceneDpr}`,
      );
      assert.ok(
        sample.atlasSlots !== null && sample.atlasSlots > 0,
        `${browserCase.name} at ${ratio}: atlas has no slots, so the blit path never ran`,
      );
      assert.ok(
        sample.blitScale !== null && Math.abs(sample.blitScale - 1) < 0.001,
        `${browserCase.name} at ${ratio}: blitScale ${sample.blitScale} (atlas ${sample.atlasDpr} vs renderer ${sample.sceneDpr}) — a resampled blit`,
      );
      assert.ok(
        sample.codeContrast > 0,
        `${browserCase.name} at ${ratio}: code region has no ink (${sample.codeContrast})`,
      );
    }

    // The symptom. Contrast is compared against the first ratio rather than to an
    // absolute floor, because the absolute value is font- and engine-dependent
    // while the *collapse* under a resampled blit is what the defect was.
    const baseline = samples[0].codeContrast;
    for (const [index, sample] of samples.entries()) {
      const ratio = sample.codeContrast / baseline;
      assert.ok(
        ratio >= 0.9,
        `${browserCase.name} at DPR ${RATIOS[index]}: code contrast ${sample.codeContrast.toFixed(1)} is ${((1 - ratio) * 100).toFixed(1)}% below the ${baseline.toFixed(1)} measured at DPR ${RATIOS[0]}`,
      );
    }

    assert.deepEqual(pageErrors, []);
    const summary = samples
      .map(
        (s, i) =>
          `dpr ${RATIOS[i]}→atlas ${s.atlasDpr} blit ${s.blitScale?.toFixed(3)} code ${s.codeContrast.toFixed(1)} prose ${s.proseContrast.toFixed(1)} resets ${s.atlasResets}`,
      )
      .join(' | ');
    console.log(`✓ ${browserCase.name}: ${summary}`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/code-atlas-dpr.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the code-atlas browser fixture');

  // The page background is what the fixture composites transparent samples over,
  // so it must match `PAGE_BG` there or every contrast reading is against the
  // wrong backdrop.
  const markup =
    '<!doctype html><html><body style="margin:0;background:#0f172a">' +
    `<canvas width="${VIEWPORT.width}" height="${VIEWPORT.height}"></canvas>` +
    '<script type="module" src="/fixture.mjs"></script></body></html>';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(markup);
      return;
    }
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fixtureSource);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    for (const browserCase of bothEngines()) await verifyCase(browserCase, url);
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
