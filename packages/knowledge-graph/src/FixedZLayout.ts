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
    // Seed z so the first step does not start from a random height.
    for (const node of data.nodes) {
      if (node.z === undefined && node.fz === undefined) node.z = this.z;
      if (node.fz === undefined) {
        // Prefer a soft seed over a hard pin so the host can still lift into 3D
        // later by swapping layouts; FixedZLayout re-applies z every step anyway.
      }
    }
    this.inner.setGraph(data);
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
