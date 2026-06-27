import { Entity, IRenderer, type StyledSpan, type TextStyle } from '@vecto-ui/core';
import { marked, type Token, type Tokens } from 'marked';
import { measureText } from './measure';
import { RichText } from './RichText';
import { Stack } from './Stack';
import { Text } from './Text';
import { UIComponent } from './UIComponent';

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
  bodyFont: 'Inter, system-ui, sans-serif',
  codeFont: '"JetBrains Mono", "Fira Code", monospace',
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

    // Strings
    if (ch === '"' || ch === "'" || ch === '`') {
      flush(theme.codeColor);
      const quote = ch;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++; // skip escaped
        j++;
      }
      j++; // include closing quote
      segments.push({ text: line.slice(i, j), color: STRING_COLOR });
      i = j;
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
      segments.push({ text: word, color: keywords.has(word) ? KEYWORD_COLOR : theme.codeColor });
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
  private widths: number[][];
  private lang: string;
  private theme: Required<MarkdownTheme>;
  private lineH = 20;
  private pad = 16;
  private codeFont: string;

  constructor(code: string, lang: string, maxWidth: number, theme: Required<MarkdownTheme>) {
    super();
    this.lang = lang;
    this.theme = theme;
    this.codeFont = `14px ${theme.codeFont}`;
    this.lines = [];
    this.widths = [];
    this.width = maxWidth;
    this.buildLines(code);
  }

  /** Re-parse code content (e.g. for live editing). */
  setCode(code: string, lang?: string): this {
    if (lang !== undefined) this.lang = lang;
    this.buildLines(code);
    return this;
  }

  private buildLines(code: string): void {
    const rawLines = code.split('\n');
    this.lines = rawLines.map((l) => highlightLine(l, this.lang, this.theme));
    this.widths = this.lines.map((segs) => segs.map((seg) => measureText(seg.text, this.codeFont)));
    this.height = this.pad * 2 + rawLines.length * this.lineH;
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

    // Text lines
    for (let row = 0; row < this.lines.length; row++) {
      const segs = this.lines[row];
      const ws = this.widths[row];
      let xOff = this.pad;
      const yBaseline = this.pad + row * this.lineH + this.lineH * 0.75;
      for (let col = 0; col < segs.length; col++) {
        r.fillText(segs[col].text, xOff, yBaseline, this.codeFont, segs[col].color);
        xOff += ws[col];
      }
    }
  }
}

// ── Inline token → RichText entities ─────────────────────────────────────────

/** Decode basic HTML entities that `marked` emits in token text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
          out.push({ text: decodeEntities(t.text), style: { ...inherited, bold: true } });
        }
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        if (t.tokens) {
          collectSpans(t.tokens, { ...inherited, italic: true }, theme, out);
        } else {
          out.push({ text: decodeEntities(t.text), style: { ...inherited, italic: true } });
        }
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        out.push({ text: decodeEntities(t.text), style: { ...inherited, color: theme.codeColor } });
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        // Recurse into link children (they may contain bold/italic/code)
        const linkStyle: TextStyle = { ...inherited, href: t.href, color: '#38bdf8' };
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
): RichText {
  const spans: StyledSpan[] = [];
  if (tokens && tokens.length > 0) {
    collectSpans(tokens, {}, theme, spans);
  }
  // Fallback: if no spans were produced, use the raw text
  if (spans.length === 0) {
    spans.push({ text: decodeEntities(fallbackText) });
  }
  return new RichText(spans, { font, color, maxWidth, linkColor: '#38bdf8' });
}

// ── Main Markdown component ─────────────────────────────────────────────────

export interface MarkdownOptions {
  maxWidth?: number;
  theme?: MarkdownTheme;
}

/**
 * Renders Markdown content into a VectoUI entity tree using {@link marked}.
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

  constructor(markdownText: string, opts: MarkdownOptions = {}) {
    super();
    this.maxWidth = opts.maxWidth ?? 800;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };

    this.content = new Stack({ direction: 'vertical', gap: 16 });
    this.add(this.content);

    this.renderMarkdown(markdownText);
  }

  private renderMarkdown(text: string): void {
    const tokens = marked.lexer(text);
    for (const token of tokens) {
      const el = this.renderToken(token);
      if (el) {
        this.content.add(el);
      }
    }

    this.width = this.content.width;
    this.height = this.content.height;
  }

  private renderToken(token: Token): Entity | null {
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
        );
      }

      // ── Paragraphs ───────────────────────────────────────────────────
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        return renderInlineToRichText(
          pToken.tokens,
          pToken.text,
          bodyFont,
          t.textColor,
          this.maxWidth,
          t,
        );
      }

      // ── Code blocks ──────────────────────────────────────────────────
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').toLowerCase();
        return new CodeBlock(codeToken.text, lang, this.maxWidth, t);
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
              // Offset by border width + padding
              el.x = 16;
              innerStack.add(el);
            }
          }
        }

        // Add the vertical accent bar
        const border = new QuoteBorder(innerStack.height || 20, t.quoteBorderColor);
        const container = new Stack({ direction: 'vertical', gap: 0 });
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
          const bullet = listToken.ordered ? `${Number(listToken.start ?? 1) + i}. ` : '• ';
          // Build spans: bullet prefix + inline-formatted item content
          const itemSpans: StyledSpan[] = [{ text: bullet }];
          if (item.tokens && item.tokens.length > 0) {
            // List item tokens are block-level; dig into paragraph children
            for (const inner of item.tokens) {
              if (inner.type === 'text' && 'tokens' in inner && (inner as any).tokens?.length) {
                collectSpans((inner as any).tokens, {}, t, itemSpans);
              } else if ('tokens' in inner && (inner as any).tokens?.length) {
                collectSpans((inner as any).tokens, {}, t, itemSpans);
              } else if ('text' in inner) {
                itemSpans.push({ text: decodeEntities((inner as any).text) });
              }
            }
          } else {
            itemSpans.push({ text: decodeEntities(item.text) });
          }
          const itemRt = new RichText(itemSpans, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: this.maxWidth - 24,
            linkColor: '#38bdf8',
          });
          itemRt.x = 12; // Indent
          listStack.add(itemRt);
        }
        return listStack;
      }

      // ── Horizontal rule ──────────────────────────────────────────────
      case 'hr':
        return new HorizontalRule(this.maxWidth, t.hrColor);

      // ── Whitespace ───────────────────────────────────────────────────
      case 'space':
        return null;

      // ── Fallback ─────────────────────────────────────────────────────
      default:
        if ('text' in token) {
          return new Text((token as any).text, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: this.maxWidth,
            lineHeight: 24,
          });
        }
        return null;
    }
  }

  /** Structural — children draw themselves. */
  public render(_r: IRenderer): void {}
}
