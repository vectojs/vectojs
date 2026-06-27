import {
  A11yAttributes,
  IRenderer,
  LayoutEngine,
  type ExclusionRect,
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
  /** Color for link runs that don't set their own `color`. Default `'#38bdf8'`. */
  linkColor?: string;
  /** Invoked with the `href` when a link run is activated (click / Enter via its shadow `<a>`). */
  onLinkClick?: (href: string) => void;
  /** Rect regions (local space) the text flows around — "文字绕流" / floats. */
  exclusions?: ExclusionRect[];
}

/**
 * A transparent, interactive hotspot over a link run. It renders nothing (the
 * {@link RichText} draws the underlined text); it exists so the a11y/automation
 * layer projects a real `<a href>` an agent or screen-reader can find and click,
 * and so a canvas click routes to {@link RichTextOptions.onLinkClick}.
 */
class LinkHotspot extends UIComponent {
  public href: string;
  constructor(href: string, onClick?: (href: string) => void) {
    super();
    this.href = href;
    this.interactive = true;
    this.on('click', () => onClick?.(this.href));
  }
  public getA11yAttributes(): A11yAttributes {
    return { tag: 'a', href: this.href, label: this.href };
  }
  public render(): void {
    /* invisible — RichText paints the text */
  }
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

  public linkColor: string;
  public exclusions?: ExclusionRect[];

  private engine: LayoutEngine;
  private baseFontSize: number;
  private baseStyle?: TextStyle;
  private result: LayoutResult;
  private onLinkClick?: (href: string) => void;
  /** One transparent `<a>` hotspot child per link run (kept in sync with layout). */
  private hotspots: LinkHotspot[] = [];

  constructor(spans: StyledSpan[], opts: RichTextOptions = {}) {
    super();
    this.spans = spans;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.maxWidth = opts.maxWidth;
    this.baseStyle = opts.baseStyle;
    this.linkColor = opts.linkColor ?? '#38bdf8';
    this.onLinkClick = opts.onLinkClick;
    this.exclusions = opts.exclusions;
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

  /** Set the rect regions the text flows around ("文字绕流") and re-lay out. */
  public setExclusions(exclusions: ExclusionRect[]): this {
    this.exclusions = exclusions;
    this.result = this.layout();
    return this;
  }

  /**
   * Append styled runs and re-lay out — the streaming / typewriter path. The
   * engine's rich paragraph memo reuses every untouched leading paragraph, so a
   * token-by-token stream re-prepares in O(changed paragraph), not O(document).
   */
  public appendSpans(spans: StyledSpan[]): this {
    this.spans = [...this.spans, ...spans];
    this.result = this.layout();
    return this;
  }

  private layout(): LayoutResult {
    const prepared = this.engine.prepareRich(this.spans, {}, this.baseFontSize, this.baseStyle);
    const result = this.engine.layoutPrepared(prepared, undefined, this.exclusions);
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    this.result = result;
    this.syncHotspots();
    return result;
  }

  /** One box per contiguous link run, sized to its first wrapped line. */
  private computeLinks(): Array<{
    href: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    const out: Array<{ href: string; x: number; y: number; width: number; height: number }> = [];
    const nodes = this.result.nodes;
    let i = 0;
    while (i < nodes.length) {
      const href = nodes[i].style?.href;
      if (!href) {
        i++;
        continue;
      }
      let j = i;
      while (j < nodes.length && nodes[j].style?.href === href) j++;
      const run = nodes.slice(i, j);
      const y0 = Math.min(...run.map((n) => n.y));
      const firstLine = run.filter((n) => n.y === y0);
      const x = Math.min(...firstLine.map((n) => n.x));
      const right = Math.max(...firstLine.map((n) => n.x + n.width));
      const height = Math.max(...firstLine.map((n) => n.height));
      out.push({ href, x, y: y0, width: right - x, height });
      i = j;
    }
    return out;
  }

  /**
   * Reconcile the `<a>` hotspot children with the current link runs. Stable
   * across re-wrap (one hotspot per run), so positions update in place; only a
   * change in link *count* rebuilds (pruning old shadow nodes via the scene).
   */
  private syncHotspots(): void {
    const links = this.computeLinks();
    if (links.length !== this.hotspots.length) {
      for (const old of this.hotspots) {
        this.remove(old);
        this.scene?.detachA11y(old);
      }
      this.hotspots = links.map((l) => {
        const h = new LinkHotspot(l.href, this.onLinkClick);
        this.add(h);
        return h;
      });
    }
    for (let k = 0; k < links.length; k++) {
      const l = links[k];
      const h = this.hotspots[k];
      h.href = l.href;
      h.setPosition(l.x, l.y);
      h.width = l.width;
      h.height = l.height;
    }
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
      const isLink = !!node.style?.href;
      const color = node.style?.color ?? (isLink ? this.linkColor : this.color);
      const baseline = node.y + size * 0.8; // node.y is the top; fillText y is the baseline
      r.fillText(node.char, node.x, baseline, font, color);
      if (isLink) {
        const uy = baseline + 2;
        r.beginPath();
        r.moveTo(node.x, uy);
        r.lineTo(node.x + node.width, uy);
        r.stroke(color, 1);
      }
    }
  }
}
