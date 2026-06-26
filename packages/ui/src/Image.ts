import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Image}. */
export interface ImageOptions {
  /** Box width in pixels. Required (the canvas needs a known box for layout/culling). */
  width: number;
  /** Box height in pixels. */
  height: number;
  /** Alternative text for the `<img alt>` shadow node and accessible name. */
  alt?: string;
  /** Placeholder fill shown until the bitmap loads. Default `'#1e293b'`. */
  placeholder?: string;
  /** Corner radius in pixels for the placeholder. Default `0`. */
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
  private bitmap: HTMLImageElement | null = null;
  private loaded = false;

  constructor(src: string, opts: ImageOptions) {
    super();
    this.src = src;
    this.alt = opts.alt ?? '';
    this.placeholder = opts.placeholder ?? '#1e293b';
    this.radius = opts.radius ?? 0;
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
    return { tag: 'img', src: this.src, alt: this.alt, label: this.alt };
  }

  public render(r: IRenderer): void {
    if (this.loaded && this.bitmap) {
      r.drawImage(this.bitmap, 0, 0, this.width, this.height);
      return;
    }
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.placeholder);
  }
}
