import { WORKER_SOURCE_STRING } from './LayoutWorkerSource';
import { LayoutWorkerRequest, LayoutWorkerResponse } from './LayoutWorker';
import { computeMSDFLayout } from './msdfLayout';
import type { MSDFFontData } from '@vectojs/text';

/**
 * Consecutive worker failures tolerated before the manager stops trying to
 * create one and serves every request from the main thread instead.
 *
 * A worker failure is not always transient. Measured 2026-07-31 on Chromium and
 * Firefox: under `default-src 'self'`, `worker-src 'none'`, or a `script-src`
 * without `blob:`, `new Worker(blob:…)` does **not** throw — it constructs and
 * then fires `onerror`. So a CSP looks exactly like a crash, except it will
 * never stop happening: six `queueLayout` calls spawned six Workers and
 * delivered zero layouts on both engines. Recreating per request in that
 * environment is pure waste, so give the worker a couple of chances (a genuinely
 * transient OOM/crash deserves one) and then stay on the main thread.
 */
const MAX_CONSECUTIVE_WORKER_FAILURES = 2;

/** A queued request plus its callback, kept so layout can be completed on the
 *  main thread if the worker never answers. */
interface PendingLayout {
  request: LayoutWorkerRequest;
  callback: (response: LayoutWorkerResponse) => void;
}

export class LayoutWorkerManager {
  private static instance: LayoutWorkerManager | undefined;
  private worker: Worker | null = null;
  private registeredFonts = new Set<string>();
  private pendingCallbacks = new Map<string, PendingLayout>();
  private seqIdCounter = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Font metrics by id, retained for the lifetime of the manager.
   *
   * Distinct from {@link registeredFonts}, which tracks what the *current*
   * worker has been sent and is cleared when that worker dies. This map is what
   * lets a main-thread fallback lay out text whose `fontData` the caller only
   * passed once — `MSDFTextEntity` passes it on every `queueLayout`, but the
   * option is documented as optional and a caller that omits it after the first
   * call would otherwise get no layout at all.
   */
  private fontDataById = new Map<string, MSDFFontData>();
  private consecutiveWorkerFailures = 0;
  /** Set once the worker is judged permanently unavailable (see
   *  {@link MAX_CONSECUTIVE_WORKER_FAILURES}). */
  private workerUnavailable = false;

  private constructor() {
    this.worker = this.createWorker();
  }

  /**
   * Create the layout worker, or return `null` when one cannot be had: an
   * environment without the Worker/Blob/URL APIs (SSR, non-DOM), a `new Worker`
   * that throws, or a worker already judged unavailable. Mirrors the Markdown
   * worker's `typeof Worker` guard so constructing an `MSDFTextEntity`
   * server-side does not throw. `null` is not a dead end — `queueLayout` lays
   * out on the calling thread instead, so the worker is strictly an
   * optimization.
   */
  private createWorker(): Worker | null {
    if (
      this.workerUnavailable ||
      typeof Worker === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return null;
    }
    const workerBlob = new Blob([WORKER_SOURCE_STRING], {
      type: 'application/javascript',
    });
    const workerURL = URL.createObjectURL(workerBlob);
    let worker: Worker;
    try {
      worker = new Worker(workerURL);
    } catch {
      // `new Worker` can throw outright (a blocked blob: URL, an exhausted
      // worker pool). Returning null routes layout to the main thread; letting
      // this escape would propagate out of `queueLayout` into
      // `new MSDFTextEntity(...)` and take down the caller's whole scene
      // construction over an optimization that is allowed to be unavailable.
      this.workerUnavailable = true;
      return null;
    } finally {
      URL.revokeObjectURL(workerURL);
    }

    worker.onmessage = (e: MessageEvent) => {
      if (this.worker !== worker) return;
      const response = e.data as LayoutWorkerResponse;
      const key = `${response.id}-${response.seqId}`;
      const pending = this.pendingCallbacks.get(key);
      // A reply proves the worker is healthy, so a later isolated failure is
      // still treated as transient rather than counting toward the cap.
      this.consecutiveWorkerFailures = 0;
      if (pending) {
        this.pendingCallbacks.delete(key);
        pending.callback(response);
      }
    };

    worker.onerror = () => this.handleWorkerFailure(worker);
    worker.onmessageerror = () => this.handleWorkerFailure(worker);
    return worker;
  }

  private ensureWorker(): Worker | null {
    if (!this.worker) this.worker = this.createWorker();
    return this.worker;
  }

  private handleWorkerFailure(worker: Worker): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.registeredFonts.clear();
    this.consecutiveWorkerFailures++;
    if (this.consecutiveWorkerFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
      this.workerUnavailable = true;
    }
    // Finish the abandoned work here rather than dropping it. These callbacks
    // are the only path by which an `MSDFTextEntity` ever receives geometry:
    // `render()` returns early while `layoutResult` is null, and nothing
    // re-queues on its own, so discarding them meant one transient worker error
    // left the text permanently invisible while its layout, hit-testing, and
    // a11y projection all still reported success.
    this.resolvePendingOnMainThread();
  }

  /**
   * Complete every queued request synchronously using {@link computeMSDFLayout},
   * the same function the worker runs. Requests whose font metrics were never
   * supplied are dropped (there is nothing to lay out against) rather than
   * retained.
   */
  private resolvePendingOnMainThread(): void {
    if (this.pendingCallbacks.size === 0) return;
    const pending = [...this.pendingCallbacks.values()];
    this.pendingCallbacks.clear();
    for (const { request, callback } of pending) {
      const font = request.fontData ?? this.fontDataById.get(request.fontId);
      if (!font) continue;
      callback(computeMSDFLayout(request, font));
    }
  }

  public destroy(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    // Deliberately dropped, not resolved on the main thread: destroy() is
    // teardown, so the callers are going away and their callbacks would fire
    // into disposed entities.
    this.pendingCallbacks.clear();
    this.seqIdCounter.clear();
    this.registeredFonts.clear();
    this.fontDataById.clear();
    this.worker?.terminate();
    this.worker = null;
    if (LayoutWorkerManager.instance === this) LayoutWorkerManager.instance = undefined;
  }

  public static getInstance(): LayoutWorkerManager {
    if (!LayoutWorkerManager.instance) {
      LayoutWorkerManager.instance = new LayoutWorkerManager();
    }
    return LayoutWorkerManager.instance;
  }

  /**
   * Release any queued/in-flight layout work for a single entity **without
   * resurrecting the singleton**. Called from `MSDFTextEntity.destroy()`: using
   * {@link getInstance} there would spawn a Worker purely to cancel (and throw
   * in SSR, where `Worker` is undefined). If no manager exists nothing is
   * queued, so this is a no-op.
   */
  public static cancelLayoutForEntity(entityId: string): void {
    LayoutWorkerManager.instance?.cancelLayout(entityId);
  }

  public queueLayout(
    entityId: string,
    text: string,
    options: {
      fontId: string;
      fontSize: number;
      maxWidth: number;
      maxHeight: number;
      fontData?: any;
      lineHeight?: number;
      letterSpacing?: number;
      textAlign?: 'left' | 'justify';
      callback: (res: LayoutWorkerResponse) => void;
    },
  ): void {
    // Clear existing debounce timer for entity (per-entity scope)
    const existingTimer = this.debounceTimers.get(entityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const runLayout = () => {
      this.debounceTimers.delete(entityId);
      const nextSeqId = (this.seqIdCounter.get(entityId) ?? 0) + 1;
      this.seqIdCounter.set(entityId, nextSeqId);

      const request: LayoutWorkerRequest = {
        id: entityId,
        seqId: nextSeqId,
        text,
        fontId: options.fontId,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        fontSize: options.fontSize,
        lineHeight: options.lineHeight,
        letterSpacing: options.letterSpacing,
        textAlign: options.textAlign,
      };

      // Retain the metrics independently of what the current worker knows, so a
      // main-thread fallback can still lay this font out later.
      if (options.fontData) this.fontDataById.set(options.fontId, options.fontData);
      if (!this.registeredFonts.has(options.fontId)) {
        // The current worker doesn't know this font. That is normally a first
        // registration, but it is also exactly the state right after a worker
        // restart: `handleWorkerFailure` cleared registeredFonts, and a caller
        // that omits fontData (documented as optional because of the map above)
        // would otherwise be swallowed by the worker's unknown-fontId guard,
        // hanging its callback forever. Re-send whatever metrics we hold.
        const fontData = options.fontData ?? this.fontDataById.get(options.fontId);
        if (fontData) {
          request.fontData = fontData;
          this.registeredFonts.add(options.fontId);
        }
      }

      const key = `${entityId}-${nextSeqId}`;
      this.pendingCallbacks.set(key, { request, callback: options.callback });
      const worker = this.ensureWorker();
      if (!worker) {
        // No worker available (SSR, a CSP that blocks blob: workers, or a worker
        // already judged unavailable). Lay out on this thread instead: the
        // geometry is identical, only the thread differs.
        this.resolvePendingOnMainThread();
        return;
      }
      try {
        worker.postMessage(request);
      } catch {
        if (this.worker) this.handleWorkerFailure(this.worker);
        else this.resolvePendingOnMainThread();
      }
    };

    // Leading-edge debounce: execute immediately on first request, buffer subsequent ones by 50ms
    if (!this.seqIdCounter.has(entityId)) {
      runLayout();
    } else {
      const timer = setTimeout(runLayout, 50);
      this.debounceTimers.set(entityId, timer);
    }
  }

  public cancelLayout(entityId: string): void {
    const existingTimer = this.debounceTimers.get(entityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceTimers.delete(entityId);
    }
    // Remove any in-flight callback entries for this entity so we don't
    // pin a closure + `this` reference if the entity is destroyed while
    // the worker is still processing (the worker's response will be
    // discarded below).
    for (const key of this.pendingCallbacks.keys()) {
      if (key.startsWith(`${entityId}-`)) this.pendingCallbacks.delete(key);
    }
    // The per-entity seqId counter is deliberately NOT reset: replies are
    // keyed `${entityId}-${seqId}`, so restarting at 1 would let a stale reply
    // from a just-cancelled in-flight request match the NEXT request's pending
    // entry and deliver the old geometry to the new callback. Keeping it
    // monotonic makes cancelled replies unmatchable; the only cost is one
    // integer per live entity, cleared by destroy().
  }
}
