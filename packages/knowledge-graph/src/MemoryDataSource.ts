import type {
  KgDataSource,
  KgEntity,
  KgFact,
  KgGraphData,
  KgNeighborhood,
  KgNeighborOptions,
  NodeId,
} from './types';

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
    // Copy so later host mutations to the snapshot cannot corrupt the index.
    for (const e of data.entities) {
      this.entities.set(e.id, { ...e, labels: { ...e.labels } });
    }
    for (const f of data.facts) {
      const fact: KgFact = { ...f };
      const outs = this.out.get(fact.source) ?? [];
      outs.push(fact);
      this.out.set(fact.source, outs);
      const inns = this.inn.get(fact.target) ?? [];
      inns.push(fact);
      this.inn.set(fact.target, inns);
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

  getNeighbors(id: NodeId, options: KgNeighborOptions = {}): KgNeighborhood {
    options.signal?.throwIfAborted();
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
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Invalid MemoryDataSource cursor: ${options.cursor}`);
    }
    const sliced = facts.slice(offset, offset + limit);
    const neighborIds = new Set<NodeId>();
    for (const f of sliced) {
      neighborIds.add(f.source === id ? f.target : f.source);
    }
    const neighbors: KgEntity[] = [];
    for (const nid of neighborIds) {
      const n = this.entities.get(nid);
      if (n) neighbors.push(n);
    }
    const nextOffset = offset + sliced.length;
    const hasMore = nextOffset < facts.length;
    return {
      entity,
      facts: sliced,
      neighbors,
      total: facts.length,
      nextCursor: hasMore ? String(nextOffset) : undefined,
      hasMore,
    };
  }
}
