import type { GraphData, GraphLayout, GraphLink } from '@vectojs/graph3d';
import type { KgDataSource, KgEntity, KgFact, KgNeighborOptions, NodeId } from './types';
import { pickLabel } from './types';

export type ExpansionStatus = 'idle' | 'loading' | 'partial' | 'complete' | 'failed' | 'cancelled';

export interface ExpansionState {
  status: ExpansionStatus;
  loaded: number;
  total?: number;
  cursor?: string;
  hasMore?: boolean;
  error?: unknown;
}

export interface ExpansionResult {
  entity?: KgEntity;
  addedEntities: number;
  addedFacts: number;
  state: ExpansionState;
}

export interface KnowledgeGraphSnapshot {
  version: 1;
  entities: readonly KgEntity[];
  facts: readonly KgFact[];
  expansions: readonly KnowledgeGraphExpansionSnapshot[];
}

export interface KnowledgeGraphExpansionSnapshot {
  id: NodeId;
  status: Exclude<ExpansionStatus, 'idle' | 'loading' | 'failed'>;
  loaded: number;
  total?: number;
  cursor?: string;
  hasMore?: boolean;
}

export interface KnowledgeGraphModelOptions {
  source: KgDataSource;
  layout?: GraphLayout;
  pageSize?: number;
  direction?: KgNeighborOptions['direction'];
  lang?: string;
}

interface ExpansionRequest {
  controller: AbortController;
  revision: number;
  promise: Promise<ExpansionResult>;
}

const IDLE_STATE: ExpansionState = { status: 'idle', loaded: 0 };

/** Renderer-neutral owner of a paginated, materialized knowledge-graph cut. */
export class KnowledgeGraphModel {
  readonly layout?: GraphLayout;

  private readonly source: KgDataSource;
  private readonly pageSize?: number;
  private readonly direction?: KgNeighborOptions['direction'];
  private readonly lang: string;
  private readonly entities = new Map<NodeId, KgEntity>();
  private readonly facts: KgFact[] = [];
  private readonly factKeys = new Set<string>();
  private readonly expansions = new Map<NodeId, ExpansionState>();
  private readonly requests = new Map<NodeId, ExpansionRequest>();
  private entityOrder: KgEntity[] = [];
  private graphData: GraphData = { nodes: [], links: [] };
  private readonly lastPositions = new Map<NodeId, [number, number, number]>();
  private revision = 0;
  private disposed = false;

  constructor(options: KnowledgeGraphModelOptions) {
    this.source = options.source;
    this.layout = options.layout;
    this.pageSize = options.pageSize;
    this.direction = options.direction;
    this.lang = options.lang ?? 'en';
  }

  get entityCount(): number {
    return this.entities.size;
  }

  get factCount(): number {
    return this.facts.length;
  }

  listEntities(): KgEntity[] {
    return this.entityOrder.slice();
  }

  listFacts(): KgFact[] {
    return this.facts.map((fact) => ({ ...fact }));
  }

  /** Current graph in stable entity order, suitable for any renderer. */
  getGraphData(): GraphData {
    return this.graphData;
  }

  getExpansionState(id: NodeId): ExpansionState {
    const state = this.expansions.get(id) ?? IDLE_STATE;
    return { ...state };
  }

  async bootstrap(focusIds: readonly NodeId[], expandSeeds = true): Promise<void> {
    this.assertOpen();
    const revision = this.revision;
    const nodes = await this.source.getNodes(focusIds);
    if (this.disposed || revision !== this.revision) return;
    this.ingestEntities(nodes);
    this.rebuildGraph();
    if (expandSeeds) {
      for (const id of focusIds) await this.expand(id);
    }
  }

  /** Load the next page around a node. Concurrent calls for one node share a promise. */
  expand(id: NodeId): Promise<ExpansionResult> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const current = this.requests.get(id);
    if (current) return current.promise;
    const previous = this.expansions.get(id) ?? IDLE_STATE;
    if (previous.status === 'complete') {
      return Promise.resolve({ addedEntities: 0, addedFacts: 0, state: { ...previous } });
    }

    const controller = new AbortController();
    const request = {} as ExpansionRequest;
    request.controller = controller;
    request.revision = this.revision;
    this.expansions.set(id, { ...previous, status: 'loading', error: undefined });
    request.promise = this.loadPage(id, previous, request);
    this.requests.set(id, request);
    return request.promise;
  }

  cancelExpand(id: NodeId): void {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    request.controller.abort();
    const state = this.expansions.get(id) ?? IDLE_STATE;
    this.expansions.set(id, { ...state, status: 'cancelled', error: undefined });
  }

  exportSnapshot(): KnowledgeGraphSnapshot {
    this.assertOpen();
    const expansions: KnowledgeGraphExpansionSnapshot[] = [];
    for (const [id, state] of this.expansions) {
      let status: KnowledgeGraphExpansionSnapshot['status'];
      if (
        state.status === 'complete' ||
        state.status === 'partial' ||
        state.status === 'cancelled'
      ) {
        status = state.status;
      } else {
        status = state.loaded > 0 || state.cursor !== undefined ? 'partial' : 'cancelled';
      }
      expansions.push({
        id,
        status,
        loaded: state.loaded,
        total: state.total,
        cursor: state.cursor,
        hasMore: state.hasMore,
      });
    }
    return {
      version: 1,
      entities: this.entityOrder.map((entity) => ({ ...entity, labels: { ...entity.labels } })),
      facts: this.facts.map((fact) => ({ ...fact })),
      expansions,
    };
  }

  importSnapshot(snapshot: KnowledgeGraphSnapshot): void {
    this.assertOpen();
    if (snapshot.version !== 1)
      throw new Error(`Unsupported knowledge-graph snapshot: ${snapshot.version}`);
    this.invalidateRequests();
    this.entities.clear();
    this.facts.length = 0;
    this.factKeys.clear();
    this.expansions.clear();
    this.entityOrder = [];
    const keep = new Set(snapshot.entities.map((entity) => entity.id));
    for (const id of this.lastPositions.keys()) {
      if (!keep.has(id)) this.lastPositions.delete(id);
    }
    this.ingestEntities(snapshot.entities);
    for (const fact of snapshot.facts) this.ingestFact(fact);
    for (const expansion of snapshot.expansions) {
      this.expansions.set(expansion.id, { ...expansion });
    }
    this.rebuildGraph();
  }

  captureLayoutPositions(): void {
    const positions = this.layout?.positions;
    if (!positions) return;
    for (let i = 0; i < this.entityOrder.length; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        this.lastPositions.set(this.entityOrder[i]!.id, [x!, y!, z!]);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateRequests();
    this.layout?.dispose();
    this.entities.clear();
    this.facts.length = 0;
    this.factKeys.clear();
    this.expansions.clear();
    this.entityOrder = [];
    this.graphData = { nodes: [], links: [] };
    this.lastPositions.clear();
  }

  private async loadPage(
    id: NodeId,
    previous: ExpansionState,
    request: ExpansionRequest,
  ): Promise<ExpansionResult> {
    try {
      const page = await this.source.getNeighbors(id, {
        limit: this.pageSize,
        cursor: previous.cursor,
        direction: this.direction,
        signal: request.controller.signal,
      });
      if (!this.isCurrent(id, request)) {
        return { addedEntities: 0, addedFacts: 0, state: this.getExpansionState(id) };
      }
      const entityCount = this.entities.size;
      const factCount = this.facts.length;
      this.ingestEntities([page.entity, ...page.neighbors]);
      for (const fact of page.facts) this.ingestFact(fact);
      const addedEntities = this.entities.size - entityCount;
      const addedFacts = this.facts.length - factCount;
      const loaded = previous.loaded + addedFacts;
      const hasMore = page.hasMore ?? page.nextCursor !== undefined;
      const state: ExpansionState = {
        status: hasMore ? 'partial' : 'complete',
        loaded,
        total: page.total ?? previous.total,
        cursor: page.nextCursor,
        hasMore,
      };
      this.expansions.set(id, state);
      this.requests.delete(id);
      this.rebuildGraph();
      this.layout?.reheat?.(0.5);
      return { entity: page.entity, addedEntities, addedFacts, state: { ...state } };
    } catch (error) {
      if (!this.isCurrent(id, request)) {
        return { addedEntities: 0, addedFacts: 0, state: this.getExpansionState(id) };
      }
      this.requests.delete(id);
      if (request.controller.signal.aborted) {
        const state = { ...previous, status: 'cancelled' as const };
        this.expansions.set(id, state);
        return { addedEntities: 0, addedFacts: 0, state: { ...state } };
      }
      this.expansions.set(id, { ...previous, status: 'failed', error });
      throw error;
    }
  }

  private isCurrent(id: NodeId, request: ExpansionRequest): boolean {
    return (
      !this.disposed && request.revision === this.revision && this.requests.get(id) === request
    );
  }

  private invalidateRequests(): void {
    this.revision++;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
  }

  private ingestEntities(entities: readonly KgEntity[]): void {
    for (const entity of entities) {
      const previous = this.entities.get(entity.id);
      this.entities.set(entity.id, {
        ...previous,
        ...entity,
        labels: { ...previous?.labels, ...entity.labels },
      });
    }
  }

  private ingestFact(fact: KgFact): void {
    const key = JSON.stringify([fact.source, fact.predicate, fact.target]);
    if (this.factKeys.has(key)) return;
    this.factKeys.add(key);
    this.facts.push({ ...fact });
  }

  private rebuildGraph(): void {
    this.captureLayoutPositions();
    const next: KgEntity[] = [];
    const seen = new Set<NodeId>();
    for (const entity of this.entityOrder) {
      const current = this.entities.get(entity.id);
      if (current) {
        next.push(current);
        seen.add(current.id);
      }
    }
    for (const entity of this.entities.values()) {
      if (!seen.has(entity.id)) next.push(entity);
    }
    this.entityOrder = next;
    const nodes = next.map((entity) => {
      const position = this.lastPositions.get(entity.id);
      return {
        ...entity,
        name: pickLabel(entity.labels, this.lang),
        ...(position ? { x: position[0], y: position[1], z: position[2] } : {}),
      };
    });
    this.graphData = { nodes, links: this.facts as GraphLink[] };
    this.layout?.setGraph(this.graphData);
    this.captureLayoutPositions();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('KnowledgeGraphModel is disposed');
  }
}
