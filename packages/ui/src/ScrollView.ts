import { Entity, IRenderer } from '@vectojs/core';
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
    // Drive scroll position through the shared, dt-aware spring system rather
    // than a hand-rolled per-frame integrator: that integrator ignored `dt`
    // (frame-rate-dependent) and was invisible to Scene's idle auto-throttle
    // (see Entity.hasPendingAnimations), so it only advanced once per external
    // markDirty() trigger instead of every render frame once the throttle
    // engaged — visibly stepping/jumping instead of gliding.
    this.content.setTransition({ y: 'spring' });

    this.on('wheel', (e: WheelEvent) => {
      if (e.ctrlKey) return; // Allow browser zoom (Ctrl+wheel)
      e.preventDefault();
      this.targetY -= e.deltaY;
      this.clampTarget();
      this.content.y = this.targetY; // retargets the spring; preserves velocity
    });

    // Pointer-drag (touch & mouse): content follows the finger/cursor 1:1.
    this.on('pointerdown', (e: { clientY?: number }) => {
      this.dragging = true;
      this.lastPointerY = e.clientY ?? 0;
    });
    this.on('pointermove', (e: { clientY?: number }) => {
      if (!this.dragging) return;
      const y = e.clientY ?? 0;
      this.targetY += y - this.lastPointerY;
      this.lastPointerY = y;
      this.clampTarget();
      this.content.y = this.targetY;
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

  /**
   * Scroll to a specific Y offset (where 0 is top).
   *
   * @param y - The target scroll position in pixels.
   */
  public scrollTo(y: number): void {
    this.targetY = -Math.max(0, y);
    this.clampTarget();
    this.content.y = this.targetY;
  }

  /**
   * Scroll to the very bottom of the content.
   */
  public scrollToBottom(): void {
    const maxScroll = Math.max(0, this.content.height - this.height);
    this.targetY = -maxScroll;
    this.content.y = this.targetY;
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
      this.content.y = this.targetY;
    }
  }

  /**
   * Defensive re-clamp only — the actual scroll motion is driven by `content`'s
   * own spring transition, which the Scene tree walk ticks directly (calling
   * `content.update()` as a normal child node). Reassigning `content.y` here
   * unconditionally every frame would spawn a spurious (instantly-done) driver
   * even when nothing changed, permanently defeating the idle throttle this
   * fix restores — so only touch it when clamping actually moves the target.
   */
  public update(dt: number, time: number): void {
    super.update(dt, time);
    const before = this.targetY;
    this.clampTarget();
    if (this.targetY !== before) this.content.y = this.targetY;
  }

  public render(_r: IRenderer): void {
    // ScrollView itself draws nothing (background can be added if needed)
  }
}
