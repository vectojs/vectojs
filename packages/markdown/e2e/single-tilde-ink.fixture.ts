import { Scene } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

/**
 * Does the strike line actually reach the canvas — and does subscript actually
 * NOT draw one?
 *
 * `test/singleTilde.test.ts` asserts the SPAN STYLE — that `~2~` carries a
 * negative `baselineShift` and no `lineThrough`, and `~~x~~` the reverse. That
 * stops one step short of the defect this originally caught, which was visual: a
 * reader saw H2̶O. Between the span style and the reader sits `RichText`'s
 * strike-line drawing, which no unit test exercises because jsdom has no 2D
 * context.
 *
 * ## What is measured, and why not ink in a band
 *
 * The first attempt counted ink in a horizontal band across the middle of the run
 * and compared the two cases. Measured in Chromium: band ink was 411 for `H~2~O`
 * and 413 for `H~~2~~O` — a 2px difference that proves nothing. At the time, the
 * reason was that `~` is itself a mid-height glyph and the single-tilde case's two
 * literal tildes landed in exactly the band where a strike line would be and
 * masked it. Single-tilde no longer prints its delimiters at all (it is real
 * subscript now, `DEC-0001`), but the shape metric below is kept: it is the
 * discriminator that does not depend on what a non-struck run happens to draw.
 *
 * What distinguishes a strike line from glyphs is not how much ink there is but its
 * SHAPE: a rule is one long contiguous horizontal run of pixels, while text is
 * short runs separated by gaps. So this reports the longest contiguous inked run in
 * any single row, as a fraction of the paragraph width. A struck run approaches
 * 1.0; prose (and a shrunk, lowered subscript run) stays far below it regardless
 * of which font the engine substituted.
 *
 * The struck span is the WHOLE run in every case, so the rule spans the full width
 * — a `~~2~~` inside `H~~2~~O` would only strike the `2` and give a short rule that
 * a wide glyph could rival.
 */

export interface TildeInkCase {
  /** Longest contiguous inked horizontal run in any row, over the paragraph width. */
  maxRunFraction: number;
  /** Ink across the whole paragraph box: the "did anything draw at all" control. */
  totalInk: number;
  /** The text the paragraph actually projected. */
  text: string;
}

export interface TildeInkResult {
  single: TildeInkCase;
  double: TildeInkCase;
  plain: TildeInkCase;
}

declare global {
  interface Window {
    __tildeInk?: TildeInkResult;
    __ready?: boolean;
  }
}

await document.fonts.ready;

/** Absolute canvas position of an entity. */
function absolutePosition(entity: unknown): { x: number; y: number } {
  let x = (entity as { x: number }).x;
  let y = (entity as { y: number }).y;
  let parent = (entity as { parent?: unknown }).parent;
  while (parent) {
    x += (parent as { x: number }).x;
    y += (parent as { y: number }).y;
    parent = (parent as { parent?: unknown }).parent;
  }
  return { x, y };
}

interface InkShape {
  totalInk: number;
  maxRun: number;
}

/** Total ink and the longest contiguous inked run in any row of the region. */
function inkShape(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): InkShape {
  const context = canvas.getContext('2d');
  if (!context) return { totalInk: -1, maxRun: -1 };
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.min(Math.ceil(w), canvas.width - left);
  const height = Math.min(Math.ceil(h), canvas.height - top);
  if (width <= 0 || height <= 0) return { totalInk: -1, maxRun: -1 };
  const { data } = context.getImageData(left, top, width, height);

  let totalInk = 0;
  let maxRun = 0;
  for (let row = 0; row < height; row++) {
    let run = 0;
    for (let col = 0; col < width; col++) {
      const inked = data[(row * width + col) * 4 + 3] > 8;
      if (inked) {
        totalInk++;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
  }
  return { totalInk, maxRun };
}

function renderCase(source: string): TildeInkCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 140;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 140);
  // A large size so the strike line is several rows of ink rather than one
  // antialiased row, which would make the measurement sensitive to hinting.
  const markdown = new Markdown(source, {
    maxWidth: 460,
    theme: { fontSize: 48 },
  });
  scene.add(markdown);
  scene.step(16.67);

  const paragraph = markdown.content.children[0];
  if (!(paragraph instanceof RichText)) {
    throw new Error(`Expected a RichText paragraph for ${JSON.stringify(source)}`);
  }
  const { x, y } = absolutePosition(paragraph);
  const shape = inkShape(canvas, x, y, paragraph.width, paragraph.height);

  return {
    maxRunFraction: shape.maxRun / Math.max(1, Math.ceil(paragraph.width)),
    totalInk: shape.totalInk,
    text: paragraph.spans.map((span) => span.text).join(''),
  };
}

// Identical letters in all three cases, so the only difference between `double`
// and `plain` is the strike line itself, and the only difference between `single`
// and `plain` is the subscript shrink + baseline drop (no delimiters print now).
const single = renderCase('~Hello world~');
const double = renderCase('~~Hello world~~');
const plain = renderCase('Hello world');

window.__tildeInk = { single, double, plain };
window.__ready = true;
