// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_REPLACEMENT, type StyledSpan } from '@vectojs/core';
import { Image } from '@vectojs/ui';
import { Markdown, preloadMathJax } from '../src/Markdown';

/**
 * Display math must reach the browser's text machinery, not hide inside an
 * `<img>`.
 *
 * `renderDisplayMath()` built `new Image(svgDataUri, { alt: formula })`. An
 * `Image` reports `getA11yAttributes(): { tag: 'img', src, alt }` and has no
 * `getContentProjection()`, so a `$$...$$` block contributed **nothing** to the
 * projected text layer: not to `innerText`, not to find-in-page, not to a
 * selection, not to a copy. Inline `$...$` in the very same document did, because
 * it reserves a `StyledSpan.object` inside a `RichText` and `RichText` substitutes
 * each object's `alt` for the U+FFFC sentinel when it projects
 * (`RichText.ts:427`). A user reading a document with both saw one selectable and
 * the other not — the asymmetry these tests pin down.
 *
 * The fix routes display math through the same inline-object seam rather than
 * inventing a second mechanism, which is also what removes the `<img>` — and with
 * it the `draggable="true"` that let a formula be dragged out as an SVG *file*.
 *
 * MathJax is imported lazily, so preload to make these assertions about WHAT is
 * produced rather than about load timing, as `blockMath.test.ts` does.
 */
beforeAll(async () => {
  await preloadMathJax();
});

/** Every entity in the tree, in document order. */
function walk(e: any, out: any[] = []): any[] {
  out.push(e);
  for (const c of e.children ?? []) walk(c, out);
  return out;
}

/** Every span on every RichText in the tree, in document order. */
function spansOf(md: Markdown): StyledSpan[] {
  const out: StyledSpan[] = [];
  for (const e of walk(md.content)) {
    if (Array.isArray(e.spans)) out.push(...(e.spans as StyledSpan[]));
  }
  return out;
}

/** Concatenated `getContentProjection().text` of every entity that has one. */
function projectedText(md: Markdown): string {
  let s = '';
  for (const e of walk(md.content)) {
    const proj = e.getContentProjection?.();
    if (proj?.text) s += proj.text;
  }
  return s;
}

const imagesOf = (md: Markdown): any[] => walk(md.content).filter((e) => e instanceof Image);

/** Every entity whose a11y attributes ask for an `<img>` tag. */
const imgTagged = (md: Markdown): any[] =>
  walk(md.content).filter((e) => e.getA11yAttributes?.()?.tag === 'img');

describe('display math is projected as text', () => {
  it('projects the TeX source of a $$ block', () => {
    const md = new Markdown('$$E = mc^2$$');
    expect(projectedText(md)).toContain('E = mc^2');
  });

  it('projects display and inline math alike', () => {
    // The reported asymmetry, as one assertion: both formulas in one document.
    const md = new Markdown('Inline $a+b$ here.\n\n$$c+d$$\n');
    const text = projectedText(md);
    expect(text).toContain('a+b');
    expect(text).toContain('c+d');
  });

  it('emits no <img> for a formula', () => {
    const md = new Markdown('$$E = mc^2$$');
    expect(imagesOf(md)).toHaveLength(0);
    expect(imgTagged(md)).toHaveLength(0);
  });

  it('reserves one inline object per display formula', () => {
    const md = new Markdown('$$x$$\n\n$$y$$\n');
    const objects = spansOf(md).filter((s) => s.object !== undefined);
    expect(objects).toHaveLength(2);
    expect(objects.map((s) => s.object?.alt)).toEqual(['x', 'y']);
  });

  it('uses a single U+FFFC as the span text', () => {
    const md = new Markdown('$$x$$');
    const objects = spansOf(md).filter((s) => s.object !== undefined);
    expect(objects).toHaveLength(1);
    expect(objects[0].text).toBe(OBJECT_REPLACEMENT);
  });

  it('does not leave the $$ delimiters visible', () => {
    const md = new Markdown('$$E = mc^2$$');
    const visible = spansOf(md)
      .map((s) => s.text)
      .join('');
    expect(visible).not.toContain('$');
  });

  it('projects a formula inside a list item', () => {
    // The #357 shape: the block child of a list item. Its formula must project
    // through the Stack the same way a top-level one does.
    const md = new Markdown('1. Step\n\n   $$a^2 + b^2 = c^2$$\n');
    expect(projectedText(md)).toContain('a^2 + b^2 = c^2');
  });

  it('marks the formula selectable', () => {
    const md = new Markdown('$$x$$');
    const withObject = walk(md.content).filter((e) =>
      (e.spans as StyledSpan[] | undefined)?.some((s) => s.object !== undefined),
    );
    expect(withObject).toHaveLength(1);
    expect(withObject[0].getContentProjection()?.selectable).toBe(true);
  });

  it('keeps the TeX source as the accessible name', () => {
    const md = new Markdown('$$E = mc^2$$');
    const labels = walk(md.content)
      .map((e) => e.getA11yAttributes?.()?.label)
      .filter((l): l is string => typeof l === 'string');
    expect(labels.some((l) => l.includes('E = mc^2'))).toBe(true);
  });

  it('still renders the glyphs', () => {
    // Projecting text must not cost the visual formula: the object carries a
    // painter and a non-zero box.
    const md = new Markdown('$$E = mc^2$$');
    const object = spansOf(md).find((s) => s.object !== undefined)?.object;
    expect(object).toBeDefined();
    expect(typeof object?.paint).toBe('function');
    expect(object!.width).toBeGreaterThan(0);
    expect(object!.height).toBeGreaterThan(0);
  });
});
