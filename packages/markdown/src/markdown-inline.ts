import { OBJECT_REPLACEMENT, type StyledSpan, type TextStyle } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import type { Token, Tokens } from 'marked';

import { ensureInlineImageRaster, paintInlineImage } from './markdown-image';
import { footnoteMarker } from './markdown-footnote';
import { exToPx, fontSizeFromFont, paintInlineMath, renderMathToSVGDataURI } from './markdown-math';
import type { MarkdownTheme } from './theme';

/**
 * Inline tokens to `RichText` spans: the entity decoder, the span collector and
 * its switch, the unclosed-delimiter scanner for optimistic streaming, and the
 * `RichText` factory.
 *
 * Depends one way on `./markdown-math` (inline formulas become object spans) and
 * takes the theme as a type only, so nothing here imports the component. See
 * `forge/decisions/file-decomposition-2026-08.md`.
 */

/** Decode basic HTML entities that `marked` emits in token text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `markdown-it`'s `typographer` substitutions: dashes, ellipsis, trademark
 * symbols, and quote pairs contained within one run of prose.
 *
 * Off by default (`theme.typographer`), matching markdown-it's own default —
 * these are characters the author did not literally type, so applying them
 * unconditionally would silently rewrite a document's source.
 *
 * ## Quote pairing is INTRA-RUN only
 *
 * `"quoted"` becomes curly only when both its opening and closing `"` are in
 * the SAME decoded text run. A quote that spans an inline-markup boundary
 * (`"quoted *emphasis* text"` splits into three text tokens around the `em`)
 * is not paired across that boundary and stays straight. `collectSpans`
 * recurses per-token with no shared mutable state across siblings, and
 * markdown-it's own quote rule needs exactly that — a per-paragraph
 * open/close stack — to pair nested and cross-boundary quotes. Threading that
 * state through this module's recursion is a materially larger change,
 * deferred until a real document exercises the gap.
 *
 * ## Apostrophes vs. quote delimiters
 *
 * A `'` between two letters (`it's`, `y'all`) is a contraction, not a quote
 * delimiter, and is replaced with a closing curly quote BEFORE quote pairing
 * runs — otherwise `it's fine, 'nice' day` would pair the apostrophe in
 * `it's` with the opening `'` of `'nice'`, consuming both instead of matching
 * `'nice'` on its own.
 */
export function applyTypography(text: string): string {
  let out = text;
  // Symbols first, longest literal match first so `(tm)` cannot be partially
  // consumed by a shorter pattern.
  out = out.replace(/\(tm\)/gi, '\u2122');
  out = out.replace(/\(c\)/gi, '\u00a9');
  out = out.replace(/\(r\)/gi, '\u00ae');
  // `+-` to the plus-minus sign — documented in the `typographer` theme option
  // and present in markdown-it's own symbol set, but the live path shipped
  // without it while a dead duplicate module still carried it (#657).
  out = out.replace(/\+-/g, '\u00b1');
  // Em dash before en dash: a `---` run must resolve to one em dash, not an
  // em dash's worth of en-dash pairs plus a stray hyphen.
  out = out.replace(/---/g, '\u2014');
  out = out.replace(/--/g, '\u2013');
  // Exactly three dots; a fourth is left as a literal trailing period, the
  // same behaviour markdown-it's own ellipsis rule has.
  out = out.replace(/\.{3}/g, '\u2026');
  out = out.replace(/([A-Za-z])'([A-Za-z])/g, '$1\u2019$2');
  out = out.replace(/"([^"\n]*)"/g, '\u201c$1\u201d');
  out = out.replace(/'([^'\n]*)'/g, '\u2018$1\u2019');
  return out;
}

/**
 * Decode entities and, when the theme requests it, apply
 * {@link applyTypography}. The single call site every literal-prose branch in
 * {@link collectSpans} routes through, so enabling `typographer` covers every
 * surface that already flows through `collectSpans` (paragraphs, headings,
 * list items, table cells, links, emphasis, ins/mark/sub/sup) without a
 * second call site to keep in sync.
 *
 * Deliberately NOT used for `codespan`, `html`, an unresolved `emoji`
 * shortcode's literal fallback, or `inlineMath`'s failed-typeset source
 * fallback — none of those are prose a reader would want rewritten: a code
 * span's `it's` must stay a literal apostrophe, and TeX source shown on a
 * typeset failure must stay byte-identical to what was written.
 */
function decodeProse(text: string, theme: Required<MarkdownTheme>): string {
  const decoded = decodeEntities(text);
  return theme.typographer ? applyTypography(decoded) : decoded;
}

/**
 * Empty by construction, so every {@link collectSpans} call site that has no
 * abbreviation dictionary to thread through (nested recursive calls that
 * already received one further up, or a caller that never collected one) can
 * share one object instead of allocating a fresh empty `Map` per call.
 */
const NO_ABBREVIATIONS: ReadonlyMap<string, string> = new Map();

/**
 * Split `text` into one or more spans, applying `abbr`'s
 * `markdown-it-abbr`-style dotted-underline treatment to any whole-word (or
 * whole-phrase) term match, and push each resulting span into `out` with
 * `style` (plus `abbrTitle` on the matched ones).
 *
 * This is the single call site the abbreviation feature enters through: every
 * prose-emitting leaf in {@link collectSpans} (`strong`/`em`/`sup`/`ins`/
 * `mark`/subscript/`link`/`text`/the fallback arm) routes its decoded text
 * through this instead of a bare `out.push({ text, style })`, so a
 * `*[HTML]: …` definition applies uniformly across every kind of styled run —
 * `**HTML**`, `*HTML*`, a plain `HTML` — without a special case per construct.
 * `codespan`, `html`, an unresolved emoji shortcode, and the math fallback do
 * NOT route through this, matching {@link decodeProse}'s own exclusions:
 * abbreviation matching is prose treatment, not something a code span's
 * literal characters should be subject to.
 *
 * Longest-term-first, case-sensitive, whole-word/-phrase matching: sorting the
 * dictionary's terms by descending length before building the alternation
 * means `HTML5` (if separately defined) wins over `HTML` at a position where
 * both would otherwise match, mirroring `markdown-it-abbr`'s own greedy
 * behavior. `\b` boundaries on both ends keep `HTML5` from lighting up a
 * `HTML`-only definition, and a multi-word term (`*[JS Engine]: …`) matches
 * across the internal space the same way a single word does.
 *
 * When `abbr` is empty — the overwhelmingly common case, since most documents
 * define no abbreviations at all — this degrades to a single push with no
 * regex work, so the feature costs nothing for a document that never uses it.
 */
function emitProse(
  text: string,
  style: TextStyle | undefined,
  abbr: ReadonlyMap<string, string>,
  out: StyledSpan[],
): void {
  if (!text) return;
  if (abbr.size === 0) {
    out.push({ text, style });
    return;
  }
  const terms = [...abbr.keys()].sort((a, b) => b.length - a.length);
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\b(?:${pattern})\\b`, 'g');
  let last = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), style });
    out.push({ text: match[0], style: { ...style, abbrTitle: abbr.get(match[0]) } });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), style });
}

/**
 * Recursively walk the inline token tree, accumulating {@link StyledSpan}s
 * with inherited style overrides (bold, italic, etc.).
 */
export function collectSpans(
  tokens: Token[],
  inherited: TextStyle,
  theme: Required<MarkdownTheme>,
  out: StyledSpan[],
  /**
   * The size the enclosing block is drawn at, when it is not the theme body size.
   *
   * Only inline math uses it: `ex` is font-relative, so a formula's reserved box
   * has to be resolved against the size of the run it sits in. A heading carries
   * its size in its `font` string rather than in any span style, so it cannot be
   * recovered from `inherited`.
   */
  blockFontSize?: number,
  /**
   * The document's `*[TERM]: definition` dictionary, applied to every prose
   * leaf via {@link emitProse}. Defaults to {@link NO_ABBREVIATIONS} so every
   * call site that has none to thread — nested recursive calls, and callers
   * predating this feature — costs nothing extra.
   */
  abbr: ReadonlyMap<string, string> = NO_ABBREVIATIONS,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const t = token as Tokens.Strong;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, bold: true }, theme, out, blockFontSize, abbr);
        } else {
          emitProse(decodeProse(t.text, theme), { ...inherited, bold: true }, abbr, out);
        }
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, italic: true }, theme, out, blockFontSize, abbr);
        } else {
          emitProse(decodeProse(t.text, theme), { ...inherited, italic: true }, abbr, out);
        }
        break;
      }
      case 'del': {
        // GFM `~~deleted~~`. Without this arm the token fell to `default:`, which
        // pushes its text unstyled — the content rendered, so the omission looked
        // like plain text rather than a missing feature.
        const t = token as Tokens.Del;
        // marked's GFM tokenizer emits `del` for a SINGLE-tilde run too, so
        // `H~2~O` arrives here as well as `~~gone~~`. `raw` is what distinguishes
        // them — `~2~` vs `~~gone~~` — because `text` is identical either way.
        //
        // Single-tilde is now real subscript (DEC-0001's baseline-shift field
        // landed): the run scales down and drops below the baseline, exactly like
        // `markdown-it-sub`. Before that field existed, this arm re-emitted the
        // literal `~` delimiters and recursed unstruck instead — the only honest
        // fallback available at the time, since a lowered run could not be
        // expressed at all. See `DEC-01KZDK44` for that history.
        const isStrikethrough = t.raw?.startsWith('~~') ?? true;
        if (!isStrikethrough) {
          // The run's own size drives the subscript size, the same pattern
          // inline math and the footnote marker use: a subscript inside a
          // heading scales with the heading rather than reserving a body-sized
          // glyph. `subscriptShift` is in em of this UNSCALED size (CSS
          // `vertical-align: sub` is relative to the parent's font, not the
          // subscript's own reduced one), so it is computed before scaling.
          const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
          const subStyle: TextStyle = {
            ...inherited,
            fontSize: runSize * theme.subscriptScale,
            baselineShift: runSize * theme.subscriptShift,
          };
          if (t.tokens) {
            collectSpans(t.tokens, subStyle, theme, out, blockFontSize, abbr);
          } else {
            emitProse(decodeProse(t.text, theme), subStyle, abbr, out);
          }
          break;
        }
        if (t.tokens) {
          collectSpans(
            t.tokens,
            { ...inherited, lineThrough: true },
            theme,
            out,
            blockFontSize,
            abbr,
          );
        } else {
          emitProse(decodeProse(t.text, theme), { ...inherited, lineThrough: true }, abbr, out);
        }
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        out.push({
          text: decodeEntities(t.text),
          // Inline code renders in the theme's monospace family (not just tinted
          // prose) — TextStyle.fontFamily drives both measurement and drawing.
          style: {
            ...inherited,
            color: theme.codeColor,
            fontFamily: theme.codeFont,
          },
        });
        break;
      }
      case 'br': {
        // Hard break (trailing `\` / double space). The layout engine treats
        // `\n` as a paragraph break, so a newline span renders it.
        out.push({ text: '\n' });
        break;
      }
      case 'html': {
        // Inline HTML. `<br>` is the one tag with an inline-text meaning —
        // table cells rely on it for line breaks (`| a<br>b |`). Everything
        // else is markup: never print raw tags as visible text.
        const t = token as Tokens.HTML;
        const raw = t.raw ?? t.text ?? '';
        const brCount = (raw.match(/<br\s*\/?>/gi) ?? []).length;
        for (let i = 0; i < brCount; i++) out.push({ text: '\n' });
        break;
      }
      case 'inlineMath': {
        const t = token as any;
        // Typeset into a reserved inline box when MathJax is available. The run's
        // own size drives the conversion, so `$x$` inside a heading scales with
        // the heading rather than with body prose.
        const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
        // Inherit the surrounding run's color, so `$x$` in a heading or a
        // blockquote matches the prose around it rather than the body default.
        const runColor = inherited.color ?? theme.textColor;
        const rendered = renderMathToSVGDataURI(t.text, false, runColor);
        if (rendered) {
          // Bound outside the painter so the closure captures the URI rather than
          // the whole `MathRender`, and so it cannot see a later loop iteration's.
          const uri = rendered.uri;
          out.push({
            text: OBJECT_REPLACEMENT,
            style: inherited,
            object: {
              width: exToPx(rendered.widthEx, runSize),
              height: exToPx(rendered.heightEx, runSize),
              depth: exToPx(rendered.depthEx, runSize),
              // The TeX source is the accessible name: without it a screen reader
              // receives only the invisible U+FFFC sentinel.
              alt: t.text,
              // Without this the box is reserved and stays empty. The engine does
              // not draw objects, and nothing else in the tree holds the raster.
              paint: (surface, box) => paintInlineMath(uri, surface, box),
            },
          });
        } else {
          // MathJax has not loaded yet, or conversion failed. Keep the previous
          // styled-source rendering; `ensureMathJax()` retypesets from tokens once
          // the library lands, so for a document that is merely waiting this is a
          // transient state rather than the final output.
          out.push({
            text: decodeEntities(t.raw),
            style: { ...inherited, color: theme.mathFallbackColor },
          }); // yellow/gold for inline math
        }
        break;
      }
      case 'image': {
        // An image sharing a line with text: a heading or a table cell. A
        // paragraph, blockquote or list item never reaches this arm — those route
        // through paragraph splitting, which gives the image its own block and its
        // own `Image` entity at natural size.
        //
        // Before this arm existed the token fell to `default:`, which pushes
        // `.text` — so a heading rendered its ALT TEXT as ordinary prose and the
        // picture silently vanished. Nothing was blank and nothing threw, which is
        // why it went unnoticed: `# Title ![logo](u)` read as "Title logo".
        const t = token as Tokens.Image;
        const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
        const raster = ensureInlineImageRaster(t.href);
        // A failed decode has no picture to show, so fall back to the alt text
        // rather than reserving a box that will stay empty forever.
        if (raster.failed) {
          out.push({ text: decodeEntities(t.text), style: inherited });
          break;
        }
        const height = runSize * theme.inlineImageScale;
        // Square until the decode reports an aspect ratio. The height never
        // changes, so the line box is stable from the first frame and only the
        // width settles — see `theme.inlineImageScale`.
        const aspect =
          raster.naturalWidth && raster.naturalHeight
            ? raster.naturalWidth / raster.naturalHeight
            : 1;
        const src = t.href;
        out.push({
          text: OBJECT_REPLACEMENT,
          style: inherited,
          object: {
            width: height * aspect,
            height,
            // Sits on the baseline like a cap-height glyph rather than hanging
            // below it; an image has no descender to align.
            depth: 0,
            // The accessible name, and what a copy yields. Without it the
            // invisible U+FFFC sentinel is all a screen reader receives.
            alt: t.text,
            // What this object PAINTS, which `alt` does not determine: two badges
            // can share alt text and differ in URL. Without it the paragraph memo
            // serves the first one's painter to the second and every row of a badge
            // column draws the first row's badge.
            key: src,
            paint: (surface, box) => paintInlineImage(src, surface, box),
          },
        });
        break;
      }
      case 'footnoteRef': {
        // A reference marker: smaller than the run it sits in, raised, and
        // tinted. Without this arm the token would fall to `default:`, which
        // pushes `.text` — and the token has no `text` field, so the marker
        // would silently vanish and the sentence would read as though the
        // reference had never been written.
        //
        // A TRUE superscript now that `TextStyle.baselineShift` exists
        // (`DEC-0001`) — this arm used to signal by size alone, since faking a
        // raise through an inline object would have meant rasterizing text
        // (`InlineObjectSurface` exposes only `drawImage`). Reuses
        // `theme.superscriptShift` rather than a footnote-specific constant:
        // there is nothing footnote-specific about how far a raised run sits
        // above the baseline, only about how small it is.
        //
        // No `href`. A marker is a cross-reference to a sibling block, not a URL,
        // and giving it one would underline it and route a click to the consumer's
        // `onLinkClick` with a destination that does not exist.
        const t = token as unknown as { label: string };
        const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
        out.push({
          text: footnoteMarker(t.label),
          style: {
            ...inherited,
            fontSize: runSize * theme.footnoteMarkerScale,
            baselineShift: runSize * theme.superscriptShift,
            color: theme.footnoteColor,
          },
        });
        break;
      }
      case 'sup': {
        // `markdown-it`-style superscript (`19^th^`): shrink and raise, the
        // mirror image of the single-tilde subscript arm above. New token type
        // (`markdown-superscript.ts`), not an existing one repurposed — nothing
        // in `marked`'s own grammar tokenizes bare `^…^` at all.
        const t = token as unknown as { text: string };
        const runSize = inherited.fontSize ?? blockFontSize ?? theme.fontSize;
        emitProse(
          decodeProse(t.text, theme),
          {
            ...inherited,
            fontSize: runSize * theme.superscriptScale,
            baselineShift: runSize * theme.superscriptShift,
          },
          abbr,
          out,
        );
        break;
      }
      case 'ins': {
        // `markdown-it-ins`-style insert (`++inserted++`): underline, the same
        // shape as `del`'s strikethrough but as a plain boolean flag rather
        // than a color, matching `TextStyle.underline`. New token type
        // (`markdown-ins-mark.ts`) — nothing in `marked`'s own grammar
        // tokenizes bare `++…++` at all.
        const t = token as unknown as { text: string };
        emitProse(decodeProse(t.text, theme), { ...inherited, underline: true }, abbr, out);
        break;
      }
      case 'mark': {
        // `markdown-it-mark`-style highlight (`==marked==`): a background fill
        // behind the run, at the theme's default highlight color.
        // `TextStyle.highlightColor` is a color rather than a boolean because,
        // unlike `underline`/`lineThrough`, CSS `mark` has no inherent color of
        // its own to imply — see that field's doc for why.
        const t = token as unknown as { text: string };
        emitProse(
          decodeProse(t.text, theme),
          { ...inherited, highlightColor: theme.markHighlightColor },
          abbr,
          out,
        );
        break;
      }
      case 'emoji': {
        // `:wink:`-style shortcode, already resolved to its character by
        // `markdown-emoji.ts`'s tokenizer — an unknown shortcode never
        // reaches this arm at all (the tokenizer returns `undefined` and lets
        // `inlineText` carry the literal `:name:` through as plain text). No
        // style change: the resolved character is exactly a run of plain
        // text, colored/sized/weighted like any other codepoint the browser's
        // font stack shapes via `fillText`. Mirrors the `text` arm's
        // `style: undefined` convention when `inherited` carries no
        // overrides, rather than pushing an empty `{}` — the two arms must
        // agree, since an emoji can appear either bare or nested inside bold/
        // italic/etc, exactly like plain text can.
        const t = token as unknown as { text: string };
        const style = Object.keys(inherited).length > 0 ? inherited : undefined;
        out.push({ text: t.text, style });
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        // Recurse into link children (they may contain bold/italic/code)
        const linkStyle: TextStyle = {
          ...inherited,
          href: t.href,
          color: theme.linkColor,
        };
        // An autolink (`<http://…>`, or a bare URL GFM autolinks) never has a
        // `title` key at all — even a bracket-form link with no title carries
        // `title: null`. Its visible text is the URL itself, not authored prose,
        // so it must never be typographer-rewritten: `--` in a path segment is
        // part of the address, not a dash a reader typed as punctuation.
        const isAutolink = !('title' in t);
        if (isAutolink) {
          out.push({ text: t.text, style: linkStyle });
        } else if (t.tokens && t.tokens.length > 0) {
          collectSpans(t.tokens, linkStyle, theme, out, blockFontSize, abbr);
        } else {
          emitProse(decodeProse(t.text, theme), linkStyle, abbr, out);
        }
        break;
      }
      case 'text': {
        const t = token as Tokens.Text;
        // Text tokens may themselves contain nested inline tokens (e.g. from
        // paragraph splitting).  Recurse when present.
        if ('tokens' in t && (t as any).tokens?.length) {
          collectSpans((t as any).tokens, inherited, theme, out, blockFontSize, abbr);
        } else {
          const decoded = decodeProse(t.text, theme);
          const style = Object.keys(inherited).length > 0 ? inherited : undefined;
          emitProse(decoded, style, abbr, out);
        }
        break;
      }
      default: {
        // Fallback: grab raw `.text` if available
        if ('text' in token) {
          const decoded = decodeProse((token as any).text, theme);
          const style = Object.keys(inherited).length > 0 ? inherited : undefined;
          emitProse(decoded, style, abbr, out);
        }
        break;
      }
    }
  }
}

/**
 * One trailing inline construct that has opened but not closed yet.
 *
 * `at` is the index in the scanned text of the construct's first syntax
 * character, so the caller can split there: everything before it keeps whatever
 * `marked` already decided, everything after it is the construct's content.
 */
export interface UnclosedInline {
  kind: 'strong' | 'em' | 'codespan' | 'link';
  /** Index of the opening marker's first character. */
  at: number;
  /** Index just past the opening marker, where the content starts. */
  contentAt: number;
}

/**
 * Find the last unclosed inline construct in one trailing text run.
 *
 * Only ever called with the text of the FINAL inline token of the document's
 * final paragraph. That is the only place an unclosed construct can be: a
 * construct that closed is already its own `strong`/`em`/`codespan`/`link`
 * token, so whatever syntax characters survive into a plain text token are
 * exactly the ones `marked` could not pair up.
 *
 * Returns `null` when nothing plausible is open, which is the common case and
 * must stay cheap — this runs once per streamed chunk.
 */
export function findUnclosedInline(text: string): UnclosedInline | null {
  let best: UnclosedInline | null = null;

  // Backtick first, and it wins outright. Inside a code span nothing else is
  // syntax, so an emphasis marker to the right of an open backtick is content,
  // not a competing candidate.
  const tick = text.lastIndexOf('`');
  if (tick !== -1 && tick < text.length - 1) {
    return { kind: 'codespan', at: tick, contentAt: tick + 1 };
  }
  if (tick !== -1) return null;

  // `**bo` / `*it`, and the `_` forms. Two requirements, both load-bearing:
  // the marker run must be WHOLE (`\*{1,2}(?!\*)`), or `**` alone matches as a
  // single `*` opening on a content of `*` and renders one italic asterisk; and
  // it must be followed by a non-space, since CommonMark cannot open emphasis on
  // `* ` and a marker with nothing after it has no content to style.
  const emphasis = /(\*{1,2}(?!\*)|_{1,2}(?!_))(?=[^\s])/g;
  for (let match = emphasis.exec(text); match !== null; match = emphasis.exec(text)) {
    const marker = match[1];
    const at = match.index;
    // `_` cannot open emphasis intraword (`snake_case`, `a_b`), so requiring a
    // boundary before it is what keeps identifiers from turning italic
    // mid-stream. `*` has no such restriction in CommonMark.
    if (marker[0] === '_' && at > 0 && /[\w]/.test(text[at - 1])) continue;
    best = {
      kind: marker.length === 2 ? 'strong' : 'em',
      at,
      contentAt: at + marker.length,
    };
  }

  // `[label](url` — an unmatched `[` with no completed `](…)` after it. Checked
  // last and only when it opens to the right of any emphasis candidate, for the
  // same reason backticks win: the later opener is the one still collecting text.
  const bracket = text.lastIndexOf('[');
  if (bracket !== -1 && bracket < text.length - 1 && (best === null || bracket > best.at)) {
    const closed = /\]\([^)]*\)/.test(text.slice(bracket));
    if (!closed) {
      best = { kind: 'link', at: bracket, contentAt: bracket + 1 };
    }
  }

  return best;
}

/** Parse inline markdown tokens and produce a {@link RichText} entity. */
export function renderInlineToRichText(
  tokens: Token[] | undefined,
  fallbackText: string,
  font: string,
  color: string,
  maxWidth: number,
  theme: Required<MarkdownTheme>,
  selectable: boolean,
  onLinkClick?: (url: string) => void,
  /** The document's `*[TERM]: definition` dictionary — see {@link emitProse}. */
  abbr: ReadonlyMap<string, string> = NO_ABBREVIATIONS,
): RichText {
  const spans: StyledSpan[] = [];
  if (tokens && tokens.length > 0) {
    // `blockFontSize` carries the block's own size to the inline-math arm. A
    // heading's size lives only in this `font` string — its spans carry no
    // `fontSize` — so without it an `$x$` in an `h1` would reserve a body-sized
    // box. Passed as its own argument rather than seeded into `inherited` so no
    // text span gains an explicit fontSize it did not have before, which would
    // change every heading's paragraph-memo key.
    collectSpans(tokens, {}, theme, spans, fontSizeFromFont(font), abbr);
  }
  // Fallback: if no spans were produced, use the raw text
  if (spans.length === 0) {
    spans.push({ text: decodeEntities(fallbackText) });
  }
  return new RichText(spans, {
    font,
    color,
    maxWidth,
    linkColor: theme.linkColor,
    selectable,
    onLinkClick,
  });
}
