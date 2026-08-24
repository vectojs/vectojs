/**
 * The batched property-driver tick: which entities have drivers in flight, and
 * advancing them for one frame.
 *
 * Extraction 6 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2), shipped at **heavily
 * reduced scope** — see `DEC-0025` for the per-member measurement. The decided
 * `RenderScheduler` scope named nine members and 989 lines; `loop` and `render`
 * are not movable at all, so what ships is the two separable sub-clusters this
 * file and {@link DirtyTracker} own.
 *
 * ## What this owns
 *
 * The candidate registry (`_activeDriverEntities`), the six reused scratch
 * arrays, and the batch pass itself. The registry is the reason the pass is
 * O(active drivers) rather than O(tree size), so registration and ticking are one
 * domain: every write to the set exists to serve the walk that reads it.
 *
 * ## What is held, and what is passed in
 *
 * {@link WasmBackendFacade} is held: it is assigned once in `Scene`'s constructor
 * and the anim backend is reached only through its public surface (`anim`,
 * `animReason`, `animBatchedLastFrame`), exactly as `HitTester` reaches the hit
 * backend.
 *
 * `dt`, the per-kind `gate` and `currentFrame` are per-call arguments
 * (`DEC-0019` rule 5):
 *
 * - `currentFrame` is written by `render` and belongs to the frame loop, which
 *   did not move.
 * - `gate` is `Scene.animGate`, a **public mutable field** that tests and
 *   benchmarks assign directly (`scene.animGate = { … }` at 8 sites, plus the
 *   `animDriverGateCount` alias setter). Holding it would both go stale and force
 *   the public field to become an accessor pair, which this sequence exists to
 *   avoid.
 *
 * ## What deliberately did not move
 *
 * `_tickBatchedDrivers`'s caller. `render` (575 lines) calls twelve `Scene`
 * methods spanning six domains, and `loop` calls `render`, `syncA11y` and
 * `enforceA11yDomOrder`. Both would need a `Scene` back-edge, which `DEC-0019`
 * rule 1 forbids and which `DEC-0020` and `DEC-0021` already refused in the
 * bound-callback form.
 */

import { SpringDriver, TweenDriver } from '@vectojs/animation';
import { type AnimatableProp, Entity } from '../Entity';
import type { WasmBackendFacade } from './WasmBackendFacade';

/** Per-kind driver gates, in active batchable drivers. See `Scene.animGate`. */
export interface AnimDriverGate {
  spring: number;
  tween: number;
  mixed: number;
}

export class DriverTicker {
  private readonly backends: WasmBackendFacade;

  // Entities with at least one active driver, added by Entity._spawnDriver.
  // Self-pruning: tick() drops an entry the first time it visits
  // an entity whose drivers have since all completed or been removed. This is
  // what lets the batch pass find its candidates in O(active drivers), not
  // O(tree size) — the exact mistake G3's first integrated benchmark made.
  private readonly activeEntities = new Set<Entity>();
  // Reused across frames instead of allocating a fresh array + N {entity,prop,
  // driver} objects every call — the integrated benchmark
  // (benchmarks/anim-wasm-scene) found that allocation churn was the
  // dominant integrated cost, not the wasm kernel itself. Parallel arrays,
  // truncated to the live count after each use so a stale tail slot never
  // pins a no-longer-active entity/driver in memory.
  private springEntities: Entity[] = [];
  private springProps: AnimatableProp[] = [];
  private springDrivers: SpringDriver[] = [];
  private tweenEntities: Entity[] = [];
  private tweenProps: AnimatableProp[] = [];
  private tweenDrivers: TweenDriver[] = [];

  public constructor(backends: WasmBackendFacade) {
    this.backends = backends;
  }

  /** The candidate set, for the delegating accessor `Scene` keeps for its tests. */
  public get active(): Set<Entity> {
    return this.activeEntities;
  }

  /** Register a single entity whose driver has just started. */
  public register(entity: Entity): void {
    this.activeEntities.add(entity);
  }

  /**
   * Drop `entity` and its whole subtree from the batched-driver candidate set.
   * Called by `Scene.remove`/`Scene.hideOverlay` on detach: without this a
   * removed-but-still-animating entity stays pinned in the Set (a leak) and its
   * drivers keep ticking every frame even though it is off-tree. If it is later
   * re-added, {@link registerSubtree} re-registers any node that still has live
   * drivers, so the motion resumes.
   */
  public unregisterSubtree(entity: Entity): void {
    if (this.activeEntities.size === 0) return;
    const stack: Entity[] = [entity];
    while (stack.length > 0) {
      const node = stack.pop()!;
      this.activeEntities.delete(node);
      for (const child of node.children) stack.push(child);
    }
  }

  /**
   * Re-register every node in `entity`'s subtree that still has live property
   * drivers. Called by `Scene.add`/`Scene.showOverlay` so re-attaching a subtree
   * that was removed mid-animation resumes its batched drivers (they were
   * dropped from the candidate set on removal, but the driver state still lives
   * on each entity).
   */
  public registerSubtree(entity: Entity): void {
    const stack: Entity[] = [entity];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const entries = node._driverEntries();
      if (entries && entries.size > 0) this.activeEntities.add(node);
      for (const child of node.children) stack.push(child);
    }
  }

  /**
   * Advance every registered entity's active drivers for this frame, batching
   * whichever are batchable (`SpringDriver`; `TweenDriver` with a named
   * easing) through one WASM call each when the driver-count gate is open, and
   * ticking the rest (a `TweenDriver` using a custom `EasingFn`) directly in
   * JS regardless of the gate. A "claimed" entity must have ALL its drivers
   * advanced here so it can be safely stamped `_driversTickedFrame` — leaving
   * one unclaimed would silently stall it, since `tickDrivers()` skips the
   * whole entity once stamped.
   *
   * Must run before ANY entity's `update()`/`tickDrivers()` this frame (see
   * the call site in `Scene.render`) — the same ordering constraint G1 Stage 4
   * discovered: a value this pass writes must be final before anything reads
   * it, including the JS-mode interleaved walk and the WASM-mode transform
   * pre-pass.
   */
  public tick(dt: number, gate: AnimDriverGate, currentFrame: number): void {
    if (this.activeEntities.size === 0) {
      // No drivers in flight, so no accelerator declined anything.
      this.backends.animReason = 'not-applicable';
      return;
    }

    // Pass 1 (always, cheap): prune completed entities, count batchable
    // drivers to decide the gate. O(active drivers), never O(tree size).
    // _driverEntries() returns the entity's Map directly (no callback, no
    // per-entity closure allocation).
    let springBatchable = 0;
    let tweenBatchable = 0;
    for (const entity of this.activeEntities) {
      const entries = entity._driverEntries();
      if (!entries || entries.size === 0) {
        this.activeEntities.delete(entity);
        continue;
      }
      for (const driver of entries.values()) {
        if (driver instanceof SpringDriver) springBatchable++;
        else if (driver instanceof TweenDriver && driver.wasmEasingId !== null) tweenBatchable++;
      }
    }
    const batchable = springBatchable + tweenBatchable;

    const backend = this.backends.anim;
    // Kind-aware gate. Spring and tween have measurably different break-even
    // points — spring/mixed win from ~128 drivers while pure tween is a 0.71x
    // LOSS there and only turns positive near 256 — so a single scalar gate had
    // to be set for the worse case, giving up the 128-255 spring win to avoid a
    // tween regression. The counts were already separated here; only the
    // threshold was shared.
    //
    // A mixed frame uses the mixed gate: the batch is one call per kind, so its
    // economics track the combined driver count rather than either kind alone.
    this.backends.animBatchedLastFrame = false;
    if (!backend) {
      this.backends.animReason = 'not-installed';
      return; // stay on the JS tick path
    }
    const effectiveGate =
      springBatchable > 0 && tweenBatchable > 0
        ? gate.mixed
        : tweenBatchable > 0
          ? gate.tween
          : gate.spring;
    if (batchable < effectiveGate) {
      // Working as designed, not a fault: below the measured break-even the JS
      // tick loop is genuinely faster.
      this.backends.animReason = 'below-gate';
      return;
    }
    // Record that the gate actually opened this frame. `animBackend === 'wasm'`
    // only means the backend is INSTALLED, which has misled readers into
    // assuming every frame runs through WASM.
    this.backends.animBatchedLastFrame = true;
    this.backends.animReason = 'active';

    // Pass 2: claim every registered entity. Gather batchable drivers into the
    // reused scratch arrays; tick+finalize non-batchable ones directly in JS;
    // stamp the entity so tickDrivers() skips it later this same frame.
    const sE = this.springEntities;
    const sP = this.springProps;
    const sD = this.springDrivers;
    const tE = this.tweenEntities;
    const tP = this.tweenProps;
    const tD = this.tweenDrivers;
    let springCount = 0;
    let tweenCount = 0;
    for (const entity of this.activeEntities) {
      const entries = entity._driverEntries()!;
      for (const [prop, driver] of entries) {
        if (driver instanceof SpringDriver) {
          sE[springCount] = entity;
          sP[springCount] = prop;
          sD[springCount] = driver;
          springCount++;
        } else if (driver instanceof TweenDriver && driver.wasmEasingId !== null) {
          tE[tweenCount] = entity;
          tP[tweenCount] = prop;
          tD[tweenCount] = driver;
          tweenCount++;
        } else {
          // Custom-easing tween: cannot cross into WASM. Tick it here (same
          // dt, same math as tickDrivers() would use) so the entity as a
          // whole can still be claimed this frame.
          driver.tick(dt);
          entity._applyDriverTick(prop, driver);
        }
      }
      entity._driversTickedFrame = currentFrame;
    }
    // Drop stale tail slots beyond this frame's count so a no-longer-active
    // entity/driver from a busier past frame isn't pinned in memory.
    sE.length = springCount;
    sP.length = springCount;
    sD.length = springCount;
    tE.length = tweenCount;
    tP.length = tweenCount;
    tD.length = tweenCount;

    backend.ensure(springCount, tweenCount);
    backend.revalidateViews();
    // Per-kind rejection tracking: a kernel declining one kind must not report
    // the whole frame as fully-JS when the other kind stepped through the
    // kernel. Only both kinds declining (or the only present kind) yields the
    // plain 'rejected' fault verdict.
    let springsRejected = false;
    let tweensRejected = false;
    if (springCount > 0) {
      const sv = backend.springView();
      for (let i = 0; i < springCount; i++) {
        const phys = sD[i].physics;
        sv.val[i] = phys.value;
        sv.target[i] = phys.target;
        sv.vel[i] = phys.velocity;
        sv.stiff[i] = phys.stiffness;
        sv.damp[i] = phys.damping;
        sv.mass[i] = phys.mass;
      }
      if (backend.stepSprings(dt, springCount)) {
        for (let i = 0; i < springCount; i++) sD[i].syncExternal(sv.val[i], sv.vel[i]);
      } else {
        // The kernel declined and wrote nothing, so the views still hold the
        // pre-step state — syncing them back would freeze every spring. Every
        // entity here was already stamped `_driversTickedFrame` above, so
        // tickDrivers() will skip them for the rest of the frame; tick them in
        // JS now (same dt, same math) or they lose the frame entirely.
        for (let i = 0; i < springCount; i++) sD[i].tick(dt);
        springsRejected = true;
      }
    }
    if (tweenCount > 0) {
      const tv = backend.tweenView();
      for (let i = 0; i < tweenCount; i++) {
        const d = tD[i];
        tv.from[i] = d.fromValue;
        tv.to[i] = d.target;
        tv.elapsed[i] = d.elapsedMs;
        tv.dur[i] = d.durationMs;
        tv.delay[i] = d.delayMs;
        tv.ease[i] = d.wasmEasingId!;
      }
      if (backend.stepTweens(dt, tweenCount)) {
        for (let i = 0; i < tweenCount; i++) tD[i].syncExternal(tv.val[i], tv.elapsed[i]);
      } else {
        for (let i = 0; i < tweenCount; i++) tD[i].tick(dt);
        tweensRejected = true;
      }
    }
    if (springsRejected || tweensRejected) {
      this.backends.animReason =
        springsRejected && tweensRejected
          ? 'rejected'
          : springsRejected
            ? 'springs-rejected'
            : 'tweens-rejected';
      // Only a fully-JS frame means the accelerator did no work at all; a
      // partial rejection still advanced one kind through the kernel.
      this.backends.animBatchedLastFrame = !(springsRejected && tweensRejected);
    }

    // Finalize every batchable driver this pass touched (completion check +
    // apply + settle + delete), exactly mirroring tickDrivers()'s own
    // per-driver body — the non-batchable ones were already finalized above.
    for (let i = 0; i < springCount; i++) sE[i]._applyDriverTick(sP[i], sD[i]);
    for (let i = 0; i < tweenCount; i++) tE[i]._applyDriverTick(tP[i], tD[i]);
  }
}
