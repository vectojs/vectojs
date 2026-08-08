import { Scene } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

/**
 * Does `++inserted++` actually draw an underline on the canvas, and does
 * `==marked==` actually paint a background fill — not just carry the right
 * span style?
 *
 * `test/insMark.test.ts` asserts the SPAN STYLE — that `++line++` carries
 * `underline: true` and `==word==` carries `highlightColor`. That stops one
 * step short of the canvas, which no unit test exercises (jsdom has no 2D
 * context).
 *
 * ## ins
 *
 * `RichText.underlineRun` draws its stroke 2px BELOW the shared baseline.
 * "line" has no descenders, so the plain control's ink stops exactly at the
 * glyphs' own bottom, while the underlined case's ink extends several rows
 * further down to the stroke. Measured as `bottomInkRow`, the same metric
 * `superscript-ink.e2e.ts` uses for the equivalent reason.
 *
 * ## mark
 *
 * `RichText.highlightRun` fills a rectangle behind the run's own glyph box
 * before drawing the glyphs, at `theme.markHighlightColor`
 * (`rgba(250, 204, 21, 0.35)` — semi-transparent). The canvas starts fully
 * transparent (alpha 0) and `Scene`/`SceneOptions` has no background-color
 * option to paint over that, so rather than compositing over a known
 * backdrop, this samples a pixel inside the run's box but away from any
 * glyph's ink (the padding above the ascender, at the run's left edge) and
 * checks alpha alone: the highlight fill is the only thing that can paint
 * that spot at all, so alpha > 0 there means it reached the canvas and
 * alpha === 0 means it did not.
 */

export interface InsCase {
  bottomInkRow: number;
  totalInk: number;
  text: string;
}

export interface MarkCase {
  cornerColor: [number, number, number, number];
  text: string;
}

export interface InsMarkInkResult {
  insMixed: InsCase;
  insPlain: InsCase;
  mark: MarkCase;
  markPlain: MarkCase;
}

declare global {
  interface Window {
    __insMarkInk?: InsMarkInkResult;
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

function renderIns(source: string): InsCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 140;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 140);
  // A large size so the 2px underline offset is several rows of ink, not one
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

function renderMark(source: string): MarkCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 140;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 140);
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
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context');
  // Sample near the run's top-left: inside `highlightRun`'s fill rectangle
  // (which spans the full glyph box, `runTop` to `runTop + runHeight`) but
  // above the ascender of any lowercase letter, so it is background-only —
  // painted by the highlight fill (or not) and nothing else.
  const sampleX = Math.round(x) + 1;
  const sampleY = Math.round(y) + 1;
  const { data } = context.getImageData(sampleX, sampleY, 1, 1);
  const cornerColor: [number, number, number, number] = [data[0], data[1], data[2], data[3]];

  return {
    cornerColor,
    text: paragraph.spans.map((span) => span.text).join(''),
  };
}

// "line" has no ascenders/descenders, so the underline is the ONLY thing that
// can extend the ink downward relative to the plain control.
const insMixed = renderIns('++line++');
const insPlain = renderIns('line');

// "word" for both, so the highlight fill is the ONLY difference at the
// sampled corner pixel.
const mark = renderMark('==word==');
const markPlain = renderMark('word');

window.__insMarkInk = { insMixed, insPlain, mark, markPlain };
window.__ready = true;
