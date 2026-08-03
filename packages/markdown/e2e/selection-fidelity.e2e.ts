import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { type BrowserCase, bothEngines, closeServer } from '../../core/e2e/_shared/browsers';

/**
 * Native selection over a composed Markdown document, in real engines.
 *
 * The jsdom suite (`test/selection-fidelity.test.ts`) asserts the projection
 * *intent*; this asserts what a user actually gets. See the fixture header for
 * why the two cannot be merged.
 *
 * Both gates below were verified by deliberately breaking them — an assertion
 * that has never been observed to fail is not yet a gate.
 */

/** Reading order of the eight projected leaves, in canvas order. */
const EXPECTED_ORDER = [
  'Alpha Heading',
  'Beta body paragraph.',
  // The inline-math paragraph projects its object's `alt`, not the U+FFFC
  // sentinel the layout engine reserves. Asserting the alt HERE, in the document
  // order literal, is deliberate: it is read from the DOM mirror's textContent,
  // so it fails if any of the four projection emission points still emits the
  // sentinel.
  'Iota E = mc^2 kappa.',
  'const gamma = 1;\nconst delta = 2;',
  'Epsilon',
  'Zeta',
  'Eta',
  'Theta',
];

interface SelectionCase {
  text: string;
  anchor: string | null;
  focus: string | null;
}

interface Result {
  documentOrder: string[];
  nodeCount: number;
  userSelect: string[];
  selectAll: string;
  crossBlock: SelectionCase;
  crossBlockReversed: SelectionCase;
  codeBlock: SelectionCase;
  /** A `Range` copy of the whole inline-math paragraph. */
  inlineMath: SelectionCase;
  /** The same paragraph's accessible name, which was already correct. */
  inlineMathA11yLabel: string | null;
}

/** Drag between the centers of two projected mirrors, by their text. */
async function dragBetween(page: Page, fromText: string, toText: string): Promise<SelectionCase> {
  const points = await page.evaluate(
    ({ fromText, toText }) => {
      const nodes = [...document.querySelectorAll<HTMLElement>('[data-vecto-content]')];
      const find = (needle: string) => {
        const el = nodes.find((n) => (n.textContent ?? '').startsWith(needle));
        if (!el) throw new Error(`No projected mirror starting with ${JSON.stringify(needle)}`);
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      return { from: find(fromText), to: find(toText) };
    },
    { fromText, toText },
  );

  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 24 });
  await page.mouse.up();

  return page.evaluate(() => {
    const selection = getSelection();
    return {
      text: selection?.toString() ?? '',
      anchor: selection?.anchorNode?.textContent ?? null,
      focus: selection?.focusNode?.textContent ?? null,
    };
  });
}

/**
 * Drag across the two rows *inside* the fenced code block.
 *
 * The code block projects a grid — one child span per source row — so a drag
 * between two distinct rows is what exercises the row-to-row boundary and the
 * hard newline the projection places on the first row. Dragging between a mirror
 * and itself would collapse to a caret and select nothing, which is how the
 * first draft of this case passed while measuring an empty selection.
 */
async function dragCodeRows(page: Page): Promise<SelectionCase> {
  const points = await page.evaluate(() => {
    const code = [...document.querySelectorAll<HTMLElement>('[data-vecto-content]')].find((el) =>
      (el.textContent ?? '').startsWith('const gamma'),
    );
    if (!code) throw new Error('Missing fenced code mirror');
    const rows = [...code.children];
    if (rows.length < 2) throw new Error(`Code mirror has ${rows.length} rows, expected 2`);
    const first = rows[0].getBoundingClientRect();
    const last = rows[rows.length - 1].getBoundingClientRect();
    return {
      from: { x: first.left + 2, y: first.top + first.height / 2 },
      to: { x: last.right - 2, y: last.top + last.height / 2 },
    };
  });

  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 24 });
  await page.mouse.up();

  return page.evaluate(() => {
    const selection = getSelection();
    return {
      text: selection?.toString() ?? '',
      anchor: selection?.anchorNode?.textContent ?? null,
      focus: selection?.focusNode?.textContent ?? null,
    };
  });
}

/**
 * Copy the inline-math paragraph via a real `Range`, and read its accessible name.
 *
 * A `Range` over the mirror's contents is what Ctrl+C actually serializes, so this
 * is the assertion the defect was defined by: `getA11yAttributes()` already
 * returned `Iota E = mc^2 kappa.` while a copy returned the U+FFFC sentinel,
 * because `getContentProjection()` built from `sourceText()` — the string layout
 * offsets index — rather than substituting the object's `alt` on the way out.
 *
 * Both halves are read here so the gate proves they now AGREE, rather than only
 * that one of them is right.
 */
async function copyInlineMath(page: Page): Promise<{
  selection: SelectionCase;
  a11yLabel: string | null;
}> {
  return page.evaluate(() => {
    const mirror = [...document.querySelectorAll<HTMLElement>('[data-vecto-content]')].find((el) =>
      (el.textContent ?? '').startsWith('Iota'),
    );
    if (!mirror) throw new Error('Missing inline-math mirror');
    const range = document.createRange();
    range.selectNodeContents(mirror);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const text = selection?.toString() ?? '';
    const anchor = selection?.anchorNode?.textContent ?? null;
    const focus = selection?.focusNode?.textContent ?? null;
    selection?.removeAllRanges();

    // The a11y label lives on the interactive shadow node for the same entity,
    // which the scene labels via `aria-label`. Fall back to the projection's own
    // node when the paragraph is not separately labelled.
    const labelled = [...document.querySelectorAll<HTMLElement>('[aria-label]')].find((el) =>
      (el.getAttribute('aria-label') ?? '').startsWith('Iota'),
    );
    return {
      selection: { text, anchor, focus },
      a11yLabel: labelled?.getAttribute('aria-label') ?? null,
    };
  });
}

async function collect(page: Page): Promise<Result> {
  const base = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-vecto-content]')];
    const root = document.querySelector<HTMLElement>('[data-vecto-a11y-root]');
    if (!root) throw new Error('Missing a11y root');
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectAll = selection?.toString() ?? '';
    selection?.removeAllRanges();
    return {
      documentOrder: nodes.map((el) => el.textContent ?? ''),
      nodeCount: nodes.length,
      userSelect: nodes.map((el) => getComputedStyle(el).userSelect),
      selectAll,
    };
  });

  const inline = await copyInlineMath(page);

  return {
    ...base,
    crossBlock: await dragBetween(page, 'Alpha Heading', 'Theta'),
    crossBlockReversed: await dragBetween(page, 'Theta', 'Alpha Heading'),
    codeBlock: await dragCodeRows(page),
    inlineMath: inline.selection,
    inlineMathA11yLabel: inline.a11yLabel,
  };
}

function verify(browserCase: BrowserCase, result: Result): void {
  const tag = browserCase.name;

  // Gate 1 — document order must match canvas reading order. Every selection
  // assertion below is meaningless if the projection is ordered wrongly, because
  // a drag walks document order. Verified by sabotage: reverting the
  // `sortNormalElementsVisually` fix makes this fail in both engines with the
  // table cells column-major.
  assert.deepEqual(
    result.documentOrder,
    EXPECTED_ORDER,
    `${tag} projected document order is not canvas reading order`,
  );
  assert.equal(result.nodeCount, EXPECTED_ORDER.length, `${tag} unexpected mirror count`);

  // Gate 2 — the projection must actually be selectable. Verified by sabotage:
  // constructing the fixture's Markdown with `selectable: false` makes this fail
  // (and empties every selection below), so a green run cannot be a run that
  // simply selected nothing.
  for (const value of result.userSelect) {
    assert.notEqual(value, 'none', `${tag} a projected mirror is not selectable`);
  }

  // Select-all must yield every block in reading ORDER. Block separators are an
  // engine convention, not our contract: measured on this fixture, Firefox joins
  // block-level mirrors with '\n' while Chromium concatenates them with nothing
  // at all ('Alpha HeadingBeta body paragraph.'). Comparing with all whitespace
  // removed keeps the assertion on the thing we control — the sequence — and
  // still fails on a wrong order, which is what the sabotage run confirmed.
  const squeeze = (value: string) => value.replaceAll(/\s+/gu, '');
  assert.equal(
    squeeze(result.selectAll),
    squeeze(EXPECTED_ORDER.join('')),
    `${tag} select-all did not return reading order`,
  );

  // A cross-block drag must reach both ends and stay non-empty.
  assert.ok(
    result.crossBlock.text.includes('Beta body paragraph.'),
    `${tag} cross-block selection missed the body paragraph: ${JSON.stringify(result.crossBlock.text)}`,
  );
  assert.ok(
    result.crossBlock.text.includes('gamma'),
    `${tag} cross-block selection missed the code block`,
  );

  // Reversed drag selects the same span. Anchor and focus swap; the text does
  // not, because `toString()` is document-ordered.
  const forward = result.crossBlock.text.replaceAll(/\s+/gu, ' ').trim();
  const backward = result.crossBlockReversed.text.replaceAll(/\s+/gu, ' ').trim();
  assert.equal(backward, forward, `${tag} reversed drag selected a different span`);

  // The fenced block must keep its source line break. This is the one assertion
  // the jsdom suite can state but not verify: it checks that the projection
  // *declares* `separatorAfter: '\n'` on the first row, whereas this checks that
  // a real drag across both rows actually yields two lines rather than splicing
  // the statements together.
  assert.ok(
    result.codeBlock.text.includes('gamma'),
    `${tag} code-block drag missed the first row: ${JSON.stringify(result.codeBlock.text)}`,
  );
  assert.ok(
    result.codeBlock.text.includes('delta'),
    `${tag} code-block drag missed the second row: ${JSON.stringify(result.codeBlock.text)}`,
  );
  assert.match(
    result.codeBlock.text,
    /gamma[^]*\n[^]*delta/u,
    `${tag} fenced code lost its source line break: ${JSON.stringify(result.codeBlock.text)}`,
  );
  // Gate 4 — a reserved inline object copies as its `alt`, not as the U+FFFC
  // sentinel the layout engine reserves for it.
  //
  // Stated on a real `Range` because that is what Ctrl+C serializes, and because
  // the jsdom suite structurally cannot: it has no usable `getSelection()` over
  // positioned text. Before the fix this arm read `Iota \ufffc kappa.` while the
  // accessible name was already correct, so the two are compared against each
  // other as well as against the literal — a projection that regressed one but not
  // the other is the exact shape of the original defect.
  assert.ok(
    !result.inlineMath.text.includes('\ufffc'),
    `${tag} a Range copy still contains the U+FFFC object sentinel: ${JSON.stringify(result.inlineMath.text)}`,
  );
  assert.equal(
    result.inlineMath.text.replaceAll(/\s+/gu, ' ').trim(),
    'Iota E = mc^2 kappa.',
    `${tag} inline-object copy text is wrong: ${JSON.stringify(result.inlineMath.text)}`,
  );
  if (result.inlineMathA11yLabel !== null) {
    assert.equal(
      result.inlineMathA11yLabel.replaceAll(/\s+/gu, ' ').trim(),
      result.inlineMath.text.replaceAll(/\s+/gu, ' ').trim(),
      `${tag} accessible name and copied text disagree: ${JSON.stringify(result.inlineMathA11yLabel)} vs ${JSON.stringify(result.inlineMath.text)}`,
    );
  }
  // Select-all must carry it too — a substitution applied to the per-line text but
  // not to the runs (or vice versa) would pass the Range arm and fail here.
  assert.ok(
    result.selectAll.includes('E = mc^2') && !result.selectAll.includes('\ufffc'),
    `${tag} select-all lost the inline-object alt: ${JSON.stringify(result.selectAll)}`,
  );
}

async function verifyCase(browserCase: BrowserCase, url: string): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    browser: browserCase.browser,
    executablePath: browserCase.executablePath,
    headless: true,
    args: browserCase.browser === 'chrome' ? ['--no-sandbox'] : [],
    defaultViewport: { width: 360, height: 520, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__ready === true', { timeout: 10_000 });
    // The projection materializes on a later frame than `start()`; poll for it
    // rather than assuming a frame count.
    await page.waitForFunction('document.querySelectorAll("[data-vecto-content]").length > 0', {
      timeout: 10_000,
    });

    const result = await collect(page);
    verify(browserCase, result);
    assert.deepEqual(pageErrors, [], `${browserCase.name} raised page errors`);
    console.log(`✓ ${browserCase.name}: ${result.nodeCount} mirrors in reading order`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await build({
    entryPoints: [join(packageRoot, 'e2e/selection-fidelity.fixture.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const fixtureSource = fixture.outputFiles[0]?.text;
  if (!fixtureSource) throw new Error('Failed to bundle the selection browser fixture');

  const markup =
    '<!doctype html><html><body style="margin:0"><canvas width="360" height="420"></canvas><script type="module" src="/fixture.mjs"></script></body></html>';
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
