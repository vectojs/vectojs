import { Scene } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

/**
 * Does a recognised abbreviation actually draw a dotted underline on the
 * canvas — not just carry `abbrTitle` on its span style?
 *
 * `test/abbr.test.ts` asserts the SPAN STYLE (`abbrTitle` set on the matched
 * span). That stops one step short of the canvas, which no unit test
 * exercises (jsdom has no 2D context).
 *
 * `RichText.abbrRun` draws small filled circles 3px below the baseline
 * (`atBaseline + 3`, radius `Math.max(0.75, size / 28)`), the same
 * below-baseline family as `underlineRun`'s solid stroke (`ins-mark-ink`'s
 * gate). "line" has no descenders, so the plain control's ink stops exactly
 * at the glyphs' own bottom, while the abbreviated case's ink extends a few
 * rows further down to the dots. Measured as `bottomInkRow`, same metric
 * `ins-mark-ink.e2e.ts` uses for the equivalent reason.
 */

export interface AbbrCase {
  bottomInkRow: number;
  totalInk: number;
  text: string;
}

export interface AbbrInkResult {
  abbreviated: AbbrCase;
  plain: AbbrCase;
}

declare global {
  interface Window {
    __abbrInk?: AbbrInkResult;
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

interface InkExtent {
  bottomInkRow: number;
  totalInk: number;
}

/** Bottommost inked row and total ink within the region. */
function inkExtent(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): InkExtent {
  const context = canvas.getContext('2d');
  if (!context) return { bottomInkRow: -1, totalInk: -1 };
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.min(Math.ceil(w), canvas.width - left);
  const height = Math.min(Math.ceil(h), canvas.height - top);
  if (width <= 0 || height <= 0) return { bottomInkRow: -1, totalInk: -1 };
  const { data } = context.getImageData(left, top, width, height);

  let totalInk = 0;
  let bottomInkRow = -1;
  for (let row = 0; row < height; row++) {
    let rowHasInk = false;
    for (let col = 0; col < width; col++) {
      if (data[(row * width + col) * 4 + 3] > 8) {
        rowHasInk = true;
        totalInk++;
      }
    }
    if (rowHasInk) bottomInkRow = row;
  }
  return { bottomInkRow, totalInk };
}

function render(source: string): AbbrCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 140;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 140);
  // A large size so the 3px dot offset is several rows of ink, not one
  // antialiased row sensitive to hinting.
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
  const extent = inkExtent(canvas, x, y, paragraph.width, paragraph.height);

  return {
    bottomInkRow: extent.bottomInkRow,
    totalInk: extent.totalInk,
    text: paragraph.spans.map((span) => span.text).join(''),
  };
}

// "line" has no ascenders/descenders, so the dotted underline is the ONLY
// thing that can extend the ink downward relative to the plain control.
const abbreviated = render('line\n\n*[line]: A defined term');
const plain = render('line');

window.__abbrInk = { abbreviated, plain };
window.__ready = true;
