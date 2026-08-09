/**
 * Grid carrier materialization: turning a prepared content grid into positioned
 * DOM carriers, with per-line reuse so streaming stays affordable.
 *
 * The deferred **projection walk** extraction (`DEC-0028` measurement,
 * `DEC-0019` pattern). The walk was deferred by `DEC-0020` and `DEC-0022` on the
 * grounds that `syncA11y` and `syncContentProjection` are one shared depth-first
 * walk and would have to move as a pair. Re-measured on `58c77ac` that premise
 * held for the two walk drivers and **not** for this member: the grid path is a
 * leaf of the walk, not part of it.
 *
 * ## Why this is separable when its callers are not
 *
 * `syncContentGridProjection` has exactly one call site, takes everything it
 * needs as parameters already, and calls nothing else on `Scene` except the
 * content-projection manager and the phase timer. Its own state is two memo
 * fields nobody outside it reads. It writes no state any other domain reads, so
 * there is no back-edge to invent and `DEC-0019` rule 1 is satisfied outright.
 *
 * ## What is held, and what is passed in
 *
 * Held: the {@link ContentProjectionManager} and the {@link PhaseTimer}. Both are
 * `readonly` on `Scene`, constructed once, and already shared collaborators — the
 * timer is the shared leaf `DEC-0021` extracted for exactly this reason.
 *
 * Per-call (`DEC-0019` rule 5): `pageScaleX` and `fontEpoch`. `Scene` keeps
 * `getContentMetricScaleX`, which reads `canvas` and the **public mutable**
 * `width`, and whose memo is keyed on `contentFontEpoch` that `resize` and a font
 * load both bump. Holding either here would go stale silently. `entityId` is
 * passed rather than the `Entity`, because the id is all this needs.
 *
 * ## What deliberately did not move
 *
 * `syncContentProjection` (the walk's content driver) and `syncA11y` (its a11y
 * driver) stay together on the facade, still blocked on each other exactly as
 * `DEC-0020` measured.
 *
 * `projectionBoxVisible` also stays, for a reason measurement found rather than
 * predicted: `test/ContentProjectionSettledWalk.test.ts` replaces it on the
 * `Scene` instance and asserts call counts (the settled-walk fast path is
 * verified by counting box tests, 2 when settled against 802 unpruned). Moving
 * it onto a collaborator would make those calls invisible to the patch and turn
 * a behavioural regression test into one that cannot fail. The suite is unedited
 * by contract, so the member stays where the test can see it.
 */

import type { ContentProjection, ContentProjectionLine } from '../Entity';
import { cssLineBoxBaseline } from '@vectojs/text';
import type { PreparedContentGrid, PreparedContentGridLine } from '@vectojs/text';
import { appendContentBreak } from './content-break-carrier';
import { projectionGridLineWindow } from './content-line-window';
import type { ContentProjectionManager } from './ContentProjectionManager';
import type { PhaseTimer } from './PhaseTimer';

export class ContentGridProjector {
  private readonly contentProjection: ContentProjectionManager;
  private readonly phases: PhaseTimer;

  public constructor(contentProjection: ContentProjectionManager, phases: PhaseTimer) {
    this.contentProjection = contentProjection;
    this.phases = phases;
  }

  /**
   * Materialize a prepared grid in logical source order while positioning each
   * carrier from the shared canvas geometry. Browser font measurement happens
   * later in one cold read/write batch, never inside projection synchronization.
   */
  public syncGrid(
    entityId: string,
    el: HTMLElement,
    projection: ContentProjection,
    grid: PreparedContentGrid,
    lineBand: { minY: number; maxY: number } | null,
    pageScaleX: number,
    fontEpoch: number,
  ): void {
    if (grid.source !== projection.text) {
      throw new Error('ContentProjection.grid.source must equal ContentProjection.text');
    }
    // Only the lines near the viewport get carriers. The grid path is where the
    // element volume lives — one `<span>` per glyph CLUSTER, not per line — so a
    // tall code block or table is exactly the case this bounds.
    const gridWindow = projectionGridLineWindow(grid, projection.lines, lineBand);
    // The window is part of the signature: scrolling changes which lines belong
    // without changing `grid.revision`, and without this the carriers would stay
    // frozen at whatever band was first built.
    //
    // The line ORIGIN is part of it too, for the same reason one level in. An
    // entity that scrolls its content horizontally (`CodeBlock`) moves every line
    // box without changing the grid, the revision, or the window — the source text
    // and the cell geometry within each line are identical, only the origin moved.
    // Gating on revision alone left the carriers frozen while the canvas glyphs
    // slid underneath, which detaches a native selection from the text it covers:
    // measured 1017px of divergence at full scroll before this was included.
    // Reading line 0 is enough because a projection applies one offset to every
    // row; a per-row offset would shear the grid and is not a thing any entity
    // does.
    const originSignature = projection.lines?.find((line) => line !== undefined)?.x ?? 0;
    const signature = gridWindow.gated
      ? `${grid.revision}:${gridWindow.start}-${gridWindow.end}:${originSignature}`
      : `${grid.revision}:${originSignature}`;
    if (el.dataset.vectoContentGrid !== signature) {
      const materializeStart = typeof performance !== 'undefined' ? performance.now() : 0;
      // Defer the selection decision until it is known which lines are rebuilt: a
      // selection sitting in an untouched line must survive, or streaming would
      // wipe it every frame.
      this.contentProjection.clearGridState(entityId, el, false);

      // Strip any direct TEXT-node children before building carriers.
      //
      // A block promoted from the coarse tier arrives holding exactly one text
      // node: the coarse branch projects the whole block as
      // `el.textContent = projection.text`. Everything below addresses carriers
      // through `el.children` and trims the tail with `lastElementChild`, both of
      // which are element-only views — so that text node is invisible to this
      // whole function and simply stays put, and `el.textContent` then reads the
      // block twice (probed: 78 chars for a 39-char source, exactly 2x).
      // Find-in-page matches the orphan at the wrong geometry, a screen reader
      // announces the block twice, and the dev-mode projection equality check
      // compares against a doubled string.
      //
      // The non-grid carrier branch never had this problem because it opens with
      // `el.replaceChildren()`. The grid path deliberately cannot do that — reuse
      // of unchanged carrier lines is what keeps streaming affordable — so it has
      // to remove the text nodes specifically, leaving element children alone.
      //
      // Guarded on there being a first child, so the steady state (streaming
      // append, scroll) pays one `firstChild` read and no DOM writes.
      if (el.firstChild !== null) {
        let scan: ChildNode | null = el.firstChild;
        let strippedSelection = false;
        while (scan !== null) {
          const next: ChildNode | null = scan.nextSibling;
          if (scan.nodeType === 3 /* Node.TEXT_NODE */) {
            // A selection anchored in the coarse text node cannot survive its
            // removal, so release it here rather than leaving a Range pointing at
            // a detached node. `selectionLine` below only ever sees carrier lines
            // (it looks for `data-vecto-grid-line`), so it cannot cover this.
            if (!strippedSelection) {
              strippedSelection = true;
              this.contentProjection.releaseSelectionForRebuild(el);
            }
            scan.remove();
          }
          scan = next;
        }
      }

      const projectionLines = projection.lines ?? [];
      const selectionLine = this.contentProjection.gridSelectionLine(el);
      let rebuiltSelectionLine = false;
      // Where the selection sits in `grid.source`, captured before any carrier is
      // touched. Restoring from this is what keeps a selection alive across a
      // reflow or a browser/DPR zoom, which rebuild EVERY line — the breaks moved —
      // while the selected characters stay on screen. `selectionLine` cannot help
      // there: it only says which carrier held the selection, and under a reflow
      // that line index no longer refers to the same text.
      const selectionSnapshot =
        selectionLine !== null ? this.contentProjection.snapshotGridSelection(el) : null;

      // A selection outside the new window loses its carrier either way: past the
      // end it is trimmed below, before the start it is overwritten by the
      // materialize loop, which reindexes `children[0..]` onto the new window.
      // Evaluated here rather than inside the trim loop because that loop runs
      // only when the window SHRANK — scrolling keeps the length identical, so a
      // start that moves past the selection took no path that noticed.
      if (
        selectionLine !== null &&
        (selectionLine < gridWindow.start || selectionLine >= gridWindow.end)
      ) {
        rebuiltSelectionLine = true;
      }

      // Reuse carrier lines that did not change.
      //
      // The old code called `el.replaceChildren()` and rebuilt one `<span>` per
      // cell on every revision bump. Streaming text bumps the revision on every
      // append, so a growing code block re-created its whole carrier grid each
      // frame — about 8,200 `createElement` calls per frame for a 200x40 block,
      // measured as 898-1431 ms of `gridMaterialize` (53% of `a11ySync` on Chrome,
      // 79% on Firefox) while a streamed block dropped a third of its input.
      //
      // Appending text leaves every earlier line byte-identical, so each line
      // carries a signature of everything that determines its DOM and is rebuilt
      // only when that changes. This mirrors the line-prefix reuse already in
      // `CodeBlock.buildLines` (#232) — same insight, one layer further out.
      const existingLines = el.children;
      for (let lineIndex = gridWindow.start; lineIndex < gridWindow.end; lineIndex++) {
        // Children hold only the window, so a line's DOM slot is its offset from
        // the window start, not its document index.
        const domIndex = lineIndex - gridWindow.start;
        const gridLine = grid.lines[lineIndex];
        const projectedLine = projectionLines[lineIndex];
        const lineHeight = projectedLine?.lineHeight ?? grid.lineHeight;
        const baseline = projectedLine?.baseline ?? grid.baseline;
        const lineFont = projectedLine?.font ?? grid.font;

        const lineSignature = contentGridLineSignature(
          grid,
          gridLine,
          projectedLine,
          lineHeight,
          baseline,
          lineFont,
          lineIndex === 0,
        );
        const reusable = existingLines[domIndex] as HTMLElement | undefined;
        if (
          reusable !== undefined &&
          reusable.dataset.vectoGridLineSig === lineSignature &&
          reusable.dataset.vectoGridLine === `${lineIndex}`
        ) {
          continue;
        }

        if (selectionLine !== null && selectionLine === lineIndex) rebuiltSelectionLine = true;

        const lineElement = document.createElement('span');
        lineElement.dataset.vectoGridLineSig = lineSignature;
        // The prepared grid already resolved bidi x coordinates. Keep carrier
        // flow logical/LTR so the browser does not reorder it a second time.
        lineElement.dir = 'ltr';
        lineElement.dataset.vectoGridLine = `${lineIndex}`;
        lineElement.style.position = 'absolute';
        lineElement.style.left = `${projectedLine?.x ?? 0}px`;
        lineElement.style.top = `${
          (projectedLine?.y ?? lineIndex * grid.lineHeight) +
          baseline -
          cssLineBoxBaseline(lineFont, lineHeight)
        }px`;
        lineElement.style.width = `${gridLine.width}px`;
        lineElement.style.height = `${lineHeight}px`;
        lineElement.style.whiteSpace = 'pre';
        lineElement.style.font = lineFont;
        lineElement.style.lineHeight = `${lineHeight}px`;

        const breakText = grid.source.slice(gridLine.sourceEnd, gridLine.nextSourceStart);
        if (gridLine.cells.length === 0) {
          // An empty line is nothing BUT its break, so this is the row where the
          // painted bar was most visible: one zero-width, full-height selection
          // rect and no glyph anywhere near it.
          appendContentBreak(lineElement, breakText);
        } else {
          let logicalX = 0;
          for (let cellIndex = 0; cellIndex < gridLine.cells.length; cellIndex++) {
            const cell = gridLine.cells[cellIndex];
            const cellElement = document.createElement('span');
            cellElement.dir = 'ltr';
            const sourceText = grid.source.slice(cell.sourceStart, cell.sourceEnd);
            cellElement.textContent = sourceText;
            cellElement.dataset.vectoGridCell = `${cellIndex}`;
            cellElement.dataset.vectoGridSourceLength = `${sourceText.length}`;
            cellElement.dataset.vectoGridSourceStart = `${cell.sourceStart}`;
            cellElement.dataset.vectoGridSourceEnd = `${cell.sourceEnd}`;
            cellElement.dataset.vectoGridCaretOffsets = cell.sourceCaretOffsets.join(',');
            cellElement.dataset.vectoGridLevel = `${cell.level}`;
            cellElement.dataset.vectoGridAdvance = `${cell.advance}`;
            cellElement.dataset.vectoGridX = `${cell.x}`;
            // Stay in one logical inline flow so Firefox copy/find does not
            // synthesize a newline between carriers. Relative offsets encode
            // bidi visual order without changing DOM source order.
            cellElement.style.position = 'relative';
            cellElement.style.display = 'inline-block';
            cellElement.style.left = `${cell.x - logicalX}px`;
            cellElement.style.top = '0';
            cellElement.style.width = `${cell.advance}px`;
            cellElement.style.height = `${lineHeight}px`;
            cellElement.style.boxSizing = 'border-box';
            cellElement.style.verticalAlign = 'top';
            cellElement.style.whiteSpace = 'pre';
            cellElement.style.font = lineFont;
            cellElement.style.lineHeight = `${lineHeight}px`;
            cellElement.style.transformOrigin = '0 50%';
            // Mirror the font onto data attributes so calibration can read it back
            // without touching `style.font`, whose shorthand getter Chrome
            // re-serializes on every access (measured 99.3% of the calibration pass).
            cellElement.dataset.vectoGridFont = lineFont;
            cellElement.dataset.vectoGridLineHeight = `${lineHeight}px`;
            lineElement.appendChild(cellElement);
            logicalX += cell.advance;
          }
          // After the last cell, not inside it. Appending the break to a cell's
          // own text would put it inside a box the calibration pass measures and
          // `vectoGridSourceLength` slices, so the break has to be its own
          // carrier for the cell geometry to stay exactly one cluster wide.
          appendContentBreak(lineElement, breakText);
        }
        if (lineIndex === 0) {
          for (const [basis, left, top] of [
            ['origin', 0, 0],
            ['x', 1, 0],
            ['y', 0, 1],
          ] as const) {
            const marker = document.createElement('span');
            marker.dataset.vectoGridBasis = basis;
            marker.setAttribute('aria-hidden', 'true');
            marker.style.position = 'absolute';
            marker.style.left = `${left}px`;
            marker.style.top = `${top}px`;
            marker.style.width = '0';
            marker.style.height = '0';
            marker.style.pointerEvents = 'none';
            marker.style.userSelect = 'none';
            lineElement.appendChild(marker);
          }
        }
        // Replace in place when a line already occupies this index, so untouched
        // neighbours keep their identity (and any live selection anchored in them).
        const occupant = el.children[domIndex];
        if (occupant) el.replaceChild(lineElement, occupant);
        else el.appendChild(lineElement);
      }
      // Drop carriers past the end: the grid can shrink (an edit, a re-highlight),
      // and stale lines would otherwise stay visible to a screen reader and to
      // copy/find.
      const windowLength = gridWindow.end - gridWindow.start;
      while (el.children.length > windowLength) {
        el.lastElementChild?.remove();
      }
      // Only now touch the selection, and only if the line holding it was actually
      // replaced. A selection in a reused line keeps its DOM nodes and stays live.
      //
      // Re-anchor rather than release. The replaced-line case covers two very
      // different events: a reflow or zoom, where the same characters are still
      // projected under new line breaks and the selection should survive; and a
      // scroll that carried them out of the window, where there is nothing left to
      // point at. Source offsets tell the two apart, and `restoreGridSelection`
      // falls back to releasing when the offsets no longer resolve.
      if (rebuiltSelectionLine) {
        this.contentProjection.restoreGridSelection(el, selectionSnapshot);
      }
      el.dataset.vectoProjectionLines = signature;
      el.dataset.vectoContentGrid = signature;
      if (gridWindow.gated) {
        el.dataset.vectoProjectionWindow = `${gridWindow.start}-${gridWindow.end}/${grid.lines.length}`;
      } else {
        delete el.dataset.vectoProjectionWindow;
      }
      el.dataset.vectoGridCarriers = `${el.querySelectorAll('[data-vecto-grid-cell]').length}`;
      if (typeof performance !== 'undefined') {
        const materializeMs = performance.now() - materializeStart;
        el.dataset.vectoGridMaterializeMs = `${materializeMs}`;
        if (this.phases.enabled) this.phases.record('gridMaterialize', materializeMs);
      }
      delete el.dataset.vectoGridCalibration;
      delete el.dataset.vectoGridReady;
    }

    const calibrationKey = `${signature}:${fontEpoch}:${pageScaleX.toFixed(4)}`;
    if (el.dataset.vectoGridCalibration !== calibrationKey) {
      const calibStart = this.phases.enabled ? performance.now() : 0;
      this.contentProjection.scheduleGridCalibration(
        entityId,
        el,
        calibrationKey,
        pageScaleX,
        fontEpoch,
      );
      if (this.phases.enabled) {
        this.phases.record('gridCalibrateSchedule', performance.now() - calibStart);
      }
    }
  }
}

// --- domain: content-projection — grid line signature ---
/**
 * A digest of everything about one grid line that determines its projected DOM.
 *
 * Used to skip rebuilding carrier lines that did not change. Streaming text bumps
 * `grid.revision` on every append while leaving all earlier lines byte-identical,
 * so without this the projection re-creates one `<span>` per cell for the entire
 * block every frame.
 *
 * **Every field the projection reads must appear here.** A missing field means a
 * stale carrier is served: geometry drifts from the canvas, and DOM Range offsets
 * stop matching the source, which breaks selection and screen-reader position
 * rather than merely looking wrong. The corresponding writes live in
 * `syncContentGridProjection`; keep the two in step.
 */
function contentGridLineSignature(
  grid: PreparedContentGrid,
  line: PreparedContentGridLine,
  projected: ContentProjectionLine | undefined,
  lineHeight: number,
  baseline: number,
  font: string,
  isFirstLine: boolean,
): string {
  const parts: string[] = [
    // Line box: position, size, and the font that resolves its baseline.
    `${projected?.x ?? 0}`,
    `${projected?.y ?? ''}`,
    `${lineHeight}`,
    `${baseline}`,
    font,
    `${line.width}`,
    // The trailing hard break belongs to this line and lands in the DOM text.
    grid.source.slice(line.sourceEnd, line.nextSourceStart),
    // The basis markers are appended only to line 0, so a line moving to or from
    // index 0 changes its DOM even when nothing else does.
    isFirstLine ? '1' : '0',
  ];
  if (line.cells.length === 0) {
    // An empty line projects its break text directly, with no cell carriers.
    parts.push('empty');
  } else {
    for (const cell of line.cells) {
      parts.push(
        `${cell.sourceStart}`,
        `${cell.sourceEnd}`,
        `${cell.x}`,
        `${cell.advance}`,
        `${cell.level}`,
        cell.sourceCaretOffsets.join('.'),
        // Source text, not `cell.glyph`: the carrier holds the original characters
        // (the shaped glyph is the canvas's business), so a change in shaping alone
        // must not invalidate a carrier, and a change in source must.
        grid.source.slice(cell.sourceStart, cell.sourceEnd),
      );
    }
  }
  return parts.join('\u0001');
}
