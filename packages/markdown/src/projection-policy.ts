import { Entity } from '@vectojs/core';
import { CodeBlock } from './markdown-code';
import { RichText, Stack, Table, Text } from '@vectojs/ui';

/**
 * Markdown projection-policy switcher (RFC4 §6 dogfood, CTX-0601).
 *
 * Assigns the per-block `domPolicy`/`domKind` the capability negotiation
 * (`Scene.resolveProjectionFor`) consumes. DOM-free plain data only: this
 * module never creates an element — the `'prose'`/`'code'` kind specs that
 * materialize blocks live with the backend (the dogfood page registers them
 * on `DOMProjection`; custom backends register their own).
 *
 * Block → kind mapping (the §4 matrix in Markdown terms):
 *
 * - ui `Text` / `RichText` (headings, paragraphs) → `'prose'`:
 *   long/selectable text whose native value (selection, Ctrl+F, translation)
 *   outweighs DOM cost, so `'auto'` resolves `dom`.
 * - `CodeBlock` → `'code'`: selectable source text; `'auto'` rests on
 *   `canvas` (row default) until measured, explicit `'dom'` materializes it.
 * - `Table` → `''` (unsupported-kind): composite interactive widget, stays
 *   canvas with a reported reason.
 * - Grouping wrappers (children present, no specific class) → `'container'`:
 *   never materialized itself; the pass recurses into its children so nested
 *   prose/code negotiates individually (r8, CTX-0608).
 * - Anything else (rules, borders, backgrounds) → `''`: canvas leaves.
 *
 * Tables stay canvas even when nested inside a container (composite widget,
 * cell text included). Grouping wrappers below the top level keep `domKind`
 * `''` (reported fallback) — only nested prose/code leaves are tagged.
 */

/** Dogfood switcher mode (RFC4 §6): forced canvas, forced dom, or negotiated. */
export type MarkdownProjectionMode = 'canvas' | 'dom' | 'hybrid';

/** One top-level document block with its negotiation kind. */
export interface ClassifiedProjectionBlock {
  node: Entity;
  /** Stable human label for readouts (`index: Class (role)`). */
  label: string;
  /** `domKind` for negotiation; `''` means canvas-only (reported fallback). */
  domKind: string;
}

/** Classify one top-level block (see module doc for the mapping). */
export function classifyProjectionBlock(node: Entity, index: number): ClassifiedProjectionBlock {
  if (node instanceof Text || node instanceof RichText) {
    return { node, label: `${index}: ${node.constructor.name} (prose)`, domKind: 'prose' };
  }
  if (node instanceof CodeBlock) return { node, label: `${index}: CodeBlock`, domKind: 'code' };
  if (node instanceof Table) return { node, label: `${index}: Table`, domKind: '' };
  if (node.children.length > 0) {
    return { node, label: `${index}: ${node.constructor.name} (container)`, domKind: 'container' };
  }
  return { node, label: `${index}: ${node.constructor.name} (canvas leaf)`, domKind: '' };
}

/**
 * Tag prose/code nested inside a container block (blockquote, list, …) so it
 * negotiates on its own in hybrid/dom modes. Same mapping as
 * {@link classifyProjectionBlock}; tables are skipped wholesale (composite
 * widget, cell text included) and canvas leaves keep `domKind ''`.
 */
function classifyNestedChildren(node: Entity): void {
  for (const child of node.children) {
    if (child instanceof Text || child instanceof RichText) {
      child.domKind = 'prose';
    } else if (child instanceof CodeBlock) {
      // An affordance-wrapped code block classifies as a container up top;
      // tagging the inner block here keeps it negotiable (cf. #701).
      child.domKind = 'code';
    } else if (child instanceof Table) {
      // Composite interactive widget: stays canvas, cell text included.
    } else if (child.children.length > 0) {
      classifyNestedChildren(child);
    }
    // Canvas leaves (rules, borders, backgrounds) keep `domKind ''`.
  }
}

/**
 * Top-level blocks of a document's content stack, in order, with kinds
 * assigned onto the blocks (idempotent — re-running keeps prior kinds).
 * Container blocks additionally have their nested prose/code tagged via
 * {@link classifyNestedChildren} (idempotent for the same reason).
 */
export function classifyProjectionBlocks(content: Stack): ClassifiedProjectionBlock[] {
  const blocks = content.children.map((child, i) => classifyProjectionBlock(child, i));
  for (const { node, domKind } of blocks) {
    if (domKind) node.domKind = domKind;
    if (domKind === 'container') classifyNestedChildren(node);
  }
  return blocks;
}

/**
 * Apply a switcher mode to a whole Markdown subtree (kinds must already be
 * assigned via {@link classifyProjectionBlocks} or by hand):
 *
 * - `'canvas'` — every node `'canvas'`: byte-identical to today.
 * - `'dom'` — `'dom'` where the node has a materializable kind
 *   (`'prose'`/`'code'`), `'canvas'` elsewhere (tables, figures, chrome).
 * - `'hybrid'` — every node `'auto'`: the engine negotiates per block.
 */
export function applyProjectionMode(root: Entity, mode: MarkdownProjectionMode): void {
  const visit = (node: Entity): void => {
    if (mode === 'canvas') node.domPolicy = 'canvas';
    else if (mode === 'dom') {
      node.domPolicy = node.domKind === 'prose' || node.domKind === 'code' ? 'dom' : 'canvas';
    } else {
      node.domPolicy = 'auto';
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
}
