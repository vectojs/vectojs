import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

/** Construction options for {@link Toggle}. */
export interface ToggleOptions {
  /** Initial on/off state. Default `false`. */
  checked?: boolean;
  /** Optional label drawn to the right and used as the accessible name. */
  label?: string;
  /** Track width in pixels. Default `44`. */
  width?: number;
  /** Track height in pixels. Default `24`. */
  height?: number;
  /** CSS font shorthand for the label. Default `'16px sans-serif'`. */
  font?: string;
  /** Label color. Default `'#e2e8f0'`. */
  color?: string;
  /** On-state track fill. Default `'#2563eb'`. */
  accent?: string;
  /** Off-state track fill. Default `'#475569'`. */
  track?: string;
  /** Invoked with the new state whenever it changes. */
  onChange?: (checked: boolean) => void;
}

/**
 * A switch projecting a `role="switch"` shadow node with `aria-checked`, so
 * agents/assistive tech can read and operate it. Clicking toggles the state.
 *
 * @example new Toggle({ label: 'Dark mode', checked: true, onChange: v => … });
 */
export class Toggle extends UIComponent {
  public checked: boolean;
  public label: string;
  public trackW: number;
  public trackH: number;
  public font: string;
  public color: string;
  public accent: string;
  public track: string;

  constructor(opts: ToggleOptions) {
    super();
    this.checked = opts.checked ?? false;
    this.label = opts.label ?? '';
    this.trackW = opts.width ?? 44;
    this.trackH = opts.height ?? 24;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.accent = opts.accent ?? '#2563eb';
    this.track = opts.track ?? '#475569';
    this.interactive = true;

    this.height = this.trackH;
    this.width = this.trackW + (this.label ? 8 + measureText(this.label, this.font) : 0);

    this.on('click', () => {
      this.checked = !this.checked;
      opts.onChange?.(this.checked);
    });
  }

  public getA11yAttributes(): A11yAttributes {
    return { role: 'switch', checked: this.checked, label: this.label };
  }

  public render(r: IRenderer): void {
    const radius = this.trackH / 2;
    r.beginPath();
    r.roundRect(0, 0, this.trackW, this.trackH, radius);
    r.fill(this.checked ? this.accent : this.track);

    // Knob.
    const knobR = radius - 3;
    const cx = this.checked ? this.trackW - radius : radius;
    r.beginPath();
    r.arc(cx, radius, knobR, 0, Math.PI * 2);
    r.fill('#ffffff');

    if (this.label) {
      r.fillText(this.label, this.trackW + 8, this.trackH * 0.7, this.font, this.color);
    }
  }
}
