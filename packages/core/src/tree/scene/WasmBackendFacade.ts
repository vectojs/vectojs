/**
 * The four invisible WASM accelerators, and the per-frame report that describes
 * what each of them actually did.
 *
 * Extraction 1 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2). `Scene` keeps every
 * public method and getter it had — `setTransformBackend`, `enableWasmHitTest`,
 * `accelerators`, and the rest — and each one now delegates here. The public API
 * is byte-identical; only where the state lives changed.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns the four backend handles, the shared runtime, the resident transform
 * store, and every field the accelerator report reads.
 *
 * It does NOT own three things that sit inside `Scene.ts`'s WASM comment region
 * but belong to other domains — the domain banners were added first precisely to
 * make that visible before any code moved (carryctx `DEC-0016`):
 *
 * - `_ensureHitGrid` / `_findEntityAtWasm` are the hit-test broad phase
 *   (`HitTester`, extraction 4). They *read* this facade.
 * - `_tickBatchedDrivers` is the scheduler's batched driver tick
 *   (`RenderScheduler`, extraction 6). It reads the anim backend from here.
 * - `_computeEntitiesFor` walks the tree for `ComputeParticleEntity` instances
 *   and is consumed by the render walk. Only its cache key — the structure
 *   version — is store state, so the version lives here and the walk stays on
 *   `Scene`.
 *
 * ## Why the reporting fields live here rather than with their writers
 *
 * `transformReason` is written by the render walk, `animReason` by the driver
 * tick, `hitReason` by the hit-grid build, `particleReason` by the particle
 * pass — four domains, four different extractions. They are collected here
 * anyway because {@link report} is the single reader that has to make them
 * consistent, and splitting them across four collaborators would leave that one
 * getter reaching into all four. Each writer sets its own field through a public
 * property on this object; none of them touches `Scene`'s privates.
 *
 * ## The one fact this cannot know
 *
 * `particle.available` is true when a WASM particle backend is installed **or**
 * WebGPU is live, and WebGPU device state belongs to `ContextAndResize`
 * (extraction 5). So {@link report} takes it as an argument rather than
 * reaching for it. That is the whole of this facade's dependency on the rest of
 * `Scene`.
 */

import type { Entity } from '../Entity';
import { buildTreeStore } from '../../wasm/scene-store';
import type { TransformStore } from '../../wasm/soa';
import { WASM_STATUS, type WasmTransformBackend } from '../../wasm/backend';
import {
  type CoreModuleSource,
  type CoreWasmRuntime,
  loadCoreWasmRuntime,
} from '../../wasm/runtime';
import type { HitTestBackend } from '../../wasm/hit-backend';
import type { AnimBackend } from '../../wasm/anim-backend';
import type { ParticleBackend } from '../../wasm/particle-backend';

/**
 * Why an accelerator did or did not run on the most recent frame.
 *
 * `'active'` is the only value that means the accelerator ran. Everything else
 * is a distinct decline, kept separate because they call for different actions:
 * `'not-installed'` means enable it, `'below-gate'` means the workload is too
 * small to be worth it (working as designed), and `'rejected'` means the kernel
 * refused its arguments — a fault worth reporting, not a tuning outcome.
 *
 * Declared here rather than in `Scene.ts` because this is the class that owns
 * every field of this type. `Scene.ts` re-exports all three accelerator types,
 * so `@vectojs/core`'s barrel keeps publishing them unchanged — `AcceleratorReason`
 * in particular is consumed by `@vectojs/devtools`.
 */
export type AcceleratorReason =
  /** Ran on this frame. */
  | 'active'
  /** No backend installed; the JS path is the permanent fallback. */
  | 'not-installed'
  /** Installed, but the per-frame gate chose JS (workload below threshold). */
  | 'below-gate'
  /** Installed and gated in, but the kernel rejected the call and wrote nothing. */
  | 'rejected'
  /** Not applicable to this pass (e.g. a non-main renderer, or nothing to do). */
  | 'not-applicable';

/**
 * One accelerator's per-frame status, read from {@link Scene.accelerators}.
 *
 * The pair exists because `available` and `activeThisFrame` genuinely differ:
 * before this shape, `transformBackend`/`animBackend` reported only that a
 * backend was *installed*, which invites concluding an accelerator is doing work
 * when its gate never opens. Read `activeThisFrame` for what actually happened
 * and `reason` for why.
 */
export interface AcceleratorStatus {
  /** A backend is installed and could run, gate permitting. */
  available: boolean;
  /** It ran on the most recent frame. */
  activeThisFrame: boolean;
  /** Why it did or did not run. */
  reason: AcceleratorReason;
  /** Which implementation actually did the work on the most recent frame. */
  path: string;
}

/**
 * Per-frame status of every invisible accelerator, read from
 * {@link Scene.accelerators}. Each is independent: a scene can compose
 * transforms in WASM while ticking drivers in JS.
 */
export interface AcceleratorReport {
  /** World-matrix composition (`compose_simd`). */
  transform: AcceleratorStatus;
  /** Batched property drivers (`spring_step`/`tween_step`). */
  animation: AcceleratorStatus;
  /** Hit-test broad phase (`hit_build`/`hit_query`) and its gather source. */
  hitTest: AcceleratorStatus;
  /** Particle simulation — WebGPU compute, the WASM CPU kernel, or JS. */
  particle: AcceleratorStatus;
}

/**
 * How many CONSECUTIVE `uploadRuns` rejections disable the WASM transform
 * backend for a scene's lifetime.
 *
 * A rejection leaves the store's structure version stale so the next frame
 * retries the rebuild, which is right while the cause might be transient — a
 * concurrent backend growing shared linear memory between `ensure()` and
 * `set_run_count()`. But a topology genuinely over the crate's hard run cap
 * re-fails every frame, and each retry costs a full O(n) `buildTreeStore` plus a
 * run-table upload.
 *
 * 3 rather than 1 because the retry is a deliberate, documented design, and
 * rather than a larger number because the wasted work scales with tree size and
 * a hard cap will never be cleared by retrying. Counted consecutively and reset
 * on any success, so an intermittent rejection cannot accumulate into disabling
 * a scene that is working. (carryctx CTX-0278, DEC-0014)
 */
const WASM_UPLOAD_REJECT_LIMIT = 3;

export class WasmBackendFacade {
  /**
   * The main tree's root.
   *
   * Held by value rather than as a `Scene` reference: it is assigned exactly
   * once in `Scene`'s constructor and never reassigned, and taking it directly
   * is what keeps this class from holding a back-edge to its facade. Only the
   * main tree is ever composed through the store — overlays render on the JS
   * path, so the overlay root is not needed here.
   */
  private readonly root: Entity;

  constructor(root: Entity) {
    this.root = root;
  }

  // ── WASM transform backend (invisible accelerator) ──────────────────────────
  // When `mode === 'wasm'`, the main render walk sources each entity's world
  // matrix from an SoA store composed by `transform` (see `renderNode`), instead
  // of composing it in JS. The JS path is the permanent fallback and the
  // default: a null backend, a non-main renderer, or any entity absent from the
  // store all fall back to the JS composition, so WASM can only ever change
  // *how fast* a world matrix is produced, never *what* it is.
  private _transform: WasmTransformBackend | null = null;
  private _mode: 'js' | 'wasm' = 'js';

  // Resident store state (Stage 3). The store layout — slot assignment + sibling
  // runs — depends only on tree TOPOLOGY, so it is rebuilt only when the
  // structure changes (add/remove/reparent bump `structureVersion`). Between
  // rebuilds the per-frame cost is: gather each entity's transform into the
  // resident wasm input view + run the kernel — no reallocation, no readback.
  private _treeStore: TransformStore | null = null;
  private _slotEntity: Entity[] = []; // store slot -> entity (also validates slots)
  private _inputs: ReturnType<WasmTransformBackend['inputView']> | null = null;
  private _world: ReturnType<WasmTransformBackend['worldView']> | null = null;
  private _structureVersion = 0;
  private _storeStructureVersion = -1;
  /**
   * Consecutive `uploadRuns` rejections. Reset by any success and by
   * {@link setTransform}; at {@link WASM_UPLOAD_REJECT_LIMIT} the backend mode
   * flips to `'js'` permanently.
   */
  private _uploadRejections = 0;
  /** Latch for the permanent-fallback warning, which fires from a per-frame path. */
  private hasWarnedUploadFallback = false;
  /**
   * Whether `compute_aabbs` has run against the current frame's world matrices.
   * The AABB pass is only meaningful after a `compose_*`, so the fused gather
   * must not read the views before then.
   */
  private _aabbsFresh = false;

  /** The installed transform backend, or `null` on the JS path. */
  public get transform(): WasmTransformBackend | null {
    return this._transform;
  }

  /** Which backend composes world matrices for the main render walk. */
  public get mode(): 'js' | 'wasm' {
    return this._mode;
  }

  /**
   * Whether the render walk should source world matrices from the store this
   * frame: a backend is installed AND the mode has not fallen back to JS.
   */
  public get transformActive(): boolean {
    return this._transform !== null && this._mode === 'wasm';
  }

  /** Store slot -> entity, for the render walk and the fused hit gather. */
  public get slotEntity(): Entity[] {
    return this._slotEntity;
  }

  /** Bumped by every topology change; the store layout's cache key. */
  public get structureVersion(): number {
    return this._structureVersion;
  }

  /** Which structure version the resident store layout was built for. */
  public get storeStructureVersion(): number {
    return this._storeStructureVersion;
  }

  /** Consecutive `uploadRuns` rejections; see {@link WASM_UPLOAD_REJECT_LIMIT}. */
  public get uploadRejections(): number {
    return this._uploadRejections;
  }

  /** Invalidate the resident WASM store layout; the next wasm-mode frame
   *  rebuilds it. Called by `Entity.add`/`remove` (topology changes only). */
  public markStructureChanged(): void {
    this._structureVersion++;
  }

  /**
   * Install (or clear) a WASM transform backend. Passing a backend switches the
   * main render walk onto it; passing `null` reverts to the JS path.
   */
  public setTransform(backend: WasmTransformBackend | null): void {
    // A backend identity change (e.g. `setWasmRuntime(sharedRuntime)` re-running
    // `enableWasmTransforms`) installs a NEW backend that shares linear memory
    // with the old one but has never received `uploadRuns`: its input/world
    // views are zero-length. An unchanged tree structure would skip the
    // rebuild in `syncStore`, so the resident store state must be invalidated
    // on identity change, not only on topology change.
    const backendChanged = backend !== this._transform && this._transform !== null;
    this._transform = backend;
    this._mode = backend ? 'wasm' : 'js';
    // An explicit install is the documented way back after a permanent
    // run-table fallback, so the rejection streak must not survive it —
    // otherwise the very next rejection would trip the limit again. The warning
    // latch is deliberately NOT reset: one report per scene is the point.
    this._uploadRejections = 0;
    if (backendChanged) {
      this._treeStore = null;
      this._storeStructureVersion = -1;
      this._inputs = null;
      this._world = null;
      this._aabbsFresh = false;
    }
  }

  // ── The shared runtime ──────────────────────────────────────────────────────
  /**
   * The one WASM instance this Scene's accelerators share.
   *
   * Each `enableWasm*` used to instantiate the binary itself, so enabling all
   * four compiled the same module four times and held four linear memories. The
   * Rust crate already keeps transform/anim/hit/particle in separate statics, so
   * one instance serves all of them without aliasing. The compiled module is
   * cached globally; the instance is per-Scene, which is the isolation that
   * actually matters.
   */
  private _runtime: CoreWasmRuntime | null = null;

  /** The shared WASM runtime, if one has been loaded. */
  public get runtime(): CoreWasmRuntime | null {
    return this._runtime;
  }

  /**
   * Install a pre-built runtime, so several Scenes can share one compile while
   * each keeps its own stores. Pass `null` to detach (backends already installed
   * keep working; only subsequent `enableWasm*` calls re-load).
   */
  public setRuntime(runtime: CoreWasmRuntime | null): void {
    this._runtime = runtime;
  }

  /**
   * Load (or reuse) this Scene's shared WASM runtime.
   *
   * Returns `null` on any failure — CSP `wasm-unsafe-eval`, a 404, corrupt bytes,
   * unsupported SIMD — so every caller keeps its JS path. Failure is the default
   * state here, not an error path.
   */
  public async ensureRuntime(source: CoreModuleSource): Promise<CoreWasmRuntime | null> {
    if (this._runtime) return this._runtime;
    const runtime = await loadCoreWasmRuntime(source);
    if (!runtime) return null;
    // A concurrent `enableWasm*` may have won the race while we awaited; keep
    // whichever landed first so the backends cannot end up on two instances.
    if (this._runtime) return this._runtime;
    this._runtime = runtime;
    return runtime;
  }

  // ── The other three backend handles ─────────────────────────────────────────
  private _hit: HitTestBackend | null = null;
  private _anim: AnimBackend | null = null;
  private _particle: ParticleBackend | null = null;

  /** The installed hit-test backend, or `null` for the JS depth-first walk. */
  public get hit(): HitTestBackend | null {
    return this._hit;
  }

  /** Install (or clear) a WASM hit-test backend. */
  public setHit(backend: HitTestBackend | null): void {
    this._hit = backend;
    this.hitGridFrame = -1; // force a rebuild under the (possibly new) backend
    // Installed but not yet queried is 'not-applicable', not 'not-installed' —
    // the grid is built lazily, so an untouched backend has declined nothing.
    this.hitReason = backend ? 'not-applicable' : 'not-installed';
  }

  /** The installed batched-animation backend, or `null` for the JS tick. */
  public get anim(): AnimBackend | null {
    return this._anim;
  }

  /** Install (or clear) a WASM batched-animation backend. */
  public setAnim(backend: AnimBackend | null): void {
    this._anim = backend;
  }

  /** The installed particle backend, or `null` for the JS `updateCPU` path. */
  public get particle(): ParticleBackend | null {
    return this._particle;
  }

  /** Install (or clear) a WASM particle backend. */
  public setParticle(backend: ParticleBackend | null): void {
    this._particle = backend;
  }

  // ── Accelerator reporting state ─────────────────────────────────────────────
  // Written by four different domains (see the class comment) and read only by
  // `report`, which is why they are collected here rather than with their
  // writers.

  /**
   * Why the transform accelerator did or did not run on the most recent frame.
   * Written by the render walk and {@link syncStore}.
   */
  public transformReason: AcceleratorReason = 'not-installed';
  /** Why the batched-driver accelerator did or did not run. */
  public animReason: AcceleratorReason = 'not-installed';
  /**
   * Why the hit-test accelerator did or did not serve the last pointer query.
   * The grid is built lazily on demand, not every frame, so this describes the
   * most recent BUILD. Starts at `'not-installed'` because that is the truth
   * before a backend exists; the grid build moves it to `'not-applicable'` once
   * one is installed but nothing has queried yet.
   */
  public hitReason: AcceleratorReason = 'not-installed';
  /** Why the particle accelerator did or did not run. */
  public particleReason: AcceleratorReason = 'not-applicable';
  /** Which particle implementation actually simulated the most recent frame. */
  public particlePath = 'none';
  /**
   * Whether the last grid build sourced its AABBs from the WASM transform store
   * rather than recomputing them in JS. Diagnostic only — both paths must
   * produce the same entity for a given point.
   */
  public hitFusedGather = false;
  /** Whether the WASM batch path actually ran on the most recent frame. */
  public animBatchedLastFrame = false;

  // Hit-grid cache key: which frame + structure version the grid was last
  // (successfully, non-overflowing) built for. Owned here rather than by
  // `HitTester` because {@link setHit} has to invalidate it, and a backend swap
  // is this facade's job. The grid contents themselves stay with the hit-test
  // domain.
  /** Frame the hit grid was last built for; `-1` forces a rebuild. */
  public hitGridFrame = -1;
  /** Whether that build succeeded (did not overflow its item budget). */
  public hitGridOk = false;

  /**
   * Per-frame status of every invisible accelerator: whether each is installed,
   * whether it actually ran on the most recent frame, and why.
   *
   * `webgpuActive` is passed in because WebGPU device state belongs to
   * `ContextAndResize`, not here — see the class comment.
   */
  public report(webgpuActive: boolean): AcceleratorReport {
    return {
      transform: {
        available: this._transform !== null && this._mode === 'wasm',
        activeThisFrame: this.transformReason === 'active',
        reason: this.transformReason,
        path: this.transformReason === 'active' ? 'wasm' : 'js',
      },
      animation: {
        available: this._anim !== null,
        activeThisFrame: this.animBatchedLastFrame,
        reason: this.animReason,
        path: this.animBatchedLastFrame ? 'wasm' : 'js',
      },
      hitTest: {
        available: this._hit !== null,
        // The grid is built lazily on a pointer query, not every frame, so this
        // describes the last BUILD rather than the last frame.
        activeThisFrame: this.hitReason === 'active',
        reason: this.hitReason,
        path: this.hitReason !== 'active' ? 'js' : this.hitFusedGather ? 'wasm-fused' : 'wasm',
      },
      particle: {
        available: this._particle !== null || webgpuActive,
        activeThisFrame: this.particleReason === 'active',
        reason: this.particleReason,
        path: this.particlePath,
      },
    };
  }

  // ── The two per-frame store passes ──────────────────────────────────────────

  /**
   * Compose the whole main tree's world matrices through the resident WASM store
   * and return the world-matrix views for the render walk to read. Rebuilds the
   * store layout (slots + runs) only when the tree structure changed since the
   * last rebuild; otherwise it just gathers current transforms into the resident
   * input view and runs the kernel. Returns `null` if there is no backend.
   */
  public syncStore(): ReturnType<WasmTransformBackend['worldView']> | null {
    const backend = this._transform;
    if (!backend) return null;

    if (this._treeStore === null || this._storeStructureVersion !== this._structureVersion) {
      const built = buildTreeStore(this.root);
      const slotEntity = Array.from<Entity>({ length: built.store.count });
      for (const [entity, slot] of built.indexOf) {
        slotEntity[slot] = entity;
        entity._storeSlot = slot;
      }
      // sizes wasm memory + publishes the run table
      if (!backend.uploadRuns(built.store)) {
        // The crate rejected the run count, so the run table still describes the
        // PREVIOUS topology. Composing against it would lay this frame's entities
        // out along last frame's parent links. Leave `_storeStructureVersion`
        // untouched so the next frame retries the rebuild.
        this.transformReason = 'rejected';
        // The store did not move to this frame's world matrices either, so any
        // AABBs previously computed from them are stale — a fused gather must
        // not read them. The flag is also cleared on the runKernel rejection
        // below; both rejection returns exit with a store that does not
        // describe the frame being rendered.
        this._aabbsFresh = false;
        // Retrying forever is only right while the rejection might be transient
        // (a concurrent backend growing shared linear memory between `ensure()`
        // and `set_run_count()`). A topology that genuinely exceeds the crate's
        // HARD run cap re-fails every frame, and each retry is a full O(n)
        // `buildTreeStore` plus a run-table upload — so after
        // `WASM_UPLOAD_REJECT_LIMIT` consecutive rejections, give up on the
        // accelerator for this scene's lifetime instead of burning that work per
        // frame. Consecutive, not cumulative: an intermittent rejection across a
        // long session must never accumulate into disabling a scene that works.
        // (carryctx CTX-0278, DEC-0014)
        this._uploadRejections++;
        if (this._uploadRejections >= WASM_UPLOAD_REJECT_LIMIT) {
          // Flip the field the render walk already reads (`renderNode`'s
          // `wasmMain`), rather than adding a parallel disable flag that would be
          // a second source of truth for the same question. The backend is left
          // installed so `accelerators.transform` can still describe what
          // happened; `available` reports false because this reads the backend
          // mode, which is now 'js'.
          this._mode = 'js';
          if (!this.hasWarnedUploadFallback) {
            console.warn(
              `[VectoJS] WASM transform backend disabled after ${this._uploadRejections} consecutive ` +
                `run-table rejections (${built.store.runCount} runs for ${built.store.count} entities); ` +
                'the crate refused this topology. Falling back to JS transforms for this scene. ' +
                'Call scene.setTransformBackend(backend) to re-enable after reducing the tree.',
            );
            this.hasWarnedUploadFallback = true;
          }
        }
        return null;
      }
      // Any success clears the streak, so only a genuinely persistent rejection
      // reaches the limit.
      this._uploadRejections = 0;
      this._treeStore = built.store;
      this._slotEntity = slotEntity;
      this._inputs = backend.inputView(); // valid until the next capacity growth
      this._world = backend.worldView();
      this._storeStructureVersion = this._structureVersion;
    }

    // Another backend sharing this instance (hit_init allocates its own grid
    // arrays in the same linear memory) may have grown memory and detached these
    // views since the last frame. Re-acquire them before writing, or every write
    // silently lands nowhere.
    backend.revalidateViews();
    if (this._inputs && this._inputs.x.length === 0) {
      this._inputs = backend.inputView();
      this._world = backend.worldView();
    }

    // Gather local transforms into the resident input view. Slot 0 is the root,
    // which the kernel seeds to identity, so start at 1. cos/sin come from the
    // Phase-0 per-entity trig cache (recomputed only when rotation changed).
    const inp = this._inputs!;
    const slotEntity = this._slotEntity;
    for (let slot = 1; slot < slotEntity.length; slot++) {
      const e = slotEntity[slot];
      inp.x[slot] = e.x;
      inp.y[slot] = e.y;
      inp.sx[slot] = e.scaleX;
      inp.sy[slot] = e.scaleY;
      const trig = e._getTrig();
      inp.cos[slot] = trig.cos;
      inp.sin[slot] = trig.sin;
      inp.opacity[slot] = e.opacity;
    }
    if (backend.runKernel('simd') !== WASM_STATUS.OK) {
      // A rejected kernel wrote nothing, so the world views still hold the
      // PREVIOUS frame's matrices. Returning them would render last frame's
      // geometry as if it were current — the batch `compose()` path already
      // guards this; the resident path did not. Returning null routes the render
      // walk through JS composition, which is the permanent fallback.
      this.transformReason = 'rejected';
      // A rejection frame renders through JS composition, whose matrices the
      // store does not hold, so AABBs computed for the store's previous frame
      // must not satisfy a fused gather this frame. Without this clear, an
      // `ensureAabbs()` between a successful frame and its rejected successor
      // would return early and the gather would hit-test against last frame's
      // geometry.
      this._aabbsFresh = false;
      return null;
    }
    // The world matrices just changed, so any AABBs computed from the previous
    // frame's matrices are stale. They are recomputed on demand rather than every
    // frame: a pointer query happens ad-hoc, and most frames never need them.
    this._aabbsFresh = false;
    this.transformReason = 'active';
    return this._world;
  }

  /**
   * Run the WASM world-AABB pass over the current frame's world matrices, so the
   * fused hit gather can read AABBs straight out of the store.
   *
   * Local bounds are uploaded here rather than in the per-frame transform sync
   * because `getBounds()` is a virtual call that allocates a rect on most
   * entities — paying it every frame for a query that may never come would move
   * cost onto the render path to save it on hover. Returns `false` if any entity
   * cannot supply bounds through the store, so the caller uses the JS gather.
   */
  public ensureAabbs(): boolean {
    const backend = this._transform;
    const store = this._treeStore;
    if (!backend || !store) return false;
    if (this._aabbsFresh) return true;

    backend.revalidateViews();
    const bounds = backend.boundsView();
    const slotEntity = this._slotEntity;
    for (let slot = 0; slot < slotEntity.length; slot++) {
      const e = slotEntity[slot];
      if (!e) continue;
      const b = e.getBounds();
      // A boundless entity keeps zeroed bounds; the fused gather routes it
      // through `boundless` and never reads its AABB slots.
      bounds.bx[slot] = b ? b.x : 0;
      bounds.by[slot] = b ? b.y : 0;
      bounds.bw[slot] = b ? b.width : 0;
      bounds.bh[slot] = b ? b.height : 0;
    }
    // A rejected pass leaves the store's AABB slots holding the previous
    // frame's bounds. Marking them fresh anyway would hand the fused gather
    // stale geometry and silently mis-hit every pointer event this frame, so
    // report failure and let the caller fall back to the JS gather.
    if (!backend.runAabbs(slotEntity.length)) return false;
    this._aabbsFresh = true;
    return true;
  }
}
