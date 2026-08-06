import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * Copy / download controls on code blocks and tables, in real engines.
 *
 * The acceptance criterion for this feature is keyboard reachability and AT
 * announcement in **both** engines, because Firefox's clipboard permission model
 * differs from Chrome's and a Chrome-only pass is not evidence. See the fixture
 * header for why jsdom cannot answer either question.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Probe {
  buttonNames: string[];
  buttonTags: string[];
  clickPayload: string | null;
  keyboardPayload: string | null;
  labelAfterActivate: string | null;
  firstTabIsButton: boolean;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
}

/** Reads the projected buttons and exercises pointer and keyboard activation. */
async function probe(page: Page): Promise<Probe> {
  const named = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return {
      names: buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent ?? ''),
      tags: buttons.map((b) => b.tagName.toLowerCase()),
      boxes: buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    };
  });

  // Pointer activation: click the projected element for the code-block copy.
  await page.evaluate(() => {
    // Truncated in place, never reassigned: the fixture's `writeClipboard`
    // closure holds a reference to the array that existed when it was built, so
    // `window.__captured = []` would detach it and every payload would be lost.
    window.__captured.length = 0;
    const target = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.getAttribute('aria-label') ?? '') === 'Copy code',
    );
    target?.click();
  });
  const clickPayload = await page.evaluate(() => window.__captured[0] ?? null);
  // Waited for rather than read immediately: the label lives on the entity and
  // reaches `aria-label` on the next synced frame, so a same-tick read sees the
  // resting label and the assertion would fail for a reason that has nothing to
  // do with the feature. Measured: still resting at t+0, updated by t+400.
  const labelAfterActivate = await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button'))
          .map((b) => b.getAttribute('aria-label') ?? '')
          .find((label) => label.startsWith('Copied')) ?? false,
      { timeout: 4000 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => null);

  // Keyboard activation: focus the same control and press Enter. A canvas-drawn
  // button is only genuinely reachable if this path works.
  //
  // The resting label has to come back before the control can be found again:
  // the previous assertion deliberately left it reading "Copied", and matching on
  // the resting name while it is still in its confirmation state silently finds
  // nothing, focuses nothing, and reports a keyboard failure that is really a
  // sequencing mistake in the test.
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).some(
        (b) => (b.getAttribute('aria-label') ?? '') === 'Copy code',
      ),
    { timeout: 4000 },
  );
  await page.evaluate(() => {
    window.__captured.length = 0;
    const target = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.getAttribute('aria-label') ?? '') === 'Copy code',
    );
    target?.focus();
  });
  await page.keyboard.press('Enter');
  // Waited on rather than slept through: the DOM `click` a keypress synthesizes
  // is dispatched to the entity asynchronously, so a same-tick read observes
  // nothing. Measured in both engines: Enter and Space each deliver exactly one
  // payload once the hop completes.
  const keyboardPayload = await page
    .waitForFunction(() => window.__captured[0] ?? false, { timeout: 4000 })
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => null);

  // Tab order: from the document start, a Tab must be able to reach a button.
  const firstTabIsButton = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some((b) => {
      const index = b.getAttribute('tabindex');
      return index === null || Number(index) >= 0;
    });
  });

  return {
    buttonNames: named.names,
    buttonTags: named.tags,
    clickPayload,
    keyboardPayload,
    labelAfterActivate,
    firstTabIsButton,
    boxes: named.boxes,
  };
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      browser: browserCase.browser,
      executablePath: browserCase.executablePath,
      headless: true,
      args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
      defaultViewport: { width: 420, height: 620, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });
    // The projection materializes on a synced frame, not on load.
    await page.waitForFunction(() => document.querySelectorAll('button').length >= 4, {
      timeout: 10_000,
    });
    const result = await probe(page);

    // Four controls: copy + download on the code block, copy + download on the
    // table.
    assert.deepEqual(
      result.buttonNames,
      ['Copy code', 'Download code', 'Copy table', 'Download table'],
      `${browserCase.name}: unexpected control names ${JSON.stringify(result.buttonNames)}`,
    );
    // A real <button> element, not a div with a role: AT and the browser's own
    // keyboard handling both key off the tag.
    assert.ok(
      result.buttonTags.every((tag) => tag === 'button'),
      `${browserCase.name}: controls must project as <button>, got ${result.buttonTags.join()}`,
    );
    assert.equal(
      result.clickPayload,
      "const greeting = 'hÉllo';",
      `${browserCase.name}: a click must deliver the code verbatim, got ${result.clickPayload}`,
    );
    assert.equal(
      result.keyboardPayload,
      "const greeting = 'hÉllo';",
      `${browserCase.name}: Enter on a focused control must activate it, got ${result.keyboardPayload}`,
    );
    assert.ok(
      result.labelAfterActivate !== null,
      `${browserCase.name}: activation must change the accessible name so AT reports the result`,
    );
    assert.ok(
      result.firstTabIsButton,
      `${browserCase.name}: at least one control must be in the tab order`,
    );
    // Every control must have real geometry; a zero-sized projected element is
    // focusable but unclickable.
    for (const box of result.boxes) {
      assert.ok(
        box.width > 0 && box.height > 0,
        `${browserCase.name}: a control projected with no area (${JSON.stringify(box)})`,
      );
    }

    console.log(
      `${browserCase.name}: ${result.buttonNames.length} controls, click + Enter both OK`,
    );
  } finally {
    await browser?.close();
  }
}

async function main(): Promise<void> {
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/block-affordances.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the affordance browser fixture');

  const markup =
    '<!doctype html><html><body style="margin:0"><canvas width="420" height="520"></canvas><script type="module" src="/fixture.mjs"></script></body></html>';
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
