import { Entity } from '../tree/Entity';
import { IRenderer } from '../renderer/IRenderer';

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
  private dirty: boolean = true;
  private loading: boolean = false;

  constructor(svgSource: string, id?: string) {
    super(id);
    this.setSVGSource(svgSource);
  }

  public setSVGSource(svgSource: string): void {
    if (this.svgSource === svgSource) return;
    this.svgSource = svgSource;
    this.dirty = true;
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
        console.error('Failed parsing SVG via DOMParser, falling back to regex:', e);
      }
    } else {
      const wMatch = /<svg[^>]*\bwidth\s*=\s*["']([^"']+)["']/i.exec(this.svgSource);
      const hMatch = /<svg[^>]*\bheight\s*=\s*["']([^"']+)["']/i.exec(this.svgSource);
      const vbMatch = /<svg[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i.exec(this.svgSource);

      if (wMatch && hMatch) {
        width = parseFloat(wMatch[1]) || 100;
        height = parseFloat(hMatch[1]) || 100;
      } else if (vbMatch) {
        const parts = vbMatch[1].split(/[\s,]+/).map(parseFloat);
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
    this.loading = true;

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
        this.dirty = false;
        this.loading = false;
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
          this.dirty = false;
          this.loading = false;
          this.currentImg = null;
          if (this.scene) this.scene.markDirty();
        })
        .catch((e) => {
          console.error('Failed to create ImageBitmap from SVG:', e);
          this.dirty = false;
          this.loading = false;
          this.currentImg = null;
        });
    };
    img.onerror = (e) => {
      if (this.currentImg !== img) return;
      console.error('Failed to load SVG Image element:', e);
      this.dirty = false;
      this.loading = false;
      this.currentImg = null;
    };
    img.src = this.blobURL;
  }

  isPointInside(globalX: number, globalY: number): boolean {
    const pos = this.getGlobalPosition();
    const scale = this.getWorldScale();
    const rot = this.getWorldRotation();

    const dx = globalX - pos.x;
    const dy = globalY - pos.y;

    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const lx = (dx * cos - dy * sin) / scale.x;
    const ly = (dx * sin + dy * cos) / scale.y;

    return lx >= 0 && lx <= this.width && ly >= 0 && ly <= this.height;
  }

  render(r: IRenderer): void {
    const isSVGExporter = typeof (r as any).toXMLString === 'function';
    if (isSVGExporter) {
      const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(this.svgSource);
      r.drawImage({ src: dataUri } as any, 0, 0, this.width, this.height);
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
