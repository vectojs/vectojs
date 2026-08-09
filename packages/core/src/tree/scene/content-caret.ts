/**
 * Caret addressing inside a content projection: the shared vocabulary for
 * describing "this exact position in this projected text".
 *
 * Extracted as a **shared module** rather than as part of any one collaborator
 * because both sides of the extraction-3 cut need it. The selection-preservation
 * pass that moves to {@link ContentSelectionManager} converts a live `Selection`
 * endpoint into a linear character offset and back, while the pointer-to-caret
 * resolution that stays in `Scene.ts` (`nearestTextPositionInProjection` and its
 * per-line helpers) builds the same positions from hit coordinates. Duplicating
 * the offset walk in both places would let the two drift, and a caret that
 * disagrees with the offset it was derived from restores a selection to the wrong
 * text.
 *
 * Every symbol here was module-private in `Scene.ts` and stays module-private to
 * the package: `packages/core/src/index.ts` is `export * from './tree/Scene'`, so
 * re-exporting would silently widen the public API. `DEC-0019` rule 3.
 *
 * Stateless and DOM-only by design — no `Scene`, no entities, no engine state.
 */

/** A concrete text caret position, usable as a Selection anchor or focus. */
export interface TextCaretPosition {
  node: Text;
  offset: number;
}

export function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function projectionAbsoluteOffset(
  root: HTMLElement,
  caret: TextCaretPosition,
): number | null {
  let offset = 0;
  for (const node of collectTextNodes(root)) {
    if (node === caret.node) return offset + Math.min(caret.offset, node.data.length);
    offset += node.data.length;
  }
  return null;
}

export function projectionCaretAt(
  root: HTMLElement,
  absoluteOffset: number,
  affinity: 'forward' | 'backward',
): TextCaretPosition | null {
  const nodes = collectTextNodes(root);
  if (nodes.length === 0) return null;
  let remaining = Math.max(0, absoluteOffset);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (
      remaining < node.data.length ||
      (remaining === node.data.length && affinity === 'backward')
    ) {
      return { node, offset: remaining };
    }
    if (remaining === node.data.length && index === nodes.length - 1) {
      return { node, offset: remaining };
    }
    remaining -= node.data.length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}
