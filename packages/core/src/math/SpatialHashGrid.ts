/**
 * Fixed-cell Spatial Hash Grid for O(1) average-case AABB neighbor queries.
 * Insert entities each frame, then query by AABB to find nearby entity IDs.
 */
export class SpatialHashGrid {
  private cellSize: number;
  private grid: Map<number, Set<string>> = new Map();
  private entityCells: Map<string, number[]> = new Map();

  constructor(cellSize: number = 64) {
    this.cellSize = cellSize;
  }

  private hash(cx: number, cy: number): number {
    const x = cx < 0 ? -2 * cx - 1 : 2 * cx;
    const y = cy < 0 ? -2 * cy - 1 : 2 * cy;
    return ((x + y) * (x + y + 1)) / 2 + y;
  }

  private cellsForAABB(x: number, y: number, w: number, h: number): number[] {
    const minCx = Math.floor(x / this.cellSize);
    const minCy = Math.floor(y / this.cellSize);
    const maxCx = Math.floor((x + w) / this.cellSize);
    const maxCy = Math.floor((y + h) / this.cellSize);
    const keys: number[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        keys.push(this.hash(cx, cy));
      }
    }
    return keys;
  }

  /** Insert or update an entity's bounding box in the grid. */
  insert(id: string, x: number, y: number, w: number, h: number): void {
    this.remove(id);
    const keys = this.cellsForAABB(x, y, w, h);
    this.entityCells.set(id, keys);
    for (const key of keys) {
      if (!this.grid.has(key)) this.grid.set(key, new Set());
      this.grid.get(key)!.add(id);
    }
  }

  /** Remove an entity from all grid cells. */
  remove(id: string): void {
    const keys = this.entityCells.get(id);
    if (!keys) return;
    for (const key of keys) {
      this.grid.get(key)?.delete(id);
    }
    this.entityCells.delete(id);
  }

  /** Query all entity IDs whose cells overlap the given AABB. */
  query(x: number, y: number, w: number, h: number): Set<string> {
    const result = new Set<string>();
    for (const key of this.cellsForAABB(x, y, w, h)) {
      const cell = this.grid.get(key);
      if (cell) for (const id of cell) result.add(id);
    }
    return result;
  }

  /** Clear all cells and entity registrations. */
  clear(): void {
    this.grid.clear();
    this.entityCells.clear();
  }
}
