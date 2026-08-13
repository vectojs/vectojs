import {
  contentLineInHint,
  type ContentProjection,
  type ContentProjectionHint,
  GlyphRasterAtlas,
  type GlyphRasterAtlasStats,
  IRenderer,
  prepareContentGrid,
  type PreparedContentGrid,
} from '@vectojs/core';
import { measureText, UIComponent } from '@vectojs/ui';

import { resolvePresetTheme, type MarkdownThemePresetName } from './markdown-presets';
import type { MarkdownTheme } from './theme';

/**
 * Fenced code blocks: the keyword tables, the per-line highlighter, the
 * `CodeBlock` entity and its shared glyph atlas.
 *
 * Self-contained apart from a type-only edge to `./theme`, so this module has no
 * runtime dependency on `Markdown.ts` and `CodeBlock` can be constructed without
 * loading the component. See `forge/decisions/file-decomposition-2026-08.md`.
 */

/** Keyword sets for basic syntax highlighting. A language may have none and still
 *  be highlighted — see {@link LANGUAGE_SYNTAX}. */
const KEYWORD_SETS: Record<string, Set<string>> = {
  js: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
  ]),
  ts: new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'extends',
    'new',
    'this',
    'import',
    'export',
    'from',
    'default',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'of',
    'in',
    'typeof',
    'instanceof',
    'switch',
    'case',
    'break',
    'continue',
    'null',
    'undefined',
    'true',
    'false',
    'type',
    'interface',
    'enum',
    'as',
    'is',
    'readonly',
    'implements',
    'abstract',
    'public',
    'private',
    'protected',
    'static',
    'void',
    'never',
    'any',
    'unknown',
  ]),
  py: new Set([
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'import',
    'from',
    'as',
    'with',
    'try',
    'except',
    'raise',
    'finally',
    'pass',
    'break',
    'continue',
    'and',
    'or',
    'not',
    'in',
    'is',
    'None',
    'True',
    'False',
    'yield',
    'lambda',
    'global',
    'nonlocal',
    'del',
    'assert',
    'async',
    'await',
  ]),
  rust: new Set([
    'fn',
    'let',
    'mut',
    'const',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'match',
    'return',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'use',
    'mod',
    'crate',
    'self',
    'super',
    'where',
    'as',
    'in',
    'ref',
    'move',
    'async',
    'await',
    'true',
    'false',
    'type',
    'unsafe',
    'extern',
    'dyn',
    'static',
  ]),
};

KEYWORD_SETS['bash'] = new Set([
  // Shell builtins and control words. Deliberately not the whole of coreutils:
  // a keyword table that includes every command name colors an entire script
  // uniformly, which reads worse than coloring only the control flow.
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'return',
  'exit',
  'break',
  'continue',
  'local',
  'export',
  'readonly',
  'declare',
  'unset',
  'shift',
  'source',
  'alias',
  'set',
  'trap',
  'echo',
  'cd',
  'sudo',
  'true',
  'false',
]);

KEYWORD_SETS['json'] = new Set(['true', 'false', 'null']);

KEYWORD_SETS['css'] = new Set([
  'important',
  'inherit',
  'initial',
  'unset',
  'revert',
  'auto',
  'none',
  'var',
  'calc',
]);

KEYWORD_SETS['html'] = new Set([
  // Tag names are the meaningful tokens a reader scans for. The tokenizer is
  // word-based, so `<div>` yields the word `div`.
  'html',
  'head',
  'body',
  'title',
  'meta',
  'link',
  'script',
  'style',
  'div',
  'span',
  'p',
  'a',
  'img',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'td',
  'th',
  'form',
  'input',
  'button',
  'label',
  'select',
  'option',
  'textarea',
  'header',
  'footer',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'canvas',
  'svg',
  'template',
  'slot',
]);

// Aliases
KEYWORD_SETS['javascript'] = KEYWORD_SETS['js'];
KEYWORD_SETS['typescript'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['python'] = KEYWORD_SETS['py'];
KEYWORD_SETS['rs'] = KEYWORD_SETS['rust'];
// Dialects onto their base. The lookup is exact-match after lowercasing, so
// without these a superset of a covered language got nothing at all — `jsx` was
// the telling case.
KEYWORD_SETS['jsx'] = KEYWORD_SETS['js'];
KEYWORD_SETS['mjs'] = KEYWORD_SETS['js'];
KEYWORD_SETS['cjs'] = KEYWORD_SETS['js'];
KEYWORD_SETS['tsx'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['mts'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['cts'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['sh'] = KEYWORD_SETS['bash'];
KEYWORD_SETS['zsh'] = KEYWORD_SETS['bash'];
KEYWORD_SETS['shell'] = KEYWORD_SETS['bash'];
KEYWORD_SETS['console'] = KEYWORD_SETS['bash'];
KEYWORD_SETS['jsonc'] = KEYWORD_SETS['json'];
KEYWORD_SETS['json5'] = KEYWORD_SETS['json'];
KEYWORD_SETS['scss'] = KEYWORD_SETS['css'];
KEYWORD_SETS['sass'] = KEYWORD_SETS['css'];
KEYWORD_SETS['less'] = KEYWORD_SETS['css'];
KEYWORD_SETS['vue'] = KEYWORD_SETS['html'];
KEYWORD_SETS['svelte'] = KEYWORD_SETS['html'];
KEYWORD_SETS['xml'] = KEYWORD_SETS['html'];
KEYWORD_SETS['svg'] = KEYWORD_SETS['html'];

/**
 * Per-language lexical syntax, separate from the keyword table.
 *
 * The comment prefix used to be hardcoded in the tokenizer — `//` for every
 * language and `#` only for Python and Rust — so a shell script's `#` comments
 * were never colored even where the keyword lookup succeeded. Describing the
 * syntax per language instead means adding a language is a table entry rather
 * than a new branch in the tokenizer.
 *
 * `quotes` exists because the quote characters are not universal: a `'` in shell
 * is a string delimiter, but in Rust it also opens a lifetime (`&'a str`), and a
 * backtick is a template literal in JS while it is command substitution in
 * shell. JSON has no single-quoted strings at all.
 */
interface LanguageSyntax {
  /** Line-comment prefixes, longest first so `//` is tried before `/`. */
  lineComments: readonly string[];
  /** Quote characters that open a string on this line. */
  quotes: readonly string[];
  /** Whether numeric literals are meaningful enough to color. */
  numbers: boolean;
  /**
   * Block-comment delimiters as `[open, close]` pairs, which may span lines.
   *
   * Separate from {@link lineComments} because the two need different handling,
   * not merely different text: a line comment always ends at the end of its line,
   * so it needs no state, while a block comment carries a "still inside a
   * comment" flag to the next line. Before this existed the tokenizer was purely
   * per-line, so a slash-star comment coloured only its first line and every
   * line after it was painted as live code — the most visible highlighting gap
   * left, and the reason CSS claimed no comment support at all.
   */
  blockComments?: readonly (readonly [string, string])[];
  /**
   * String delimiters that may span lines, e.g. a JS template literal or a
   * Python docstring.
   *
   * Distinct from {@link quotes}, whose members must close on their own line to
   * colour at all (a deliberate guard so a Rust lifetime or an apostrophe cannot
   * swallow the rest of the line). A delimiter listed here is unambiguous enough
   * that an unterminated one really does continue, so it is safe to carry.
   *
   * Longest-first within the list, so Python's `"""` is tried before `"`.
   */
  multilineStrings?: readonly string[];
}

const C_LIKE: LanguageSyntax = {
  lineComments: ['//'],
  quotes: ['"', "'", '`'],
  numbers: true,
  blockComments: [['/*', '*/']],
  // A JS/TS template literal spans lines. Listed here as well as in `quotes`:
  // `quotes` handles the common single-line case, and this carries the rest.
  multilineStrings: ['`'],
};

const HASH_COMMENT: LanguageSyntax = {
  lineComments: ['#'],
  quotes: ['"', "'"],
  numbers: true,
};

const LANGUAGE_SYNTAX: Record<string, LanguageSyntax> = {
  js: C_LIKE,
  ts: C_LIKE,
  // A Python docstring is the language's block comment in practice, and it is
  // lexically a string, so it is carried as one rather than invented as a third
  // kind. Triple delimiters are listed before the single ones so the longest
  // match wins.
  py: { ...HASH_COMMENT, multilineStrings: ['"""', "'''"] },
  // Rust has `//` line comments AND `'` lifetimes. The unterminated-quote
  // fallback already keeps a lifetime from swallowing the line, so `'` stays
  // listed: `'a'` is a valid char literal and should color as a string.
  rust: C_LIKE,
  bash: HASH_COMMENT,
  // JSON has no comments and no single-quoted strings. JSONC does have `//`,
  // and is aliased separately below rather than sharing this entry.
  json: { lineComments: [], quotes: ['"'], numbers: true },
  // CSS has only block comments — which now span lines, so this entry claims
  // them. Numbers are everywhere in CSS and coloring them is most of the visible
  // benefit.
  css: {
    lineComments: [],
    quotes: ['"', "'"],
    numbers: true,
    blockComments: [['/*', '*/']],
  },
  // Markup: no line comments, and numbers inside attribute values are noise
  // rather than signal. An SGML comment spans lines like any other block form.
  html: {
    lineComments: [],
    quotes: ['"', "'"],
    numbers: false,
    blockComments: [['<!--', '-->']],
  },
};

LANGUAGE_SYNTAX['javascript'] = LANGUAGE_SYNTAX['js'];
LANGUAGE_SYNTAX['typescript'] = LANGUAGE_SYNTAX['ts'];
LANGUAGE_SYNTAX['python'] = LANGUAGE_SYNTAX['py'];
LANGUAGE_SYNTAX['rs'] = LANGUAGE_SYNTAX['rust'];
LANGUAGE_SYNTAX['jsx'] = LANGUAGE_SYNTAX['js'];
LANGUAGE_SYNTAX['mjs'] = LANGUAGE_SYNTAX['js'];
LANGUAGE_SYNTAX['cjs'] = LANGUAGE_SYNTAX['js'];
LANGUAGE_SYNTAX['tsx'] = LANGUAGE_SYNTAX['ts'];
LANGUAGE_SYNTAX['mts'] = LANGUAGE_SYNTAX['ts'];
LANGUAGE_SYNTAX['cts'] = LANGUAGE_SYNTAX['ts'];
LANGUAGE_SYNTAX['sh'] = LANGUAGE_SYNTAX['bash'];
LANGUAGE_SYNTAX['zsh'] = LANGUAGE_SYNTAX['bash'];
LANGUAGE_SYNTAX['shell'] = LANGUAGE_SYNTAX['bash'];
LANGUAGE_SYNTAX['console'] = LANGUAGE_SYNTAX['bash'];
LANGUAGE_SYNTAX['yaml'] = HASH_COMMENT;
LANGUAGE_SYNTAX['yml'] = HASH_COMMENT;
LANGUAGE_SYNTAX['toml'] = HASH_COMMENT;
LANGUAGE_SYNTAX['ini'] = HASH_COMMENT;
LANGUAGE_SYNTAX['dockerfile'] = HASH_COMMENT;
LANGUAGE_SYNTAX['makefile'] = HASH_COMMENT;
LANGUAGE_SYNTAX['make'] = HASH_COMMENT;
LANGUAGE_SYNTAX['jsonc'] = { lineComments: ['//'], quotes: ['"'], numbers: true };
LANGUAGE_SYNTAX['json5'] = { lineComments: ['//'], quotes: ['"', "'"], numbers: true };
LANGUAGE_SYNTAX['scss'] = C_LIKE;
LANGUAGE_SYNTAX['sass'] = C_LIKE;
LANGUAGE_SYNTAX['less'] = C_LIKE;
LANGUAGE_SYNTAX['glsl'] = C_LIKE;
LANGUAGE_SYNTAX['c'] = C_LIKE;
LANGUAGE_SYNTAX['cpp'] = C_LIKE;
LANGUAGE_SYNTAX['go'] = C_LIKE;
LANGUAGE_SYNTAX['java'] = C_LIKE;
LANGUAGE_SYNTAX['kotlin'] = C_LIKE;
LANGUAGE_SYNTAX['swift'] = C_LIKE;
LANGUAGE_SYNTAX['vue'] = LANGUAGE_SYNTAX['html'];
LANGUAGE_SYNTAX['svelte'] = LANGUAGE_SYNTAX['html'];
LANGUAGE_SYNTAX['xml'] = LANGUAGE_SYNTAX['html'];
LANGUAGE_SYNTAX['svg'] = LANGUAGE_SYNTAX['html'];

/**
 * Languages this build can highlight, for an app that wants to check before
 * rendering. A language appears here when it has syntax, keywords, or both.
 */
export function highlightedLanguages(): string[] {
  return [...new Set([...Object.keys(LANGUAGE_SYNTAX), ...Object.keys(KEYWORD_SETS)])].sort();
}

/** Segment of highlighted code text. */
interface CodeSegment {
  text: string;
  color: string;
}

/**
 * Lexical state carried across a line boundary, or `null` at the top level.
 *
 * This is what makes the highlighter more than per-line. It is deliberately a
 * single open construct rather than a stack: none of the forms it tracks nest in
 * the languages described here (C block comments do not nest, and a string
 * cannot contain an unescaped copy of its own delimiter), so a stack would model
 * a generality that does not exist and would need a policy for unbalanced input.
 */
type CarryState = {
  /** Which colour the carried run paints in. */
  kind: 'comment' | 'string';
  /** The delimiter that ends it. */
  close: string;
} | null;

/** One highlighted line plus the state it hands to the next. */
interface HighlightedLine {
  segments: CodeSegment[];
  carry: CarryState;
}

/**
 * Tokenize a line of code into colored segments (keyword / string / comment /
 * default), continuing whatever construct `carry` left open.
 *
 * Per-line rather than whole-document because that is what streaming needs: an
 * append re-highlights only the lines after the last stable one
 * ({@link CodeBlock.buildLines}), and a whole-document tokenizer would make each
 * chunk O(document). `carry` is the minimum state that buys correct multi-line
 * constructs without giving that up.
 */
function highlightLine(
  line: string,
  lang: string,
  theme: Required<MarkdownTheme>,
  carry: CarryState = null,
): HighlightedLine {
  // Normalize here rather than at construction: `lang` is public and settable
  // through `setCode()`, and a fence writes it verbatim, so ```Bash / ```BASH /
  // ```bash all had to resolve to one entry. A fence info string can also carry
  // attributes (```ts title="x"), so only the first token is the language.
  const key =
    lang
      .trim()
      .toLowerCase()
      .split(/[\s:,{]/)[0] ?? '';
  const keywords = KEYWORD_SETS[key];
  const syntax = LANGUAGE_SYNTAX[key];
  // Bail out only when the language is unknown on BOTH tables. Gating the whole
  // tokenizer on the keyword lookup meant an unknown language lost its comments,
  // strings and numbers too — and those, not the keywords, are most of the
  // visible benefit for a shell-heavy document.
  if (!keywords && !syntax) {
    return { segments: [{ text: line, color: theme.codeColor }], carry: null };
  }

  const segments: CodeSegment[] = [];
  const KEYWORD_COLOR = theme.syntaxKeywordColor;
  const STRING_COLOR = theme.syntaxStringColor;
  const COMMENT_COLOR = theme.syntaxCommentColor;
  const NUMBER_COLOR = theme.syntaxNumberColor;

  let i = 0;
  let buf = '';

  const flush = (color: string) => {
    if (buf) {
      segments.push({ text: buf, color });
      buf = '';
    }
  };

  // A language present only in the keyword table keeps the previous C-like
  // lexical rules, so an app that registered keywords by hand is unaffected.
  const lexical = syntax ?? C_LIKE;

  /**
   * Index just past `close` at or after `from`, or `-1` when it does not close on
   * this line.
   *
   * Escapes are skipped only for a string: a backslash has no meaning inside a C
   * block comment, so honouring one there would let a line ending in `\` hide the
   * `*` of a following close delimiter.
   */
  const findClose = (from: number, close: string, isString: boolean): number => {
    let j = from;
    while (j < line.length) {
      if (isString && line[j] === '\\') {
        j += 2;
        continue;
      }
      if (line.startsWith(close, j)) return j + close.length;
      j++;
    }
    return -1;
  };

  // Finish what the previous line left open, before any token rule runs: inside a
  // carried comment or string nothing is a keyword, a number, or a new comment.
  if (carry) {
    const color = carry.kind === 'comment' ? COMMENT_COLOR : STRING_COLOR;
    const end = findClose(0, carry.close, carry.kind === 'string');
    if (end === -1) {
      // Still open at end of line. An empty line inside a block comment produces
      // no segment, which is correct — there is nothing to paint — and the state
      // still propagates.
      if (line.length > 0) segments.push({ text: line, color });
      return { segments, carry };
    }
    segments.push({ text: line.slice(0, end), color });
    i = end;
  }

  while (i < line.length) {
    const ch = line[i];

    // Block comments first, and they may run past this line. Checked before line
    // comments because both can start with the same character (`/*` vs `//`) and
    // an exact-prefix match is what disambiguates them.
    const block = lexical.blockComments?.find(([open]) => line.startsWith(open, i));
    if (block) {
      const [open, close] = block;
      flush(theme.codeColor);
      const end = findClose(i + open.length, close, false);
      if (end === -1) {
        segments.push({ text: line.slice(i), color: COMMENT_COLOR });
        return { segments, carry: { kind: 'comment', close } };
      }
      segments.push({ text: line.slice(i, end), color: COMMENT_COLOR });
      i = end;
      continue;
    }

    // Line comments, from the language's own table rather than hardcoded. Tried
    // longest-first so `//` wins over a hypothetical `/`.
    const comment = lexical.lineComments.find((prefix) => line.startsWith(prefix, i));
    if (comment !== undefined) {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return { segments, carry: null };
    }

    // Multi-line string delimiters, before the single-line `quotes` rule: the two
    // overlap (Python's `"""` begins with `"`, a JS backtick is in both lists) and
    // the longer, unambiguous form has to win. Unlike `quotes` an unterminated one
    // is CARRIED rather than dropped, which is exactly the difference between the
    // two lists — see `LanguageSyntax.multilineStrings`.
    const multi = lexical.multilineStrings?.find((delim) => line.startsWith(delim, i));
    if (multi !== undefined) {
      flush(theme.codeColor);
      const end = findClose(i + multi.length, multi, true);
      if (end === -1) {
        segments.push({ text: line.slice(i), color: STRING_COLOR });
        return { segments, carry: { kind: 'string', close: multi } };
      }
      segments.push({ text: line.slice(i, end), color: STRING_COLOR });
      i = end;
      continue;
    }

    // Strings. Only colored when the quote actually CLOSES on this line —
    // otherwise a stray quote (a Rust lifetime `&'a str`, an apostrophe in an
    // identifier or trailing prose, a generic `'` in shell) would swallow the
    // whole rest of the line as a green "string". An unterminated quote falls
    // through and is treated as ordinary punctuation.
    if (lexical.quotes.includes(ch)) {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2; // skip the escape and whatever it escapes
          continue;
        }
        if (line[j] === quote) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        flush(theme.codeColor);
        segments.push({ text: line.slice(i, j + 1), color: STRING_COLOR });
        i = j + 1; // past the closing quote
        continue;
      }
      // Unterminated: emit as plain text and move on.
      buf += ch;
      i++;
      continue;
    }

    // Numbers
    if (
      lexical.numbers &&
      /\d/.test(ch) &&
      (i === 0 || /[\s(,=+\-*/<>[\]{}:;]/.test(line[i - 1]))
    ) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[\d._xXa-fA-F]/.test(line[j])) j++;
      segments.push({ text: line.slice(i, j), color: NUMBER_COLOR });
      i = j;
      continue;
    }

    // Word boundaries (potential keywords)
    if (/[a-zA-Z_]/.test(ch)) {
      flush(theme.codeColor);
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      segments.push({
        text: word,
        // A language may have lexical syntax but no keywords (plain YAML, TOML,
        // a Dockerfile). Those still get comments, strings and numbers.
        color: keywords?.has(word) ? KEYWORD_COLOR : theme.codeColor,
      });
      i = j;
      continue;
    }

    buf += ch;
    i++;
  }

  flush(theme.codeColor);
  return { segments, carry: null };
}

// ── Single CodeBlock entity ─────────────────────────────────────────────────

/**
 * The wheel payload {@link CodeBlock} consumes to scroll horizontally.
 *
 * Structural rather than `WheelEvent`, because the entity is driven by a
 * `VectoJSEvent` wrapper whose `nativeEvent` is the DOM event.
 */
interface CodeWheelEvent {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  /** Shift+wheel is the conventional "scroll the other axis" modifier. */
  shiftKey?: boolean;
  /** Ctrl+wheel is browser zoom and must never be consumed. */
  ctrlKey?: boolean;
  nativeEvent?: { preventDefault?: () => void };
}

/** Optional behaviour for {@link CodeBlock}. */
export interface CodeBlockOptions {
  /**
   * Draw a header band across the top of the block showing the language name.
   *
   * Off by default, and the default is not merely conservative: the band costs
   * vertical space in every block of a document, and a label is worth that only
   * where a document actually mixes languages. A single-language page gets the
   * same word repeated down its length.
   *
   * Turning it on also RESERVES that space, which is what makes the block's
   * own affordance controls stop overlapping the first line of code — measured
   * before this existed: the controls occupied y 8-32 while line one occupied
   * y 18-42, a 14px overlap in the default theme.
   *
   * The reserved height keeps `height` a pure function of line count (the
   * invariant {@link CodeBlock.setWidth} documents); it only changes the
   * constant term.
   */
  showLanguage?: boolean;
}

/**
 * A single self-rendering entity for fenced code blocks.
 *
 * Replaces the old N×M child-entity explosion (Container → Stack → Text per
 * segment per line) with a flat leaf that draws its own background + text.
 */
export class CodeBlock extends UIComponent {
  private lines: CodeSegment[][];
  /**
   * Lexical state ENTERING each line, index-aligned with {@link lines}.
   *
   * Entering rather than leaving, so a streamed append can resume tokenizing at
   * the prefix-reuse boundary by reading one entry instead of re-scanning the
   * document for an unclosed block comment.
   */
  private lineCarry: CarryState[] = [];
  private grid: PreparedContentGrid | null = null;
  /** Raw (unhighlighted) lines of the last build, for prefix reuse in buildLines. */
  private rawLines: string[] | null = null;
  /**
   * Language the highlight segments were built under. Prefix reuse compares
   * raw line text only, so a `setCode(code, otherLang)` with byte-identical
   * lines would reuse segments highlighted with the WRONG language; the reuse
   * predicate must also require this to equal the current `lang`.
   */
  private highlightLang: string | null = null;
  private cellWidth = 0;
  private source: string;
  /** Bumped by {@link buildLines} and {@link setSelectable}; read by `Scene`. */
  private contentEpoch = 0;

  /**
   * Horizontal scroll offset in local px, always in `[0, maxScrollX]`.
   *
   * Code does not wrap, so a line wider than the box would otherwise have an
   * unreachable tail. This offset is subtracted from BOTH the painted cell x and
   * the projected line x in the same frame — never one without the other, or the
   * DOM selection carriers detach from the glyphs they are supposed to cover
   * (the defect class `5cf7119` and `ee1de6f` fixed on the vertical axis).
   */
  private scrollXValue = 0;
  /** Memoized widest prepared line, keyed by the grid identity it came from. */
  private contentWidthGrid: PreparedContentGrid | null = null;
  private contentWidthValue = 0;

  private lang: string;
  private theme: Required<MarkdownTheme>;
  /**
   * Assigned in the constructor rather than as a field initializer: both come
   * from `theme`, and a field initializer runs before the constructor body has
   * a `theme` to read.
   */
  private lineH: number;
  private pad: number;
  private codeFont: string;
  public selectable: boolean;
  /** Whether the language header band is drawn. See {@link CodeBlockOptions.showLanguage}. */
  private showLanguage: boolean;
  /** Font of the header label, resolved once from the theme. */
  private langFont: string;

  /**
   * @param theme Any subset of {@link MarkdownTheme}, or the name of a built-in
   *   preset (see {@link MarkdownThemePresetName}). Accepting a partial theme
   *   keeps callers that were written against an earlier, smaller
   *   `MarkdownTheme` working — this class is public API, and a hand-built
   *   theme literal would otherwise start throwing
   *   `lineHeight must be a positive finite number` the moment a new size key
   *   was added. Resolved through {@link resolvePresetTheme} so `CodeBlock` can
   *   be constructed directly with a preset name without going through
   *   `Markdown`.
   */
  constructor(
    code: string,
    lang: string,
    maxWidth: number,
    theme: MarkdownThemePresetName | MarkdownTheme,
    selectable = true,
    options: CodeBlockOptions = {},
  ) {
    super();
    const resolved = resolvePresetTheme(theme);
    this.source = code;
    this.lang = lang;
    this.theme = resolved;
    this.lineH = resolved.codeLineHeight;
    this.pad = resolved.codePadding;
    this.codeFont = `${resolved.codeFontSize}px ${resolved.codeFont}`;
    this.selectable = selectable;
    this.langFont = `${resolved.codeLangFontSize}px ${resolved.codeFont}`;
    // Only when there is a language to name. A bare ``` fence would otherwise
    // reserve a band and paint nothing into it, which is worse than no band:
    // the reader sees unexplained empty space above the code.
    this.showLanguage = options.showLanguage === true && this.languageLabel() !== '';

    this.lines = [];
    this.width = maxWidth;
    this.buildLines(code);

    // Wheel arrives through the content-projection div, which `Scene` gives an
    // unconditional wheel listener when it creates it (`Scene.ts:4401`). So this
    // works WITHOUT `interactive`, and that matters: an interactive entity gets
    // an a11y shadow node with `pointer-events: auto` that stacks above the
    // transparent text mirror and swallows the mousedown, so native
    // drag-selection would never start (measured, `Scene.ts:3260-3269`).
    this.on('wheel', (e: CodeWheelEvent) => {
      const max = this.maxScrollX;
      if (max <= 0) return;
      // Ctrl+wheel is browser zoom, never content scroll — same guard as
      // `ScrollView` (`ScrollView.ts:79-81`).
      if (e.ctrlKey === true) return;
      const deltaMode = e.deltaMode ?? 0;
      let deltaX = e.deltaX ?? 0;
      let deltaY = e.deltaY ?? 0;
      if (deltaMode === 1) {
        // Lines.
        deltaX *= 16;
        deltaY *= 16;
      } else if (deltaMode === 2) {
        // Pages.
        deltaX *= this.width;
        deltaY *= this.height;
      }
      // ONLY horizontal intent scrolls the code. A code block is an inline
      // element in a vertically scrolling document, not a scroll container that
      // owns its viewport, so a plain vertical wheel belongs to the page.
      //
      // This deliberately does NOT follow `Tabs`, which the earlier version
      // cited: a `Tabs` strip is a horizontal-only widget with no vertical
      // travel of its own, so borrowing whichever axis moved costs nothing
      // there. Here it cost the page its scroll — measured on a live blog post,
      // a `deltaX: 0, deltaY: 120` wheel over an overflowing block reported
      // `defaultPrevented: true` with `scrollY` unmoved at 1050, so the pointer
      // had to leave the block before the page would scroll at all.
      //
      // Shift+wheel is included because a mouse with no horizontal wheel has no
      // other way to reach the tail, and shift-as-horizontal is the platform
      // convention every browser already applies to `overflow-x` boxes. A
      // trackpad's own horizontal swipe arrives as `deltaX` and needs no
      // modifier.
      const horizontal = e.shiftKey === true ? deltaY || deltaX : deltaX;
      if (horizontal === 0) return;
      const before = this.scrollX;
      // Through `setScrollX`, so the clamp and the content-epoch bump have exactly
      // one implementation.
      this.setScrollX(before + horizontal);
      // Only when the offset actually moved, so a wheel at either end of travel
      // still scrolls the page instead of trapping it inside the code block.
      if (this.scrollX !== before) e.nativeEvent?.preventDefault?.();
    });
  }

  /**
   * The language name shown in the header, or `''` when there is nothing to show.
   *
   * Normalized exactly as the highlighter normalizes its lookup key, so the label
   * and the colouring can never disagree about which language this is: a fence
   * may be written ` ```Bash ` or carry attributes (` ```ts title="a.ts" `), and
   * the label has to be the language, not the raw info string.
   *
   * Lowercased for the same reason `streamdown` lowercases its own
   * (`lib/code-block/header.tsx:15`): the fence's capitalization is incidental,
   * and a document mixing ` ```JS ` with ` ```js ` should not render two
   * different-looking labels for one language.
   */
  private languageLabel(): string {
    return (
      this.lang
        .trim()
        .toLowerCase()
        .split(/[\s:,{]/)[0] ?? ''
    );
  }

  /**
   * Height in px of the header band, or `0` when it is off.
   *
   * The label sits in a band of its own rather than floating over the code,
   * because a translucent overlay above real glyphs is unreadable at small sizes
   * and would fight the horizontal scroll: the code slides under it, so any text
   * drawn on top would collide with a different token every frame.
   */
  private headerHeight(): number {
    if (!this.showLanguage) return 0;
    // Label size plus symmetric breathing room derived from the block's own
    // padding, so a theme that opens the block up opens the header up with it
    // rather than leaving a cramped band on a generous block.
    return this.theme.codeLangFontSize + Math.round(this.pad * 0.75);
  }

  /**
   * Local y of the first line of code.
   *
   * Everything that positions a row — the painter, the projection, the grid's
   * own origin — goes through this, so the header offset cannot be applied to
   * one and forgotten on another. That class of mismatch is exactly what
   * detaches selection carriers from the glyphs they cover.
   */
  private contentTop(): number {
    return this.headerHeight() + this.pad;
  }

  /**
   * Current horizontal scroll offset in local px, clamped to what the content
   * currently allows.
   *
   * Clamped on READ, not only on write, because `setWidth()` may shrink the box
   * after a scroll and is contractually forbidden from rebuilding anything. Both
   * the painter and the projection read through here, which is what keeps the
   * glyphs and the selection carriers on the same offset within a frame.
   */
  public get scrollX(): number {
    return Math.min(this.scrollXValue, this.maxScrollX);
  }

  /**
   * Widest line's overflow past the padded box, i.e. the maximum useful
   * {@link scrollX}. `0` when every line already fits.
   */
  public get maxScrollX(): number {
    return Math.max(0, this.contentWidth() - (this.width - this.pad * 2));
  }

  /**
   * Widest prepared line, memoized against the grid that produced it.
   *
   * Read by {@link scrollX}, which both `render()` and `getContentProjection()`
   * call every synced frame, so an O(lines) scan here would be an O(document) cost
   * per frame on a long block — the exact shape the per-line projection window
   * exists to avoid. The grid is rebuilt only when the content changes, so the
   * cache key is identity of the grid object.
   */
  private contentWidth(): number {
    const grid = this.ensureGrid();
    if (this.contentWidthGrid === grid) return this.contentWidthValue;
    let widest = 0;
    for (const line of grid.lines) {
      if (line.width > widest) widest = line.width;
    }
    this.contentWidthGrid = grid;
    this.contentWidthValue = widest;
    return widest;
  }

  /**
   * Scroll horizontally to `x`, clamped to `[0, maxScrollX]`.
   *
   * @returns `this` for chaining.
   */
  public setScrollX(x: number): this {
    const next = Math.max(0, Math.min(this.maxScrollX, x));
    if (next === this.scrollXValue) return this;
    this.scrollXValue = next;
    // The epoch bump is REQUIRED, not bookkeeping: `Scene.syncContentProjection`
    // early-returns when the content epoch and the world transform are both
    // unchanged (`Scene.ts:4288-4312`), and a scroll changes neither — the entity
    // does not move and its text does not change. Without this the painted glyphs
    // would slide while the selection carriers stayed put, which is exactly the
    // detached-selection defect this design must avoid.
    this.contentEpoch++;
    this.scene?.markDirty();
    return this;
  }

  /** Re-parse code content (e.g. for live editing). */
  setCode(code: string, lang?: string): this {
    if (lang !== undefined) this.lang = lang;
    this.source = code;
    this.buildLines(code);
    // New content means a new content width, so an offset valid a moment ago can
    // now point past the end — a streamed block that replaces a long line with a
    // short one would otherwise paint blank. Clamped rather than reset, so
    // scroll position survives an append.
    this.scrollXValue = Math.min(this.scrollXValue, this.maxScrollX);
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native selection for this code block. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    // Projected as `selectable`, and does not rebuild the lines.
    this.contentEpoch++;
    this.scene?.markDirty();
    return this;
  }

  public override getContentEpoch(): number {
    return this.contentEpoch;
  }

  /**
   * Change the block's box width.
   *
   * Deliberately does **not** rebuild the grid or the highlight, because code does
   * not reflow: lines are placed on a fixed monospace grid at `col × cellWidth` and
   * a long line overflows rather than wrapping, so `height` is a function of line
   * *count* alone. The width sizes the rounded background and the clip. Anything
   * that would change the glyph geometry — the source, the language, the font —
   * goes through {@link setCode} and invalidates the grid there.
   *
   * A narrower box can leave {@link scrollX} past the new end of travel. That is
   * resolved by clamping on read rather than by adjusting anything here, so this
   * method keeps costing nothing.
   *
   * @returns `this` for chaining.
   */
  public setWidth(width: number): this {
    const next = Math.max(0, width);
    if (next === this.width) return this;
    this.width = next;
    this.scene?.markDirty();
    return this;
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection | null {
    if (!this.source) return null;
    // Coarse tier: return text only, skip the O(document glyphs) grid build.
    if (hint?.textOnly) {
      return {
        text: this.source,
        font: this.codeFont,
        lineHeight: this.lineH,
        selectable: this.selectable,
        ligatures: 'none',
      };
    }
    const grid = this.ensureGrid();
    // Read once so every row of this projection shares one offset even if the
    // clamp basis were to change mid-walk.
    const scrollX = this.scrollX;
    // Slicing the source per row is O(document) per synced frame, and the grid
    // path is also where the DOM cost concentrates (one carrier per glyph
    // CLUSTER). Building only the rows in the band is what makes a long code
    // block cost the viewport rather than the file.
    //
    // SPARSE, and index-aligned with `grid.lines`. Scene's grid path reads
    // `projection.lines[lineIndex]` by DOCUMENT row (`Scene.ts:4797`), so a
    // compacted array would hand row 900's geometry to row 0 and every carrier
    // would be positioned wrong. Holes simply fall back to the grid's own
    // uniform metrics there, which is exactly what a row outside the band needs.
    const rows: NonNullable<ContentProjection['lines']> = [];
    rows.length = grid.lines.length;
    for (let row = 0; row < grid.lines.length; row++) {
      const line = grid.lines[row];
      const y = this.contentTop() + row * this.lineH;
      if (!contentLineInHint(hint, y, this.lineH)) continue;
      rows[row] = {
        text: this.source.slice(line.sourceStart, line.sourceEnd),
        separatorAfter: this.source.slice(line.sourceEnd, line.nextSourceStart) || undefined,
        // The SAME offset `render()` subtracts, read through the same clamping
        // accessor. Cell carriers are `position: relative` inside this `absolute`
        // line box, so shifting the line's x translates every cell of the line
        // rigidly and selection stays over the glyphs.
        x: this.pad - scrollX,
        y,
        baseline: this.lineH * 0.75,
        font: this.codeFont,
        lineHeight: this.lineH,
      };
    }
    return {
      text: this.source,
      font: this.codeFont,
      lineHeight: this.lineH,
      // Every row is absolutely positioned from the same local coordinates as
      // render(). A single pre-wrap DOM text node would introduce browser
      // wrapping for long source lines that canvas intentionally keeps intact.
      //
      lines: rows,
      selectable: this.selectable,
      // render() draws cell-by-cell (no ligatures can form); the DOM copy
      // must not ligate either or Firefox selection geometry drifts.
      ligatures: 'none',
      // `render()` clips the glyph pass to this box, so the DOM copy must too.
      // A line wider than the box otherwise projects carriers past the entity,
      // and the browser paints their selection highlight over whatever is drawn
      // beside the block — measured 1580px of carrier against a 1566px viewport
      // on a real page, the highlight running through the prose to its right.
      clipToBounds: true,
      grid,
    };
  }

  /**
   * Re-highlight the code, reusing the highlight of any unchanged line prefix.
   *
   * Streaming appends to the END of a block, so all but the last line or two are
   * byte-identical to the previous call — yet this used to re-highlight every
   * line on every chunk, making a streamed block O(N) per append and O(N^2)
   * overall. Reusing the stable prefix makes an append proportional to what
   * actually changed.
   *
   * The last previously-seen line is deliberately NOT reused: a chunk usually
   * lands mid-line, so that line's text (and therefore its tokenization) changes.
   *
   * Prefix reuse survives multi-line constructs because {@link lineCarry} records
   * the state ENTERING each line, so resuming at the reuse boundary needs no
   * rescan: a carried state is a pure function of the preceding text, and that
   * text is byte-identical over the reused prefix by construction.
   */
  private buildLines(code: string): void {
    // The projection reports `source` and the grid built from it; `setCode` is
    // the only path that changes either, and it ends here.
    this.contentEpoch++;
    const rawLines = code.split(/\r\n|\r|\n/);
    const previous = this.rawLines;
    // Longest identical prefix, excluding the previous last line (see above).
    // Reuse additionally requires the SAME language: segments highlight under
    // `lang`, and comparing only raw text would carry segments coloured for
    // the previous language across a `setCode(code, otherLang)` whose lines
    // are byte-identical.
    let reusable = 0;
    if (previous && this.lines.length === previous.length && this.highlightLang === this.lang) {
      const limit = Math.min(previous.length - 1, rawLines.length);
      while (reusable < limit && previous[reusable] === rawLines[reusable]) reusable++;
    }

    const lines = reusable > 0 ? this.lines.slice(0, reusable) : [];
    const carries = reusable > 0 ? this.lineCarry.slice(0, reusable) : [];
    // The state the first re-tokenized line starts in. `lineCarry[reusable]` is
    // that line's own entering state, recorded on the previous build.
    let carry: CarryState = reusable > 0 ? (this.lineCarry[reusable] ?? null) : null;
    for (let i = reusable; i < rawLines.length; i++) {
      carries.push(carry);
      const result = highlightLine(rawLines[i]!, this.lang, this.theme, carry);
      lines.push(result.segments);
      carry = result.carry;
    }
    this.lines = lines;
    this.lineCarry = carries;

    this.rawLines = rawLines;
    this.highlightLang = this.lang;
    this.grid = null;
    // Still a pure function of line COUNT — the header only changes the constant
    // term, so `setWidth()`'s documented invariant holds unchanged.
    this.height = this.contentTop() + this.pad + rawLines.length * this.lineH;
  }

  private ensureGrid(): PreparedContentGrid {
    const cellWidth = this.cellWidth || Math.max(1, measureText('M', this.codeFont));
    if (
      !this.grid ||
      this.grid.source !== this.source ||
      this.grid.font !== this.codeFont ||
      this.grid.cellWidth !== cellWidth
    ) {
      this.grid = prepareContentGrid(this.source, {
        font: this.codeFont,
        cellWidth,
        lineHeight: this.lineH,
        baseline: this.lineH * 0.75,
      });
    }
    return this.grid;
  }

  /**
   * Not hit-testable, and deliberately still not `interactive`, even though the
   * block now consumes wheel events to scroll.
   *
   * The wheel arrives from the content-projection div rather than from canvas
   * hit-testing, so no a11y shadow node is needed. Creating one would place a
   * `pointer-events: auto` element above the transparent text mirror and swallow
   * the mousedown that starts a native drag-selection.
   */
  isPointInside(): boolean {
    return false;
  }

  render(r: IRenderer): void {
    // Background
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.theme.codeRadius);
    r.fill(this.theme.codeBgColor);
    if (this.theme.codeBorderColor && this.theme.codeBorderColor !== 'transparent') {
      r.beginPath();
      r.roundRect(0.5, 0.5, this.width - 1, this.height - 1, this.theme.codeRadius);
      r.stroke(this.theme.codeBorderColor, 1);
    }

    const grid = this.ensureGrid();

    // Per-cluster grid drawing: every grapheme cluster is its own fillText at
    // col × cellWidth. Positioning whole segments on the grid is not enough —
    // Firefox applies OpenType ligatures on Canvas2D (Chrome doesn't), so a
    // run like "ffi affinity" ligates internally, compresses, and leaves a
    // gap before the next segment. Ligatures cannot form across separate
    // fillText calls, which makes the drawn grid identical in every browser
    // (canvas textRendering:'optimizeSpeed' would be cheaper, but Firefox —
    // the one engine that needs it — doesn't implement it). Wide CJK/emoji
    // clusters advance two cells, terminal wcwidth-style, so following
    // tokens no longer overlap them.
    // Where the renderer can blit a source rect, draw each cluster from a shared
    // glyph atlas instead. Identical call count and geometry, but ~2x cheaper per
    // call on both engines because the source texture never changes. A
    // per-run-canvas cache was measured *slower* than fillText on Chrome at scale
    // (0.87x at 40k cells) for exactly that reason — see
    // `forge/baselines/raster-cache-findings.md`.
    const atlas = codeGlyphAtlas(r);
    const atlasSource = atlas?.source ?? null;
    const blit = atlas ? r.drawImageRect : undefined;

    // Clip the glyphs to the block box. A long line does not wrap, so without
    // this it paints through the rounded background and off the viewport edge.
    // `clipChildren` cannot do this job: it clips a node's CHILDREN, and this is
    // a leaf drawing its own glyphs, so the explicit idiom is required.
    //
    // `IRenderer.clip` is rect-only — there is no rounded-corner clip in the
    // interface — so the clip is a hard rect inside a `codeRadius` background and
    // the corner arcs are a few px wider than the clip. Accepted; see
    // `forge/decisions/code-block-overflow-2026-08.md`.
    // Header band, painted before the clip so the label is never affected by the
    // glyph clip below, and before the glyphs so it cannot be overdrawn.
    const header = this.headerHeight();
    if (header > 0) {
      r.fillText(
        this.languageLabel(),
        this.pad,
        // Vertically centred in the band by its own cap height rather than by
        // font size: `fillText` takes a baseline, so centring the em box would
        // sit the visible letterforms low. 0.7 of the label size below the band's
        // centre line is where a lowercase-plus-cap run reads as centred.
        (header + this.theme.codeLangFontSize * 0.7) / 2,
        this.langFont,
        this.theme.codeLangColor,
      );
    }

    r.save();
    // Clipped to start BELOW the header, not at the block's top edge: the code
    // scrolls horizontally under a stationary label, so a band-height clip is
    // what stops a tall glyph or a scrolled line from painting across it.
    r.clip(0, header, this.width, this.height - header);
    // Same clamping accessor the projection reads, so the painted glyphs and the
    // selection carriers cannot disagree about the offset.
    const scrollX = this.scrollX;

    for (let row = 0; row < grid.lines.length; row++) {
      const yBaseline = this.contentTop() + row * this.lineH + this.lineH * 0.75;
      const segments = this.lines[row];
      let segmentIndex = 0;
      let segmentEnd = segments[0]?.text.length ?? 0;
      const lineStart = grid.lines[row].sourceStart;
      for (const cell of grid.lines[row].cells) {
        const localSourceStart = cell.sourceStart - lineStart;
        while (segmentIndex < segments.length - 1 && localSourceStart >= segmentEnd) {
          segmentIndex++;
          segmentEnd += segments[segmentIndex].text.length;
        }
        const sourceText = this.source.slice(cell.sourceStart, cell.sourceEnd);
        if (cell.advance <= 0 || sourceText === ' ' || sourceText === '\t') continue;
        const color = segments[segmentIndex]?.color ?? this.theme.codeColor;
        const x = this.pad + cell.x - scrollX;
        // Skip cells scrolled fully out of the box on either side. The clip
        // already makes them invisible; this keeps a wide line's cost
        // proportional to what is on screen rather than to the line.
        if (x + cell.advance < 0 || x > this.width) continue;

        if (blit && atlas) {
          const slot = atlas.get(this.codeFont, color, cell.glyph);
          // `atlas.source` is null until the first successful rasterization, so
          // it is read per cell rather than hoisted — the first cell of the first
          // frame is what creates it.
          const src = atlasSource ?? atlas.source;
          if (slot && src) {
            // Destination offsets mirror the fillText baseline convention, so the
            // blit lands exactly where the glyph would have been drawn.
            blit.call(
              r,
              src,
              slot.sx,
              slot.sy,
              slot.sw,
              slot.sh,
              x - slot.offsetX,
              yBaseline - slot.offsetY,
              slot.w,
              slot.h,
            );
            continue;
          }
          // Anything the atlas declined (a cluster too large to pack, a headless
          // context) falls through to fillText below.
        }
        r.fillText(cell.glyph, x, yBaseline, this.codeFont, color);
      }
    }

    r.restore();
  }
}

/**
 * Process-wide code-block glyph atlases, **keyed by device-pixel-ratio**.
 *
 * Shared rather than per-`CodeBlock` so a document's glyph set is rasterized once:
 * streamed markdown creates many code blocks over the same font and theme, and a
 * per-instance atlas would re-rasterize for each, discarding the reuse the whole
 * approach depends on. Slots carry `(font, colour, glyph)`, so multiple themes or
 * font sizes coexist correctly and merely occupy more slots.
 *
 * ## Why a pool and not one atlas
 *
 * A slot's `sx/sy/sw/sh` are device pixels at the ratio it was rasterized at, so
 * an atlas's DPR is immutable — and this used to be a single atlas capturing
 * `devicePixelRatio` at first use, with no rebuild path. A browser zoom therefore
 * left the code grid blitting stale pixels that the DPR-scaled context resampled,
 * while every other text entity re-rasterized: measured in Firefox 153 on one live
 * page, zooming 100% → 133% moved the renderer to 2.068 while the atlas stayed at
 * 1.579, and peak edge contrast inside the code block fell 171 → 139 → 73 across
 * 100/133/500% while prose held 255. **Only code looked soft**, which is exactly
 * why it read as a font bug rather than a cache bug.
 *
 * Keying on the ratio fixes that without mutation: a zoom simply selects a
 * different atlas, and zooming back reuses the first one rather than re-rasterizing
 * from scratch. It also makes two scenes at *different* effective ratios correct —
 * `SceneOptions.maxDPR` lets one scene cap at 2 while another runs uncapped, and a
 * single atlas would have thrashed between them every frame.
 *
 * Bounded to {@link MAX_CODE_ATLASES} entries, LRU-evicted and `destroy()`ed on
 * eviction, because each atlas holds a `maxSize²` canvas (2048² ≈ 16 MB) and a
 * pinch-zoom can walk through many ratios.
 *
 * The DPR comes from {@link IRenderer.pixelRatio} rather than
 * `window.devicePixelRatio`, so a clamped backing store gets an atlas matching
 * *it* — rasterizing at the window's ratio while the context is scaled to a
 * clamped one is the same resampling defect in a different disguise.
 *
 * Returns `undefined` when the renderer cannot blit a sub-rect (`SVGRenderer`, or
 * any renderer omitting the optional method), leaving the caller on `fillText` —
 * which is also the correct output for a vector export.
 */
const codeAtlases = new Map<number, GlyphRasterAtlas>();
/** LRU bound on {@link codeAtlases}. Two covers a zoom and its origin. */
const MAX_CODE_ATLASES = 2;
/** The atlas most recently handed out, for {@link codeAtlas}/{@link codeAtlasStats}. */
let lastCodeAtlas: GlyphRasterAtlas | null = null;

function codeGlyphAtlas(r: IRenderer): GlyphRasterAtlas | undefined {
  if (typeof r.drawImageRect !== 'function') return undefined;
  if (typeof document === 'undefined') return undefined;
  // Prefer the renderer's own backing-store ratio; fall back to the window only
  // for a backend that does not report one.
  const dpr = Math.max(
    1,
    r.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  );
  const existing = codeAtlases.get(dpr);
  if (existing) {
    // Refresh LRU position: re-insertion moves the key to the end of the
    // Map's iteration order, which is what makes the eviction below pick the
    // genuinely least-recently-used entry.
    codeAtlases.delete(dpr);
    codeAtlases.set(dpr, existing);
    lastCodeAtlas = existing;
    return existing;
  }
  // No `Math.min(dpr, 3)` cap here, deliberately. The cap was there because atlas
  // area grows with dpr², but it made *correctness impossible* on a display whose
  // real ratio exceeds it — this host's 500% zoom is 4.286, so a capped atlas is
  // permanently resampled by 1.43x and no amount of rebuilding helps. A code
  // block's glyph set is bounded (one mono font, one size, a handful of theme
  // colours), so the honest failure mode of an over-full atlas is `stats.resets`
  // climbing, which is already instrumented and already documented as the signal
  // to fall back to `fillText`.
  const atlas = new GlyphRasterAtlas({ dpr, maxSize: 2048 });
  codeAtlases.set(dpr, atlas);
  if (codeAtlases.size > MAX_CODE_ATLASES) {
    const oldestKey = codeAtlases.keys().next().value as number;
    const oldest = codeAtlases.get(oldestKey);
    codeAtlases.delete(oldestKey);
    // Release the backing canvas rather than waiting for GC: these are ~16 MB
    // each and an evicted atlas is unreachable anyway.
    if (oldest && oldest !== atlas) oldest.destroy();
  }
  lastCodeAtlas = atlas;
  return atlas;
}

/**
 * Instrumentation for the code-block glyph atlas in use, or `null` before first
 * use.
 *
 * Exposed so an app or benchmark can confirm the atlas is actually active and
 * reusing slots. Watch `resets`: a steadily climbing count means the glyph set is
 * unbounded for the atlas size, so every reset re-rasterizes everything and the
 * atlas is doing net harm rather than saving work.
 *
 * Reports the *most recently used* atlas, which after a zoom is the one now being
 * blitted — see {@link codeAtlas}.
 */
export function codeAtlasStats(): GlyphRasterAtlasStats | null {
  return lastCodeAtlas ? lastCodeAtlas.stats : null;
}

/**
 * The code-block atlas most recently blitted from, or `null` before first use.
 *
 * For instrumentation that must map a traced `drawImage` back to the glyph it
 * painted — a blit carries only a source rect, so `slotAt()` is the only way to
 * recover the cluster and its metrics. Used by `e2e/text-projection.e2e.ts` to
 * keep the code-grid positioning assertions working on the blit path.
 *
 * "Most recently used" rather than "the one" because atlases are pooled per DPR:
 * a caller resolving a traced blit wants the atlas that produced it, which is the
 * one the last render selected. Compare its {@link GlyphRasterAtlas.pixelRatio}
 * against {@link IRenderer.pixelRatio} to assert the blit is 1:1.
 */
export function codeAtlas(): GlyphRasterAtlas | null {
  return lastCodeAtlas;
}
