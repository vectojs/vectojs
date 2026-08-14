import type { KgDataSource, KgEntity, KgFact, KgGraphData, KgNeighborhood, NodeId } from './types';

/**
 * In-memory {@link KgDataSource} for tests and small graphs. Indexes facts by
 * endpoint so `getNeighbors` is O(degree) rather than O(E).
 */
export class MemoryDataSource implements KgDataSource {
  private readonly entities = new Map<NodeId, KgEntity>();
  private readonly out = new Map<NodeId, KgFact[]>();
  private readonly inn = new Map<NodeId, KgFact[]>();

  constructor(data?: KgGraphData) {
    if (data) this.load(data);
  }

  load(data: KgGraphData): void {
    this.entities.clear();
    this.out.clear();
    this.inn.clear();
    for (const e of data.entities) this.entities.set(e.id, e);
    for (const f of data.facts) {
      const outs = this.out.get(f.source) ?? [];
      outs.push(f);
      this.out.set(f.source, outs);
      const inns = this.inn.get(f.target) ?? [];
      inns.push(f);
      this.inn.set(f.target, inns);
    }
  }

  getNodes(ids?: readonly NodeId[]): readonly KgEntity[] {
    if (!ids) return [...this.entities.values()];
    const out: KgEntity[] = [];
    for (const id of ids) {
      const e = this.entities.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  getNeighbors(
    id: NodeId,
    options: { limit?: number; direction?: 'out' | 'in' | 'both' } = {},
  ): KgNeighborhood {
    const entity = this.entities.get(id);
    if (!entity) {
      return {
        entity: { id, type: 'Unknown', labels: { '': String(id) } },
        facts: [],
        neighbors: [],
      };
    }
    const direction = options.direction ?? 'both';
    const limit = options.limit ?? Infinity;
    const facts: KgFact[] = [];
    if (direction === 'out' || direction === 'both') {
      for (const f of this.out.get(id) ?? []) facts.push(f);
    }
    if (direction === 'in' || direction === 'both') {
      for (const f of this.inn.get(id) ?? []) facts.push(f);
    }
    const sliced = facts.slice(0, limit);
    const neighborIds = new Set<NodeId>();
    for (const f of sliced) {
      neighborIds.add(f.source === id ? f.target : f.source);
    }
    const neighbors: KgEntity[] = [];
    for (const nid of neighborIds) {
      const n = this.entities.get(nid);
      if (n) neighbors.push(n);
    }
    return { entity, facts: sliced, neighbors };
  }
}
