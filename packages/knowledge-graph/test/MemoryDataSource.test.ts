import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/MemoryDataSource';
import type { KgGraphData } from '../src/types';

const SAMPLE: KgGraphData = {
  entities: [
    { id: 'a', type: 'Person', labels: { en: 'Ada' } },
    { id: 'b', type: 'Person', labels: { en: 'Bob' } },
    { id: 'c', type: 'Org', labels: { en: 'Corp' } },
  ],
  facts: [
    { source: 'a', target: 'b', predicate: 'knows' },
    { source: 'a', target: 'c', predicate: 'worksAt' },
    { source: 'b', target: 'c', predicate: 'worksAt' },
  ],
};

describe('MemoryDataSource', () => {
  it('returns no entity for an unknown id instead of fabricating a placeholder', () => {
    const src = new MemoryDataSource(SAMPLE);
    const hood = src.getNeighbors('missing');
    expect(hood.entity).toBeUndefined();
    expect(hood.facts).toEqual([]);
    expect(hood.neighbors).toEqual([]);
  });

  it('returns seed nodes by id', () => {
    const src = new MemoryDataSource(SAMPLE);
    expect(src.getNodes(['a', 'c']).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('expands both directions by default', () => {
    const src = new MemoryDataSource(SAMPLE);
    const hood = src.getNeighbors('c');
    expect(hood.facts).toHaveLength(2);
    expect(hood.neighbors.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('respects direction and limit', () => {
    const src = new MemoryDataSource(SAMPLE);
    const out = src.getNeighbors('a', { direction: 'out', limit: 1 });
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]!.source).toBe('a');
    expect(out).toMatchObject({ total: 2, nextCursor: '1:1', hasMore: true });
    const next = src.getNeighbors('a', { direction: 'out', limit: 1, cursor: out.nextCursor });
    expect(next).toMatchObject({ total: 2, hasMore: false });
    expect(next.facts[0]!.predicate).toBe('worksAt');
  });

  it('lists a self-loop fact once in every direction', () => {
    const src = new MemoryDataSource({
      entities: [{ id: 'a', type: 'Thing', labels: { en: 'Loop' } }],
      facts: [{ source: 'a', target: 'a', predicate: 'relatesTo' }],
    });
    for (const direction of ['out', 'in', 'both'] as const) {
      const hood = src.getNeighbors('a', { direction });
      // A self-loop is indexed under both endpoints; 'both' must not
      // double-list it within one page.
      expect(hood.facts, direction).toHaveLength(1);
      expect(hood.total, direction).toBe(1);
      expect(hood.hasMore, direction).toBe(false);
    }
  });

  it('rejects cursors invalidated by an intervening load()', () => {
    const src = new MemoryDataSource(SAMPLE);
    const first = src.getNeighbors('a', { direction: 'out', limit: 1 });
    expect(first.nextCursor).toBeDefined();
    src.load(SAMPLE); // mutation mid-pagination bumps the data version
    expect(() =>
      src.getNeighbors('a', { direction: 'out', limit: 1, cursor: first.nextCursor }),
    ).toThrow(/mutated/i);
    // Pagination restarts cleanly from scratch after the mutation.
    const fresh = src.getNeighbors('a', { direction: 'out', limit: 1 });
    expect(fresh.facts).toHaveLength(1);
    expect(fresh.nextCursor).not.toBe(first.nextCursor);
  });

  it('rejects malformed cursors loudly', () => {
    const src = new MemoryDataSource(SAMPLE);
    expect(() => src.getNeighbors('a', { cursor: 'not-a-cursor' })).toThrow(/Invalid/u);
  });
});
