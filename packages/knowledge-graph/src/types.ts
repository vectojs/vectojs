import type { GraphData, GraphLink, GraphNode, NodeId } from '@vectojs/graph3d';

export type { NodeId };

/** Viewing dimension for a knowledge-graph session. */
export type KnowledgeGraphMode = '2d' | '3d';

/**
 * Multi-language label map. Keys are BCP-47 language tags (`en`, `zh-cn`, …);
 * the empty key `''` is the language-neutral fallback.
 */
export type LabelMap = Readonly<Record<string, string>>;

/**
 * One typed knowledge-graph entity. Extends the generic {@link GraphNode} so it
 * can be handed straight to `@vectojs/graph3d` layouts/renderers; domain fields
 * ride along untouched.
 */
export interface KgEntity extends GraphNode {
  id: NodeId;
  /** RDF/schema type IRI or short name (`Work`, `Author`, …). */
  type: string;
  /** Display labels by language. */
  labels: LabelMap;
  /** Optional confidence in `[0, 1]`. */
  confidence?: number;
  /** Provenance / source document id. */
  source?: string;
}

/** One typed, directed fact between two entities. */
export interface KgFact extends GraphLink {
  source: NodeId;
  target: NodeId;
  /** Predicate IRI or short name. */
  predicate: string;
  confidence?: number;
  /** Provenance / source document id (not the link endpoint). */
  provenance?: string;
}

/** In-memory snapshot consumed by the session (after adapter materialization). */
export interface KgGraphData {
  entities: KgEntity[];
  facts: KgFact[];
}

/**
 * Lazy data-source contract. Real-scale graphs (100k+ entities) must not load
 * the full neighborhood up front — `getNeighbors` is called on expand.
 *
 * All methods may be sync or async; the session awaits every call.
 */
export interface KgDataSource {
  /** Seed entities for the initial view (e.g. a search hit, a focus node). */
  getNodes(ids?: readonly NodeId[]): MaybeAsync<readonly KgEntity[]>;
  /** Outbound (and optionally inbound) facts + their far-end entities. */
  getNeighbors(
    id: NodeId,
    options?: { limit?: number; direction?: 'out' | 'in' | 'both' },
  ): MaybeAsync<KgNeighborhood>;
  /** Resolve labels for entities already known by id (language negotiation). */
  getLabels?(ids: readonly NodeId[], lang?: string): MaybeAsync<ReadonlyMap<NodeId, string>>;
}

export interface KgNeighborhood {
  entity: KgEntity;
  facts: readonly KgFact[];
  /** Far-end entities referenced by `facts` (may be a subset if truncated). */
  neighbors: readonly KgEntity[];
}

export type MaybeAsync<T> = T | Promise<T>;

/** Convert domain data into the generic graph3d shape (identity cast of arrays). */
export function toGraphData(data: KgGraphData): GraphData {
  return {
    nodes: data.entities as GraphNode[],
    links: data.facts as GraphLink[],
  };
}

/** Pick a display label from a {@link LabelMap}. */
export function pickLabel(labels: LabelMap, lang = 'en'): string {
  return labels[lang] ?? labels[''] ?? labels[Object.keys(labels)[0] ?? ''] ?? '';
}
