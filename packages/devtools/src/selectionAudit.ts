import type { ContentProjectionLine, Entity, Scene } from '@vectojs/core';
import { entityPath } from './inspect';

/**
 * Selection-overlap audit: does the transparent DOM content projection (what the
 * browser lets the user drag-select and copy) sit on top of the glyphs the
 * canvas actually drew? When it drifts — the classic failure modes are justified
 * lines (widened inter-word gaps), RTL/bidi (visual reorder + right-align), and
 * fractional DPR/zoom rounding — the highlight slides off the text and copy
 * lands on the wrong characters.
 *
 * Unlike a screenshot diff this runs browser-side against AUTHORITATIVE geometry:
 * the expected extent comes from the entity's own {@link ContentProjection} line
 * coordinates (the same numbers the renderer draws from), and the actual extent
 * from the live DOM `Range.getClientRects()`. Both are mapped into the entity's
 * local logical space so the comparison is DPR/zoom-independent. It needs a real
 * browser (layout + Range geometry), so it is a devtools/QA audit, not a unit
 * test — pair it with the `scripts/selection-harness` driver for cross-engine,
 * multi-DPR runs.
 */
export interface SelectionAuditFinding {
  kind: 'selection-drift';
  entityId: string;
  entityPath: string;
  /** Visual line index within the entity's projection. */
  line: number;
  /** Left/right edges in the entity's LOCAL logical px. */
  expectedLeft: number;
  expectedRight: number;
  actualLeft: number;
  actualRight: number;
  /** |actual − expected| at each edge, local logical px. */
  leftDrift: number;
  rightDrift: number;
  message: string;
}

export interface SelectionAuditOptions {
  /** Per-edge drift (local px) at or below which a line is considered aligned.
   *  Default 2 — the sub-pixel rounding floor. The right edge legitimately
   *  accumulates a browser-kerned-vs-canvas-advance delta, so callers checking
   *  whole lines may prefer {@link rightTolerance}. */
  tolerance?: number;
  /** Separate, looser tolerance for the right edge only (kerning/advance drift
   *  grows with line length + fractional zoom). Defaults to {@link tolerance}. */
  rightTolerance?: number;
  /** Restrict to these entity ids (default: every selectable projection). */
  entityIds?: string[];
}

/** Right edge (max x + width) a projected line's own geometry implies, local px. */
function expectedLineExtent(line: ContentProjectionLine): {
  left: number;
  right: number;
} {
  const runs = line.runs;
  if (runs && runs.some((r) => r.x !== undefined)) {
    let left = Infinity;
    let right = -Infinity;
    for (const r of runs) {
      if (r.x === undefined) continue;
      left = Math.min(left, r.x);
      right = Math.max(right, r.x + (r.width ?? 0));
    }
    if (left !== Infinity) return { left, right };
  }
  // No positioned runs: the line box starts at its own x. Its right edge is not
  // known from geometry alone (natural-flow text), so the caller compares the
  // left origin only (right stays NaN → skipped).
  return { left: line.x, right: Number.NaN };
}

/**
 * Audit selection overlap for one entity. Returns a finding per line whose DOM
 * selection box drifts from the projection geometry beyond tolerance. Needs the
 * live DOM (`scene.getContentElement`), so it is a no-op when the entity has no
 * materialized, selectable projection.
 */
export function auditEntitySelection(
  scene: Scene,
  entity: Entity,
  opts: SelectionAuditOptions = {},
): SelectionAuditFinding[] {
  const proj = entity.getContentProjection?.();
  if (!proj?.lines || proj.selectable === false) return [];
  const root = scene.getContentElement(entity.id);
  if (!root) return [];
  const lineEls = [...root.children] as HTMLElement[];
  if (lineEls.length === 0) return [];

  const tol = opts.tolerance ?? 2;
  const rightTol = opts.rightTolerance ?? tol;
  const rootRect = root.getBoundingClientRect();
  // Client px per local logical px: the content root is sized in logical px and
  // the browser scales it by DPR/zoom, so this factor removes both.
  const rootLogicalWidth = entity.width || rootRect.width;
  const scale = rootRect.width > 0 && rootLogicalWidth > 0 ? rootRect.width / rootLogicalWidth : 1;
  const toLocal = (clientX: number): number => (clientX - rootRect.left) / scale + 0;

  const findings: SelectionAuditFinding[] = [];
  const sel = typeof getSelection === 'function' ? getSelection() : null;

  for (let i = 0; i < proj.lines.length && i < lineEls.length; i++) {
    const line = proj.lines[i];
    const el = lineEls[i];
    const expected = expectedLineExtent(line);

    const range = document.createRange();
    range.selectNodeContents(el);
    let cl = Infinity;
    let cr = -Infinity;
    for (const r of range.getClientRects()) {
      cl = Math.min(cl, toLocal(r.left));
      cr = Math.max(cr, toLocal(r.right));
    }
    if (cl === Infinity) continue; // empty/hidden line

    const leftDrift = Math.abs(cl - expected.left);
    const rightDrift = Number.isNaN(expected.right) ? 0 : Math.abs(cr - expected.right);
    if (leftDrift > tol || rightDrift > rightTol) {
      findings.push({
        kind: 'selection-drift',
        entityId: entity.id,
        entityPath: entityPath(entity),
        line: i,
        expectedLeft: round2(expected.left),
        expectedRight: round2(expected.right),
        actualLeft: round2(cl),
        actualRight: round2(cr),
        leftDrift: round2(leftDrift),
        rightDrift: round2(rightDrift),
        message:
          `${entity.constructor.name} line ${i} selection ` +
          `drifts left ${round2(leftDrift)}px` +
          (Number.isNaN(expected.right) ? '' : `, right ${round2(rightDrift)}px`),
      });
    }
  }

  // Leave no lingering programmatic selection behind.
  sel?.removeAllRanges();
  return findings;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Audit selection overlap across every selectable projection in the scene (or a
 * subset via {@link SelectionAuditOptions.entityIds}). Empty array = every
 * selection box tracks its glyphs. JSON-safe + deterministically ordered, so it
 * doubles as a CI/QA gate when driven on a real browser.
 */
export function auditSceneSelection(
  scene: Scene,
  opts: SelectionAuditOptions = {},
): SelectionAuditFinding[] {
  const wanted = opts.entityIds ? new Set(opts.entityIds) : null;
  const findings: SelectionAuditFinding[] = [];
  const walk = (entity: Entity): void => {
    if (!wanted || wanted.has(entity.id)) {
      findings.push(...auditEntitySelection(scene, entity, opts));
    }
    for (const child of entity.children) walk(child);
  };
  walk(scene.rootEntity);
  findings.sort((a, b) =>
    a.entityPath !== b.entityPath ? a.entityPath.localeCompare(b.entityPath) : a.line - b.line,
  );
  return findings;
}
