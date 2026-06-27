import { describe, it, expect } from 'vitest';
import {
  LayoutEngine,
  computeLineSegments,
  type GlyphMeasurer,
  type ExclusionRect,
} from '../src/layout/LayoutEngine';

// Width ∝ fontSize so positions are exact; every char is 0.5em wide.
const measurer: GlyphMeasurer = { measure: (_char, fontSize) => fontSize * 0.5 };
const EMPTY_ATLAS = {};

describe('computeLineSegments — free x-ranges in a horizontal band', () => {
  it('returns the full width when there are no exclusions', () => {
    expect(computeLineSegments(0, 30, 200, [])).toEqual([{ x0: 0, x1: 200 }]);
  });

  it('carves a left float off the left edge', () => {
    const ex: ExclusionRect[] = [{ x: 0, y: 0, width: 40, height: 30 }];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([{ x0: 40, x1: 200 }]);
  });

  it('carves a right float off the right edge', () => {
    const ex: ExclusionRect[] = [{ x: 160, y: 0, width: 40, height: 30 }];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([{ x0: 0, x1: 160 }]);
  });

  it('splits the line into two when an exclusion sits in the middle', () => {
    const ex: ExclusionRect[] = [{ x: 80, y: 0, width: 40, height: 30 }];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([
      { x0: 0, x1: 80 },
      { x0: 120, x1: 200 },
    ]);
  });

  it('ignores an exclusion that does not vertically overlap the band', () => {
    const ex: ExclusionRect[] = [{ x: 0, y: 100, width: 40, height: 30 }];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([{ x0: 0, x1: 200 }]);
  });

  it('returns no segments when an exclusion spans the whole width', () => {
    const ex: ExclusionRect[] = [{ x: 0, y: 0, width: 200, height: 30 }];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([]);
  });

  it('merges overlapping exclusions before subtracting', () => {
    const ex: ExclusionRect[] = [
      { x: 0, y: 0, width: 50, height: 30 },
      { x: 30, y: 0, width: 40, height: 30 }, // overlaps the first → union [0,70]
    ];
    expect(computeLineSegments(0, 30, 200, ex)).toEqual([{ x0: 70, x1: 200 }]);
  });
});

describe('layoutPrepared — text flow around rect exclusions', () => {
  it('is byte-for-byte unchanged when no exclusions are given', () => {
    const e = new LayoutEngine(200, 1000, measurer);
    const prepared = e.prepare('aaaa bbbb cccc dddd', EMPTY_ATLAS, 20);
    const base = e.layoutPrepared(prepared);
    const empty = e.layoutPrepared(prepared, undefined, []);
    expect(empty.nodes).toEqual(base.nodes);
    expect(empty.totalHeight).toBe(base.totalHeight);
  });

  it('indents the lines a left float covers, then reclaims the full width below it', () => {
    const e = new LayoutEngine(200, 1000, measurer);
    // 20px font → char 10px, word "aaaa" 40px, lineHeight 30px.
    const prepared = e.prepare('aaaa bbbb cccc dddd', EMPTY_ATLAS, 20);
    // Left float covering only the first line band [0,30).
    const result = e.layoutPrepared(prepared, undefined, [{ x: 0, y: 0, width: 60, height: 30 }]);

    const firstLine = result.nodes.filter((n) => n.y < 30);
    expect(Math.min(...firstLine.map((n) => n.x))).toBe(60); // pushed past the float

    const below = result.nodes.filter((n) => n.y >= 30);
    expect(below.length).toBeGreaterThan(0);
    expect(Math.min(...below.map((n) => n.x))).toBe(0); // full width reclaimed
  });
});
