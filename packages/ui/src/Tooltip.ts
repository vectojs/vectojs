import { Entity, IRenderer } from '@vectojs/core';
import { Overlay, OverlayPlacement } from './Overlay';

export interface TooltipOptions {
  /** The entity this tooltip is attached to. */
  target: Entity;
  /** Text content of the tooltip. */
  content: string;
  /** Preferred placement. Default `'top'`. */
  placement?: OverlayPlacement;
  /** Delay in milliseconds before the tooltip appears. Default `320`. */
  delay?: number;
  font?: string;
  color?: string;
  bg?: string;
}

/**
 * A hover-triggered tooltip that appears near a target entity after a short delay.
 * Add once to the scene; it manages its own show/hide lifecycle.
 *
 * @example
 * const tooltip = new Tooltip({ target: myButton, content: 'Save file (Ctrl+S)' });
 * scene.add(tooltip);
 */
export class Tooltip extends Overlay {
  private _content: string;
  private _font: string;
  private _textColor: string;
  private _bg: string;
  private _delay: number;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TooltipOptions) {
    const estimatedW = Math.min(opts.content.length * 7.5 + 20, 320);
    super({
      width: estimatedW,
      height: 30,
      placement: opts.placement ?? 'top',
      offset: 8,
    });
    this._content = opts.content;
    this._font = opts.font ?? '12px sans-serif';
    this._textColor = opts.color ?? '#e2e8f0';
    this._bg = opts.bg ?? 'rgba(15,15,30,0.92)';
    this._delay = opts.delay ?? 320;

    opts.target.on('hover', () => {
      this._timer = setTimeout(() => this.showAt(opts.target), this._delay);
    });
    opts.target.on('pointerleave', () => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this.hide();
    });
  }

  public render(r: IRenderer): void {
    // Background + border
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.fill(this._bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.stroke('rgba(255,255,255,0.12)', 1);
    // Label
    r.fillText(this._content, 10, this.height / 2 + 4, this._font, this._textColor);
  }
}
