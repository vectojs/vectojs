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
 */
const MU = 1 / 18;

/**
 * `$nulldelimiterspace: calc(1.2em / $ptperem)` with `$ptperem: 10`
 * (katex.scss:187-188). A `nulldelimiter` span is empty, so this advance
 * exists only in CSS and has to be reintroduced here.
 */
const NULL_DELIMITER_SPACE = 0.12;

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

/** One placed glyph outline. */
interface PlacedGlyph {
  font: string;
  code: number;
  /** Pen x, internal units. */
  x: number;
  /** Baseline y, internal units, positive downward. */
  y: number;
  /** Uniform scale applied to the outline (sizing classes). */
  scale: number;
}

/** One filled axis-aligned rectangle: rules, fraction lines, borders. */
interface PlacedRect {
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

/** One placed stretchy path from `svgGeometry`, already in 1000:1 units. */
interface PlacedPath {
  d: string;
  x: number;
  y: number;
  /** Stretchy SVGs use `preserveAspectRatio: none`, so x and y differ. */
  sx: number;
  sy: number;
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
  missing: Set<string>;
}

/** How a vlist positions its rows relative to the widest one. */
type RowAlign = 'left' | 'center' | 'right';

/**
 * Resolves the `text-align` that applies to a vlist's rows.
 *
 * These are CSS rules on ancestors, not properties of the tree, so a vlist
 * cannot be positioned correctly from its own contents alone:
 *
 * - `.mfrac > span > span { text-align: center }` (katex.scss:262)
 * - `.sqrt > .vlist-t { text-align: center }` (katex.scss:406)
 * - `.katex-accent > .vlist-t { text-align: center }` (katex.scss:411)
 * - `.col-align-c|l|r > .vlist-t` (katex.scss:442-452)
 *
 * The chain is outermost-first, so the nearest enclosing rule wins by scanning
 * from the end.
 */
function rowAlign(chain: readonly string[]): RowAlign {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    if (c === 'col-align-c') {
      return 'center';
    }
    if (c === 'col-align-r') {
      return 'right';
    }
    if (c === 'col-align-l') {
      return 'left';
    }
    if (c === 'mfrac' || c === 'sqrt' || c === 'katex-accent') {
      return 'center';
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
 * baseline. `scale` is the accumulated sizing ratio.
 */
function walk(
  node: HtmlDomNode | SvgNode | PathNode | LineNode | Img,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
): void {
  if (node instanceof SymbolNode) {
    emitSymbol(node, state, classChain, y, scale);
    return;
  }

  if (node instanceof SvgNode) {
    emitSvgNode(node, state, y, scale);
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
    emitContainer(node, state, classChain, y, scale);
  }
}

/** Resolves a symbol to outlines and advances the pen. */
function emitSymbol(
  node: SymbolNode,
  state: EmitState,
  classChain: readonly string[],
  y: number,
  scale: number,
): void {
  // A zero-width space is layout scaffolding (`vlist-s`), never ink.
  if (node.text === '\u200b' || node.text === '') {
    return;
  }

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
      state.glyphs.push({ font, code, x: penX, y, scale });
      penX += (glyph.advance / UNITS_PER_EM) * UPEM * scale;
    } else {
      state.missing.add(`${font}/U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      // Advance so surrounding layout stays put even when an outline is absent
      // from the whitelist. The vendored metrics table covers every character
      // KaTeX can lay out, which is a superset of the shipped outlines.
      const m = getCharacterMetrics(ch, font, 'math');
      penX += (m?.width ?? node.width) * UPEM * scale;
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
  clipEm?: number,
): void {
  // `stretchy.svgSpan` sets width/height in em plus a viewBox in 1000:1 units,
  // and relies on `preserveAspectRatio` to stretch or slice horizontally.
  //
  // `clipEm` is the visible width when an ancestor clips this SVG. `\sqrt`
  // emits a **400em** wide radical with `preserveAspectRatio="xMinYMin slice"`
  // and relies on `.hide-tail { width: 100%; overflow: hidden }`
  // (katex.scss:513) to cut it down, so taking the SVG's own width as advance
  // reports a 400em formula. The clip is the real extent.
  const rawWidthEm = parseEm(node.attributes.width);
  const heightEm = parseEm(node.attributes.height);
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
        state.paths.push({
          d,
          x: state.x,
          y: y - heightEm * UPEM * scale,
          sx,
          sy,
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
    } else if (child instanceof LineNode) {
      const x1 = Number.parseFloat(child.attributes.x1 ?? '0');
      const y1 = Number.parseFloat(child.attributes.y1 ?? '0');
      const x2 = Number.parseFloat(child.attributes.x2 ?? '0');
      const y2 = Number.parseFloat(child.attributes.y2 ?? '0');
      const stroke = Number.parseFloat(child.attributes['stroke-width'] ?? '0');
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        state.rects.push({
          x: state.x + Math.min(x1, x2) * sx,
          y: y - heightEm * UPEM * scale + Math.min(y1, y2) * sy,
          w: Math.max(Math.abs(x2 - x1) * sx, stroke * sx),
          h: Math.max(Math.abs(y2 - y1) * sy, stroke * sy),
        });
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
    emitVList(node as Span<HtmlDomNode>, state, chain, y, localScale, rowAlign(chain));
    state.x += parseEm(style.marginRight) * UPEM * localScale;
    return;
  }

  // A `frac-line` draws its rule as a CSS bottom border spanning the full
  // width of its container, so its width is not knowable here.
  if (classes.includes('frac-line')) {
    const thickness = parseEm(style.borderBottomWidth) || node.height;
    state.rects.push({
      x: state.x,
      y: y - node.height * UPEM * localScale,
      w: 0,
      h: Math.max(thickness * UPEM * localScale, 0),
      fullWidth: true,
    });
    return;
  }

  // `functions/rule.ts:44` is the one place a Span carries an explicit width,
  // and there it means a filled rectangle.
  if (node instanceof Span && node.width != null) {
    const w = node.width * UPEM * localScale;
    const h = (node.height + node.depth) * UPEM * localScale;
    if (w > 0 && h > 0) {
      state.rects.push({
        x: state.x + parseEm(style.marginLeft) * UPEM * localScale,
        y: y - node.height * UPEM * localScale,
        w,
        h,
      });
      state.x += w;
      return;
    }
  }

  // `\rlap`/`\llap`/`\clap` children occupy no advance width, and an accent
  // that is not `accent-full` is explicitly zero-width:
  // `.accent-body:not(.accent-full) { width: 0 }` (katex.scss:422-424), so it
  // does not widen the symbol it sits over.
  const lapping =
    classes.includes('rlap') ||
    classes.includes('llap') ||
    classes.includes('clap') ||
    (classes.includes('accent-body') && !classes.includes('accent-full'));
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

  for (const child of node.children ?? []) {
    if (clipEm != null && child instanceof SvgNode) {
      emitSvgNode(child, state, childY, localScale, clipEm);
    } else {
      walk(child, state, chain, childY, localScale);
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
): void {
  const startX = state.x;
  let maxX = state.x;

  // Rules inside this vlist span *its* width, not the whole formula's, so
  // remember where its rects begin and resolve them against its own extent.
  const rectStart = state.rects.length;

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
        missing: new Set(),
      };
      const rowChain = [...classChain, ...row.classes];
      for (const child of row.children ?? []) {
        walk(child, probe, rowChain, 0, scale);
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
      walk(child, state, rowChain, rowY, scale);
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
    missing: new Set(),
  };
  walk(tree, state, [], 0, 1);

  // Any rule still unresolved was not inside a vlist, so it spans the formula.
  for (const r of state.rects) {
    if (r.fullWidth) {
      r.x = 0;
      r.w = state.x;
      r.fullWidth = false;
    }
  }

  const widthEm = state.x / UPEM;
  const heightEm = tree.height;
  const depthEm = tree.depth;

  const pad = padEm * UPEM;
  const minX = -pad;
  const minY = -heightEm * UPEM - pad;
  const boxW = state.x + pad * 2;
  const boxH = (heightEm + depthEm) * UPEM + pad * 2;

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

  for (const g of state.glyphs) {
    const glyph = getGlyph(g.font, g.code);
    if (!glyph?.path) {
      continue;
    }
    // Outlines are y-up and the document is y-down. Flip per placement rather
    // than rewriting path data, which would lose precision and prevent reuse.
    const transform = `translate(${fmt(g.x)} ${fmt(g.y)}) scale(${fmt(g.scale)} ${fmt(-g.scale)})`;
    const id = defId.get(`${g.font}\u0000${g.code}`);
    body.push(
      id
        ? `<use href="#${id}" transform="${transform}"/>`
        : `<path transform="${transform}" d="${glyph.path}"/>`,
    );
  }

  for (const r of state.rects) {
    if (r.w <= 0 || r.h <= 0) {
      continue;
    }
    body.push(`<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}"/>`);
  }

  for (const p of state.paths) {
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
    body.push(`<path${clipAttr} transform="${transform}" d="${p.d}"/>`);
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt((boxW / UPEM) * emPx)}" ` +
    `height="${fmt((boxH / UPEM) * emPx)}" ` +
    `viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(boxW)} ${fmt(boxH)}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    `<g fill="${color}">${body.join('')}</g></svg>`;

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
