import { A11yAttributes, IRenderer } from '@vectojs/core';
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
  /** Focus-ring color, stroked 2px around the track while focused. Default `'#00f0ff'`. */
  focusColor?: string;
  /** Whether the toggle is disabled (no toggling, projected `disabled`). Default `false`. */
  disabled?: boolean;
}

class ToggleKnob extends UIComponent {
  private knobR: number;

  constructor(knobR: number) {
    super();
    this.knobR = knobR;
    this.interactive = false;
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.arc(0, 0, this.knobR, 0, Math.PI * 2);
    r.fill('#ffffff');
  }
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
  /** Focus-ring color; stroked 2px around the track while focused. */
  public focusColor: string;
  /** True while the shadow switch holds keyboard focus. */
  public focused = false;

  private _disabled = false;

  private knobEntity: ToggleKnob;

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
    this.focusColor = opts.focusColor ?? '#00f0ff';
    this._disabled = opts.disabled ?? false;
    this.interactive = true;

    this.height = this.trackH;
    this.width = this.trackW + (this.label ? 8 + measureText(this.label, this.font) : 0);

    // Focus ring bookkeeping. The projected `[role=switch]` node is painted at
    // opacity 0, so without a drawn indicator all keyboard focus is invisible
    // (WCAG 2.4.7) — same pattern as Button/Slider.
    this.on('focus', () => {
      this.focused = true;
      this.scene?.markDirty();
    });
    this.on('blur', () => {
      this.focused = false;
      this.scene?.markDirty();
    });

    const radius = this.trackH / 2;
    const knobR = radius - 3;
    const initialX = this.checked ? this.trackW - radius : radius;

    this.knobEntity = new ToggleKnob(knobR);
    this.knobEntity.setPosition(initialX, radius);
    this.knobEntity.setTransition({
      x: {
        stiffness: 210,
        damping: 14,
        mass: 0.6,
      },
    });
    this.add(this.knobEntity);

    // Unified event model (matches Input/Checkbox): a click requests a state
    // change via `emit('change')`; the single 'change' handler is the source of
    // truth, so external `on('change', …)` listeners and the `onChange` callback
    // both fire. (role="switch" is a div, so the Scene doesn't forward a native
    // change for it — the component emits its own.)
    this.on('click', () => {
      if (this._disabled) return;
      this.emit('change', { checked: !this.checked });
    });
    this.on('change', (e: { checked: boolean }) => {
      if (this._disabled || e.checked === this.checked) return;
      this.checked = e.checked;

      // Snappy physical spring motion targeting the new checked end position
      const targetX = this.checked ? this.trackW - radius : radius;
      this.knobEntity.x = targetX;

      opts.onChange?.(this.checked);
      this.scene?.markDirty();
    });
  }

  /** Whether the toggle is disabled. Projected so AT reports what the canvas draws. */
  public get disabled(): boolean {
    return this._disabled;
  }

  public set disabled(value: boolean) {
    if (this._disabled === value) return;
    this._disabled = value;
    if (value) this.focused = false;
    this.scene?.markDirty();
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'switch',
      checked: this.checked,
      label: this.label,
      disabled: this._disabled ? true : undefined,
    };
  }

  public render(r: IRenderer): void {
    const radius = this.trackH / 2;
    r.beginPath();
    r.roundRect(0, 0, this.trackW, this.trackH, radius);
    r.fill(this.checked ? this.accent : this.track);

    // Focus ring. The native shadow node is painted at opacity 0, so a
    // keyboard user would otherwise get no focus indication (WCAG 2.4.7).
    if (this.focused) {
      const forced = this.scene?.forcedColors ?? false;
      r.beginPath();
      r.roundRect(-3, -3, this.trackW + 6, this.trackH + 6, radius + 3);
      r.stroke(forced ? 'Highlight' : this.focusColor, 2);
    }

    if (this.label) {
      r.fillText(this.label, this.trackW + 8, this.trackH * 0.7, this.font, this.color);
    }
  }
}
