import type { InlineObjectBox, InlineObjectSurface } from '@vectojs/core';
import type { Token, Tokens } from 'marked';
import type { ImageSource } from '@vectojs/ui';

/** Resolve a markdown image `src` to a generic {@link ImageSource}. */
export type MarkdownImageResolver = (src: string) => ImageSource | Promise<ImageSource>;

/** Default resolver — identity mapping to `{kind:'url'}`. */
export const defaultMarkdownImageResolver: MarkdownImageResolver = (src) => ({
  kind: 'url',
  url: src,
});

/**
 * Image predicates over a `marked` token tree, plus the raster store for images
 * that render *inline* rather than as their own block.
 *
 * Still a leaf — it imports no other module of this package, so nothing here has
 * an edge back into `Markdown.ts`. The predicates are pure; the raster store below
 * is not, and is here rather than in `markdown-inline.ts` so that everything
 * deciding how an image reaches the screen lives in one file. The predicates are
 * kept together because they decide, between them, whether a paragraph renders as
 * one `RichText` or as a `Stack` of runs and images — a disagreement among them
 * silently drops a picture. See
 * `forge/decisions/file-decomposition-2026-08.md`.
 */

/**
 * Whether a paragraph renders as a `Stack` of runs and images rather than one
 * `RichText`.
 *
 * The same test the `paragraph` render arm uses, so the reconciler and the
 * renderer cannot disagree about which shape a token produces.
 *
 * The search is over **descendants, not direct children**. `marked` nests an
 * image as deeply as the source does — `[![a](u)](dest)` is
 * `paragraph > link > image` and `- item ![a](u)` is
 * `list_item > text > [text, image]` — so a direct-children test failed every
 * nested form, sent the run to `inlineRunRichText`, which has no image support,
 * and dropped the image with no warning. Recursing costs one walk of an inline
 * run and removes the whole class rather than the two shapes that were reported.
 */
export function paragraphHasImage(token: Tokens.Paragraph): boolean {
  return containsImage(token.tokens);
}

/**
 * Whether any token in this inline run, at any depth, is an image.
 *
 * The one place the question is answered, so the predicate above, the list-item
 * tier check and the flattening the render arms do cannot drift apart.
 */
export function containsImage(tokens: Token[] | undefined): boolean {
  if (!tokens) return false;
  for (const token of tokens) {
    if (token.type === 'image') return true;
    const anyToken = token as Tokens.Generic;
    if (containsImage(anyToken.tokens as Token[] | undefined)) return true;
    // `list` holds its items in `items`, and `table` its cells in `header`/`rows` —
    // neither has a `.tokens` array at all, so a walk over `.tokens` alone reports
    // FALSE for an image inside either. Measured: `containsImage` returned false for
    // both `| h |\n| --- |\n| ![a](u) |` and `- item ![a](u)`.
    //
    // Harmless for the paragraph-splitting callers, which are only ever handed a
    // paragraph's or a list item's own inline run. Not harmless for the caller that
    // asks whether a whole BLOCK contains an image, which is how a table cell's
    // inline image never subscribed to its own decode and kept the square box it
    // reserved before knowing its aspect ratio. `containsInlineMath` in
    // `markdown-math.ts` already walks all three shapes for the same reason.
    if (Array.isArray(anyToken.items) && containsImage(anyToken.items as Token[])) {
      return true;
    }
    const table = token as Tokens.Table;
    if (Array.isArray(table.header) && table.header.some((cell) => containsImage(cell.tokens))) {
      return true;
    }
    if (
      Array.isArray(table.rows) &&
      table.rows.some((row) => row.some((cell) => containsImage(cell.tokens)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every image in an inline run, at any depth, in source order.
 *
 * Pairs with `stripImages`: together they partition a run into the prose a
 * `RichText` can render and the images it cannot.
 */
export function imagesOf(tokens: Token[] | undefined): Tokens.Image[] {
  const images: Tokens.Image[] = [];
  for (const token of tokens ?? []) {
    if (token.type === 'image') {
      images.push(token as Tokens.Image);
      continue;
    }
    images.push(...imagesOf((token as Tokens.Generic).tokens as Token[] | undefined));
  }
  return images;
}

/**
 * The same token with every nested image removed, prose intact.
 *
 * A wrapper that held only an image is dropped; one that also held text keeps the
 * text. Used for a list item's lead run, which must show its marker and its prose
 * while its images render as blocks beneath.
 */
export function stripImages<T extends Token>(token: T): T {
  const children = (token as Tokens.Generic).tokens as Token[] | undefined;
  if (!children) return token;
  const kept: Token[] = [];
  for (const child of children) {
    if (child.type === 'image') continue;
    const grandchildren = (child as Tokens.Generic).tokens as Token[] | undefined;
    if (grandchildren && containsImage(grandchildren)) {
      const stripped = stripImages(child);
      const remaining = (stripped as Tokens.Generic).tokens as Token[] | undefined;
      if (remaining && remaining.length > 0) kept.push(stripped);
      continue;
    }
    kept.push(child);
  }
  return { ...token, tokens: kept };
}

/**
 * An inline run with nested images lifted to the top level, in source order.
 *
 * The paragraph arm splits a run into one `Stack` child per image plus one per
 * maximal run of non-image tokens, which requires every image to be a direct
 * member of the array it iterates. An image inside a link or an emphasis is not,
 * so the run is flattened first.
 *
 * A wrapper is replaced by its children rather than dropped, so the text inside a
 * link that also holds an image survives. Only wrappers **containing** an image
 * are opened: a plain link keeps its own token, and therefore keeps the styling
 * and click handling `renderInlineToRichText` gives it.
 */
export function liftNestedImages(tokens: Token[]): Token[] {
  const lifted: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'image') {
      lifted.push(token);
      continue;
    }
    const children = (token as Tokens.Generic).tokens as Token[] | undefined;
    if (children && containsImage(children)) {
      lifted.push(...liftNestedImages(children));
      continue;
    }
    lifted.push(token);
  }
  return lifted;
}

/** Index of the last `image` token in an inline run, or -1 if there is none. */
export function lastIndexOfImage(tokens: Token[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === 'image') return i;
  }
  return -1;
}

/**
 * A decoding raster for one inline image, keyed by URL.
 *
 * Separate from the paragraph path's `Image` entity, which owns its own bitmap and
 * resizes itself in `onLoad`. An inline image cannot do that: it is an
 * `InlineObject`, and the box it occupies is fixed when the span is collected, so
 * the natural size has to be readable from here before the next layout rather than
 * applied to an entity afterwards.
 *
 * Supports generic {@link ImageSource}: `url` decodes via `HTMLImageElement`,
 * `blob` via `createImageBitmap` (with object-URL fallback), and `bitmap` is used
 * directly. The backing `source` is the `CanvasImageSource` drawn by
 * `paintInlineImage`; `bitmap` is retained as a legacy alias for `url` rasters so
 * existing tests that reach through `raster.bitmap` keep working.
 */
export interface InlineImageRaster {
  /** `undefined` when this environment has no `Image` (SSR, plain unit tests). */
  bitmap?: HTMLImageElement;
  /** Generic backing source for `IRenderer.drawImage` / `InlineObjectSurface`. */
  source?: CanvasImageSource;
  decoded: boolean;
  /** Natural size, known only once decoded. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Set when the decode failed, so a broken URL is not retried every frame. */
  failed?: boolean;
  /** Release `ImageBitmap` / revoke `blob:` URL when evicted or cleared. */
  dispose?: () => void;
}

const inlineImageRasters = new Map<string, InlineImageRaster>();

/**
 * Upper bound on {@link inlineImageRasters}. A decoded bitmap costs its decoded
 * pixels in memory, and a long-lived page rendering many documents with distinct
 * image URLs (a streamed chat or feed) once grew this map without limit while
 * the inline-math twin capped at 256 — the same defect, fixed the same way.
 */
const INLINE_IMAGE_RASTER_LIMIT = 256;

/**
 * Called after an inline image decodes, so the owner can re-measure and repaint.
 *
 * Unlike inline math's equivalent, a notified owner may need a full
 * `retypesetFromTokens` rather than only a repaint: the decode is what reveals the
 * aspect ratio, and the reserved width is computed from it. The subscriber decides
 * which, since only it knows whether any of its own spans changed size.
 */
const inlineImageRasterWaiters = new Set<() => void>();

/** Subscribe `notify` to inline-image decodes. Idempotent per closure. */
export function subscribeInlineImageRaster(notify: () => void): void {
  inlineImageRasterWaiters.add(notify);
}

/**
 * Unsubscribe `notify`.
 *
 * Must be called on teardown: the set is module-level and lives as long as the
 * page, so a retained closure retains the whole entity tree that created it.
 */
export function unsubscribeInlineImageRaster(notify: () => void): void {
  inlineImageRasterWaiters.delete(notify);
}

function normalizeInlineSource(
  src: ImageSource,
):
  | { kind: 'url'; url: string }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bitmap'; bitmap: ImageBitmap } {
  if (typeof src === 'string') return { kind: 'url', url: src };
  return src as
    | { kind: 'url'; url: string }
    | { kind: 'blob'; blob: Blob }
    | { kind: 'bitmap'; bitmap: ImageBitmap };
}

function notifyInlineWaiters(): void {
  for (const notify of inlineImageRasterWaiters) notify();
}

function decodeInlineSource(
  resolved: ImageSource,
  entry: InlineImageRaster,
  fallbackSrc: string,
): void {
  const norm = normalizeInlineSource(resolved);
  switch (norm.kind) {
    case 'bitmap': {
      const bmp = norm.bitmap;
      entry.source = bmp;
      // Keep bitmap legacy alias for completeness (tests may check)
      entry.decoded = true;
      entry.naturalWidth = bmp.width;
      entry.naturalHeight = bmp.height;
      // External ImageBitmap ownership stays with caller — do not close on dispose.
      // Defer notification so the caller that created this raster during
      // collectSpans (inside renderToken → renderMarkdown) finishes its
      // initial layout before a re-measure is considered. Without the defer,
      // a sync bitmap notifies while renderMarkdown is still iterating its
      // token list, and the re-measure's retypesetFromTokens clears and
      // re-adds the heading while the outer loop then adds it again,
      // duplicating the block.
      if (typeof queueMicrotask === 'function') queueMicrotask(notifyInlineWaiters);
      else Promise.resolve().then(notifyInlineWaiters);
      break;
    }
    case 'blob': {
      const blob = norm.blob;
      const gCreate = globalThis as unknown as {
        createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
      };
      if (typeof gCreate.createImageBitmap === 'function') {
        gCreate
          .createImageBitmap(blob)
          .then((bmp) => {
            entry.source = bmp;
            entry.decoded = true;
            entry.naturalWidth = bmp.width;
            entry.naturalHeight = bmp.height;
            entry.dispose = () => {
              try {
                bmp.close();
              } catch {}
            };
            notifyInlineWaiters();
          })
          .catch(() => {
            decodeBlobViaImageInline(blob, entry);
          });
      } else {
        decodeBlobViaImageInline(blob, entry);
      }
      break;
    }
    case 'url':
    default: {
      const url = norm.kind === 'url' ? norm.url : fallbackSrc;
      if (typeof globalThis.Image === 'undefined') return;
      const bitmap = new globalThis.Image();
      bitmap.onload = () => {
        entry.decoded = true;
        entry.naturalWidth = bitmap.naturalWidth || undefined;
        entry.naturalHeight = bitmap.naturalHeight || undefined;
        entry.source = bitmap;
        notifyInlineWaiters();
      };
      bitmap.onerror = () => {
        entry.failed = true;
        notifyInlineWaiters();
      };
      bitmap.src = url;
      entry.bitmap = bitmap;
      entry.source = bitmap;
      break;
    }
  }
}

function decodeBlobViaImageInline(blob: Blob, entry: InlineImageRaster): void {
  if (
    typeof globalThis.Image === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    entry.failed = true;
    notifyInlineWaiters();
    return;
  }
  const url = URL.createObjectURL(blob);
  let objectURL: string | null = url;
  entry.dispose = () => {
    if (objectURL) {
      try {
        URL.revokeObjectURL(objectURL);
      } catch {}
      objectURL = null;
    }
  };
  const img = new globalThis.Image();
  entry.bitmap = img;
  entry.source = img as unknown as CanvasImageSource;
  img.onload = () => {
    entry.decoded = true;
    entry.naturalWidth = (img as HTMLImageElement).naturalWidth || undefined;
    entry.naturalHeight = (img as HTMLImageElement).naturalHeight || undefined;
    entry.source = img as unknown as CanvasImageSource;
    // Keep object URL alive while image is decoded; revoke on dispose/eviction.
    notifyInlineWaiters();
  };
  img.onerror = () => {
    if (objectURL) {
      try {
        URL.revokeObjectURL(objectURL);
      } catch {}
      objectURL = null;
      entry.dispose = undefined;
    }
    entry.failed = true;
    notifyInlineWaiters();
  };
  img.src = url;
}

/**
 * Ensure the raster for `src` is decoding, and return it.
 *
 * Synchronous and idempotent: the span collector calls it while measuring and the
 * paint path calls it on every visible frame, and only the first call starts a
 * decode. Exported because the span collector needs the natural size to size its
 * box, which is the whole reason this store reports one.
 *
 * When a resolver is supplied, its result (which may be `blob` or `bitmap`) is
 * decoded instead of the raw `src` URL. Resolver may be async — the raster stays
 * square until the promise settles, then notifies waiters so the owner can
 * re-measure.
 */
export function ensureInlineImageRaster(
  src: string,
  resolver: MarkdownImageResolver = defaultMarkdownImageResolver,
): InlineImageRaster {
  const existing = inlineImageRasters.get(src);
  if (existing) {
    // Re-insert so Map iteration order is recency order: a raster that is
    // still being painted stays recent and is never the eviction candidate.
    inlineImageRasters.delete(src);
    inlineImageRasters.set(src, existing);
    return existing;
  }

  const entry: InlineImageRaster = { decoded: false };
  inlineImageRasters.set(src, entry);
  // Bound the map like `ensureInlineMathRaster` does: the evicted image
  // re-decodes on its next paint, which is one empty box for an image that
  // has not been painted recently.
  while (inlineImageRasters.size > INLINE_IMAGE_RASTER_LIMIT) {
    const oldest = inlineImageRasters.keys().next().value;
    if (oldest === undefined || oldest === src) break;
    const evicted = inlineImageRasters.get(oldest);
    try {
      evicted?.dispose?.();
    } catch {}
    inlineImageRasters.delete(oldest);
  }

  let resolved: ImageSource | Promise<ImageSource>;
  try {
    resolved = resolver(src);
  } catch (err) {
    console.warn('[Markdown] imageResolver threw for', src, err);
    resolved = { kind: 'url', url: src };
  }
  if (resolved instanceof Promise) {
    resolved
      .then((r) => decodeInlineSource(r, entry, src))
      .catch((err) => {
        console.warn('[Markdown] imageResolver rejected for', src, err);
        entry.failed = true;
        notifyInlineWaiters();
      });
  } else {
    decodeInlineSource(resolved, entry, src);
  }
  return entry;
}

/**
 * Paint one inline image into the box the layout engine reserved for it.
 *
 * Draws nothing until the raster decodes — one frame of empty box, then a repaint
 * through {@link inlineImageRasterWaiters}. Mirrors `paintInlineMath`; a
 * placeholder slab would flash a grey rectangle mid-sentence on every first paint.
 *
 * Supports generic {@link ImageSource} backing: `source` may be an `ImageBitmap`
 * or an `HTMLImageElement`.
 */
export function paintInlineImage(
  src: string,
  surface: InlineObjectSurface,
  box: InlineObjectBox,
): void {
  const raster = ensureInlineImageRaster(src);
  if (!raster.decoded) return;
  const backing = raster.source ?? raster.bitmap;
  if (!backing) return;
  surface.drawImage(backing as CanvasImageSource, box.x, box.y, box.width, box.height);
}

/** Drop every cached raster. Tests only — a decode is process-wide state. */
export function clearInlineImageRasters(): void {
  for (const r of inlineImageRasters.values()) {
    try {
      r.dispose?.();
    } catch {}
  }
  inlineImageRasters.clear();
}

/**
 * How many `Stack` children the paragraph render arm builds for an inline run.
 *
 * One child per image, plus one per *maximal run* of consecutive non-image
 * tokens — the arm merges those into a single `RichText` via `flushText`, so this
 * is not `tokens.length`. Kept in lockstep with that arm; it is what
 * `updateImageParagraph` checks to confirm the entity it was handed is the one
 * built for the old tokens.
 */
export function expectedImageParagraphChildren(tokens: Token[]): number {
  let children = 0;
  let inTextRun = false;
  // Counted over the same flattened run the arm iterates, or a paragraph whose
  // image is nested would be checked against a child count it never built.
  for (const token of liftNestedImages(tokens)) {
    if (token.type === 'image') {
      children++;
      inTextRun = false;
    } else if (!inTextRun) {
      children++;
      inTextRun = true;
    }
  }
  return children;
}
