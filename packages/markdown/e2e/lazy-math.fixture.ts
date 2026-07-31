import { Scene } from '@vectojs/core';
import { Markdown, isMathJaxReady, preloadMathJax } from '../src/index';

declare global {
  interface Window {
    __ready?: boolean;
    __lazyMathResult?: LazyMathBrowserResult;
    __lazyMathError?: string;
  }
}

/**
 * What one inline `$...$` formula produced, read off the real layout.
 *
 * Inline math is a reserved box inside a single `RichText`, not a child entity,
 * so none of the entity-shape checks above can see it. These read the actual
 * `LayoutNode` the engine emitted, which is the only place the resolved
 * position and size of the box exist.
 */
export interface InlineMathBrowserResult {
  /**
   * Before MathJax lands, the formula is still gold `#fcd34d` TeX source and
   * reserves nothing.
   */
  objectsBeforeLoad: number;
  /** After it lands, exactly one reserved object node exists. */
  objectsAfterLoad: number;
  /** No gold source-text span survives the typeset. */
  goldSpansAfterLoad: number;
  /** The `$` delimiters are not visible anywhere in the laid-out text. */
  visibleTextHasDollar: boolean;
  /** The box is real: both dimensions positive. */
  boxWidth: number;
  boxHeight: number;
  /**
   * Text flows AROUND the box rather than through it: the next glyph starts at
   * or after the box's right edge. This is the assertion that the reserved
   * advance is actually honoured by line breaking, not merely stored.
   */
  nextGlyphClearsBox: boolean;
  /** The glyph before the formula ends at or before the box's left edge. */
  prevGlyphClearsBox: boolean;
  /** The box sits within the line, not off the top of the paragraph. */
  boxWithinParagraph: boolean;
  /** `sourceText()` keeps the U+FFFC sentinel so `sourceIndex` stays aligned. */
  sourceTextHasSentinel: boolean;
  /** `accessibleText()` substitutes the TeX source for screen readers. */
  accessibleTextHasFormula: boolean;
  /**
   * Non-background pixels found INSIDE the reserved box after a real paint.
   *
   * The assertion this whole case exists for. Everything else about inline math is
   * observable in a unit test; whether anything was actually drawn is not. The
   * reservation shipped without a painter and produced a correctly measured,
   * correctly positioned, accessible, and completely blank gap.
   */
  paintedPixelsInBox: number;
  /**
   * Non-background pixels in a control strip just BELOW the box.
   *
   * Guards the assertion above against a false positive: if the sampler were
   * reading a region that happens to contain text, `paintedPixelsInBox` would be
   * positive no matter what the painter did. This strip is inside the canvas and
   * outside the line, so it must stay empty.
   */
  paintedPixelsBelowBox: number;
  /**
   * A formula in a heading reserves a WIDER box than the same formula in body
   * prose. This is what the old hardcoded `ex * 8` could not do, and it is only
   * observable once a real engine has resolved the heading's font.
   */
  headingBoxWiderThanBody: boolean;
}

export interface LazyMathBrowserResult {
  /** MathJax must NOT be loaded merely because `@vectojs/markdown` was imported. */
  readyBeforeAnyFormula: boolean;
  /** A closed fence renders as a CodeBlock of TeX source while the module loads. */
  entityBeforeLoad: string;
  /** …and becomes the typeset image once it lands. */
  entityAfterLoad: string;
  /** The typeset formula is a real decoded SVG raster, not a placeholder slab. */
  imageDecoded: boolean;
  /**
   * The document box tracked the typeset formula rather than the source block.
   *
   * Deliberately NOT "grew": measured in real Chrome the box goes 60 -> 58.328,
   * a SHRINK, because the typeset formula is shorter than the two-line CodeBlock
   * of its source. That is also why the rebuild cannot use
   * `Stack.resizeLastChild`, which is documented grow-only. What must hold is
   * that the box changed and still equals `content.height`.
   */
  heightChanged: boolean;
  /** `md.height` and `md.content.height` agree after the rebuild. */
  heightConsistent: boolean;
  /** After the one-time load, later formulas typeset in the same tick. */
  secondFormulaSynchronous: boolean;
  /** `onStable` must never observe an untypeset formula. */
  stableSawTypeset: boolean;
  /** Inline `$...$`, which no entity-shape assertion above can reach. */
  inline: InlineMathBrowserResult;
}

/**
 * Describe the first block as `Parent/Child` class names.
 *
 * Trailing digits are stripped because a bundler renames classes when two modules
 * in the graph declare the same name: esbuild emits `Image2` for `@vectojs/ui`'s
 * `Image` here, since the DOM `Image` is also in scope. Asserting on the raw name
 * would make this fixture fail on a bundler detail rather than on behaviour.
 */
const kindOf = (md: Markdown): string => {
  const first = md.content.children[0] as unknown as {
    constructor: { name: string };
    children?: Array<{ constructor: { name: string } }>;
  };
  if (!first) return 'none';
  const clean = (name: string) => name.replace(/\d+$/, '');
  const inner = first.children?.[0];
  return inner
    ? `${clean(first.constructor.name)}/${clean(inner.constructor.name)}`
    : clean(first.constructor.name);
};

/** U+FFFC, the sentinel char an inline object reserves its advance on. */
const OBJECT_REPLACEMENT = '\ufffc';

/** The gold this package styles un-typeset inline math with. */
const MATH_SOURCE_COLOR = '#fcd34d';

/**
 * One formula mid-sentence, with text on both sides.
 *
 * Both sides matter: the glyph before proves the box starts where the text
 * stopped, and the glyph after proves the reserved advance was actually consumed
 * by line breaking rather than merely recorded.
 */
const INLINE_SOURCE = 'Given $x+1$ we proceed with more text after it.';

/**
 * A minimal view of the layout node the engine emitted.
 *
 * `RichText.result` is private, so this reads it through a cast. Widening the
 * public API only so a fixture can look at it would be worse: the geometry is an
 * implementation detail everywhere except here, where it is the whole subject.
 */
interface ProbedNode {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: { color?: string };
  object?: { width: number; height: number; depth?: number; alt?: string };
}

interface ProbedRichText {
  constructor: { name: string };
  result?: { nodes: ProbedNode[] };
  spans?: Array<{ text: string; style?: { color?: string } }>;
  sourceText?: () => string;
  accessibleText?: () => string;
}

/** The first block of a document, as a RichText probe. */
const richTextOf = (md: Markdown): ProbedRichText =>
  md.content.children[0] as unknown as ProbedRichText;

const nodesOf = (md: Markdown): ProbedNode[] => richTextOf(md).result?.nodes ?? [];

const objectNodesOf = (md: Markdown): ProbedNode[] =>
  nodesOf(md).filter((node) => node.object !== undefined);

/**
 * Render {@link INLINE_SOURCE} on its own canvas and count drawn pixels inside the
 * formula's box.
 *
 * A dedicated `Scene` rather than the page canvas, so the sampled region contains
 * only this paragraph and a coordinate mistake cannot pick up unrelated content.
 *
 * The raster decodes asynchronously and the painter draws nothing until it has, so
 * this waits for the repaint rather than sampling the first frame. It polls because
 * the notification is internal to the package: exposing a promise for it would mean
 * widening the public API purely for a test.
 */
async function paintAndSample(box: ProbedNode | undefined): Promise<{
  paintedPixelsInBox: number;
  paintedPixelsBelowBox: number;
}> {
  if (!box) return { paintedPixelsInBox: 0, paintedPixelsBelowBox: 0 };

  const target = document.createElement('canvas');
  target.width = 640;
  target.height = 240;
  document.body.appendChild(target);

  const scene = new Scene(target, { disableWindowResize: true });
  scene.resize(640, 240);
  const painted = new Markdown(INLINE_SOURCE);
  scene.add(painted);

  const context = target.getContext('2d');
  if (!context) throw new Error('Fixture canvas has no 2D context');

  // Inset by a pixel on each side: the box edges are fractional, and a formula's
  // glyphs do not reach the corners of its bounding box.
  const region = {
    x: Math.floor(box.x) + 1,
    y: Math.floor(box.y) + 1,
    width: Math.max(1, Math.ceil(box.width) - 2),
    height: Math.max(1, Math.ceil(box.height) - 2),
  };

  const countInk = (x: number, y: number, w: number, h: number): number => {
    const { data } = context.getImageData(x, y, w, h);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Anything visible. The scene paints on a transparent canvas, so a drawn
      // pixel is one with alpha; the colour is MathJax's and not worth pinning.
      if (data[i + 3] > 8) ink++;
    }
    return ink;
  };

  // Up to ~2s for the SVG to decode, then one more frame to paint it.
  let paintedPixelsInBox = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    scene.step(16.67);
    paintedPixelsInBox = countInk(region.x, region.y, region.width, region.height);
    if (paintedPixelsInBox > 0) break;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }

  // Control: a strip below the line, inside the canvas and outside the text.
  const belowY = Math.min(target.height - 9, Math.ceil(box.y + box.height) + 6);
  const paintedPixelsBelowBox = countInk(region.x, belowY, region.width, 8);

  painted.destroy();
  target.remove();
  return { paintedPixelsInBox, paintedPixelsBelowBox };
}

async function main(): Promise<void> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    document.body.appendChild(canvas);

    // Nothing has asked for a formula yet, so importing the package must not have
    // pulled MathJax in. This is the whole point of the lazy import: in a real
    // browser the chunk has not even been fetched at this line.
    const readyBeforeAnyFormula = isMathJaxReady();

    const md = new Markdown('```math\n\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n```');
    const entityBeforeLoad = kindOf(md);
    const heightBefore = md.height;

    // Built BEFORE the load so it observes the pre-typeset state. A document
    // created after `preloadMathJax()` cannot show it.
    const inlineBefore = new Markdown(INLINE_SOURCE);
    const objectsBeforeLoad = objectNodesOf(inlineBefore).length;

    await preloadMathJax();
    // One extra turn for the rebuild continuation to run.
    await Promise.resolve();

    const entityAfterLoad = kindOf(md);
    const heightChanged = md.height !== heightBefore;
    const heightConsistent = md.height === md.content.height;

    // Wait for the browser to actually decode the SVG data URI. jsdom cannot do
    // this at all — it is the part only a real engine answers.
    const container = md.content.children[0] as unknown as {
      children?: Array<{ src?: string }>;
    };
    const img = container.children?.[0];
    let imageDecoded = false;
    if (img?.src) {
      imageDecoded = await new Promise<boolean>((resolve) => {
        const probe = new globalThis.Image();
        probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
        probe.onerror = () => resolve(false);
        probe.src = img.src as string;
      });
    }

    // The module is installed now, so this must not need an await.
    const second = new Markdown('```math\n\\int_0^1 x^2 dx\n```');
    const secondFormulaSynchronous = kindOf(second).endsWith('/Image');

    // Settlement: a fresh document streaming a formula must hand onStable a
    // typeset entity. MathJax is already loaded here, so this checks the
    // steady-state path rather than the load wait (covered in unit tests).
    const streamed = new Markdown('');
    let stableSawTypeset = false;
    const stream = streamed.createStream({
      onStable: () => {
        stableSawTypeset = kindOf(streamed).endsWith('/Image');
      },
    });
    stream.write('```math\n\\alpha + \\beta\n```');
    await stream.close();

    // ── Inline `$...$` ──────────────────────────────────────────────────────
    // MathJax is loaded by now, so this is the steady-state path: the box is
    // reserved during the first layout rather than after a rebuild.
    const inlineAfter = new Markdown(INLINE_SOURCE);
    const inlineRich = richTextOf(inlineAfter);
    const inlineNodes = nodesOf(inlineAfter);
    const inlineObjects = objectNodesOf(inlineAfter);

    const goldSpansAfterLoad = (inlineRich.spans ?? []).filter(
      (span) => span.style?.color === MATH_SOURCE_COLOR,
    ).length;

    // What the engine will actually paint, excluding the invisible sentinel.
    const visibleText = inlineNodes
      .filter((node) => node.object === undefined)
      .map((node) => node.char)
      .join('');

    const box = inlineObjects[0];
    const objectIndex = inlineNodes.findIndex((node) => node.object !== undefined);
    const previous = objectIndex > 0 ? inlineNodes[objectIndex - 1] : undefined;
    const next =
      objectIndex >= 0 && objectIndex + 1 < inlineNodes.length
        ? inlineNodes[objectIndex + 1]
        : undefined;

    // Sub-pixel tolerance: these are float sums of glyph advances, so an exact
    // equality would be testing float arithmetic rather than layout.
    const EPSILON = 0.01;
    const boxRight = box ? box.x + box.width : 0;

    const sourceTextValue = inlineRich.sourceText?.() ?? '';
    const accessibleTextValue = inlineRich.accessibleText?.() ?? '';

    // Paint it for real and look at the pixels. This is the part no unit test can
    // reach: Bun has no `globalThis.Image` at all, and jsdom has one that never
    // settles a `data:` URI (measured: neither onload nor onerror within 400ms).
    const { paintedPixelsInBox, paintedPixelsBelowBox } = await paintAndSample(box);

    // The same formula in an h1 must reserve a wider box than in body prose.
    const headingBox = objectNodesOf(new Markdown('# $x+1$'))[0];
    const bodyBox = objectNodesOf(new Markdown('$x+1$'))[0];

    const inline: InlineMathBrowserResult = {
      objectsBeforeLoad,
      objectsAfterLoad: inlineObjects.length,
      goldSpansAfterLoad,
      visibleTextHasDollar: visibleText.includes('$'),
      boxWidth: box?.width ?? 0,
      boxHeight: box?.height ?? 0,
      nextGlyphClearsBox: next !== undefined && next.x >= boxRight - EPSILON,
      prevGlyphClearsBox:
        previous !== undefined && previous.x + previous.width <= (box?.x ?? 0) + EPSILON,
      boxWithinParagraph:
        box !== undefined &&
        box.y >= -EPSILON &&
        box.y + box.height <= inlineAfter.height + EPSILON,
      sourceTextHasSentinel: sourceTextValue.includes(OBJECT_REPLACEMENT),
      accessibleTextHasFormula:
        accessibleTextValue.includes('x+1') && !accessibleTextValue.includes(OBJECT_REPLACEMENT),
      paintedPixelsInBox,
      paintedPixelsBelowBox,
      headingBoxWiderThanBody:
        headingBox !== undefined && bodyBox !== undefined && headingBox.width > bodyBox.width,
    };

    window.__lazyMathResult = {
      readyBeforeAnyFormula,
      entityBeforeLoad,
      entityAfterLoad,
      imageDecoded,
      heightChanged,
      heightConsistent,
      secondFormulaSynchronous,
      stableSawTypeset,
      inline,
    };
  } catch (error) {
    window.__lazyMathError = error instanceof Error ? error.message : String(error);
  } finally {
    window.__ready = true;
  }
}

void main();
