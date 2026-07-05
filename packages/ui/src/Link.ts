import { A11yAttributes, IRenderer, sanitizeUrl } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText, fontSizePx } from './measure';

/** Construction options for {@link Link}. */
export interface LinkOptions {
  /** Destination URL. Required for navigation and for the shadow `<a href>`. */
  href: string;
  /** Link color. Default `'#38bdf8'`. */
  color?: string;
  /** CSS font shorthand. Default `'16px sans-serif'`. */
  font?: string;
  /** Whether to draw an underline. Default `true`. */
  underline?: boolean;
}

/**
 * A hyperlink rendered as colored (underlined) text.
 *
 * Projects a real `<a href>` shadow node (natively clickable / crawlable). The
 * canvas hit-test path opens the URL via `window.open(href, '_blank', 'noopener')`.
 *
 * @example new Link('Docs', { href: 'https://example.com' }).setPosition(20, 80);
 */
export class Link extends UIComponent {
  public label: string;
  public href: string;
  public color: string;
  public font: string;
  public underline: boolean;

  constructor(label: string, opts: LinkOptions) {
    super();
    this.label = label;
    this.href = opts.href;
    this.color = opts.color ?? '#38bdf8';
    this.font = opts.font ?? '16px sans-serif';
    this.underline = opts.underline ?? true;
    this.interactive = true;

    this.width = measureText(this.label, this.font);
    this.height = fontSizePx(this.font);

    this.on('click', () => {
      const safe = sanitizeUrl(this.href);
      if (safe && safe !== '#' && typeof window !== 'undefined') {
        window.open(safe, '_blank', 'noopener');
      }
    });
  }

  public getA11yAttributes(): A11yAttributes {
    return { tag: 'a', href: sanitizeUrl(this.href), label: this.label };
  }

  public render(r: IRenderer): void {
    const baseline = this.height * 0.8;
    r.fillText(this.label, 0, baseline, this.font, this.color);
    if (this.underline) {
      r.beginPath();
      r.moveTo(0, baseline + 2);
      r.lineTo(this.width, baseline + 2);
      r.stroke(this.color, 1);
    }
  }
}
