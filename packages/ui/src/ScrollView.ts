import { Entity, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';

export interface ScrollViewOptions {
  width: number;
  height: number;
}

/**
 * A scrollable viewport that clips its content and handles wheel/touch scrolling
 * with spring physics.
 */
export class ScrollView extends UIComponent {
  public content: Entity;

  private targetY: number = 0;
  private velocityY: number = 0;
  private readonly friction: number = 0.85;
  private readonly spring: number = 0.1;
  // Pointer-drag (touch / mouse) state.
  private dragging: boolean = false;
  private lastPointerY: number = 0;

  constructor(opts: ScrollViewOptions) {
    super('ScrollView');
    this.width = opts.width;
    this.height = opts.height;
    this.interactive = true;
    this.clipChildren = true;

    this.content = new (class extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    })('ScrollViewContent');
    super.add(this.content);

    this.on('wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.targetY -= e.deltaY;
      this.clampTarget();
      this.scene?.markDirty();
    });

    // Pointer-drag (touch & mouse): content follows the finger/cursor 1:1.
    this.on('pointerdown', (e: { clientY?: number }) => {
      this.dragging = true;
      this.lastPointerY = e.clientY ?? 0;
      this.scene?.markDirty();
    });
    this.on('pointermove', (e: { clientY?: number }) => {
      if (!this.dragging) return;
      const y = e.clientY ?? 0;
      this.targetY += y - this.lastPointerY;
      this.lastPointerY = y;
      this.clampTarget();
      this.scene?.markDirty();
    });
    const endDrag = () => {
      this.dragging = false;
    };
    this.on('pointerup', endDrag);
    this.on('pointerleave', endDrag);
  }

  /** Clamp the scroll target to `[-maxScroll, 0]` (top and content-end edges). */
  private clampTarget(): void {
    const maxScroll = Math.max(0, this.content.height - this.height);
    if (this.targetY > 0) this.targetY = 0;
    else if (this.targetY < -maxScroll) this.targetY = -maxScroll;
  }

  public add(child: Entity): this {
    this.content.add(child);
    this.updateContentSize();
    return this;
  }

  public remove(child: Entity): this {
    this.content.remove(child);
    this.updateContentSize();
    return this;
  }

  /**
   * Calculates the bounds of the content node to determine the max scroll area.
   */
  public updateContentSize(): void {
    let maxW = 0;
    let maxH = 0;
    for (const child of this.content.children) {
      if (child.x + child.width > maxW) maxW = child.x + child.width;
      if (child.y + child.height > maxH) maxH = child.y + child.height;
    }
    this.content.width = maxW;
    this.content.height = maxH;

    // Re-clamp if size shrunk
    const maxScroll = Math.max(0, this.content.height - this.height);
    if (this.targetY < -maxScroll) {
      this.targetY = -maxScroll;
    }
  }

  public update(dt: number, time: number): void {
    super.update(dt, time);

    // Smooth scrolling integration
    const maxScroll = Math.max(0, this.content.height - this.height);

    // Spring back if out of bounds (for rubber-banding later)
    if (this.content.y > 0) {
      this.targetY = 0;
    } else if (this.content.y < -maxScroll) {
      this.targetY = -maxScroll;
    }

    const diff = this.targetY - this.content.y;
    this.velocityY += diff * this.spring;
    this.velocityY *= this.friction;

    if (Math.abs(this.velocityY) > 0.01 || Math.abs(diff) > 0.01) {
      this.content.y += this.velocityY;
      this.scene?.markDirty();
    } else {
      this.content.y = this.targetY;
      this.velocityY = 0;
    }
  }

  public render(_r: IRenderer): void {
    // ScrollView itself draws nothing (background can be added if needed)
  }
}
