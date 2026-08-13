import {
  type A11yAttributes,
  type DevtoolsDescriptor,
  Entity,
  IRenderer,
  type LayoutControlledProperty,
  type MotionConfig,
} from '@vectojs/core';
import { UIComponent } from './UIComponent';

export interface ScrollViewOptions {
  width: number;
  height: number;
  /**
   * Physics driving the scroll offset. Defaults to `'spring'`, whose defaults
   * (`stiffness: 180`, `damping: 12`) are underdamped — ζ ≈ 0.447, so one wheel
   * tick overshoots by ~20% and reverses direction several times before
   * settling. That reads as liveliness on a short list and as a bounce on a
   * document.
   *
   * For document-like content pass the critically-damped preset
   * `{ stiffness: 180, damping: 27 }`: same travel, no overshoot, and the
   * spring reaches rest sooner, which also lets {@link Entity.hasPendingAnimations}
   * clear so Scene's idle throttle can re-engage.
   */
  scrollPhysics?: MotionConfig;
}

/**
 * Critically-damped scroll physics: reaches the target without overshoot.
 *
 * ζ = damping / (2·√(stiffness·mass)) = 27 / (2·√180) ≈ 1.006, just past the
 * critical 2·√180 ≈ 26.83. Exported so applications can opt into
 * non-bouncing document scrolling without re-deriving the constants.
 */
export const DOCUMENT_SCROLL_PHYSICS: MotionConfig = {
  stiffness: 180,
  damping: 27,
};

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
    super();
    this.width = opts.width;
    this.height = opts.height;
    this.interactive = true;
    this.clipChildren = true;

    this.content = new (class extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
      /** Snap to `y` without touching the spring — see `scrollToBottom`'s use. */
      jumpTo(y: number): void {
        this.setImmediate('y', y);
      }
    })('ScrollViewContent');
    super.add(this.content);
    // Drive scroll position through the shared, dt-aware spring system rather
    // than a hand-rolled per-frame integrator: that integrator ignored `dt`
    // (frame-rate-dependent) and was invisible to Scene's idle auto-throttle
    // (see Entity.hasPendingAnimations), so it only advanced once per external
    // markDirty() trigger instead of every render frame once the throttle
    // engaged — visibly stepping/jumping instead of gliding.
    this.content.setTransition({ y: opts.scrollPhysics ?? 'spring' });

    this.on('wheel', (e) => {
      if (e.ctrlKey) return; // Allow browser zoom (Ctrl+wheel)
      e.preventDefault();
      const deltaY = e.deltaY ?? 0;
      const deltaMode = e.deltaMode ?? 0;
      // Convert deltaMode: 0=pixels (unchanged), 1=lines (~16px), 2=pages (viewport height)
      let scrollDelta = deltaY;
      if (deltaMode === 1)
        scrollDelta = deltaY * 16; // line mode
      else if (deltaMode === 2) scrollDelta = deltaY * this.height; // page mode
      this.targetY -= scrollDelta;
      this.clampTarget();
      this.content.y = this.targetY; // retargets the spring; preserves velocity
    });

    // Pointer-drag (touch & mouse): content follows the finger/cursor 1:1.
    this.on('pointerdown', (e: { localY?: number }) => {
      if (e.localY === undefined) return;
      this.dragging = true;
      this.lastPointerY = e.localY;
    });
    this.on('pointermove', (e: { localY?: number }) => {
      if (!this.dragging || e.localY === undefined) return;
      const y = e.localY;
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
   *
   * Snaps instantly rather than retargeting the spring: callers that track
   * growing content (e.g. streaming chat) call this on every update, often
   * many times a second — retargeting a spring that fast never lets it
   * settle, so the viewport visibly jitters instead of tracking the newest
   * content. Wheel/drag scrolling still springs (see above); only this
   * "pin to the end" path bypasses it.
   */
  public scrollToBottom(): void {
    const maxScroll = Math.max(0, this.content.height - this.height);
    this.targetY = -maxScroll;
    (this.content as unknown as { jumpTo(y: number): void }).jumpTo(this.targetY);
  }

  public add(child: Entity): this {
    this.content.add(child);
    this.updateContentSize();
    return this;
  }

  public remove(child: Entity): this {
    // Direct children of the ScrollView itself (the inner content container,
    // scrollbar chrome) must detach via super.remove: redirecting them to
    // `content.remove` is a no-op, which leaves them in `this.children` and
    // turns Entity.destroy()'s drain loop (`while (children.length) ...`)
    // into an infinite loop once the child is already destroyed.
    if (child.parent === this) {
      super.remove(child);
    } else {
      this.content.remove(child);
    }
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

  /**
   * Scroll offset, spring target and clamp range.
   *
   * `content.y` is the live spring position while `targetY` is where it is headed;
   * seeing both is the only way to tell a mid-animation offset from a stuck one.
   */
  /**
   * A ScrollView owns geometry on its internal content wrapper only — that is where
   * the scroll offset lives. Children the caller adds go INSIDE the wrapper and keep
   * their own coordinates, so nothing is reported for them.
   */
  public override getLayoutControlledProperties(
    child: Entity,
  ): ReadonlyArray<LayoutControlledProperty> {
    return child === this.content ? ['y', 'width', 'height'] : [];
  }

  /**
   * A ScrollView is a structural container: it draws nothing and every pixel a
   * user aims at belongs to a descendant. It is nonetheless `interactive`, so
   * Scene projects a viewport-sized semantic mirror for it — and a mirror with
   * the default `pointerEvents: 'auto'` sits above the content projections
   * (which are pinned to `zIndex: 0`) and swallows the pointer, making the text
   * underneath unselectable.
   *
   * Opting out of hit testing restores selection while keeping wheel
   * scrolling: Scene binds its wheel listener to the *content* projection and
   * dispatches it to the owning node, not to this mirror. The one thing that
   * does not survive is pointer-*drag* scrolling over selectable text, which is
   * the correct trade — a drag over text means "select this" on every other
   * platform.
   */
  public override getA11yAttributes(): A11yAttributes {
    return { pointerEvents: 'none' };
  }

  public override getDevtoolsDescriptor(): DevtoolsDescriptor {
    const maxScroll = Math.max(0, this.content.height - this.height);
    return {
      kind: 'ScrollView',
      groups: [
        {
          label: 'Scroll',
          fields: [
            {
              label: 'scrollTop',
              value: Math.round(-this.content.y * 10) / 10,
              hint: 'Live spring position, negated from content.y',
              readOnly: true,
            },
            {
              label: 'targetTop',
              value: Math.round(-this.targetY * 10) / 10,
              hint: 'Where the spring is headed; differs from scrollTop mid-animation',
              readOnly: true,
            },
            {
              label: 'maxScroll',
              value: Math.round(maxScroll * 10) / 10,
              readOnly: true,
            },
            { label: 'dragging', value: this.dragging, readOnly: true },
          ],
        },
        {
          label: 'Content',
          fields: [
            {
              label: 'contentHeight',
              value: Math.round(this.content.height),
              readOnly: true,
            },
            {
              label: 'viewportHeight',
              value: Math.round(this.height),
              readOnly: true,
            },
            {
              label: 'childCount',
              value: this.content.children.length,
              readOnly: true,
            },
          ],
        },
      ],
      notes:
        maxScroll === 0
          ? ['Content fits the viewport, so scrolling is a no-op regardless of input.']
          : undefined,
    };
  }

  public render(_r: IRenderer): void {
    // ScrollView itself draws nothing (background can be added if needed)
  }
}
