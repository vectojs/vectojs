import {
  A11yAttributes,
  EMPTY_GLYPH_ATLAS,
  IRenderer,
  LayoutEngine,
  sanitizeUrl,
  type ExclusionRect,
  type GlyphMeasurer,
  type LayoutResult,
  type StyledSpan,
  type ContentProjection,
  type TextStyle,
  createMetricsMeasurer,
} from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { createMeasuringContext, familyOf, fontSizePx, measureText } from './measure';

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

interface LinkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transparent pointer region for one visual line of a logical link. It is
 * projected only so browser pointer input stays above selectable text; the
 * presentational role keeps the semantic tree at one parent anchor.
 */
class LinkHitRegion extends UIComponent {
  constructor() {
    super();
    this.interactive = true;
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'presentation' };
  }

  public render(): void {
    /* invisible — RichText paints the text */
  }
}

/**
 * A transparent, interactive hotspot over a link run. It renders nothing (the
 * {@link RichText} draws the underlined text); it exists so the a11y/automation
 * layer projects one real `<a href>` an agent or screen-reader can find and
 * click, while presentational child regions route canvas and browser pointer
 * input from every visual line to {@link RichTextOptions.onLinkClick}.
 */
class LinkHotspot extends UIComponent {
  public href: string;
  private hitRegions: LinkHitRegion[] = [];

  constructor(href: string, onClick?: (href: string) => void) {
    super();
    this.href = href;
    this.interactive = true;
    this.on('click', () => {
      const safe = sanitizeUrl(this.href);
      if (safe && safe !== '#') onClick?.(safe);
    });
  }

  public setRects(rects: LinkRect[]): void {
    let left = rects[0].x;
    let top = rects[0].y;
    let right = rects[0].x + rects[0].width;
    let bottom = rects[0].y + rects[0].height;
    for (let i = 1; i < rects.length; i++) {
      const rect = rects[i];
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }

    this.setPosition(left, top);
    this.width = right - left;
    this.height = bottom - top;
    if (rects.length !== this.hitRegions.length) {
      for (const old of this.hitRegions) {
        this.remove(old);
        this.scene?.detachA11y(old);
      }
      this.hitRegions = rects.map(() => {
        const region = new LinkHitRegion();
        this.add(region);
        return region;
      });
    }
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const region = this.hitRegions[i];
      region.setPosition(rect.x - left, rect.y - top);
      region.width = rect.width;
      region.height = rect.height;
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'a',
      href: sanitizeUrl(this.href),
      label: this.href,
      target: '_blank',
      pointerEvents: 'none',
    };
  }

  public render(): void {
    /* invisible — RichText paints the text */
  }
}

/**
 * A {@link GlyphMeasurer} that measures with the base CSS `font`. Without a DOM
 * it falls back to metrics registered via `registerFontMetrics`, and only with
 * none of those does the engine keep its portable 0.5em fallback. (Bold/italic
 * runs are measured at the base weight — a small, documented width approximation;
 * size differences ARE honored via the per-run font size.)
 */
function baseMeasurer(font: string): GlyphMeasurer | null {
  if (typeof document === 'undefined') return createMetricsMeasurer(familyOf(font));
  // Attached, not detached — see createMeasuringContext: Firefox resolves
  // generic font families against the document, so a detached canvas measures
  // monospace 20% narrow while the engine paints at the real width, and the
  // following run overlaps the tail of this one.
  const ctx = createMeasuringContext();
  if (!ctx) return createMetricsMeasurer(familyOf(font));
  const cache = new Map<string, number>();
  return {
    measure(char: string, fontSize: number, fontFamily?: string): number {
      const family = fontFamily ?? familyOf(font);
      const key = `${fontSize} ${family} ${char}`;
      let w = cache.get(key);
      if (w === undefined) {
        ctx.font = `${fontSize}px ${family}`;
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
/**
 * Slack when comparing a coalesced run's measured width against the summed
 * per-glyph advances, and when testing glyph adjacency. Sub-pixel: large enough to
 * absorb float accumulation over a line, small enough that real kerning (which
 * moves glyphs by a meaningful fraction of an em) always fails the test.
 */
const COALESCE_TOLERANCE_PX = 0.5;

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
  /** Memoized visual line groups, keyed on the `result` identity that produced
   *  them. `render()` runs every frame and both it and the content projection
   *  call `visualLineGroups()`; rebuilding the groups (an O(glyphs) walk with a
   *  `Math.max(...map())` per line) each time showed up as steady-state cost on
   *  60fps chat transcripts. `layout()` swaps in a fresh `result` object, so a
   *  reference check is a sufficient and cheap invalidation signal. */
  private _lineGroupsCache: {
    result: LayoutResult;
    groups: ReturnType<RichText['buildVisualLineGroups']>;
  } | null = null;
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
    // EMPTY_GLYPH_ATLAS, not a fresh `{}`: the engine invalidates its memoized
    // paragraphs whenever the atlas is not the same object as last call, so a
    // literal here cleared the cache on every single layout. See its docstring.
    const prepared = this.engine.prepareRich(
      this.spans,
      EMPTY_GLYPH_ATLAS,
      this.baseFontSize,
      this.baseStyle,
    );
    const result = this.engine.layoutPrepared(prepared, undefined, this.exclusions);
    this.width = result.totalWidth;
    this.height = result.totalHeight;
    this.result = result;
    this.syncHotspots();
    return result;
  }

  /** One logical link per contiguous run, with one hit rectangle per visual line. */
  private computeLinks(): Array<{ href: string; rects: LinkRect[] }> {
    const out: Array<{ href: string; rects: LinkRect[] }> = [];
    const nodes = this.result.nodes;
    let i = 0;
    while (i < nodes.length) {
      const first = nodes[i];
      const href = first.style?.href;
      if (!href) {
        i++;
        continue;
      }

      const rects: LinkRect[] = [];
      let lineY = first.y;
      let left = first.x;
      let right = first.x + first.width;
      let height = first.height;
      let j = i + 1;
      while (j < nodes.length && nodes[j].style?.href === href) {
        const node = nodes[j];
        if (node.y !== lineY) {
          rects.push({ x: left, y: lineY, width: right - left, height });
          lineY = node.y;
          left = node.x;
          right = node.x + node.width;
          height = node.height;
        } else {
          left = Math.min(left, node.x);
          right = Math.max(right, node.x + node.width);
          height = Math.max(height, node.height);
        }
        j++;
      }
      rects.push({ x: left, y: lineY, width: right - left, height });
      out.push({ href, rects });
      i = j;
    }
    return out;
  }

  /**
   * Reconcile the `<a>` hotspot children with the current logical link runs.
   * Stable across re-wrap, so per-line hit rectangles update in place; only a
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
      h.setRects(l.rects);
    }
  }

  /**
   * The concatenated span text exactly as the engine saw it.
   *
   * Offsets into this string are what `LayoutNode.sourceIndex` indexes, so it
   * must stay byte-for-byte aligned with the spans — including a one-character
   * U+FFFC for each inline object. Use {@link accessibleText} for anything
   * user-facing.
   */
  private sourceText(): string {
    return this.spans.map((s) => s.text).join('');
  }

  /**
   * The text content for the accessible name.
   *
   * An inline-object span contributes its `alt` rather than the raw U+FFFC
   * sentinel, which is meaningless to a screen reader and copies as an invisible
   * character. A span with no `alt` contributes nothing.
   *
   * Deliberately NOT usable for `sourceIndex` slicing: substituting an `alt` of
   * any length other than one shifts every later offset.
   */
  private accessibleText(): string {
    return this.spans.map((s) => (s.object ? (s.object.alt ?? '') : s.text)).join('');
  }

  /**
   * The projected text for a half-open interval of {@link sourceText} offsets,
   * with each inline object's U+FFFC sentinel replaced by its `alt`.
   *
   * This is the one function that reconciles two things that cannot both be a
   * single string. Layout offsets (`LayoutNode.sourceIndex`) index
   * {@link sourceText}, where an inline object is exactly one character, so the
   * line-slicing arithmetic in {@link buildVisualLineGroups} must stay in that
   * coordinate space. But what the DOM projection *emits* has to be readable: a
   * raw U+FFFC copies out of a real browser `Range` as an invisible character, so
   * a paragraph with inline math yielded `'Inline math \ufffc inside a sentence.'`
   * on a plain Ctrl+C.
   *
   * Substituting cannot be done by swapping {@link sourceText} for
   * {@link accessibleText} at the top of {@link getContentProjection}, which is why
   * this exists: an `alt` of any length other than one shifts every later offset,
   * so the slices would desynchronise from the laid-out glyphs and the selection
   * boxes would drift. Taking the interval in *source* coordinates and substituting
   * only on the way out keeps every offset intact while changing what is emitted.
   *
   * A span with no `alt` contributes nothing, matching {@link accessibleText}: an
   * unlabelled decorative object is better absent from a copy than present as an
   * invisible character.
   */
  private projectedSlice(start: number, end: number): string {
    let out = '';
    let offset = 0;
    for (const span of this.spans) {
      const spanEnd = offset + span.text.length;
      const from = Math.max(start, offset);
      const to = Math.min(end, spanEnd);
      if (from < to) {
        // An object span is exactly one U+FFFC (LayoutEngine requires it), so any
        // overlap at all covers the whole sentinel and the alt is emitted once.
        out += span.object ? (span.object.alt ?? '') : span.text.slice(from - offset, to - offset);
      }
      offset = spanEnd;
      if (offset >= end) break;
    }
    return out;
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
        // The alt, not the U+FFFC sentinel — see `projectedSlice`. An object span
        // is exactly one sentinel character, so any overlap covers all of it.
        const text = span.object
          ? (span.object.alt ?? '')
          : span.text.slice(from - offset, to - offset);
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
      // `projectedSlice`, not a raw `source.slice`: a reserved inline-object glyph
      // must carry its `alt` into the carrier's text or a justified line copies the
      // invisible sentinel. Falls back to `g.char` only when the node claims no
      // source extent at all.
      const text = this.projectedSlice(s, s + (g.sourceLength ?? 0)) || (g.object ? '' : g.char);
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
  /** Memoized on `result` identity — see `_lineGroupsCache`. */
  private visualLineGroups(): ReturnType<RichText['buildVisualLineGroups']> {
    const cache = this._lineGroupsCache;
    if (cache && cache.result === this.result) return cache.groups;
    const groups = this.buildVisualLineGroups();
    this._lineGroupsCache = { result: this.result, groups };
    return groups;
  }

  private buildVisualLineGroups(): Array<{
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

    const source = this.sourceText();
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
          // Offsets stay in `sourceText` space (that is what `sourceIndex` indexes);
          // only the emitted string substitutes each inline object's `alt`.
          text: this.projectedSlice(sourceStart, sourceEnd),
          separatorAfter: this.projectedSlice(sourceEnd, Math.max(sourceEnd, nextStart)),
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
    // A run may override the family (e.g. inline monospace code); fall back to
    // the component's base family otherwise.
    const family = style?.fontFamily ?? familyOf(this.font);
    return `${italic}${bold}${size}px ${family}`;
  }

  public getA11yAttributes(): A11yAttributes {
    return { label: this.accessibleText() };
  }

  /** Mirror the concatenated span text into the DOM content layer. */
  public override getContentProjection(): ContentProjection | null {
    // Emptiness is decided on the SOURCE, not the projected text: a paragraph whose
    // only content is an unlabelled inline object projects an empty string but still
    // occupies layout, and returning a projection with `text: ''` would make Scene
    // release the DOM node on every frame it is rebuilt.
    if (!this.sourceText()) return null;
    const text = this.projectedSlice(0, this.sourceText().length);
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
      const baseline = line.y + line.baseline;
      let runStart = -1;
      let runText = '';
      let runFont = '';
      let runColor = '';
      let runWidth = 0;
      let runStruck = false;
      let runSize = 0;

      /**
       * Emit the pending run as ONE `fillText`, or fall back to per-character
       * draws when coalescing would move a glyph.
       *
       * Why the check exists: layout measures and positions each character
       * individually (`measure.ts` calls `ctx.measureText(char)` per glyph), so a
       * node's `x` is a sum of isolated advances with no kerning. Drawing the same
       * characters as one string lets the browser apply kerning and ligatures, so
       * for a font/script where that changes the total the glyphs would no longer
       * sit where layout put them — visible as text that drifts from its
       * selection overlay and its hit box.
       *
       * So a run is only coalesced when its measured width equals the summed
       * per-glyph advances. That is true for the ASCII-with-default-kerning
       * majority and false exactly where it must be, and it is one `measureText`
       * per run (memoized) against what was one `fillText` per character.
       */
      /**
       * Strike one line across the whole flushed run.
       *
       * Cheaper than the link underline's per-glyph path, and correct for the
       * same reason a run can be coalesced at all: the glyphs are contiguous, so
       * one segment spans them. Struck-ness joins the coalescing key below, so a
       * run is never part struck.
       */
      const strikeRun = (x: number, width: number, color: string, size: number): void => {
        // Sit the line on the visual middle of lowercase rather than the text
        // centre: `baseline - size * 0.5` would cut the ascenders of a run like
        // "TALL", and a descender-relative offset drifts with font size.
        const y = baseline - size * 0.28;
        r.beginPath();
        r.moveTo(x, y);
        r.lineTo(x + width, y);
        // Scale with the run so a 32px heading is not struck by a hairline.
        r.stroke(color, Math.max(1, size / 14));
      };

      const flushRun = (): void => {
        if (runStart < 0) return;
        if (runStruck) strikeRun(runStart, runWidth, runColor, runSize);
        if (runText.length === 1) {
          r.fillText(runText, runStart, baseline, runFont, runColor);
        } else {
          const shaped = measureText(runText, runFont);
          if (Math.abs(shaped - runWidth) <= COALESCE_TOLERANCE_PX) {
            r.fillText(runText, runStart, baseline, runFont, runColor);
          } else {
            // Kerning/ligatures would shift glyphs: draw them where layout said.
            let x = runStart;
            for (const ch of runText) {
              r.fillText(ch, x, baseline, runFont, runColor);
              x += measureText(ch, runFont);
            }
          }
        }
        runStart = -1;
        runText = '';
        runWidth = 0;
      };

      for (const node of nodes) {
        if (node.char.trim().length === 0) {
          // Whitespace is not painted, but it DOES advance the pen, so a run
          // cannot span it — the next glyph's x is not `runStart + runWidth`.
          flushRun();
          continue;
        }
        if (node.object) {
          // A reserved inline box. Painting the U+FFFC sentinel as text would draw
          // a tofu box in the gap, so hand the box to the object's own painter.
          // Breaks the run for the same reason whitespace does — the pen has
          // advanced past reserved space.
          //
          // An object without a painter draws nothing, which is a blank gap. That
          // is not hypothetical: inline math shipped that way, correctly measured,
          // positioned, and accessible, and invisible.
          flushRun();
          node.object.paint?.(r, {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
          });
          continue;
        }
        const size = node.height;
        const font = this.nodeFont(node.style, size);
        const isLink = !!node.style?.href;
        const color = node.style?.color ?? (isLink ? this.linkColor : this.color);

        // Links keep their per-glyph path: each needs its own underline segment,
        // so there is nothing to coalesce.
        if (isLink) {
          flushRun();
          r.fillText(node.char, node.x, baseline, font, color);
          const uy = baseline + 2;
          r.beginPath();
          r.moveTo(node.x, uy);
          r.lineTo(node.x + node.width, uy);
          r.stroke(color, 1);
          // `~~[gone](url)~~` lexes to a `del` wrapping a `link`, so a struck
          // link is reachable and must get its line here too — this branch
          // never reaches `flushRun`'s strike.
          if (node.style?.lineThrough) {
            strikeRun(node.x, node.width, color, size);
          }
          continue;
        }

        // Extend the run only if style matches AND this glyph starts exactly
        // where the previous one ended. A positional gap means layout moved it
        // (justification, a tab, a bidi reorder), and concatenating would close
        // the gap.
        const struck = !!node.style?.lineThrough;
        const contiguous =
          runStart >= 0 &&
          font === runFont &&
          color === runColor &&
          // Struck-ness is part of the key, or one line would be stroked across
          // a run that is only partly struck.
          struck === runStruck &&
          Math.abs(node.x - (runStart + runWidth)) <= COALESCE_TOLERANCE_PX;

        if (!contiguous) {
          flushRun();
          runStart = node.x;
          runFont = font;
          runColor = color;
          runStruck = struck;
          runSize = size;
        }
        runText += node.char;
        runWidth = node.x + node.width - runStart;
      }
      flushRun();
    }
  }
}
