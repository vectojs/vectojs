import { BarnesHutQuadtree } from './internal/BarnesHutQuadtree';
import type {
  ForceLayout2DOptions,
  GraphData,
  GraphLink,
  GraphNode,
  LinkValue,
  NodeId,
  NodeValue,
} from './types';

const f = Math.fround;
const F32_MAX = 3.4028234663852886e38;

/**
 * Dependency-free, renderer-agnostic 2D force layout.
 *
 * Positions are exposed as interleaved XY pairs in input-node order. The view
 * identity is stable across {@link step} calls, but topology or capacity
 * changes may replace it; hosts must reacquire `positions` after `setGraph`,
 * `appendGraph`, or `removeNodes`. The simulation uses a true 2D Barnes-Hut
 * quadtree and owns no timer; hosts decide when to call {@link step}.
 */
export class ForceLayout2D {
  public positions = new Float32Array(0);
  public nodeCount = 0;

  private readonly repulsionOption: NodeValue;
  private readonly collisionRadiusOption: NodeValue;
  private readonly linkDistanceOption: LinkValue;
  private readonly linkStrengthOption: LinkValue;
  private readonly collisionStrength: number;
  private readonly centerStrength: number;
  private readonly velocityDecay: number;
  private readonly theta: number;
  private readonly repulsionDistanceMax: number;
  private readonly alphaDecay: number;
  private readonly alphaMin: number;
  private readonly seed: number;

  private nodes: GraphNode[] = [];
  private nodeIndex = new Map<NodeId, number>();
  private positionStorage = new Float32Array(0);
  private velocityX = new Float32Array(0);
  private velocityY = new Float32Array(0);
  private fixedX = new Float32Array(0);
  private fixedY = new Float32Array(0);
  private pinnedX = new Uint8Array(0);
  private pinnedY = new Uint8Array(0);
  private repulsion = new Float32Array(0);
  private collisionRadius = new Float32Array(0);
  private predicted = new Float32Array(0);
  private linkSource = new Int32Array(0);
  private linkTarget = new Int32Array(0);
  private linkDistance = new Float32Array(0);
  private linkStrength = new Float32Array(0);
  private linkSourceShare = new Float32Array(0);
  private linkTargetShare = new Float32Array(0);
  private degree = new Int32Array(0);
  private linkKeys: string[] = [];
  private linkKeySet = new Set<string>();
  private linkCount = 0;
  private nodeCapacity = 0;
  private linkCapacity = 0;
  private placementIndex = 0;
  private alpha = 1;
  private disposed = false;
  private quadtree = new BarnesHutQuadtree();
  private forceOutput = new Float64Array(2);

  public constructor(options: ForceLayout2DOptions = {}) {
    this.repulsionOption = options.repulsion ?? 300;
    this.collisionRadiusOption = options.collisionRadius ?? 0;
    this.linkDistanceOption = options.linkDistance ?? 30;
    this.linkStrengthOption = options.linkStrength ?? 0.3;
    this.collisionStrength = finiteOr(options.collisionStrength, 1, 0);
    this.centerStrength = finiteOr(options.centerStrength, 0.02, 0);
    this.velocityDecay = finiteOr(options.velocityDecay, 0.6, 0, 0.999999);
    this.theta = finiteOr(options.theta, 0.9, 0);
    this.repulsionDistanceMax = finiteOr(options.repulsionDistanceMax, Infinity, 0);
    this.alphaDecay = finiteOr(options.alphaDecay, 0.0228, 0, 1);
    this.alphaMin = finiteOr(options.alphaMin, 0.001, 0);
    this.seed = Number.isFinite(options.seed) ? Number(options.seed) : 1;
  }

  /** Replace all simulation state with a newly seeded graph. */
  public setGraph(data: GraphData): void {
    this.assertUsable();
    const seen = new Set<NodeId>();
    for (const node of data.nodes) {
      if (!isNodeId(node.id))
        throw new Error('ForceLayout2D node IDs must be finite strings or numbers');
      if (seen.has(node.id)) throw new Error(`ForceLayout2D duplicate node ID: ${String(node.id)}`);
      seen.add(node.id);
    }
    this.clearGraph();
    this.appendGraph(data);
    this.alpha = 1;
  }

  /**
   * Append new node IDs and links without changing existing simulation state.
   * Existing and repeated node IDs are ignored. Links are replay-safe by their
   * directed endpoints plus optional `id`; parallel links require distinct IDs.
   */
  public appendGraph(data: GraphData): void {
    this.assertUsable();
    const newNodes: GraphNode[] = [];
    const seen = new Set<NodeId>();
    for (const node of data.nodes) {
      if (!isNodeId(node.id) || this.nodeIndex.has(node.id) || seen.has(node.id)) continue;
      seen.add(node.id);
      newNodes.push(node);
    }

    this.ensureNodeCapacity(this.nodeCount + newNodes.length);
    for (const node of newNodes) this.addNode(node);
    if (newNodes.length > 0) this.refreshPositionView();
    const addedLinks = this.appendLinks(data.links);
    if (newNodes.length > 0 || addedLinks > 0) this.reheat();
  }

  /** Remove node IDs, compacting survivors in their original relative order. */
  public removeNodes(ids: Iterable<NodeId>): void {
    this.assertUsable();
    const removed = new Set(ids);
    if (removed.size === 0) return;

    const oldToNew = new Int32Array(this.nodeCount);
    oldToNew.fill(-1);
    let nextCount = 0;
    for (let oldIndex = 0; oldIndex < this.nodeCount; oldIndex++) {
      const node = this.nodes[oldIndex];
      if (removed.has(node.id)) continue;
      oldToNew[oldIndex] = nextCount;
      if (oldIndex !== nextCount) this.copyNodeState(oldIndex, nextCount);
      this.nodes[nextCount] = node;
      nextCount++;
    }
    if (nextCount === this.nodeCount) return;
    this.nodes.length = nextCount;
    this.nodeCount = nextCount;
    this.positionStorage.fill(0, nextCount * 2);
    this.velocityX.fill(0, nextCount);
    this.velocityY.fill(0, nextCount);
    this.fixedX.fill(0, nextCount);
    this.fixedY.fill(0, nextCount);
    this.pinnedX.fill(0, nextCount);
    this.pinnedY.fill(0, nextCount);
    this.repulsion.fill(0, nextCount);
    this.collisionRadius.fill(0, nextCount);
    this.refreshPositionView();
    this.rebuildNodeIndex();

    let nextLink = 0;
    for (let link = 0; link < this.linkCount; link++) {
      const source = oldToNew[this.linkSource[link]];
      const target = oldToNew[this.linkTarget[link]];
      if (source < 0 || target < 0) continue;
      this.linkSource[nextLink] = source;
      this.linkTarget[nextLink] = target;
      this.linkDistance[nextLink] = this.linkDistance[link];
      this.linkStrength[nextLink] = this.linkStrength[link];
      this.linkKeys[nextLink] = this.linkKeys[link];
      nextLink++;
    }
    this.linkCount = nextLink;
    this.linkKeys.length = nextLink;
    this.linkKeySet = new Set(this.linkKeys);
    this.recomputeLinkBias();
    this.reheat();
  }

  /**
   * Advance by a host-controlled number of synchronous simulation ticks.
   * Returns `true` while active (not settled), or `false` once cooled.
   */
  public step(iterations = 1): boolean {
    this.assertUsable();
    if (this.nodeCount === 0 || this.alpha < this.alphaMin) return false;
    const count = normalizeIterations(iterations);
    for (let iteration = 0; iteration < count && this.alpha >= this.alphaMin; iteration++) {
      this.tick();
    }
    return this.alpha >= this.alphaMin;
  }

  public pinNode(nodeIndex: number, x: number, y: number): void {
    this.assertUsable();
    if (!this.validNodeIndex(nodeIndex)) return;
    this.setNodePin(nodeIndex, { x, y });
  }

  public unpinNode(nodeIndex: number): void {
    this.assertUsable();
    if (!this.validNodeIndex(nodeIndex)) return;
    this.clearNodePin(nodeIndex, { x: true, y: true });
  }

  /** Pin either axis without changing the other axis's pin state. */
  public setNodePin(nodeIndex: number, pin: { x?: number; y?: number }): void {
    this.assertUsable();
    if (!this.validNodeIndex(nodeIndex)) return;
    const offset = nodeIndex * 2;
    if (pin.x !== undefined) {
      this.fixedX[nodeIndex] = toF32(pin.x, toF32(this.positionStorage[offset]));
      this.pinnedX[nodeIndex] = 1;
      this.positionStorage[offset] = this.fixedX[nodeIndex];
      this.velocityX[nodeIndex] = 0;
    }
    if (pin.y !== undefined) {
      this.fixedY[nodeIndex] = toF32(pin.y, toF32(this.positionStorage[offset + 1]));
      this.pinnedY[nodeIndex] = 1;
      this.positionStorage[offset + 1] = this.fixedY[nodeIndex];
      this.velocityY[nodeIndex] = 0;
    }
  }

  /** Clear selected axis pins while preserving any axis omitted from `axes`. */
  public clearNodePin(
    nodeIndex: number,
    axes: { x?: boolean; y?: boolean } = { x: true, y: true },
  ): void {
    this.assertUsable();
    if (!this.validNodeIndex(nodeIndex)) return;
    if (axes.x) {
      this.pinnedX[nodeIndex] = 0;
      this.velocityX[nodeIndex] = 0;
    }
    if (axes.y) {
      this.pinnedY[nodeIndex] = 0;
      this.velocityY[nodeIndex] = 0;
    }
  }

  public reheat(alpha = 0.3): void {
    this.assertUsable();
    const requested = Math.max(this.alphaMin, Math.min(1, finiteOr(alpha, 0.3, 0, 1)));
    this.alpha = Math.max(this.alpha, requested);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGraph();
    this.positionStorage = new Float32Array(0);
    this.positions = this.positionStorage;
    this.velocityX = this.velocityY = new Float32Array(0);
    this.fixedX = this.fixedY = new Float32Array(0);
    this.pinnedX = this.pinnedY = new Uint8Array(0);
    this.repulsion = this.collisionRadius = new Float32Array(0);
    this.predicted = new Float32Array(0);
    this.linkSource = this.linkTarget = new Int32Array(0);
    this.linkDistance = this.linkStrength = new Float32Array(0);
    this.linkSourceShare = this.linkTargetShare = new Float32Array(0);
    this.degree = new Int32Array(0);
    this.linkKeys = [];
    this.linkKeySet.clear();
    this.forceOutput = new Float64Array(0);
    this.nodeCapacity = 0;
    this.linkCapacity = 0;
    this.quadtree.dispose();
  }

  private tick(): void {
    const positions = this.positionStorage;
    this.sanitizeState();
    this.quadtree.build(positions, this.repulsion, this.nodeCount);
    for (let node = 0; node < this.nodeCount; node++) {
      this.quadtree.force(
        positions[node * 2],
        positions[node * 2 + 1],
        this.theta,
        node,
        this.forceOutput,
        this.repulsionDistanceMax,
      );
      if (!this.pinnedX[node])
        this.velocityX[node] = toF32(this.velocityX[node] + this.forceOutput[0] * this.alpha);
      if (!this.pinnedY[node])
        this.velocityY[node] = toF32(this.velocityY[node] + this.forceOutput[1] * this.alpha);
    }

    for (let link = 0; link < this.linkCount; link++) {
      const source = this.linkSource[link];
      const target = this.linkTarget[link];
      let dx =
        (this.pinnedX[target]
          ? this.fixedX[target]
          : positions[target * 2] + this.velocityX[target]) -
        (this.pinnedX[source]
          ? this.fixedX[source]
          : positions[source * 2] + this.velocityX[source]);
      let dy =
        (this.pinnedY[target]
          ? this.fixedY[target]
          : positions[target * 2 + 1] + this.velocityY[target]) -
        (this.pinnedY[source]
          ? this.fixedY[source]
          : positions[source * 2 + 1] + this.velocityY[source]);
      let distance = Math.hypot(dx, dy);
      if (distance < 1e-6) {
        const angle = deterministicAngle(source, target, this.seed);
        dx = Math.cos(angle) * 1e-6;
        dy = Math.sin(angle) * 1e-6;
        distance = 1e-6;
      }
      const displacement =
        ((distance - this.linkDistance[link]) / distance) * this.linkStrength[link] * this.alpha;
      const forceX = toF32(dx * displacement);
      const forceY = toF32(dy * displacement);
      const sourceShareX = springShare(
        this.linkSourceShare[link],
        this.pinnedX[source],
        this.pinnedX[target],
      );
      const targetShareX = springShare(
        this.linkTargetShare[link],
        this.pinnedX[target],
        this.pinnedX[source],
      );
      const sourceShareY = springShare(
        this.linkSourceShare[link],
        this.pinnedY[source],
        this.pinnedY[target],
      );
      const targetShareY = springShare(
        this.linkTargetShare[link],
        this.pinnedY[target],
        this.pinnedY[source],
      );
      this.velocityX[source] = toF32(this.velocityX[source] + forceX * sourceShareX);
      this.velocityY[source] = toF32(this.velocityY[source] + forceY * sourceShareY);
      this.velocityX[target] = toF32(this.velocityX[target] - forceX * targetShareX);
      this.velocityY[target] = toF32(this.velocityY[target] - forceY * targetShareY);
    }

    this.applyCollisions();
    const center = this.centerStrength * this.alpha;
    for (let node = 0; node < this.nodeCount; node++) {
      let x = positions[node * 2];
      let y = positions[node * 2 + 1];
      let velocityX = toF32((this.velocityX[node] - x * center) * this.velocityDecay);
      let velocityY = toF32((this.velocityY[node] - y * center) * this.velocityDecay);
      if (!this.pinnedX[node]) {
        x = toF32(x + velocityX);
      } else {
        x = this.fixedX[node];
        velocityX = 0;
      }
      if (!this.pinnedY[node]) {
        y = toF32(y + velocityY);
      } else {
        y = this.fixedY[node];
        velocityY = 0;
      }
      positions[node * 2] = x;
      positions[node * 2 + 1] = y;
      this.velocityX[node] = velocityX;
      this.velocityY[node] = velocityY;
    }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
  }

  private applyCollisions(): void {
    let maximumRadius = 0;
    for (let i = 0; i < this.nodeCount; i++)
      maximumRadius = Math.max(maximumRadius, this.collisionRadius[i]);
    if (maximumRadius <= 0 || this.collisionStrength <= 0) return;
    const positions = this.positionStorage;
    for (let node = 0; node < this.nodeCount; node++) {
      this.predicted[node * 2] = this.pinnedX[node]
        ? this.fixedX[node]
        : toF32(positions[node * 2] + this.velocityX[node]);
      this.predicted[node * 2 + 1] = this.pinnedY[node]
        ? this.fixedY[node]
        : toF32(positions[node * 2 + 1] + this.velocityY[node]);
    }
    this.quadtree.build(this.predicted, this.repulsion, this.nodeCount);
    for (let source = 0; source < this.nodeCount; source++) {
      const sourceRadius = this.collisionRadius[source];
      const sourceX = this.predicted[source * 2];
      const sourceY = this.predicted[source * 2 + 1];
      this.quadtree.forEachNearby(sourceX, sourceY, sourceRadius + maximumRadius, (target) => {
        if (target <= source) return;
        const minimumDistance = sourceRadius + this.collisionRadius[target];
        if (minimumDistance <= 0) return;
        let dx = this.predicted[target * 2] - sourceX;
        let dy = this.predicted[target * 2 + 1] - sourceY;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimumDistance) return;
        if (distance < 1e-6) {
          const angle = deterministicAngle(source, target, this.seed);
          dx = Math.cos(angle) * 1e-6;
          dy = Math.sin(angle) * 1e-6;
          distance = 1e-6;
        }
        const overlap = ((minimumDistance - distance) / distance) * this.collisionStrength;
        const forceX = dx * overlap;
        const forceY = dy * overlap;
        const sourceShareX = collisionShare(this.pinnedX[source], this.pinnedX[target]);
        const targetShareX = collisionShare(this.pinnedX[target], this.pinnedX[source]);
        const sourceShareY = collisionShare(this.pinnedY[source], this.pinnedY[target]);
        const targetShareY = collisionShare(this.pinnedY[target], this.pinnedY[source]);
        this.velocityX[source] = toF32(this.velocityX[source] - forceX * sourceShareX);
        this.velocityY[source] = toF32(this.velocityY[source] - forceY * sourceShareY);
        this.velocityX[target] = toF32(this.velocityX[target] + forceX * targetShareX);
        this.velocityY[target] = toF32(this.velocityY[target] + forceY * targetShareY);
      });
    }
  }

  private addNode(node: GraphNode): void {
    const index = this.nodeCount++;
    this.nodes.push(node);
    this.nodeIndex.set(node.id, index);
    const random = mulberry32((this.seed + Math.imul(this.placementIndex + 1, 0x9e3779b9)) >>> 0);
    const radius = 10 * Math.sqrt(this.placementIndex + 1);
    const angle = random() * Math.PI * 2;
    this.placementIndex++;
    const seededX = finiteOr(node.x, radius * Math.cos(angle));
    const seededY = finiteOr(node.y, radius * Math.sin(angle));
    const fixedX = optionalFinite(node.fx);
    const fixedY = optionalFinite(node.fy);
    this.positionStorage[index * 2] = toF32(fixedX ?? seededX);
    this.positionStorage[index * 2 + 1] = toF32(fixedY ?? seededY);
    this.velocityX[index] = 0;
    this.velocityY[index] = 0;
    this.fixedX[index] = toF32(fixedX ?? 0);
    this.fixedY[index] = toF32(fixedY ?? 0);
    this.pinnedX[index] = fixedX === undefined ? 0 : 1;
    this.pinnedY[index] = fixedY === undefined ? 0 : 1;
    this.repulsion[index] = toF32(resolveNodeValue(this.repulsionOption, node, index, 300), 300, 0);
    this.collisionRadius[index] = toF32(
      resolveNodeValue(this.collisionRadiusOption, node, index, 0),
      0,
      0,
    );
  }

  private appendLinks(links: readonly GraphLink[]): number {
    const valid: Array<[number, number, number, number, string]> = [];
    const pendingKeys = new Set<string>();
    for (const link of links) {
      const source = this.nodeIndex.get(link.source);
      const target = this.nodeIndex.get(link.target);
      if (source === undefined || target === undefined || source === target) continue;
      const key = linkIdentity(link);
      if (this.linkKeySet.has(key) || pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      const globalIndex = this.linkCount + valid.length;
      valid.push([
        source,
        target,
        resolveLinkValue(this.linkDistanceOption, link, globalIndex, 30),
        resolveLinkValue(this.linkStrengthOption, link, globalIndex, 0.3),
        key,
      ]);
    }
    this.ensureLinkCapacity(this.linkCount + valid.length);
    for (const [source, target, distance, strength, key] of valid) {
      this.linkSource[this.linkCount] = source;
      this.linkTarget[this.linkCount] = target;
      this.linkDistance[this.linkCount] = toF32(distance, 30, 0);
      this.linkStrength[this.linkCount] = toF32(strength, 0.3, 0);
      this.linkKeys[this.linkCount] = key;
      this.linkKeySet.add(key);
      this.linkCount++;
    }
    if (valid.length > 0) this.recomputeLinkBias();
    return valid.length;
  }

  private ensureNodeCapacity(required: number): void {
    if (required <= this.nodeCapacity) return;
    const capacity = grownCapacity(this.nodeCapacity, required);
    this.positionStorage = resize(this.positionStorage, capacity * 2);
    this.velocityX = resize(this.velocityX, capacity);
    this.velocityY = resize(this.velocityY, capacity);
    this.fixedX = resize(this.fixedX, capacity);
    this.fixedY = resize(this.fixedY, capacity);
    this.pinnedX = resize(this.pinnedX, capacity);
    this.pinnedY = resize(this.pinnedY, capacity);
    this.repulsion = resize(this.repulsion, capacity);
    this.collisionRadius = resize(this.collisionRadius, capacity);
    this.predicted = resize(this.predicted, capacity * 2);
    this.degree = resize(this.degree, capacity);
    this.nodeCapacity = capacity;
  }

  private ensureLinkCapacity(required: number): void {
    if (required <= this.linkCapacity) return;
    const capacity = grownCapacity(this.linkCapacity, required);
    this.linkSource = resize(this.linkSource, capacity);
    this.linkTarget = resize(this.linkTarget, capacity);
    this.linkDistance = resize(this.linkDistance, capacity);
    this.linkStrength = resize(this.linkStrength, capacity);
    this.linkSourceShare = resize(this.linkSourceShare, capacity);
    this.linkTargetShare = resize(this.linkTargetShare, capacity);
    this.linkCapacity = capacity;
  }

  private recomputeLinkBias(): void {
    this.degree.fill(0, 0, this.nodeCount);
    for (let link = 0; link < this.linkCount; link++) {
      this.degree[this.linkSource[link]]++;
      this.degree[this.linkTarget[link]]++;
    }
    for (let link = 0; link < this.linkCount; link++) {
      const sourceDegree = this.degree[this.linkSource[link]];
      const targetDegree = this.degree[this.linkTarget[link]];
      const total = sourceDegree + targetDegree;
      this.linkSourceShare[link] = toF32(targetDegree / total);
      this.linkTargetShare[link] = toF32(sourceDegree / total);
    }
  }

  private copyNodeState(source: number, target: number): void {
    this.positionStorage[target * 2] = this.positionStorage[source * 2];
    this.positionStorage[target * 2 + 1] = this.positionStorage[source * 2 + 1];
    this.velocityX[target] = this.velocityX[source];
    this.velocityY[target] = this.velocityY[source];
    this.fixedX[target] = this.fixedX[source];
    this.fixedY[target] = this.fixedY[source];
    this.pinnedX[target] = this.pinnedX[source];
    this.pinnedY[target] = this.pinnedY[source];
    this.repulsion[target] = this.repulsion[source];
    this.collisionRadius[target] = this.collisionRadius[source];
  }

  private rebuildNodeIndex(): void {
    this.nodeIndex.clear();
    for (let index = 0; index < this.nodeCount; index++)
      this.nodeIndex.set(this.nodes[index].id, index);
  }

  private clearGraph(): void {
    this.nodes = [];
    this.nodeIndex.clear();
    this.nodeCount = 0;
    this.linkCount = 0;
    this.linkKeys = [];
    this.linkKeySet.clear();
    this.placementIndex = 0;
    this.alpha = 1;
    this.refreshPositionView();
  }

  private refreshPositionView(): void {
    this.positions = this.positionStorage.subarray(0, this.nodeCount * 2);
  }

  private sanitizeState(): void {
    for (let node = 0; node < this.nodeCount; node++) {
      const offset = node * 2;
      this.positionStorage[offset] = toF32(this.positionStorage[offset]);
      this.positionStorage[offset + 1] = toF32(this.positionStorage[offset + 1]);
      this.velocityX[node] = toF32(this.velocityX[node]);
      this.velocityY[node] = toF32(this.velocityY[node]);
      this.fixedX[node] = toF32(this.fixedX[node]);
      this.fixedY[node] = toF32(this.fixedY[node]);
      this.repulsion[node] = toF32(this.repulsion[node], 0, 0);
      this.collisionRadius[node] = toF32(this.collisionRadius[node], 0, 0);
      if (this.pinnedX[node]) this.positionStorage[offset] = this.fixedX[node];
      if (this.pinnedY[node]) this.positionStorage[offset + 1] = this.fixedY[node];
    }
  }

  private validNodeIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.nodeCount;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ForceLayout2D was disposed');
  }
}

function resolveNodeValue(
  option: NodeValue,
  node: GraphNode,
  index: number,
  fallback: number,
): number {
  const value = typeof option === 'function' ? option(node, index) : option;
  return finiteOr(value, fallback, 0);
}

function resolveLinkValue(
  option: LinkValue,
  link: GraphLink,
  index: number,
  fallback: number,
): number {
  const value = typeof option === 'function' ? option(link, index) : option;
  return finiteOr(value, fallback, 0);
}

function finiteOr(
  value: unknown,
  fallback: number,
  minimum = -Infinity,
  maximum = Infinity,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function toF32(value: unknown, fallback = 0, minimum = -F32_MAX): number {
  const finite = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return f(Math.max(minimum, Math.min(F32_MAX, finite)));
}

function normalizeIterations(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 10_000);
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function linkIdentity(link: GraphLink): string {
  const id = isNodeId(link.id) ? idKey(link.id) : '';
  return JSON.stringify([idKey(link.source), idKey(link.target), id]);
}

function idKey(id: NodeId): string {
  const value = String(id);
  return `${typeof id}:${value.length}:${value}`;
}

function collisionShare(axisPinned: number, otherAxisPinned: number): number {
  if (axisPinned) return 0;
  return otherAxisPinned ? 1 : 0.5;
}

function springShare(share: number, axisPinned: number, otherAxisPinned: number): number {
  if (axisPinned) return 0;
  return otherAxisPinned ? 1 : share;
}

function grownCapacity(current: number, required: number): number {
  let next = Math.max(4, current);
  while (next < required) next *= 2;
  return next;
}

function resize<T extends Float32Array | Int32Array | Uint8Array>(
  source: T,
  length: number,
  fill?: number,
): T {
  const result = new (source.constructor as new (length: number) => T)(length);
  if (fill !== undefined) result.fill(fill);
  result.set(source.subarray(0, Math.min(source.length, length)));
  return result;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicAngle(source: number, target: number, seed: number): number {
  const random = mulberry32(
    (seed ^ Math.imul(source + 1, 0x9e3779b9) ^ Math.imul(target + 1, 0x85ebca6b)) >>> 0,
  );
  return random() * Math.PI * 2;
}
