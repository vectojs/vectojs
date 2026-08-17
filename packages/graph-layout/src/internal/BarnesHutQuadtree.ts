const MAX_DEPTH = 40;

/** Flat-array true-2D Barnes-Hut quadtree reused across simulation ticks. */
export class BarnesHutQuadtree {
  private cellX = new Float64Array(0);
  private cellY = new Float64Array(0);
  private centerX = new Float64Array(0);
  private centerY = new Float64Array(0);
  private halfSize = new Float64Array(0);
  private charge = new Float64Array(0);
  private child = new Int32Array(0);
  private pointHead = new Int32Array(0);
  private internal = new Uint8Array(0);
  private pointNext = new Int32Array(0);
  private stack = new Int32Array(64);
  private collisionUsed = new Uint8Array(0);
  private collisionCellX = new Float64Array(0);
  private collisionCellY = new Float64Array(0);
  private collisionHead = new Int32Array(0);
  private collisionNext = new Int32Array(0);
  private collisionProbeSlots = new Int32Array(9);
  private positions: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private charges: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private capacity = 0;
  private pointCapacity = 0;
  private nodeCount = 0;

  public build(
    positions: Float32Array<ArrayBufferLike>,
    charges: Float32Array<ArrayBufferLike>,
    count: number,
  ): void {
    this.positions = positions;
    this.charges = charges;
    if (count === 0) {
      this.nodeCount = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let point = 0; point < count; point++) {
      const x = positions[point * 2];
      const y = positions[point * 2 + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const size = Math.max(maxX - minX, maxY - minY, 1e-3);
    this.ensureNodes(Math.max(64, count * 4 + 4));
    this.ensurePoints(count);
    this.pointNext.fill(-1, 0, count);
    this.nodeCount = 1;
    this.resetNode(0, (minX + maxX) * 0.5, (minY + maxY) * 0.5, size * 0.5 + 1e-6);
    for (let point = 0; point < count; point++) this.insert(point);
    this.finalize();
  }

  public force(
    qx: number,
    qy: number,
    theta: number,
    pointIndex: number,
    out: Float64Array<ArrayBufferLike>,
    maxDistance = Infinity,
  ): void {
    if (this.nodeCount === 0 || maxDistance <= 0) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    let forceX = 0;
    let forceY = 0;
    const maxDistanceSquared = maxDistance * maxDistance;
    const cutoffTolerance = Math.max(1e-12, maxDistanceSquared * 1e-12);
    let stackSize = 0;
    this.ensureStack(this.nodeCount);
    this.stack[stackSize++] = 0;
    while (stackSize > 0) {
      const node = this.stack[--stackSize];
      const nearestDistanceSquared = distanceToCellSquared(
        qx,
        qy,
        this.cellX[node],
        this.cellY[node],
        this.halfSize[node],
      );
      if (nearestDistanceSquared > maxDistanceSquared + cutoffTolerance) continue;
      const charge = this.charge[node];
      if (charge <= 0) continue;
      const leaf = this.internal[node] === 0;
      const dx = this.centerX[node] - qx;
      const dy = this.centerY[node] - qy;
      const distanceSquared = dx * dx + dy * dy;
      const containsQuery =
        Math.abs(qx - this.cellX[node]) <= this.halfSize[node] &&
        Math.abs(qy - this.cellY[node]) <= this.halfSize[node];
      if (
        !leaf &&
        !containsQuery &&
        distanceSquared < maxDistanceSquared &&
        4 * this.halfSize[node] * this.halfSize[node] < theta * theta * distanceSquared
      ) {
        let contributionX = dx;
        let contributionY = dy;
        let contributionDistanceSquared = distanceSquared;
        if (contributionDistanceSquared < 1e-12) {
          const angle = pairAngle(pointIndex, -1);
          contributionX = Math.cos(angle) * 1e-6;
          contributionY = Math.sin(angle) * 1e-6;
          contributionDistanceSquared = 1e-6;
        }
        contributionDistanceSquared = Math.max(contributionDistanceSquared, 1e-6);
        const inverseDistance = 1 / Math.sqrt(contributionDistanceSquared);
        const factor = (-charge * inverseDistance) / contributionDistanceSquared;
        forceX += contributionX * factor;
        forceY += contributionY * factor;
        continue;
      }
      if (leaf) {
        for (let point = this.pointHead[node]; point >= 0; point = this.pointNext[point]) {
          if (point === pointIndex) continue;
          let contributionX = this.positions[point * 2] - qx;
          let contributionY = this.positions[point * 2 + 1] - qy;
          let contributionDistanceSquared =
            contributionX * contributionX + contributionY * contributionY;
          if (contributionDistanceSquared >= maxDistanceSquared) continue;
          if (contributionDistanceSquared < 1e-12) {
            const angle = pairAngle(pointIndex, point);
            const direction = pointIndex < point ? 1 : -1;
            contributionX = Math.cos(angle) * direction * 1e-6;
            contributionY = Math.sin(angle) * direction * 1e-6;
            contributionDistanceSquared = 1e-6;
          }
          contributionDistanceSquared = Math.max(contributionDistanceSquared, 1e-6);
          const inverseDistance = 1 / Math.sqrt(contributionDistanceSquared);
          const factor = (-this.charges[point] * inverseDistance) / contributionDistanceSquared;
          forceX += contributionX * factor;
          forceY += contributionY * factor;
        }
        continue;
      }
      const offset = node * 4;
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const child = this.child[offset + quadrant];
        if (child >= 0) this.stack[stackSize++] = child;
      }
    }
    out[0] = forceX;
    out[1] = forceY;
  }

  public forEachNearby(
    qx: number,
    qy: number,
    radius: number,
    visit: (pointIndex: number) => void,
  ): void {
    if (this.nodeCount === 0) return;
    let stackSize = 0;
    this.ensureStack(this.nodeCount);
    this.stack[stackSize++] = 0;
    while (stackSize > 0) {
      const node = this.stack[--stackSize];
      const dx = Math.max(Math.abs(qx - this.cellX[node]) - this.halfSize[node], 0);
      const dy = Math.max(Math.abs(qy - this.cellY[node]) - this.halfSize[node], 0);
      if (dx * dx + dy * dy > radius * radius) continue;
      if (this.internal[node] === 0) {
        for (let point = this.pointHead[node]; point >= 0; point = this.pointNext[point])
          visit(point);
        continue;
      }
      const offset = node * 4;
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const child = this.child[offset + quadrant];
        if (child >= 0) this.stack[stackSize++] = child;
      }
    }
  }

  public applyGridCollisions(
    positions: Float32Array<ArrayBufferLike>,
    pointCount: number,
    radii: Float32Array<ArrayBufferLike>,
    velocitiesX: Float32Array<ArrayBufferLike>,
    velocitiesY: Float32Array<ArrayBufferLike>,
    pinnedX: Uint8Array<ArrayBufferLike>,
    pinnedY: Uint8Array<ArrayBufferLike>,
    strength: number,
    seed: number,
  ): void {
    let maximumRadius = 0;
    for (let point = 0; point < pointCount; point++)
      maximumRadius = Math.max(maximumRadius, radii[point]);
    if (maximumRadius <= 0) return;
    this.ensureCollisionGrid(pointCount * 2);
    const cellSize = Math.max(maximumRadius * 2, 1);
    this.collisionUsed.fill(0);
    this.collisionHead.fill(-1);
    this.collisionNext.fill(-1, 0, pointCount);
    for (let point = 0; point < pointCount; point++) {
      const cellX = Math.floor(positions[point * 2] / cellSize);
      const cellY = Math.floor(positions[point * 2 + 1] / cellSize);
      const slot = this.collisionSlot(cellX, cellY, true);
      this.collisionNext[point] = this.collisionHead[slot]!;
      this.collisionHead[slot] = point;
    }
    for (let source = 0; source < pointCount; source++) {
      const sourceX = positions[source * 2];
      const sourceY = positions[source * 2 + 1];
      const sourceRadius = radii[source];
      const cellX = Math.floor(sourceX / cellSize);
      const cellY = Math.floor(sourceY / cellSize);
      let probeCount = 0;
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          const slot = this.collisionSlot(cellX + offsetX, cellY + offsetY, false);
          if (slot < 0) continue;
          let duplicate = false;
          for (let probe = 0; probe < probeCount; probe++) {
            const previous = this.collisionProbeSlots[probe];
            if (
              previous === slot ||
              (this.collisionCellX[previous] === this.collisionCellX[slot] &&
                this.collisionCellY[previous] === this.collisionCellY[slot])
            ) {
              duplicate = true;
              break;
            }
          }
          if (duplicate) continue;
          this.collisionProbeSlots[probeCount++] = slot;
          for (
            let target = this.collisionHead[slot]!;
            target >= 0;
            target = this.collisionNext[target]!
          ) {
            if (target <= source) continue;
            const minimumDistance = sourceRadius + radii[target];
            let dx = positions[target * 2] - sourceX;
            let dy = positions[target * 2 + 1] - sourceY;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared >= minimumDistance * minimumDistance) continue;
            let distance = Math.sqrt(distanceSquared);
            if (distance < 1e-6) {
              const angle = collisionPairAngle(source, target, seed);
              dx = Math.cos(angle) * 1e-6;
              dy = Math.sin(angle) * 1e-6;
              distance = 1e-6;
            }
            const overlap = ((minimumDistance - distance) / distance) * strength;
            const forceX = dx * overlap;
            const forceY = dy * overlap;
            const sourceShareX = pinnedX[source] ? 0 : pinnedX[target] ? 1 : 0.5;
            const targetShareX = pinnedX[target] ? 0 : pinnedX[source] ? 1 : 0.5;
            const sourceShareY = pinnedY[source] ? 0 : pinnedY[target] ? 1 : 0.5;
            const targetShareY = pinnedY[target] ? 0 : pinnedY[source] ? 1 : 0.5;
            velocitiesX[source] = toF32(velocitiesX[source] - forceX * sourceShareX);
            velocitiesY[source] = toF32(velocitiesY[source] - forceY * sourceShareY);
            velocitiesX[target] = toF32(velocitiesX[target] + forceX * targetShareX);
            velocitiesY[target] = toF32(velocitiesY[target] + forceY * targetShareY);
          }
        }
      }
    }
  }

  public dispose(): void {
    this.cellX = this.cellY = new Float64Array(0);
    this.centerX = this.centerY = this.halfSize = this.charge = new Float64Array(0);
    this.child = this.pointHead = this.pointNext = new Int32Array(0);
    this.internal = new Uint8Array(0);
    this.stack = new Int32Array(0);
    this.collisionUsed = new Uint8Array(0);
    this.collisionCellX = this.collisionCellY = new Float64Array(0);
    this.collisionHead = this.collisionNext = new Int32Array(0);
    this.collisionProbeSlots = new Int32Array(9);
    this.positions = this.charges = new Float32Array(0);
    this.capacity = 0;
    this.pointCapacity = 0;
    this.nodeCount = 0;
  }

  private insert(point: number): void {
    const x = this.positions[point * 2];
    const y = this.positions[point * 2 + 1];
    let node = 0;
    for (let depth = 0; ; depth++) {
      if (this.internal[node]) {
        node = this.childFor(node, x, y);
        continue;
      }
      const head = this.pointHead[node];
      if (head < 0 || depth >= MAX_DEPTH) {
        this.pointNext[point] = head;
        this.pointHead[node] = point;
        return;
      }
      this.pointHead[node] = -1;
      this.internal[node] = 1;
      for (let existing = head; existing >= 0;) {
        const next = this.pointNext[existing];
        const child = this.childFor(
          node,
          this.positions[existing * 2],
          this.positions[existing * 2 + 1],
        );
        this.pointNext[existing] = this.pointHead[child];
        this.pointHead[child] = existing;
        existing = next;
      }
      node = this.childFor(node, x, y);
    }
  }

  private childFor(node: number, x: number, y: number): number {
    const quadrant = (x >= this.cellX[node] ? 1 : 0) | (y >= this.cellY[node] ? 2 : 0);
    const slot = node * 4 + quadrant;
    let child = this.child[slot];
    if (child < 0) {
      const half = this.halfSize[node] * 0.5;
      child = this.allocateNode(
        this.cellX[node] + (quadrant & 1 ? half : -half),
        this.cellY[node] + (quadrant & 2 ? half : -half),
        half,
      );
      this.child[slot] = child;
    }
    return child;
  }

  private finalize(): void {
    for (let node = this.nodeCount - 1; node >= 0; node--) {
      let total = 0;
      let weightedX = 0;
      let weightedY = 0;
      if (this.internal[node] === 0) {
        for (let point = this.pointHead[node]; point >= 0; point = this.pointNext[point]) {
          const charge = this.charges[point];
          total += charge;
          weightedX += this.positions[point * 2] * charge;
          weightedY += this.positions[point * 2 + 1] * charge;
        }
      } else {
        for (let quadrant = 0; quadrant < 4; quadrant++) {
          const child = this.child[node * 4 + quadrant];
          if (child < 0) continue;
          total += this.charge[child];
          weightedX += this.centerX[child] * this.charge[child];
          weightedY += this.centerY[child] * this.charge[child];
        }
      }
      this.charge[node] = total;
      if (total > 0) {
        this.centerX[node] = weightedX / total;
        this.centerY[node] = weightedY / total;
      }
    }
  }

  private allocateNode(x: number, y: number, halfSize: number): number {
    if (this.nodeCount >= this.capacity) this.ensureNodes(this.capacity * 2);
    const node = this.nodeCount++;
    this.resetNode(node, x, y, halfSize);
    return node;
  }

  private resetNode(node: number, x: number, y: number, halfSize: number): void {
    this.cellX[node] = this.centerX[node] = x;
    this.cellY[node] = this.centerY[node] = y;
    this.halfSize[node] = halfSize;
    this.charge[node] = 0;
    this.pointHead[node] = -1;
    this.internal[node] = 0;
    this.child.fill(-1, node * 4, node * 4 + 4);
  }

  private ensureNodes(required: number): void {
    if (required <= this.capacity) return;
    let next = Math.max(64, this.capacity);
    while (next < required) next *= 2;
    this.cellX = resize(this.cellX, next);
    this.cellY = resize(this.cellY, next);
    this.centerX = resize(this.centerX, next);
    this.centerY = resize(this.centerY, next);
    this.halfSize = resize(this.halfSize, next);
    this.charge = resize(this.charge, next);
    this.child = resize(this.child, next * 4, -1);
    this.pointHead = resize(this.pointHead, next, -1);
    this.internal = resize(this.internal, next);
    this.capacity = next;
  }

  private ensurePoints(required: number): void {
    if (required <= this.pointCapacity) return;
    let next = Math.max(64, this.pointCapacity);
    while (next < required) next *= 2;
    this.pointNext = resize(this.pointNext, next, -1);
    this.pointCapacity = next;
  }

  private ensureStack(required: number): void {
    if (required <= this.stack.length) return;
    let next = Math.max(64, this.stack.length);
    while (next < required) next *= 2;
    this.stack = resize(this.stack, next);
  }

  private ensureCollisionGrid(required: number): void {
    let capacity = this.collisionUsed.length || 64;
    while (capacity < required) capacity *= 2;
    if (capacity === this.collisionUsed.length) return;
    this.collisionUsed = new Uint8Array(capacity);
    this.collisionCellX = new Float64Array(capacity);
    this.collisionCellY = new Float64Array(capacity);
    this.collisionHead = new Int32Array(capacity);
    this.collisionNext = new Int32Array(Math.max(this.pointCapacity, required));
  }

  private collisionSlot(cellX: number, cellY: number, create: boolean): number {
    const mask = this.collisionUsed.length - 1;
    let slot = (Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663)) & mask;
    while (this.collisionUsed[slot]) {
      if (this.collisionCellX[slot] === cellX && this.collisionCellY[slot] === cellY) return slot;
      slot = (slot + 1) & mask;
    }
    if (!create) return -1;
    this.collisionUsed[slot] = 1;
    this.collisionCellX[slot] = cellX;
    this.collisionCellY[slot] = cellY;
    return slot;
  }
}

function pairAngle(a: number, b: number): number {
  const low = Math.min(a, b) + 1;
  const high = Math.max(a, b) + 1;
  let value = Math.imul(low, 0x9e3779b9) ^ Math.imul(high, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  return ((value >>> 0) / 4294967296) * Math.PI * 2;
}

function collisionPairAngle(source: number, target: number, seed: number): number {
  const low = Math.min(source, target) + 1;
  const high = Math.max(source, target) + 1;
  let state = (seed ^ Math.imul(low, 0x9e3779b9) ^ Math.imul(high, 0x85ebca6b)) >>> 0;
  state = (state + 0x6d2b79f5) | 0;
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return (((value ^ (value >>> 14)) >>> 0) / 4294967296) * Math.PI * 2;
}

function toF32(value: number): number {
  return Math.fround(value);
}

function distanceToCellSquared(
  qx: number,
  qy: number,
  x: number,
  y: number,
  halfSize: number,
): number {
  const dx = Math.max(Math.abs(qx - x) - halfSize, 0);
  const dy = Math.max(Math.abs(qy - y) - halfSize, 0);
  return dx * dx + dy * dy;
}

function resize<T extends Float64Array | Int32Array | Uint8Array>(
  source: T,
  length: number,
  fill?: number,
): T {
  const result = new (source.constructor as new (length: number) => T)(length);
  if (fill !== undefined) result.fill(fill);
  result.set(source.subarray(0, Math.min(source.length, length)));
  return result;
}
