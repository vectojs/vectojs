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
  });
});
