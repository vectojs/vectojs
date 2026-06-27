import { Entity, IRenderer } from '@vecto-ui/core';
import { marked, type Token, type Tokens } from 'marked';
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

/** A filled rounded-rect card (used as code-block background). */
class RoundedRect extends Entity {
  color: string;
  radius: number;
  constructor(w: number, h: number, color: string, radius: number = 8) {
    super();
    this.width = w;
    this.height = h;
    this.color = color;
    this.radius = radius;
  }
  isPointInside(): boolean {
    return false;
  }
  render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.color);
  }
}

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

/** A plain structural container for grouping entities without applying layout rules. */
class Container extends UIComponent {
  constructor(name?: string) {
    super(name);
  }
  render(_r: IRenderer): void {}
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

// ── Inline token → Text entities ─────────────────────────────────────────────

/** Parse inline markdown tokens and produce Text entities on a Stack line. */
function renderInlineTokens(
  tokens: Token[] | undefined,
  fallbackText: string,
  font: string,
  color: string,
  maxWidth: number,
): Text {
  // For now: flatten to plain text. A full implementation would create
  // separate Text entities for bold/italic/code spans and lay them out inline.
  const plainText = tokens
    ? tokens.map((t) => ('text' in t ? (t as any).text : '')).join('')
    : fallbackText;
  return new Text(plainText, { font, color, maxWidth, lineHeight: 24 });
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
        return new Text(hToken.text, {
          font: `bold ${size}px ${t.bodyFont}`,
          color: t.headingColor,
          maxWidth: this.maxWidth,
          lineHeight: size * 1.4,
        });
      }

      // ── Paragraphs ───────────────────────────────────────────────────
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        return renderInlineTokens(pToken.tokens, pToken.text, bodyFont, t.textColor, this.maxWidth);
      }

      // ── Code blocks ──────────────────────────────────────────────────
      case 'code': {
        const codeToken = token as Tokens.Code;
        const lang = (codeToken.lang ?? '').toLowerCase();
        const pad = 16;
        const lineH = 20;
        const codeFont = `14px ${t.codeFont}`;
        const lines = codeToken.text.split('\n');

        // Container for code block (plain Container, no automatic layout)
        const codeContainer = new Container('CodeContainer');

        // Render each line with syntax highlighting
        const linesContainer = new Stack({ direction: 'vertical', gap: 0 });

        for (const line of lines) {
          const segments = highlightLine(line, lang, t);
          const lineRow = new Stack({ direction: 'horizontal', gap: 0 });
          if (!line.trim()) {
            lineRow.add(
              new Text(line || ' ', {
                font: codeFont,
                color: t.codeColor,
                preserveLeadingSpaces: true,
              }),
            );
          } else {
            for (const seg of segments) {
              lineRow.add(
                new Text(seg.text, {
                  font: codeFont,
                  color: seg.color,
                  preserveLeadingSpaces: true,
                }),
              );
            }
          }
          lineRow.height = lineH;
          linesContainer.add(lineRow);
        }

        const bgHeight = linesContainer.height + pad * 2;
        const bg = new RoundedRect(this.maxWidth, bgHeight, t.codeBgColor, 8);
        bg.x = 0;
        bg.y = 0;
        codeContainer.add(bg);

        linesContainer.x = pad;
        linesContainer.y = pad;
        codeContainer.add(linesContainer);

        codeContainer.width = this.maxWidth;
        codeContainer.height = bgHeight;

        return codeContainer;
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
          const itemText = new Text(bullet + item.text, {
            font: bodyFont,
            color: t.textColor,
            maxWidth: this.maxWidth - 24,
            lineHeight: 24,
          });
          itemText.x = 12; // Indent
          listStack.add(itemText);
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
