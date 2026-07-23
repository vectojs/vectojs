/**
 * WASM hit-test broad-phase backend: builds a dense viewport grid from world
 * AABBs and answers "which entities overlap this cell" so a pointer query scans
 * a handful of candidates instead of every entity in the tree. This is an
 * invisible accelerator — the JS depth-first walk ({@link Entity.isPointInside}
 * over every node) is the permanent fallback, so a caller that cannot
 * instantiate WASM simply keeps using it. Failure is the default state, not an
 * error path.
 *
 * The grid is a coarse pre-filter only: it never decides a hit by itself.
 * {@link candidatesAt} returns the AABB-overlapping candidates in a cell
 * (ascending entity index — scan from the end for topmost-first); the caller
 * re-checks each one against its entity's own precise `isPointInside` (so
 * non-rectangular hit shapes stay correct) before trusting a result.
 */

/** The raw C ABI the crate (`crates/vectojs-core-rs/src/hit.rs`) exports. */
interface HitExports {
  memory: WebAssembly.Memory;
  hit_init(entityCap: number, cellCap: number, itemCap: number): void;
  hit_build(count: number, vw: number, vh: number, cellSize: number): void;
  hit_overflow(): number;
  p_h_minx(): number;
  p_h_miny(): number;
  p_h_maxx(): number;
  p_h_maxy(): number;
  p_h_cell_start(): number;
  p_h_cell_count(): number;
  p_h_items(): number;
}

const PAD = 8;
/** Average grid cells an entity's AABB is expected to span; sizes `item_cap`
 *  from the entity count. A build that needs more sets `hit_overflow()`, which
 *  the caller must treat as "grid untrustworthy this build" and fall back. */
const CELLS_PER_ENTITY_HINT = 4;

export class HitTestBackend {
  private readonly ex: HitExports;
  private entityCap = 0;
  private cellCap = 0;
  private itemCap = 0;
  private vminx!: Float64Array;
  private vminy!: Float64Array;
  private vmaxx!: Float64Array;
  private vmaxy!: Float64Array;
  private vCellStart!: Int32Array;
  private vCellCount!: Int32Array;
  private vItems!: Int32Array;

  /** Grid geometry from the last {@link ensure} call. */
  public gridW = 0;
  public gridH = 0;
  public cellSize = 64;

  constructor(instance: WebAssembly.Instance) {
    this.ex = instance.exports as unknown as HitExports;
  }

  /** The resident AABB input views (`minx/miny/maxx/maxy`), valid until the
   *  next capacity growth. Writing here is what {@link build} reads from. */
  inputView(): {
    minx: Float64Array;
    miny: Float64Array;
    maxx: Float64Array;
    maxy: Float64Array;
  } {
    return { minx: this.vminx, miny: this.vminy, maxx: this.vmaxx, maxy: this.vmaxy };
  }

  /**
   * Size (and grow, if needed) capacity for `count` entities over
   * `[0,vw] x [0,vh]` at `cellSize`, and record the grid geometry
   * {@link candidatesAt} needs. Call this BEFORE writing AABBs into
   * {@link inputView} — a capacity growth detaches the previous views, so
   * writing first and sizing after would write into a stale buffer.
   */
  ensure(count: number, vw: number, vh: number, cellSize: number): void {
    const gw = Math.max(1, Math.ceil(vw / cellSize));
    const gh = Math.max(1, Math.ceil(vh / cellSize));
    this.growIfNeeded(count, gw * gh, count * CELLS_PER_ENTITY_HINT);
    this.gridW = gw;
    this.gridH = gh;
    this.cellSize = cellSize;
  }

  /**
   * Run the kernel's bucketing over whatever is currently resident in
   * {@link inputView} (write the AABBs there, and call {@link ensure} first).
   * Returns `false` if the build overflowed its item budget — the caller must
   * not trust {@link candidatesAt} results for this build and should fall back
   * to the JS walk instead (never return a wrong hit).
   */
  runBuild(count: number, vw: number, vh: number, cellSize: number): boolean {
    this.ex.hit_build(count, vw, vh, cellSize);
    return this.ex.hit_overflow() === 0;
  }

  /**
   * Entity indices whose AABB overlaps the cell containing `(px, py)`, in
   * ascending index order (scan from the end for topmost/highest-index
   * first), or `null` if the point falls outside the built grid. This is a
   * coarse candidate LIST, not a hit result — the caller must still confirm
   * each candidate's AABB contains the point and re-check its precise
   * `isPointInside`.
   */
  candidatesAt(px: number, py: number): Int32Array | null {
    if (px < 0 || py < 0) return null;
    const cx = Math.floor(px / this.cellSize);
    const cy = Math.floor(py / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return null;
    const c = cy * this.gridW + cx;
    if (c >= this.cellCap) return null;
    const start = this.vCellStart[c];
    const count = this.vCellCount[c];
    return this.vItems.subarray(start, start + count);
  }

  private growIfNeeded(count: number, cellCount: number, itemCount: number): void {
    if (count + PAD <= this.entityCap && cellCount <= this.cellCap && itemCount <= this.itemCap) {
      return;
    }
    this.entityCap = count + PAD;
    this.cellCap = Math.max(cellCount, 1);
    this.itemCap = Math.max(itemCount, count, 1);
    this.ex.hit_init(count, this.cellCap, this.itemCap); // crate pads entity capacity by +PAD internally
    this.refreshViews();
  }

  /** Rebuild typed-array views after a growing `hit_init` (which detaches the
   *  memory buffer). */
  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    const eCap = this.entityCap;
    const cCap = this.cellCap;
    const iCap = this.itemCap;
    this.vminx = new Float64Array(buf, this.ex.p_h_minx(), eCap);
    this.vminy = new Float64Array(buf, this.ex.p_h_miny(), eCap);
    this.vmaxx = new Float64Array(buf, this.ex.p_h_maxx(), eCap);
    this.vmaxy = new Float64Array(buf, this.ex.p_h_maxy(), eCap);
    this.vCellStart = new Int32Array(buf, this.ex.p_h_cell_start(), cCap);
    this.vCellCount = new Int32Array(buf, this.ex.p_h_cell_count(), cCap);
    this.vItems = new Int32Array(buf, this.ex.p_h_items(), iCap);
  }
}

/**
 * Instantiate synchronously (Node/tests, or a worker). Rejected on the browser
 * main thread for modules >4 KB — use {@link instantiateAsync} there. Returns
 * `null` if compilation/instantiation throws, so callers fall back to JS.
 */
export function instantiateSync(bytes: BufferSource): HitTestBackend | null {
  try {
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    return new HitTestBackend(instance);
  } catch {
    return null;
  }
}

/**
 * Instantiate asynchronously (browser main thread). Returns `null` on any
 * failure — CSP `wasm-unsafe-eval`, unsupported, corrupt/missing bytes — so the
 * caller keeps using the JS path.
 */
export async function instantiateAsync(bytes: BufferSource): Promise<HitTestBackend | null> {
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new HitTestBackend(instance);
  } catch {
    return null;
  }
}

/** Anything the hit-test core can be loaded from, matching the transform
 *  core's {@link WasmModuleSource} loading ergonomics. */
export type HitModuleSource = BufferSource | string | URL | Response | Promise<Response>;

/**
 * Instantiate from a URL/Response using streaming compilation when the
 * platform supports it, falling back to fetch → arrayBuffer → instantiate when
 * unavailable or the response's MIME type is rejected. Returns `null` on any
 * failure so the caller keeps the JS path.
 */
export async function instantiateStreaming(
  source: string | URL | Response | Promise<Response>,
): Promise<HitTestBackend | null> {
  try {
    const resp =
      typeof source === 'string' || source instanceof URL
        ? await fetch(String(source))
        : await source;

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const buffered = resp.clone();
      try {
        const { instance } = await WebAssembly.instantiateStreaming(resp, {});
        return new HitTestBackend(instance);
      } catch {
        const { instance } = await WebAssembly.instantiate(await buffered.arrayBuffer(), {});
        return new HitTestBackend(instance);
      }
    }

    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    return new HitTestBackend(instance);
  } catch {
    return null;
  }
}
