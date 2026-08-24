/**
 * Span tree -> self-contained SVG.
 *
 * This is the layer KaTeX does not have. KaTeX's `buildHTML` emits a span tree
 * whose vertical arrangement is expressed in CSS (`position: relative` plus
 * `top`, `display: table-cell` plus `vertical-align`) and whose glyphs are text
 * nodes resolved against a webfont by CSS class. Neither survives `SVGEntity`'s
 * pipeline (`data URI -> Image -> createImageBitmap -> drawImage`): an `Image`
 * loaded from a data URI resolves no external references and inherits no page
 * CSS.
 *
 * So this layer does three things the browser would otherwise have done:
 *
 * 1. **Resolves each glyph to an outline.** `SymbolNode` carries only text plus
 *    the metrics it was measured with; the *font* lives in CSS classes, often
 *    on an ancestor (see `./fonts.ts`). We resolve the inherited class chain
 *    and look the outline up in the generated glyph table.
 * 2. **Accumulates horizontal position.** The span tree contains no x
 *    coordinates at all — `Span.width` is written only by `functions/rule.ts`.
 *    The browser derives x from inline text layout, so we sum advance widths.
 * 3. **Converts CSS vertical positioning to explicit y.** `makeVList` encodes
 *    each row's baseline as `style.top = -pstrutSize - currPos - elem.depth`
 *    against a sibling `pstrut` of height `pstrutSize`, so the baseline offset
 *    is recoverable as `-(top + pstrutSize)` without re-deriving layout.
 *
 * Coordinate system: the internal unit is 1/1000 em (matching both the glyph
 * table's units/em and `svgGeometry`'s documented 1000:1 viewBox scale), x
 * increases rightward from the start of the formula, and y increases
 * **downward** from the baseline. Glyph outlines are y-up, so each is placed
 * inside a `scale(1,-1)` group rather than having its path data rewritten,
 * which would cost precision and defeat outline deduplication.
 */

import {
  Anchor,
  type HtmlDomNode,
  Img,
  LineNode,
  PathNode,
  Span,
  SvgNode,
  SymbolNode,
} from '../kernel/domTree';
import { getCharacterMetrics } from '../kernel/fontMetrics';
import { path as SVG_PATHS } from '../kernel/svgGeometry';

import { DocumentFragment } from '../kernel/tree';
import { resolveFont, sizingRatio } from './fonts';
import { getGlyph, UNITS_PER_EM } from './glyphTable';

/** Internal units per em. Matches the glyph table and `svgGeometry`. */
const UPEM = 1000;

/**
 * `$mu: calc(1em / 18)` (katex.scss:187) — TeX's math unit, 1/18 em.
 *
 * Exported so `scripts/vendor-katex.ts` can verify it against the upstream
 * stylesheet on every vendor run; see its emit-constants guard.
 */
export const MU = 1 / 18;

/**
 * `$nulldelimiterspace: calc(1.2em / $ptperem)` with `$ptperem: 10`
 * (katex.scss:187-188). A `nulldelimiter` span is empty, so this advance
 * exists only in CSS and has to be reintroduced here.
 *
 * Exported for the vendoring drift guard, as {@link MU}.
 */
export const NULL_DELIMITER_SPACE = 0.12;

/**
 * KaTeX renders at `font-size: 1.21em` (`katex.scss:24`), so one em in the span
 * tree is 1.21x the consumer's font size. We emit in em units and let the
 * caller scale, so this exists to document the relationship rather than to be
 * applied here.
 */
export const KATEX_FONT_SCALE = 1.21;

export interface EmitOptions {
  /**
   * Rendered em size in px, used only for the `width`/`height` attributes. The
   * `viewBox` is always in em-derived internal units, so changing this
   * rescales the raster without changing geometry.
   */
  emPx?: number;
  /** Fill colour for glyph outlines and rules. */
  color?: string;
  /** Padding around the ink, in em. Guards against clipped antialiasing. */
  padEm?: number;
}

/** A glyph placement, exposed for cross-validation against a browser. */
export interface GlyphPlacement {
  font: string;
  code: number;
  char: string;
  /** Pen x in em, from the formula's left edge. */
  x: number;
  /** Baseline y in em, positive **downward** from the formula baseline. */
  y: number;
  scale: number;
}

export interface EmitResult {
  /** The complete, self-contained SVG document. */
  svg: string;
  /** Total advance width, in em. */
  width: number;
  /** Height above the baseline, in em. */
  height: number;
  /** Depth below the baseline, in em. */
  depth: number;
  /** Glyphs requested but absent from the table, as `Font/U+XXXX`. */
  missing: string[];
  /**
   * Every placed glyph in em units. Exposed so the placement can be compared
   * against a real browser's layout of the same span tree, which is the only
   * way to know the vlist `top`-to-`y` conversion is right rather than merely
   * self-consistent.
   */
  placements: GlyphPlacement[];
}

/**
 * The effective ink colour a placement resolved to, when the span tree carries
 * one (`style.color` from `\color`/`\textcolor`/phantom). Undefined means the
 * caller's default fill applies.
 */
interface ColoredPlacement {
  color?: string;
}

/** One placed glyph outline. */
interface PlacedGlyph extends ColoredPlacement {
  font: string;
  code: number;
  char: string;
  /** Pen x, internal units. */
  x: number;
  /** Baseline y, internal units, positive downward. */
  y: number;
  /** Uniform scale applied to the outline (sizing classes). */
  scale: number;
}

/** One filled axis-aligned rectangle: rules, fraction lines, borders. */
interface PlacedRect extends ColoredPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * True when the width comes from a CSS border spanning its container, so it
   * is not known until the container's extent is. Resolved by `stretchRules`.
   */
  fullWidth?: boolean;
}

/** One stroked line from a `\cancel` overlay SVG (a `LineNode`). */
interface PlacedLine extends ColoredPlacement {
  /** x endpoints. When `fullWidth`, fractions of the container width (0..1),
   *  resolved against the enclosing vlist row's extent. */
  x1: number;
  x2: number;
  /** y endpoints, internal units, concrete at emit time. */
  y1: number;
  y2: number;
  /** Stroke width, internal units. */
  stroke: number;
  fullWidth?: boolean;
}

/** One placed stretchy path from `svgGeometry`, already in 1000:1 units. */
interface PlacedPath extends ColoredPlacement {
  d: string;
  x: number;
  y: number;
  /** Stretchy SVGs use `preserveAspectRatio: none`, so x and y differ. */
  sx: number;
  sy: number;
  /** Drawn extent, internal units (`y` is the top edge). Used by `emitSVG`'s
   *  ink-bounds union, since a path's outline is opaque to the emit layer. */
  w: number;
  h: number;
  /**
   * Visible rectangle when an ancestor clips this path, in internal units.
   * `\sqrt` relies on `.hide-tail { overflow: hidden }` to trim a 400em
   * radical, so without this the vinculum overdraws the entire formula.
   */
  clip?: { x: number; y: number; w: number; h: number };
}

interface EmitState {
  /** Current pen position, internal units. */
  x: number;
  glyphs: PlacedGlyph[];
  rects: PlacedRect[];
  paths: PlacedPath[];
  lines: PlacedLine[];
  missing: Set<string>;
  /**
   * Missing glyphs already warned about, so a formula repeating one unmapped
   * character warns once instead of once per occurrence.
   */
  warnedMetricsMisses: Set<string>;
}

/** How a vlist positions its rows relative to the widest one. */
export type RowAlign = 'left' | 'center' | 'right';

/**
 * Class → `text-align`, encoding the katex.scss rules that position a vlist's
 * rows against the widest one. Exported so the vendoring drift guard can
 * re-derive the mapping from upstream on every vendor run; see
 * `scripts/vendor-katex.ts`.
 *
 * Sources (katex.scss, KaTeX `5a5bf206`):
 *
 * - `.mfrac > span > span { text-align: center }` (line 262)
 * - `.op-limits > .vlist-t { text-align: center }` (lines 405-408)
 * - `.katex-accent > .vlist-t { text-align: center }` (lines 411-414)
 * - `.col-align-c|l|r > .vlist-t` (lines 442-451)
 * - `.x-arrow, .mover, .munder { text-align: center }` (lines 563-566)
 *
 * `sqrt: 'center'` is a deliberate deviation from upstream, which has no
 * `text-align` rule under `.sqrt`; see the guard's deviation table for why.
 */
export const ROW_ALIGN_CLASSES: Readonly<Record<string, RowAlign>> = {
  'col-align-c': 'center',
  'col-align-l': 'left',
  'col-align-r': 'right',
  mfrac: 'center',
  sqrt: 'center',
  'katex-accent': 'center',
  'op-limits': 'center',
  'x-arrow': 'center',
  mover: 'center',
  munder: 'center',
};

/**
 * Resolves the `text-align` that applies to a vlist's rows.
 *
 * These are CSS rules on ancestors, not properties of the tree, so a vlist
 * cannot be positioned correctly from its own contents alone — a narrow
 * numerator must be centred over the fraction rule, and a subscript under the
 * middle of its operator. The chain is outermost-first, so the nearest
 * enclosing rule wins by scanning from the end. Anything unmatched is the CSS
 * initial value, `left`.
 */
function rowAlign(chain: readonly string[]): RowAlign {
  for (let i = chain.length - 1; i >= 0; i--) {
    const align = ROW_ALIGN_CLASSES[chain[i]];
    if (align !== undefined) {
      return align;
    }
  }
  return 'left';
}

/** Parses a CSS length that KaTeX wrote via `makeEm`, returning em. */
function parseEm(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses a KaTeX length, distinguishing a CSS percentage (only `\cancel`'s
 * overlay SVG writes `width: 100%` and `x2/y2: 100%`) from an em value.
 * Percentages are returned as a fraction in `[0, 1]`.
 */
function parseLength(value: string | undefined): { value: number; pct: boolean } {
  if (!value) {
    return { value: 0, pct: false };
  }
  const s = value.trim();
  if (s.endsWith('%')) {
    const n = Number.parseFloat(s);
    return { value: Number.isFinite(n) ? n / 100 : 0, pct: true };
  }
  const n = Number.parseFloat(s);
  return { value: Number.isFinite(n) ? n : 0, pct: false };
}

/**
 * Walks a node, appending ink to `state` and advancing `state.x`.
 *
 * `classChain` is the concatenated class list from the root down to this node,
 * outermost first. Font resolution needs the whole chain because a `SymbolNode`
 * frequently carries no font class of its own — `\left(` produces one with an
 * empty class list under a `delimsizing size1` ancestor, and resolving locally
 * would silently pick Main-Regular and draw a short paren where a tall one
 * belongs.
 *
 * `y` is the baseline of the current node, positive downward from the formula
 * baseline. `scale` is the accumulated sizing ratio. `color` is the effective
 * ink colour inherited from enclosing spans' `style.color` (`\color`,
 * `\textcolor`, phantom); a node's own `style.color` overrides it.
 */
function walk(
  node: HtmlDomNode | SvgNode | PathNode | LineNode | Img,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
  color: string | undefined,
): void {
  if (node instanceof SymbolNode) {
    emitSymbol(node, state, classChain, y, scale, color);
    return;
  }

  if (node instanceof SvgNode) {
    emitSvgNode(node, state, y, scale, color);
    return;
  }

  // A bare PathNode or LineNode outside an SvgNode has no geometry context to
  // be placed against, and KaTeX never produces one.
  if (node instanceof PathNode || node instanceof LineNode) {
    return;
  }

  // `Img` comes only from \includegraphics, which needs an external resource
  // and so cannot appear in a self-contained SVG at all.
  if (node instanceof Img) {
    return;
  }

  if (node instanceof Span || node instanceof Anchor || node instanceof DocumentFragment) {
    emitContainer(node, state, classChain, y, scale, color);
  }
}

/** Resolves a symbol to outlines and advances the pen. */
function emitSymbol(
  node: SymbolNode,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
  inheritedColor: string | undefined,
): void {
  // A zero-width space is layout scaffolding (`vlist-s`), never ink.
  if (node.text === '\u200b' || node.text === '') {
    return;
  }

  // The kernel writes `color: transparent` onto every node of a phantom
  // (`Options.getColor`, domTree.ts:75-78). Phantom ink must occupy the same
  // advance and box as its visible twin but contribute no outlines.
  const color = node.style.color ?? inheritedColor;
  const phantom = color === 'transparent';

  const { font } = resolveFont([...classChain, ...node.classes]);

  let penX = state.x + parseEm(node.style.marginLeft) * UPEM * scale;

  // `tryCombineChars` (buildCommon.ts:296) merges adjacent same-style symbols
  // into one node, concatenating `text` while leaving `width` as the *first*
  // character's — it maxes height/depth and takes the last `italic`, but never
  // sums width. So `node.width` is not this node's advance and each character
  // must be measured on its own.
  for (const ch of node.text) {
    const code = ch.codePointAt(0)!;
    const glyph = getGlyph(font, code);

    if (glyph) {
      if (!phantom) {
        state.glyphs.push({ font, code, char: ch, x: penX, y, scale, color });
      }
      penX += (glyph.advance / UNITS_PER_EM) * UPEM * scale;
    } else {
      // Phantom content never needs an outline, so a missing glyph there is
      // not a reportable absence. Advance so surrounding layout stays put even
      // when an outline is absent from the whitelist. The vendored metrics
      // table covers every character KaTeX can lay out, which is a superset of
      // the shipped outlines.
      if (!phantom) {
        state.missing.add(`${font}/U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      const m = getCharacterMetrics(ch, font, 'math');
      const width = m?.width ?? node.width;
      if (Number.isFinite(width)) {
        penX += width * UPEM * scale;
      } else {
        // Both the metrics table and the node's own width missed. Advancing by
        // the non-finite value would poison penX and, through it, the viewBox.
        // Degrade to a zero advance and say so once per unique miss — quiet
        // NaN output is how a bad glyph becomes an invisible layout bug.
        const key = `${font}/U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
        if (!phantom && !state.warnedMetricsMisses.has(key)) {
          state.warnedMetricsMisses.add(key);
          console.warn(
            `[tex] no metrics for missing glyph ${key}; advancing 0 ` +
              '(outline table and font metrics both missed)',
          );
        }
      }
    }
  }

  // KaTeX applies italic correction as `marginRight` on the symbol's span
  // (`domTree.ts` SymbolNode.toNode), so it is advance, not geometry.
  penX += node.italic * UPEM * scale;
  penX += parseEm(node.style.marginRight) * UPEM * scale;
  state.x = penX;
}

/** Emits a stretchy SVG: the `<svg><path/></svg>` subtree from `stretchy`. */
function emitSvgNode(
  node: SvgNode,
  state: EmitState,
  y: number,
  scale: number,
  color: string | undefined,
  clipEm?: number,
): void {
  const widthLen = parseLength(node.attributes.width);
  const heightEm = parseEm(node.attributes.height);

  // A percentage width is `\cancel`'s overlay SVG: `width: 100%` and
  // `x2/y2: 100%` resolve against the enclosing row in the browser, and the
  // overlay occupies no advance width. `LineNode` is produced only by
  // `stretchyEnclose` for this shape, so treat it as a stroked diagonal line
  // whose x endpoints defer to the vlist extent (like `fullWidth` rules).
  if (widthLen.pct) {
    if (color === 'transparent') {
      return;
    }
    const boxH = heightEm * UPEM * scale;
    const top = y - boxH;
    for (const child of node.children) {
      if (child instanceof LineNode) {
        const stroke = parseEm(child.attributes['stroke-width']);
        const x1 = parseLength(child.attributes.x1);
        const y1 = parseLength(child.attributes.y1);
        const x2 = parseLength(child.attributes.x2);
        const y2 = parseLength(child.attributes.y2);
        state.lines.push({
          x1: x1.value,
          y1: top + y1.value * boxH,
          x2: x2.value,
          y2: top + y2.value * boxH,
          stroke: stroke * UPEM * scale,
          fullWidth: true,
          color,
        });
      }
    }
    return;
  }

  // `stretchy.svgSpan` sets width/height in em plus a viewBox in 1000:1 units,
  // and relies on `preserveAspectRatio` to stretch or slice horizontally.
  //
  // `clipEm` is the visible width when an ancestor clips this SVG. `\sqrt`
  // emits a **400em** wide radical with `preserveAspectRatio="xMinYMin slice"`
  // and relies on `.hide-tail { width: 100%; overflow: hidden }`
  // (katex.scss:513) to cut it down, so taking the SVG's own width as advance
  // reports a 400em formula. The clip is the real extent.
  const rawWidthEm = widthLen.value;
  const widthEm = clipEm != null ? Math.min(rawWidthEm, clipEm) : rawWidthEm;

  const viewBox = node.attributes.viewBox?.split(/\s+/).map(Number);
  const hasBox = viewBox?.length === 4 && viewBox.every(Number.isFinite);
  const vbW = hasBox ? viewBox![2] : widthEm * UPEM;
  const vbH = hasBox ? viewBox![3] : heightEm * UPEM;

  // A sliced SVG is *not* scaled to the clip: it renders at the scale its own
  // declared width implies and the excess is cut off. Scaling by the clipped
  // width instead would squash a 400em radical into 0.85em.
  const sliced = node.attributes.preserveAspectRatio?.includes('slice') ?? false;
  const scaleWidthEm = sliced ? rawWidthEm : widthEm;

  const sx = vbW > 0 ? (scaleWidthEm * UPEM * scale) / vbW : scale;
  const sy = vbH > 0 ? (heightEm * UPEM * scale) / vbH : scale;

  for (const child of node.children) {
    if (child instanceof PathNode) {
      const d = child.alternate ?? SVG_PATHS[child.pathName];
      if (d) {
        // The path's own coordinate space is y-down with its origin at the top
        // of the box, and the box's bottom sits on this node's baseline.
        if (color !== 'transparent') {
          state.paths.push({
            d,
            x: state.x,
            y: y - heightEm * UPEM * scale,
            sx,
            sy,
            w: widthEm * UPEM * scale,
            h: heightEm * UPEM * scale,
            color,
            // Clip only when the declared width exceeds what is visible, so an
            // unclipped stretchy arrow costs no clipPath.
            clip:
              sliced && rawWidthEm > widthEm
                ? {
                    x: state.x,
                    y: y - heightEm * UPEM * scale,
                    w: widthEm * UPEM * scale,
                    h: heightEm * UPEM * scale,
                  }
                : undefined,
          });
        }
      }
    }
  }

  state.x += widthEm * UPEM * scale;
}

/** Emits a Span, Anchor or DocumentFragment and its children. */
function emitContainer(
  node: Span<HtmlDomNode> | Anchor | DocumentFragment<HtmlDomNode>,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
  inheritedColor: string | undefined,
): void {
  const classes = 'classes' in node ? node.classes : [];
  const style = 'style' in node ? node.style : {};

  // A strut carries height for CSS line-box purposes and holds no ink.
  // `pstrut` gives a vlist row a known baseline; `vlist-s` holds only a
  // zero-width space for a Safari bug (buildCommon.ts:622). Walking any of
  // them would place scaffolding as if it were content.
  if (
    classes.includes('katex-strut') ||
    classes.includes('pstrut') ||
    classes.includes('vlist-s')
  ) {
    return;
  }

  // `style.color` overrides whatever was inherited, and every descendant
  // inherits the result. `transparent` is how the kernel marks phantom ink
  // (Options.getColor), which must keep its advance but place no ink.
  const color = style.color ?? inheritedColor;
  const phantom = color === 'transparent';

  const chain = [...classChain, ...classes];
  const localScale = scale * sizingRatio(classes);

  state.x += parseEm(style.marginLeft) * UPEM * localScale;

  // `.nulldelimiter { width: $nulldelimiterspace }` (katex.scss:384), where
  // `$nulldelimiterspace: calc(1.2em / 10)` (katex.scss:187-188). The span is
  // empty, so its advance exists only in CSS and would otherwise be lost.
  if (classes.includes('nulldelimiter')) {
    state.x += NULL_DELIMITER_SPACE * UPEM * localScale;
    return;
  }

  // `.arraycolsep { display: inline-block }` (katex.scss:438) with its width
  // written into `style.width` by `array.ts`.
  if (classes.includes('arraycolsep')) {
    state.x += parseEm(style.width) * UPEM * localScale;
    return;
  }

  // `> .katex-root { margin-left: 5mu; margin-right: -10mu }`
  // (katex.scss:343-350) with `$mu: calc(1em / 18)` (katex.scss:187). These
  // come from \r@@t's \mkern and are pure CSS, absent from the tree.
  // The negative right margin is what pulls the index back over the radical,
  // so omitting it leaves `\sqrt[3]{x}` a measured 0.5555em too wide.
  const rootIndex = classes.includes('katex-root');
  if (rootIndex) {
    state.x += 5 * MU * UPEM * localScale;
  }

  // `inner.style.paddingLeft = makeEm(advanceWidth)` (functions/sqrt.ts:73)
  // carries the radical's advance, so the radicand starts clear of it.
  state.x += parseEm(style.paddingLeft) * UPEM * localScale;

  if (classes.includes('vlist-t')) {
    emitVList(node as Span<HtmlDomNode>, state, chain, y, localScale, rowAlign(chain), color);
    state.x += parseEm(style.marginRight) * UPEM * localScale;
    return;
  }

  // A line span draws its rule as a CSS border spanning the full width of its
  // container, so its width is not knowable here: `frac-line`, `underline-line`
  // and `overline-line` (functions/underline.ts:15, overline.ts:19),
  // `katex-hline`/`katex-hdashline` (environments/array.ts:521-526) all write
  // `borderBottomWidth` via `makeLineSpan`; `katex-sout` (functions/enclose.ts:33)
  // strikes through with its own height instead. Like a border, the rule spans
  // the row and occupies no advance.
  if (style.borderBottomWidth || classes.includes('katex-sout')) {
    if (!phantom) {
      const thickness = parseEm(style.borderBottomWidth) || node.height;
      state.rects.push({
        x: state.x,
        y: y - node.height * UPEM * localScale,
        w: 0,
        h: Math.max(thickness * UPEM * localScale, 0),
        fullWidth: true,
        color,
      });
    }
    return;
  }

  // `functions/rule.ts:44` is the one place a Span carries an explicit width,
  // and there it means a filled rectangle.
  if (node instanceof Span && node.width != null) {
    const w = node.width * UPEM * localScale;
    const h = (node.height + node.depth) * UPEM * localScale;
    if (w > 0 && h > 0) {
      if (!phantom) {
        state.rects.push({
          x: state.x + parseEm(style.marginLeft) * UPEM * localScale,
          y: y - node.height * UPEM * localScale,
          w,
          h,
          color,
        });
      }
      state.x += w;
      return;
    }
  }

  // `\rlap`/`\llap`/`\clap` children occupy no advance width, and an accent
  // that is not `accent-full` is explicitly zero-width:
  // `.accent-body:not(.accent-full) { width: 0 }` (katex.scss:422-424), so it
  // does not widen the symbol it sits over.
  //
  // CSS positions the three lap classes differently (katex.scss:293-320):
  // `.rlap > .katex-inner { left: 0 }` starts the ink at the anchor,
  // `.llap > .katex-inner { right: 0 }` ends it at the anchor, and `.clap >
  // .katex-inner > span { margin-left: -50% }` centres it. The span tree
  // records no x position, so the lap content must be measured first (the
  // measure-probe pattern from `emitVList`) and the pen shifted accordingly.
  const lapKind = classes.includes('llap')
    ? 'llap'
    : classes.includes('clap')
      ? 'clap'
      : classes.includes('rlap')
        ? 'rlap'
        : undefined;
  const lapping =
    lapKind !== undefined || (classes.includes('accent-body') && !classes.includes('accent-full'));
  const startX = state.x;

  // `style.top` outside a vlist shifts the baseline; `delimcenter` uses it.
  const childY = y + parseEm(style.top) * UPEM * localScale;

  // `.accent-body { position: relative }` (katex.scss:416) exists so `left`
  // can shift the accent horizontally without affecting layout.
  state.x += parseEm(style.left) * UPEM * localScale;

  // `.hide-tail { width: 100%; overflow: hidden }` (katex.scss:513) clips an
  // oversized child SVG. `minWidth` is the floor KaTeX sets on it.
  const clipEm = classes.includes('hide-tail')
    ? parseEm(style.minWidth) || parseEm(style.width) || undefined
    : undefined;

  if (lapKind === 'llap' || lapKind === 'clap') {
    // Measure the lap content without emitting it, so the shift is by the
    // content's own advance rather than a guess. `\llap` ink must end at the
    // anchor and `\clap` ink must straddle it, unlike `\rlap` which starts
    // there.
    const probe: EmitState = {
      x: state.x,
      glyphs: [],
      rects: [],
      paths: [],
      lines: [],
      missing: new Set(),
      warnedMetricsMisses: new Set(),
    };
    for (const child of node.children ?? []) {
      if (clipEm != null && child instanceof SvgNode) {
        emitSvgNode(child, probe, childY, localScale, color, clipEm);
      } else {
        walk(child, probe, chain, childY, localScale, color);
      }
    }
    const lapWidth = probe.x - state.x;
    state.x -= lapKind === 'llap' ? lapWidth : lapWidth / 2;
    // A measuring pass must not lose a genuinely missing glyph.
    for (const m of probe.missing) {
      state.missing.add(m);
    }
  }

  for (const child of node.children ?? []) {
    if (clipEm != null && child instanceof SvgNode) {
      emitSvgNode(child, state, childY, localScale, color, clipEm);
    } else {
      walk(child, state, chain, childY, localScale, color);
    }
  }

  if (lapping) {
    state.x = startX;
  }

  if (rootIndex) {
    state.x += -10 * MU * UPEM * localScale;
  }

  state.x += parseEm(style.marginRight) * UPEM * localScale;
}

/**
 * Emits a vlist, converting each row's CSS `top` into an explicit baseline.
 *
 * `makeVList` writes `childWrap.style.top = -pstrutSize - currPos -
 * elem.depth` and gives the sibling `pstrut` `height = pstrutSize`, so a row's
 * baseline offset above the vlist baseline is exactly `-(top + pstrutSize)`.
 * Reading `pstrutSize` back out of the tree instead of recomputing it keeps
 * this a translation of the layout rather than a second implementation of it.
 *
 * Only the first `vlist-r` holds content. The second exists to give the CSS
 * table its depth (buildCommon.ts:612-627) and contains an empty span.
 */
function emitVList(
  vtable: Span<HtmlDomNode>,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
  align: RowAlign = 'left',
  color: string | undefined,
): void {
  const startX = state.x;
  let maxX = state.x;

  // Rules inside this vlist span *its* width, not the whole formula's, so
  // remember where its rects begin and resolve them against its own extent.
  const rectStart = state.rects.length;
  // Same for `\cancel` overlay lines, whose x endpoints are fractions of this
  // vlist's row width.
  const lineStart = state.lines.length;

  const firstRow = (vtable.children ?? []).find(
    (c): c is Span<HtmlDomNode> => c instanceof Span && c.hasClass('vlist-r'),
  );
  const vlist = (firstRow?.children ?? []).find(
    (c): c is Span<HtmlDomNode> => c instanceof Span && c.hasClass('vlist'),
  );
  if (!vlist) {
    return;
  }

  const rows = (vlist.children ?? []).filter((c): c is Span<HtmlDomNode> => c instanceof Span);

  // `text-align` on a vlist centres or right-aligns each row against the
  // widest one, so a row's x depends on rows emitted after it. Measure every
  // row first, then place. `\frac` (katex.scss:262), accents (:411),
  // `\sqrt` (:406) and `col-align-c` (:442) all rely on this; without it a
  // narrow numerator sits flush left instead of over the centre of the rule.
  const rowWidths: number[] = [];
  if (align !== 'left') {
    for (const row of rows) {
      const probe: EmitState = {
        x: 0,
        glyphs: [],
        rects: [],
        paths: [],
        lines: [],
        missing: new Set(),
        warnedMetricsMisses: new Set(),
      };
      const rowChain = [...classChain, ...row.classes];
      for (const child of row.children ?? []) {
        walk(child, probe, rowChain, 0, scale, color);
      }
      rowWidths.push(probe.x);
      // A measuring pass must not lose a genuinely missing glyph.
      for (const m of probe.missing) {
        state.missing.add(m);
      }
    }
  }
  const widest = rowWidths.length ? Math.max(...rowWidths) : 0;

  for (const [i, row] of rows.entries()) {
    const pstrut = (row.children ?? []).find(
      (c): c is Span<HtmlDomNode> => c instanceof Span && c.hasClass('pstrut'),
    );
    const pstrutSize = pstrut ? parseEm(pstrut.style.height) : 0;

    // Baseline offset above the vlist baseline, in em.
    const above = -(parseEm(row.style.top) + pstrutSize);
    const rowY = y - above * UPEM * scale;

    let indent = 0;
    if (align === 'center') {
      indent = (widest - rowWidths[i]) / 2;
    } else if (align === 'right') {
      indent = widest - rowWidths[i];
    }

    state.x = startX + indent + parseEm(row.style.marginLeft) * UPEM * scale;

    const rowChain = [...classChain, ...row.classes];
    for (const child of row.children ?? []) {
      walk(child, state, rowChain, rowY, scale, color);
    }

    maxX = Math.max(maxX, state.x + parseEm(row.style.marginRight) * UPEM * scale);
  }

  // Resolve this vlist's own full-width rules before returning, so a nested
  // fraction's line spans the inner fraction and not the outer one.
  const width = maxX - startX;
  for (let i = rectStart; i < state.rects.length; i++) {
    const r = state.rects[i];
    if (r.fullWidth) {
      r.x = startX;
      r.w = width;
      r.fullWidth = false;
    }
  }
  // `\cancel` overlay lines span the same row extent.
  for (let i = lineStart; i < state.lines.length; i++) {
    const l = state.lines[i];
    if (l.fullWidth) {
      l.x1 = startX + l.x1 * width;
      l.x2 = startX + l.x2 * width;
      l.fullWidth = false;
    }
  }

  state.x = maxX;
}

/** Formats a number for SVG output, trimming pointless precision. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return '0';
  }
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Escapes a colour string before it is interpolated into an SVG attribute.
 *
 * Colours arrive from the caller's theme (`EmitOptions.color`) and from TeX
 * input (`\color{...}`/`\textcolor{...}` writes the argument verbatim into
 * `style.color`), so neither is guaranteed benign: a `"` terminates the
 * attribute early and opens the SVG to attribute injection, which is why the
 * value is escaped rather than validated — a grammar would reject legitimate
 * colours like `var(--fg)` and `rgba(1,2,3,.5)`, while escaping is a no-op on
 * every valid colour.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Emits a self-contained SVG for a laid-out span tree.
 *
 * Every glyph becomes a `<path>` outline, so the output references no font, no
 * stylesheet and no external URL and renders identically through
 * `createImageBitmap` as it would inline.
 */
export function emitSVG(tree: Span<HtmlDomNode>, options: EmitOptions = {}): EmitResult {
  const { emPx = 16, color = '#000', padEm = 0.05 } = options;

  const state: EmitState = {
    x: 0,
    glyphs: [],
    rects: [],
    paths: [],
    lines: [],
    missing: new Set(),
    warnedMetricsMisses: new Set(),
  };
  walk(tree, state, [], 0, 1, undefined);

  // Any rule still unresolved was not inside a vlist, so it spans the formula.
  for (const r of state.rects) {
    if (r.fullWidth) {
      r.x = 0;
      r.w = state.x;
      r.fullWidth = false;
    }
  }
  // Same fallback for `\cancel` overlay lines not enclosed in a vlist.
  for (const l of state.lines) {
    if (l.fullWidth) {
      l.x1 = l.x1 * state.x;
      l.x2 = l.x2 * state.x;
      l.fullWidth = false;
    }
  }

  const widthEm = state.x / UPEM;
  const heightEm = tree.height;
  const depthEm = tree.depth;

  const pad = padEm * UPEM;

  // The viewBox starts from the layout box (`tree.height`/`tree.depth` advance
  // extents) plus pad, and is then expanded to the union of everything
  // actually placed. The layout box alone clips real ink in two cases:
  // `\smash` (and therefore `\hphantom`) zeroes height/depth while its children
  // keep their full size, and `\llap` ink extends left of the origin. Both
  // would otherwise be cut off at the box edge.
  let minX = -pad;
  let minY = -heightEm * UPEM - pad;
  let maxX = state.x + pad;
  let maxY = depthEm * UPEM + pad;

  for (const g of state.glyphs) {
    // Vertical extent from the kernel metrics the layout itself used
    // (`getCharacterMetrics` returns em, height above / depth below baseline).
    // Horizontal extent is the advance, a safe superset of the outline.
    const m = getCharacterMetrics(g.char, g.font, 'math');
    if (m) {
      minY = Math.min(minY, g.y - m.height * UPEM * g.scale);
      maxY = Math.max(maxY, g.y + m.depth * UPEM * g.scale);
    }
    const glyph = getGlyph(g.font, g.code);
    const advance = glyph ? (glyph.advance / UNITS_PER_EM) * UPEM * g.scale : 0;
    minX = Math.min(minX, g.x);
    maxX = Math.max(maxX, g.x + advance);
  }
  for (const r of state.rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  for (const l of state.lines) {
    const half = l.stroke / 2;
    minX = Math.min(minX, l.x1 - half, l.x2 - half);
    maxX = Math.max(maxX, l.x1 + half, l.x2 + half);
    minY = Math.min(minY, l.y1 - half, l.y2 - half);
    maxY = Math.max(maxY, l.y1 + half, l.y2 + half);
  }
  for (const p of state.paths) {
    // A clipped path's visible extent is the clip, not its declared size: the
    // `\sqrt` radical declares 400em and relies on `hide-tail` to trim it.
    const bx = p.clip ? p.clip.x : p.x;
    const by = p.clip ? p.clip.y : p.y;
    const bw = p.clip ? p.clip.w : p.w;
    const bh = p.clip ? p.clip.h : p.h;
    minX = Math.min(minX, bx);
    minY = Math.min(minY, by);
    maxX = Math.max(maxX, bx + bw);
    maxY = Math.max(maxY, by + bh);
  }

  const boxW = maxX - minX;
  const boxH = maxY - minY;

  // Deduplicate outlines: a repeated glyph is defined once and referenced,
  // which is a large win on any formula that repeats a symbol.
  const useCount = new Map<string, number>();
  for (const g of state.glyphs) {
    useCount.set(`${g.font}\u0000${g.code}`, (useCount.get(`${g.font}\u0000${g.code}`) ?? 0) + 1);
  }

  const defs: string[] = [];
  const defId = new Map<string, string>();
  for (const [key, count] of useCount) {
    if (count < 2) {
      continue;
    }
    const sep = key.indexOf('\u0000');
    const glyph = getGlyph(key.slice(0, sep), Number(key.slice(sep + 1)));
    if (!glyph?.path) {
      continue;
    }
    const id = `g${defs.length}`;
    defId.set(key, id);
    defs.push(`<path id="${id}" d="${glyph.path}"/>`);
  }

  const body: string[] = [];

  // Consecutive placements that resolved to the same explicit colour are
  // wrapped in one nested `<g fill="...">`, so `\color{red}x` needs no
  // per-element fill attribute and the root group keeps the caller's default.
  // The render callbacks may return '' for skipped ink, which still leaves the
  // surrounding group structure intact.
  const grouped = <T extends { color?: string }>(
    items: readonly T[],
    render: (item: T) => string,
  ): string => {
    let out = '';
    let open: string | undefined;
    for (const item of items) {
      if (item.color !== open) {
        if (open !== undefined) {
          out += '</g>';
        }
        if (item.color !== undefined) {
          out += `<g fill="${escapeAttr(item.color)}">`;
        }
        open = item.color;
      }
      out += render(item);
    }
    if (open !== undefined) {
      out += '</g>';
    }
    return out;
  };

  body.push(
    grouped(state.glyphs, (g) => {
      const glyph = getGlyph(g.font, g.code);
      if (!glyph?.path) {
        return '';
      }
      // Outlines are y-up and the document is y-down. Flip per placement
      // rather than rewriting path data, which would lose precision and
      // prevent reuse.
      const transform = `translate(${fmt(g.x)} ${fmt(g.y)}) scale(${fmt(g.scale)} ${fmt(-g.scale)})`;
      const id = defId.get(`${g.font}\u0000${g.code}`);
      // SVG2's plain `href` (no `xlink:href` fallback) is a deliberate choice:
      // every engine that renders this output — Chromium 50+, Firefox 51+,
      // Safari 12.1+, and the resvg/rsvg converters used in tooling — supports
      // it, while adding xlink would need an xmlns:xlink declaration on every
      // formula and bytes on every placement. Revisit only if a consumer that
      // predates SVG2 <use> ever becomes real.
      return id
        ? `<use href="#${id}" transform="${transform}"/>`
        : `<path transform="${transform}" d="${glyph.path}"/>`;
    }),
  );

  body.push(
    grouped(state.rects, (r) => {
      if (r.w <= 0 || r.h <= 0) {
        return '';
      }
      return `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"/>`;
    }),
  );

  for (const l of state.lines) {
    body.push(
      `<line x1="${fmt(l.x1)}" y1="${fmt(l.y1)}" x2="${fmt(l.x2)}" y2="${fmt(l.y2)}" ` +
        `stroke="${escapeAttr(l.color ?? color)}" stroke-width="${fmt(l.stroke)}"/>`,
    );
  }

  body.push(
    grouped(state.paths, (p) => {
      const transform = `translate(${fmt(p.x)} ${fmt(p.y)}) scale(${fmt(p.sx)} ${fmt(p.sy)})`;
      let clipAttr = '';
      if (p.clip) {
        // A same-document fragment reference, which resolves inside a data URI.
        // Only an *external* url() would fail there.
        const id = `c${defs.length}`;
        defs.push(
          `<clipPath id="${id}"><rect x="${fmt(p.clip.x)}" y="${fmt(p.clip.y)}" ` +
            `width="${fmt(p.clip.w)}" height="${fmt(p.clip.h)}"/></clipPath>`,
        );
        clipAttr = ` clip-path="url(#${id})"`;
      }
      return `<path${clipAttr} transform="${transform}" d="${p.d}"/>`;
    }),
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt((boxW / UPEM) * emPx)}" ` +
    `height="${fmt((boxH / UPEM) * emPx)}" ` +
    `viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(boxW)} ${fmt(boxH)}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    `<g fill="${escapeAttr(color)}">${body.join('')}</g></svg>`;

  return {
    svg,
    width: widthEm,
    height: heightEm,
    depth: depthEm,
    missing: [...state.missing].sort(),
    placements: state.glyphs.map((g) => ({
      font: g.font,
      code: g.code,
      char: String.fromCodePoint(g.code),
      x: g.x / UPEM,
      y: g.y / UPEM,
      scale: g.scale,
    })),
  };
}
