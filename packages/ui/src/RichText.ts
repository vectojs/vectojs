import {
  A11yAttributes,
  IRenderer,
  LayoutEngine,
  type GlyphMeasurer,
  type LayoutResult,
  type StyledSpan,
  type TextStyle,
} from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { fontSizePx } from './measure';

/** Construction options for {@link RichText}. */
export interface RichTextOptions {
  /** Base CSS font shorthand (family + default size). Default `'16px sans-serif'`. */
  font?: string;
  /** Default fill color for runs without their own `color`. Default `'#e2e8f0'`. */
  color?: string;
  /** Wrap width in pixels. When omitted, only explicit newlines break lines. */
  maxWidth?: number;
  /** Style inherited by every run (each run's own style still wins). */
  baseStyle?: TextStyle;
}

/** Extract the family portion of a CSS font shorthand (drops a leading `<n>px`). */
function familyOf(font: string): string {
  return font.replace(/^\s*(?:[a-z-]+\s+)*?[\d.]+px\s*/i, '').trim() || 'sans-serif';
}

/**
 * A {@link GlyphMeasurer} that measures with the base CSS `font`. Returns `null`
 * without a DOM so the engine keeps its portable 0.5em fallback. (Bold/italic
 * runs are measured at the base weight — a small, documented width approximation;
 * size differences ARE honored via the per-run font size.)
 */
function baseMeasurer(font: string): GlyphMeasurer | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const cache = new Map<string, number>();
  return {
    measure(char: string, fontSize: number): number {
      const key = `${fontSize} ${char}`;
      let w = cache.get(key);
      if (w === undefined) {
        ctx.font = `${fontSize}px ${familyOf(font)}`;
        w = ctx.measureText(char).width;
        cache.set(key, w);
      }
      return w;
    },
  };
}

/**
 * Multi-style inline text: bold / italic / colored / differently-sized runs flow
 * and wrap on the same lines, sharing a baseline (战役一). Layout goes through the
 * core {@link LayoutEngine}'s rich path (`prepareRich`); each positioned glyph is
 * drawn with its run's color and weight/slant via native `fillText`.
 *
 * @example
 * new RichText([
 *   { text: 'The ' },
 *   { text: 'quick', style: { bold: true, color: '#38bdf8' } },
 *   { text: ' brown ' },
 *   { text: 'fox', style: { italic: true } },
 * ], { maxWidth: 240 });
 */
export class RichText extends UIComponent {
  public spans: StyledSpan[];
  public font: string;
  public color: string;
  public maxWidth?: number;

  private engine: LayoutEngine;
  private baseFontSize: number;
  private baseStyle?: TextStyle;
  private result: LayoutResult;

  constructor(spans: StyledSpan[], opts: RichTextOptions = {}) {
    super();
    this.spans = spans;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.maxWidth = opts.maxWidth;
    this.baseStyle = opts.baseStyle;
    this.baseFontSize = fontSizePx(this.font);
    this.engine = new LayoutEngine(this.maxWidth ?? 1e9, 1e9, baseMeasurer(this.font));
    this.interactive = true;
    this.result = this.layout();
  }

  /** Replace the styled runs and re-lay out. */
  public setSpans(spans: StyledSpan[]): this {
    this.spans = spans;
    this.result = this.layout();
    return this;
  }

  /** Change the wrap width and re-lay out. */
  public setMaxWidth(maxWidth: number): this {
    this.maxWidth = maxWidth;
    this.engine.maxWidth = maxWidth;
    this.result = this.layout();
    return this;
  }

  private layout(): LayoutResult {
    const prepared = this.engine.prepareRich(this.spans, {}, this.baseFontSize, this.baseStyle);
    const result = this.engine.layoutPrepared(prepared);
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    return result;
  }

  /** The full text content, used as the accessible name. */
  private fullText(): string {
    return this.spans.map((s) => s.text).join('');
  }

  /** Build the CSS font shorthand for a node's style. */
  private nodeFont(style: TextStyle | undefined, size: number): string {
    const italic = style?.italic ? 'italic ' : '';
    const bold = style?.bold ? 'bold ' : '';
    return `${italic}${bold}${size}px ${familyOf(this.font)}`;
  }

  public getA11yAttributes(): A11yAttributes {
    return { label: this.fullText() };
  }

  public render(r: IRenderer): void {
    for (const node of this.result.nodes) {
      if (node.char.trim().length === 0) continue;
      const size = node.height;
      const font = this.nodeFont(node.style, size);
      const color = node.style?.color ?? this.color;
      // `node.y` is the glyph's top; fillText's y is the baseline (~0.8 down).
      r.fillText(node.char, node.x, node.y + size * 0.8, font, color);
    }
  }
}
