import type { Entity } from '@vectojs/core';
import {
  MathBlock,
  preloadMathJax,
  renderMathToSVGDataURI,
  isMathJaxReady,
  MATH_LANGS,
} from './markdown-math';
import type {
  FencedBlockRenderer,
  FencedBlockRenderOptions,
  FencedBlockRendererSpec,
} from './markdown-fenced-registry';

/**
 * Built-in math block renderer for the fenced block registry.
 *
 * Wraps the existing `MathBlock` entity and `renderMathToSVGDataURI`, preserving
 * all current behavior (lazy load, cache, content projection, text selection).
 *
 * This is a lazy-loadable renderer: the `load()` method triggers the math engine
 * import, and the renderer function is synchronous once the engine is ready.
 */

export const mathBlockRendererSpec: FencedBlockRendererSpec = {
  async load(): Promise<FencedBlockRenderer | null> {
    // Trigger the math engine load. This is idempotent — multiple calls join one load.
    await preloadMathJax();

    // Return the synchronous renderer function.
    return (source: string, lang: string, options: FencedBlockRenderOptions): Entity | null => {
      if (!source.trim()) return null;
      if (!isMathJaxReady()) return null;

      const mathRender = renderMathToSVGDataURI(
        source,
        true, // displayMode = true for block math
        options.theme.textColor,
      );

      if (!mathRender) return null;

      return new MathBlock(
        mathRender,
        source,
        options.availableWidth,
        options.theme,
        options.selectable,
      );
    };
  },
};

/**
 * Re-export MATH_LANGS for external registration.
 *
 * Languages that render as math: `math`, `latex`, `tex`.
 */
export { MATH_LANGS };
