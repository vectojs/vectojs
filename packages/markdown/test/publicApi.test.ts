import { describe, expect, it } from 'vitest';

import * as fromEntry from '../src/index';
import * as fromMarkdown from '../src/Markdown';

/**
 * The public API surface, pinned.
 *
 * `Markdown.ts` was split into six domain modules (`theme`, `markdown-entities`,
 * `markdown-image`, `markdown-code`, `markdown-math`, `markdown-inline`), and
 * `src/index.ts` is `export * from './Markdown'`. So every symbol that was
 * exported from `Markdown.ts` before the split has to keep being re-exported
 * from it, or it silently disappears from the package.
 *
 * "Silently" is the operative word and is why this file exists. Moving a
 * declaration out and forgetting its re-export is not a type error, not a lint
 * warning, and not a test failure anywhere else in the suite — the symbol simply
 * stops existing for consumers. `packages/core/e2e/text-projection.fixture.ts`
 * deep-imports `codeAtlas`, `CodeBlock` and `Markdown` from
 * `../../markdown/src/Markdown`, so it would break outside this package's own
 * test run, which is the worst place to discover it.
 *
 * See `forge/decisions/file-decomposition-2026-08.md`.
 */
describe('public API survives the module split', () => {
  /**
   * Measured from `Markdown.ts` at `9bb63d6`, immediately before the split.
   * Do not remove an entry to make a failure go away: removing one is a breaking
   * change and needs a major bump plus a changeset saying so.
   */
  const EXPORTED_BEFORE_SPLIT = [
    'CodeBlock',
    'Markdown',
    'MathBlock',
    'codeAtlas',
    'codeAtlasStats',
    'isMathJaxReady',
    'preloadMathJax',
  ] as const;

  it.each(EXPORTED_BEFORE_SPLIT)('re-exports %s from Markdown.ts', (name) => {
    expect(fromMarkdown).toHaveProperty(name);
    expect((fromMarkdown as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(EXPORTED_BEFORE_SPLIT)('reaches the package entry as %s', (name) => {
    expect(fromEntry).toHaveProperty(name);
  });

  it('exports the same binding through both paths, not a copy', () => {
    // A re-export must forward the identity. Two separately-evaluated copies of
    // a class would make `instanceof` fail across the boundary — which is
    // exactly what `mathBlocksOf`-style checks in the other suites rely on.
    for (const name of EXPORTED_BEFORE_SPLIT) {
      expect((fromEntry as Record<string, unknown>)[name]).toBe(
        (fromMarkdown as Record<string, unknown>)[name],
      );
    }
  });

  it('keeps MathRender module-private', () => {
    // It was never exported before the split. Re-exporting it to satisfy an
    // import inside the package would widen the public API by accident.
    expect(fromMarkdown).not.toHaveProperty('MathRender');
    expect(fromEntry).not.toHaveProperty('MathRender');
  });

  it('does not leak the newly-extracted internals', () => {
    // These moved into their own modules and are imported by name within the
    // package. None was public before the split, so none should be public now —
    // `export *` makes that easy to get wrong in the other direction.
    for (const name of [
      'collectSpans',
      'containsImage',
      'decodeEntities',
      'headingSize',
      'highlightLine',
      'liftNestedImages',
      'renderInlineToRichText',
      'resolveTheme',
      'MarkdownContainer',
      'HorizontalRule',
      'QuoteBorder',
    ]) {
      expect(fromEntry, name).not.toHaveProperty(name);
    }
  });
});
