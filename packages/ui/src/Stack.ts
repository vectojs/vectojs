import {
  Entity,
  IRenderer,
  type Bounds,
  type LayoutControlledProperty,
  type RenderChildRange,
} from '@vectojs/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Stack}. */
export interface StackOptions {
  /** Main axis. Default `'vertical'`. */
  direction?: 'vertical' | 'horizontal';
  /** Gap between children in pixels. Default `0`. */
  gap?: number;
  /** Cross-axis alignment of children. Default `'start'`. */
  align?: 'start' | 'center' | 'end';
  /** Whether to wrap children to the next line when exceeding maxWidth/maxHeight. Default `false`. */
  wrap?: boolean;
  /** Maximum size along the main axis before wrapping (requires wrap: true). */
  maxWidth?: number;
  maxHeight?: number;
  /**
   * Skip drawing vertical children outside the viewport while retaining the
   * complete entity tree. Enable only when each direct child's box contains its
   * entire painted subtree. Defaults to false.
   */
  cullOffscreenChildren?: boolean;
  /**
   * Target extent along the main axis in pixels. When set (and `wrap` is
   * false), `layout()` stretches the LAST child along the main axis so the
   * children plus gaps total exactly this size — enabling fill-remaining
   * layouts without hand-rolled per-render loops. The last child never
   * shrinks below its own content size: if the other children plus gaps
   * leave less room than that, it keeps its content size and the content
   * overflows the container (the container still reports `fillTarget` as its
   * main-axis extent). All other children keep their sizes. Ignored when
   * `wrap: true`. While set, the O(1) incremental append paths are bypassed
   * and every mutation re-runs the full `layout()`.
   */
  fillTarget?: number;
}

/**
 * A layout container that positions its children sequentially along a main axis
 * with a gap, aligning them on the cross axis. Re-runs layout whenever a child is
 * added; its own `width`/`height` size to the laid-out content (enabling culling).
 *
 * Children keep their own sizes; only their `x`/`y` are set (the sole
 * exception is the last child when `fillTarget` is set — see
 * {@link StackOptions.fillTarget}). Purely structural — draws nothing itself.
 *
 * @example
 * const col = new Stack({ direction: 'vertical', gap: 12 });
 * col.add(new Text('Title'));
 * col.add(new Button('Go'));
 * scene.add(col.setPosition(40, 40));
 */
export class Stack extends UIComponent {
  public direction: 'vertical' | 'horizontal';
  public gap: number;
  public align: 'start' | 'center' | 'end';
  public wrap: boolean;
  public maxWidth: number;
  public maxHeight: number;
  public cullOffscreenChildren: boolean;
  /** Requested main-axis extent, or `undefined` when {@link StackOptions.fillTarget} is not set. */
  public fillTarget: number | undefined;

  // Bookkeeping for the stretch `layout()` applies to the last child while
  // `fillTarget` is set: which entity was stretched, its content (pre-stretch)
  // main extent, and the extent actually applied. A later `layout()` uses these
  // to tell its own previous stretch apart from a genuine external resize —
  // so repeated layouts don't compound the stretch and a shrinking
  // `fillTarget` still takes effect.
  private fillStretchedChild: Entity | null = null;
  private fillStretchedOriginal = 0;
  private fillStretchedApplied = 0;

  // Set by `remove()` (or anything else that can invalidate the incremental
  // append assumptions below) so the next `add()` falls back to a full
  // `layout()` instead of the fast path, resynchronizing width/height/
  // positions correctly before further fast appends resume.
  private fastAppendDirty = false;

  // Incremental wrap-append state, kept O(1) so a wrapping Stack built one
  // child at a time (a streaming Flow of tags/chips) doesn't re-run the full
  // O(children) `layout()` on every `add()` — which made total build cost
  // O(children²). Describes the LAST line only; `layout()` recomputes these at
  // the end and `appendFastWrap()` updates them per append. Valid under the
  // same invariants as the non-wrap fast path (`align: 'start'`, not right
  // after a `remove()`), because start alignment pins every child to its
  // line's start, so a later child that grows the line's cross size never
  // shifts an already-placed one.
  private wrapLineMain = 0; // main-axis extent of the last line (incl. inner gaps)
  private wrapLineCross = 0; // cross-axis extent (max child cross) of the last line
  private wrapPriorCross = 0; // summed cross (incl. gaps) of all lines before the last
  private wrapMaxMain = 0; // largest line main-extent seen (drives cross-axis size)

  constructor(opts: StackOptions = {}) {
    super();
    this.direction = opts.direction ?? 'vertical';
    this.gap = opts.gap ?? 0;
    this.align = opts.align ?? 'start';
    this.wrap = opts.wrap ?? false;
    this.maxWidth = opts.maxWidth ?? Infinity;
    this.maxHeight = opts.maxHeight ?? Infinity;
    this.cullOffscreenChildren = opts.cullOffscreenChildren ?? false;
    this.fillTarget = opts.fillTarget;
    this.viewportCullChildren = this.cullOffscreenChildren;
  }

  public override getRenderChildRange(localViewport: Bounds): RenderChildRange | null {
    if (!this.cullOffscreenChildren || this.direction !== 'vertical' || this.wrap) return null;

    const children = this.children;
    const count = children.length;
    if (count === 0) return { start: 0, end: 0 };
    const minY = localViewport.y;
    const maxY = minY + localViewport.height;

    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const child = children[mid];
      if (child.y + child.height < minY) low = mid + 1;
      else high = mid;
    }
    const start = low;

    low = start;
    high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (children[mid].y <= maxY) low = mid + 1;
      else high = mid;
    }
    return { start, end: low };
  }

  /**
   * Add a child. Building a large Stack by calling `add()` once per item
   * (e.g. a streaming Markdown renderer adding one paragraph at a time) used
   * to re-run the full `layout()` — an O(children) walk — on every single
   * call, making total layout cost scale with the SQUARE of the item count.
   * The overwhelmingly common case (no wrapping, default start alignment)
   * only ever needs to place the ONE new child at the end and grow the
   * container's own size to match — every earlier child's position and the
   * container's cross-axis size are unaffected by a start-aligned append,
   * so this fast path only recomputes that one child instead of the whole
   * list. Falls back to the full `layout()` whenever that invariant doesn't
   * hold: wrapping (a new child can start a new line, shifting nothing
   * already placed, but the grouping itself requires a full re-pass) or
   * non-start alignment (a new child that's cross-axis-larger than every
   * prior one would shift their centered/end-aligned offset), or right
   * after a `remove()` (positions/size may be stale until resynchronized).
   */
  /**
   * A `Stack` positions its children on both axes, so both coordinates are
   * recomputed on every layout and an edit to either is reverted.
   */
  public override getLayoutControlledProperties(): ReadonlyArray<LayoutControlledProperty> {
    return ['x', 'y'];
  }

  public add(child: Entity): this {
    super.add(child);
    if (this.fastAppendDirty || this.align !== 'start' || this.fillTarget !== undefined) {
      // fillTarget forces the full path too: the previous last child may be
      // carrying layout()'s stretch, which must be un-applied before the new
      // child is placed and the stretch recomputed onto the new last child.
      this.layout();
      this.fastAppendDirty = false;
    } else if (this.wrap) {
      this.appendFastWrap(child);
    } else {
      this.appendFast(child);
    }
    return this;
  }

  /** Remove a child. Marks layout state stale so the next `add()` resyncs via a full `layout()`. */
  public override remove(child: Entity): this {
    super.remove(child);
    this.fastAppendDirty = true;
    return this;
  }

  /**
   * Notify the Stack that its LAST child changed its own size in place —
   * e.g. a streaming Markdown paragraph's `RichText` grew via `setSpans()`
   * as more text streamed in — without any `add()`/`remove()` call. Callers
   * that resize an existing child used to have no cheap way to resync a
   * container built around one-child-at-a-time streaming, so they fell back
   * to a full `layout()` (an O(children) walk) on every single change, which
   * defeats the point of `add()`'s O(1) fast path: the growing child is still
   * the ONLY one whose bounds moved, so no earlier sibling needs touching.
   *
   * Same invariants as the `add()` fast path (no wrap, `align: 'start'`, not
   * immediately after a `remove()`), PLUS one more: the resized child's
   * cross-axis size may only GROW, never shrink — true for text that's
   * purely being appended to (existing lines are unaffected; new content
   * only extends the last line up to the wrap width or starts new,
   * shorter-or-equal lines), but not safe in general (e.g. content being
   * replaced/edited down). A shrinking resize would leave `width`/`height`
   * stale-too-large until the next full `layout()`. Falls back to a full
   * `layout()` whenever any invariant doesn't hold.
   */
  public resizeLastChild(child: Entity): void {
    if (
      this.fastAppendDirty ||
      this.wrap ||
      this.align !== 'start' ||
      this.fillTarget !== undefined ||
      this.children[this.children.length - 1] !== child
    ) {
      this.layout();
      this.fastAppendDirty = false;
      return;
    }
    if (this.direction === 'vertical') {
      this.height = child.y + child.height;
      this.width = Math.max(this.width, child.width);
    } else {
      this.width = child.x + child.width;
      this.height = Math.max(this.height, child.height);
    }
  }

  private appendFast(child: Entity): void {
    const vertical = this.direction === 'vertical';
    const hasPrior = this.children.length > 1;
    if (vertical) {
      child.x = 0;
      child.y = hasPrior ? this.height + this.gap : 0;
      this.width = hasPrior ? Math.max(this.width, child.width) : child.width;
      this.height = (hasPrior ? this.height + this.gap : 0) + child.height;
    } else {
      child.y = 0;
      child.x = hasPrior ? this.width + this.gap : 0;
      this.height = hasPrior ? Math.max(this.height, child.height) : child.height;
      this.width = (hasPrior ? this.width + this.gap : 0) + child.width;
    }
  }

  /**
   * O(1) incremental append for the WRAP + start-align case. Places `child`
   * either at the end of the current line (if it still fits within the main-
   * axis limit) or as the first child of a new line, using only the persisted
   * last-line state — never re-walking earlier children. Start alignment is
   * what makes this safe: every child sits at its line's start on the cross
   * axis, so a later, cross-larger child on the same line grows `wrapLineCross`
   * without shifting any already-placed sibling. Mirrors the grouping/placement
   * `layout()` does, so the result is identical to a full re-layout.
   */
  private appendFastWrap(child: Entity): void {
    const vertical = this.direction === 'vertical';
    const limit = vertical ? this.maxHeight : this.maxWidth;
    const childMain = vertical ? child.height : child.width;
    const childCross = vertical ? child.width : child.height;
    const firstEver = this.children.length === 1;

    // Wrap when the current (non-empty) line can't fit the child within the
    // main-axis limit — identical test to layout()'s pass 1.
    const startsNewLine = !firstEver && this.wrapLineMain + this.gap + childMain > limit;

    if (firstEver) {
      this.wrapPriorCross = 0;
      this.wrapLineMain = childMain;
      this.wrapLineCross = childCross;
    } else if (startsNewLine) {
      // Close the current line: its cross extent (plus a gap) now sits above
      // the new line.
      this.wrapPriorCross += this.wrapLineCross + this.gap;
      this.wrapLineMain = childMain;
      this.wrapLineCross = childCross;
    } else {
      this.wrapLineMain += this.gap + childMain;
      this.wrapLineCross = Math.max(this.wrapLineCross, childCross);
    }

    // Main-axis start position of this child within its line.
    const mainStart = startsNewLine || firstEver ? 0 : this.wrapLineMain - childMain;
    if (vertical) {
      child.x = this.wrapPriorCross; // start-align: line start on the cross axis
      child.y = mainStart;
    } else {
      child.x = mainStart;
      child.y = this.wrapPriorCross;
    }

    this.wrapMaxMain = Math.max(this.wrapMaxMain, this.wrapLineMain);
    const totalCross = this.wrapPriorCross + this.wrapLineCross;
    this.width = vertical ? totalCross : this.wrapMaxMain;
    this.height = vertical ? this.wrapMaxMain : totalCross;
  }

  /**
   * Position all children along the main axis and align them on the cross axis,
   * then size this container to fit.
   */
  public layout(): void {
    const vertical = this.direction === 'vertical';
    const limit = vertical ? this.maxHeight : this.maxWidth;

    // Fill-target bookkeeping: un-apply the stretch that an earlier layout()
    // put on a child, so the sizes measured below are content sizes rather
    // than this container's own past output. When the stretched child is
    // still the last one AND fill is still active, the entity physically
    // keeps its stretched size for now (it is re-stretched below anyway) and
    // only the recorded content size feeds the math — that keeps repeated
    // layouts idempotent, respects genuine external resizes, and lets a
    // shrinking fillTarget take effect.
    const fillActive = this.fillTarget !== undefined && !this.wrap;
    const lastChild = this.children[this.children.length - 1];
    if (this.fillStretchedChild && (!fillActive || this.fillStretchedChild !== lastChild)) {
      const prev = this.fillStretchedChild;
      if (vertical) prev.height = this.fillStretchedOriginal;
      else prev.width = this.fillStretchedOriginal;
      this.fillStretchedChild = null;
    }

    // Pass 1: group into lines if wrapping
    const lines: Entity[][] = [];
    let currentLine: Entity[] = [];
    let currentMain = 0;

    for (const c of this.children) {
      const childMain = vertical ? c.height : c.width;
      if (this.wrap && currentLine.length > 0 && currentMain + this.gap + childMain > limit) {
        lines.push(currentLine);
        currentLine = [c];
        currentMain = childMain;
      } else {
        currentLine.push(c);
        currentMain += currentLine.length > 1 ? this.gap + childMain : childMain;
      }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // Pass 1.5 (fill): stretch the LAST child along the main axis so the
    // children plus gaps total exactly fillTarget — floored at its content
    // size, never shrinking below it. With wrap off, pass 1 produced at most
    // one line holding every child. The content size is the recorded
    // pre-stretch value when this child still carries our own previous
    // stretch; anything else means it was genuinely resized from outside and
    // the new size wins.
    if (fillActive && lines.length > 0) {
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      const rawMain = vertical ? last.height : last.width;
      const contentMain =
        this.fillStretchedChild === last && rawMain === this.fillStretchedApplied
          ? this.fillStretchedOriginal
          : rawMain;
      let othersMain = 0;
      for (let i = 0; i < line.length - 1; i++) {
        othersMain += vertical ? line[i].height : line[i].width;
      }
      const leftover = this.fillTarget! - othersMain - (line.length - 1) * this.gap;
      const applied = Math.max(contentMain, leftover);
      if (vertical) last.height = applied;
      else last.width = applied;
      this.fillStretchedChild = last;
      this.fillStretchedOriginal = contentMain;
      this.fillStretchedApplied = applied;
    }

    // Pass 2: layout lines
    let totalCross = 0;
    let maxTotalMain = 0;

    for (const line of lines) {
      let lineCross = 0;
      let lineMain = 0;
      for (const c of line) {
        lineCross = Math.max(lineCross, vertical ? c.width : c.height);
        lineMain += vertical ? c.height : c.width;
      }
      lineMain += (line.length - 1) * this.gap;
      maxTotalMain = Math.max(maxTotalMain, lineMain);

      let currentMain = 0;
      for (const c of line) {
        const childCross = vertical ? c.width : c.height;
        let offset = totalCross;
        if (this.align === 'center') offset += (lineCross - childCross) / 2;
        else if (this.align === 'end') offset += lineCross - childCross;

        if (vertical) {
          c.x = offset;
          c.y = currentMain;
          currentMain += c.height + this.gap;
        } else {
          c.x = currentMain;
          c.y = offset;
          currentMain += c.width + this.gap;
        }
      }
      totalCross += lineCross + this.gap;
    }
    // Remove trailing gap
    if (lines.length > 0) totalCross -= this.gap;

    this.width = vertical ? totalCross : maxTotalMain;
    this.height = vertical ? maxTotalMain : totalCross;

    // While filling, the container reports exactly fillTarget along the main
    // axis — even when insufficient space floored the last child at its
    // content size and the laid-out children now overflow it (overflow
    // semantics, like a fixed-size box). With no children there is nothing
    // to stretch, so an empty stack keeps its content-based size of zero.
    if (fillActive && lines.length > 0) {
      if (vertical) this.height = this.fillTarget!;
      else this.width = this.fillTarget!;
    }

    // Refresh the incremental wrap-append state from the just-computed lines so
    // the next wrapping `add()` can extend the last line in O(1) instead of
    // re-running this whole pass. Describes the LAST line + everything above it.
    if (this.wrap) {
      const lastLine = lines[lines.length - 1];
      let lineMain = 0;
      let lineCross = 0;
      if (lastLine) {
        for (const c of lastLine) {
          lineCross = Math.max(lineCross, vertical ? c.width : c.height);
          lineMain += vertical ? c.height : c.width;
        }
        lineMain += (lastLine.length - 1) * this.gap;
      }
      this.wrapLineMain = lineMain;
      this.wrapLineCross = lineCross;
      // Prior cross = total cross minus the last line's cross (and its leading
      // gap, present whenever there is more than one line).
      this.wrapPriorCross = lines.length > 1 ? totalCross - lineCross : 0;
      this.wrapMaxMain = maxTotalMain;
    }
  }

  /** Structural container — draws nothing itself. */
  public render(_r: IRenderer): void {}
}
