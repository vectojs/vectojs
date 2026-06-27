import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { measureText, fontSizePx } from './measure';

/** Construction options for {@link Button}. */
export interface ButtonOptions {
  /** Click handler, invoked for both canvas hit-test and shadow `<button>` clicks. */
  onClick?: (e: unknown) => void;
  /** Background fill. Default `'#2563eb'`. */
  bg?: string;
  /** Background fill while hovered. Default `'#3b82f6'`. */
  hoverBg?: string;
  /** Label color. Default `'#ffffff'`. */
  color?: string;
  /** CSS font shorthand. Default `'600 16px sans-serif'`. */
  font?: string;
  /** Inner padding in pixels. Default `12`. */
  padding?: number;
  /** Corner radius in pixels. Default `8`. */
  radius?: number;
}

/**
 * A clickable button rendered as a rounded rectangle with a centered label.
 *
 * Projects a real `<button role="button" aria-label>` shadow node, so
 * `page.getByRole('button', { name })` drives it. The handler fires from both
 * the canvas hit-test path and the shadow button click.
 *
 * @example new Button('Submit', { onClick: () => save() }).setPosition(40, 40);
 */
export class Button extends UIComponent {
  public label: string;
  public bg: string;
  public hoverBg: string;
  public color: string;
  public font: string;
  public radius: number;
  public focused = false;
  private hovered = false;

  constructor(label: string, opts: ButtonOptions = {}) {
    super();
    this.label = label;
    this.bg = opts.bg ?? '#2563eb';
    this.hoverBg = opts.hoverBg ?? '#3b82f6';
    this.color = opts.color ?? '#ffffff';
    this.font = opts.font ?? '600 16px sans-serif';
    this.padding = opts.padding ?? 12;
    this.radius = opts.radius ?? 8;
    this.interactive = true;

    this.width = measureText(this.label, this.font) + this.padding * 2;
    this.height = fontSizePx(this.font) + this.padding * 2;

    this.on('hover', () => (this.hovered = true));
    this.on('pointerleave', () => (this.hovered = false));
    if (opts.onClick) this.on('click', opts.onClick);
  }

  public getA11yAttributes(): A11yAttributes {
    return { tag: 'button', role: 'button', label: this.label };
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.hovered ? this.hoverBg : this.bg);
    if (this.focused) {
      r.stroke('#00f0ff', 2);
    }
    r.fillText(this.label, this.padding, this.height * 0.66, this.font, this.color);
  }
}
