/** Identifier used to reference a graph node. */
export type NodeId = string | number;

/** Renderer-independent input node. Additional application data is preserved. */
export interface GraphNode {
  id: NodeId;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  [key: string]: unknown;
}

/** Renderer-independent link whose endpoints are node identifiers. */
export interface GraphLink {
  source: NodeId;
  target: NodeId;
  /**
   * Optional identity for parallel links. Links without an ID are identified
   * by their directed endpoint pair; parallel links require distinct IDs.
   */
  id?: NodeId;
  [key: string]: unknown;
}

/**
 * Graph data accepted by {@link ForceLayout2D}. `setGraph` rejects duplicate
 * node IDs; `appendGraph` ignores IDs already present for idempotent paging.
 */
export interface GraphData {
  nodes: readonly GraphNode[];
  links: readonly GraphLink[];
}

export type NodeValue = number | ((node: GraphNode, index: number) => number);
export type LinkValue = number | ((link: GraphLink, index: number) => number);

/** Configuration for the dependency-free 2D force simulation. */
export interface ForceLayout2DOptions {
  /** Per-node repulsion magnitude. Default 300. */
  repulsion?: NodeValue;
  /** Per-node collision radius. Default 0 (disabled). */
  collisionRadius?: NodeValue;
  /** Fraction of collision overlap corrected per tick. Default 1. */
  collisionStrength?: number;
  /** Per-link resting length. Default 30. */
  linkDistance?: LinkValue;
  /** Per-link spring stiffness. Default 0.3. */
  linkStrength?: LinkValue;
  /** Pull toward the origin. Default 0.02. */
  centerStrength?: number;
  /** Per-tick velocity retention in `[0, 1)`. Default 0.6. */
  velocityDecay?: number;
  /** Barnes-Hut opening angle. Default 0.9. */
  theta?: number;
  /** Temperature decay per tick. Default 0.0228. */
  alphaDecay?: number;
  /** Temperature below which the simulation is settled. Default 0.001. */
  alphaMin?: number;
  /** Seed for deterministic initial placement. Default 1. */
  seed?: number;
}
