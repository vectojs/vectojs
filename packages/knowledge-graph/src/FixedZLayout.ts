import type { GraphData, GraphLayout } from '@vectojs/graph3d';
import { VectoForceLayout, type VectoForceLayoutOptions } from '@vectojs/graph3d';

export interface FixedZLayoutOptions extends VectoForceLayoutOptions {
  /** Constant z written after every step. Default 0. */
  z?: number;
}

/**
 * Wraps {@link VectoForceLayout} and forces every node's z to a constant after
 * each step — the 2D flat-graph layout knowledge-graph uses by default.
 *
 * The inner simulation still runs in 3D (Barnes-Hut octree); pinning z each
 * tick keeps the view planar without forking the force kernel. Pin/unpin/
 * reheat delegate through.
 */
export class FixedZLayout implements GraphLayout {
  private readonly inner: VectoForceLayout;
  private readonly z: number;
  private nodeCount = 0;

  constructor(options: FixedZLayoutOptions = {}) {
    const { z = 0, ...rest } = options;
    this.z = z;
    this.inner = new VectoForceLayout(rest);
  }

  get positions(): Float32Array {
    return this.inner.positions;
  }

  setGraph(data: GraphData): void {
    this.nodeCount = data.nodes.length;
    // Do not mutate the caller's node objects — seed z only on a shallow copy
    // of the nodes array so shared snapshots stay pristine.
    const nodes = data.nodes.map((n) => {
      if (n.z !== undefined || n.fz !== undefined) return n;
      return { ...n, z: this.z };
    });
    this.inner.setGraph({ nodes, links: data.links });
    this.flatten();
  }

  step(iterations?: number): boolean {
    const settled = this.inner.step(iterations);
    this.flatten();
    this.sanitize();
    return settled;
  }

  pinNode(index: number, x: number, y: number, z?: number): void {
    this.inner.pinNode?.(index, x, y, z ?? this.z);
    this.flatten();
  }

  unpinNode(index: number): void {
    this.inner.unpinNode?.(index);
  }

  reheat(alpha?: number): void {
    this.inner.reheat?.(alpha);
  }

  dispose(): void {
    this.inner.dispose();
  }

  private flatten(): void {
    const pos = this.inner.positions;
    const n = this.nodeCount;
    const z = this.z;
    for (let i = 0; i < n; i++) pos[i * 3 + 2] = z;
  }

  /**
   * Replace non-finite x/y with a small deterministic seed and zero z-drift.
   * Barnes-Hut + stiff springs can NaN on dense bipartite cuts; rather than
   * blank the WebGL buffers we reseed the bad nodes so the frame stays visible.
   */
  private sanitize(): void {
    const pos = this.inner.positions;
    const n = this.nodeCount;
    const z = this.z;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const r = 10 * Math.cbrt(i + 1);
        pos[i * 3] = r * Math.cos(i * 2.399);
        pos[i * 3 + 1] = r * Math.sin(i * 2.399);
      }
      pos[i * 3 + 2] = z;
    }
  }
}
