import { Scene } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

/**
 * Does `19^th^ place` actually raise `th` on the canvas, not just carry the
 * right span style?
 *
 * `test/superscript.test.ts` asserts the SPAN STYLE — that `^th^` carries a
 * positive `baselineShift` and a reduced `fontSize`. That stops one step short
 * of the canvas, which no unit test exercises (jsdom has no 2D context).
 *
 * What is measured: the topmost inked row within the paragraph's box, for
 * `19^th^ place` (mixed) versus `19th place` at uniform size (plain). Both
 * strings project the same TEXT (`superscript-ink.e2e.ts` asserts that), so a
 * difference in where the ink starts vertically can only come from the
 * baseline shift actually reaching the draw call.
 */

export interface RaisedInkCase {
  /** Row index (0 = top of the paragraph box) of the first row with any ink. */
  topInkRow: number;
  /** Row index of the last row with any ink. */
  bottomInkRow: number;
  /** Ink across the whole paragraph box: the "did anything draw at all" control. */
  totalInk: number;
  /** The text the paragraph actually projected. */
  text: string;
}

export interface SuperscriptInkResult {
  mixed: RaisedInkCase;
  plain: RaisedInkCase;
}

declare global {
  interface Window {
    __supInk?: SuperscriptInkResult;
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
  topInkRow: number;
  bottomInkRow: number;
  totalInk: number;
}

/** Topmost/bottommost inked row and total ink within the region. */
function inkExtent(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): InkExtent {
  const context = canvas.getContext('2d');
  if (!context) return { topInkRow: -1, bottomInkRow: -1, totalInk: -1 };
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.min(Math.ceil(w), canvas.width - left);
  const height = Math.min(Math.ceil(h), canvas.height - top);
  if (width <= 0 || height <= 0) return { topInkRow: -1, bottomInkRow: -1, totalInk: -1 };
  const { data } = context.getImageData(left, top, width, height);

  let totalInk = 0;
  let topInkRow = -1;
  let bottomInkRow = -1;
  for (let row = 0; row < height; row++) {
    let rowHasInk = false;
    for (let col = 0; col < width; col++) {
      if (data[(row * width + col) * 4 + 3] > 8) {
        rowHasInk = true;
        totalInk++;
      }
    }
    if (rowHasInk) {
      if (topInkRow < 0) topInkRow = row;
      bottomInkRow = row;
    }
  }
  return { topInkRow, bottomInkRow, totalInk };
}

function renderCase(source: string): RaisedInkCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 140;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 140);
  // A large size so a few px of baseline shift is many rows of ink, which
  // would make the measurement insensitive to hinting/antialiasing noise.
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
    topInkRow: extent.topInkRow,
    bottomInkRow: extent.bottomInkRow,
    totalInk: extent.totalInk,
    text: paragraph.spans.map((span) => span.text).join(''),
  };
}

// Isolated so the dominant, unshifted "19"/" place" glyphs cannot mask the
// signal: `th` alone, raised and shrunk, versus `th` alone at uniform size.
// The only difference between the two sources is the caret syntax.
const mixed = renderCase('^th^');
const plain = renderCase('th');

window.__supInk = { mixed, plain };
window.__ready = true;
