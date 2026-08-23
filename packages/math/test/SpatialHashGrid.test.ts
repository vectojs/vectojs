import { describe, it, expect } from 'vitest';
import { SpatialHashGrid } from '../src/SpatialHashGrid';

describe('SpatialHashGrid', () => {
  it('should return inserted entity in query', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('a', 10, 10, 20, 20);
    const result = grid.query(0, 0, 100, 100);
    expect(result.has('a')).toBe(true);
  });

  it('should not return entity after remove', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('a', 10, 10, 20, 20);
    grid.remove('a');
    const result = grid.query(0, 0, 100, 100);
    expect(result.has('a')).toBe(false);
  });

  it('should not return entity queried at wrong position', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('a', 10, 10, 20, 20); // in cell (0,0)
    const result = grid.query(500, 500, 10, 10); // far away
    expect(result.has('a')).toBe(false);
  });

  it('should clear all entities', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('a', 10, 10, 20, 20);
    grid.insert('b', 20, 20, 20, 20);
    grid.clear();
    expect(grid.query(0, 0, 200, 200).size).toBe(0);
  });

  it('should handle entity spanning multiple cells', () => {
    const grid = new SpatialHashGrid(64);
    grid.insert('big', 0, 0, 200, 200); // spans 4 cells (0,0)(1,0)(0,1)(1,1)
    expect(grid.query(100, 100, 10, 10).has('big')).toBe(true);
    expect(grid.query(0, 0, 10, 10).has('big')).toBe(true);
  });

  describe('Empty-cell eviction', () => {
    it('evicts emptied cells on remove so the grid map stays proportional to content', () => {
      const grid = new SpatialHashGrid(64);
      const cells = (g: SpatialHashGrid) =>
        (g as unknown as { grid: Map<number, Set<string>> }).grid.size;

      grid.insert('a', 10, 10, 20, 20);
      expect(cells(grid)).toBe(1);
      grid.remove('a');
      expect(cells(grid)).toBe(0);

      // Multi-cell entity: every touched cell must be evicted.
      grid.insert('big', 0, 0, 200, 200); // spans 4x4 cells at cellSize 64
      expect(cells(grid)).toBe(16);
      grid.remove('big');
      expect(cells(grid)).toBe(0);
    });

    it('keeps the cell map bounded across many insert/remove cycles', () => {
      const grid = new SpatialHashGrid(64);
      const cells = (g: SpatialHashGrid) =>
        (g as unknown as { grid: Map<number, Set<string>> }).grid.size;
      let peak = 0;
      for (let cycle = 0; cycle < 500; cycle++) {
        // Entities wander each cycle so fresh cells are touched constantly —
        // without eviction the map would grow monotonically with the union of
        // all visited cells instead of the live set.
        grid.insert('wanderer', cycle * 7.3, cycle * 5.1, 30, 30);
        grid.insert(`static-${cycle % 3}`, 100 + cycle * 3, 100, 20, 20);
        peak = Math.max(peak, cells(grid));
        grid.remove('wanderer');
        if (cycle >= 2) grid.remove(`static-${(cycle - 2) % 3}`);
      }
      expect(cells(grid)).toBeLessThanOrEqual(8);
      expect(peak).toBeLessThanOrEqual(12);
      // Exactly the two still-live static entities survive the final state.
      const survivors = [...grid.query(-10000, -10000, 20000, 20000)].sort();
      expect(survivors).toEqual(['static-0', 'static-1']);
    });

    it('still answers whole-grid fallback queries correctly after eviction', () => {
      const grid = new SpatialHashGrid(64);
      grid.insert('a', 10, 10, 20, 20);
      grid.remove('a');
      grid.insert('b', 500, 500, 64 * 3, 64 * 3); // oversized query below
      const result = grid.query(-10000, -10000, 20000, 20000); // huge -> fallback walk
      expect(result.has('a')).toBe(false);
      expect(result.has('b')).toBe(true);
    });
  });

  describe('Insert validation', () => {
    it.each([
      ['NaN width', 10, 10, Number.NaN, 20],
      ['NaN y', 10, Number.NaN, 20, 20],
      ['negative height', 0, 0, 50, -1],
      ['negative width', 0, 0, -0.5, 50],
      ['infinite x', Number.POSITIVE_INFINITY, 0, 10, 10],
    ])(
      'throws on %s instead of silently registering an unfindable entity',
      (_label, x, y, w, h) => {
        const grid = new SpatialHashGrid(64);
        expect(() => grid.insert('bad', x, y, w, h)).toThrow(
          /must be finite and width\/height non-negative/,
        );
      },
    );

    it('leaves a previously registered entity untouched when an insert throws', () => {
      const grid = new SpatialHashGrid(64);
      grid.insert('good', 10, 10, 20, 20);
      expect(() => grid.insert('good', 5, 5, Number.NaN, 5)).toThrow();
      expect(grid.query(0, 0, 100, 100).has('good')).toBe(true);
    });

    it('allows zero-size point entities', () => {
      const grid = new SpatialHashGrid(64);
      grid.insert('point', 70, 70, 0, 0);
      expect(grid.query(64, 64, 10, 10).has('point')).toBe(true);
      expect(grid.query(0, 0, 60, 60).has('point')).toBe(false);
    });
  });
});
