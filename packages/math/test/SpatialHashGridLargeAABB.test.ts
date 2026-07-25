import { describe, it, expect } from 'vitest';
import { SpatialHashGrid } from '../src/SpatialHashGrid';

/**
 * Cell enumeration is O(area / cellSize²), so a single large AABB used to be
 * pathological: measured 790µs per query over a 10000×10000 region and 1.2ms to
 * insert one 6400×6400 box at cellSize 64. Boxes that would span too many cells
 * are now held in a separate oversized list and tested directly, and an
 * oversized QUERY walks the occupied cells instead of its own area.
 *
 * The risk that matters is a broad phase that silently DROPS a candidate, so
 * these are differential against an exhaustive AABB scan.
 */
describe('SpatialHashGrid large-AABB handling', () => {
  type Box = { id: string; x: number; y: number; w: number; h: number };

  const overlaps = (a: Box, q: Box) =>
    q.x < a.x + a.w && q.x + q.w > a.x && q.y < a.y + a.h && q.y + q.h > a.y;

  /** Every id whose AABB truly overlaps the query — the reference answer. */
  const reference = (boxes: Box[], q: Box) =>
    boxes
      .filter((b) => overlaps(b, q))
      .map((b) => b.id)
      .sort();

  /**
   * The grid may return a superset (cell granularity), so the contract is:
   * it must never MISS a true overlap.
   */
  const expectNoMisses = (boxes: Box[], queries: Box[], cellSize = 64) => {
    const grid = new SpatialHashGrid(cellSize);
    for (const b of boxes) grid.insert(b.id, b.x, b.y, b.w, b.h);
    for (const q of queries) {
      const got = grid.query(q.x, q.y, q.w, q.h);
      for (const id of reference(boxes, q)) {
        expect(got.has(id), `missed ${id} for query ${JSON.stringify(q)}`).toBe(true);
      }
    }
  };

  it('finds a small box overlapping a small query', () => {
    expectNoMisses(
      [{ id: 'a', x: 0, y: 0, w: 32, h: 32 }],
      [{ id: 'q', x: 16, y: 16, w: 32, h: 32 }],
    );
  });

  it('finds an OVERSIZED box from a small query', () => {
    // 6400×6400 at cellSize 64 = 10k cells → goes to the oversized list.
    expectNoMisses(
      [{ id: 'huge', x: 0, y: 0, w: 6400, h: 6400 }],
      [
        { id: 'q1', x: 10, y: 10, w: 8, h: 8 },
        { id: 'q2', x: 6000, y: 6000, w: 8, h: 8 },
      ],
    );
  });

  it('does NOT return an oversized box the query misses', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('huge', 0, 0, 6400, 6400);
    expect(grid.query(7000, 7000, 10, 10).has('huge')).toBe(false);
  });

  it('finds small boxes from an OVERSIZED query', () => {
    const boxes: Box[] = [];
    for (let i = 0; i < 40; i++) boxes.push({ id: `s${i}`, x: i * 200, y: i * 150, w: 20, h: 20 });
    expectNoMisses(boxes, [{ id: 'q', x: 0, y: 0, w: 10000, h: 10000 }]);
  });

  it('handles a mix of oversized and small, both directions', () => {
    const boxes: Box[] = [
      { id: 'huge', x: 0, y: 0, w: 8000, h: 8000 },
      { id: 'wide', x: 0, y: 100, w: 9000, h: 4 },
    ];
    for (let i = 0; i < 30; i++)
      boxes.push({ id: `s${i}`, x: i * 137, y: 90 + (i % 5), w: 16, h: 16 });
    expectNoMisses(boxes, [
      { id: 'small', x: 300, y: 95, w: 10, h: 10 },
      { id: 'big', x: 0, y: 0, w: 9000, h: 9000 },
      { id: 'far', x: 20000, y: 20000, w: 10, h: 10 },
    ]);
  });

  it('remove() clears an oversized entry', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('huge', 0, 0, 6400, 6400);
    expect(grid.query(10, 10, 8, 8).has('huge')).toBe(true);
    grid.remove('huge');
    expect(grid.query(10, 10, 8, 8).has('huge')).toBe(false);
  });

  it('re-inserting the same id updates its geometry (small → oversized)', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('x', 0, 0, 32, 32);
    grid.insert('x', 5000, 5000, 6400, 6400); // now oversized, moved away
    expect(grid.query(10, 10, 8, 8).has('x')).toBe(false);
    expect(grid.query(6000, 6000, 8, 8).has('x')).toBe(true);
  });

  it('re-inserting the same id updates its geometry (oversized → small)', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('x', 0, 0, 6400, 6400);
    grid.insert('x', 10, 10, 16, 16);
    expect(grid.query(5000, 5000, 8, 8).has('x')).toBe(false);
    expect(grid.query(12, 12, 4, 4).has('x')).toBe(true);
  });

  it('clear() empties the oversized list too', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('huge', 0, 0, 6400, 6400);
    grid.clear();
    expect(grid.query(10, 10, 8, 8).size).toBe(0);
  });

  it('a large-AABB query is no longer O(area)', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('a', 0, 0, 32, 32);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) grid.query(0, 0, 10000, 10000);
    const perQuery = (performance.now() - t0) / 50;
    // Was ~790us/query before (24649 cells enumerated); the occupied-cell walk
    // is bounded by content, so this is orders of magnitude below that.
    expect(perQuery).toBeLessThan(100);
  });

  it('inserting one huge AABB is no longer O(area)', () => {
    const grid = new SpatialHashGrid(64);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) grid.insert(`h${i}`, 0, 0, 6400, 6400);
    const perInsert = (performance.now() - t0) / 50;
    expect(perInsert).toBeLessThan(100); // was ~1218us
  });
});
