/**
 * How a projected line carries its trailing hard break.
 *
 * A projected line must hold its own line break in the DOM: copy, find-in-page
 * and screen readers all read the projection, and a block whose lines are
 * separate absolutely-positioned carriers has no flow structure a browser could
 * synthesize a newline from. So the break character is written out explicitly.
 *
 * Writing it as an ordinary inline character is what this module exists to stop.
 * The carriers are `white-space: pre`, so a trailing `\n` is a real preserved
 * character in an inline context, and a browser gives it a selection rectangle
 * of **zero width and full line height** at the end of the line. Chrome paints
 * that rectangle, so selecting a line drew a caret-like vertical bar just past
 * the last glyph — ink the canvas never drew, at a position no glyph occupies.
 *
 * Measured in real headed Chrome (DPR 1.76) on a live page, selecting one
 * paragraph line of `1. 极致的性能与定制化：\n`: four selection rects, the last
 * `x 495.18, w 0, h 31.82`. The same line with the break character removed
 * produced one rect and no bar. Both projection paths were affected — a
 * `CodeBlock` fixture reported one such rect on every line that owned a break
 * (3 of 4 rows, including the empty row whose entire content is the break).
 *
 * ## Why the character stays in the DOM
 *
 * Deleting it fixes the bar and breaks copy: measured on the same page,
 * stripping the trailing `\n` from every line of a block made
 * `getSelection().toString()` return the block as one unbroken run. The break
 * has to remain selectable text; it merely must not paint.
 *
 * `font-size: 0` is what separates those two. A zero font size leaves the
 * character in the text content and in the selected string, while collapsing the
 * line box it would otherwise contribute — measured on the same block, the
 * zero-width full-height rect became `w 0, h 0` and the selected string still
 * ended in `\n`.
 *
 * Rejected alternatives, each measured on the same live block:
 *
 * - **An absolutely positioned zero-size box** (`position: absolute; width: 0;
 *   height: 0; overflow: hidden`) still produced the full-height rect, *and*
 *   dropped the newline from the selected string — out of flow, the break no
 *   longer serialises. Worse on both counts.
 * - **Removing the character** and relying on the carriers' own box structure.
 *   The line carriers do compute to `display: block`, so it is a reasonable
 *   guess that the browser would synthesize the break — it does not. Copy came
 *   back unbroken (see above).
 *
 * ## Why a shared module
 *
 * Both projection branches own break text and both had the defect:
 * `Scene.syncContentProjection`'s carrier branch (plain and positioned-run
 * lines) and {@link ContentGridProjector.syncGrid} (the last cell of a line, and
 * an empty line's whole content). This follows the `content-line-window`
 * precedent — a stateless helper both sides of the grid cut call, rather than a
 * member on either — so the two cannot drift into disagreeing about how a break
 * is represented, which would make copy fidelity depend on which branch drew a
 * given block.
 *
 * Stateless by design: no `Scene`, no entities, no state beyond the node passed
 * in.
 */

/**
 * Characters that occupy no width on the canvas, so collapsing them costs
 * nothing.
 *
 * The separator a line owns is **not always a break**. A SOFT-wrapped line
 * separates from the next with a space, and that space is real text the canvas
 * measured into the line's advance — collapsing it to a zero font size deletes
 * width the glyphs actually occupy. Measured on the `chromium-dpr1.5-zoom90`
 * e2e arm: a soft-wrapped `alpha beta gamma ` line reported a DOM extent of
 * 134.2 client px against 149.1 px of canvas draw, exactly the missing trailing
 * space, and the selection box stopped short of the drawn text.
 *
 * So only hard breaks are collapsed. Everything else is appended as ordinary
 * inline text, which is what it was before and what the canvas measured.
 */
const HARD_BREAK_ONLY = /^[\r\n]+$/;

/**
 * Append `breakText` to `owner`, suppressing its paint only if it is a hard
 * break.
 *
 * A no-op for empty text, so callers can pass a separator that may legitimately
 * be absent (the document's last line owns no break) without branching.
 *
 * A hard break goes into a `font-size: 0` span: still selectable, copyable and
 * announced, but contributing no line box. Any other separator — a soft-wrap
 * space — is appended as a plain text node, because its width is part of the
 * line the canvas drew.
 *
 * The span is deliberately **not** `aria-hidden` and does **not** set
 * `user-select: none`: the break is real content that a screen reader and a copy
 * both want. Only its painted geometry is suppressed.
 */
export function appendContentBreak(owner: Node, breakText: string): void {
  if (!breakText) return;
  if (!HARD_BREAK_ONLY.test(breakText)) {
    owner.appendChild(document.createTextNode(breakText));
    return;
  }
  const span = document.createElement('span');
  span.textContent = breakText;
  // Collapses the line box the break would contribute without removing the
  // character from the text content. `line-height` is set too because a `0`
  // font size still resolves a `normal` line height from the inherited font.
  span.style.fontSize = '0';
  span.style.lineHeight = '0';
  owner.appendChild(span);
}
