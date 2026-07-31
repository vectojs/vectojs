/**
 * Paragraph-image repaint gate.
 *
 * A paragraph image decodes asynchronously. `paragraphImage`'s `onLoad` used to
 * call `markDirty()` only when the bitmap reported a non-zero intrinsic size,
 * so a source that loads successfully while reporting zero left an `onDemand`
 * scene unnotified — it repaints only when marked, so nothing it changed at
 * decode time was ever drawn. The display-math sibling had already been written
 * the correct way, with a comment naming this exact hazard; the two call sites
 * disagreed.
 *
 * The one source shape that reaches the failing branch was found by
 * measurement, not assumption: an `<svg width="0" height="0">` fires `onload`
 * with `naturalWidth === 0` on both engines. A dimensionless SVG does *not* —
 * no-`width`/`height`, `viewBox`-only, and `width="100%"` all fall back to the
 * CSS default 300x150 and pass. A cross-origin raster does not either. A broken
 * source reports zero but settles as `error`, so `onLoad` never runs at all.
 *
 * First consumer of `e2e/_shared/browsers.ts`.
 *
 * Run with `bun run test:e2e` in packages/markdown.
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';
import type {
  ParagraphImageBrowserResult,
  ParagraphImageCaseResult,
} from './paragraph-image-repaint.fixture';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A normal raster: 80x60, solid green, so its ink is arithmetic. */
const SIZED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60">' +
  '<rect width="80" height="60" fill="#00c000"/></svg>';

/**
 * The only shape that fires `onload` with a zero intrinsic dimension. Verified
 * on both engines; every other "sizeless" SVG falls back to 300x150.
 */
const ZERO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>';

/**
 * Fixed delay for the image response. A `data:` URI decodes ~synchronously, so
 * it lands before the first paint and leaves no transition to observe. This is
 * a constant rather than a request parameter so no request data reaches a timer
 * (CodeQL `js/resource-exhaustion`).
 */
const IMAGE_DELAY_MS = 400;

function isResult(value: unknown): value is ParagraphImageBrowserResult {
  if (typeof value !== 'object' || value === null) return false;
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) return false;
  return cases.every((entry: unknown) => {
    const record = entry as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      typeof record.marksFromDecode === 'number' &&
      typeof record.loaded === 'boolean' &&
      typeof record.naturalWidth === 'number' &&
      typeof record.width === 'number' &&
      typeof record.ink === 'number' &&
      typeof record.inkBelow === 'number'
    );
  });
}

function caseByName(result: ParagraphImageBrowserResult, name: string): ParagraphImageCaseResult {
  const found = result.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture reported no case named ${name}`);
  return found;
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 640, height: 500, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 30_000 });

    const failure = await page.evaluate('window.__paragraphImageError');
    if (failure) throw new Error(`${browserCase.name}: ${String(failure)}`);

    const raw = await page.evaluate('window.__paragraphImageResult');
    assert.ok(isResult(raw), `${browserCase.name} returned an unexpected result shape`);
    const result = raw;

    assert.deepEqual(
      pageErrors,
      [],
      `${browserCase.name} raised page errors: ${pageErrors.join('; ')}`,
    );

    const sized = caseByName(result, 'sized');
    const zero = caseByName(result, 'zeroSized');

    // The control strip must be empty first: if it has ink, the sample region is
    // wrong and every positive count below is meaningless.
    assert.equal(
      sized.inkBelow,
      0,
      `${browserCase.name}: the strip below the image box must be empty, got ${sized.inkBelow}`,
    );

    // Guards the guard: if the zero-sized source stopped reporting zero, this
    // case would silently stop exercising the branch under test.
    assert.equal(
      zero.naturalWidth,
      0,
      `${browserCase.name}: the zero-sized source must report naturalWidth 0 to exercise the ` +
        `failing branch, got ${zero.naturalWidth}`,
    );
    assert.ok(
      zero.loaded,
      `${browserCase.name}: the zero-sized source must LOAD (not error), otherwise onLoad never runs`,
    );

    // The defect and the fix. Before the fix this was 0 for the zero-sized arm
    // on both engines, while the control was 1.
    assert.equal(
      zero.marksFromDecode,
      1,
      `${browserCase.name}: a paragraph image that loads with a zero intrinsic size must still ` +
        `mark the scene dirty, got ${zero.marksFromDecode} markDirty calls from its decode`,
    );
    assert.equal(
      sized.marksFromDecode,
      1,
      `${browserCase.name}: the normal raster must mark the scene dirty exactly once, got ` +
        `${sized.marksFromDecode}`,
    );

    // The control still corrects its box and paints, so the fix did not regress
    // the path that already worked.
    assert.equal(
      sized.naturalWidth,
      80,
      `${browserCase.name}: control raster intrinsic width should be 80, got ${sized.naturalWidth}`,
    );
    assert.equal(
      sized.width,
      80,
      `${browserCase.name}: control box must be corrected to its intrinsic 80, got ${sized.width}`,
    );
    assert.ok(
      sized.ink > 0,
      `${browserCase.name}: the control image must paint real pixels, got ${sized.ink}`,
    );

    console.log(
      `  ✓ ${browserCase.name}: sized ${sized.width}x${sized.height} ink=${sized.ink} marks=${sized.marksFromDecode}; ` +
        `zeroSized nw=${zero.naturalWidth} box=${zero.width}x${zero.height} marks=${zero.marksFromDecode}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/paragraph-image-repaint.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const script = fixture.outputFiles[0].text;

  const markup =
    '<!doctype html><meta charset="utf-8"><title>paragraph image repaint</title>' +
    '<body style="margin:0;background:#000"><script type="module" src="/fixture.mjs"></script></body>';

  const server = createServer((request, response) => {
    const requestUrl = request.url ?? '/';
    if (requestUrl === '/' || requestUrl.startsWith('/index.html')) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(markup);
      return;
    }
    if (requestUrl.startsWith('/fixture.mjs')) {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(script);
      return;
    }
    if (requestUrl.startsWith('/img')) {
      const body = requestUrl.includes('kind=zero') ? ZERO_SVG : SIZED_SVG;
      setTimeout(() => {
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          // Without this the second case is served from cache and arrives
          // already decoded, which erases the race being tested.
          'cache-control': 'no-store',
        });
        response.end(body);
      }, IMAGE_DELAY_MS);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  const url = `http://127.0.0.1:${address.port}/`;

  try {
    for (const browserCase of bothEngines()) {
      await verifyCase(browserCase, url);
    }
    console.log('\nparagraph image repaint e2e: all checks passed on both engines');
  } finally {
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
