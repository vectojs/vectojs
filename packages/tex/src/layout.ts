/**
 * The kernel entry point: TeX source → a laid-out span tree.
 *
 * This replaces KaTeX's `buildTree.ts`, which was not vendored because its only
 * job is to decide between HTML and MathML output and wrap the result in the
 * `.katex` / `.katex-display` elements a browser needs. We want neither: there is
 * no MathML, and the wrapper spans carry CSS semantics that mean nothing on a
 * canvas.
 *
 * What comes out is the same `DomSpan` tree KaTeX's own HTML renderer consumes,
 * with all vertical geometry already resolved — `height`, `depth`, and explicit
 * `top` offsets on vlist children. The SVG emit layer translates that; it does not
 * re-derive layout.
 */

import { makeSpan } from './kernel/buildCommon';
import buildHTML from './kernel/buildHTML';
import type { DomSpan } from './kernel/domTree';
import Options from './kernel/Options';
import parseTree from './kernel/parseTree';
import Settings from './kernel/Settings';
import Style from './kernel/Style';

/** Options for laying out one formula. */
export interface LayoutOptions {
  /**
   * Display mode (`$$…$$`) rather than inline (`$…$`).
   *
   * Changes the style cascade, so `\sum` gets full-size limits above and below
   * rather than beside, and fractions are set at full size.
   */
  displayMode?: boolean;
  /**
   * Largest permitted user-specified size, in em, for commands that take one
   * (`\rule`, `\kern`, `\hspace`). Defends against a formula asking for a
   * 10000em rule, which would be a denial of service on the rasterizer rather
   * than a rendering bug.
   */
  maxSize?: number;
  /** Minimum thickness in em for fraction bars and rules. */
  minRuleThickness?: number;
  /** Cap on macro expansions, guarding against a recursive `\def`. */
  maxExpand?: number;
}

/**
 * Lays out a TeX expression, returning the root span of the layout tree.
 *
 * Throws `ParseError` for invalid input. Callers that must not throw should catch
 * and degrade to rendering the TeX source verbatim, which is what
 * `@vectojs/markdown` already does for unknown commands.
 */
export function layout(tex: string, options: LayoutOptions = {}): DomSpan {
  const settings = new Settings({
    displayMode: options.displayMode ?? false,
    maxSize: options.maxSize ?? Infinity,
    minRuleThickness: options.minRuleThickness ?? 0.04,
    maxExpand: options.maxExpand ?? 1000,
    // Never throw for a *strictness* violation — those flag questionable but
    // renderable TeX (e.g. Unicode text in math mode). A hard parse error still
    // throws; this only stops warnings from becoming failures.
    strict: false,
    // `throwOnError: false` would splice KaTeX's own red error markup into the
    // tree. We want the exception so the caller can fall back to TeX source.
    throwOnError: true,
  });

  const tree = parseTree(tex, settings);
  const buildOptions = new Options({
    style: settings.displayMode ? Style.DISPLAY : Style.TEXT,
    maxSize: settings.maxSize,
    minRuleThickness: settings.minRuleThickness,
  });

  const root = buildHTML(tree, buildOptions);

  // `buildHTML` returns the `.katex-html` span whose own height/depth are the
  // formula's. Wrapping it keeps a stable root for the emitter to measure, and
  // matches how `makeSpan` sizes a parent from its children.
  return makeSpan(['vecto-tex'], [root], buildOptions);
}

export type { DomSpan };
