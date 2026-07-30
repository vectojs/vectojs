import { Markdown, isMathJaxReady, preloadMathJax } from '../src/index';

declare global {
  interface Window {
    __ready?: boolean;
    __lazyMathResult?: LazyMathBrowserResult;
    __lazyMathError?: string;
  }
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

    window.__lazyMathResult = {
      readyBeforeAnyFormula,
      entityBeforeLoad,
      entityAfterLoad,
      imageDecoded,
      heightChanged,
      heightConsistent,
      secondFormulaSynchronous,
      stableSawTypeset,
    };
  } catch (error) {
    window.__lazyMathError = error instanceof Error ? error.message : String(error);
  } finally {
    window.__ready = true;
  }
}

void main();
