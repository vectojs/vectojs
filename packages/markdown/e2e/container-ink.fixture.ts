import { Scene } from '@vectojs/core';
import { Markdown } from '../src/Markdown';

/**
 * Does a `:::` container actually paint its background fill and accent border
 * on the canvas — not just build the right entity tree?
 *
 * `test/container.test.ts` asserts the entity shape (one `ContainerBackground`
 * + `QuoteBorder` + `Stack` per fence) and the border's `.color` property.
 * That stops one step short of the canvas, which no unit test exercises
 * (jsdom has no 2D context) — the same gap `ins-mark-ink.fixture.ts` closes
 * for `++ins++`/`==mark==`.
 *
 * Same sampling strategy as `mark`'s corner check in that fixture: the canvas
 * starts fully transparent, and `Scene`/`SceneOptions` has no background-color
 * option, so a sampled pixel's alpha alone tells us whether something painted
 * there. Two spots distinguish the container's three layers:
 *
 * - **top-left corner of the content area** (`x + 2, y + 2`): inside the
 *   `ContainerBackground` fill, past its corner radius, but to the right of
 *   the `QuoteBorder` accent bar (`containerBorderWidth` is 4px). Alpha > 0
 *   there iff the background fill reached the canvas.
 * - **inside the accent bar itself** (`x + 1, y + <mid-height>`): the
 *   `QuoteBorder`'s own strip, which is drawn OVER the background at the
 *   same x range. Its color should match `theme.containerColors[kind]`
 *   (opaque, unlike the translucent background), so sampling there and
 *   comparing the RGB to the expected accent color is a stronger check than
 *   alpha alone — a background-only regression (border never drawn) would
 *   still show alpha > 0 at this spot without it.
 */

export interface ContainerCase {
  bgCorner: [number, number, number, number];
  borderPixel: [number, number, number, number];
  text: string;
}

export interface ContainerInkResult {
  note: ContainerCase;
  plain: ContainerCase;
}

declare global {
  interface Window {
    __containerInk?: ContainerInkResult;
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

function pixelAt(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): [number, number, number, number] {
  const context = canvas.getContext('2d');
  if (!context) return [0, 0, 0, 0];
  const { data } = context.getImageData(Math.round(x), Math.round(y), 1, 1);
  return [data[0], data[1], data[2], data[3]];
}

/** Walk the entity tree collecting every entity with a `.text`/`.spans`. */
function findFirstText(entity: { children?: unknown[] }): string {
  const withSpans = entity as { spans?: Array<{ text?: string }> };
  if (withSpans.spans && withSpans.spans.length > 0) {
    return withSpans.spans.map((s) => s.text ?? '').join('');
  }
  const withText = entity as { text?: unknown };
  if (typeof withText.text === 'string' && withText.text.length > 0) return withText.text;
  for (const child of entity.children ?? []) {
    const found = findFirstText(child as { children?: unknown[] });
    if (found) return found;
  }
  return '';
}

function renderContainer(source: string): ContainerCase {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 200;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(480, 200);
  const markdown = new Markdown(source, {
    maxWidth: 460,
    theme: { fontSize: 24 },
  });
  scene.add(markdown);
  scene.step(16.67);

  const top = markdown.content.children[0];
  if (!top) throw new Error(`No top-level entity for ${JSON.stringify(source)}`);
  const { x, y } = absolutePosition(top);

  return {
    // Background sample: past the border strip's own width (4px), so it
    // reads the fill and not the accent bar drawn over it.
    bgCorner: pixelAt(canvas, x + 6, y + 2),
    // Border sample: inside the accent strip itself (x+1, well under its
    // 4px width). Both samples use the SAME y offset — 2px below the top of
    // the content box — which for lowercase, ascender-free text sits above
    // any glyph ink regardless of x. Measured directly: a first attempt at
    // y+10 (deeper into the line, near x-height) picked up the "e" glyph's
    // own stroke in the PLAIN control (no indent, so its text starts at
    // x=0 and reaches x+1) — exactly the false positive this fixture exists
    // to avoid, the same lesson `bgCorner`'s own y+2 already encoded.
    borderPixel: pixelAt(canvas, x + 1, y + 2),
    text: findFirstText(top as { children?: unknown[] }),
  };
}

// Lowercase, ascender-free text ("encore") for BOTH cases, not just the
// control: row y+2 is close enough to the ascent line that a capital letter
// or an ascender (b/d/f/h/k/l/t) reaches into it at ANY x — measured
// directly: a first attempt using "Hello world" made the PLAIN control's
// corner alpha 161 from the "H"'s own stroke. `note`'s indent
// (`containerIndent`, 16px) already keeps its own text well to the right of
// both sampled x offsets, so ascender-safety only strictly matters for the
// unindented control — applying it to both keeps the two cases textually
// comparable.
const note = renderContainer(':::note\nencore encore\n:::');
// A plain paragraph occupies the same region with nothing painted behind it
// — no background, no border — so both sampled spots must stay transparent.
const plain = renderContainer('encore encore');

window.__containerInk = { note, plain };
window.__ready = true;
