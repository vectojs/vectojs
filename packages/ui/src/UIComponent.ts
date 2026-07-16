import { Entity, Bounds, type AnimatableProp, type MotionConfig } from '@vectojs/core';

/** Declares an enter/exit animation: each property travels from `from` to `to`. */
export interface MotionSpec {
  props: Partial<Record<AnimatableProp, [from: number, to: number]>>;
  config?: MotionConfig;
}

/**
 * Base class for high-level UI components.
 *
 * Centralizes the box model and AABB hit-testing shared by {@link Text},
 * {@link Button}, and {@link Link}, plus a shared enter/exit presence helper:
 * declare {@link enterMotion}/{@link exitMotion} and the component animates in on
 * mount and out on {@link dismiss} — one implementation instead of each component
 * hand-rolling its own spring or lerp.
 */
export abstract class UIComponent extends Entity {
  /** Inner padding in pixels, used by box-style components. */
  public padding: number = 0;

  /** Played automatically when the component mounts to a live scene, if set. */
  protected enterMotion?: MotionSpec;
  /** Played by {@link dismiss} before the component removes itself, if set. */
  protected exitMotion?: MotionSpec;

  protected override onMounted(): void {
    if (this.enterMotion) void this.playMotion(this.enterMotion);
  }

  /** Seed each prop to `from`, register the transition, then drive to `to`. */
  protected playMotion(spec: MotionSpec): Promise<void> {
    const cfg: MotionConfig = spec.config ?? 'spring';
    const targets: Partial<Record<AnimatableProp, number>> = {};
    const trans: Partial<Record<AnimatableProp, MotionConfig>> = {};
    for (const [k, pair] of Object.entries(spec.props)) {
      const prop = k as AnimatableProp;
      const [from, to] = pair as [number, number];
      this.setImmediate(prop, from); // seed the starting value instantly
      targets[prop] = to;
      trans[prop] = cfg;
    }
    this.setTransition(trans);
    return this.driveMotion(targets, cfg);
  }

  private driveMotion(
    targets: Partial<Record<AnimatableProp, number>>,
    cfg: MotionConfig,
  ): Promise<void> {
    if (typeof cfg === 'object' && 'duration' in cfg) {
      return this.animateTo(targets, cfg);
    }
    return this.springTo(targets, cfg === 'spring' ? {} : cfg);
  }

  /** Play the exit motion (if any), then remove self from the tree. */
  public async dismiss(): Promise<void> {
    if (this.exitMotion) await this.playMotion(this.exitMotion);
    this.parent?.remove(this);
  }

  /** Wakes the render loop at the next caret-blink phase boundary, or `null`. */
  private caretBlinkTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Keep a focused text component's caret blink visible to the idle throttle.
   * The blink phase is derived from `Date.now()` inside `render()`, so nothing
   * marks the scene dirty when the phase flips — an idle `onDemand` scene
   * would freeze the caret solid (the ScrollView 0.2.x regression class).
   * One timeout per 500 ms phase boundary costs ~2 renders/s while focused;
   * reporting a permanent pending animation instead would pin the scene at
   * full frame rate for as long as the field holds focus.
   */
  protected startCaretBlinkWake(): void {
    this.stopCaretBlinkWake();
    const schedule = () => {
      this.caretBlinkTimer = setTimeout(
        () => {
          this.scene?.markDirty();
          schedule();
        },
        500 - (Date.now() % 500),
      );
    };
    schedule();
    this.scene?.markDirty(); // show the caret promptly, not at the next boundary
  }

  /** Stop the caret-blink wake-up (on blur; destroy also clears it). */
  protected stopCaretBlinkWake(): void {
    if (this.caretBlinkTimer !== null) {
      clearTimeout(this.caretBlinkTimer);
      this.caretBlinkTimer = null;
    }
    this.scene?.markDirty(); // erase the caret promptly on blur
  }

  public override destroy(): void {
    if (this.caretBlinkTimer !== null) {
      clearTimeout(this.caretBlinkTimer);
      this.caretBlinkTimer = null;
    }
    super.destroy();
  }

  /**
   * Axis-aligned hit-test against the component's box in global space.
   *
   * @param globalX - World-space X coordinate.
   * @param globalY - World-space Y coordinate.
   * @returns Whether the point lies within `[0, width] x [0, height]` locally.
   */
  public isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  /** Local-space box, enabling viewport culling by {@link Scene}. */
  public getBounds(): Bounds {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
}
