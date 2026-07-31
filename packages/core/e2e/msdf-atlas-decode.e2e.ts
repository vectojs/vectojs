/**
 * MSDF atlas-decode end-to-end ink gate.
 *
 * `WebGLPointRenderer.setMSDFTexture` caches the atlas on source **identity**
 * with no decode guard, so an `HTMLImageElement` that had not finished decoding
 * was uploaded once as an empty texture, recorded as current, and never
 * re-uploaded. The atlas then decoded and nothing sampled it: layout,
 * hit-testing, and the a11y projection all correct, the text invisible forever.
 * `MSDFTextEntityOptions.texture` is caller-supplied and there is no loader
 * helper, so the obvious `const img = new Image(); img.src = url;` hit it every
 * time.
 *
 * Fixing the upload was only half of it. Because the correct upload has to
 * happen on a LATER frame, something must schedule that frame — and measured on
 * both engines, neither render mode did: `onDemand` skips idle frames, and
 * `always` throttles to 2 FPS when idle, so recovery was down to whether a
 * throttled tick happened to land after the decode. `MSDFTextEntity` now
 * subscribes to the atlas's `load`.
 *
 * No unit test in this repo can see any of this: no package runs a real canvas
 * (`packages/ui/test/setup.ts` stubs `getContext('2d')` with no-ops) and there
 * is no WebGL context, so the only instrument is a real browser counting real
 * pixels. Same defect class as CTX-0152's invisible inline math and CTX-0153's
 * blank SVG box.
 *
 * Run with `bun run test:e2e` in packages/core. Executable resolution:
 * PUPPETEER_EXECUTABLE_PATH → /usr/bin/chromium → /usr/bin/google-chrome, and
 * FIREFOX_EXECUTABLE_PATH → /usr/bin/firefox.
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { type BrowserCase, bothEngines, closeServer } from './_shared/browsers';
import type { MsdfCaseResult, MsdfDecodeBrowserResult } from './msdf-atlas-decode.fixture';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ATLAS_SIZE = 64;
const ATLAS_CELL = 32;

/**
 * Build the atlas PNG here rather than committing a binary fixture: it is a
 * solid-white 32×32 block in a 64×64 transparent image, which the MSDF shader
 * reads as `median(1,1,1) - 0.5 > 0` — fully opaque ink — so the expected pixel
 * count is arithmetic instead of a magic number tied to a checked-in file.
 */
function buildAtlasPng(): Buffer {
  const raw = Buffer.alloc((ATLAS_SIZE * 4 + 1) * ATLAS_SIZE);
  let offset = 0;
  for (let y = 0; y < ATLAS_SIZE; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < ATLAS_SIZE; x++) {
      const on = x < ATLAS_CELL && y < ATLAS_CELL ? 255 : 0;
      raw[offset++] = on;
      raw[offset++] = on;
      raw[offset++] = on;
      raw[offset++] = on;
    }
  }

  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ATLAS_SIZE, 0);
  ihdr.writeUInt32BE(ATLAS_SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ATLAS_PNG = buildAtlasPng();

/**
 * The only atlas latencies the fixture ever asks for, keyed by their literal
 * query value. Serving a delay from this map keeps request data out of the
 * `setTimeout` duration entirely.
 */
const ATLAS_DELAYS_MS = new Map<string, number>([
  ['0', 0],
  ['300', 300],
]);

function isResult(value: unknown): value is MsdfDecodeBrowserResult {
  if (typeof value !== 'object' || value === null) return false;
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) return false;
  return cases.every((entry: unknown) => {
    const record = entry as Record<string, unknown>;
    return (
      typeof record.name === 'string' &&
      typeof record.ink === 'number' &&
      typeof record.inkBelow === 'number' &&
      typeof record.uploads === 'number'
    );
  });
}

function caseByName(result: MsdfDecodeBrowserResult, name: string): MsdfCaseResult {
  const found = result.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`Fixture did not report a case named ${name}`);
  return found;
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<boolean> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 640, height: 900, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 60_000 });

    const fixtureError: unknown = await page.evaluate(() => window.__msdfDecodeError);
    assert.equal(fixtureError, undefined, `${browserCase.name} fixture failed: ${fixtureError}`);

    const result: unknown = await page.evaluate(() => window.__msdfDecodeResult);
    assert.ok(isResult(result), `${browserCase.name} returned an invalid result`);

    // WebGL2 unavailable (headless Firefox on a bare CI runner): `Scene` fell
    // back to Canvas2D, so there is no GL layer and nothing here is measurable.
    // Skip rather than fail — the fallback is documented behaviour — and report
    // it so a silently-degraded run is visible in the log.
    if (result.cases.every((entry) => entry.skipped)) {
      console.log(`  - ${browserCase.name}: no WebGL2, MSDF GL path not exercised (skipped)`);
      return false;
    }
    assert.ok(
      result.cases.every((entry) => !entry.skipped),
      `${browserCase.name}: WebGL2 was available for some cases but not others, which makes the comparison meaningless`,
    );

    // Sampling sanity first: ink in the control strip means the sample region is
    // wrong, which would make every positive count below meaningless.
    for (const entry of result.cases) {
      assert.equal(
        entry.inkBelow,
        0,
        `${browserCase.name}/${entry.name}: control strip must be empty, got ${entry.inkBelow}`,
      );
    }

    // The control has no decode state, so it isolates "WebGL MSDF text paints at
    // all" from "a latent atlas is handled". If this fails the rest is noise.
    const control = caseByName(result, 'canvasControl');
    assert.ok(
      control.ink > 0,
      `${browserCase.name}: a canvas atlas must paint (WebGL MSDF text is broken outright)`,
    );
    assert.equal(control.uploads, 1, `${browserCase.name}: the control uploads its atlas once`);

    for (const name of ['networkAlways', 'networkOnDemand'] as const) {
      const entry = caseByName(result, name);
      // Guard the guard: if the atlas had already decoded by the first render,
      // this case never exercised the race and its pass proves nothing.
      // Guard the guard: if the atlas had already decoded by the first glyph
      // submit, this case never exercised the race and its pass proves nothing.
      assert.equal(
        entry.completeAtFirstRender,
        false,
        `${browserCase.name}/${name}: the atlas must still be decoding at the first render, or this case tests nothing`,
      );
      // No empty commit: with the atlas still decoding, nothing may have been
      // uploaded. A single upload here is the original bug — it would be the
      // 0x0 texture that the identity cache then pins forever.
      assert.equal(
        entry.uploadsBeforeRepaint,
        0,
        `${browserCase.name}/${name}: an undecoded atlas must not be uploaded at all, got ${entry.uploadsBeforeRepaint} uploads`,
      );
      // The repaint hook's contract, asserted directly rather than through a
      // rendered frame: headless rAF is throttled to ~2 ticks in 550 ms, so
      // whether a frame lands after the decode is luck, and a frame-based
      // assertion passes with the hook deleted. Being dirty is not luck.
      assert.equal(
        entry.dirtyBeforeDecode,
        false,
        `${browserCase.name}/${name}: the scene must be clean while the atlas is still decoding, or dirtyAfterDecode proves nothing`,
      );
      assert.equal(
        entry.dirtyAfterDecode,
        true,
        `${browserCase.name}/${name}: the atlas finishing its decode must mark the scene dirty, otherwise nothing ever schedules the frame that uploads it`,
      );
      assert.ok(
        entry.uploads >= 1,
        `${browserCase.name}/${name}: the atlas must be uploaded once a frame runs after the decode, got ${entry.uploads}`,
      );
      assert.ok(
        entry.ink > 0,
        `${browserCase.name}/${name}: MSDF text whose atlas decoded late must be visible, not a permanently blank box`,
      );
      assert.equal(
        entry.ink,
        control.ink,
        `${browserCase.name}/${name}: late-decoded atlas must paint the same pixels as the control, got ${entry.ink} vs ${control.ink}`,
      );
    }

    assert.deepEqual(
      pageErrors,
      [],
      `${browserCase.name} raised page errors: ${pageErrors.join(' | ')}`,
    );
    const summary = result.cases
      .map(
        (entry) =>
          `${entry.name} ink=${entry.ink} up=${entry.uploads} pre=${entry.uploadsBeforeRepaint} dirty=${entry.dirtyBeforeDecode}->${entry.dirtyAfterDecode} c1st=${entry.completeAtFirstRender}`,
      )
      .join(', ');
    console.log(`  ✓ ${browserCase.name}: ${summary}`);
    return true;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/msdf-atlas-decode.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });

  const entrySource = fixture.outputFiles[0]?.text;
  if (!entrySource) throw new Error('Failed to bundle the msdf-atlas-decode fixture');

  const markup =
    '<!doctype html><html><body style="margin:0"><script type="module" src="/fixture.mjs"></script></body></html>';
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(markup);
      return;
    }
    if (pathname === '/fixture.mjs') {
      response.setHeader('content-type', 'text/javascript');
      response.end(entrySource);
      return;
    }
    if (pathname === '/atlas.png') {
      // Latency is the whole point: it must exceed the layout-worker round-trip
      // so the entity's first render sees an undecoded image.
      //
      // The delay is picked from a fixed allowlist rather than computed from the
      // query value. Clamping the parsed number would be equally safe in
      // practice, but it still carries request data into a timer duration, which
      // CodeQL flags as `js/resource-exhaustion` — and rightly in shape, even
      // for a loopback test server. An allowlist removes the data flow instead
      // of arguing about its bounds.
      const requested = requestUrl.searchParams.get('delay') ?? '0';
      const delay = ATLAS_DELAYS_MS.has(requested) ? (ATLAS_DELAYS_MS.get(requested) as number) : 0;
      setTimeout(() => {
        response.setHeader('content-type', 'image/png');
        response.setHeader('cache-control', 'no-store');
        response.end(ATLAS_PNG);
      }, delay);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
  const url = `http://127.0.0.1:${address.port}/`;

  const cases: BrowserCase[] = bothEngines();

  try {
    let exercised = 0;
    for (const browserCase of cases) {
      if (await verifyCase(browserCase, url)) exercised++;
    }
    // A skip per engine is legitimate, but a run where NO engine could test the
    // WebGL path proves nothing and must not report success.
    assert.ok(
      exercised > 0,
      'no engine provided WebGL2, so the MSDF atlas-decode path was never verified',
    );
    console.log(
      `\nMSDF atlas-decode e2e: all checks passed (${exercised}/${cases.length} engines exercised the WebGL path)`,
    );
  } finally {
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
