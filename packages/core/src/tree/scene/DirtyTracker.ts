/**
 * The dirty flag and its attribution: whether the next frame must redraw, and
 * who asked for it.
 *
 * Extraction 6 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2), shipped at **heavily
 * reduced scope** — see `DEC-0025`. The decided `RenderScheduler` scope named
 * `loop` and `render` as its centre; neither is movable, so what ships is this
 * cluster and {@link DriverTicker}.
 *
 * ## What this owns
 *
 * The flag itself, the opt-in attribution map, and its FIFO bound. The two are
 * one domain rather than two: `markDirty` is the only writer of the flag and the
 * only trigger of an attribution, so splitting them would put a branch on the hot
 * path in one class and its data in another.
 *
 * ## The hot path
 *
 * {@link mark} is called from dozens of sites, several per frame. It stays a
 * single field write plus one already-false branch when tracking is off, which is
 * why {@link record} is a separate method: V8 inlines the one-field version
 * reliably, and that split was deliberate before this extraction.
 *
 * ## What is passed in
 *
 * `currentFrame` is a per-call argument (`DEC-0019` rule 5). It is written by
 * `Scene.render`, which did not move, so capturing it would go stale every frame.
 *
 * ## What deliberately did not move
 *
 * `Scene.markDirty` keeps its exact name and signature and delegates here. It is
 * a cross-class contract — `Entity.ts` calls `scene.markDirty()`, and there are
 * 129 call sites across the workspace packages — so it stays reachable on `Scene`
 * (`DEC-0019` rule 2).
 *
 * `renderMode`, `maxFPS` and `autoThrottle` stay on `Scene` as public fields:
 * they are consumed by `loop`, which did not move, and `renderMode` has three
 * external readers in `@vectojs/devtools`. The frame telemetry counters stay with
 * `loop` for the same reason — it is their only writer.
 */

/**
 * Who marked the scene dirty, and why.
 *
 * Every field is optional except `reason` so a call site can be as specific as it
 * cheaply can — an entity id costs nothing to pass, a property name is often
 * already in scope.
 */
export interface DirtySource {
  /** Entity id responsible, when one is. Omitted for scene-level invalidation. */
  entity?: string;
  /** Short, stable category — e.g. `'text-changed'`, `'animation'`, `'resize'`. */
  reason: string;
  /** Property that changed, when the reason alone is ambiguous. */
  property?: string;
}

/** An aggregated dirty attribution. */
export interface DirtyReasonEntry {
  entity?: string;
  reason: string;
  property?: string;
  /** How many times this exact attribution was recorded. */
  count: number;
  firstFrame: number;
  lastFrame: number;
}

export class DirtyTracker {
  /** Cap on distinct recorded dirty reasons (see {@link record}). */
  private static readonly MAX_DIRTY_REASONS = 200;

  private tracking = false;
  private readonly reasons = new Map<string, DirtyReasonEntry>();
  private isDirty: boolean = true;

  /** Whether the next frame must redraw. */
  public get dirty(): boolean {
    return this.isDirty;
  }

  /**
   * Mark the scene as needing a redraw on the next frame.
   *
   * Attribution is opt-in and costs nothing when off: this is called from dozens
   * of sites, several of them per-frame, so the common path must stay a single
   * field write.
   */
  public mark(source: DirtySource | undefined, currentFrame: number): void {
    this.isDirty = true;
    if (this.tracking && source) this.record(source, currentFrame);
  }

  /**
   * Consume the flag.
   *
   * `Scene.loop` clears it BEFORE the update/render pass: any `markDirty()` call
   * made inside an entity's `update()` must survive into the next frame
   * (self-animating entities re-arm themselves this way). Clearing after render
   * would silently wipe those marks and freeze the entity.
   */
  public clear(): void {
    this.isDirty = false;
  }

  /**
   * Record who marked the scene dirty and why.
   *
   * Kept separate from {@link mark} so the hot path is not a function call with a
   * branch — V8 inlines the one-field version reliably.
   */
  private record(source: DirtySource, currentFrame: number): void {
    const key = `${source.entity ?? 'scene'}:${source.reason}${
      source.property ? `.${source.property}` : ''
    }`;
    const existing = this.reasons.get(key);
    if (existing) {
      existing.count++;
      existing.lastFrame = currentFrame;
      return;
    }
    // Bounded: a scene that mints a unique reason per frame (an id in the key,
    // say) must not grow this map forever. FIFO eviction — the same rationale as
    // the color cache, and for the same reason true LRU is not worth the
    // bookkeeping here.
    if (this.reasons.size >= DirtyTracker.MAX_DIRTY_REASONS) {
      const oldest = this.reasons.keys().next().value;
      if (oldest !== undefined) this.reasons.delete(oldest);
    }
    this.reasons.set(key, {
      entity: source.entity,
      reason: source.reason,
      property: source.property,
      count: 1,
      firstFrame: currentFrame,
      lastFrame: currentFrame,
    });
  }

  /** Start or stop recording dirty attributions. */
  public setTracking(enabled: boolean): void {
    this.tracking = enabled;
    if (!enabled) this.reasons.clear();
  }

  /** Whether dirty attribution is currently being recorded. */
  public get trackingEnabled(): boolean {
    return this.tracking;
  }

  /** Recorded dirty attributions, most frequent first. */
  public get sortedReasons(): DirtyReasonEntry[] {
    return [...this.reasons.values()].sort((a, b) => b.count - a.count);
  }

  /** Drop recorded attributions, keeping tracking enabled. */
  public clearReasons(): void {
    this.reasons.clear();
  }
}
