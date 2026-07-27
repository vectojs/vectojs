import {
  BidiResolver,
  Entity,
  GlyphRasterAtlas,
  type GlyphRasterAtlasStats,
  IRenderer,
  prepareContentGrid,
  type ContentProjection,
  type PreparedContentGrid,
  type StyledSpan,
  type TextStyle,
  SVGEntity,
} from '@vectojs/core';
import { marked, type Token, type Tokens, type TokensList } from 'marked';

marked.use({
  extensions: [
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) {
        return src.match(/(?<![\\$])\$(?![$\s])/)?.index;
      },
      tokenizer(src) {
        // Guard against currency: "$5 to $10" must NOT become one math span.
        // Require, à la pandoc: the opening `$` is not `$$` and is immediately
        // followed by a non-space, non-digit; the content has no literal `$`
        // (only escaped `\$`) and no newline; the closing `$` is preceded by a
        // non-space and not followed by a digit. So "$x+1$" is math, but "$5",
        // "$5 to $10", "$$", and "cost $9 each" are not.
        const match = /^\$(?![$\s\d])((?:\\\$|[^$\n])*?)(?<!\s)\$(?!\d)/.exec(src);
        if (match) {
          return {
            type: 'inlineMath',
            raw: match[0],
            text: match[1].trim(),
          };
        }
        return undefined;
      },
      renderer(token) {
        return token.raw;
      },
    },
  ],
});

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { measureText, RichText, Stack, Table, Text, Image, UIComponent } from '@vectojs/ui';

// @ts-ignore
import { WORKER_SOURCE_STRING } from './MarkdownWorkerSource';

// ── MathJax Setup ────────────────────────────────────────────────────────────

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: 'local' });
const htmlMathJax = mathjax.document('', { InputJax: tex, OutputJax: svg });

function renderMathToSVGDataURI(
  formula: string,
  displayMode: boolean,
): { uri: string; width: number; height: number } | null {
  try {
    const node = htmlMathJax.convert(formula, { display: displayMode });
    const svgString = adaptor.innerHTML(node);

    // Parse ex sizes (e.g. width="40.3ex" height="5.2ex")
    const wMatch = svgString.match(/width="([^"]+)ex"/);
    const hMatch = svgString.match(/height="([^"]+)ex"/);
    const wEx = wMatch ? parseFloat(wMatch[1]) : 10;
    const hEx = hMatch ? parseFloat(hMatch[1]) : 2;
    // 1ex is approx 8px in our font size
    const width = wEx * 8;
    const height = hEx * 8;

    // Use btoa since this executes in the browser
    const base64 = btoa(unescape(encodeURIComponent(svgString)));
    return { uri: `data:image/svg+xml;base64,${base64}`, width, height };
  } catch (e) {
    console.error('MathJax error', e);
    return null;
  }
}

// ── Worker Setup ─────────────────────────────────────────────────────────────

let markdownWorker: Worker | null = null;
let workerIdCounter = 0;
// Distinguishes Markdown instances in the worker's prior-raws cache (one worker
// is shared by every instance on the page).
let workerInstanceCounter = 0;
// `cb` receives (matchLen, tail): the caller's own tokens[0..matchLen) are
// still valid (unchanged raw source) and only `tail` is new — see the
// matching comment in MarkdownWorker.ts for why the worker sends a diff
// instead of the full re-lexed tree on every call.
// `onNeedRaws` is invoked instead of `cb` when the worker reports that its
// cached copy of this instance's prior token raws is missing or stale; the
// requester re-dispatches once with the raws attached.
const workerCallbacks = new Map<
  number,
  {
    cb: (matchLen: number, tail: TokensList) => void;
    onNeedRaws?: () => void;
    text: string;
  }
>();

/**
 * The worker failed for this request (lexer threw, or the worker itself
 * died). Dropping the callback would lose that update for good — for the
 * final chunk of a stream that means content that never renders. Parse on
 * the main thread instead; it is the exact code path the no-Worker
 * environments already use. No prefix to trust here (this is a fresh local
 * parse, not a diff against the caller's own snapshot), so treat the whole
 * result as new — the caller's own `updateTokens` still reconciles it
 * correctly, just without the transfer-size saving for this one call.
 */
function runSyncFallback(entry: {
  cb: (matchLen: number, tail: TokensList) => void;
  text: string;
}): void {
  try {
    entry.cb(0, marked.lexer(entry.text));
  } catch (err) {
    console.warn('Markdown sync fallback parse failed', err);
  }
}

if (typeof Worker !== 'undefined') {
  try {
    const blob = new Blob([WORKER_SOURCE_STRING], {
      type: 'application/javascript',
    });
    markdownWorker = new Worker(URL.createObjectURL(blob));
    markdownWorker.onmessage = (e) => {
      const { id, matchLen, tail, error, needRaws } = e.data;
      const entry = workerCallbacks.get(id);
      if (entry) {
        workerCallbacks.delete(id);
        if (needRaws && entry.onNeedRaws) {
          // The worker can't trust its cached raws — retry with them attached.
          entry.onNeedRaws();
        } else if (needRaws) {
          // No retry path (shouldn't happen); parse locally rather than drop it.
          runSyncFallback(entry);
        } else if (!error) {
          entry.cb(matchLen as number, tail as TokensList);
        } else {
          runSyncFallback(entry);
        }
      }
    };
    markdownWorker.onerror = () => {
      // The worker itself crashed: flush every pending request synchronously
      // and stop routing to it.
      const pending = [...workerCallbacks.values()];
      workerCallbacks.clear();
      markdownWorker = null;
      for (const entry of pending) runSyncFallback(entry);
    };
  } catch (err) {
    console.warn('Failed to initialize MarkdownWorker', err);
  }
}

// ── Theme ────────────────────────────────────────────────────────────────────

/** Color and typography theme for Markdown rendering. */
export interface MarkdownTheme {
  /** Body text color. */
  textColor?: string;
  /** Heading text color. */
  headingColor?: string;
  /** Code text color (inline + block). */
  codeColor?: string;
  /** Code block background color. */
  codeBgColor?: string;
  /** Blockquote border/accent color. */
  quoteBorderColor?: string;
  /** Blockquote text color. */
  quoteTextColor?: string;
  /** Horizontal-rule color. */
  hrColor?: string;
  /** Table background color. */
  tableBgColor?: string;
  /** Table header background color. */
  tableHeaderBgColor?: string;
  /** Body font. */
  bodyFont?: string;
  /** Monospace font for code. */
  codeFont?: string;
  /** Base font size in px. */
  fontSize?: number;
}

const DEFAULT_THEME: Required<MarkdownTheme> = {
  textColor: '#e2e8f0',
  headingColor: '#f8fafc',
  codeColor: '#a5f3fc',
  codeBgColor: 'rgba(30, 41, 59, 0.85)',
  quoteBorderColor: '#6366f1',
  quoteTextColor: '#94a3b8',
  hrColor: 'rgba(148, 163, 184, 0.3)',
  tableBgColor: 'rgba(15, 15, 25, 0.4)',
  tableHeaderBgColor: 'rgba(255, 255, 255, 0.08)',
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: 'ui-monospace, "JetBrains Mono", "Fira Code", monospace',
  fontSize: 16,
};

// ── Helper entities ──────────────────────────────────────────────────────────

/** A thin horizontal line (for `<hr>`). */
class HorizontalRule extends Entity {
  color: string;
  constructor(w: number, color: string) {
    super();
    this.width = w;
    this.height = 1;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(this.width, 0);
    r.stroke(this.color, 1);
  }
}

/** A vertical accent bar for blockquotes. */
class QuoteBorder extends Entity {
  color: string;
  constructor(height: number, color: string) {
    super();
    this.width = 4;
    this.height = height;
    this.color = color;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 2);
    r.fill(this.color);
  }
}

/** A simple concrete container entity for nested layouts. */
class MarkdownContainer extends Entity {
  isPointInside(_globalX: number, _globalY: number): boolean {
    return false;
  }
  render(_r: any): void {}
}

// ── Code block with syntax-keyword highlighting ─────────────────────────────

/** Keyword sets for basic syntax highlighting. */
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

// Aliases
KEYWORD_SETS['javascript'] = KEYWORD_SETS['js'];
KEYWORD_SETS['typescript'] = KEYWORD_SETS['ts'];
KEYWORD_SETS['python'] = KEYWORD_SETS['py'];
KEYWORD_SETS['rs'] = KEYWORD_SETS['rust'];

/** Segment of highlighted code text. */
interface CodeSegment {
  text: string;
  color: string;
}

/** Tokenize a line of code into colored segments (keyword / string / comment / default). */
function highlightLine(line: string, lang: string, theme: Required<MarkdownTheme>): CodeSegment[] {
  const keywords = KEYWORD_SETS[lang];
  if (!keywords) {
    return [{ text: line, color: theme.codeColor }];
  }

  const segments: CodeSegment[] = [];
  const KEYWORD_COLOR = '#c084fc'; // purple-ish
  const STRING_COLOR = '#86efac'; // green
  const COMMENT_COLOR = '#64748b'; // slate
  const NUMBER_COLOR = '#fbbf24'; // amber

  let i = 0;
  let buf = '';

  const flush = (color: string) => {
    if (buf) {
      segments.push({ text: buf, color });
      buf = '';
    }
  };

  while (i < line.length) {
    const ch = line[i];

    // Single-line comment
    if (ch === '/' && line[i + 1] === '/') {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }
    // Python / Rust comment
    if (ch === '#' && (lang === 'py' || lang === 'python' || lang === 'rust' || lang === 'rs')) {
      flush(theme.codeColor);
      segments.push({ text: line.slice(i), color: COMMENT_COLOR });
      return segments;
    }

    // Strings. Only colored when the quote actually CLOSES on this line —
    // otherwise a stray quote (a Rust lifetime `&'a str`, an apostrophe in an
    // identifier or trailing prose, a generic `'` in shell) would swallow the
    // whole rest of the line as a green "string". An unterminated quote falls
    // through and is treated as ordinary punctuation.
    if (ch === '"' || ch === "'" || ch === '`') {
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
    if (/\d/.test(ch) && (i === 0 || /[\s(,=+\-*/<>[\]{}:;]/.test(line[i - 1]))) {
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
        color: keywords.has(word) ? KEYWORD_COLOR : theme.codeColor,
      });
      i = j;
      continue;
    }

    buf += ch;
    i++;
  }

  flush(theme.codeColor);
  return segments;
}

// ── Single CodeBlock entity ─────────────────────────────────────────────────

/**
 * A single self-rendering entity for fenced code blocks.
 *
 * Replaces the old N×M child-entity explosion (Container → Stack → Text per
 * segment per line) with a flat leaf that draws its own background + text.
 */
export class CodeBlock extends UIComponent {
  private lines: CodeSegment[][];
  private grid: PreparedContentGrid | null = null;
  /** Raw (unhighlighted) lines of the last build, for prefix reuse in buildLines. */
  private rawLines: string[] | null = null;
  private cellWidth = 0;
  private source: string;

  private lang: string;
  private theme: Required<MarkdownTheme>;
  private lineH = 24;
  private pad = 18;
  private codeFont: string;
  public selectable: boolean;

  constructor(
    code: string,
    lang: string,
    maxWidth: number,
    theme: Required<MarkdownTheme>,
    selectable = true,
  ) {
    super();
    this.source = code;
    this.lang = lang;
    this.theme = theme;
    this.codeFont = `15px ${theme.codeFont}`;
    this.selectable = selectable;

    this.lines = [];
    this.width = maxWidth;
    this.buildLines(code);
  }

  /** Re-parse code content (e.g. for live editing). */
  setCode(code: string, lang?: string): this {
    if (lang !== undefined) this.lang = lang;
    this.source = code;
    this.buildLines(code);
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native selection for this code block. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    this.scene?.markDirty();
    return this;
  }

  public override getContentProjection(): ContentProjection | null {
    if (!this.source) return null;
    const grid = this.ensureGrid();
    return {
      text: this.source,
      font: this.codeFont,
      lineHeight: this.lineH,
      // Every row is absolutely positioned from the same local coordinates as
      // render(). A single pre-wrap DOM text node would introduce browser
      // wrapping for long source lines that canvas intentionally keeps intact.
      lines: grid.lines.map((line, row) => ({
        text: this.source.slice(line.sourceStart, line.sourceEnd),
        separatorAfter: this.source.slice(line.sourceEnd, line.nextSourceStart) || undefined,
        x: this.pad,
        y: this.pad + row * this.lineH,
        baseline: this.lineH * 0.75,
        font: this.codeFont,
        lineHeight: this.lineH,
      })),
      selectable: this.selectable,
      // render() draws cell-by-cell (no ligatures can form); the DOM copy
      // must not ligate either or Firefox selection geometry drifts.
      ligatures: 'none',
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
   */
  private buildLines(code: string): void {
    const rawLines = code.split(/\r\n|\r|\n/);
    const previous = this.rawLines;
    // Longest identical prefix, excluding the previous last line (see above).
    let reusable = 0;
    if (previous && this.lines.length === previous.length) {
      const limit = Math.min(previous.length - 1, rawLines.length);
      while (reusable < limit && previous[reusable] === rawLines[reusable]) reusable++;
    }

    if (reusable > 0) {
      const next = this.lines.slice(0, reusable);
      for (let i = reusable; i < rawLines.length; i++) {
        next.push(highlightLine(rawLines[i]!, this.lang, this.theme));
      }
      this.lines = next;
    } else {
      this.lines = rawLines.map((l) => highlightLine(l, this.lang, this.theme));
    }

    this.rawLines = rawLines;
    this.grid = null;
    this.height = this.pad * 2 + rawLines.length * this.lineH;
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

  /** Code blocks are decorative — not interactive. */
  isPointInside(): boolean {
    return false;
  }

  render(r: IRenderer): void {
    // Background
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 8);
    r.fill(this.theme.codeBgColor);

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

    for (let row = 0; row < grid.lines.length; row++) {
      const yBaseline = this.pad + row * this.lineH + this.lineH * 0.75;
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
        const x = this.pad + cell.x;

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
  }
}

/**
 * The process-wide glyph atlas for code blocks, created on first use.
 *
 * Shared rather than per-`CodeBlock` so a document's glyph set is rasterized once:
 * streamed markdown creates many code blocks over the same font and theme, and a
 * per-instance atlas would re-rasterize for each, discarding the reuse the whole
 * approach depends on. Slots carry `(font, colour, glyph)`, so multiple themes or
 * font sizes coexist correctly and merely occupy more slots.
 *
 * Returns `undefined` when the renderer cannot blit a sub-rect (`SVGRenderer`, or
 * any renderer omitting the optional method), leaving the caller on `fillText` —
 * which is also the correct output for a vector export.
 */
let sharedCodeAtlas: GlyphRasterAtlas | null = null;
function codeGlyphAtlas(r: IRenderer): GlyphRasterAtlas | undefined {
  if (typeof r.drawImageRect !== 'function') return undefined;
  if (typeof document === 'undefined') return undefined;
  sharedCodeAtlas ??= new GlyphRasterAtlas({
    // Match the display so a HiDPI blit stays crisp. Capped at 3 because atlas
    // area grows with dpr² and a 4x display would otherwise blow the size cap
    // with a few hundred glyphs.
    dpr: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1,
    maxSize: 2048,
  });
  return sharedCodeAtlas;
}

/**
 * Instrumentation for the shared code-block glyph atlas, or `null` before first
 * use.
 *
 * Exposed so an app or benchmark can confirm the atlas is actually active and
 * reusing slots. Watch `resets`: a steadily climbing count means the glyph set is
 * unbounded for the atlas size, so every reset re-rasterizes everything and the
 * atlas is doing net harm rather than saving work.
 */
export function codeAtlasStats(): GlyphRasterAtlasStats | null {
  return sharedCodeAtlas ? sharedCodeAtlas.stats : null;
}

// ── Inline token → RichText entities ─────────────────────────────────────────

/** Decode basic HTML entities that `marked` emits in token text. */
function decodeEntities(text: string): string {
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
function collectSpans(
  tokens: Token[],
  inherited: TextStyle,
  theme: Required<MarkdownTheme>,
  out: StyledSpan[],
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const t = token as Tokens.Strong;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, bold: true }, theme, out);
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
          collectSpans(t.tokens, { ...inherited, italic: true }, theme, out);
        } else {
          out.push({
            text: decodeEntities(t.text),
            style: { ...inherited, italic: true },
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
        out.push({
          text: decodeEntities(t.raw),
          style: { ...inherited, color: '#fcd34d' },
        }); // yellow/gold for inline math
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        // Recurse into link children (they may contain bold/italic/code)
        const linkStyle: TextStyle = {
          ...inherited,
          href: t.href,
          color: '#38bdf8',
        };
        if (t.tokens && t.tokens.length > 0) {
          collectSpans(t.tokens, linkStyle, theme, out);
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
          collectSpans((t as any).tokens, inherited, theme, out);
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

/** Parse inline markdown tokens and produce a {@link RichText} entity. */
function renderInlineToRichText(
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
    collectSpans(tokens, {}, theme, spans);
  }
  // Fallback: if no spans were produced, use the raw text
  if (spans.length === 0) {
    spans.push({ text: decodeEntities(fallbackText) });
  }
  return new RichText(spans, {
    font,
    color,
    maxWidth,
    linkColor: '#38bdf8',
    selectable,
    onLinkClick,
  });
}

// ── Main Markdown component ─────────────────────────────────────────────────

export interface MarkdownOptions {
  maxWidth?: number;
  theme?: MarkdownTheme;
  onLinkClick?: (url: string) => void;
  /** Allow browser-native drag selection and copy for rendered text. Default `true`. */
  selectable?: boolean;
}

/**
 * Renders Markdown content into a VectoJS entity tree using {@link marked}.
 *
 * Supported token types:
 * - **Headings** (h1–h6) with scaled font sizes
 * - **Paragraphs** with word-wrapping
 * - **Code blocks** with syntax-keyword highlighting and a rounded background
 * - **Blockquotes** with a left accent bar
 * - **Unordered / ordered lists** with bullets / numbers
 * - **Horizontal rules**
 * - **Inline code** (via backticks)
 *
 * @example
 * const md = new Markdown('# Hello\\nSome *text*', { maxWidth: 600 });
 * scene.add(md.setPosition(40, 40));
 */
export class Markdown extends UIComponent {
  public content: Stack;
  public maxWidth: number;
  public theme: Required<MarkdownTheme>;
  public onLinkClick?: (url: string) => void;
  public selectable: boolean;
  public onLayoutUpdated?: () => void;
  private rawMarkdown: string;
  private tokens: Token[] = [];
  // At most one worker lex request in flight at a time. Required for the
  // delta-transfer protocol below to be safe: the request captures a
  // snapshot of `this.tokens` to reconstruct the full array from the
  // worker's (matchLen, tail) response, and that snapshot would go stale if
  // another request's callback could run — and mutate `this.tokens` — while
  // this one is still pending. `appendPending` means "more text arrived
  // while a request was in flight"; the in-flight callback re-dispatches
  // with the latest accumulated text once it resolves.
  private appendInFlight = false;
  private appendPending = false;
  // Worker request ids dispatched by *this* instance that haven't resolved yet.
  // The module-level `workerCallbacks` map holds a closure capturing `this`, so
  // destroying a Markdown mid-stream would pin the whole entity (and its subtree)
  // until the worker replied. `destroy()` drops these so the instance is GC-able.
  private pendingWorkerIds = new Set<number>();
  // Identity + token-list version for the worker's prior-raws cache. The worker
  // keeps this instance's last raw list so a streaming append sends only the new
  // text; `tokenVersion` is bumped on EVERY `this.tokens` mutation so any change
  // the worker didn't produce (setContent, a sync-fallback parse) invalidates
  // that cache instead of silently diffing against stale raws.
  private readonly workerInstanceId = `md-${workerInstanceCounter++}`;
  private tokenVersion = 0;
  // `tokenChildPrefix[i]` = how many of `tokens[0..i)` render a child entity, so
  // `updateTokens` can map a token index to its child slot in O(1). Maintained
  // incrementally by setTokens() (only the changed suffix is recomputed).
  private readonly tokenChildPrefix: number[] = [];

  /**
   * Replace the token list, invalidate the worker's cached raws for it, and
   * refresh {@link tokenChildPrefix} — the token-index → child-entity-index
   * prefix sum `updateTokens` needs.
   *
   * `validFrom` is the number of leading tokens whose prefix entries are still
   * correct (the raw-equal prefix), so only the changed suffix is recomputed
   * instead of rebuilding over every token on every streamed chunk.
   */
  private setTokens(tokens: Token[], validFrom = 0): void {
    this.tokens = tokens;
    this.tokenVersion++;

    const prefix = this.tokenChildPrefix;
    const keep = Math.min(validFrom, prefix.length, tokens.length);
    prefix.length = keep;
    // Resume the running child count from the kept prefix's last entry.
    let childIdx = 0;
    if (keep > 0) {
      childIdx = prefix[keep - 1];
      if (this.producesEntity(tokens[keep - 1])) childIdx++;
    }
    for (let i = keep; i < tokens.length; i++) {
      prefix.push(childIdx);
      if (this.producesEntity(tokens[i])) childIdx++;
    }
  }

  constructor(markdownText: string, opts: MarkdownOptions = {}) {
    super();
    this.maxWidth = opts.maxWidth ?? 800;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.onLinkClick = opts.onLinkClick;
    this.selectable = opts.selectable ?? true;

    this.content = new Stack({ direction: 'vertical', gap: 16 });
    this.add(this.content);

    this.rawMarkdown = markdownText;
    this.setTokens([]);
    this.renderMarkdown(markdownText);
  }

  private renderMarkdown(text: string): void {
    const tokens = marked.lexer(text);
    this.setTokens(tokens);
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) {
        this.content.add(el);
      }
    }

    this.width = this.content.width;
    this.height = this.content.height;
  }

  /** Replace all markdown content (full rebuild). */
  public setContent(markdown: string): this {
    this.rawMarkdown = markdown;
    // Destroy (not just detach) all children so their subtrees' resources —
    // MSDF worker slots, GPU buffers, portal observers — are released instead
    // of stranded. destroy() detaches from `content` as it goes.
    while (this.content.children.length > 0) {
      this.content.children[this.content.children.length - 1].destroy();
    }
    this.setTokens([]);
    this.renderMarkdown(markdown);
    return this;
  }

  /**
   * Tear down this Markdown block: drop any in-flight worker callbacks (each
   * pins `this` via its closure, so a mid-stream destroy would otherwise keep
   * the whole subtree alive until the worker replied), then recurse into the
   * content subtree via `super.destroy()` so every block's resources are freed.
   */
  public override destroy(): void {
    for (const id of this.pendingWorkerIds) workerCallbacks.delete(id);
    this.pendingWorkerIds.clear();
    this.appendInFlight = false;
    this.appendPending = false;
    // Release this instance's prior-raws entry in the (shared) worker, so a page
    // that creates and drops many blocks doesn't retain their raws forever.
    markdownWorker?.postMessage({
      instance: this.workerInstanceId,
      dispose: true,
    });
    super.destroy();
  }

  /** Enable or disable native selection for existing and future Markdown text. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    const apply = (entity: Entity): void => {
      const candidate = entity as Entity & {
        setSelectable?: (value: boolean) => unknown;
      };
      candidate.setSelectable?.(selectable);
      for (const child of entity.children) apply(child);
    };
    for (const child of this.content.children) apply(child);
    this.scene?.markDirty();
    return this;
  }

  /** Append a markdown chunk incrementally. Reuses unchanged prefix entities. */
  public appendMarkdown(chunk: string): this {
    this.rawMarkdown += chunk;

    if (!markdownWorker) {
      const newTokens = marked.lexer(this.rawMarkdown);
      this.updateTokens(newTokens);
      return this;
    }

    if (this.appendInFlight) {
      // `this.rawMarkdown` already has this chunk folded in — the next
      // dispatch picks it up naturally, no separate buffer needed.
      this.appendPending = true;
      return this;
    }
    this.dispatchAppend();
    return this;
  }

  /**
   * Post one lex request for the accumulated text.
   *
   * `sendRaws` forces this request to carry the full prior-token raw list. The
   * worker normally keeps that list itself (keyed by `workerInstanceId` +
   * `tokenVersion`), so a streaming append sends only the new text — re-sending
   * every prior raw each chunk made the transfer O(document) per chunk, i.e.
   * O(N²) over a stream. It is sent only when the worker says its cache can't
   * be trusted (`needRaws`), which happens on the first request for this
   * instance and after any token-list change the worker didn't produce
   * (`setContent`, a main-thread sync-fallback parse).
   */
  private dispatchAppend(sendRaws = false): void {
    if (!markdownWorker) return;
    this.appendInFlight = true;
    const id = workerIdCounter++;
    // Snapshot now — this is the array the worker's `matchLen` is relative
    // to, and it must stay fixed until this exact response is applied (see
    // the field comment on `appendInFlight` for why that requires
    // coalescing rather than tracking `this.tokens` live).
    const oldTokensSnapshot = this.tokens;
    const baseVersion = this.tokenVersion;
    this.pendingWorkerIds.add(id);
    workerCallbacks.set(id, {
      cb: (matchLen, tail) => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        const newTokens = [...oldTokensSnapshot.slice(0, matchLen), ...tail] as TokensList;
        // The worker's matchLen is exactly the prefix it kept, and `newTokens` is
        // built from that same slice, so it is correct by construction here.
        this.updateTokens(newTokens, matchLen);
        if (this.appendPending) {
          this.appendPending = false;
          this.dispatchAppend();
        }
      },
      // The worker can't trust its cached raws for this request; retry it once
      // with them attached. `this.tokens` is untouched (no updateTokens ran), so
      // the retry's snapshot and version still line up.
      onNeedRaws: () => {
        this.pendingWorkerIds.delete(id);
        this.appendInFlight = false;
        this.dispatchAppend(true);
      },
      text: this.rawMarkdown,
    });
    markdownWorker.postMessage({
      id,
      text: this.rawMarkdown,
      instance: this.workerInstanceId,
      baseVersion,
      ...(sendRaws ? { oldRaws: oldTokensSnapshot.map((t) => t.raw) } : {}),
    });
  }

  private updateTokens(newTokens: TokensList, knownMatchLen?: number): void {
    const oldTokens = this.tokens;
    const oldChildren = [...this.content.children]; // snapshot

    // The raw-equal prefix length. The worker already computed this to decide
    // what tail to send, so when it hands the value over there is nothing to
    // re-derive — this loop was re-scanning every token's `raw` string on the
    // main thread for a result the worker had already produced.
    //
    // Validated rather than trusted blindly: `knownMatchLen` is relative to the
    // token snapshot the request was issued against, and a bug (or a future
    // protocol change) that let it exceed either array would silently reuse the
    // wrong entities. Out-of-range falls through to the scan.
    let matchLen: number;
    const minLen = Math.min(oldTokens.length, newTokens.length);
    if (knownMatchLen !== undefined && knownMatchLen >= 0 && knownMatchLen <= minLen) {
      matchLen = knownMatchLen;
    } else {
      matchLen = 0;
      for (let i = 0; i < minLen; i++) {
        if (oldTokens[i].raw === newTokens[i].raw) {
          matchLen++;
        } else {
          break;
        }
      }
    }

    // Old-token-index → child-entity index (tokens that render nothing don't
    // consume a child slot — see producesEntity). This prefix sum is maintained
    // incrementally by setTokens(), so it's already valid for `oldTokens` here:
    // reading it is O(1) instead of the O(total blocks) rebuild this used to do
    // on every streamed chunk.
    const oldTokenToChild = this.tokenChildPrefix;
    // The raw-equal prefix length, captured before the in-place paragraph branch
    // below mutates `matchLen`. Everything before it is unchanged, so the child
    // prefix sum stays valid there and only the suffix is recomputed.
    const rawMatchLen = matchLen;

    // Handle the common streaming case: the last token changed but kept its type,
    // so its entity can be updated in place instead of destroyed and rebuilt.
    //
    // `code` is here alongside `paragraph` because an unclosed fenced block is the
    // second most common shape an LLM streams, and it is the worst case for the
    // rebuild path: CodeBlock re-tokenizes and re-measures its whole grid on
    // construction, so a block growing one line at a time paid that for every
    // chunk. `setCode()` already existed for live editing; the reconciler simply
    // never called it.
    const lastTokenSameType =
      matchLen === oldTokens.length - 1 &&
      matchLen < newTokens.length &&
      oldTokens[matchLen]?.type === newTokens[matchLen]?.type;

    if (lastTokenSameType && newTokens[matchLen]?.type === 'code') {
      const existingEntity = oldChildren[oldTokenToChild[matchLen]];
      const codeToken = newTokens[matchLen] as Tokens.Code;
      if (existingEntity instanceof CodeBlock) {
        // Language can change mid-stream: ```` ``` ```` then the info string
        // arrives on the next chunk, so pass it through rather than assuming it
        // is stable.
        existingEntity.setCode(codeToken.text, codeToken.lang ?? undefined);
        matchLen++;
        // Same O(1) tail resync as the paragraph path: the block is still the
        // Stack's last child, so its own box changed but no sibling moved.
        this.content.resizeLastChild(existingEntity);
      }
    } else if (lastTokenSameType && newTokens[matchLen]?.type === 'paragraph') {
      // Update existing paragraph entity in-place via setSpans
      const entityIdx = oldTokenToChild[matchLen];
      const existingEntity = oldChildren[entityIdx];
      if (existingEntity && 'setSpans' in existingEntity) {
        // Re-render the paragraph's inline tokens
        const pToken = newTokens[matchLen] as Tokens.Paragraph;
        const t = this.theme;
        // Build new spans from the token
        const spans: StyledSpan[] = [];
        if (pToken.tokens && pToken.tokens.length > 0) {
          collectSpans(pToken.tokens, {}, t, spans);
        }
        if (spans.length === 0) {
          spans.push({ text: pToken.text });
        }
        (existingEntity as any).setSpans(spans);
        matchLen++; // This token is now handled
        // Streaming's hot path: the growing paragraph is still the Stack's
        // last child, so its own size changed but no sibling moved — resync
        // the container's cached width/height in O(1) instead of falling
        // through to the unconditional full `layout()` this used to run on
        // every single streamed chunk regardless of what actually changed.
        this.content.resizeLastChild(existingEntity);
      }
    }

    // Destroy excess old entities (from matchLen onward). destroy() (not just
    // remove()) so a discarded block's subtree resources are released, and it
    // detaches from `content` itself. Starts AT matchLen — the old loop walked
    // every token from 0 only to skip the matched prefix with an `i >= matchLen`
    // test, making it O(total blocks) per streamed chunk.
    for (let i = matchLen; i < oldTokens.length; i++) {
      if (this.producesEntity(oldTokens[i])) {
        const idx = oldTokenToChild[i];
        if (idx < oldChildren.length) {
          oldChildren[idx].destroy();
        }
      }
    }

    // Add new entities for tokens beyond matchLen
    for (let i = matchLen; i < newTokens.length; i++) {
      const el = this.renderToken(newTokens[i]);
      if (el) this.content.add(el);
    }

    // The raw-equal prefix is unchanged, so its child-index entries stay valid;
    // only the suffix prefix-sum is recomputed.
    this.setTokens(newTokens, rawMatchLen);
    // No explicit layout() here: the common in-place resize above uses
    // resizeLastChild(), and any add()/remove() calls in the loops above
    // already keep `content`'s own width/height correct as they happen (see
    // Stack.add()'s fastAppendDirty resync) — an unconditional full layout()
    // on every call would silently redo (or, for the pure-resize case,
    // needlessly perform for the first time) an O(children) walk on every
    // single streamed chunk.
    this.width = this.content.width;
    this.height = this.content.height;

    this.scene?.markDirty();
    if (this.onLayoutUpdated) {
      this.onLayoutUpdated();
    }
  }

  /**
   * Whether {@link renderToken} produces a child entity for this token (vs
   * `null`). `updateTokens` maps token indices to child-entity indices, and the
   * reconcile/removal loops must skip EXACTLY the tokens that render nothing —
   * not just `space`. A `space`, a non-SVG raw `html` block (an HTML comment,
   * a bare `<div>`), or a fallback token without `text` all render null; before
   * this, only `space` was skipped, so a null-rendering `html`/`def` token
   * before the growing tail shifted every subsequent entity index by one and
   * the wrong entity was updated or destroyed. Kept in lockstep with
   * `renderToken`'s null returns.
   */
  protected producesEntity(token: Token): boolean {
    switch (token.type) {
      case 'space':
        return false;
      case 'html': {
        const text = (token as Tokens.HTML).text.toLowerCase();
        return text.includes('<svg') && text.includes('</svg>');
      }
      case 'heading':
      case 'paragraph':
      case 'code':
      case 'blockquote':
      case 'list':
      case 'table':
      case 'hr':
        return true;
      default:
        return 'text' in token;
    }
  }

  protected renderToken(token: Token): Entity | null {
    const t = this.theme;
    const bodyFont = `${t.fontSize}px ${t.bodyFont}`;

    switch (token.type) {
      // ── Headings ─────────────────────────────────────────────────────
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const sizes = [32, 28, 24, 20, 18, 16];
        const size = sizes[Math.min(hToken.depth - 1, 5)];
        const headingFont = `bold ${size}px ${t.bodyFont}`;
        return renderInlineToRichText(
          hToken.tokens,
          hToken.text,
          headingFont,
          t.headingColor,
          this.maxWidth,
          t,
          this.selectable,
          this.onLinkClick,
        );
      }

      // ── Paragraphs ───────────────────────────────────────────────────
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        if (!pToken.tokens || !pToken.tokens.some((t) => t.type === 'image')) {
          return renderInlineToRichText(
            pToken.tokens,
            pToken.text,
            bodyFont,
            t.textColor,
            this.maxWidth,
            t,
            this.selectable,
            this.onLinkClick,
          );
        }

        // Split paragraph into a Stack if it contains images
        const stack = new Stack({
          direction: 'vertical',
          gap: 16,
          maxWidth: this.maxWidth,
        });
        let currentTokens: Token[] = [];

        const flushText = () => {
          if (currentTokens.length > 0) {
            stack.add(
              renderInlineToRichText(
                currentTokens,
                '',
                bodyFont,
                t.textColor,
                this.maxWidth,
                t,
                this.selectable,
                this.onLinkClick,
              ),
            );
            currentTokens = [];
          }
        };

        for (const child of pToken.tokens) {
          if (child.type === 'image') {
            flushText();
            const imgToken = child as Tokens.Image;
            const initialWidth = Math.min(800, this.maxWidth);
            const initialHeight = Math.round(initialWidth * 0.6); // Guess 16:10 aspect ratio initially
            const img = new Image(imgToken.href, {
              width: initialWidth,
              height: initialHeight,
              alt: imgToken.text,
              radius: 8,
              onLoad: () => {
                const bmp = (img as any).bitmap;
                if (bmp && bmp.naturalWidth && bmp.naturalHeight) {
                  const aspect = bmp.naturalHeight / bmp.naturalWidth;
                  img.width = Math.min(bmp.naturalWidth, this.maxWidth);
                  img.height = Math.round(img.width * aspect);
                  if (this.scene) this.scene.markDirty();
                }
              },
            });
            stack.add(img);
          } else {
            currentTokens.push(child);
          }
        }
        flushText();
        return stack;
      }

      // ── Code blocks ──────────────────────────────────────────────────
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').toLowerCase();

        if (lang === 'math' || lang === 'latex' || lang === 'tex') {
          const mathData = renderMathToSVGDataURI(codeToken.text, true);
          if (mathData) {
            // Provide a generous default height, it will scale based on width
            const mathImg = new Image(mathData.uri, {
              width: Math.min(this.maxWidth, mathData.width),
              height: mathData.height * Math.min(1, this.maxWidth / mathData.width),
              alt: codeToken.text,
            });
            // Let the layout flow it as a block
            const wrapper = new MarkdownContainer();
            mathImg.x = 16;
            mathImg.y = 8;
            wrapper.add(mathImg);
            wrapper.width = mathImg.width + 16;
            wrapper.height = mathImg.height + 16;
            return wrapper;
          }
        }

        return new CodeBlock(codeToken.text, lang, this.maxWidth, t, this.selectable);
      }

      // ── Blockquotes ──────────────────────────────────────────────────
      case 'blockquote': {
        const bqToken = token as Tokens.Blockquote;
        const innerStack = new Stack({ direction: 'vertical', gap: 8 });

        // Recursively render inner tokens
        if (bqToken.tokens) {
          for (const inner of bqToken.tokens) {
            const el = this.renderToken(inner);
            if (el) {
              const wrapper = new MarkdownContainer();
              el.x = 16;
              wrapper.add(el);
              wrapper.width = el.width + 16;
              wrapper.height = el.height;
              innerStack.add(wrapper);
            }
          }
        }

        // Add the vertical accent bar
        const border = new QuoteBorder(innerStack.height || 20, t.quoteBorderColor);

        // A plain Entity, not a Stack: the border and text overlay at the same
        // position (both at x=0, y=0), they aren't laid out sequentially. A
        // Stack re-runs its own sequential layout on every add() (see
        // Stack.add), which would silently move the second child below the
        // first regardless of any position set on it beforehand.
        const container = new MarkdownContainer();
        border.x = 0;
        border.y = 0;
        container.add(border);

        // Overlay the inner text stack
        innerStack.y = 0;
        innerStack.x = 0;
        container.add(innerStack);
        container.width = this.maxWidth;
        container.height = Math.max(border.height, innerStack.height);

        return container;
      }

      // ── Lists ────────────────────────────────────────────────────────
      case 'list': {
        const listToken = token as Tokens.List;
        const listStack = new Stack({ direction: 'vertical', gap: 6 });
        for (let i = 0; i < listToken.items.length; i++) {
          const item = listToken.items[i];
          const num = Number(listToken.start ?? 1) + i;
          // Build the inline content spans first; the marker is placed after, on
          // the side that matches the item's reading direction.
          const contentSpans: StyledSpan[] = [];
          if (item.tokens && item.tokens.length > 0) {
            // List item tokens are block-level; dig into paragraph children
            for (const inner of item.tokens) {
              if (inner.type === 'text' && 'tokens' in inner && (inner as any).tokens?.length) {
                collectSpans((inner as any).tokens, {}, t, contentSpans);
              } else if ('tokens' in inner && (inner as any).tokens?.length) {
                collectSpans((inner as any).tokens, {}, t, contentSpans);
              } else if ('text' in inner) {
                contentSpans.push({
                  text: decodeEntities((inner as any).text),
                });
              }
            }
          } else {
            contentSpans.push({ text: decodeEntities(item.text) });
          }

          // Place the marker on the reading-start side. An RTL item must show
          // its marker at the visual RIGHT; a leading neutral bullet would
          // bidi-reorder to the visual LEFT. Appending the marker as a TRAILING
          // span fixes it: `" •"` reorders to visual `"• …"`, and `" .N"` to
          // `"N. …"` — both flush-right in reading order. LTR keeps the marker
          // leading as before.
          const itemIsRtl =
            BidiResolver.getBaseLevel(contentSpans.map((s) => s.text).join('')) % 2 === 1;
          const itemSpans: StyledSpan[] = itemIsRtl
            ? [...contentSpans, { text: listToken.ordered ? ` .${num}` : ' \u2022' }]
            : [{ text: listToken.ordered ? `${num}. ` : '• ' }, ...contentSpans];
          const itemRt = new RichText(itemSpans, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: this.maxWidth - 24,
            linkColor: '#38bdf8',
            selectable: this.selectable,
            onLinkClick: this.onLinkClick,
          });
          itemRt.x = 12; // Indent
          listStack.add(itemRt);
        }
        return listStack;
      }

      // ── Table ────────────────────────────────────────────────────────
      case 'table': {
        const tblToken = token as Tokens.Table;

        const buildCell = (cell: Tokens.TableCell, header: boolean) => {
          const spans: StyledSpan[] = [];
          collectSpans(cell.tokens, {}, t, spans);
          if (spans.length === 0) return decodeEntities(cell.text);
          return new RichText(spans, {
            font: `${t.fontSize - 2}px ${t.bodyFont}`,
            color: header ? t.headingColor : t.textColor,
            baseStyle: header ? { bold: true } : undefined,
            linkColor: '#38bdf8',
            selectable: this.selectable,
            onLinkClick: this.onLinkClick,
          });
        };

        const headers = tblToken.header.map((cell) => buildCell(cell, true));
        const rows = tblToken.rows.map((row) => row.map((cell) => buildCell(cell, false)));

        return new Table({
          headers,
          rows,
          width: this.maxWidth,
          textColor: t.textColor,
          headerTextColor: t.headingColor,
          font: `${t.fontSize - 2}px ${t.bodyFont}`,
          borderColor: t.hrColor,
          bg: t.tableBgColor,
          headerBg: t.tableHeaderBgColor,
          selectable: this.selectable,
        });
      }

      // ── Horizontal rule ──────────────────────────────────────────────
      case 'hr':
        return new HorizontalRule(this.maxWidth, t.hrColor);

      // ── Whitespace ───────────────────────────────────────────────────
      case 'space':
        return null;

      // ── HTML (Support raw SVGs) ──────────────────────────────────────
      case 'html': {
        const htmlToken = token as Tokens.HTML;
        if (
          htmlToken.text.toLowerCase().includes('<svg') &&
          htmlToken.text.toLowerCase().includes('</svg>')
        ) {
          return new SVGEntity(htmlToken.text);
        }
        return null;
      }

      // ── Fallback ─────────────────────────────────────────────────────
      default:
        if ('text' in token) {
          return new Text((token as any).text, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: this.maxWidth,
            lineHeight: 24,
            selectable: this.selectable,
          });
        }
        return null;
    }
  }

  /** Structural — children draw themselves. */
  public render(_r: IRenderer): void {}
}
