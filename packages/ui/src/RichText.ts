import {
  A11yAttributes,
  IRenderer,
  LayoutEngine,
  sanitizeUrl,
  type ExclusionRect,
  type GlyphMeasurer,
  type LayoutResult,
  type StyledSpan,
  type ContentProjection,
  type TextStyle,
} from '@vectojs/core';
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
  /** Rect regions (local space) the text flows around — exclusion shapes / CSS-like floats. */
  exclusions?: ExclusionRect[];
  /** Allow browser-native drag selection and copy. Default `true`. */
  selectable?: boolean;
  /**
   * Horizontal alignment. `'justify'` stretches every wrapped line flush to
   * {@link maxWidth} (the paragraph-final and newline-ended lines stay ragged);
   * `'left'` (default) leaves them ragged. Needs a {@link maxWidth} to have an
   * effect. Free here — `RichText` already draws each glyph at its own `node.x`,
   * which the engine's justify pass repositions.
   */
  textAlign?: 'left' | 'justify';
  /**
   * Optional hyphenator: given a word, return its break parts (e.g.
   * `['hyphen', 'ation']`). A word that doesn't fit breaks at the chosen point
   * with a visible `-`. Soft hyphens (U+00AD) already present in a run's text
   * work without one.
   */
  hyphenate?: (word: string) => string[];
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
    this.on('click', () => {
      const safe = sanitizeUrl(this.href);
      if (safe && safe !== '#') onClick?.(safe);
    });
  }
  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'a',
      href: sanitizeUrl(this.href),
      label: this.href,
      target: '_blank',
    };
  }

  public render(): void {
    /* invisible — RichText paints the text */
  }
}

/** Extract the family portion of a CSS font shorthand (drops a leading `<n>px`). */
function familyOf(font: string): string {
  const pxIndex = font.indexOf('px');
  if (pxIndex < 0) return font.trim() || 'sans-serif';

  let rest = font.slice(pxIndex + 2).trimStart();
  if (rest.startsWith('/')) {
    let i = 1;
    while (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t') i++;
    rest = rest.slice(i).trimStart();
  }

  return rest || 'sans-serif';
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
 * and wrap on the same lines, sharing a baseline (Campaign 1). Layout goes through the
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
  public selectable: boolean;

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
    this.selectable = opts.selectable ?? true;
    this.baseStyle = opts.baseStyle;
    this.linkColor = opts.linkColor ?? '#38bdf8';
    this.onLinkClick = opts.onLinkClick;
    this.exclusions = opts.exclusions;
    this.baseFontSize = fontSizePx(this.font);
    this.engine = new LayoutEngine(this.maxWidth ?? 1e9, 1e9, baseMeasurer(this.font));
    this.engine.textAlign = opts.textAlign ?? 'left';
    if (opts.hyphenate) this.engine.hyphenate = opts.hyphenate;
    this.interactive = false;
    this.result = this.layout();
  }

  /** Replace the styled runs and re-lay out. */
  public setSpans(spans: StyledSpan[]): this {
    this.spans = spans;
    this.result = this.layout();
    this.scene?.markDirty();
    return this;
  }

  /** Change the wrap width and re-lay out. */
  public setMaxWidth(maxWidth: number): this {
    this.maxWidth = maxWidth;
    this.engine.maxWidth = maxWidth;
    this.result = this.layout();
    this.scene?.markDirty();
    return this;
  }

  /**
   * Set horizontal alignment (`'justify'` stretches wrapped lines flush to
   * {@link setMaxWidth}'s width; the last line stays ragged) and re-lay out.
   */
  public setTextAlign(align: 'left' | 'justify'): this {
    this.engine.textAlign = align;
    this.result = this.layout();
    this.scene?.markDirty();
    return this;
  }

  /** Set the rect regions the text flows around (exclusion shapes) and re-lay out. */
  public setExclusions(exclusions: ExclusionRect[]): this {
    this.exclusions = exclusions;
    this.result = this.layout();
    this.scene?.markDirty();
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
    this.scene?.markDirty();
    return this;
  }

  /** Enable or disable browser-native drag selection without rebuilding the entity. */
  public setSelectable(selectable: boolean): this {
    this.selectable = selectable;
    this.scene?.markDirty();
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
    const out: Array<{
      href: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
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

  /** Rebuild styled DOM runs from a logical UTF-16 source interval. */
  private logicalRuns(start: number, end: number): Array<{ text: string; font: string }> {
    const runs: Array<{ text: string; font: string }> = [];
    let offset = 0;
    for (const span of this.spans) {
      const spanEnd = offset + span.text.length;
      const from = Math.max(start, offset);
      const to = Math.min(end, spanEnd);
      if (from < to) {
        const style =
          span.style || this.baseStyle ? { ...this.baseStyle, ...span.style } : undefined;
        const font = this.nodeFont(style, style?.fontSize ?? this.baseFontSize);
        const text = span.text.slice(from - offset, to - offset);
        const previous = runs.at(-1);
        if (previous?.font === font) previous.text += text;
        else runs.push({ text, font });
      }
      offset = spanEnd;
    }
    return runs;
  }

  /**
   * Positioned per-style-run carriers for a justified line. justify widens the
   * inter-word gaps on the canvas, so natural-flow DOM runs would drift; give
   * each run the visual `x` (and `width` spanning to the next run, gap included)
   * taken from the laid-out glyphs, split at font-style boundaries so mixed
   * bold/italic/size runs keep their own font. Run text is the logical SOURCE
   * substring (not `node.char`) so copy / AT stay correct even for shaped glyphs.
   */
  private positionedRuns(
    nodes: LayoutResult['nodes'],
  ): Array<{ text: string; font: string; x: number; width: number }> {
    const source = this.fullText();
    // Visual order. One carrier PER GLYPH: justify widens the gaps between words
    // (and the engine can even reorder a trailing space around a wrap boundary),
    // so only a per-glyph carrier positioned at each glyph's own visual x keeps
    // the DOM selection box on the drawn glyphs. Each carrier's text is the
    // glyph's LOGICAL source substring (not node.char) so copy / AT stay correct
    // for shaped scripts; carriers are emitted in visual order but the browser
    // reads their text nodes in DOM order, which for LTR justify is logical too.
    const glyphs = nodes.slice().sort((a, b) => (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0));
    const runs: Array<{
      text: string;
      font: string;
      x: number;
      width: number;
    }> = [];
    for (const g of glyphs) {
      const s = g.sourceIndex ?? 0;
      const text = source.slice(s, s + (g.sourceLength ?? 0)) || g.char;
      runs.push({
        text,
        font: this.nodeFont(g.style, g.height),
        x: g.x,
        width: g.width,
      });
    }
    return runs;
  }

  /**
   * Group the laid-out glyphs into the same visual lines the canvas draws.
   * Each line keeps its real local origin and run fonts, so the semantic DOM
   * never has to re-flow mixed-size markdown differently from the canvas.
   */
  private visualLineGroups(): Array<{
    nodes: LayoutResult['nodes'];
    projection: NonNullable<ContentProjection['lines']>[number];
  }> {
    const groups: LayoutResult['nodes'][] = [];
    for (const node of this.result.nodes) {
      const previous = groups.at(-1);
      const baseline = node.y + node.height * 0.8;
      const previousBaseline = previous ? previous[0].y + previous[0].height * 0.8 : Number.NaN;
      if (!previous || Math.abs(previousBaseline - baseline) > 0.01) groups.push([node]);
      else previous.push(node);
    }

    const source = this.fullText();
    return groups.map((nodes, index) => {
      const largest = Math.max(...nodes.map((node) => node.height));
      const font = this.nodeFont(undefined, largest);
      let sourceStart = Math.min(...nodes.map((node) => node.sourceIndex ?? 0));
      const sourceEnd = Math.max(
        ...nodes.map((node) => (node.sourceIndex ?? 0) + (node.sourceLength ?? 0)),
      );
      if (index === 0) sourceStart = 0;
      const nextNodes = groups[index + 1];
      const nextStart = nextNodes
        ? Math.min(...nextNodes.map((node) => node.sourceIndex ?? sourceEnd))
        : source.length;
      // Justified lines need positioned runs so the DOM selection box tracks
      // the widened canvas spacing; ragged (left) lines keep cheap natural flow.
      const runs =
        this.engine.textAlign === 'justify'
          ? this.positionedRuns(nodes)
          : this.logicalRuns(sourceStart, sourceEnd);
      const y = Math.min(...nodes.map((node) => node.y));
      const baseline = nodes[0].y + nodes[0].height * 0.8 - y;
      return {
        nodes,
        projection: {
          text: source.slice(sourceStart, sourceEnd),
          separatorAfter: source.slice(sourceEnd, Math.max(sourceEnd, nextStart)),
          x: Math.min(...nodes.map((node) => node.x)),
          y,
          baseline,
          font,
          // LayoutEngine advances a paragraph by its largest run, not the
          // component default. Keep the native selection box on that same
          // rhythm when a heading or inline large text shares a line.
          lineHeight: largest * 1.5,
          runs,
        },
      };
    });
  }

  private projectedLines(): NonNullable<ContentProjection['lines']> {
    return this.visualLineGroups().map(({ projection }) => projection);
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

  /** Mirror the concatenated span text into the DOM content layer. */
  public override getContentProjection(): ContentProjection | null {
    const text = this.fullText();
    if (!text) return null;
    // The engine advances lines by fontSize × 1.5; without matching the DOM
    // line-height, multi-line selection highlights drift off the glyphs.
    return {
      text,
      font: this.font,
      lineHeight: this.baseFontSize * 1.5,
      lines: this.projectedLines(),
      selectable: this.selectable,
    };
  }

  public render(r: IRenderer): void {
    for (const { nodes, projection: line } of this.visualLineGroups()) {
      for (const node of nodes) {
        if (node.char.trim().length === 0) continue;
        const size = node.height;
        const font = this.nodeFont(node.style, size);
        const isLink = !!node.style?.href;
        const color = node.style?.color ?? (isLink ? this.linkColor : this.color);
        const baseline = line.y + line.baseline;
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
}
