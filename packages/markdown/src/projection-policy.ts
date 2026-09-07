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
 *   never materialized itself; children negotiate individually.
 * - Anything else (rules, borders, backgrounds) → `''`: canvas leaves.
 *
 * Kinds are assigned to top-level blocks only; nested content keeps its own
 * `domKind` (default `''` → canvas, reported) until a finer pass tags it.
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
 * Top-level blocks of a document's content stack, in order, with kinds
 * assigned onto the blocks (idempotent — re-running keeps prior kinds).
 */
export function classifyProjectionBlocks(content: Stack): ClassifiedProjectionBlock[] {
  const blocks = content.children.map((child, i) => classifyProjectionBlock(child, i));
  for (const { node, domKind } of blocks) {
    if (domKind) node.domKind = domKind;
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
