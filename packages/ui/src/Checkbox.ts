import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

/** Construction options for {@link Checkbox}. */
export interface CheckboxOptions {
  /** Initial checked state. Default `false`. */
  checked?: boolean;
  /** Optional label drawn to the right of the box and used as the accessible name. */
  label?: string;
  /** Box size in pixels. Default `20`. */
  size?: number;
  /** CSS font shorthand for the label. Default `'16px sans-serif'`. */
  font?: string;
  /** Label color. Default `'#e2e8f0'`. */
  color?: string;
  /** Checked fill. Default `'#2563eb'`. */
  accent?: string;
  /** Unchecked border. Default `'#475569'`. */
  border?: string;
  /** Invoked with the new checked state whenever it changes. */
  onChange?: (checked: boolean) => void;
}

/**
 * A checkbox backed by a real `<input type="checkbox">` shadow node — natively
 * toggleable by agents/assistive tech. Clicking (canvas or shadow) toggles the
 * state; the shadow node's own change keeps it in sync.
 *
 * @example new Checkbox({ label: 'Accept terms', onChange: v => … });
 */
export class Checkbox extends UIComponent {
  public checked: boolean;
  public label: string;
  public size: number;
  public font: string;
  public color: string;
  public accent: string;
  public border: string;

  constructor(opts: CheckboxOptions) {
    super();
    this.checked = opts.checked ?? false;
    this.label = opts.label ?? '';
    this.size = opts.size ?? 20;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.accent = opts.accent ?? '#2563eb';
    this.border = opts.border ?? '#475569';
    this.interactive = true;

    this.height = this.size;
    this.width = this.size + (this.label ? 8 + measureText(this.label, this.font) : 0);

    this.on('click', () => this.setChecked(!this.checked, opts.onChange));
    // Authoritative native state when the shadow checkbox is toggled directly.
    this.on('change', (e: { checked: boolean }) => this.setChecked(e.checked, opts.onChange));
  }

  private setChecked(value: boolean, onChange?: (c: boolean) => void): void {
    if (value === this.checked) return;
    this.checked = value;
    onChange?.(value);
  }

  public getA11yAttributes(): A11yAttributes {
    return { tag: 'input', inputType: 'checkbox', checked: this.checked, label: this.label };
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.size, this.size, 4);
    if (this.checked) {
      r.fill(this.accent);
      // Checkmark.
      r.beginPath();
      r.moveTo(this.size * 0.25, this.size * 0.5);
      r.lineTo(this.size * 0.45, this.size * 0.7);
      r.lineTo(this.size * 0.75, this.size * 0.3);
      r.stroke('#ffffff', 2);
    } else {
      r.stroke(this.border, 2);
    }
    if (this.label) {
      r.fillText(this.label, this.size + 8, this.size * 0.75, this.font, this.color);
    }
  }
}
