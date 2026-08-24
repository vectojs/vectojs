import { Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function isSvgWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Index of the `>` that actually closes the open tag, skipping quoted
 * attribute values. A bare `indexOf('>')` truncates the tag at the first
 * `>` inside a value (`<svg title="a>b" …>`), so every later attribute —
 * including `viewBox` — goes unseen by the regex-free attribute scan.
 */
function findSvgTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Width/height with a percentage unit cannot be resolved without a viewport to
 * resolve against, so callers treat it as absent and let `viewBox` decide.
 */
function isPercentDimension(value: string): boolean {
  return value.trim().endsWith('%');
}

/** ViewBox is usable only when it holds exactly four finite numbers. */
function viewBoxDimensions(value: string): { width: number; height: number } | null {
  const parts = value.split(/[\s,]+/).map(parseFloat);
  return parts.length === 4 && parts.every(Number.isFinite)
    ? { width: parts[2], height: parts[3] }
    : null;
}

function readSvgAttribute(source: string, name: string): string | null {
  const lowerSource = source.toLowerCase();
  const svgStart = lowerSource.indexOf('<svg');
  if (svgStart < 0) return null;

  const tagEnd = findSvgTagEnd(source, svgStart + 4);
  if (tagEnd < 0) return null;

  const tag = source.slice(svgStart + 4, tagEnd);
  const lowerTag = tag.toLowerCase();
  const lowerName = name.toLowerCase();

  for (let i = 0; i < tag.length; i++) {
    const before = i === 0 ? ' ' : tag[i - 1];
    if (!isSvgWhitespace(before)) continue;
    if (!lowerTag.startsWith(lowerName, i)) continue;

    let cursor = i + lowerName.length;
    while (cursor < tag.length && isSvgWhitespace(tag[cursor])) cursor++;
    if (tag[cursor] !== '=') continue;
    cursor++;
    while (cursor < tag.length && isSvgWhitespace(tag[cursor])) cursor++;

    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const valueStart = cursor + 1;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) return null;
    return tag.slice(valueStart, valueEnd);
  }

  return null;
}

export class SVGEntity extends Entity {
  /**
   * Stroke colour of the fallback marker drawn when the source cannot be
   * rasterized. Set to `'transparent'` to opt out and keep the box empty.
   * Default `'rgba(248,113,113,0.9)'`.
   */
  public fallbackStroke: string = 'rgba(248,113,113,0.9)';
  /** Fill behind the fallback marker. Default `'rgba(248,113,113,0.12)'`. */
  public fallbackFill: string = 'rgba(248,113,113,0.12)';

  private svgSource: string = '';
  private imageBitmap: ImageBitmap | null = null;
  private imageElement: HTMLImageElement | null = null;
  private blobURL: string | null = null;
  private currentImg: HTMLImageElement | null = null;
  private lodTimeout: any = null;
  private rasterFailed: boolean = false;

  private cachedDoc: Document | null = null;

  private baseWidth: number = 100;
  private baseHeight: number = 100;
  private lastRasterizedScale: number = 1;
  private targetScale: number = 1;

  constructor(svgSource: string, id?: string) {
    super(id);
    this.setSVGSource(svgSource);
  }

  public setSVGSource(svgSource: string): void {
    if (this.svgSource === svgSource) return;
    this.svgSource = svgSource;
    this.cachedDoc = null;

    this.parseSVGDimensions();
    this.triggerRasterization(this.lastRasterizedScale);
  }

  private parseSVGDimensions(): void {
    let width = 100;
    let height = 100;

    if (typeof window !== 'undefined' && typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(this.svgSource, 'image/svg+xml');
        const parserError = doc.querySelector('parsererror');
        if (parserError) {
          console.error('SVG Parsing error:', parserError.textContent);
          this.rasterFailed = true;
        } else {
          this.cachedDoc = doc;
          const svgEl = doc.documentElement;
          const wAttr = svgEl.getAttribute('width');
          const hAttr = svgEl.getAttribute('height');
          const vbAttr = svgEl.getAttribute('viewBox');

          if (wAttr && hAttr && !isPercentDimension(wAttr) && !isPercentDimension(hAttr)) {
            width = parseFloat(wAttr) || 100;
            height = parseFloat(hAttr) || 100;
          } else if (vbAttr) {
            // A non-finite part (`viewBox="0 0 100 none"`, truncated markup)
            // must not flow NaN into `Math.max(1, Math.round(NaN * scale))`
            // during rasterization; fall through to the defaults instead.
            const dims = viewBoxDimensions(vbAttr);
            if (dims) {
              width = dims.width;
              height = dims.height;
            }
          }
        }
      } catch (e) {
        console.error('Failed parsing SVG via DOMParser, falling back to attribute scan:', e);
        this.rasterFailed = true;
      }
    } else {
      const wAttr = readSvgAttribute(this.svgSource, 'width');
      const hAttr = readSvgAttribute(this.svgSource, 'height');
      const vbAttr = readSvgAttribute(this.svgSource, 'viewBox');

      if (wAttr && hAttr && !isPercentDimension(wAttr) && !isPercentDimension(hAttr)) {
        width = parseFloat(wAttr) || 100;
        height = parseFloat(hAttr) || 100;
      } else if (vbAttr) {
        const dims = viewBoxDimensions(vbAttr);
        if (dims) {
          width = dims.width;
          height = dims.height;
        }
      }
    }

    this.baseWidth = width;
    this.baseHeight = height;
    this.width = width;
    this.height = height;
  }

  private triggerRasterization(scale: number): void {
    if (typeof window === 'undefined' || typeof Blob === 'undefined') return;

    // A fresh attempt starts optimistic; the handlers below re-raise the flag.
    this.rasterFailed = false;

    if (this.currentImg) {
      this.currentImg.onload = null;
      this.currentImg.onerror = null;
      this.currentImg = null;
    }

    if (this.blobURL) {
      URL.revokeObjectURL(this.blobURL);
      this.blobURL = null;
    }

    let processedSource = this.svgSource;
    try {
      let doc = this.cachedDoc;
      if (!doc) {
        const parser = new DOMParser();
        doc = parser.parseFromString(this.svgSource, 'image/svg+xml');
        this.cachedDoc = doc;
      }

      const parserError = doc.querySelector('parsererror');
      if (parserError) {
        console.error(
          'SVG Parsing validation error in triggerRasterization:',
          parserError.textContent,
        );
        this.rasterFailed = true;
      } else {
        const clonedDoc = doc.cloneNode(true) as Document;
        const svgEl = clonedDoc.documentElement;
        if (svgEl.tagName.toLowerCase() === 'svg') {
          const targetWidth = Math.max(1, Math.round(this.baseWidth * scale));
          const targetHeight = Math.max(1, Math.round(this.baseHeight * scale));

          svgEl.setAttribute('width', `${targetWidth}`);
          svgEl.setAttribute('height', `${targetHeight}`);
          if (!svgEl.hasAttribute('viewBox')) {
            svgEl.setAttribute('viewBox', `0 0 ${this.baseWidth} ${this.baseHeight}`);
          }

          const serializer = new XMLSerializer();
          processedSource = serializer.serializeToString(clonedDoc);

          // Markup written without `xmlns` parses as well-formed XML and yields
          // correct dimensions, but `namespaceURI` is null and the browser's
          // IMAGE DECODER — not the XML parser — then rejects the blob, which
          // used to leave a permanently blank box. Declaring the namespace makes
          // the real artwork rasterize instead.
          //
          // This must be done on the SERIALIZED TEXT, not via the DOM. Measured
          // across both engines: `setAttribute('xmlns', …)` works in Chromium but
          // Firefox silently ignores it and serializes byte-identical markup, so
          // the blob still fails to decode there. `setAttributeNS` with the xmlns
          // namespace is a no-op in both. Injecting after serialization is the
          // only form that repairs it on Chromium *and* Firefox.
          if (svgEl.namespaceURI === null && !/\sxmlns\s*=/.test(processedSource)) {
            processedSource = processedSource.replace(/<svg/i, `<svg xmlns="${SVG_NAMESPACE}"`);
          }
        }
      }
    } catch (e) {
      console.error('Failed to apply LOD scaling to SVG XML:', e);
      this.rasterFailed = true;
    }

    const blob = new Blob([processedSource], { type: 'image/svg+xml;charset=utf-8' });
    this.blobURL = URL.createObjectURL(blob);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    this.currentImg = img;

    img.onload = () => {
      if (this.currentImg !== img) return;
      this.imageElement = img;

      if (typeof createImageBitmap === 'undefined') {
        this.currentImg = null;
        if (this.scene) this.scene.markDirty();
        return;
      }

      createImageBitmap(img)
        .then((bitmap) => {
          if (this.currentImg !== img) {
            bitmap.close();
            return;
          }
          if (this.imageBitmap) {
            this.imageBitmap.close();
          }
          this.imageBitmap = bitmap;
          this.currentImg = null;
          if (this.scene) this.scene.markDirty();
        })
        .catch((e) => {
          console.error('Failed to create ImageBitmap from SVG:', e);
          this.currentImg = null;
          // `imageElement` is already set by the onload above, so this path
          // still paints; only flag failure when there is nothing to draw.
          if (!this.imageElement) this.rasterFailed = true;
          if (this.scene) this.scene.markDirty();
        });
    };
    img.onerror = (e) => {
      if (this.currentImg !== img) return;
      console.error('Failed to load SVG Image element:', e);
      this.currentImg = null;
      this.rasterFailed = true;
      // Without this an onDemand scene never repaints, so the fallback marker
      // would never reach the canvas.
      if (this.scene) this.scene.markDirty();
    };
    img.src = this.blobURL;
  }

  /**
   * Whether the source genuinely rasterized to a bitmap.
   *
   * Distinguishes "drew the real artwork" from "drew the fallback marker",
   * which pixel counts alone cannot tell apart — both are non-blank.
   */
  public hasRasterBitmap(): boolean {
    return this.imageBitmap !== null;
  }

  /**
   * Whether rasterization failed, so {@link render} draws the fallback marker.
   *
   * `false` while a raster is still in flight; only a settled failure sets it.
   */
  public hasRasterFailed(): boolean {
    return this.rasterFailed;
  }

  isPointInside(globalX: number, globalY: number): boolean {
    const local = this.worldToLocal(globalX, globalY);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }

  render(r: IRenderer): void {
    const svgRenderer = r as IRenderer & {
      drawSVG?: (source: string, dx: number, dy: number, dw: number, dh: number) => void;
    };
    if (typeof svgRenderer.drawSVG === 'function') {
      svgRenderer.drawSVG(this.svgSource, 0, 0, this.width, this.height);
      return;
    }

    const scale = this.getWorldScale();
    const currentScale = Math.max(0.1, Math.max(scale.x, scale.y));

    if (Math.abs(currentScale - this.lastRasterizedScale) / this.lastRasterizedScale > 0.2) {
      this.targetScale = currentScale;
      if (this.lodTimeout) clearTimeout(this.lodTimeout);
      this.lodTimeout = setTimeout(() => {
        this.triggerRasterization(this.targetScale);
        this.lastRasterizedScale = this.targetScale;
        this.lodTimeout = null;
      }, 200);
    }

    if (this.imageBitmap) {
      r.drawImage(this.imageBitmap, 0, 0, this.width, this.height);
      return;
    }
    if (this.imageElement) {
      r.drawImage(this.imageElement, 0, 0, this.width, this.height);
      return;
    }
    // Nothing to blit. If rasterization FAILED (as opposed to merely being
    // in flight) draw a marker rather than leaving a blank box: a silent gap
    // is indistinguishable from correct output, so the defect reaches
    // production unnoticed. Mirrors SVGRenderer.drawImage, which already
    // draws a visible rect when it has no usable href.
    if (this.rasterFailed) this.drawFallback(r);
  }

  /** Box outline plus a diagonal cross — the conventional "broken image" mark. */
  private drawFallback(r: IRenderer): void {
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    r.beginPath();
    r.roundRect(0, 0, w, h, 0);
    r.fill(this.fallbackFill);

    r.beginPath();
    r.roundRect(0, 0, w, h, 0);
    r.stroke(this.fallbackStroke, 1);

    const inset = Math.min(w, h) * 0.2;
    r.beginPath();
    r.moveTo(inset, inset);
    r.lineTo(w - inset, h - inset);
    r.moveTo(w - inset, inset);
    r.lineTo(inset, h - inset);
    r.stroke(this.fallbackStroke, 1);
  }

  destroy(): void {
    if (this.lodTimeout) {
      clearTimeout(this.lodTimeout);
      this.lodTimeout = null;
    }
    if (this.currentImg) {
      this.currentImg.onload = null;
      this.currentImg.onerror = null;
      this.currentImg = null;
    }
    if (this.imageBitmap) {
      this.imageBitmap.close();
      this.imageBitmap = null;
    }
    if (this.blobURL) {
      URL.revokeObjectURL(this.blobURL);
      this.blobURL = null;
    }
    this.imageElement = null;
    this.cachedDoc = null;
    super.destroy();
  }
}
