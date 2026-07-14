/** Identifier used to reference a node from a link. */
export type NodeId = string | number;

/**
 * One graph node. Domain-specific properties ride along untouched — the
 * layout engine and renderer only read the fields declared here and never
 * mutate the caller's objects.
 */
export interface GraphNode {
  id: NodeId;
  /**
   * Relative importance; the renderer scales node volume proportionally
   * (radius ∝ ∛val), matching the sizing convention users know from
   * 3d-force-graph. Defaults to 1.
   */
  val?: number;
  /** CSS color for this node. Falls back to the renderer's default. */
  color?: string;
  /** Pin the node at a fixed x coordinate (layout will not move it). */
  fx?: number;
  /** Pin the node at a fixed y coordinate. */
  fy?: number;
  /** Pin the node at a fixed z coordinate. */
  fz?: number;
  [key: string]: unknown;
}

/** One directed edge between two nodes, referenced by id. */
export interface GraphLink {
  source: NodeId;
  target: NodeId;
  [key: string]: unknown;
}

/** The full graph handed to layouts and renderers. */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
