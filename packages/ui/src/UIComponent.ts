import { Entity } from '@vecto-ui/core';

/**
 * Base class for high-level UI components.
 *
 * Centralizes the box model and AABB hit-testing shared by {@link Text},
 * {@link Button}, and {@link Link}. Subclasses set `width`/`height` from their
 * measured content and implement `render` plus (when interactive) override
 * `getA11yAttributes` to project the right shadow node.
 */
export abstract class UIComponent extends Entity {
  /** Inner padding in pixels, used by box-style components. */
  public padding: number = 0;

  /**
   * Axis-aligned hit-test against the component's box in global space.
   *
   * @param globalX - World-space X coordinate.
   * @param globalY - World-space Y coordinate.
   * @returns Whether the point lies within `[0, width] x [0, height]` locally.
   */
  public isPointInside(globalX: number, globalY: number): boolean {
    const pos = this.getGlobalPosition();
    const lx = globalX - pos.x;
    const ly = globalY - pos.y;
    return lx >= 0 && lx <= this.width && ly >= 0 && ly <= this.height;
  }
}
