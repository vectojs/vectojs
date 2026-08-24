import { describe, expect, it } from 'vitest';
import {
  type GlyphAtlas,
  type InlineObject,
  LayoutEngine,
  LayoutResultBuffer,
  OBJECT_REPLACEMENT as OBJ,
  type StyledSpan,
} from '../src/LayoutEngine';

/**
 * Inline object advance reservation.
 *
 * A span carrying an {@link InlineObject} reserves horizontal advance for a box
 * the engine never shapes (a typeset formula, an icon). These tests pin the four
 * things that can silently break: the reserved advance is used instead of a glyph
 * measurement, the memo key distinguishes two differently-sized objects that
 * flatten to identical text, the streaming prefix cache notices a changed object,
 * and the box sits on the shared text baseline.
 */

// A deliberately wrong-width atlas: if any code path measures U+FFFC as a glyph
// instead of reading the reservation, the assertions below shift by 999.
const ATLAS: GlyphAtlas = {
  [OBJ]: { width: 999, baseSize: 16, ast: null },
  a: { width: 10, baseSize: 16, ast: null },
  b: { width: 10, baseSize: 16, ast: null },
  ' ': { width: 5, baseSize: 16, ast: null },
};

function engine(maxWidth = 1000): LayoutEngine {
  const e = new LayoutEngine();
  e.maxWidth = maxWidth;
  e.maxHeight = 10_000;
  return e;
}

const obj = (width: number, height = 20, depth?: number): InlineObject =>
  depth === undefined ? { width, height } : { width, height, depth };

describe('inline object advance reservation', () => {
  it('reserves the object width instead of measuring the sentinel glyph', () => {
    const e = engine();
    const spans: StyledSpan[] = [{ text: OBJ, object: obj(42) }];
    const prepared = e.prepareRich(spans, ATLAS, 16);
    const glyphs = prepared.paragraphs[0].words.flatMap((w) => w.glyphs);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].char).toBe(OBJ);
    // 42, not the atlas's deliberately-wrong 999.
    expect(glyphs[0].width).toBe(42);
    expect(glyphs[0].object).toEqual({ width: 42, height: 20 });
  });

  it('carries the object through to the positioned node', () => {
    const e = engine();
    const res = e.layoutPrepared(e.prepareRich([{ text: OBJ, object: obj(42, 20) }], ATLAS, 16));
    const node = res.nodes.find((n) => n.char === OBJ);
    expect(node).toBeDefined();
    expect(node!.width).toBe(42);
    expect(node!.height).toBe(20);
    expect(node!.object).toEqual({ width: 42, height: 20 });
  });

  it('advances following text by the reserved width', () => {
    const e = engine();
    const withObject = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: OBJ, object: obj(42) }, { text: 'b' }], ATLAS, 16),
    );
    const bWith = withObject.nodes.find((n) => n.char === 'b')!;
    // 'a' is 10 wide, then 42 reserved -> 'b' starts at 52.
    expect(bWith.x).toBe(52);
  });

  it('does not report a canvas fallback for the sentinel', () => {
    // U+FFFC is not expected in the atlas; counting it as a miss would report a
    // fallback that never happened.
    const bare: GlyphAtlas = { a: { width: 10, baseSize: 16, ast: null } };
    const e = engine();
    const prepared = e.prepareRich([{ text: 'a' }, { text: OBJ, object: obj(42) }], bare, 16);
    expect(prepared.fallbackToCanvas).toBeUndefined();
    const glyphs = prepared.paragraphs[0].words.flatMap((w) => w.glyphs);
    const objGlyph = glyphs.find((g) => g.char === OBJ)!;
    expect(objGlyph.atlasMiss).toBeUndefined();
  });

  it('ignores `object` on a span whose text is not the sentinel', () => {
    const e = engine();
    const prepared = e.prepareRich([{ text: 'ab', object: obj(42) }], ATLAS, 16);
    const glyphs = prepared.paragraphs[0].words.flatMap((w) => w.glyphs);
    // Measured as ordinary text: 10 + 10, and no object attached.
    expect(glyphs.map((g) => g.width)).toEqual([10, 10]);
    expect(glyphs.every((g) => g.object === undefined)).toBe(true);
  });

  it('wraps to the next line when the object does not fit', () => {
    const e = engine(60);
    const res = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: ' ' }, { text: OBJ, object: obj(55) }], ATLAS, 16),
    );
    const a = res.nodes.find((n) => n.char === 'a')!;
    const o = res.nodes.find((n) => n.char === OBJ)!;
    // 55 cannot follow 'a '(15) inside 60, so the object starts a new line.
    expect(o.y).toBeGreaterThan(a.y);
    expect(o.x).toBe(0);
  });
});

describe('inline object memo keying', () => {
  it('does not serve one object the metrics of a different-width one', () => {
    // THE regression this guards: both paragraphs flatten to the identical text
    // (one U+FFFC) with identical style, so a styleSig that omits the object
    // metrics produces byte-identical keys and the second is served the first's
    // layout. This is the CTX-0145 fontFamily bug in a new field.
    const e = engine();
    const first = e.prepareRich([{ text: OBJ, object: obj(42) }], ATLAS, 16);
    const second = e.prepareRich([{ text: OBJ, object: obj(80) }], ATLAS, 16);

    const w1 = first.paragraphs[0].words.flatMap((w) => w.glyphs)[0].width;
    const w2 = second.paragraphs[0].words.flatMap((w) => w.glyphs)[0].width;
    expect(w1).toBe(42);
    expect(w2).toBe(80);
  });

  it('distinguishes height and depth as well as width', () => {
    const e = engine();
    const a = e.layoutPrepared(e.prepareRich([{ text: OBJ, object: obj(42, 20, 0) }], ATLAS, 16));
    const b = e.layoutPrepared(e.prepareRich([{ text: OBJ, object: obj(42, 40, 10) }], ATLAS, 16));
    const na = a.nodes.find((n) => n.char === OBJ)!;
    const nb = b.nodes.find((n) => n.char === OBJ)!;
    expect(na.height).toBe(20);
    expect(nb.height).toBe(40);
    // Note `y` is NOT a useful discriminator here: whenever the object's own
    // ascent is what drives pMax, its top pins to the line top (y === 0) by
    // construction, for any height/depth. Both boxes above have ascent >= 20 at
    // 16px text, so both sit at 0 — the line grew around them. `height` and the
    // total line box are what differ.
    expect(b.totalHeight).toBeGreaterThan(a.totalHeight);
  });

  it('still reuses the memo for an identical object', () => {
    const e = engine();
    const spans = (): StyledSpan[] => [{ text: 'a' }, { text: OBJ, object: obj(42) }];
    e.prepareRich(spans(), ATLAS, 16);
    const before = e.cacheStats().richParagraph.hits;
    // A fresh array with a fresh object of equal value must still hit: the key is
    // value-based, so a caller rebuilding spans per chunk is not penalized.
    e.prepareRich(spans(), ATLAS, 16);
    expect(e.cacheStats().richParagraph.hits).toBeGreaterThan(before);
  });
});

describe('inline object streaming prefix reuse', () => {
  const widthOf = (r: ReturnType<LayoutEngine['prepareRich']>): number =>
    r.paragraphs[0].words.flatMap((w) => w.glyphs).find((g) => g.char === OBJ)!.width;

  it('reshapes when a RETAINED prefix object changes width', () => {
    // The object must be separated from the growing tail by whitespace for this to
    // bite. The hot path re-segments the whole trailing same-category run, and
    // U+FFFC is non-whitespace: with "\ufffca" -> "\ufffcab" the boundary walks back
    // PAST the object, `keep` becomes 0, and every word is reshaped anyway — so the
    // guard is never consulted. A space is a hard boundary the appended tail cannot
    // dissolve, so the object's word is genuinely retained from the cache.
    //
    // Verified by mutation: replacing the objectRangeEquals call with `true` makes
    // this return the stale 42, while the no-space shape still returns 80.
    const e = engine();
    e.prepareRich([{ text: OBJ, object: obj(42) }, { text: ' a' }], ATLAS, 16);
    const grown = e.prepareRich([{ text: OBJ, object: obj(80) }, { text: ' ab' }], ATLAS, 16);
    expect(widthOf(grown)).toBe(80);
  });

  it('reshapes a retained object several words back', () => {
    const e = engine();
    e.prepareRich([{ text: OBJ, object: obj(42) }, { text: ' a b' }], ATLAS, 16);
    const grown = e.prepareRich([{ text: OBJ, object: obj(80) }, { text: ' a ba' }], ATLAS, 16);
    expect(widthOf(grown)).toBe(80);
  });

  it('extends normally when the prefix object is unchanged', () => {
    const e = engine();
    e.prepareRich([{ text: OBJ, object: obj(42) }, { text: ' a' }], ATLAS, 16);
    const missesBefore = e.cacheStats().richParagraph.misses;
    const grown = e.prepareRich([{ text: OBJ, object: obj(42) }, { text: ' ab' }], ATLAS, 16);
    expect(widthOf(grown)).toBe(42);
    // Served by the streaming hot path, which builds no memo key — an unchanged
    // object must not force a fall-through to the cold path.
    expect(e.cacheStats().richParagraph.misses).toBe(missesBefore);
  });
});

describe('inline object baseline alignment', () => {
  it('sits the box bottom at baseline + depth', () => {
    const e = engine();
    const fontSize = 16;
    // A box shorter than the text: baseline is at pMax * 0.8 = 12.8 from line top.
    const res = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: OBJ, object: obj(10, 8, 0) }], ATLAS, fontSize),
    );
    const o = res.nodes.find((n) => n.char === OBJ)!;
    // depth 0 -> bottom on the baseline -> top = 12.8 - 8 = 4.8
    expect(o.y).toBeCloseTo(12.8 - 8, 5);
  });

  it('hangs the box below the baseline by its depth', () => {
    const e = engine();
    const noDepth = e.layoutPrepared(
      e.prepareRich([{ text: OBJ, object: obj(10, 8, 0) }], ATLAS, 16),
    );
    const withDepth = e.layoutPrepared(
      e.prepareRich([{ text: OBJ, object: obj(10, 8, 3) }], ATLAS, 16),
    );
    const a = noDepth.nodes.find((n) => n.char === OBJ)!;
    const b = withDepth.nodes.find((n) => n.char === OBJ)!;
    // Same box, 3px of it now below the baseline -> top moves DOWN by 3.
    expect(b.y - a.y).toBeCloseTo(3, 5);
  });

  it('grows the line so a tall object is not clipped', () => {
    const e = engine();
    const short = e.layoutPrepared(e.prepareRich([{ text: 'a' }], ATLAS, 16));
    // Ascent 100 far exceeds 16px text's 12.8 baseline offset.
    const tall = e.layoutPrepared(
      e.prepareRich([{ text: 'a' }, { text: OBJ, object: obj(10, 100, 0) }], ATLAS, 16),
    );
    expect(tall.totalHeight).toBeGreaterThan(short.totalHeight);
    const o = tall.nodes.find((n) => n.char === OBJ)!;
    // The box must start at or below the line top, never above it.
    expect(o.y).toBeGreaterThanOrEqual(0);
  });

  it('shares one baseline between the object and surrounding text', () => {
    const e = engine();
    const res = e.layoutPrepared(
      e.prepareRich(
        [{ text: 'a' }, { text: OBJ, object: obj(10, 100, 0) }, { text: 'b' }],
        ATLAS,
        16,
      ),
    );
    const a = res.nodes.find((n) => n.char === 'a')!;
    const b = res.nodes.find((n) => n.char === 'b')!;
    const o = res.nodes.find((n) => n.char === OBJ)!;
    // Text on both sides of the object stays on one baseline.
    expect(a.y).toBeCloseTo(b.y, 5);
    // And the object's bottom lands on that same baseline (ascent 100, depth 0).
    expect(o.y + 100).toBeCloseTo(a.y + 16 * 0.8, 1);
  });
});

describe('inline objects across the fast paths', () => {
  it('measurePrepared grows the line for tall objects like the full path', () => {
    const e = engine();
    const spans: StyledSpan[] = [
      { text: 'a' },
      { text: OBJ, object: obj(30, 40, 12) },
      { text: ' b' },
    ];
    const prepared = e.prepareRich(spans, ATLAS, 16);
    const measured = e.measurePrepared(prepared);
    const laidOut = e.layoutPrepared(prepared);
    expect(measured.lineCount).toBe(1);
    // Ascent 28 grows pMax to 35 (lineHeight max(52.5, 40) = 52.5), not the
    // plain-text 24 a fontSize-only walk reports.
    expect(measured.height).toBeCloseTo(laidOut.totalHeight, 5);
    expect(measured.height).toBeGreaterThan(40);
  });

  it('buffer path sizes and places the object box like the full path', () => {
    const e = engine();
    const spans: StyledSpan[] = [{ text: 'a' }, { text: OBJ, object: obj(30, 40, 12) }];
    const prepared = e.prepareRich(spans, ATLAS, 16);
    const nodes = e.layoutPrepared(prepared).nodes;
    const buffer = new LayoutResultBuffer();
    e.layoutPreparedIntoBuffer(prepared, buffer);

    expect(buffer.count).toBe(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      expect(buffer.chars[i]).toBe(nodes[i].char);
      expect(buffer.ws[i]).toBeCloseTo(nodes[i].width, 4);
      expect(buffer.hs[i]).toBeCloseTo(nodes[i].height, 4);
      expect(buffer.ys[i]).toBeCloseTo(nodes[i].y, 4);
    }
    // The object slot carries the real box height, not the paragraph fontSize.
    const objIdx = buffer.chars.slice(0, buffer.count).indexOf(OBJ);
    expect(buffer.hs[objIdx]).toBe(40);
  });
});
