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

  constructor(opts: StackOptions = {}) {
    super();
    this.direction = opts.direction ?? 'vertical';
    this.gap = opts.gap ?? 0;
    this.align = opts.align ?? 'start';
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
    // Cross-axis extent = the largest child's cross size.
    let cross = 0;
    for (const c of this.children) {
      cross = Math.max(cross, vertical ? c.width : c.height);
    }

    let main = 0;
    for (let i = 0; i < this.children.length; i++) {
      const c = this.children[i];
      if (i > 0) main += this.gap;
      const childCross = vertical ? c.width : c.height;
      let offset = 0;
      if (this.align === 'center') offset = (cross - childCross) / 2;
      else if (this.align === 'end') offset = cross - childCross;

      if (vertical) {
        c.x = offset;
        c.y = main;
        main += c.height;
      } else {
        c.x = main;
        c.y = offset;
        main += c.width;
      }
    }

    this.width = vertical ? cross : main;
    this.height = vertical ? main : cross;
  }

  /** Structural container — draws nothing itself. */
  public render(_r: IRenderer): void {}
}
