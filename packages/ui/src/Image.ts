import { A11yAttributes, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';

/** How a loaded bitmap is mapped into the requested box. */
export type ImageFit = 'fill' | 'cover' | 'contain';

/** Normalized focal point for `'cover'` cropping, each axis in `[0, 1]`. */
export interface ImageFocalPoint {
  /** Horizontal focus: `0` = left edge, `1` = right edge. Default `0.5`. */
  x: number;
  /** Vertical focus: `0` = top edge, `1` = bottom edge. Default `0.5`. */
  y: number;
}

/** Destination geometry produced by {@link computeImageFit}. */
export interface ImagePlacement {
  /** Destination left edge. */
  dx: number;
  /** Destination top edge. */
  dy: number;
  /** Destination width. */
  dw: number;
  /** Destination height. */
  dh: number;
}

const DEFAULT_FOCAL: ImageFocalPoint = { x: 0.5, y: 0.5 };

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Collapse `-0` to `0` so offsets never leak a signed zero into callers. */
function normZero(v: number): number {
  return v === 0 ? 0 : v;
}

/**
 * Map a source bitmap into a destination box under an image-fit policy.
 *
 * `'fill'` stretches to the box (legacy behavior). `'cover'` preserves the
 * source aspect ratio, fills the box, and crops the overflow around the focal
 * point (a destination offset that the caller clips). `'contain'` preserves the
 * aspect ratio and centers the whole bitmap inside the box.
 *
 * A source with an unknown size (`srcW <= 0` or `srcH <= 0`) degenerates to
 * `'fill'`, since no aspect ratio is available to preserve.
 *
 * @param srcW - Source intrinsic width in pixels.
 * @param srcH - Source intrinsic height in pixels.
 * @param dstW - Destination box width in pixels.
 * @param dstH - Destination box height in pixels.
 * @param fit - The fit policy.
 * @param focal - Normalized focal point for `'cover'`; values outside `[0, 1]`
 *   are clamped. Only `'cover'` consults it.
 */
export function computeImageFit(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  fit: ImageFit,
  focal: ImageFocalPoint = DEFAULT_FOCAL,
): ImagePlacement {
  if (fit === 'fill' || srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  }
  const scale =
    fit === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const dx = normZero(fit === 'cover' ? (dstW - dw) * clamp01(focal.x) : (dstW - dw) / 2);
  const dy = normZero(fit === 'cover' ? (dstH - dh) * clamp01(focal.y) : (dstH - dh) / 2);
  return { dx, dy, dw, dh };
}

/** Construction options for {@link Image}. */
export interface ImageOptions {
  /** Box width in pixels. Required (the canvas needs a known box for layout/culling). */
  width: number;
  /** Box height in pixels. */
  height: number;
  /**
   * How the loaded bitmap maps into the box. `'fill'` (default) stretches to
   * the box (legacy behavior); `'cover'` fills the box preserving aspect ratio
   * and crops overflow around {@link focalPoint}; `'contain'` fits the whole
   * bitmap inside the box preserving aspect ratio.
   */
  fit?: ImageFit;
  /**
   * Normalized `0..1` focal point used by `'cover'` cropping. Values outside
   * `[0, 1]` are clamped at the API boundary. Default `{ x: 0.5, y: 0.5 }`.
   */
  focalPoint?: ImageFocalPoint;
  /** Alternative text for the `<img alt>` shadow node and accessible name. */
  alt?: string;
  /** Placeholder fill shown until the bitmap loads. Default `'#1e293b'`. */
  placeholder?: string;
  /** Corner radius in pixels, applied to both the placeholder and the loaded bitmap. Default `0`. */
  radius?: number;
  /** Invoked once the image finishes loading (e.g. to `scene.markDirty()`). */
  onLoad?: () => void;
}

/**
 * An image rendered to canvas via `drawImage`, projecting a real `<img src alt>`
 * shadow node so it stays crawlable/accessible.
 *
 * Loading is async: a placeholder box is drawn until the bitmap is ready. In
 * `onDemand` scenes, pass `onLoad: () => scene.markDirty()` to repaint on load.
 *
 * @example new Image('/logo.png', { width: 120, height: 40, alt: 'Vecto' });
 */
export class Image extends UIComponent {
  public src: string;
  public alt: string;
  public placeholder: string;
  public radius: number;
  public fit: ImageFit;
  public focalPoint: ImageFocalPoint;
  private bitmap: HTMLImageElement | null = null;
  private loaded = false;

  constructor(src: string, opts: ImageOptions) {
    super();
    this.src = src;
    this.alt = opts.alt ?? '';
    this.placeholder = opts.placeholder ?? '#1e293b';
    this.radius = opts.radius ?? 0;
    this.fit = opts.fit ?? 'fill';
    this.focalPoint = {
      x: clamp01(opts.focalPoint?.x ?? DEFAULT_FOCAL.x),
      y: clamp01(opts.focalPoint?.y ?? DEFAULT_FOCAL.y),
    };
    this.width = opts.width;
    this.height = opts.height;
    this.interactive = true; // project the <img> shadow node

    if (typeof globalThis.Image !== 'undefined') {
      const bmp = new globalThis.Image();
      bmp.onload = () => {
        this.loaded = true;
        opts.onLoad?.();
      };
      bmp.src = src;
      this.bitmap = bmp;
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return { tag: 'img', src: this.src, alt: this.alt, label: this.alt || undefined };
  }

  public render(r: IRenderer): void {
    if (this.loaded && this.bitmap) {
      this.renderBitmap(r, this.bitmap);
      return;
    }
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.placeholder);
  }

  /**
   * Draw the loaded bitmap under the active fit policy, clipping to the box's
   * rounded silhouette whenever `radius > 0` or `'cover'` overflows the box.
   */
  private renderBitmap(r: IRenderer, bitmap: HTMLImageElement): void {
    const srcW = bitmap.naturalWidth || bitmap.width;
    const srcH = bitmap.naturalHeight || bitmap.height;
    const placement = computeImageFit(
      srcW,
      srcH,
      this.width,
      this.height,
      this.fit,
      this.focalPoint,
    );

    const needsClip = this.radius > 0 || this.fit === 'cover';
    if (needsClip) {
      r.save();
      if (this.radius > 0) {
        r.clip(0, 0, this.width, this.height, this.radius);
      } else {
        r.clip(0, 0, this.width, this.height);
      }
    }
    r.drawImage(bitmap, placement.dx, placement.dy, placement.dw, placement.dh);
    if (needsClip) r.restore();
  }
}
