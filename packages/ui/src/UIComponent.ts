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
