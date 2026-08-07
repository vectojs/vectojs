/**
 * Inline-image gate: an image on a line it shares with text must actually paint.
 *
 * A heading and a table cell route their inline content through `collectSpans`,
 * where `Tokens.Image` had no arm and fell to `default:`, which pushes `.text` —
 * so the alt text rendered as ordinary prose and the picture vanished. Nothing
 * threw and nothing was blank, which is why it survived: `# Title ![logo](u)`
 * read as "Title logo".
 *
 * The unit tests cover the arithmetic and the degradation paths. They cannot
 * cover the two things that only a real engine settles:
 *
 * 1. **That a real decode fires and the correction repaints.** jsdom settles
 *    neither `onload` nor `onerror` for any URL shape, so the unit tests force
 *    `naturalWidth` and invoke the handler by hand.
 * 2. **That pixels land inside the reserved box.** Inline math shipped once with a
 *    reservation and no painter: measured, positioned, accessible, and completely
 *    blank. Counting ink is the only assertion that catches that class.
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
import type { InlineImageBrowserResult, InlineImageCaseResult } from './inline-image.fixture';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A deliberately WIDE raster: 4:1, solid green so its ink is arithmetic.
 *
 * The aspect ratio is the point. A square would make the before/after boxes
 * identical and the correction unobservable — which is the same reason the sibling
 * fixture needs a delayed response.
 */
const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20">' +
  '<rect width="80" height="20" fill="#00c000"/></svg>';

/**
 * Fixed delay for the image response, so the first paint happens before the decode
 * and the square-to-aspect transition is observable. A constant rather than a
 * request parameter so no request data reaches a timer (CodeQL
 * `js/resource-exhaustion`).
 */
const IMAGE_DELAY_MS = 400;

function isResult(value: unknown): value is InlineImageBrowserResult {
  if (typeof value !== 'object' || value === null) return false;
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) return false;
  return cases.every((entry: unknown) => {
    const record = entry as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      typeof record.widthBefore === 'number' &&
      typeof record.widthAfter === 'number' &&
      typeof record.paintedPixelsInBox === 'number' &&
      typeof record.alt === 'string' &&
      typeof record.key === 'string' &&
      typeof record.decoded === 'boolean'
    );
  });
}

function caseByName(result: InlineImageBrowserResult, name: string): InlineImageCaseResult {
  const found = result.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture reported no case named ${name}`);
  return found;
}

function verifyOneCase(browserCase: BrowserCase, probe: InlineImageCaseResult): void {
  const where = `${browserCase.name}/${probe.name}`;

  // The instrument first. If the raster never decoded, every geometry assertion
  // below is comparing a square to itself and would pass for the wrong reason.
  assert.ok(probe.decoded, `${where}: the raster must report a real decode`);
  assert.equal(probe.naturalWidth, 80, `${where}: expected natural width 80`);
  assert.equal(probe.naturalHeight, 20, `${where}: expected natural height 20`);

  // The control strip must be empty, or a positive ink count means nothing.
  //
  // Only meaningful for the heading. A table paints its own cell borders and
  // header rule, so the strip below a cell's box legitimately has ink (measured:
  // 426 px) and asserting zero there fails for a reason that has nothing to do
  // with the image. The heading arm is what guards the sampler, and one guarded
  // arm is enough — the two cases share the sampling code.
  if (probe.name === 'heading') {
    assert.equal(
      probe.paintedPixelsBelowBox,
      0,
      `${where}: the strip below the box must be empty, got ${probe.paintedPixelsBelowBox}`,
    );
  }

  // The assertion the whole file exists for.
  assert.ok(
    probe.paintedPixelsInBox > 0,
    `${where}: the image must paint real pixels inside its reserved box, got ${probe.paintedPixelsInBox}`,
  );

  // Square before the decode, 4:1 after it, at an unchanged height — so the line
  // box never moves and only the width settles.
  assert.ok(
    Math.abs(probe.widthBefore - probe.heightBefore) < 0.01,
    `${where}: box before the decode must be square, got ${probe.widthBefore}x${probe.heightBefore}`,
  );
  assert.ok(
    Math.abs(probe.heightAfter - probe.heightBefore) < 0.01,
    `${where}: height must not change across the decode, got ${probe.heightBefore} then ${probe.heightAfter}`,
  );
  assert.ok(
    Math.abs(probe.widthAfter - probe.heightAfter * 4) < 0.5,
    `${where}: width must follow the 4:1 natural aspect, got ${probe.widthAfter} for height ${probe.heightAfter}`,
  );

  // The alt text is the accessible name, and must not also be painted as prose —
  // which is exactly what the defect did.
  assert.equal(probe.alt, 'BADGEALT', `${where}: the object must carry the alt text`);
  assert.ok(!probe.visibleTextHasAlt, `${where}: the alt text must not render as visible prose`);
  assert.ok(probe.accessibleTextHasAlt, `${where}: the alt text must reach the accessible name`);

  // What the object identifies itself as painting, which is what keeps a badge
  // column from drawing its first row's badge in every row.
  assert.ok(probe.key.length > 0, `${where}: the object must carry a paint key`);
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
    await page.waitForFunction('window.__ready === true', { timeout: 60_000 });

    const failure = await page.evaluate('window.__inlineImageError');
    if (failure) throw new Error(`${browserCase.name}: ${String(failure)}`);

    const raw = await page.evaluate('window.__inlineImageResult');
    assert.ok(isResult(raw), `${browserCase.name} returned an unexpected result shape`);

    assert.deepEqual(
      pageErrors,
      [],
      `${browserCase.name} raised page errors: ${pageErrors.join('; ')}`,
    );

    const heading = caseByName(raw, 'heading');
    const cell = caseByName(raw, 'tableCell');
    verifyOneCase(browserCase, heading);
    verifyOneCase(browserCase, cell);

    // A heading is drawn larger than a table cell, so an image following its run
    // must be too. This is what makes the box a function of the run rather than of
    // the document body size.
    assert.ok(
      heading.heightAfter > cell.heightAfter,
      `${browserCase.name}: a heading image must be taller than a table-cell image, got ` +
        `${heading.heightAfter} vs ${cell.heightAfter}`,
    );

    console.log(
      `✓ ${browserCase.name}: heading ${heading.widthBefore.toFixed(1)}²→` +
        `${heading.widthAfter.toFixed(1)}x${heading.heightAfter.toFixed(1)} ink=${heading.paintedPixelsInBox}; ` +
        `cell ${cell.widthBefore.toFixed(1)}²→${cell.widthAfter.toFixed(1)}x${cell.heightAfter.toFixed(1)} ` +
        `ink=${cell.paintedPixelsInBox}`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/inline-image.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const script = fixture.outputFiles[0].text;

  const markup =
    '<!doctype html><meta charset="utf-8"><title>inline image</title>' +
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
      setTimeout(() => {
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          // Without this the second case is served from cache and arrives already
          // decoded, which erases the transition being measured.
          'cache-control': 'no-store',
        });
        response.end(WIDE_SVG);
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
    console.log('\ninline image e2e: all checks passed on both engines');
  } finally {
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
