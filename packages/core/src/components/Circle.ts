import { Entity, type Bounds, type BatchCircle } from '../tree/Entity';
import type { IRenderer } from '../renderer/IRenderer';

/** Construction options for {@link Circle}. */
export interface CircleOptions {
  /** Radius in local units. Default `0`. */
  radius?: number;
  /** CSS fill color, or `null` for no fill. Default `'#38bdf8'`. */
  fill?: string | null;
  /** CSS stroke color, or `null` for no stroke. Default `null`. */
  stroke?: string | null;
  /** Stroke width in local units. Default `1`. */
  strokeWidth?: number;
}

/**
 * A concrete circle primitive centered on its local origin `(0, 0)`.
 * Instantiate directly — no subclassing:
 *
 * @example
 * const dot = new Circle({ radius: 24, fill: '#f97316' });
 * dot.set({ x: 100, y: 100 });
 * scene.add(dot);
 *
 * The accessibility shadow box is sized to the circle's bounding square and
 * offset by `-radius` so it covers the drawn disc (whose center is the entity
 * origin). A solid-fill (unstroked) Circle opts into the point-batch fast path
 * via {@link getBatchCircle}; a stroked circle renders through the normal path.
 */
export class Circle extends Entity {
  public fill: string | null;
  public stroke: string | null;
  public strokeWidth: number;

  private _radius: number;

  constructor(opts: CircleOptions = {}) {
    super();
    this._radius = opts.radius ?? 0;
    // `?? default` only for absent (undefined); an explicit `null` means "no
    // fill" and must be preserved, not replaced by the default color.
    this.fill = opts.fill === undefined ? '#38bdf8' : opts.fill;
    this.stroke = opts.stroke ?? null;
    this.strokeWidth = opts.strokeWidth ?? 1;
    this.syncBox();
  }

  public get radius(): number {
    return this._radius;
  }
  public set radius(v: number) {
    this._radius = v;
    this.syncBox();
  }

  /** Keep the a11y box (a square around the centered disc) in sync with radius. */
  private syncBox(): void {
    this.width = this._radius * 2;
    this.height = this._radius * 2;
    this.a11yOffsetX = -this._radius;
    this.a11yOffsetY = -this._radius;
  }

  public override getBounds(): Bounds {
    return {
      x: -this._radius,
      y: -this._radius,
      width: this._radius * 2,
      height: this._radius * 2,
    };
  }

  /**
   * A solid-fill, unstroked circle opts into the renderer's circle batch
   * (center = entity origin, radius scaled by world scale). A stroke needs the
   * exact Canvas path, so return `null` there. Read each frame, so an animated
   * `fill`/`radius` still batches.
   */
  public override getBatchCircle(): BatchCircle | null {
    if (!this.fill || this.stroke) return null;
    return { radius: this._radius, color: this.fill };
  }

  public isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x * local.x + local.y * local.y <= this._radius * this._radius;
  }

  public render(renderer: IRenderer): void {
    renderer.beginPath();
    renderer.arc(0, 0, this._radius, 0, Math.PI * 2);
    renderer.closePath();
    if (this.fill) renderer.fill(this.fill);
    if (this.stroke) renderer.stroke(this.stroke, this.strokeWidth);
  }
}
