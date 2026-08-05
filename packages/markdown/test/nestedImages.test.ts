// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';

/**
 * An image must render wherever Markdown allows one to be written, not only as a
 * direct child of a paragraph.
 *
 * `paragraphHasImage` and the paragraph render arm both tested
 * `token.tokens?.some((c) => c.type === 'image')` — **direct children only** —
 * while `marked` legitimately nests an image one or more levels deeper:
 *
 * | source                  | token shape                              |
 * | ----------------------- | ---------------------------------------- |
 * | `![a](u)`               | `paragraph > image`                      |
 * | `[![a](u)](dest)`       | `paragraph > link > image`               |
 * | `- item ![a](u)`        | `list > list_item > text > [text, image]` |
 *
 * A nested image therefore failed the predicate, fell through to
 * `inlineRunRichText`, which has no image support, and vanished with no warning.
 * This is the same shape of defect as CTX-0208's block-level list-item children:
 * a predicate over direct children gating a construct that nests.
 *
 * `react-markdown` avoids the whole class by never asking the question — one
 * recursive `visit` reaches any depth (`lib/index.js:346`). The fix here keeps a
 * single shared predicate, because its docstring invariant (the reconciler and
 * the renderer must not disagree about which shape a token produces) is real, and
 * makes that one predicate recursive instead.
 *
 * Counting entities rather than pixels is deliberate: jsdom's `Image` settles
 * neither `onload` nor `onerror` for a `data:` URI, so a decode is unobservable
 * here. `paragraphImageRepaint.test.ts` documents that measurement.
 */

/** Every image entity in the tree, identified structurally like its sibling test. */
function imageEntities(md: Markdown): Array<{ src: string; alt?: string }> {
  const found: Array<{ src: string; alt?: string }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    if ('src' in entity && 'bitmap' in entity) {
      found.push(entity as unknown as { src: string; alt?: string });
    }
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return found;
}

/**
 * Concatenated text, to prove surrounding prose survives the split.
 *
 * Reads `spans`, not a `text` property: `RichText` carries its content as styled
 * spans and exposes no `text`, so walking for one finds nothing and would make
 * this assertion vacuous.
 */
function projectedText(md: Markdown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    if (Array.isArray(spans)) {
      for (const span of spans) out += span.text ?? '';
    }
    const withText = entity as { text?: unknown };
    if (typeof withText.text === 'string') out += withText.text;
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(md as unknown as { children?: unknown[] });
  return out;
}

const URL = 'https://example.test/u.svg';

describe('images nested inside other inline constructs', () => {
  it('renders a bare image as a control', () => {
    const md = new Markdown(`![alt](${URL})`, { width: 600 });
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL]);
  });

  it('renders an image wrapped in a link', () => {
    const md = new Markdown(`[![alt](${URL})](https://example.test/dest)`, {
      width: 600,
    });
    // Was 0: `marked` gives `paragraph > link > image`, so the direct-children
    // test failed and the whole run went to `inlineRunRichText`.
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL]);
  });

  it('renders an image inside a list item', () => {
    const md = new Markdown(`- item ![alt](${URL})`, { width: 600 });
    // Was 0: `list > list_item > text > [text, image]` is two levels deeper again.
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL]);
  });

  it('keeps the text and the marker around a nested image', () => {
    const md = new Markdown(`- item ![alt](${URL})`, { width: 600 });
    expect(imageEntities(md)).toHaveLength(1);
    const text = projectedText(md);
    expect(text).toContain('item');
    // The marker survives. An earlier attempt excluded the whole child from the
    // lead run, which left `listItemSpans` with no tokens; it then fell back to
    // the item's RAW `text` and rendered `item ![alt](…)` as literal Markdown
    // source above the correctly-split block.
    expect(text).toContain('•');
    expect(text).not.toContain('![');
    expect(text).not.toContain(URL);
  });

  it('renders an image nested in emphasis inside a link', () => {
    const md = new Markdown(`[*![alt](${URL})*](https://example.test/dest)`, {
      width: 600,
    });
    // Arbitrary depth, not just one level: this is why the predicate recurses
    // rather than gaining a hardcoded `link` case.
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL]);
  });

  it('renders two images nested in separate links', () => {
    const md = new Markdown(
      `[![a](${URL})](https://example.test/1) and [![b](https://example.test/v.svg)](https://example.test/2)`,
      { width: 600 },
    );
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL, 'https://example.test/v.svg']);
  });

  it('renders a reference-style image, which already worked', () => {
    // Recorded as a third failing case in the 2026-08-05T191624Z handoff. It is
    // not: the token is `paragraph > image` with `href` resolved, identical to
    // the control, and it renders. Measured here so it is not re-investigated.
    const md = new Markdown(`![alt][id]\n\n[id]: ${URL}`, { width: 600 });
    expect(imageEntities(md).map((i) => i.src)).toEqual([URL]);
  });
});
