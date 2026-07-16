import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLink,
  type SimulationNode,
} from 'd3-force-3d';
import type { GraphData } from '../types';
import type { GraphLayout } from './GraphLayout';

export interface D3ForceLayoutOptions {
  /** Target resting length of links. Default 30 (d3-force's own default). */
  linkDistance?: number;
  /** Many-body (charge) strength; negative repels. Default -30. */
  chargeStrength?: number;
  /**
   * Alpha threshold below which {@link D3ForceLayout.step} reports the
   * simulation as cooled. Default 0.001 (d3-force's own default).
   */
  alphaMin?: number;
}

/**
 * {@link GraphLayout} adapter over d3-force-3d — the same engine that powers
 * 3d-force-graph, so tuned graphs migrate with their feel intact.
 *
 * The d3 simulation mutates its node objects (x/y/z/vx/…), so `setGraph`
 * clones each node into an internal simulation record instead of handing the
 * caller's objects to d3; only the declared `x`/`y`/`z` position seeds and
 * `fx`/`fy`/`fz` pins are carried over. The simulation's own timer is never
 * started — the caller drives it
 * synchronously through `step()`, which also keeps the class usable inside a
 * Web Worker without a fake rAF.
 */
export class D3ForceLayout implements GraphLayout {
  public positions: Float32Array = new Float32Array(0);

  private simulation: Simulation | null = null;
  private simNodes: SimulationNode[] = [];
  private disposed = false;

  private readonly linkDistance: number;
  private readonly chargeStrength: number;
  private readonly alphaMin: number;

  constructor(options: D3ForceLayoutOptions = {}) {
    this.linkDistance = options.linkDistance ?? 30;
    this.chargeStrength = options.chargeStrength ?? -30;
    this.alphaMin = options.alphaMin ?? 0.001;
  }

  public setGraph(data: GraphData): void {
    this.assertUsable();
    this.simulation?.stop();

    this.simNodes = data.nodes.map((node) => {
      const simNode: SimulationNode = { id: node.id };
      // Position seeds: d3 keeps a pre-set x/y/z instead of its phyllotaxis
      // default, so seeded graphs start (and cool) deterministically.
      if (node.x !== undefined) simNode.x = node.x;
      if (node.y !== undefined) simNode.y = node.y;
      if (node.z !== undefined) simNode.z = node.z;
      if (node.fx !== undefined) simNode.fx = node.fx;
      if (node.fy !== undefined) simNode.fy = node.fy;
      if (node.fz !== undefined) simNode.fz = node.fz;
      return simNode;
    });
    const simLinks: SimulationLink[] = data.links.map((link) => ({
      source: link.source,
      target: link.target,
    }));

    this.simulation = forceSimulation(this.simNodes, 3)
      .alphaMin(this.alphaMin)
      .force(
        'link',
        forceLink(simLinks)
          .id((node) => node.id as string | number)
          .distance(this.linkDistance),
      )
      .force('charge', forceManyBody().strength(this.chargeStrength))
      .force('center', forceCenter())
      .stop();

    this.positions = new Float32Array(this.simNodes.length * 3);
    this.readPositions();
  }

  public step(iterations = 1): boolean {
    this.assertUsable();
    if (!this.simulation) return false;
    for (let i = 0; i < iterations && this.simulation.alpha() >= this.alphaMin; i++) {
      this.simulation.tick();
    }
    this.readPositions();
    return this.simulation.alpha() >= this.alphaMin;
  }

  /**
   * Pin a node to a fixed position by writing d3-force's `fx`/`fy`/`fz` on the
   * internal simulation record. The simulation clamps the node there every
   * tick until {@link unpinNode}. Out-of-range indices are ignored so a stale
   * pointer interaction can't crash the layout.
   */
  public pinNode(nodeIndex: number, x: number, y: number, z: number): void {
    this.assertUsable();
    const node = this.simNodes[nodeIndex];
    if (!node) return;
    node.fx = x;
    node.fy = y;
    node.fz = z;
    // Keep the exposed buffer coherent immediately, before the next step().
    this.positions[nodeIndex * 3] = x;
    this.positions[nodeIndex * 3 + 1] = y;
    this.positions[nodeIndex * 3 + 2] = z;
  }

  /** Release a pinned node back to free simulation (clears `fx`/`fy`/`fz`). */
  public unpinNode(nodeIndex: number): void {
    this.assertUsable();
    const node = this.simNodes[nodeIndex];
    if (!node) return;
    node.fx = null;
    node.fy = null;
    node.fz = null;
  }

  /**
   * Raise the simulation's alpha so it resumes meaningful movement after
   * cooling — e.g. when a drag pins a node and the rest of the graph should
   * settle around it. Clamped to d3's usual `[0, 1]` working range.
   */
  public reheat(alpha = 0.3): void {
    this.assertUsable();
    if (!this.simulation) return;
    this.simulation.alpha(Math.max(this.alphaMin, Math.min(1, alpha)));
  }

  public dispose(): void {
    this.simulation?.stop();
    this.simulation = null;
    this.simNodes = [];
    this.positions = new Float32Array(0);
    this.disposed = true;
  }

  private readPositions(): void {
    for (let i = 0; i < this.simNodes.length; i++) {
      const node = this.simNodes[i];
      this.positions[i * 3] = node.x ?? 0;
      this.positions[i * 3 + 1] = node.y ?? 0;
      this.positions[i * 3 + 2] = node.z ?? 0;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('D3ForceLayout was disposed');
  }
}
