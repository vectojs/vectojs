/**
 * Which projected lines a content block materializes for a given visible band.
 *
 * Extracted as a **shared module** rather than onto a collaborator because both
 * sides of the grid cut need it. `Scene.syncContentProjection` calls
 * {@link projectionLineWindow} for the plain carrier branch and stays on the
 * facade; {@link ContentGridProjector} calls {@link projectionGridLineWindow} for
 * the grid branch and has moved. Duplicating the scan would let the two branches
 * disagree about which lines are present, and a window that disagrees with the
 * carriers it drives serves stale geometry to selection and find-in-page.
 *
 * This is the `content-caret` precedent from `DEC-0022`: a stateless helper that
 * outlived the class it was private to.
 *
 * Every symbol here was module-private in `Scene.ts` and stays module-private to
 * the package. The core barrel re-exports everything from `./tree/Scene`, so
 * re-exporting from there would silently widen the public API (`DEC-0019` rule 3).
 *
 * Stateless by design — no `Scene`, no entities, no DOM.
 */

import type { PreparedContentGrid } from '@vectojs/text';
import type { ContentProjection } from '../Entity';

/** Half-open range of projected line indices to materialize. */
export interface ProjectionLineWindow {
  start: number;
  /** Exclusive. */
  end: number;
  /** False when the whole document is being projected. */
  gated: boolean;
}

/**
 * The contiguous run of lines overlapping `band`, in entity-local y.
 *
 * **Contiguous on purpose.** A gap would break selection: the DOM order of
 * carriers is what the browser walks when extending a selection or serialising
 * a copy, so materializing lines 0-9 and 90-99 with nothing between them would
 * let a drag from line 5 to line 95 silently splice out 80 lines of text. A
 * single window can only lose text at its *edges*, where the user cannot reach
 * without scrolling, and scrolling rebuilds the window.
 *
 * Falls back to the whole document whenever the answer is not clearly better:
 * a null band, a document that fits, or a window that would cover everything
 * anyway. Emitting nothing is never correct — projected text is what serves
 * find-in-page, copy and, for static text, the screen reader.
 */
export function projectionLineWindow(
  lines: ReadonlyArray<{ y: number; lineHeight?: number }>,
  band: { minY: number; maxY: number } | null,
  fallbackLineHeight: number,
): ProjectionLineWindow {
  const all: ProjectionLineWindow = {
    start: 0,
    end: lines.length,
    gated: false,
  };
  if (!band || lines.length === 0) return all;

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.lineHeight ?? fallbackLineHeight;
    // A line counts as visible when its box overlaps the band at all, so a line
    // straddling the edge is kept rather than clipped mid-glyph.
    if (line.y + h >= band.minY && line.y <= band.maxY) {
      if (start === -1) start = i;
      end = i + 1;
    } else if (start !== -1 && line.y > band.maxY) {
      // Lines are emitted in document order, so once past the band we are done.
      // Guard on `start` first: a document whose first line is already past the
      // band must keep scanning, not stop at index 0.
      break;
    }
  }

  if (start === -1) {
    // Nothing overlapped. Rather than project nothing, keep the single nearest
    // line so the entity still has a non-empty projection and the text stays
    // reachable.
    //
    // This is now only reachable for an entity the caller has already decided is
    // in the interaction band — a partially-overlapping box whose own lines all
    // miss the band. A FULLY off-band entity does not arrive here at all: it is
    // either released by the semantic gate or routed to the coarse plain-text
    // tier, which is why this fallback no longer needs to be the thing that keeps
    // its text reachable. Before the semantic/interaction split it was, because a
    // surviving entity was by definition in the one band there was.
    return { start: 0, end: Math.min(1, lines.length), gated: true };
  }
  if (start === 0 && end === lines.length) return all;
  return { start, end, gated: true };
}

/**
 * {@link projectionLineWindow} for a prepared grid.
 *
 * A grid line's y comes from the parallel `projection.lines` entry when present
 * and otherwise from `lineIndex * grid.lineHeight`, which is the same fallback
 * the materialization loop uses for positioning — so the window and the carriers
 * always agree on where a line is.
 */
export function projectionGridLineWindow(
  grid: PreparedContentGrid,
  projectionLines: ContentProjection['lines'],
  band: { minY: number; maxY: number } | null,
): ProjectionLineWindow {
  const count = grid.lines.length;
  const all: ProjectionLineWindow = { start: 0, end: count, gated: false };
  if (!band || count === 0) return all;
  const lines: Array<{ y: number; lineHeight?: number }> = [];
  for (let i = 0; i < count; i++) {
    const projected = projectionLines?.[i];
    lines.push({
      y: projected?.y ?? i * grid.lineHeight,
      lineHeight: projected?.lineHeight ?? grid.lineHeight,
    });
  }
  return projectionLineWindow(lines, band, grid.lineHeight);
}
