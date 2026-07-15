import { Entity, type Bounds, type BatchRect } from '../tree/Entity';
import type { IRenderer } from '../renderer/IRenderer';

/** Construction options for {@link Rect}. */
export interface RectOptions {
  /** Width in local units. Default `0`. */
  width?: number;
  /** Height in local units. Default `0`. */
  height?: number;
  /** CSS fill color, or `null` for no fill. Default `'#38bdf8'`. */
  fill?: string | null;
  /** CSS stroke color, or `null` for no stroke. Default `null`. */
  stroke?: string | null;
  /** Stroke width in local units. Default `1`. */
  strokeWidth?: number;
  /** Corner radius in local units (uniform). Default `0` (sharp corners). */
  radius?: number;
}

/**
 * A concrete axis-aligned rectangle primitive drawn from its local origin
 * `(0, 0)` to `(width, height)`. Instantiate directly — no subclassing:
 *
 * @example
 * const box = new Rect({ width: 120, height: 64, fill: '#38bdf8', radius: 8 });
 * box.set({ x: 40, y: 40 });
 * scene.add(box);
 *
 * The box matches the entity's `width`/`height`, so its accessibility shadow
 * node lines up with what's drawn. A solid-fill, non-rounded, unstroked Rect
 * opts into the WebGL instanced-rectangle fast path via {@link getBatchRect};
 * rounded or stroked rectangles render through the normal Canvas path.
 */
export class Rect extends Entity {
  public fill: string | null;
  public stroke: string | null;
  public strokeWidth: number;
  public radius: number;

  constructor(opts: RectOptions = {}) {
    super();
    this.width = opts.width ?? 0;
    this.height = opts.height ?? 0;
    // `?? default` only for absent (undefined); an explicit `null` means "no
    // fill" and must be preserved, not replaced by the default color.
    this.fill = opts.fill === undefined ? '#38bdf8' : opts.fill;
    this.stroke = opts.stroke ?? null;
    this.strokeWidth = opts.strokeWidth ?? 1;
    this.radius = opts.radius ?? 0;
  }

  public override getBounds(): Bounds {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /**
   * Solid-fill, square-cornered, unstroked rectangles opt into the GPU
   * instanced-rect batch (WebGL `pointBackend` only). Any stroke or corner
   * radius needs the exact Canvas path, so return `null` to fall back to
   * {@link render}. Read each frame, so an animated `fill` still batches.
   */
  public override getBatchRect(): BatchRect | null {
    if (!this.fill || this.stroke || this.radius > 0) return null;
    return { width: this.width, height: this.height, color: this.fill };
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  public render(renderer: IRenderer): void {
    renderer.beginPath();
    if (this.radius > 0) {
      renderer.roundRect(0, 0, this.width, this.height, this.radius);
    } else {
      // No dedicated rect op on IRenderer; trace the box explicitly.
      renderer.moveTo(0, 0);
      renderer.lineTo(this.width, 0);
      renderer.lineTo(this.width, this.height);
      renderer.lineTo(0, this.height);
      renderer.closePath();
    }
    if (this.fill) renderer.fill(this.fill);
    if (this.stroke) renderer.stroke(this.stroke, this.strokeWidth);
  }
}
