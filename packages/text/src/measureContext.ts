/**
 * The one rule this module exists to enforce: **measure where you paint.**
 *
 * A Canvas 2D context that is not in a document resolves generic CSS families
 * (`serif`, `monospace`, `sans-serif`) differently from the document's own style
 * context in Gecko, because the generic-to-real mapping lives in a per-language
 * font preference that is only reachable from a live style context. The engine
 * paints on a real attached canvas, so a detached measurer reports a different
 * font's advances than the ones being drawn.
 *
 * Measured on Firefox 153, `<html lang="zh">`, 240Hz/scale-1.6 host
 * (`window.devicePixelRatio` 1.5789), `measureText('MMMMMMMMMM')`:
 *
 * | font              | detached | attached | document layout |
 * | ----------------- | -------- | -------- | --------------- |
 * | `22px monospace`  | 109.737  | 131.579  | 132.000         |
 * | `22px serif`      | 109.737  | 205.526  | 206.333         |
 * | `22px sans-serif` | 177.895  | 177.895  | 178.667         |
 *
 * Note that detached `serif` and detached `monospace` return the *same* number:
 * both collapsed onto one hardcoded fallback, a 20% error on `monospace` and
 * 47% on `serif`. Only `sans-serif` happened to agree. Chromium is unaffected
 * (all three families identical detached vs attached), which is why this class
 * of bug survives Chromium-only testing.
 *
 * Attachment is the whole fix, and it is dynamic rather than latched: the *same*
 * context re-measured 109.737 → 131.579 → 109.737 across append and remove, so
 * Gecko consults the style context per `measureText` rather than at context
 * creation. `OffscreenCanvas` also measures correctly (132.000, matching layout
 * exactly, since it has no backing device scale to grid-fit against) but is not
 * used here: agreeing with the *painted* canvas matters more than agreeing with
 * DOM layout, and the painted canvas is a real attached one.
 *
 * A residual ~0.3% disagreement remains between an attached canvas and DOM
 * layout (131.579 vs 132.000) — Gecko grid-fits advances to integer device
 * pixels for layout while canvas keeps fractional ones. That is a separate
 * concern from this module and has no CSS escape hatch (`text-rendering:
 * geometricPrecision` measured identical to `auto`).
 */

let sharedCanvas: HTMLCanvasElement | undefined;
let sharedContext: CanvasRenderingContext2D | null | undefined;

/**
 * Create a 1x1 canvas attached to `document.body` and return its 2D context.
 *
 * Prefer {@link getSharedMeasuringContext} — this appends an element, so calling
 * it per object leaks one canvas per object. Exported for callers that genuinely
 * need an isolated context.
 *
 * The canvas is positioned far off-screen at `opacity: 0` rather than
 * `display: none`, because a `display: none` element is outside layout and was
 * measured to lose the very style context this exists to acquire. It is never
 * painted, only measured against.
 *
 * Attachment is best-effort: `document.body` can be null before parse completes.
 * Without it the behaviour degrades to the old detached one — correct on
 * Chromium, wrong on Firefox for generic families — rather than throwing.
 *
 * @returns A measuring context, or `null` in a DOM-free environment.
 */
export function createMeasuringContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.cssText = 'position:absolute;opacity:0;left:-9999px;top:0;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  document.body?.appendChild(canvas);
  return canvas.getContext('2d');
}

/**
 * The single measuring context shared across every `@vectojs/*` package,
 * created on first use.
 *
 * Safe to share because `ctx.font` is assigned before every read at each call
 * site, and what is memoized is a context, not a measurement — no width cache
 * travels with it.
 *
 * `undefined` vs `null` is load-bearing: `null` is a real memoized answer ("no
 * DOM here"), so the guard is `!== undefined` rather than a truthiness test that
 * would retry element creation on every call in an SSR environment.
 *
 * @returns The shared measuring context, or `null` in a DOM-free environment.
 */
export function getSharedMeasuringContext(): CanvasRenderingContext2D | null {
  if (sharedContext !== undefined) return sharedContext;
  if (typeof document === 'undefined') {
    sharedContext = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.cssText = 'position:absolute;opacity:0;left:-9999px;top:0;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  document.body?.appendChild(canvas);
  sharedCanvas = canvas;
  sharedContext = canvas.getContext('2d');
  return sharedContext;
}

/**
 * Whether the shared measuring context is currently attached to the document.
 *
 * Exists because attachment is best-effort — a context created before
 * `document.body` existed measures generic families wrong on Firefox, and that
 * is otherwise silent. A caller that has just loaded a webfont, or a test
 * asserting the measure-where-you-paint contract, can check this and re-create.
 *
 * @returns `true` when a shared context exists and its canvas is in the document.
 */
export function isSharedMeasuringContextAttached(): boolean {
  return sharedCanvas !== undefined && sharedCanvas.isConnected;
}

/**
 * Drop the shared measuring context, removing its canvas from the document.
 *
 * For the case where the context was created before `document.body` existed and
 * is therefore detached: the next {@link getSharedMeasuringContext} rebuilds it
 * attached. Callers holding their own width caches must clear those too — this
 * releases the context, not anything memoized from it.
 */
export function resetSharedMeasuringContext(): void {
  sharedCanvas?.remove();
  sharedCanvas = undefined;
  sharedContext = undefined;
}
