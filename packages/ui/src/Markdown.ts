import {
  Entity,
  IRenderer,
  type ContentProjection,
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
        return src.match(/\$/)?.index;
      },
      tokenizer(src) {
        const match = /^\$([^$]+)\$/.exec(src);
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
import { measureText } from './measure';
import { RichText } from './RichText';
import { Stack } from './Stack';
import { Table } from './Table';
import { Text } from './Text';
import { Image } from './Image';
import { UIComponent } from './UIComponent';

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
const workerCallbacks = new Map<number, { cb: (tokens: TokensList) => void; text: string }>();

/**
 * The worker failed for this request (lexer threw, or the worker itself
 * died). Dropping the callback would lose that update for good — for the
 * final chunk of a stream that means content that never renders. Parse on
 * the main thread instead; it is the exact code path the no-Worker
 * environments already use.
 */
function runSyncFallback(entry: { cb: (tokens: TokensList) => void; text: string }): void {
  try {
    entry.cb(marked.lexer(entry.text));
  } catch (err) {
    console.warn('Markdown sync fallback parse failed', err);
  }
}

if (typeof Worker !== 'undefined') {
  try {
    const blob = new Blob([WORKER_SOURCE_STRING], { type: 'application/javascript' });
    markdownWorker = new Worker(URL.createObjectURL(blob));
    markdownWorker.onmessage = (e) => {
      const { id, tokens, error } = e.data;
      const entry = workerCallbacks.get(id);
      if (entry) {
        workerCallbacks.delete(id);
        if (!error) entry.cb(tokens as TokensList);
        else runSyncFallback(entry);
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
    const sourceLines = this.source.split('\n');
    return {
      text: this.source,
      font: this.codeFont,
      lineHeight: this.lineH,
      // Every row is absolutely positioned from the same local coordinates as
      // render(). A single pre-wrap DOM text node would introduce browser
      // wrapping for long source lines that canvas intentionally keeps intact.
      lines: sourceLines.map((text, row) => ({
        text,
        separatorAfter: row < sourceLines.length - 1 ? '\n' : undefined,
        x: this.pad,
        y: this.pad + row * this.lineH,
        baseline: this.lineH * 0.75,
        font: this.codeFont,
        lineHeight: this.lineH,
      })),
      selectable: this.selectable,
    };
  }

  private buildLines(code: string): void {
    const rawLines = code.split('\n');
    this.lines = rawLines.map((l) => highlightLine(l, this.lang, this.theme));
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

    const cellWidth = this.cellWidth || Math.max(1, measureText('M', this.codeFont));

    // Text lines
    for (let row = 0; row < this.lines.length; row++) {
      const segs = this.lines[row];
      let colOffset = 0;
      let xOffset = 0;
      const yBaseline = this.pad + row * this.lineH + this.lineH * 0.75;
      for (let col = 0; col < segs.length; col++) {
        const segment = segs[col];
        const gridX = colOffset * cellWidth;
        const posX = Math.max(gridX, xOffset);
        r.fillText(segment.text, this.pad + posX, yBaseline, this.codeFont, segment.color);
        colOffset += segment.text.length;
        xOffset = posX + measureText(segment.text, this.codeFont);
      }
    }
  }
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
        out.push({ text: decodeEntities(t.raw), style: { ...inherited, color: '#fcd34d' } }); // yellow/gold for inline math
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
  private tokens: Token[];

  constructor(markdownText: string, opts: MarkdownOptions = {}) {
    super();
    this.maxWidth = opts.maxWidth ?? 800;
    this.theme = { ...DEFAULT_THEME, ...opts.theme };
    this.onLinkClick = opts.onLinkClick;
    this.selectable = opts.selectable ?? true;

    this.content = new Stack({ direction: 'vertical', gap: 16 });
    this.add(this.content);

    this.rawMarkdown = markdownText;
    this.tokens = [];
    this.renderMarkdown(markdownText);
  }

  private renderMarkdown(text: string): void {
    const tokens = marked.lexer(text);
    this.tokens = tokens;
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
    // Remove all children from the content stack
    while (this.content.children.length > 0) {
      this.content.remove(this.content.children[this.content.children.length - 1]);
    }
    this.tokens = [];
    this.renderMarkdown(markdown);
    return this;
  }

  /** Enable or disable native selection for existing and future Markdown text. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    const apply = (entity: Entity): void => {
      const candidate = entity as Entity & { setSelectable?: (value: boolean) => unknown };
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

    if (markdownWorker) {
      const id = workerIdCounter++;
      workerCallbacks.set(id, {
        cb: (newTokens) => {
          this.updateTokens(newTokens);
        },
        text: this.rawMarkdown,
      });
      markdownWorker.postMessage({ id, text: this.rawMarkdown });
    } else {
      const newTokens = marked.lexer(this.rawMarkdown);
      this.updateTokens(newTokens);
    }
    return this;
  }

  private updateTokens(newTokens: TokensList): void {
    const oldTokens = this.tokens;
    const oldChildren = [...this.content.children]; // snapshot

    // Find the matching prefix length (by comparing token raw source)
    let matchLen = 0;
    const minLen = Math.min(oldTokens.length, newTokens.length);
    // Map from old token index to child entity index (skip 'space' tokens
    // that produce null entities)
    let childIdx = 0;
    const oldTokenToChild: number[] = [];
    for (let i = 0; i < oldTokens.length; i++) {
      oldTokenToChild.push(childIdx);
      if (oldTokens[i].type !== 'space') childIdx++;
    }

    // Compare tokens by raw source
    for (let i = 0; i < minLen; i++) {
      if (oldTokens[i].raw === newTokens[i].raw) {
        matchLen++;
      } else {
        break;
      }
    }

    // Handle the common streaming case: last token changed (paragraph grew)
    // If only the last old token changed and it's the same type, update in-place
    if (
      matchLen === oldTokens.length - 1 &&
      matchLen < newTokens.length &&
      oldTokens[matchLen]?.type === newTokens[matchLen]?.type &&
      newTokens[matchLen]?.type === 'paragraph'
    ) {
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
      }
    }

    // Remove excess old entities (from matchLen onward)
    for (let i = 0; i < oldTokens.length; i++) {
      if (i >= matchLen && oldTokens[i].type !== 'space') {
        const idx = oldTokenToChild[i];
        if (idx < oldChildren.length) {
          this.content.remove(oldChildren[idx]);
        }
      }
    }

    // Add new entities for tokens beyond matchLen
    for (let i = matchLen; i < newTokens.length; i++) {
      const el = this.renderToken(newTokens[i]);
      if (el) this.content.add(el);
    }

    this.tokens = newTokens;
    this.content.layout();
    this.width = this.content.width;
    this.height = this.content.height;

    this.scene?.markDirty();
    if (this.onLayoutUpdated) {
      this.onLayoutUpdated();
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
        const stack = new Stack({ direction: 'vertical', gap: 16, maxWidth: this.maxWidth });
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
