import { Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

function isSvgWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function readSvgAttribute(source: string, name: string): string | null {
  const lowerSource = source.toLowerCase();
  const svgStart = lowerSource.indexOf('<svg');
  if (svgStart < 0) return null;

  const tagEnd = source.indexOf('>', svgStart + 4);
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
  private svgSource: string = '';
  private imageBitmap: ImageBitmap | null = null;
  private imageElement: HTMLImageElement | null = null;
  private blobURL: string | null = null;
  private currentImg: HTMLImageElement | null = null;
  private lodTimeout: any = null;

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
        } else {
          this.cachedDoc = doc;
          const svgEl = doc.documentElement;
          const wAttr = svgEl.getAttribute('width');
          const hAttr = svgEl.getAttribute('height');
          const vbAttr = svgEl.getAttribute('viewBox');

          if (wAttr && hAttr) {
            width = parseFloat(wAttr) || 100;
            height = parseFloat(hAttr) || 100;
          } else if (vbAttr) {
            const parts = vbAttr.split(/[\s,]+/).map(parseFloat);
            if (parts.length === 4) {
              width = parts[2];
              height = parts[3];
            }
          }
        }
      } catch (e) {
        console.error('Failed parsing SVG via DOMParser, falling back to attribute scan:', e);
      }
    } else {
      const wAttr = readSvgAttribute(this.svgSource, 'width');
      const hAttr = readSvgAttribute(this.svgSource, 'height');
      const vbAttr = readSvgAttribute(this.svgSource, 'viewBox');

      if (wAttr && hAttr) {
        width = parseFloat(wAttr) || 100;
        height = parseFloat(hAttr) || 100;
      } else if (vbAttr) {
        const parts = vbAttr.split(/[\s,]+/).map(parseFloat);
        if (parts.length === 4) {
          width = parts[2];
          height = parts[3];
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
        }
      }
    } catch (e) {
      console.error('Failed to apply LOD scaling to SVG XML:', e);
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
        });
    };
    img.onerror = (e) => {
      if (this.currentImg !== img) return;
      console.error('Failed to load SVG Image element:', e);
      this.currentImg = null;
    };
    img.src = this.blobURL;
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
    } else if (this.imageElement) {
      r.drawImage(this.imageElement, 0, 0, this.width, this.height);
    }
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
