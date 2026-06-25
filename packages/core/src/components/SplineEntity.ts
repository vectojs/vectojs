import { Bounds, Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

/** One piecewise-cubic segment: x(t) and y(t) as `[a,b,c,d]` polynomial coefficients. */
export interface SplineSegment {
  start_t: number;
  end_t: number;
  x_poly: number[];
  y_poly: number[];
}

/**
 * Color of a spline equation: an `[r,g,b]` triple in `0..1`, a linear-gradient
 * descriptor, or `null` (use the entity's default color).
 */
export type SplineColor =
  | [number, number, number]
  | {
      stops: [number, [number, number, number]][];
      start_pos: [number, number];
      end_pos: [number, number];
    }
  | null;

/** A single curve (one stroke color) made of consecutive {@link SplineSegment}s. */
export interface SplineEquation {
  color_rgb: SplineColor;
  data: SplineSegment[];
}

/** The native vectomancy `Spline` document. */
export interface SplineDocument {
  type: 'Spline';
  equations: SplineEquation[];
  bounding_box?: [number, number, number, number];
}

/** Construction options for {@link SplineEntity}. */
export interface SplineOptions {
  /** Stroke width in local units. Default `2`. */
  lineWidth?: number;
  /** Bake to an OffscreenCanvas once and `drawImage` each frame. Default `true`. */
  cache?: boolean;
  /** Color used when an equation's `color_rgb` is `null`. Default `#e2e8f0`. */
  defaultColor?: string;
}

/** Cubic Bézier control points produced from a {@link SplineSegment}. */
export interface BezierControlPoints {
  x0: number;
  y0: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x3: number;
  y3: number;
}

/**
 * Convert one cubic-polynomial segment to Bézier control points.
 *
 * For a coefficient vector `[a,b,c,d]` describing `f(t)=a+bt+ct²+dt³` on `t∈[0,1]`,
 * the equivalent Bézier control values are `a`, `a+b/3`, `a+2b/3+c/3`, `a+b+c+d`.
 * Applied independently to the x and y polynomials.
 *
 * @param seg - The polynomial segment.
 * @returns The cubic Bézier control points.
 */
export function polySegmentToBezier(seg: SplineSegment): BezierControlPoints {
  const ax = seg.x_poly[0] || 0;
  const bx = seg.x_poly[1] || 0;
  const cx = seg.x_poly[2] || 0;
  const dx = seg.x_poly[3] || 0;
  const ay = seg.y_poly[0] || 0;
  const by = seg.y_poly[1] || 0;
  const cy = seg.y_poly[2] || 0;
  const dy = seg.y_poly[3] || 0;
  return {
    x0: ax,
    y0: ay,
    cp1x: ax + bx / 3,
    cp1y: ay + by / 3,
    cp2x: ax + (2 * bx) / 3 + cx / 3,
    cp2y: ay + (2 * by) / 3 + cy / 3,
    x3: ax + bx + cx + dx,
    y3: ay + by + cy + dy,
  };
}

function rgbToCss(rgb: [number, number, number]): string {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

/**
 * Renders a native vectomancy `Spline` document (piecewise-cubic curves) to canvas.
 *
 * Bounds come from the document's `bounding_box` (or are computed from segment
 * endpoints), so the entity participates in {@link Scene} viewport culling. By
 * default the curves are baked once into an `OffscreenCanvas` and blitted each
 * frame; without `OffscreenCanvas` it strokes the Bézier paths per frame.
 *
 * @example
 * const doc = await loadSpline('/ast/logo.json');
 * scene.add(new SplineEntity(doc).setPosition(100, 100));
 */
export class SplineEntity extends Entity {
  public doc: SplineDocument;
  public lineWidth: number;
  public defaultColor: string;
  private cache: boolean;
  private bounds: Bounds;
  private offscreen: HTMLCanvasElement | OffscreenCanvas | null = null;
  private baked = false;

  constructor(doc: SplineDocument, opts: SplineOptions = {}) {
    super();
    this.doc = doc;
    this.lineWidth = opts.lineWidth ?? 2;
    this.cache = opts.cache ?? true;
    this.defaultColor = opts.defaultColor ?? '#e2e8f0';
    this.bounds = this.computeBounds();
    this.width = this.bounds.width;
    this.height = this.bounds.height;
  }

  private computeBounds(): Bounds {
    if (this.doc.bounding_box) {
      const [minX, minY, maxX, maxY] = this.doc.bounding_box;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const eq of this.doc.equations) {
      for (const seg of eq.data) {
        const b = polySegmentToBezier(seg);
        for (const [x, y] of [
          [b.x0, b.y0],
          [b.cp1x, b.cp1y],
          [b.cp2x, b.cp2y],
          [b.x3, b.y3],
        ]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** @inheritdoc */
  public getBounds(): Bounds {
    return this.bounds;
  }

  /**
   * AABB hit-test against the document bounds in world space.
   *
   * Curve-accurate hit-testing can be layered on later via {@link hitTestCurve};
   * this method already calls it as a refinement when it is overridden.
   */
  public isPointInside(globalX: number, globalY: number): boolean {
    const pos = this.getGlobalPosition();
    const lx = globalX - pos.x;
    const ly = globalY - pos.y;
    const inAabb =
      lx >= this.bounds.x &&
      lx <= this.bounds.x + this.bounds.width &&
      ly >= this.bounds.y &&
      ly <= this.bounds.y + this.bounds.height;
    if (!inAabb) return false;
    const refined = this.hitTestCurve(lx, ly);
    return refined === null ? true : refined;
  }

  /**
   * Optional curve-accurate refinement of {@link isPointInside}.
   *
   * Returns `null` by default (AABB result is used as-is). Override to test the
   * local point against the actual curves (e.g. distance-to-bezier within a
   * tolerance) for precise picking.
   *
   * @param _localX - X in the entity's local space.
   * @param _localY - Y in the entity's local space.
   * @returns `true`/`false` to refine, or `null` to keep the AABB result.
   */
  protected hitTestCurve(_localX: number, _localY: number): boolean | null {
    return null;
  }

  private resolveColor(color: SplineColor, r: IRenderer): string | unknown {
    if (color === null) return this.defaultColor;
    if (Array.isArray(color)) return rgbToCss(color);
    const w = this.bounds.width || 1;
    const h = this.bounds.height || 1;
    return r.createLinearGradient(
      color.start_pos[0] * w + this.bounds.x,
      color.start_pos[1] * h + this.bounds.y,
      color.end_pos[0] * w + this.bounds.x,
      color.end_pos[1] * h + this.bounds.y,
      color.stops.map(([stop, rgb]) => ({
        stop: Math.max(0, Math.min(1, stop)),
        color: rgbToCss(rgb),
      })),
    );
  }

  private strokeEquations(r: IRenderer): void {
    for (const eq of this.doc.equations) {
      const stroke = this.resolveColor(eq.color_rgb, r);
      r.beginPath();
      for (const seg of eq.data) {
        const b = polySegmentToBezier(seg);
        r.moveTo(b.x0, b.y0);
        r.bezierCurveTo(b.cp1x, b.cp1y, b.cp2x, b.cp2y, b.x3, b.y3);
      }
      r.stroke(stroke, this.lineWidth);
    }
  }

  /** Bake all equations into an OffscreenCanvas once (when available). */
  private bake(): void {
    this.baked = true;
    const pad = this.lineWidth + 2;
    const w = Math.max(1, Math.ceil(this.bounds.width) + pad * 2);
    const h = Math.max(1, Math.ceil(this.bounds.height) + pad * 2);
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else {
      return; // no DOM: caller falls back to per-frame strokes
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return;
    ctx.translate(pad - this.bounds.x, pad - this.bounds.y);
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const eq of this.doc.equations) {
      ctx.strokeStyle =
        eq.color_rgb === null
          ? this.defaultColor
          : Array.isArray(eq.color_rgb)
            ? rgbToCss(eq.color_rgb)
            : this.defaultColor; // gradients use the per-frame path
      ctx.beginPath();
      for (const seg of eq.data) {
        const b = polySegmentToBezier(seg);
        ctx.moveTo(b.x0, b.y0);
        ctx.bezierCurveTo(b.cp1x, b.cp1y, b.cp2x, b.cp2y, b.x3, b.y3);
      }
      ctx.stroke();
    }
    this.offscreen = canvas;
  }

  /** @inheritdoc */
  public render(r: IRenderer): void {
    if (this.cache) {
      if (!this.baked) this.bake();
      if (this.offscreen) {
        const pad = this.lineWidth + 2;
        r.drawImage(
          this.offscreen as CanvasImageSource,
          this.bounds.x - pad,
          this.bounds.y - pad,
          (this.offscreen as { width: number }).width,
          (this.offscreen as { height: number }).height,
        );
        return;
      }
    }
    this.strokeEquations(r);
  }
}

/**
 * Fetch and parse a vectomancy `Spline` JSON document (browser only).
 *
 * @param url - URL of the `.json` spline document.
 * @returns The parsed {@link SplineDocument}.
 */
export async function loadSpline(url: string): Promise<SplineDocument> {
  const res = await fetch(url);
  return (await res.json()) as SplineDocument;
}
