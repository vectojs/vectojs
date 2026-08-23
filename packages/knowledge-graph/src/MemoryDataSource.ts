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
  /** Bumped by {@link load} so outstanding cursors can detect mutation. */
  private version = 0;

  constructor(data?: KgGraphData) {
    if (data) this.load(data);
  }

  load(data: KgGraphData): void {
    this.entities.clear();
    this.out.clear();
    this.inn.clear();
    // Invalidate outstanding cursors: pagination in flight against the
    // previous data must fail loudly rather than resume at shifted offsets.
    this.version++;
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
    // Merge the out/in indexes deduped by fact identity: a self-loop
    // (`source === target`) is indexed under both endpoints and would be
    // double-listed within one `'both'` page.
    const facts: KgFact[] = [];
    const seen = new Set<KgFact>();
    if (direction === 'out' || direction === 'both') {
      for (const f of this.out.get(id) ?? []) {
        if (!seen.has(f)) {
          seen.add(f);
          facts.push(f);
        }
      }
    }
    if (direction === 'in' || direction === 'both') {
      for (const f of this.inn.get(id) ?? []) {
        if (!seen.has(f)) {
          seen.add(f);
          facts.push(f);
        }
      }
    }
    const offset = options.cursor === undefined ? 0 : this.parseCursor(options.cursor);
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
      nextCursor: hasMore ? `${this.version}:${nextOffset}` : undefined,
      hasMore,
    };
  }

  /**
   * Cursors are `<data-version>:<offset>` pairs. {@link load} bumps the
   * version, so a cursor issued before a mid-pagination mutation is rejected
   * loudly instead of silently slicing a different fact list.
   */
  private parseCursor(cursor: string): number {
    const sep = cursor.indexOf(':');
    if (sep < 0) throw new Error(`Invalid MemoryDataSource cursor: ${cursor}`);
    const version = Number.parseInt(cursor.slice(0, sep), 10);
    if (!Number.isSafeInteger(version)) {
      throw new Error(`Invalid MemoryDataSource cursor: ${cursor}`);
    }
    if (version !== this.version) {
      throw new Error(
        `Stale MemoryDataSource cursor ${cursor}: the data was mutated after this cursor was issued`,
      );
    }
    const offset = Number.parseInt(cursor.slice(sep + 1), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Invalid MemoryDataSource cursor: ${cursor}`);
    }
    return offset;
  }
}
