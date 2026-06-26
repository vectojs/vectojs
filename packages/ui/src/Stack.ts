import { Entity, IRenderer } from '@vecto-ui/core';
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
}

/**
 * A layout container that positions its children sequentially along a main axis
 * with a gap, aligning them on the cross axis. Re-runs layout whenever a child is
 * added; its own `width`/`height` size to the laid-out content (enabling culling).
 *
 * Children keep their own sizes; only their `x`/`y` are set. Purely structural —
 * draws nothing itself.
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

  constructor(opts: StackOptions = {}) {
    super('Stack');
    this.direction = opts.direction ?? 'vertical';
    this.gap = opts.gap ?? 0;
    this.align = opts.align ?? 'start';
    this.wrap = opts.wrap ?? false;
    this.maxWidth = opts.maxWidth ?? Infinity;
    this.maxHeight = opts.maxHeight ?? Infinity;
  }

  /** Add a child and re-run layout. */
  public add(child: Entity): this {
    super.add(child);
    this.layout();
    return this;
  }

  /**
   * Position all children along the main axis and align them on the cross axis,
   * then size this container to fit.
   */
  public layout(): void {
    const vertical = this.direction === 'vertical';
    const limit = vertical ? this.maxHeight : this.maxWidth;

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
  }

  /** Structural container — draws nothing itself. */
  public render(_r: IRenderer): void {}
}
