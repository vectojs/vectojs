/**
 * The content projection's **selection preservation** and **grid calibration** —
 * the two halves of extraction 3 that are separable today.
 *
 * Extraction 3 of the `Scene.ts` decomposition
 * (`forge/decisions/file-decomposition-2026-08.md` §2), reduced in scope by
 * carryctx `DEC-0022` for the same measured reason `DEC-0020` reduced extraction
 * 2: the projection *walk* is not separable yet.
 *
 * ## What this owns
 *
 * **Selection across rebuilds.** A streaming message replaces its projection
 * children on every appended chunk, and a naive rebuild wipes a selection the
 * user made in the unchanged prefix. This owns the tracked drag anchor, the
 * blank-region drag flag, the per-walk "is anything selected at all" memo, and
 * the snapshot/restore of selection endpoints as linear character offsets.
 *
 * **Grid calibration.** The cold read/write batch that measures a projected
 * grid's real laid-out text and writes a per-cell `scaleX`, its generation
 * stamping, its probe DOM, and the pending-frame/probe bookkeeping that lets a
 * teardown cancel work in flight.
 *
 * ## What it deliberately does not own
 *
 * `syncContentProjection` (624 lines) and its helpers stay on `Scene`. It is the
 * far side of the shared walk `DEC-0020` measured: `syncA11y` calls it at its own
 * recursion point, and it reads the four per-sync fields `syncA11y` initialises
 * (`_syncSerial`, `contentSemanticBudgetLeft`, `contentSemanticDeferred`,
 * `contentSelectionPresentThisSync`). The two walk drivers move together, once
 * they can be cut as a pair rather than threaded through each other — taking
 * either alone needs a back-edge, which `DEC-0019` rule 1 forbids.
 *
 * `getContentMetricScaleX` also stays: it reads `canvas` and `width`, which
 * `resize` mutates, so it is extraction 5's state. Its result is already a
 * parameter of {@link scheduleGridCalibration}, so nothing here reaches for it.
 *
 * ## What is passed in, and why
 *
 * `a11yRoot` is injected because it is assigned once in `Scene`'s constructor and
 * never reassigned, so it is safe to hold. {@link PhaseTimer} is injected because
 * it is the shared leaf `DEC-0021` extracted for exactly this: the calibration
 * pass records `calibScan` and `calibProbeBuild`, and reaching a `Scene` private
 * to do it — or holding a bound `Scene` method — is the rule 1 violation this
 * whole sequence is avoiding.
 *
 * The font epoch is a per-call argument rather than held state (`DEC-0019` rule
 * 5): a font load and a resize both bump it, and both belong to other domains.
 */

import { PhaseTimer } from './PhaseTimer';
import {
  projectionAbsoluteOffset,
  projectionCaretAt,
  type TextCaretPosition,
} from './content-caret';

/**
 * Length of the page-scale basis the calibration probe measures, in CSS px.
 *
 * The probe reads the client distance between a span at `left: 0` and one at
 * `left: <this>px` to recover the page's own layout scale, then divides by this
 * length. It **must not be 1**, which is what it was: a browser rounds a
 * `getBoundingClientRect().left` to 1/64 device px, so a 1 px basis quantizes to
 * a multiple of 1/64 and the recovered scale carries the whole rounding error.
 *
 * Measured in real headed Chrome at `devicePixelRatio` 1.1000000685 on
 * xuepoo-blog: the 1 px basis returned **0.9921875** (= 63.5/64) where the page
 * scale was **1.0** — a 0.78% error. Every per-cell `scaleX` is
 * `advance * scale / natural`, so that error shrank every carrier's painted
 * advance below its grid pitch and the browser's selection rects, sized from the
 * painted advance, fell short of tiling it: 18.0001 px of pitch selected as
 * 17.8624 px, leaving a **0.133 px** gap at every CJK seam and 0.061 px at every
 * Latin one. At DPR 1.1 those land on a device-pixel boundary and paint as a
 * vertical white line between adjacent Han glyphs — the `使|用|sudo` artifact.
 *
 * A longer basis divides the same fixed 1/64 rounding by its own length, so the
 * recovered scale converges. Measured over bases 1/2/4/10/100/1000 px on the same
 * page: `0.9921875, 1.0, 0.998046875, 1.0, 1.0, 1.0` — every basis of 10 px or
 * more agreed exactly while the 1 px read was the outlier. 256 px keeps the worst
 * case at 1/64 / 256 = 6.1e-5 (a 0.0011 px residue on an 18 px cell, ~100x below
 * the 1/64 device pixel a browser can even represent) while staying far inside
 * the probe's own 100000 px width, so it cannot introduce a scrollbar or a
 * layout of its own.
 */
const PAGE_SCALE_BASIS_PX = 256;

export class ContentProjectionManager {
  /**
   * `a11yRoot` doubles as the projection root: carriers are appended to it, and
   * the calibration probe is parented under it so CSS zoom and font substitution
   * match the live carriers. `null` in non-DOM (SSR/Node) environments.
   */
  private readonly a11yRoot: HTMLDivElement | null;
  private readonly phases: PhaseTimer;

  // --- selection preservation ------------------------------------------------
  /**
   * True while a drag that started in a blank region of the projection is live.
   * Mid-drag the browser is authoritative, so a rebuild must not try to preserve
   * anything.
   */
  private blankRegionDrag = false;
  /** Tracked drag anchor. Survives a drag, unlike the live DOM selection. */
  private anchor: TextCaretPosition | null = null;
  /**
   * Memo for {@link selectionPresent}, valid for one sync walk.
   *
   * Reading any `Selection` property forces a synchronous layout, so the answer
   * is resolved once per walk rather than once per rebuilt element. `null` means
   * "not yet asked this walk".
   */
  private presentThisSync: boolean | null = null;

  // --- grid calibration ------------------------------------------------------
  /** Pending calibration rAF handle per projected grid entity. */
  private readonly calibrationFrameHandles = new Map<string, number>();
  /** Detached, untransformed font probes used by the cold calibration pass. */
  private readonly calibrationProbes = new Map<string, HTMLElement>();
  /**
   * Bumped when the conditions a measurement depends on change, which
   * invalidates every existing per-cell `scaleX` at once without touching them.
   */
  private calibrationGeneration = 0;
  /** The conditions the current generation was measured under. */
  private calibrationStamp = '';

  public constructor(a11yRoot: HTMLDivElement | null, phases: PhaseTimer) {
    this.a11yRoot = a11yRoot;
    this.phases = phases;
  }

  /** Pending calibration frames, keyed by entity id. Read by the e2e lifecycle probe. */
  public get calibrationFrames(): ReadonlyMap<string, number> {
    return this.calibrationFrameHandles;
  }

  /**
   * Start tracking a drag that began in a blank region of the projection.
   *
   * Called from the projection root's `mousedown` handler, which has already
   * resolved the caret and collapsed or extended the live selection.
   */
  public beginBlankRegionDrag(anchor: TextCaretPosition): void {
    this.anchor = anchor;
    this.blankRegionDrag = true;
  }

  /** The tracked drag anchor, for extending a selection as the pointer moves. */
  public get selectionAnchor(): TextCaretPosition | null {
    return this.anchor;
  }

  /**
   * Whether a manually-driven blank-region drag is live.
   *
   * The projection root's `mousemove` handler gates on this: with no native
   * anchor, the browser will not extend the selection itself.
   */
  public get blankRegionDragActive(): boolean {
    return this.blankRegionDrag;
  }

  /**
   * Drop the memo describing whether the document holds a selection.
   *
   * Called at the top of each a11y sync walk: the memo answers a question about
   * the live document, and a value from an earlier frame would be wrong.
   */
  public invalidateSelectionMemo(): void {
    this.presentThisSync = null;
  }

  public endDrag(): void {
    this.blankRegionDrag = false;
    this.anchor = null;
    if (this.a11yRoot) this.a11yRoot.style.pointerEvents = 'none';
  }

  /**
   * Index of the carrier line currently holding a selection inside `el`, or
   * `null`.
   *
   * Lets a partial re-materialization decide whether the user's selection is even
   * affected. Checks the tracked anchor first (it survives a drag) and falls back
   * to the live DOM selection.
   */
  public gridSelectionLine(el: HTMLElement): number | null {
    const candidates: Array<Node | null | undefined> = [this.anchor?.node];
    if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
      const selection = window.getSelection();
      candidates.push(selection?.anchorNode, selection?.focusNode);
    }
    for (const candidate of candidates) {
      if (!candidate || !el.contains(candidate)) continue;
      // Walk up to the direct child of `el`, which is the carrier line.
      let cursor: Node | null = candidate;
      while (cursor && cursor.parentNode !== el) cursor = cursor.parentNode;
      const lineIndex = (cursor as HTMLElement | null)?.dataset?.vectoGridLine;
      if (lineIndex !== undefined) return Number(lineIndex);
    }
    return null;
  }

  /**
   * Does the document hold a selection right now, memoized for this sync walk?
   *
   * Pays one forced layout per walk instead of one per rebuilt element — see
   * {@link presentThisSync} for the measurements. When the answer is `false` no
   * element can own a selection, so every per-element ownership test can be
   * skipped without touching the object.
   */
  public selectionPresent(): boolean {
    if (this.presentThisSync !== null) {
      return this.presentThisSync;
    }
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    // `anchorNode`/`focusNode` rather than `rangeCount`: a collapsed caret still
    // has an anchor and still belongs to whoever contains it, and every property
    // costs the same single forced layout anyway.
    const present = !!selection && (!!selection.anchorNode || !!selection.focusNode);
    this.presentThisSync = present;
    return present;
  }

  public releaseSelectionForRebuild(el: HTMLElement): void {
    // Cheap rejection first. The tracked anchor is this object's own field so it
    // costs nothing, and the memo costs one forced layout per sync walk rather
    // than one per element. With neither an anchor nor a document selection there
    // is nothing to release — the case for every block of a bulk materialization.
    if (!this.anchor && !this.selectionPresent()) return;
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    const ownsSelection =
      (this.anchor && el.contains(this.anchor.node)) ||
      (selection?.anchorNode ? el.contains(selection.anchorNode) : false) ||
      (selection?.focusNode ? el.contains(selection.focusNode) : false);
    if (!ownsSelection) return;
    this.endDrag();
    selection?.removeAllRanges();
    // The memo described the document before this release; it no longer does.
    this.presentThisSync = null;
  }

  /**
   * Rebuild a content-projection element's DOM (`rebuild`) while preserving a
   * text selection the user made inside it. A streaming message replaces its
   * projection children on every appended chunk; without this, a selection in
   * the UNCHANGED prefix is wiped on each frame ("can't select text in a
   * message still receiving tokens"). We snapshot the selection's anchor/focus
   * as linear character offsets within `el` before the rebuild and re-resolve
   * them against the new DOM after, clamped to the new text length.
   *
   * Only fires when `el` owns the current selection and there is no active drag
   * (mid-drag the browser is authoritative). The virtualization case — where
   * `el` itself is removed from the DOM — is out of scope here (the node is
   * genuinely freed; the browser clears the selection and there is nothing to
   * restore against).
   */
  public preserveSelectionAcrossRebuild(el: HTMLElement, rebuild: () => void): void {
    // Nothing selected anywhere in the document means nothing to preserve and
    // nothing to release, so rebuild without touching the Selection object. This
    // is the bulk-materialization path, where reading a selection property would
    // force a layout over the whole projection subtree once per block — see
    // {@link presentThisSync}.
    if (!this.anchor && !this.selectionPresent()) {
      rebuild();
      return;
    }
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    const owns =
      !!selection &&
      !this.blankRegionDrag &&
      ((selection.anchorNode ? el.contains(selection.anchorNode) : false) ||
        (selection.focusNode ? el.contains(selection.focusNode) : false));

    if (!owns || !selection.anchorNode || !selection.focusNode) {
      // Nothing to preserve — fall back to the plain release + rebuild.
      this.releaseSelectionForRebuild(el);
      rebuild();
      return;
    }

    // Snapshot as linear offsets within this element's text. Selection
    // endpoints are only meaningful to the offset walk when they are text
    // nodes; a non-Text endpoint yields null and we skip restore.
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorOffset =
      anchorNode instanceof Text
        ? projectionAbsoluteOffset(el, {
            node: anchorNode,
            offset: selection.anchorOffset,
          })
        : null;
    const focusOffset =
      focusNode instanceof Text
        ? projectionAbsoluteOffset(el, {
            node: focusNode,
            offset: selection.focusOffset,
          })
        : null;

    this.endDrag();
    selection.removeAllRanges();
    rebuild();

    if (anchorOffset === null || focusOffset === null) return;
    const textLen = (el.textContent ?? '').length;
    if (anchorOffset > textLen || focusOffset > textLen) return; // selection ran into removed tail
    const anchor = projectionCaretAt(el, anchorOffset, 'forward');
    const focus = projectionCaretAt(el, focusOffset, 'backward');
    if (!anchor || !focus) return;
    try {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } catch {
      // Engine rejected a reverse/cross-node range — leave selection cleared.
    }
  }

  /**
   * A selection inside a projected grid, expressed as offsets into `grid.source`.
   *
   * Source offsets rather than the linear DOM offsets
   * {@link preserveSelectionAcrossRebuild} uses, because the grid path windows its
   * carriers: the DOM holds only the lines near the viewport, so linear offset 0
   * means "the first line that happens to be materialized" and moves whenever the
   * window does. A reflow changes both the line breaks and the window, so a linear
   * offset would restore the selection onto different characters. Every carrier
   * cell already records its own `sourceStart`/`sourceEnd`, which are stable
   * against line breaking, windowing, and per-cell calibration.
   */
  private gridSelectionEndpointOffset(el: HTMLElement, node: Node, offset: number): number | null {
    if (!el.contains(node)) return null;
    // A block promoted from the coarse tier holds one text node with the WHOLE
    // source, so its own offsets are already source offsets.
    if (node.parentNode === el) {
      return node instanceof Text ? Math.min(offset, node.data.length) : null;
    }
    // The endpoint's own offset only means characters when the endpoint IS the
    // text; an element endpoint addresses child nodes, so it contributes nothing
    // and the cell's start is the answer.
    const withinCell = node instanceof Text ? offset : 0;
    let cursor: Node | null = node;
    while (cursor && cursor !== el) {
      const cell = cursor as HTMLElement;
      const start = cell.dataset?.vectoGridSourceStart;
      if (start !== undefined) {
        const sourceStart = Number(start);
        const sourceLength = Number(cell.dataset.vectoGridSourceLength ?? 0);
        if (!Number.isFinite(sourceStart)) return null;
        // Clamp to the cell's own source text: the last cell of a line also
        // carries the trailing hard break in the same text node, and those
        // characters belong to no cell's source span.
        return sourceStart + Math.min(withinCell, sourceLength);
      }
      cursor = cursor.parentNode;
    }
    return null;
  }

  /**
   * Where in `grid.source` the live selection sits, or `null` when this element
   * does not own one that can be expressed that way.
   *
   * Cheap-rejects exactly as {@link releaseSelectionForRebuild} does: the tracked
   * anchor is a local field, and the memo costs one forced layout per sync walk
   * rather than one per element.
   */
  public snapshotGridSelection(el: HTMLElement): { anchor: number; focus: number } | null {
    if (!this.anchor && !this.selectionPresent()) return null;
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    // Mid-drag the browser is authoritative, so there is nothing to snapshot and
    // nothing to put back.
    if (!selection || this.blankRegionDrag) return null;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) return null;
    if (!el.contains(anchorNode) && !el.contains(focusNode)) return null;
    const anchor = this.gridSelectionEndpointOffset(el, anchorNode, selection.anchorOffset);
    const focus = this.gridSelectionEndpointOffset(el, focusNode, selection.focusOffset);
    if (anchor === null || focus === null) return null;
    return { anchor, focus };
  }

  /** The carrier caret for a source offset, or `null` when it is not projected. */
  private gridCaretAtSourceOffset(el: HTMLElement, sourceOffset: number): TextCaretPosition | null {
    for (const cell of el.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')) {
      const sourceStart = Number(cell.dataset.vectoGridSourceStart ?? Number.NaN);
      const sourceLength = Number(cell.dataset.vectoGridSourceLength ?? 0);
      if (!Number.isFinite(sourceStart)) continue;
      // Cells arrive in logical source order, so the FIRST cell whose span covers
      // the offset wins. An offset on a shared boundary resolves to the end of the
      // earlier cell, which is the same caret position as the start of the next.
      if (sourceOffset >= sourceStart && sourceOffset <= sourceStart + sourceLength) {
        const node = cell.firstChild;
        if (node instanceof Text) return { node, offset: sourceOffset - sourceStart };
      }
    }
    return null;
  }

  /**
   * Put a {@link snapshotGridSelection} result back after a re-materialization,
   * releasing instead whenever the selected text is no longer projected.
   *
   * Restoring is what keeps a selection alive across a reflow or a browser zoom,
   * where every carrier line is rebuilt (the line breaks moved) but the selected
   * characters are still on screen. When the window scrolled past them instead,
   * the offsets resolve to nothing and the selection is dropped — a `Range` left
   * pointing into detached carriers reports stale geometry and copies the wrong
   * text.
   */
  public restoreGridSelection(
    el: HTMLElement,
    snapshot: { anchor: number; focus: number } | null,
  ): void {
    if (!snapshot) {
      this.releaseSelectionForRebuild(el);
      return;
    }
    const anchor = this.gridCaretAtSourceOffset(el, snapshot.anchor);
    const focus = this.gridCaretAtSourceOffset(el, snapshot.focus);
    if (!anchor || !focus) {
      this.releaseSelectionForRebuild(el);
      return;
    }
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    if (!selection) return;
    this.endDrag();
    try {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } catch {
      // Engine rejected the range — leave the selection cleared rather than
      // stranded on the old nodes.
      selection.removeAllRanges();
    }
    // The memo described the document before this pass; it no longer does.
    this.presentThisSync = null;
  }

  /**
   * Reset per-grid calibration and bookkeeping before a (re)materialization.
   *
   * @param entityId - Owning entity, keyed into the calibration maps.
   * @param el - The projection element.
   * @param releaseSelection - Whether to drop a selection this element owns.
   *   Pass `false` when carrier lines are being reused: the selection's DOM nodes
   *   survive the pass, so tearing it down would wipe a user's selection on every
   *   streamed chunk — the exact bug {@link preserveSelectionAcrossRebuild}
   *   exists to prevent on the non-grid path.
   */
  public clearGridState(entityId: string, el: HTMLElement, releaseSelection = true): void {
    const calibrationFrame = this.calibrationFrameHandles.get(entityId);
    if (calibrationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(calibrationFrame);
    }
    this.calibrationFrameHandles.delete(entityId);
    this.calibrationProbes.get(entityId)?.remove();
    this.calibrationProbes.delete(entityId);
    delete el.dataset.vectoGridCalibrationPending;
    delete el.dataset.vectoGridCalibration;
    delete el.dataset.vectoGridReady;
    delete el.dataset.vectoContentGrid;
    delete el.dataset.vectoGridCarriers;
    delete el.dataset.vectoGridMaterializeMs;
    delete el.dataset.vectoGridCalibrationSamples;
    delete el.dataset.vectoGridCalibrationMs;
    if (releaseSelection) this.releaseSelectionForRebuild(el);
  }

  /**
   * Cancel every calibration in flight and drop every probe.
   *
   * For `Scene.destroy()`: an outstanding rAF would otherwise run against a
   * destroyed scene, and a probe left in the document keeps a detached subtree
   * alive.
   */
  public dispose(): void {
    if (typeof cancelAnimationFrame === 'function') {
      for (const frame of this.calibrationFrameHandles.values()) {
        cancelAnimationFrame(frame);
      }
    }
    this.calibrationFrameHandles.clear();
    for (const probe of this.calibrationProbes.values()) probe.remove();
    this.calibrationProbes.clear();
    this.endDrag();
  }

  /**
   * Measure a projected grid's real laid-out text and write a per-cell `scaleX`.
   *
   * @param fontEpoch - `Scene`'s font epoch. Passed in rather than held: a font
   *   load and a resize both bump it, and both belong to other domains.
   */
  public scheduleGridCalibration(
    entityId: string,
    el: HTMLElement,
    calibrationKey: string,
    pageScaleX: number,
    fontEpoch: number,
  ): void {
    if (typeof requestAnimationFrame !== 'function') return;
    if (el.dataset.vectoGridCalibrationPending === calibrationKey) return;

    // Advance the calibration generation when the conditions a measurement depends
    // on change. The font epoch covers font availability; page scale covers browser
    // zoom. Both alter the laid-out width of the same text, so every existing
    // per-cell scaleX becomes wrong and must be re-measured rather than trusted.
    const stamp = `${fontEpoch}:${pageScaleX.toFixed(4)}`;
    if (this.calibrationStamp !== stamp) {
      this.calibrationStamp = stamp;
      this.calibrationGeneration++;
    }
    const generation = `${this.calibrationGeneration}`;

    // Cells not yet calibrated for this generation. Carrier reuse (#244) leaves an
    // untouched line's cells — and the transforms already written on them — in
    // place, so a streamed append leaves this matching only the rebuilt tail.
    // Queried before any probe DOM is built so the common no-op case costs one
    // selector match.
    const pendingCells = el.querySelectorAll<HTMLElement>(
      `[data-vecto-grid-cell]:not([data-vecto-grid-calib="${generation}"])`,
    );

    // Complete without a probe when nothing is pending: no probe construction, no
    // forced layout, and no two-frame round trip. This is the steady state while
    // streaming.
    //
    // The condition is `pendingCells.length` and NOT the number of measurable
    // cells. Those differ on a FIRST projection, where every cell is pending yet all
    // may be legitimately skipped as unmeasurable (zero advance, empty text). Using
    // the measurable count marked such a grid ready without ever measuring it: a
    // standalone Table's cell selection then returned '' instead of its text,
    // because the e2e waits on `vectoGridReady` and proceeded before the browser had
    // laid the new carriers out.
    if (pendingCells.length === 0) {
      el.dataset.vectoGridCalibrationSamples = '0';
      delete el.dataset.vectoGridCalibrationPending;
      // `vectoGridReady` must be published from a frame callback, not synchronously.
      //
      // Its contract is "this projection's geometry is settled and safe to measure",
      // which is stronger than "calibration has no work to do". Consumers act on it
      // by immediately calling `getBoundingClientRect` — the e2e locates a drag that
      // way — and carriers materialized earlier in this same task have not been laid
      // out yet, so a synchronous flag hands out a zero-width rect and a drag lands
      // outside the text. The probe path implicitly satisfied the contract by
      // spending two frames before setting it; this path has no probe, so it waits
      // one frame explicitly. Still far cheaper than building and measuring a probe.
      const readyFrame = requestAnimationFrame(() => {
        this.calibrationFrameHandles.delete(entityId);
        if (!el.isConnected) return;
        el.dataset.vectoGridCalibration = calibrationKey;
        el.dataset.vectoGridReady = 'true';
      });
      this.calibrationFrameHandles.set(entityId, readyFrame);
      return;
    }
    const previous = this.calibrationFrameHandles.get(entityId);
    if (previous !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(previous);
    }
    this.calibrationProbes.get(entityId)?.remove();
    this.calibrationProbes.delete(entityId);
    const calibrationStart = typeof performance !== 'undefined' ? performance.now() : 0;

    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.dataset.vectoGridProbe = entityId;
    probe.style.position = 'absolute';
    probe.style.left = '-100000px';
    probe.style.top = '0';
    probe.style.width = '100000px';
    probe.style.height = '1px';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.whiteSpace = 'pre';
    probe.style.contain = 'layout style paint';
    const probeOrigin = document.createElement('span');
    probeOrigin.style.position = 'absolute';
    probeOrigin.style.left = '0';
    probeOrigin.style.top = '0';
    const probeX = document.createElement('span');
    probeX.style.position = 'absolute';
    probeX.style.left = `${PAGE_SCALE_BASIS_PX}px`;
    probeX.style.top = '0';
    probe.append(probeOrigin, probeX);
    const measurements: Array<{
      targets: HTMLElement[];
      targetWidth: number;
      sourceLength: number;
      source: Text;
    }> = [];
    const measurementsByKey = new Map<string, (typeof measurements)[number]>();
    const scanStart = this.phases.enabled ? performance.now() : 0;
    for (const target of pendingCells) {
      const sourceLength = Number(target.dataset.vectoGridSourceLength ?? 0);
      const targetWidth = Number(target.dataset.vectoGridAdvance ?? 0);
      // Cells with nothing to measure are stamped immediately: leaving them
      // unstamped would keep them in the selector and re-scan them every frame,
      // which is the cost this whole change exists to remove.
      if (sourceLength <= 0 || targetWidth <= 0) {
        target.dataset.vectoGridCalib = generation;
        continue;
      }
      const sourceText = target.textContent?.slice(0, sourceLength) ?? '';
      if (!sourceText) {
        target.dataset.vectoGridCalib = generation;
        continue;
      }
      // Read the font from a data attribute, not `target.style.font`.
      //
      // `style.font` is a shorthand getter: Chrome re-serializes it from every font
      // longhand on each read. Done once per cell per frame that made the scan
      // 288 ms of a 290 ms calibration pass — 99.3% — while Firefox, whose getter
      // is cheap, spent 0.6 ms on the identical loop. A 480x cross-engine gap on
      // the same code is the signal that the cost is the property access itself,
      // not the work around it. The carrier already knows its font (the projection
      // just assigned it), so it records it as a plain string for reading back.
      const cellFont = target.dataset.vectoGridFont ?? '';
      const cellLineHeight = target.dataset.vectoGridLineHeight ?? '';
      const measurementKey = JSON.stringify([cellFont, cellLineHeight, targetWidth, sourceText]);
      const shared = measurementsByKey.get(measurementKey);
      if (shared) {
        shared.targets.push(target);
        continue;
      }
      const carrier = document.createElement('span');
      carrier.dir = 'ltr';
      carrier.style.position = 'absolute';
      carrier.style.left = '0';
      carrier.style.top = '0';
      carrier.style.whiteSpace = 'pre';
      carrier.style.font = cellFont;
      carrier.style.lineHeight = cellLineHeight;
      carrier.style.fontVariantLigatures = 'none';
      carrier.style.fontKerning = 'none';
      const source = document.createTextNode(sourceText);
      carrier.appendChild(source);
      probe.appendChild(carrier);
      const measurement = {
        targets: [target],
        targetWidth,
        sourceLength,
        source,
      };
      measurements.push(measurement);
      measurementsByKey.set(measurementKey, measurement);
    }
    // Keep the probe under the projection root so CSS zoom and font
    // substitution match the live carriers. Gecko may still return an
    // unzoomed Range width for a missing-glyph fallback; pageScaleX below
    // compensates that engine behavior without special-casing the font.
    if (this.phases.enabled) this.phases.record('calibScan', performance.now() - scanStart);

    // No measurable cell among the pending ones: every one was zero-advance or
    // empty text and has just been stamped, so there is nothing to lay out and no
    // reason to spend two animation frames. Distinct from the `pendingCells` early
    // exit above, which covers the already-calibrated steady state.
    if (measurements.length === 0) {
      // The probe is not in the document yet (it is appended below), so it needs no
      // removal here — it simply goes unreferenced.
      el.dataset.vectoGridCalibration = calibrationKey;
      el.dataset.vectoGridReady = 'true';
      el.dataset.vectoGridCalibrationSamples = '0';
      delete el.dataset.vectoGridCalibrationPending;
      return;
    }

    const appendStart = this.phases.enabled ? performance.now() : 0;
    (this.a11yRoot ?? document.body ?? document.documentElement).appendChild(probe);
    if (this.phases.enabled) this.phases.record('calibProbeBuild', performance.now() - appendStart);
    el.dataset.vectoGridCalibrationSamples = `${measurements.length}`;
    this.calibrationProbes.set(entityId, probe);
    el.dataset.vectoGridCalibrationPending = calibrationKey;
    delete el.dataset.vectoGridReady;
    const readFrame = requestAnimationFrame(() => {
      if (!el.isConnected || el.dataset.vectoGridCalibrationPending !== calibrationKey) {
        probe.remove();
        this.calibrationProbes.delete(entityId);
        this.calibrationFrameHandles.delete(entityId);
        return;
      }
      const updates: Array<{ element: HTMLElement; scale: number }> = [];
      const probeOriginRect = probeOrigin.getBoundingClientRect();
      const probeXRect = probeX.getBoundingClientRect();
      const basisScale = Math.abs(probeXRect.left - probeOriginRect.left) / PAGE_SCALE_BASIS_PX;
      const projectionPageScaleX =
        Number.isFinite(basisScale) && basisScale > 0 ? basisScale : pageScaleX;
      let valid = true;
      for (const measurement of measurements) {
        const range = document.createRange();
        range.setStart(measurement.source, 0);
        range.setEnd(measurement.source, measurement.sourceLength);
        const natural = range.getBoundingClientRect().width;
        if (!Number.isFinite(natural) || natural <= 0) {
          valid = false;
          break;
        }
        const scale = (measurement.targetWidth * projectionPageScaleX) / natural;
        for (const element of measurement.targets) updates.push({ element, scale });
      }
      probe.remove();
      this.calibrationProbes.delete(entityId);
      if (!valid) {
        delete el.dataset.vectoGridCalibrationPending;
        this.calibrationFrameHandles.delete(entityId);
        return;
      }
      const writeFrame = requestAnimationFrame(() => {
        if (!el.isConnected || el.dataset.vectoGridCalibrationPending !== calibrationKey) {
          this.calibrationFrameHandles.delete(entityId);
          return;
        }
        for (const { element, scale } of updates) {
          element.style.transform = Math.abs(scale - 1) <= 0.001 ? '' : `scaleX(${scale})`;
          // Stamp only after the transform is actually applied. If the pass bails
          // out as invalid, these stay unstamped and are retried next revision,
          // which is the behaviour that keeps a failed measurement from being
          // silently treated as done.
          element.dataset.vectoGridCalib = generation;
        }
        el.dataset.vectoGridCalibration = calibrationKey;
        el.dataset.vectoGridReady = 'true';
        if (typeof performance !== 'undefined') {
          el.dataset.vectoGridCalibrationMs = `${performance.now() - calibrationStart}`;
        }
        delete el.dataset.vectoGridCalibrationPending;
        this.calibrationFrameHandles.delete(entityId);
      });
      this.calibrationFrameHandles.set(entityId, writeFrame);
    });
    this.calibrationFrameHandles.set(entityId, readFrame);
  }
}
