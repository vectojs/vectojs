import { A11yAttributes, IRenderer, sanitizeUrl, VectoJSEvent } from '@vectojs/core';
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
  /** Whether the link is disabled (no navigation, projected `disabled`). Default `false`. */
  disabled?: boolean;
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

  private _disabled = false;

  constructor(label: string, opts: LinkOptions) {
    super();
    this.label = label;
    this.href = opts.href;
    this.color = opts.color ?? '#38bdf8';
    this.font = opts.font ?? '16px sans-serif';
    this.underline = opts.underline ?? true;
    this._disabled = opts.disabled ?? false;
    this.interactive = true;

    this.width = measureText(this.label, this.font);
    this.height = fontSizePx(this.font);

    // Re-measure once a webfont finishes loading, or the link's intrinsic
    // width keeps the pre-load pixels (see watchFontMetrics).
    this.watchFontMetrics(() => {
      this.width = measureText(this.label, this.font);
      this.scene?.markDirty();
    });

    this.on('click', (e: VectoJSEvent) => {
      if (this._disabled) return;
      // The shadow `<a href target=_blank>` navigates NATIVELY on a real DOM
      // click, and that same click is also forwarded here — calling
      // window.open again would open a SECOND tab. So only open programmatically
      // for a canvas/Three/XR-path click (no real anchor navigated): detect a
      // genuine DOM click whose target is an <a> and bail in that case.
      const native = e.nativeEvent as Event | undefined;
      const target = native?.target as { tagName?: string } | undefined;
      const isNativeAnchorClick =
        typeof Event !== 'undefined' &&
        native instanceof Event &&
        target?.tagName?.toLowerCase() === 'a';
      if (isNativeAnchorClick) return; // browser already navigated the shadow <a>

      const safe = sanitizeUrl(this.href);
      if (safe && safe !== '#' && typeof window !== 'undefined') {
        window.open(safe, '_blank', 'noopener');
      }
    });
  }

  /** Whether the link is disabled. Projected so AT reports what the canvas draws. */
  public get disabled(): boolean {
    return this._disabled;
  }

  public set disabled(value: boolean) {
    if (this._disabled === value) return;
    this._disabled = value;
    this.scene?.markDirty();
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'a',
      href: this._disabled ? undefined : sanitizeUrl(this.href),
      label: this.label,
      target: '_blank',
      disabled: this._disabled ? true : undefined,
    };
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
