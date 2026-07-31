/**
 * Layout-worker fallback end-to-end ink gate.
 *
 * `MSDFTextEntity.render()` returns early while `layoutResult` is null, and the
 * only thing that ever sets it is a `LayoutWorkerManager` callback. Those
 * callbacks used to be discarded whenever the worker failed, and dropped
 * outright when no worker could be created — so a single worker error, or a
 * Content-Security-Policy that blocks `blob:` workers, left the text
 * permanently invisible while its box, hit-testing, and DOM content projection
 * all still reported success.
 *
 * Measured 2026-07-31: a real CSP does not make `new Worker(blob:…)` throw. It
 * constructs and then fires `onerror`, on both Chromium and Firefox, under
 * `worker-src 'none'`, a `script-src` without `blob:`, and `default-src 'self'`.
 * That is why this runner serves the fixture twice — once with a real CSP header
 * and once without — instead of stubbing the Worker global: the CSP variant is
 * the realistic trigger, and only a real header reproduces it.
 *
 * The `csp` page is the load-bearing case: it must paint the same pixels as the
 * unrestricted page. Any assertion short of counting them passes on a blank
 * canvas, which is exactly how this defect class shipped twice before
 * (CTX-0152, CTX-0153).
 *
 * Run with `bun run test:e2e` in packages/core. Executable resolution:
 * PUPPETEER_EXECUTABLE_PATH → /usr/bin/chromium → /usr/bin/google-chrome, and
 * FIREFOX_EXECUTABLE_PATH → /usr/bin/firefox.
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { type BrowserCase, bothEngines } from './_shared/browsers';
import type {
  LayoutCaseResult,
  LayoutFallbackBrowserResult,
} from './layout-worker-fallback.fixture';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function isResult(value: unknown): value is LayoutFallbackBrowserResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { workerUsable?: unknown; cases?: unknown };
  if (typeof record.workerUsable !== 'boolean' || !Array.isArray(record.cases)) return false;
  return record.cases.every((entry: unknown) => {
    const item = entry as Record<string, unknown>;
    return (
      typeof item.name === 'string' &&
      (item.constructError === null || typeof item.constructError === 'string') &&
      typeof item.gotLayout === 'boolean' &&
      typeof item.glyphs === 'number' &&
      typeof item.ink === 'number' &&
      typeof item.inkBelow === 'number' &&
      typeof item.workerAttempts === 'number'
    );
  });
}

/**
 * A policy with no `blob:` in `script-src`, which is what blocks a blob-URL
 * Worker. `'unsafe-inline'` is required only so the bundled fixture itself can
 * run from an inline `<script>`; it does not re-permit workers.
 */
const BLOCKING_CSP = "default-src 'self'; script-src 'unsafe-inline'";

async function main(): Promise<void> {
  const browsers: BrowserCase[] = bothEngines();

  const bundle = await build({
    entryPoints: [join(packageRoot, 'e2e/layout-worker-fallback.fixture.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    absWorkingDir: packageRoot,
    platform: 'browser',
    target: 'es2022',
  });
  const script = bundle.outputFiles[0].text;
  const html = `<!doctype html><meta charset="utf-8"><title>layout fallback</title><body style="margin:0;background:#000"><script>${script}</script></body>`;

  const server = createServer((request, response) => {
    const wantsCsp = (request.url ?? '/').includes('csp=1');
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    };
    if (wantsCsp) headers['content-security-policy'] = BLOCKING_CSP;
    response.writeHead(200, headers);
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };

  let failures = 0;
  try {
    for (const browserCase of browsers) {
      let browser: Browser | undefined;
      try {
        browser = await puppeteer.launch({
          browser: browserCase.browser,
          executablePath: browserCase.executablePath,
          headless: true,
          args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : undefined,
        });

        const pages: Record<string, LayoutFallbackBrowserResult> = {};
        for (const variant of ['plain', 'csp'] as const) {
          const page = await browser.newPage();
          const pageErrors: string[] = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await page.goto(`http://127.0.0.1:${port}/?csp=${variant === 'csp' ? 1 : 0}`, {
            waitUntil: 'load',
          });
          await page.waitForFunction('window.__ready === true', {
            timeout: 60_000,
          });
          const failure = await page.evaluate(() => window.__layoutFallbackError ?? null);
          assert.equal(failure, null, `${variant} fixture threw: ${failure}`);
          const raw = await page.evaluate(() => window.__layoutFallbackResult);
          assert.ok(isResult(raw), `${variant} produced a malformed result`);
          pages[variant] = raw;

          // A blocked worker is reported by the browser as a page-level CSP
          // violation; that is the environment under test, not a defect.
          const unexpected = pageErrors.filter(
            (message) => !/content security policy|blocked|SecurityError/i.test(message),
          );
          assert.deepEqual(unexpected, [], `${variant} raised unexpected page errors`);
          await page.close();
        }

        const plain = pages.plain;
        const csp = pages.csp;

        // The premise of the whole gate: the CSP page really cannot use a
        // worker, and the plain page really can. Without this the two variants
        // could be identical and every comparison below would be vacuous.
        assert.equal(
          plain.workerUsable,
          true,
          'the unrestricted page must be able to use a worker',
        );
        assert.equal(csp.workerUsable, false, 'the CSP page must NOT be able to use a worker');

        const byName = (result: LayoutFallbackBrowserResult, name: string): LayoutCaseResult => {
          const found = result.cases.find((entry) => entry.name === name);
          assert.ok(found, `missing case ${name}`);
          return found;
        };

        const reference = byName(plain, 'default');
        assert.ok(reference.ink > 0, 'the worker-backed control must paint pixels');
        assert.equal(
          reference.inkBelow,
          0,
          'the control strip must be empty (sample region check)',
        );
        assert.equal(reference.constructError, null, 'the control must not throw');
        assert.ok(reference.gotLayout, 'the control must receive layout');

        for (const variant of ['plain', 'csp'] as const) {
          const result = pages[variant];
          for (const name of [
            'default',
            'noWorkerGlobal',
            'workerCtorThrows',
            'workerRuntimeError',
          ]) {
            const item = byName(result, name);
            assert.equal(
              item.constructError,
              null,
              `${variant}/${name}: constructing the entity must not throw, got ${item.constructError}`,
            );
            assert.ok(
              item.gotLayout,
              `${variant}/${name}: layout must arrive even with no usable worker`,
            );
            assert.equal(
              item.glyphs,
              reference.glyphs,
              `${variant}/${name}: glyph count must match the worker-backed control`,
            );
            assert.equal(
              item.inkBelow,
              0,
              `${variant}/${name}: the control strip must be empty, so the ink sample is trustworthy`,
            );
            // The assertion the defect could not survive.
            assert.ok(
              item.ink > 0,
              `${variant}/${name}: the text must be PAINTED, not a blank canvas (ink=${item.ink})`,
            );
            assert.equal(
              item.ink,
              reference.ink,
              `${variant}/${name}: fallback layout must paint identically to the worker (ink=${item.ink} vs ${reference.ink})`,
            );
          }
        }

        // Bounded recreation: a permanently worker-hostile document must stop
        // spawning Workers. Measured pre-fix, 6 sequential requests spawned 6
        // Workers on both engines and delivered 0 layouts.
        const cspRepeated = byName(csp, 'repeatedRequests');
        assert.ok(
          cspRepeated.gotLayout && cspRepeated.ink > 0,
          'csp/repeatedRequests: repeated requests must still produce painted text',
        );
        assert.ok(
          cspRepeated.workerAttempts <= 2,
          `csp/repeatedRequests: worker creation must be capped at 2, got ${cspRepeated.workerAttempts}`,
        );
        // And the unrestricted page must NOT be capped into the fallback: a
        // healthy worker serves all six requests with one Worker.
        const plainRepeated = byName(plain, 'repeatedRequests');
        assert.equal(
          plainRepeated.workerAttempts,
          1,
          `plain/repeatedRequests: a healthy worker must be reused, got ${plainRepeated.workerAttempts}`,
        );

        console.log(
          `✓ ${browserCase.name}: control ink=${reference.ink} glyphs=${reference.glyphs}; ` +
            `csp workerUsable=false, 4 cases painted ink=${byName(csp, 'default').ink}; ` +
            `repeated requests workerAttempts plain=${plainRepeated.workerAttempts} ` +
            `csp=${cspRepeated.workerAttempts}`,
        );
      } catch (error) {
        failures++;
        console.error(`✗ ${browserCase.name}: ${(error as Error).message}`);
      } finally {
        await browser?.close();
      }
    }
  } finally {
    server.close();
  }

  if (failures > 0) throw new Error(`${failures} browser(s) failed the layout fallback gate`);
  console.log('layout worker fallback: all checks passed');
}

await main();
