import { describe, it, expect } from 'vitest';
import { Entity } from '@vectojs/core';
import { auditTree } from '../src/audit';

/**
 * The sibling-overlap check used to be an all-pairs double loop: O(k²)
 * intersection tests AND O(k²) `worldBox()` calls (the inner loop recomputed the
 * other box every time), so a container with many children — a long list, a wide
 * table — made the audit quadratic in exactly the thing you want to audit. It is
 * now broad-phased through a `SpatialHashGrid`.
 *
 * These tests pin that the broad-phase reports the SAME SET of findings as an
 * exhaustive all-pairs comparison, since a behavior change here would silently
 * drop real layout bugs. (Emission *order* is compared as a sorted set: the
 * audit walks the tree per-parent and has never guaranteed a global pair order.)
 */
class Box extends Entity {
  constructor(id: string, x: number, y: number, w: number, h: number) {
    super(id);
    this.setPosition(x, y);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

/** Exhaustive reference implementation of the same rule. */
function allPairsOverlaps(kids: Entity[], tolerance = 0.5): string[] {
  const out: string[] = [];
  for (let i = 0; i < kids.length; i++) {
    const a = kids[i];
    if (a.opacity <= 0 || a.width <= 0 || a.height <= 0) continue;
    const ab = a.getWorldBounds();
    for (let j = i + 1; j < kids.length; j++) {
      const b = kids[j];
      if (b.opacity <= 0 || b.width <= 0 || b.height <= 0) continue;
      const bb = b.getWorldBounds();
      const x = Math.max(ab.x, bb.x);
      const y = Math.max(ab.y, bb.y);
      const r = Math.min(ab.x + ab.width, bb.x + bb.width);
      const bo = Math.min(ab.y + ab.height, bb.y + bb.height);
      if (r - x > tolerance && bo - y > tolerance) out.push(`${a.id}|${b.id}`);
    }
  }
  return out.sort();
}

// `null` sceneBounds = skip viewport-overflow findings; we only want overlaps.
const overlapPairs = (root: Entity): string[] =>
  auditTree(root, null)
    .filter((f) => f.kind === 'overlap')
    .map((f) => `${f.entityId}|${f.otherId}`)
    .sort();

describe('sibling-overlap broad phase matches all-pairs', () => {
  const parentOf = (kids: Entity[]): Entity => {
    const p = new Box('parent', 0, 0, 0, 0); // unsized: no own overflow findings
    for (const k of kids) p.add(k);
    return p;
  };

  it('finds a simple overlapping pair', () => {
    const kids = [new Box('a', 0, 0, 50, 50), new Box('b', 25, 25, 50, 50)];
    expect(overlapPairs(parentOf(kids))).toEqual(['a|b']);
  });

  it('reports nothing for disjoint siblings', () => {
    const kids = [new Box('a', 0, 0, 50, 50), new Box('b', 200, 200, 50, 50)];
    expect(overlapPairs(parentOf(kids))).toEqual([]);
  });

  it('ignores sub-tolerance slivers (same as before)', () => {
    // 0.25px overlap — below the 0.5 default tolerance.
    const kids = [new Box('a', 0, 0, 50, 50), new Box('b', 49.75, 0, 50, 50)];
    expect(overlapPairs(parentOf(kids))).toEqual([]);
  });

  it('matches all-pairs on a dense grid of overlapping boxes', () => {
    // 12×12 boxes on a 30px pitch with 50px extents → every box overlaps its
    // neighbours, producing many pairs across many grid cells.
    const kids: Entity[] = [];
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        kids.push(new Box(`n${r}_${c}`, c * 30, r * 30, 50, 50));
      }
    }
    const expected = allPairsOverlaps(kids);
    expect(expected.length).toBeGreaterThan(100); // the case is actually dense
    expect(overlapPairs(parentOf(kids))).toEqual(expected);
  });

  it('matches all-pairs when box sizes vary wildly (cell-size robustness)', () => {
    // One huge box spanning everything plus many small ones: the huge box must
    // still be paired with each small box it covers.
    const kids: Entity[] = [new Box('huge', 0, 0, 1000, 200)];
    for (let i = 0; i < 30; i++) kids.push(new Box(`s${i}`, i * 30, 50, 20, 20));
    const expected = allPairsOverlaps(kids);
    expect(overlapPairs(parentOf(kids))).toEqual(expected);
  });

  it('matches all-pairs for a sparse long list (the common non-overlap case)', () => {
    const kids: Entity[] = [];
    for (let i = 0; i < 200; i++) kids.push(new Box(`row${i}`, 0, i * 24, 300, 22));
    expect(overlapPairs(parentOf(kids))).toEqual(allPairsOverlaps(kids));
  });

  it('skips invisible and zero-sized siblings', () => {
    const hidden = new Box('hidden', 0, 0, 50, 50);
    hidden.opacity = 0;
    const zero = new Box('zero', 0, 0, 0, 0);
    const kids = [new Box('a', 0, 0, 50, 50), hidden, zero, new Box('b', 10, 10, 50, 50)];
    expect(overlapPairs(parentOf(kids))).toEqual(['a|b']);
  });

  it('honors the ignoreOverlap predicate', () => {
    const kids = [new Box('a', 0, 0, 50, 50), new Box('b', 25, 25, 50, 50)];
    const findings = auditTree(parentOf(kids), null, {
      ignoreOverlap: (x, y) => (x.id === 'a' && y.id === 'b') || (x.id === 'b' && y.id === 'a'),
    }).filter((f) => f.kind === 'overlap');
    expect(findings).toEqual([]);
  });
});
