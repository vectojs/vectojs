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
  type: 'Spline' | 'Polyline';
  equations?: SplineEquation[];
  paths?: { color_rgb: SplineColor; data: { x: number; y: number }[] }[];
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
  /**
   * Hit-test strategy:
   * - `'curve'` (default): precise — a point hits only within `lineWidth/2 +
   *   hitTolerance` of an actual curve.
   * - `'aabb'`: coarse — anywhere in the bounding box hits.
   */
  hitTest?: 'curve' | 'aabb';
  /** Extra pick padding (local units) added to `lineWidth/2` in `'curve'` mode. Default `0`. */
  hitTolerance?: number;
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

/** Samples per Bézier segment when flattening for hit-testing. */
const HIT_SAMPLES = 16;

/**
 * Flatten a cubic Bézier into a polyline of `samples + 1` points, returned as a
 * flat `[x0,y0,x1,y1,…]` Float32Array.
 */
function flattenBezier(b: BezierControlPoints, samples: number): Float32Array {
  const pts = new Float32Array((samples + 1) * 2);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const c1 = 3 * mt * mt * t;
    const c2 = 3 * mt * t * t;
    const d = t * t * t;
    pts[i * 2] = a * b.x0 + c1 * b.cp1x + c2 * b.cp2x + d * b.x3;
    pts[i * 2 + 1] = a * b.y0 + c1 * b.cp1y + c2 * b.cp2y + d * b.y3;
  }
  return pts;
}

/** Squared distance from point `(px,py)` to the segment `(x1,y1)-(x2,y2)`. */
function distSqToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
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
  public hitTolerance: number;
  private cache: boolean;
  private hitMode: 'curve' | 'aabb';
  private bounds: Bounds;
  private offscreen: HTMLCanvasElement | OffscreenCanvas | null = null;
  private baked = false;
  /** Logical (CSS-pixel) size of the baked bitmap — the blit destination size. */
  private bakedWidth = 0;
  private bakedHeight = 0;
  /** Gradient strokes can't be baked to a solid-color bitmap; they render per-frame. */
  private readonly containsGradient: boolean;
  /** Lazily-flattened polylines (one Float32Array of [x,y,...] per segment) for hit-testing. */
  private polylines: Float32Array[] | null = null;

  /**
   * When `true`, the renderer draws a rounded-rect outline of the entity's
   * local bounds after painting the curves. Useful for drag feedback and
   * debugging hit areas. Defaults to `false`.
   */
  public showBounds: boolean = false;

  constructor(doc: SplineDocument, opts: SplineOptions = {}) {
    super();
    this.doc = doc;
    this.lineWidth = opts.lineWidth ?? 2;
    this.cache = opts.cache ?? true;
    this.defaultColor = opts.defaultColor ?? '#e2e8f0';
    this.hitMode = opts.hitTest ?? 'curve';
    this.hitTolerance = opts.hitTolerance ?? 0;
    this.bounds = this.computeBounds();
    this.width = this.bounds.width;
    this.height = this.bounds.height;
    const isGradient = (c: SplineColor) => c !== null && !Array.isArray(c);
    this.containsGradient =
      (this.doc.equations?.some((eq) => isGradient(eq.color_rgb)) ?? false) ||
      (this.doc.paths?.some((p) => isGradient(p.color_rgb)) ?? false);
    // Enable a11y shadow layer by default so pointer events are dispatched.
    this.interactive = true;
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
    if (this.doc.equations) {
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
    }
    if (this.doc.paths) {
      for (const path of this.doc.paths) {
        for (const pt of path.data) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
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
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    const { x: lx, y: ly } = local;
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
   * Curve-accurate refinement of {@link isPointInside}: hit only when the local
   * point lies within `lineWidth/2 + hitTolerance` of an actual curve.
   *
   * Returns `null` in `hitTest: 'aabb'` mode (keep the bounding-box result).
   * Curves are flattened to polylines once and cached. Override for custom logic.
   *
   * @param localX - X in the entity's local space.
   * @param localY - Y in the entity's local space.
   * @returns `true`/`false`, or `null` to keep the AABB result.
   */
  protected hitTestCurve(localX: number, localY: number): boolean | null {
    if (this.hitMode === 'aabb') return null;
    const tol = this.lineWidth / 2 + this.hitTolerance;
    const tol2 = tol * tol;
    const polylines = this.getPolylines();
    for (const pts of polylines) {
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (distSqToSegment(localX, localY, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= tol2) {
          return true;
        }
      }
    }
    return false;
  }

  /** Flatten every Bézier segment into a sampled polyline once, then cache. */
  private getPolylines(): Float32Array[] {
    if (this.polylines) return this.polylines;
    const out: Float32Array[] = [];
    if (this.doc.equations) {
      for (const eq of this.doc.equations) {
        for (const seg of eq.data) {
          out.push(flattenBezier(polySegmentToBezier(seg), HIT_SAMPLES));
        }
      }
    }
    if (this.doc.paths) {
      for (const path of this.doc.paths) {
        const pts = new Float32Array(path.data.length * 2);
        for (let i = 0; i < path.data.length; i++) {
          pts[i * 2] = path.data[i].x;
          pts[i * 2 + 1] = path.data[i].y;
        }
        out.push(pts);
      }
    }
    this.polylines = out;
    return out;
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
    if (this.doc.equations) {
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
    if (this.doc.paths) {
      for (const path of this.doc.paths) {
        const stroke = this.resolveColor(path.color_rgb, r);
        r.beginPath();
        if (path.data.length > 0) {
          r.moveTo(path.data[0].x, path.data[0].y);
          for (let i = 1; i < path.data.length; i++) {
            r.lineTo(path.data[i].x, path.data[i].y);
          }
        }
        r.stroke(stroke, this.lineWidth);
      }
    }
  }

  /** Bake all equations into an OffscreenCanvas once (when available). */
  private bake(): void {
    this.baked = true;
    const pad = this.lineWidth + 2;
    const w = Math.max(1, Math.ceil(this.bounds.width) + pad * 2);
    const h = Math.max(1, Math.ceil(this.bounds.height) + pad * 2);
    this.bakedWidth = w;
    this.bakedHeight = h;
    // Bake at devicePixelRatio: the main canvas is DPR-scaled, so a 1x bitmap
    // would be upscaled (blurry) on HiDPI displays. Blitting uses w×h (logical).
    const dpr =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio || 1
        : 1;
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w * dpr, h * dpr);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    } else {
      return; // no DOM: caller falls back to per-frame strokes
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.translate(pad - this.bounds.x, pad - this.bounds.y);
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.doc.equations) {
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
    }
    if (this.doc.paths) {
      for (const path of this.doc.paths) {
        ctx.strokeStyle =
          path.color_rgb === null
            ? this.defaultColor
            : Array.isArray(path.color_rgb)
              ? rgbToCss(path.color_rgb)
              : this.defaultColor;
        ctx.beginPath();
        if (path.data.length > 0) {
          ctx.moveTo(path.data[0].x, path.data[0].y);
          for (let i = 1; i < path.data.length; i++) {
            ctx.lineTo(path.data[i].x, path.data[i].y);
          }
        }
        ctx.stroke();
      }
    }
    this.offscreen = canvas;
  }

  public render(r: IRenderer): void {
    let rendered = false;
    if (this.cache && !this.containsGradient) {
      if (!this.baked) this.bake();
      if (this.offscreen) {
        const pad = this.lineWidth + 2;
        r.drawImage(
          this.offscreen as CanvasImageSource,
          this.bounds.x - pad,
          this.bounds.y - pad,
          // Logical size, not the (DPR-scaled) bitmap size.
          this.bakedWidth,
          this.bakedHeight,
        );
        rendered = true;
      }
    }
    if (!rendered) {
      this.strokeEquations(r);
    }

    if (this.showBounds) {
      r.beginPath();
      r.roundRect(this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height, 4);
      r.stroke('rgba(0, 150, 255, 0.8)', 2);
    }
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
