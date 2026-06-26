import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Input}. */
export interface InputOptions {
  /** Box width in pixels. */
  width: number;
  /** Box height in pixels. Default `40`. */
  height?: number;
  /** Placeholder text shown when empty. */
  placeholder?: string;
  /** Initial value. Default `''`. */
  value?: string;
  /** CSS font shorthand. Default `'16px sans-serif'`. */
  font?: string;
  /** Text color. Default `'#e2e8f0'`. */
  color?: string;
  /** Placeholder color. Default `'#64748b'`. */
  placeholderColor?: string;
  /** Background fill. Default `'#0f172a'`. */
  bg?: string;
  /** Border color. Default `'#334155'`. */
  border?: string;
  /** Corner radius. Default `6`. */
  radius?: number;
  /** Inner padding. Default `10`. */
  padding?: number;
  /** Invoked with the new value whenever the field changes. */
  onChange?: (value: string) => void;
}

/**
 * A single-line text field backed by a real `<input>` shadow node — so an agent
 * (or assistive tech) can `fill()` it natively, and the typed value flows back to
 * the canvas via the `change` event. The canvas draws the current value (or
 * placeholder).
 *
 * @example new Input({ width: 240, placeholder: 'Your email', onChange: v => …});
 */
export class Input extends UIComponent {
  public value: string;
  public placeholder: string;
  public font: string;
  public color: string;
  public placeholderColor: string;
  public bg: string;
  public border: string;
  public radius: number;

  constructor(opts: InputOptions) {
    super();
    this.width = opts.width;
    this.height = opts.height ?? 40;
    this.value = opts.value ?? '';
    this.placeholder = opts.placeholder ?? '';
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.placeholderColor = opts.placeholderColor ?? '#64748b';
    this.bg = opts.bg ?? '#0f172a';
    this.border = opts.border ?? '#334155';
    this.radius = opts.radius ?? 6;
    this.padding = opts.padding ?? 10;
    this.interactive = true;

    this.on('change', (e: { value: string }) => {
      this.value = e.value;
      opts.onChange?.(this.value);
    });
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'input',
      inputType: 'text',
      placeholder: this.placeholder,
      value: this.value,
      label: this.placeholder,
    };
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.stroke(this.border, 1);

    const baseline = this.height * 0.66;
    const text = this.value || this.placeholder;
    const color = this.value ? this.color : this.placeholderColor;
    r.fillText(text, this.padding, baseline, this.font, color);
  }
}
