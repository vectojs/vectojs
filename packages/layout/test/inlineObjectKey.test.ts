import { describe, expect, it } from 'vitest';
import { LayoutEngine, OBJECT_REPLACEMENT } from '../src/index';

/**
 * An object span's memo key must identify what the object PAINTS.
 *
 * `prepareRich` memoizes prepared paragraphs, and a memo hit reuses the cached
 * paragraph's `InlineObject` — including its `paint` closure, which is
 * deliberately excluded from the key because a fresh closure per call never
 * compares equal and would defeat the memo entirely.
 *
 * That is safe when the drawing is a function of `alt`, which is in the key:
 * inline math's data URI is a pure function of the TeX source it also announces.
 * It is NOT safe for an image, whose picture is chosen by its URL while `alt` is
 * human prose. Measured before this test existed: two spans with identical
 * metrics and identical `alt` but different painters produced a memo hit, and the
 * second paragraph painted the FIRST one's image.
 *
 * `key` closes that. These tests pin both directions — that a differing `key`
 * separates two otherwise-identical objects, and that an equal one still shares —
 * because a key that always differs is as broken as one that never does: it turns
 * every lookup into a miss and the memo into pure overhead, with slowness as the
 * only symptom.
 */

const FONT = '16px sans-serif';

/** A span whose painter records `tag`, so a memo hit is observable. */
function objectSpan(tag: string, alt: string, into: string[], key?: string) {
  return {
    text: OBJECT_REPLACEMENT,
    object: {
      width: 20,
      height: 20,
      depth: 0,
      alt,
      key,
      paint: () => into.push(tag),
    },
  };
}

/** Invoke every painter reachable from a prepared result, in encounter order. */
function runPainters(prepared: unknown): void {
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const obj = (node as { object?: { paint?: () => void } }).object;
    obj?.paint?.();
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) for (const v of value) walk(v);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(prepared);
}

describe('InlineObject.key in the paragraph memo', () => {
  it('separates two objects that differ only in what they paint', () => {
    const engine = new LayoutEngine();
    const painted: string[] = [];

    const first = engine.prepareRich(
      [{ text: 'x ' }, objectSpan('FIRST', 'badge', painted, 'pass.svg')],
      FONT,
      400,
    );
    const second = engine.prepareRich(
      [{ text: 'x ' }, objectSpan('SECOND', 'badge', painted, 'fail.svg')],
      FONT,
      400,
    );

    painted.length = 0;
    runPainters(first);
    expect(painted).toEqual(['FIRST']);

    painted.length = 0;
    runPainters(second);
    // Without `key` in the fingerprint this was ['FIRST'] — the second row of a
    // badge column painted the first row's badge.
    expect(painted).toEqual(['SECOND']);
  });

  it('still shares a paragraph when the key matches', () => {
    const engine = new LayoutEngine();
    const painted: string[] = [];
    engine.prepareRich([{ text: 'x ' }, objectSpan('A', 'badge', painted, 'pass.svg')], FONT, 400);
    const before = engine.cacheStats().richParagraph.hits;
    engine.prepareRich([{ text: 'x ' }, objectSpan('B', 'badge', painted, 'pass.svg')], FONT, 400);
    // Same key, so the memo is allowed to hit. This is the arm that fails if `key`
    // is made to vary per call rather than per drawing.
    expect(engine.cacheStats().richParagraph.hits).toBeGreaterThan(before);
  });

  it('rejects a streamed prefix that would keep a stale painter', () => {
    // A SECOND code path, gated by `objectRangeEquals` rather than by the memo
    // key: `prepareRich`'s strict-extension branch keeps the already-shaped prefix
    // words, and each kept glyph holds the `InlineObject` it was shaped with. So an
    // object inside the KEPT prefix keeps its old painter, and a document that
    // grows while that object's picture changed paints the old one.
    //
    // The object must sit in the preserved prefix for this to bite, which is why
    // settled text follows it: the branch reshapes the whole trailing
    // same-category run, so an object at the very end lands in that reshape and is
    // rebuilt from the fresh spans anyway. An earlier version of this test put it
    // last and passed under sabotage — vacuously.
    const engine = new LayoutEngine();
    const painted: string[] = [];

    engine.prepareRich(
      [{ text: 'x ' }, objectSpan('FIRST', 'badge', painted, 'pass.svg'), { text: ' tail ' }],
      FONT,
      400,
    );
    const extended = engine.prepareRich(
      [{ text: 'x ' }, objectSpan('SECOND', 'badge', painted, 'fail.svg'), { text: ' tail more' }],
      FONT,
      400,
    );

    painted.length = 0;
    for (const word of extended.paragraphs[0].words) {
      for (const glyph of word.glyphs ?? []) glyph.object?.paint?.();
    }
    // Without `key` in `objectRangeEquals` this was ['FIRST'].
    expect(painted).toEqual(['SECOND']);
  });

  it('leaves objects that set no key sharing exactly as before', () => {
    const engine = new LayoutEngine();
    const painted: string[] = [];
    engine.prepareRich([{ text: 'x ' }, objectSpan('A', '\\alpha', painted)], FONT, 400);
    const before = engine.cacheStats().richParagraph.hits;
    engine.prepareRich([{ text: 'x ' }, objectSpan('B', '\\alpha', painted)], FONT, 400);
    // Inline math is this case: the URI is a pure function of the alt text, so
    // adding `key` must not cost it its memo.
    expect(engine.cacheStats().richParagraph.hits).toBeGreaterThan(before);
  });
});
