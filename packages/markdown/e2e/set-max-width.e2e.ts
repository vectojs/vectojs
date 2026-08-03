/**
 * `Markdown.setMaxWidth` gate, on both engines.
 *
 * `Text` and `RichText` both had a `setMaxWidth`; `Markdown`, which composes them,
 * did not, and assigning `maxWidth` changed nothing because the width is read when
 * each block is *built*. The only workaround was a full rebuild, and a real
 * consumer had written one — `vectojs-gallery`'s chat Creation released its stream,
 * replayed every revealed character through `setContent`, built a **new** writer
 * because the old one was bound to discarded blocks, and carried its scroll offset
 * by hand, on every resize frame.
 *
 * So geometry alone is not the assertion: a rebuild produces correct geometry too.
 * This asserts the things that distinguish a reflow from a rebuild —
 *
 *  1. the same entity instances survive (identity tokens, not counts),
 *  2. an open stream writer stays `open` and keeps appending afterwards,
 *  3. the lexer consumes **no** additional source characters,
 *
 * — alongside the projected selection geometry actually re-wrapping, which is what
 * a reader sees.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/** Mirrors `WidthProbe` in the fixture. */
interface Probe {
  maxWidth: number;
  documentWidth: number;
  documentHeight: number;
  childIds: number[];
  childWidths: Array<number | null>;
  projectedLines: number;
  widestLine: number;
  streamState: string | null;
  text: string;
  sourceCharsLexed: number;
  tokens: number;
}

function isProbe(value: unknown): value is Probe {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Probe).maxWidth === 'number' &&
    Array.isArray((value as Probe).childIds) &&
    typeof (value as Probe).projectedLines === 'number'
  );
}

const WIDE = 520;
const NARROW = 260;

const HEAD =
  '# Streaming document\n\nA first paragraph long enough that it wraps differently at two widths.\n\n';
const TAIL = 'A second paragraph, written after the resize, which must arrive at the new width.\n';

async function read(page: Page): Promise<Probe> {
  const value: unknown = await page.evaluate(() =>
    (window as unknown as { __widthProbe(): unknown }).__widthProbe(),
  );
  assert.ok(isProbe(value), `probe returned ${JSON.stringify(value)}`);
  return value;
}

/** One rendered frame, so the projection is rebuilt before it is read. */
async function frame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 640, height: 480, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

    // Stream the head of the document, leaving the writer open.
    await page.evaluate(() => (window as unknown as { __openStream(): void }).__openStream());
    await page.evaluate(
      (chunk: string) => (window as unknown as { __write(c: string): void }).__write(chunk),
      HEAD,
    );
    await frame(page);
    const wide = await read(page);
    assert.equal(wide.maxWidth, WIDE, `${browserCase.name}: fixture did not start at ${WIDE}`);
    assert.equal(wide.streamState, 'open', `${browserCase.name}: stream not open before resize`);
    assert.ok(
      wide.childIds.length >= 2,
      `${browserCase.name}: expected at least a heading and a paragraph, got ${wide.childIds.length}`,
    );
    assert.ok(
      wide.projectedLines > 0,
      `${browserCase.name}: nothing projected, so the reflow assertion would be vacuous`,
    );

    // The resize, mid-stream.
    await page.evaluate(
      (width: number) =>
        (window as unknown as { __setMaxWidth(w: number): void }).__setMaxWidth(width),
      NARROW,
    );
    await frame(page);
    const narrow = await read(page);

    // 1. It is a reflow, not a rebuild: the same instances are still there.
    assert.deepEqual(
      narrow.childIds,
      wide.childIds,
      `${browserCase.name}: child identities changed ${JSON.stringify(wide.childIds)} -> ${JSON.stringify(narrow.childIds)}, so blocks were rebuilt`,
    );

    // 2. The open writer survived. `setContent` aborts it; this must not.
    assert.equal(
      narrow.streamState,
      'open',
      `${browserCase.name}: stream state became ${narrow.streamState} across the resize`,
    );

    // 3. No re-lexing. This is the cost the gallery workaround paid on every
    //    resize frame, and the number that proves it is gone.
    assert.equal(
      narrow.sourceCharsLexed,
      wide.sourceCharsLexed,
      `${browserCase.name}: lexer consumed ${narrow.sourceCharsLexed - wide.sourceCharsLexed} more characters across a pure width change`,
    );
    assert.equal(narrow.tokens, wide.tokens, `${browserCase.name}: token count changed on resize`);

    // 4. It actually re-wrapped, measured on the public selection geometry.
    assert.equal(narrow.maxWidth, NARROW);
    assert.ok(
      narrow.widestLine <= NARROW,
      `${browserCase.name}: widest projected line ${narrow.widestLine.toFixed(1)} exceeds the ${NARROW} wrap width`,
    );
    assert.ok(
      narrow.projectedLines > wide.projectedLines,
      `${browserCase.name}: projected lines ${wide.projectedLines} -> ${narrow.projectedLines}; a narrower width must produce more`,
    );
    assert.ok(
      narrow.documentHeight > wide.documentHeight,
      `${browserCase.name}: document height ${wide.documentHeight} -> ${narrow.documentHeight}; more lines must be taller`,
    );
    for (const [index, width] of narrow.childWidths.entries()) {
      if (width === null) continue;
      assert.ok(
        width <= NARROW,
        `${browserCase.name}: child ${index} still wraps at ${width} after a resize to ${NARROW}`,
      );
    }

    // 5. Streaming continues into the resized document, at the new width.
    await page.evaluate(
      (chunk: string) => (window as unknown as { __write(c: string): void }).__write(chunk),
      TAIL,
    );
    await page.evaluate(async () => {
      await (window as unknown as { __close(): Promise<void> }).__close();
    });
    await frame(page);
    const closed = await read(page);

    assert.ok(
      closed.text.includes('written after the resize'),
      `${browserCase.name}: text appended after the resize is missing`,
    );
    assert.ok(
      closed.text.includes('wraps differently'),
      `${browserCase.name}: text written before the resize was lost`,
    );
    assert.ok(
      closed.childIds.length > narrow.childIds.length,
      `${browserCase.name}: the appended paragraph produced no new block`,
    );
    // The prefix is still the same instances: appending after a resize must not
    // rebuild what the resize just reflowed.
    assert.deepEqual(
      closed.childIds.slice(0, narrow.childIds.length),
      narrow.childIds,
      `${browserCase.name}: appending after the resize rebuilt earlier blocks`,
    );
    for (const [index, width] of closed.childWidths.entries()) {
      if (width === null) continue;
      assert.ok(
        width <= NARROW,
        `${browserCase.name}: child ${index} built after the resize wraps at ${width}, not ${NARROW}`,
      );
    }

    // Round trip: widening restores the original line count on the same instances.
    await page.evaluate(
      (width: number) =>
        (window as unknown as { __setMaxWidth(w: number): void }).__setMaxWidth(width),
      WIDE,
    );
    await frame(page);
    const rewidened = await read(page);
    assert.deepEqual(
      rewidened.childIds,
      closed.childIds,
      `${browserCase.name}: widening rebuilt blocks`,
    );
    assert.ok(
      rewidened.projectedLines < closed.projectedLines,
      `${browserCase.name}: widening did not reduce line count (${closed.projectedLines} -> ${rewidened.projectedLines})`,
    );

    assert.deepEqual(pageErrors, []);
    console.log(
      `✓ ${browserCase.name}: ${WIDE}px ${wide.projectedLines} lines h=${wide.documentHeight} -> ${NARROW}px ${narrow.projectedLines} lines h=${narrow.documentHeight} (widest ${narrow.widestLine.toFixed(1)}), same ${narrow.childIds.length} instances, stream open, 0 extra chars lexed`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/set-max-width.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the setMaxWidth browser fixture');

  const markup =
    '<!doctype html><html><body style="margin:0;background:#0f172a">' +
    '<canvas width="640" height="480"></canvas>' +
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
