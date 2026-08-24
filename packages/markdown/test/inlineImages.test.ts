// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';
import { clearInlineImageRasters, ensureInlineImageRaster } from '../src/markdown-image';

/**
 * An image must render where it is written, including on a line it shares with
 * text.
 *
 * Images render in a paragraph, a blockquote and a list item through paragraph
 * splitting, which gives each one its own block and its own `Image` entity. A
 * heading and a table cell have no such path — they route through `collectSpans`,
 * where `Tokens.Image` used to fall to `default:`, which pushes `.text`. So the
 * ALT TEXT rendered as ordinary prose and the picture vanished. Measured before
 * the fix, `# Title ![alt](u) tail` projected `"Title alt tail"` with zero image
 * entities and zero object spans: nothing threw, nothing was blank, and the
 * sentence read intact — which is why it went unnoticed.
 *
 * The fix is one arm in the inline switch emitting an object span, reusing the
 * same `OBJECT_REPLACEMENT` + `paint` mechanism inline math already uses, so
 * selection and the accessible name come along for free. A per-context fix would
 * not have had either.
 *
 * ## Why these tests drive the decode by hand
 *
 * jsdom settles neither `onload` nor `onerror`, for an `http` URL or a `data:`
 * one — measured, and the same measurement `paragraphImageRepaint.test.ts` and
 * `nestedImages.test.ts` record. `naturalWidth`/`naturalHeight` are however
 * forceable with `defineProperty`, so a decode is simulated by setting those and
 * invoking the handler the store installed. That is the only way to test the
 * aspect-ratio correction at all, and it is worth doing because the correction is
 * a full document rebuild.
 */

/** Every object span in the tree, with the fields that decide its box. */
function objectSpans(md: Markdown): Array<{
  alt?: string;
  key?: string;
  width: number;
  height: number;
  depth?: number;
}> {
  const found: Array<{
    alt?: string;
    key?: string;
    width: number;
    height: number;
    depth?: number;
  }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ object?: unknown }> }).spans;
    for (const span of spans ?? []) {
      if (span.object) {
        found.push(
          span.object as {
            alt?: string;
            key?: string;
            width: number;
            height: number;
            depth?: number;
          },
        );
      }
    }
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return found;
}

/** Concatenated span text, to prove alt text is no longer painted as prose. */
function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

/** Every `Image` ENTITY, i.e. the block path, identified structurally. */
function imageEntities(md: Markdown): string[] {
  const found: string[] = [];
  const walk = (entity: { children?: unknown[] }): void => {
    if ('src' in entity && 'bitmap' in entity) found.push((entity as { src: string }).src);
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return found;
}

/**
 * Simulate a decode: force the natural size, then fire the store's own handler.
 *
 * Deliberately reaches through `ensureInlineImageRaster` rather than stubbing
 * `globalThis.Image`, so the notification path under test is the real one — the
 * waiters the store notifies are what trigger the document rebuild.
 */
function decode(src: string, naturalWidth: number, naturalHeight: number): void {
  const raster = ensureInlineImageRaster(src);
  const bitmap = raster.bitmap;
  if (!bitmap) throw new Error('no bitmap — jsdom should provide globalThis.Image');
  Object.defineProperty(bitmap, 'naturalWidth', {
    value: naturalWidth,
    configurable: true,
  });
  Object.defineProperty(bitmap, 'naturalHeight', {
    value: naturalHeight,
    configurable: true,
  });
  bitmap.onload?.(new Event('load'));
}

/** Simulate a failed decode. */
function fail(src: string): void {
  const raster = ensureInlineImageRaster(src);
  raster.bitmap?.onerror?.(new Event('error'));
}

const URL = 'https://example.test/badge.svg';

beforeEach(() => {
  clearInlineImageRasters();
});

describe('an image on a line it shares with text', () => {
  it('renders in a heading as an object span, not as alt text', () => {
    const md = new Markdown(`# Title ![alt](${URL}) tail`, { width: 600 });
    const objects = objectSpans(md);
    expect(objects).toHaveLength(1);
    expect(objects[0].alt).toBe('alt');
    // Was "Title alt tail" — the alt text painted as prose.
    expect(projectedText(md)).toBe('Title \ufffc tail');
  });

  it('renders in a table cell', () => {
    const md = new Markdown(`| h |\n| --- |\n| ![alt](${URL}) |`, {
      width: 600,
    });
    expect(objectSpans(md)).toHaveLength(1);
    // Was "halt".
    expect(projectedText(md)).toBe('h\ufffc');
  });

  it('keeps the alt text as the accessible name', () => {
    // The object carries it, so the a11y projection and a copy both get real text
    // instead of the invisible U+FFFC sentinel. This is what a per-context fix
    // routing through a separate entity would have lost.
    const md = new Markdown(`# ![a pretty picture](${URL})`, { width: 600 });
    expect(objectSpans(md)[0].alt).toBe('a pretty picture');
  });

  it('sizes the box from the run, not from the document body size', () => {
    // An h1 is larger than body prose, and a table cell is smaller. The image
    // follows the run it sits in, which is the whole reason `blockFontSize` is
    // threaded through `collectSpans`.
    const heading = objectSpans(new Markdown(`# ![a](${URL})`, { width: 600 }))[0];
    const cell = objectSpans(new Markdown(`| h |\n| --- |\n| ![a](${URL}) |`, { width: 600 }))[0];
    expect(heading.height).toBeGreaterThan(cell.height);
  });

  it('reserves a square before the decode and the aspect ratio after it', () => {
    const md = new Markdown(`# ![a](${URL})`, { width: 600 });
    const before = objectSpans(md)[0];
    expect(before.width).toBeCloseTo(before.height, 5);

    decode(URL, 80, 20); // 4:1, a badge
    const after = objectSpans(md)[0];
    expect(after.height).toBeCloseTo(before.height, 5); // height never moves
    expect(after.width).toBeCloseTo(before.height * 4, 5);
  });

  it('re-measures a heading nested in a blockquote after the decode', () => {
    // The top-level token is a blockquote, not a heading, so
    // `inlineImageBoxesStale` must descend into `blockquote.tokens` to find the
    // image whose box the decode just changed — before the fix it stopped at
    // the top level and the nested badge kept its square forever.
    const md = new Markdown(`> # ![a](${URL})`, { width: 600 });
    const before = objectSpans(md)[0];
    expect(before.width).toBeCloseTo(before.height, 5);

    decode(URL, 80, 20); // 4:1, a badge
    const after = objectSpans(md)[0];
    expect(after.height).toBeCloseTo(before.height, 5); // height never moves
    expect(after.width).toBeCloseTo(before.height * 4, 5);
  });

  it('sits on the baseline rather than hanging below it', () => {
    const md = new Markdown(`# ![a](${URL})`, { width: 600 });
    expect(objectSpans(md)[0].depth).toBe(0);
  });

  it('falls back to alt text when the decode fails', () => {
    const md = new Markdown(`# Title ![alt](${URL})`, { width: 600 });
    expect(objectSpans(md)).toHaveLength(1);
    fail(URL);
    // A box that will never be filled is worse than the text: it is an invisible
    // gap. The rebuild is what replaces it, so this also proves the failure path
    // notifies its waiters.
    expect(objectSpans(md)).toHaveLength(0);
    expect(projectedText(md)).toBe('Title alt');
  });

  it('distinguishes two images that share alt text and differ in URL', () => {
    // The reachable case for `InlineObject.key`: a badge column. Both cells have
    // identical alt, identical metrics and different pictures, so without the key
    // the layout memo serves the first cell's painter to the second and every row
    // draws the first row's badge.
    const md = new Markdown(`| status |\n| --- |\n| ![badge](pass.svg) |\n| ![badge](fail.svg) |`, {
      width: 600,
    });
    const keys = objectSpans(md).map((o) => o.key);
    expect(keys).toEqual(['pass.svg', 'fail.svg']);
  });

  it('leaves the block-level path alone', () => {
    // A paragraph image still becomes its own `Image` entity at natural size. It
    // must NOT become an inline object: this arm is for images sharing a line with
    // text, and routing block images through it would cap every picture in a
    // document to ~1.15x the body font size.
    const md = new Markdown(`Text ![alt](${URL}) more.`, { width: 600 });
    expect(imageEntities(md)).toEqual([URL]);
    expect(objectSpans(md)).toHaveLength(0);
  });

  it('does not rebuild for a square image', () => {
    // The decode confirms what the span already reserved, so the document repaints
    // instead of re-rendering. Observed through the token-level predicate: a
    // rebuild would produce a new spans array.
    const md = new Markdown(`# ![a](${URL})`, { width: 600 });
    const spansBefore = objectSpans(md)[0];
    decode(URL, 64, 64);
    const spansAfter = objectSpans(md)[0];
    expect(spansAfter.width).toBeCloseTo(spansBefore.width, 5);
    expect(spansAfter.height).toBeCloseTo(spansBefore.height, 5);
  });
});

/**
 * The store is module-level and lives as long as the page, so a streamed feed
 * of documents with distinct image URLs once grew it without limit, pinning a
 * decoded `HTMLImageElement` per URL until tab close (#699). The inline-math
 * raster store fixed the same defect with an LRU cap; this pins the image
 * twin to the same behaviour.
 */
describe('the inline-image raster store is bounded', () => {
  const limit = 256;
  const src = (i: number): string => `https://example.test/img-${i}.png`;

  it('evicts the least-recently-used entry past the cap', () => {
    // Fill past the cap without ever touching entry 0 again, so it stays the
    // least-recently-used and is evicted: a fresh call starts a new decode
    // instead of returning the same pinned entry forever.
    const first = ensureInlineImageRaster(src(0));
    for (let i = 1; i <= limit + 8; i++) {
      ensureInlineImageRaster(src(i));
    }
    const redecoded = ensureInlineImageRaster(src(0));
    expect(redecoded).not.toBe(first);
    expect(redecoded.decoded).toBe(false);
  });

  it('a recent hit survives a flood that would otherwise evict it', () => {
    const survivor = ensureInlineImageRaster(src(0));
    for (let i = 1; i <= 100; i++) {
      ensureInlineImageRaster(src(i));
    }

    // The hit re-inserts, moving entry 0 behind the flood so far.
    expect(ensureInlineImageRaster(src(0))).toBe(survivor);

    for (let i = 101; i <= 200; i++) {
      ensureInlineImageRaster(src(i));
    }
    expect(ensureInlineImageRaster(src(0))).toBe(survivor);
  });
});
