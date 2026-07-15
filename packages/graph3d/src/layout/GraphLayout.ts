import type { GraphData } from '../types';

/**
 * A pluggable 3D graph layout engine.
 *
 * The contract is deliberately minimal and worker-friendly: positions are
 * exposed as one flat `Float32Array` of xyz triplets in `GraphData.nodes`
 * order, so an implementation can live in a Web Worker and stream its buffer
 * across the thread boundary as a transferable without any per-node object
 * traffic. The renderer consumes the same buffer directly.
 */
export interface GraphLayout {
  /**
   * Replace the simulated graph. Node objects are treated as read-only
   * (except the `fx`/`fy`/`fz` pin fields, which are honored); implementations
   * must keep their mutable simulation state internal.
   */
  setGraph(data: GraphData): void;

  /**
   * Advance the simulation by `iterations` ticks (default 1) and refresh
   * {@link positions}. Returns `false` once the layout has cooled and further
   * stepping would not meaningfully move nodes — callers use this to stop
   * their tick loop.
   */
  step(iterations?: number): boolean;

  /**
   * Current node positions as xyz triplets, index-aligned with the
   * `GraphData.nodes` array passed to {@link setGraph}. The same array
   * instance is reused across steps; copy it if you need a snapshot.
   */
  readonly positions: Float32Array;

  /**
   * Pin the node at `nodeIndex` (its position in the `GraphData.nodes` array)
   * to a fixed world position, so the simulation holds it there instead of
   * moving it. This is the runtime equivalent of the node's `fx`/`fy`/`fz`
   * pin fields, used for interactive drag-to-pin.
   *
   * Optional: layouts that cannot pin individual nodes at runtime may omit
   * it. {@link GraphInteraction} feature-detects this before enabling drag.
   */
  pinNode?(nodeIndex: number, x: number, y: number, z: number): void;

  /**
   * Release a previously {@link pinNode}-ed node back to free simulation.
   * Optional, paired with {@link pinNode}.
   */
  unpinNode?(nodeIndex: number): void;

  /**
   * Reheat the simulation (raise alpha back toward 1) so it responds to a
   * pin/unpin or other change after it has cooled. Optional; callers should
   * treat its absence as "the layout stays live on its own".
   */
  reheat?(alpha?: number): void;

  /** Release simulation resources. The instance must not be used afterwards. */
  dispose(): void;
}
