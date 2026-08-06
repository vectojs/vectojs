import { OBJECT_REPLACEMENT, type StyledSpan, type TextStyle } from '@vectojs/core';
import { RichText } from '@vectojs/ui';
import type { Token, Tokens } from 'marked';

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
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const t = token as Tokens.Strong;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, bold: true }, theme, out, blockFontSize);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, bold: true },
          });
        }
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, italic: true }, theme, out, blockFontSize);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, italic: true },
          });
        }
        break;
      }
      case 'del': {
        // GFM `~~deleted~~`. Without this arm the token fell to `default:`, which
        // pushes its text unstyled — the content rendered, so the omission looked
        // like plain text rather than a missing feature.
        const t = token as Tokens.Del;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, lineThrough: true }, theme, out, blockFontSize);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, lineThrough: true },
          });
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
      case 'link': {
        const t = token as Tokens.Link;
        // Recurse into link children (they may contain bold/italic/code)
        const linkStyle: TextStyle = {
          ...inherited,
          href: t.href,
          color: theme.linkColor,
        };
        if (t.tokens && t.tokens.length > 0) {
          collectSpans(t.tokens, linkStyle, theme, out, blockFontSize);
        } else {
          out.push({ text: decodeEntities(t.text), style: linkStyle });
        }
        break;
      }
      case 'text': {
        const t = token as Tokens.Text;
        // Text tokens may themselves contain nested inline tokens (e.g. from
        // paragraph splitting).  Recurse when present.
        if ('tokens' in t && (t as any).tokens?.length) {
          collectSpans((t as any).tokens, inherited, theme, out, blockFontSize);
        } else {
          const decoded = decodeEntities(t.text);
          if (decoded) {
            const style = Object.keys(inherited).length > 0 ? inherited : undefined;
            out.push({ text: decoded, style });
          }
        }
        break;
      }
      default: {
        // Fallback: grab raw `.text` if available
        if ('text' in token) {
          const decoded = decodeEntities((token as any).text);
          if (decoded) {
            const style = Object.keys(inherited).length > 0 ? inherited : undefined;
            out.push({ text: decoded, style });
          }
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
): RichText {
  const spans: StyledSpan[] = [];
  if (tokens && tokens.length > 0) {
    // `blockFontSize` carries the block's own size to the inline-math arm. A
    // heading's size lives only in this `font` string — its spans carry no
    // `fontSize` — so without it an `$x$` in an `h1` would reserve a body-sized
    // box. Passed as its own argument rather than seeded into `inherited` so no
    // text span gains an explicit fontSize it did not have before, which would
    // change every heading's paragraph-memo key.
    collectSpans(tokens, {}, theme, spans, fontSizeFromFont(font));
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
