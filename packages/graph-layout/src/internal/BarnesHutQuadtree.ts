const MAX_DEPTH = 40;

/** Sentinel tier for zero-radius points: below every real (finite) tier so
 * they only ever act as cross-tier probe initiators, never as grid owners. */
const ZERO_TIER = -0x40000000;

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
  private collisionTier = new Int32Array(0);
  private collisionOrder = new Int32Array(0);
  private collisionOrderOffsets = new Int32Array(0);
  private collisionOrderCursor = new Int32Array(0);
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
      // INVARIANT: skipping subtrees whose aggregated charge is <= 0 is only
      // sound while every point charge is non-negative. ForceLayout2D clamps
      // repulsion to >= 0 when resolving accessors (addNode/sanitizeState),
      // so a nonpositive subtree total means an empty subtree or exactly
      // cancelling charges — either contributes ~zero net force and skipping
      // it merely avoids wasted work. d3-style NEGATIVE (attractive) charges
      // would make cancelled subtrees real force carriers; revisit this skip
      // and finalize()'s `total > 0` center-of-charge guard before ever
      // allowing negative charge magnitudes through.
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
    this.ensureCollisionScratch(pointCount);

    // Bin points into power-of-two RADIUS tiers instead of sizing one global
    // grid from the maximum radius. A single `cellSize = 2·maxRadius` packs
    // every small node into huge cells whenever one hub dominates, and the
    // fixed 3×3 probe below degenerates into quadratic pair scans (measured
    // 12ms → 197ms per tick going from 3k to 12k points with one large hub).
    //
    // Tier t holds radii in [2^t, 2^(t+1)) and uses cell size C_t = 2^(t+2):
    // - same tier: any overlapping pair is closer than r_i + r_j < 2^(t+2) =
    //   C_t, so the two cells are equal or adjacent — the 3×3 probe finds it;
    // - cross tier (s < b): the SMALLER point probes the BIGGER tier's grid,
    //   where r_small + r_big < 2^(s+1) + 2^(b+1) ≤ 3·2^b < C_b, again within
    //   one adjacent-cell ring. Each pair has a unique bigger-tier member, so
    //   it is resolved exactly once.
    // Cell occupancy therefore tracks LOCAL density for every distribution,
    // while uniform-radius scenes collapse to a single tier that behaves like
    // the old maximum-based sizing.
    const tierOf = this.collisionTier;
    let minTier = 0;
    let maxTier = -1; // max < min encodes "no positive-radius point yet"
    for (let point = 0; point < pointCount; point++) {
      const radius = radii[point]!;
      if (radius > 0) {
        // floor(log2(r)): floating-point rounding can only ever drop a
        // boundary radius into the finer tier, which keeps every bound above
        // valid (they only get more conservative).
        const tier = Math.floor(Math.log2(radius));
        tierOf[point] = tier;
        if (tier < minTier) minTier = tier;
        if (tier > maxTier) maxTier = tier;
      } else {
        // Zero-radius points never own a grid, but they still collide against
        // larger neighbors (distance < r_other). Bucket them below every real
        // tier so they act as initiators only.
        tierOf[point] = ZERO_TIER;
      }
    }
    const zeroBucket = minTier - 1;
    let lowest = minTier;
    for (let point = 0; point < pointCount; point++) {
      if (tierOf[point] === ZERO_TIER) {
        tierOf[point] = zeroBucket;
        lowest = zeroBucket;
      }
    }

    // Counting-sort points by tier so each pass walks contiguous slices.
    const tierCount = maxTier - lowest + 1;
    const offsets = this.collisionOrderOffsets;
    offsets.fill(0, 0, tierCount + 1);
    for (let point = 0; point < pointCount; point++) offsets[tierOf[point]! - lowest + 1]++;
    for (let tier = 0; tier < tierCount; tier++) offsets[tier + 1] += offsets[tier]!;
    const order = this.collisionOrder;
    const cursor = this.collisionOrderCursor;
    cursor.set(offsets.subarray(0, tierCount));
    for (let point = 0; point < pointCount; point++)
      order[cursor[tierOf[point]! - lowest]++] = point;

    this.collisionUsed.fill(0);
    this.collisionNext.fill(-1, 0, pointCount);
    // When zero-radius points exist they fill bucket 0 (one below the smallest
    // real tier), so the real-tier slices start at index 1; otherwise index 0.
    const firstRealTier = minTier - lowest;
    for (let tierIndex = firstRealTier; tierIndex <= maxTier - lowest; tierIndex++) {
      const tier = lowest + tierIndex;
      const start = offsets[tierIndex]!;
      const end = offsets[tierIndex + 1]!;
      if (end === start) continue;

      // Build this tier's hash grid. One table is reused sequentially across
      // tiers; occupied slots stay ≤ pointCount over a ≥2·pointCount table.
      this.collisionUsed.fill(0);
      this.collisionHead.fill(-1);
      const cellSize = 4 * Math.pow(2, tier);
      for (let index = start; index < end; index++) {
        const point = order[index]!;
        const slot = this.collisionSlot(
          Math.floor(positions[point * 2] / cellSize),
          Math.floor(positions[point * 2 + 1] / cellSize),
          true,
        );
        this.collisionNext[point] = this.collisionHead[slot]!;
        this.collisionHead[slot] = point;
      }

      // Same tier: sources walk their own grid with the shared pair-once rule.
      for (let index = start; index < end; index++) {
        const source = order[index]!;
        const sourceX = positions[source * 2];
        const sourceY = positions[source * 2 + 1];
        const sourceRadius = radii[source]!;
        const cellX = Math.floor(sourceX / cellSize);
        const cellY = Math.floor(sourceY / cellSize);
        this.probeCollisionCell(
          positions,
          radii,
          velocitiesX,
          velocitiesY,
          pinnedX,
          pinnedY,
          strength,
          seed,
          source,
          sourceX,
          sourceY,
          sourceRadius,
          cellX,
          cellY,
          true,
        );
      }

      // Cross tier: every smaller-tier (or zero-radius) point probes this
      // tier's grid; each such pair resolves exactly once, initiated here.
      for (let lowerIndex = 0; lowerIndex < tierIndex; lowerIndex++) {
        const lowerStart = offsets[lowerIndex]!;
        const lowerEnd = offsets[lowerIndex + 1]!;
        for (let index = lowerStart; index < lowerEnd; index++) {
          const source = order[index]!;
          const sourceX = positions[source * 2];
          const sourceY = positions[source * 2 + 1];
          const cellX = Math.floor(sourceX / cellSize);
          const cellY = Math.floor(sourceY / cellSize);
          this.probeCollisionCell(
            positions,
            radii,
            velocitiesX,
            velocitiesY,
            pinnedX,
            pinnedY,
            strength,
            seed,
            source,
            sourceX,
            sourceY,
            radii[source]!,
            cellX,
            cellY,
            false,
          );
        }
      }
    }
  }

  /**
   * Walk the 3×3 cell neighborhood around (`cellX`, `cellY`) resolving the
   * collisions of `source` against candidates found there.
   *
   * When `sameTier` is true the candidates come from the source's own tier
   * grid, so unordered pairs must skip `target <= source` to resolve once.
   * Cross-tier probes need no such filter: every candidate belongs to a
   * strictly bigger tier than the initiating source, so each pair appears on
   * exactly one initiator by construction.
   */
  private probeCollisionCell(
    positions: Float32Array<ArrayBufferLike>,
    radii: Float32Array<ArrayBufferLike>,
    velocitiesX: Float32Array<ArrayBufferLike>,
    velocitiesY: Float32Array<ArrayBufferLike>,
    pinnedX: Uint8Array<ArrayBufferLike>,
    pinnedY: Uint8Array<ArrayBufferLike>,
    strength: number,
    seed: number,
    source: number,
    sourceX: number,
    sourceY: number,
    sourceRadius: number,
    cellX: number,
    cellY: number,
    sameTier: boolean,
  ): void {
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
            (this.collisionCellX[previous!] === this.collisionCellX[slot] &&
              this.collisionCellY[previous!] === this.collisionCellY[slot])
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
          if (sameTier && target <= source) continue;
          const minimumDistance = sourceRadius + radii[target]!;
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
    this.collisionTier = this.collisionOrder = new Int32Array(0);
    this.collisionOrderOffsets = this.collisionOrderCursor = new Int32Array(0);
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

  /** Per-point tier assignment plus counting-sorted point order, both reused
   * across ticks. `offsets` has one extra slot for the prefix-sum tail. */
  private ensureCollisionScratch(required: number): void {
    if (required <= this.collisionTier.length) return;
    let next = Math.max(64, this.collisionTier.length);
    while (next < required) next *= 2;
    this.collisionTier = new Int32Array(next);
    this.collisionOrder = new Int32Array(next);
    this.collisionOrderOffsets = new Int32Array(next + 1);
    this.collisionOrderCursor = new Int32Array(next + 1);
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
