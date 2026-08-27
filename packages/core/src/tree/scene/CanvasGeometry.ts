/**
 * Canvas box geometry: the CSS↔logical mapping, the overlay layer alignment, and
 * the device-pixel-ratio math.
 *
 * Extraction 5 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2), shipped at **reduced
 * scope** for the same measured reason extractions 2 and 3 were reduced
 * (`DEC-0020`, `DEC-0022`): the decided `ContextAndResize` scope named nine
 * members, and six of them cannot move without a `Scene` back-edge. See the
 * decision record for the per-member measurement.
 *
 * ## What this owns
 *
 * Everything that is a pure function of the canvas's CSS box and the scene's
 * logical size:
 *
 * - {@link clientToScene} — browser viewport coordinates to logical ones.
 * - {@link syncOverlay} — keeps the a11y, portal, WebGL and WebGPU layers
 *   aligned with the canvas box, including the `position` that layers share with
 *   the canvas so a scroll needs no JS compensation, and the memo that makes an
 *   unchanged frame write nothing.
 * - {@link effectiveDPR} and {@link sizeGpuCanvas} — the DPR clamp and the
 *   backing-store sizing that follows from it.
 *
 * ## What is held, and what is passed in
 *
 * `canvas`, `a11yRoot` and `portalRoot` are held: `Scene` assigns all three
 * exactly once in its constructor and never reassigns them (`canvas` at
 * `Scene.ts:2423`, `a11yRoot` at `:2526`/`:2683`, `portalRoot` at
 * `:2670`/`:2684`).
 *
 * Everything else is a per-call argument (`DEC-0019` rule 5), because it is
 * genuinely mutable and holding it would go stale silently:
 *
 * - `width`/`height` are **public** fields that `resize` mutates and that code
 *   outside this package assigns directly (9 sites across the test suite,
 *   benchmarks and comparisons write `scene.width = …`). They cannot become this
 *   collaborator's state without changing the public API.
 * - `maxDPR` is public and externally assignable (`Scene.test.ts:1013`).
 * - `glCanvas` and `gpuCanvas` are created lazily — `gpuCanvas` only when the
 *   WebGPU particle path first runs (`Scene.ts:6468`) — so the overlay sync is
 *   told which layers exist at the moment it runs.
 *
 * ## What deliberately did not move
 *
 * `resize` stays on `Scene` and keeps its whole body. It mutates `width`,
 * `height`, `contentFontEpoch` and `contentViewportEpoch`, drives `renderer` and
 * `pointRenderer`, and calls `markDirty` — four domains, none of them this one.
 * It calls in here for the GPU canvas sizing and that is the honest extent of it
 * (`DEC-0019` rule 2 applied without inventing a back-edge).
 *
 * `setupEvents` and `watchDevicePixelRatio` both call `this.resize(…)`, so moving
 * either needs a `Scene` reference; a bound `resize` injected at construction is
 * still that reference captured in a closure, which `DEC-0020` refused for
 * `syncA11y` and `DEC-0021` refused for `_recordPhase`.
 *
 * `watchCanvasVisibility` reads `isRunning`, writes `lastTime`, calls
 * `scheduleFrame`, and owns `_canvasOnScreen`, whose readers are `loop` and
 * `stop`. That is render-scheduler state, so it belongs to extraction 6.
 *
 * `initWebGPUContext` is one member of a device-lifecycle cluster (`device`,
 * `deviceLost`, `manager`, `recoveryTimerId`, `gpuContext`,
 * `setupDeviceLostHandler`, `recreateWebGPUDeviceWithRetry`,
 * `clearGPUCanvasIfStale`) that `render` and `destroy` also drive.
 *
 * `getContentMetricScaleX` caches into `contentMetricScaleX` keyed by
 * `contentFontEpoch` and is called only by `syncContentGridProjection`, so it is
 * content-projection state and moves with the deferred projection walk.
 */

/** The overlay box last written by {@link CanvasGeometry.syncOverlay}. */
export interface OverlayGeometry {
  left: number;
  top: number;
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  /**
   * `position` written to the overlay layers, mirroring the canvas's own.
   *
   * Part of the memo because it is part of the written state: a canvas that
   * becomes `fixed` after the first sync (a scroll-driven CSS class, a
   * full-screen toggle) changes nothing else in here — same box, same logical
   * size — so without this the memo would short-circuit and leave the overlay
   * positioned the old way.
   */
  position: 'absolute' | 'fixed';
}

export class CanvasGeometry {
  private readonly canvas: HTMLCanvasElement;
  private readonly a11yRoot: HTMLDivElement | null;
  private readonly portalRoot: HTMLDivElement | null;

  /** Last geometry {@link syncOverlay} wrote, so an unchanged frame can skip the
   *  style writes entirely. Cleared by {@link invalidateOverlay} to force the next
   *  sync (a new overlay layer was created and has never been positioned). */
  private overlayGeometry: OverlayGeometry | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    a11yRoot: HTMLDivElement | null,
    portalRoot: HTMLDivElement | null,
  ) {
    this.canvas = canvas;
    this.a11yRoot = a11yRoot;
    this.portalRoot = portalRoot;
  }

  /** Convert browser viewport coordinates into the scene's logical coordinates. */
  public clientToScene(
    clientX: number,
    clientY: number,
    width: number,
    height: number,
  ): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect?.();
    if (!rect) return { x: clientX, y: clientY };
    const cssWidth = rect.width || this.canvas.clientWidth || width;
    const cssHeight = rect.height || this.canvas.clientHeight || height;
    return {
      x: (clientX - rect.left) * (cssWidth > 0 ? width / cssWidth : 1),
      y: (clientY - rect.top) * (cssHeight > 0 ? height / cssHeight : 1),
    };
  }

  /** Effective device pixel ratio, matching CanvasRenderer: real DPR clamped to
   *  `maxDPR` when set. */
  public effectiveDPR(maxDPR: number | undefined): number {
    const raw =
      typeof window !== 'undefined'
        ? (window as unknown as { devicePixelRatio?: number }).devicePixelRatio
        : 1;
    const real = Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 1;
    if (maxDPR === undefined) return real;
    if (!Number.isFinite(maxDPR) || maxDPR <= 0) return real;
    return Math.min(real, maxDPR);
  }

  /** Size the WebGPU particle canvas: backing store at logical × DPR, CSS box at
   *  the logical size. Sizing the backing store in logical px (the old
   *  behavior) left it rasterized at 1× and CSS-stretched — blurry on HiDPI. */
  public sizeGpuCanvas(
    gpuCanvas: HTMLCanvasElement,
    width: number,
    height: number,
    maxDPR: number | undefined,
  ): void {
    const dpr = this.effectiveDPR(maxDPR);
    gpuCanvas.width = Math.max(1, Math.round(width * dpr));
    gpuCanvas.height = Math.max(1, Math.round(height * dpr));
    gpuCanvas.style.width = `${width}px`;
    gpuCanvas.style.height = `${height}px`;
  }

  /** The memo, for the delegating accessor `Scene` keeps for its test readers. */
  public get overlay(): OverlayGeometry | null {
    return this.overlayGeometry;
  }

  /** Force the next {@link syncOverlay} to write: a new overlay layer exists and
   *  has never been positioned. */
  public invalidateOverlay(): void {
    this.overlayGeometry = null;
  }

  /** Keep DOM/WebGL overlay layers aligned with the canvas's CSS box. */
  public syncOverlay(
    width: number,
    height: number,
    glCanvas: HTMLCanvasElement | null,
    gpuCanvas: HTMLCanvasElement | null,
  ): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const canvasRect = this.canvas.getBoundingClientRect?.();
    const parentRect = parent.getBoundingClientRect?.();
    const cssWidth = canvasRect?.width || this.canvas.clientWidth || width;
    const cssHeight = canvasRect?.height || this.canvas.clientHeight || height;

    // Position the overlay the way the browser positions the CANVAS, so a scroll
    // needs no JS compensation to stay aligned.
    //
    // A `position: fixed` canvas — the standard full-viewport scene, where the
    // page scrolls behind a pinned canvas — is composited against the viewport by
    // the browser, instantly and off the main thread. An `absolute` overlay is
    // laid out against the scrolling document instead, so keeping the two
    // together meant re-deriving `top` from the parent's ever-changing rect and
    // writing it once per RENDERED frame. Any frame where scroll advanced but the
    // render loop had not run yet left the overlay stale by that frame's whole
    // scroll delta, and a selection highlight visibly detached from its glyphs.
    //
    // Measured on a live full-viewport scene, real key-driven smooth scroll over
    // 630px: 661 sampled frames, 1 frame misaligned by 64.8px. Positioning the
    // overlay `fixed` like the canvas and re-running the same 630px scroll:
    // 655 frames, worst misalignment 0.000px. The remaining frames were already
    // correct in both, which is why this reads as an intermittent jitter rather
    // than a constant offset.
    //
    // This is a fix by REMOVING the per-frame dependency, not by syncing more
    // often. A scroll listener would still be main-thread work racing the
    // compositor; matching the canvas's containing block means there is nothing
    // to keep in sync in the first place.
    const canvasPosition =
      typeof getComputedStyle === 'function' ? getComputedStyle(this.canvas).position : '';
    const position = canvasPosition === 'fixed' ? 'fixed' : 'absolute';

    // A `fixed` layer resolves left/top against the viewport, which is exactly
    // what the canvas's own client rect already is. An `absolute` layer keeps the
    // original parent-relative arithmetic.
    const left =
      position === 'fixed'
        ? (canvasRect?.left ?? 0)
        : (canvasRect?.left ?? 0) -
          (parentRect?.left ?? 0) -
          (parent.clientLeft || 0) +
          parent.scrollLeft;
    const top =
      position === 'fixed'
        ? (canvasRect?.top ?? 0)
        : (canvasRect?.top ?? 0) -
          (parentRect?.top ?? 0) -
          (parent.clientTop || 0) +
          parent.scrollTop;
    const scaleX = width > 0 ? cssWidth / width : 1;
    const scaleY = height > 0 ? cssHeight / height : 1;

    // The overlay layers only move when the canvas box, the logical size, or the
    // CSS↔logical scale actually changes — which is rare (resize, zoom, a
    // scrolled ancestor), not every frame. Bail out when nothing moved instead of
    // re-writing ten style properties per layer per frame: identical assignments
    // still touch the CSSOM, and the write set grows with every overlay layer.
    const prev = this.overlayGeometry;
    if (
      prev !== null &&
      prev.left === left &&
      prev.top === top &&
      prev.cssWidth === cssWidth &&
      prev.cssHeight === cssHeight &&
      prev.width === width &&
      prev.height === height &&
      prev.position === position
    ) {
      return;
    }
    this.overlayGeometry = {
      left,
      top,
      cssWidth,
      cssHeight,
      width,
      height,
      position,
    };

    for (const root of [this.a11yRoot, this.portalRoot]) {
      if (!root) continue;
      root.style.position = position;
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      root.style.transformOrigin = '0 0';
      root.style.transform = `scale(${scaleX}, ${scaleY})`;
    }

    for (const canvas of [glCanvas, gpuCanvas]) {
      if (!canvas) continue;
      canvas.style.position = position;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
  }
}
