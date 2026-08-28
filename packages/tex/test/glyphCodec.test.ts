import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLYPH_TABLE_BASE64 } from '../src/glyphs/glyphs.subset';
import {
  base64ToBytes,
  ByteReader,
  FORMAT_VERSION,
  GlyphTable,
  MAGIC_0,
  MAGIC_1,
  MAX_CACHED_MISSES,
} from '../src/emit/glyphCodec';
import { getGlyph, shippedFonts, shippedGlyphCount, unitsPerEm } from '../src/emit/glyphTable';

/**
 * Phase 2 acceptance: the binary glyph table decodes to exactly the outlines the
 * emit layer was validated against.
 *
 * The emit layer is validated 26/26 against real KaTeX in a browser, and that
 * validation attaches to the SVG path strings `generate-glyphs.ts` produced. This
 * re-encoding is therefore correct precisely when it is *lossless against those
 * strings*, so the central test is byte equality across the whole table rather
 * than a geometric tolerance.
 *
 * Byte equality is also strictly stronger than the geometric check it replaces.
 * Measured during Phase 1, a bbox+area comparison is blind to 4 of 5 realistic
 * glyph corruptions — an interior coordinate shift, a moved control point, a
 * dropped contour, and sub-unit noise all pass it; only a y-flip was caught.
 * String equality is blind to none of those, which is why the geometric assertion
 * below exists only as a *second*, independent formulation rather than as the
 * primary gate.
 */

const SUBSET_JSON = join(import.meta.dirname, '../src/glyphs/glyphs.subset.json');

interface SubsetTable {
  unitsPerEm: Record<string, number>;
  glyphs: Record<string, Record<string, { path: string; advance: number }>>;
}

const source = JSON.parse(readFileSync(SUBSET_JSON, 'utf8')) as SubsetTable;

/** Every (face, codepoint, glyph) triple in the source table. */
function sourceGlyphs(): {
  font: string;
  code: number;
  path: string;
  advance: number;
}[] {
  const out: { font: string; code: number; path: string; advance: number }[] = [];
  for (const font of Object.keys(source.glyphs)) {
    for (const code of Object.keys(source.glyphs[font])) {
      const g = source.glyphs[font][code];
      out.push({ font, code: Number(code), path: g.path, advance: g.advance });
    }
  }
  return out;
}

describe('glyph table binary codec', () => {
  it('decodes every shipped glyph to byte-identical SVG path data', () => {
    const all = sourceGlyphs();
    // Guard the guard: an empty source would make the loop below vacuously pass.
    // Exact rather than a lower bound so an unintended *shrink* fails too — the
    // corpus is subset in both display modes, and a regression that dropped one
    // mode would quietly cut the table back to 561. 666 is the count after the
    // #666 corpus extension (Script-Regular, Math-BoldItalic, italic digits,
    // the \approx/\hbar/\ell/\Re/… symbols) plus CTX-0529 (setminus/bigcup/underscore/overline),
    // 671 after CTX-0040 (SpatialHashGrid floor/cases).
    expect(all.length).toBe(671);

    const mismatches: string[] = [];
    for (const want of all) {
      const got = getGlyph(want.font, want.code);
      if (!got) {
        mismatches.push(`${want.font} U+${want.code.toString(16)}: absent`);
        continue;
      }
      if (got.path !== want.path) {
        mismatches.push(`${want.font} U+${want.code.toString(16)}: path differs`);
      }
      if (got.advance !== want.advance) {
        mismatches.push(
          `${want.font} U+${want.code.toString(16)}: advance ${got.advance} != ${want.advance}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reports the same faces and glyph count as its source', () => {
    expect(shippedFonts().sort()).toEqual(Object.keys(source.glyphs).sort());
    expect(shippedGlyphCount()).toBe(sourceGlyphs().length);
    for (const font of Object.keys(source.glyphs)) {
      expect(unitsPerEm(font), font).toBe(source.unitsPerEm[font]);
    }
  });

  it('returns undefined for a glyph outside the whitelist, repeatably', () => {
    // A miss must be a quiet `undefined` rather than a throw: the emit layer
    // records it in `EmitResult.missing` and degrades.
    //
    // This deliberately does *not* claim to verify that misses are cached. A
    // cached miss and a re-derived miss are indistinguishable from outside the
    // class — both return `undefined` — so an assertion phrased as "caches the
    // miss" would be untestable decoration. Verified by sabotage: breaking the
    // `has`-based lookup to a truthiness check (which re-decodes every miss) left
    // this test green, so the claim was dropped rather than left to imply cover
    // it does not have.
    expect(getGlyph('Main-Regular', 0x1_f600)).toBeUndefined();
    expect(getGlyph('No-Such-Face', 65)).toBeUndefined();
    expect(getGlyph('Main-Regular', 0x1_f600)).toBeUndefined();
  });

  it('decodes each outline once, returning the same object on repeat requests', () => {
    // Object identity is the one part of the caching that *is* observable, and it
    // is what makes repeated `getGlyph` calls cheap: `emitSVG` asks for the same
    // glyph once per occurrence, so a formula with twenty `x`s must not expand
    // twenty path strings.
    const first = getGlyph('Main-Regular', 120);
    const second = getGlyph('Main-Regular', 120);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('preserves geometry per contour, not merely per bounding box', () => {
    // An independent formulation of the same claim, expressed geometrically so it
    // would survive a hypothetical future change to path *formatting* that left
    // the outlines intact. Compares contour count and per-vertex position with a
    // symmetric nearest-neighbour deviation, because a bbox+area check passes a
    // broken encoder.
    for (const want of sourceGlyphs()) {
      const got = getGlyph(want.font, want.code)!;
      const a = contourVertices(want.path);
      const b = contourVertices(got.path);
      const label = `${want.font} U+${want.code.toString(16)}`;

      expect(b.length, `${label}: contour count`).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(b[i].length, `${label}: contour ${i} vertex count`).toBe(a[i].length);
        let worst = 0;
        for (let k = 0; k < a[i].length; k++) {
          worst = Math.max(worst, Math.hypot(a[i][k][0] - b[i][k][0], a[i][k][1] - b[i][k][1]));
        }
        // Zero, not a tolerance: the coordinates are integers recovered exactly.
        expect(worst, `${label}: contour ${i} worst vertex deviation`).toBe(0);
      }
    }
  });

  it('rejects a table with bad magic or an unknown version', () => {
    const good = base64ToBytes(GLYPH_TABLE_BASE64);

    const badMagic = good.slice();
    badMagic[0] = MAGIC_0 ^ 0xff;
    expect(() => new GlyphTable(badMagic)).toThrow(/bad magic/);

    const badVersion = good.slice();
    badVersion[2] = FORMAT_VERSION + 1;
    expect(() => new GlyphTable(badVersion)).toThrow(/unsupported version/);

    // The unmodified bytes must still construct, or the two assertions above
    // could be passing for an unrelated reason.
    expect(() => new GlyphTable(good)).not.toThrow();
    expect(good[0]).toBe(MAGIC_0);
    expect(good[1]).toBe(MAGIC_1);
  });

  it('round-trips varints across the ranges the table actually uses', () => {
    // Pinned to independent constants rather than to values derived from the
    // table, so the assertion cannot be satisfied by a coincidence between two
    // measured quantities.
    const values = [0, 1, -1, 63, 64, -64, 127, 128, -128, 8191, 8192, -8192, 1450, -949, 2399];
    for (const v of values) {
      const bytes: number[] = [];
      const zig = v < 0 ? -v * 2 - 1 : v * 2;
      let x = zig;
      while (x >= 0x80) {
        bytes.push((x & 0x7f) | 0x80);
        x >>>= 7;
      }
      bytes.push(x);
      expect(new ByteReader(new Uint8Array(bytes)).svar(), `svar ${v}`).toBe(v);
    }
  });

  it('keeps sideEffects true, without which the built bundle cannot typeset', () => {
    // `package.json` cannot carry a comment, and this field looks like an obvious
    // tree-shaking win, so it needs a test to stop it being "optimised" back.
    //
    // The vendored kernel fills its function and symbol registries through import
    // side effects. With `sideEffects: false` the bundler is entitled to drop
    // those imports, and it does: measured on main at d406a9a, the built
    // `dist/index.mjs` threw "Got group of unknown type: 'mathord'" for `x` and
    // "Undefined control sequence: \\frac" for a fraction. Every test in this
    // package passed regardless, because vitest aliases the package to `src/` and
    // so never loads the bundle — which is exactly why the defect survived.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { sideEffects?: unknown };
    expect(manifest.sideEffects).toBe(true);
  });

  it('handles a glyph with an empty outline', () => {
    // U+00A0 (nbsp) in Main-Regular has an advance but no contours. It is the one
    // glyph for which a corrupted coordinate stream cannot be detected, so its
    // presence is asserted explicitly rather than left implicit in the sweep.
    const nbsp = getGlyph('Main-Regular', 160);
    expect(nbsp).toBeDefined();
    expect(nbsp!.path).toBe('');
    expect(nbsp!.advance).toBeGreaterThan(0);
  });

  it('bounds its negative cache so adversarial codepoints cannot grow memory', () => {
    // Long-lived SSR rendering untrusted input can request unbounded distinct
    // codepoints, and every miss used to cache a permanent entry. The negative
    // side must therefore evict FIFO once it reaches the cap; the positive side
    // needs no cap of its own because it is bounded by the shipped glyph count.
    const table = new GlyphTable(base64ToBytes(GLYPH_TABLE_BASE64));
    const cachedMisses = () => (table as unknown as { missQueue: string[] }).missQueue.length;

    const firstMissCode = 0x10_0000; // private-use area: nothing ships there
    for (let i = 0; i < MAX_CACHED_MISSES + 50; i++) {
      table.get('Main-Regular', firstMissCode + i);
      expect(cachedMisses(), `after ${i + 1} misses`).toBeLessThanOrEqual(MAX_CACHED_MISSES);
    }

    // Eviction must not have touched positives or changed miss results.
    expect(table.get('Main-Regular', 120)).toBeDefined();
    expect(table.get('Main-Regular', firstMissCode)).toBeUndefined();
  });
});

/**
 * Extracts each contour's vertex list from SVG path data.
 *
 * Records every coordinate pair each command carries, so a moved control point
 * is a difference rather than being averaged away.
 */
function contourVertices(path: string): [number, number][][] {
  const contours: [number, number][][] = [];
  let current: [number, number][] = [];
  const re = /([MLQZ])([^MLQZ]*)/g;
  for (;;) {
    const m = re.exec(path);
    if (m === null) break;
    if (m[1] === 'Z') {
      contours.push(current);
      current = [];
      continue;
    }
    const nums = (m[2].match(/-?[0-9]*\.?[0-9]+/g) ?? []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) current.push([nums[i], nums[i + 1]]);
  }
  if (current.length > 0) contours.push(current);
  return contours;
}
