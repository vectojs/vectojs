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

/** Unified source for {@link Image} — url, blob or a pre-decoded bitmap. */
export type ImageSource =
  | string
  | { kind: 'url'; url: string }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bitmap'; bitmap: ImageBitmap };

/** Normalized variant of {@link ImageSource} with `string` expanded. */
export type NormalizedImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bitmap'; bitmap: ImageBitmap };

/** Decoupled decode result consumed by `renderBitmap`. */
export interface DecodedImage {
  /** Backing source for `IRenderer.drawImage`. */
  source: CanvasImageSource;
  /** Intrinsic width in pixels. */
  width: number;
  /** Intrinsic height in pixels. */
  height: number;
  /** Release `ImageBitmap` / revoke `blob:` URL when the image is replaced or destroyed. */
  dispose?: () => void;
}

/** Expand `string` shorthand to `{kind:'url'}`. */
export function normalizeSource(src: ImageSource): NormalizedImageSource {
  if (typeof src === 'string') return { kind: 'url', url: src };
  return src;
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
 * Supports {@link ImageSource}: a plain string is `{kind:'url'}` shorthand,
 * `{kind:'blob'}` decodes via `createImageBitmap`, and `{kind:'bitmap'}` is
 * used directly. Decode is decoupled as {@link DecodedImage} so `renderBitmap`
 * depends only on `decoded.width/height` + `decoded.source`.
 *
 * @example new Image('/logo.png', { width: 120, height: 40, alt: 'Vecto' });
 * @example new Image({ kind: 'blob', blob }, { width: 64, height: 64 });
 * @example new Image({ kind: 'bitmap', bitmap }, { width: 64, height: 64 });
 */
export class Image extends UIComponent {
  public alt: string;
  public placeholder: string;
  public radius: number;
  public fit: ImageFit;
  public focalPoint: ImageFocalPoint;
  private _source: ImageSource;
  private _normalized: NormalizedImageSource;
  private decoded: DecodedImage | null = null;
  private loaded = false;
  /** Legacy alias kept for `as unknown as {bitmap}` test injections. */
  private bitmap: HTMLImageElement | null = null;
  private _onLoad?: () => void;
  private _objectURL: string | null = null;
  private _gen = 0;

  constructor(source: ImageSource, opts: ImageOptions) {
    super();
    this._source = source;
    this._normalized = normalizeSource(source);
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
    this._onLoad = opts.onLoad;
    this.startDecode(this._normalized);
  }

  /** Compat: `string` url or `''` for non-url sources. */
  public get src(): string {
    return this._normalized.kind === 'url' ? this._normalized.url : '';
  }

  public set src(value: string) {
    this.setSource(value);
  }

  /** Original source as supplied to the constructor / `setSource`. */
  public get imageSource(): ImageSource {
    return this._source;
  }

  /** Decoded payload, or `null` while loading. */
  public get decodedImage(): DecodedImage | null {
    return this.decoded;
  }

  /** Replace the source and re-decode. */
  public setSource(source: ImageSource): void {
    this._source = source;
    this._normalized = normalizeSource(source);
    this.startDecode(this._normalized);
  }

  private startDecode(normalized: NormalizedImageSource): void {
    const gen = ++this._gen;
    this.loaded = false;
    if (this.decoded?.dispose) {
      try {
        this.decoded.dispose();
      } catch {}
    }
    this.decoded = null;
    this.bitmap = null;
    if (this._objectURL) {
      try {
        URL.revokeObjectURL(this._objectURL);
      } catch {}
      this._objectURL = null;
    }

    const onDecoded = (decoded: DecodedImage): void => {
      if (gen !== this._gen) {
        try {
          decoded.dispose?.();
        } catch {}
        return;
      }
      this.decoded = decoded;
      this.loaded = true;
      if (typeof HTMLImageElement !== 'undefined' && decoded.source instanceof HTMLImageElement) {
        this.bitmap = decoded.source as HTMLImageElement;
      }
      this._onLoad?.();
      if (!this._onLoad) this.scene?.markDirty();
    };

    const onError = (): void => {
      if (gen !== this._gen) return;
      // stay on placeholder
    };

    switch (normalized.kind) {
      case 'bitmap': {
        // External ImageBitmap ownership stays with caller — do not close on dispose.
        // Only internally created bitmaps (blob via createImageBitmap) own their disposal.
        const bmp = normalized.bitmap;
        const decoded: DecodedImage = {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
        };
        onDecoded(decoded);
        break;
      }
      case 'blob': {
        const blob = normalized.blob;
        const gCreateImageBitmap = globalThis as unknown as {
          createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
        };
        if (typeof gCreateImageBitmap.createImageBitmap === 'function') {
          gCreateImageBitmap
            .createImageBitmap(blob)
            .then((bmp) => {
              const decoded: DecodedImage = {
                source: bmp,
                width: bmp.width,
                height: bmp.height,
                dispose: () => {
                  try {
                    bmp.close();
                  } catch {}
                },
              };
              onDecoded(decoded);
            })
            .catch(() => {
              this.decodeBlobViaImage(blob, gen, onDecoded, onError);
            });
        } else {
          this.decodeBlobViaImage(blob, gen, onDecoded, onError);
        }
        break;
      }
      case 'url': {
        if (typeof globalThis.Image === 'undefined') {
          onError();
          break;
        }
        const img = new globalThis.Image();
        this.bitmap = img;
        img.onload = () => {
          const decoded: DecodedImage = {
            source: img,
            width:
              (img as HTMLImageElement).naturalWidth || (img as unknown as { width: number }).width,
            height:
              (img as HTMLImageElement).naturalHeight ||
              (img as unknown as { height: number }).height,
          };
          onDecoded(decoded);
        };
        img.onerror = () => {
          if (gen === this._gen) this.bitmap = null;
          onError();
        };
        img.src = normalized.url;
        break;
      }
    }
  }

  private decodeBlobViaImage(
    blob: Blob,
    gen: number,
    onDecoded: (d: DecodedImage) => void,
    onError: () => void,
  ): void {
    if (
      typeof globalThis.Image === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      onError();
      return;
    }
    const url = URL.createObjectURL(blob);
    if (gen === this._gen) this._objectURL = url;
    const img = new globalThis.Image();
    if (gen === this._gen) this.bitmap = img;
    img.onload = () => {
      if (gen !== this._gen) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
        return;
      }
      const decoded: DecodedImage = {
        source: img,
        width:
          (img as HTMLImageElement).naturalWidth || (img as unknown as { width: number }).width,
        height:
          (img as HTMLImageElement).naturalHeight || (img as unknown as { height: number }).height,
        dispose: () => {
          try {
            URL.revokeObjectURL(url);
          } catch {}
          if (this._objectURL === url) this._objectURL = null;
        },
      };
      onDecoded(decoded);
    };
    img.onerror = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
      if (gen === this._gen) {
        if (this._objectURL === url) this._objectURL = null;
        if (this.bitmap === img) this.bitmap = null;
      }
      onError();
    };
    img.src = url;
  }

  public getA11yAttributes(): A11yAttributes {
    const src = this._normalized.kind === 'url' ? this._normalized.url : undefined;
    return { tag: 'img', src, alt: this.alt, label: this.alt || undefined };
  }

  public override destroy(): void {
    if (this.decoded?.dispose) {
      try {
        this.decoded.dispose();
      } catch {}
    }
    this.decoded = null;
    this.loaded = false;
    this.bitmap = null;
    if (this._objectURL) {
      try {
        URL.revokeObjectURL(this._objectURL);
      } catch {}
      this._objectURL = null;
    }
    this._gen++;
    super.destroy();
  }

  public render(r: IRenderer): void {
    if (this.loaded && this.decoded) {
      this.renderBitmap(r, this.decoded);
      return;
    }
    // Legacy test injection path: `loaded=true` + `bitmap={naturalWidth, naturalHeight}`.
    const legacy = this.bitmap as unknown as
      | (HTMLImageElement & {
          naturalWidth?: number;
          naturalHeight?: number;
          width?: number;
          height?: number;
        })
      | null;
    if (this.loaded && legacy) {
      const srcW = legacy.naturalWidth ?? legacy.width ?? 0;
      const srcH = legacy.naturalHeight ?? legacy.height ?? 0;
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
      r.drawImage(
        legacy as unknown as CanvasImageSource,
        placement.dx,
        placement.dy,
        placement.dw,
        placement.dh,
      );
      if (needsClip) r.restore();
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
  private renderBitmap(r: IRenderer, decoded: DecodedImage): void {
    const placement = computeImageFit(
      decoded.width,
      decoded.height,
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
    r.drawImage(decoded.source, placement.dx, placement.dy, placement.dw, placement.dh);
    if (needsClip) r.restore();
  }
}
