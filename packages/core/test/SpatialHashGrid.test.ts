import { describe, it, expect } from 'vitest';
import { SpatialHashGrid } from '../src/math/SpatialHashGrid';

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
});
