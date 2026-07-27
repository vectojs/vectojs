import { A11yAttributes, IRenderer, type LayoutControlledProperty } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

/**
 * A transparent, focusable hotspot over one radio option. The {@link RadioGroup}
 * paints the circle + label on canvas; this exists so the a11y/automation layer
 * projects a real `role="radio"` with `aria-checked` and a roving tabindex that
 * a screen reader and keyboard user can operate (WCAG 4.1.2 / 2.1.1).
 */
class RadioHotspot extends UIComponent {
  constructor(
    public optionValue: string,
    private group: RadioGroup,
    private label: string,
  ) {
    super();
    this.interactive = true;
    this.on('click', () => this.group.selectByValue(this.optionValue, true));
    this.on('keydown', (e: KeyboardEvent) => this.group.handleRadioKey(e, this.optionValue));
  }
  /**
   * RadioGroup positions and sizes its focus hotspots, one per visible option.
   */
  public override getLayoutControlledProperties(): ReadonlyArray<LayoutControlledProperty> {
    return ['x', 'y', 'width', 'height'];
  }

  public setMeta(label: string): void {
    this.label = label;
  }
  public getA11yAttributes(): A11yAttributes {
    const checked = this.group.value === this.optionValue;
    const disabled = this.group.isDisabled(this.optionValue);
    return {
      role: 'radio',
      label: this.label,
      checked,
      disabled: disabled || undefined,
      // Roving tabindex: only the checked option (or the first, when none
      // matches) is in the tab order; arrows move within the group.
      tabIndex: this.group.isTabStop(this.optionValue) ? 0 : -1,
    };
  }
  public render(): void {
    /* invisible — RadioGroup paints the control */
  }
}

export interface RadioOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface RadioGroupOptions {
  options: RadioOption[];
  value?: string;
  direction?: 'horizontal' | 'vertical';
  gap?: number;
  size?: number;
  font?: string;
  color?: string;
  accent?: string;
  border?: string;
  onChange?: (value: string) => void;
}

/**
 * A group of mutually exclusive radio buttons.
 * Renders custom check-circles and text labels with hover highlights.
 *
 * @example
 * const group = new RadioGroup({
 *   options: [
 *     { value: 'light', label: 'Light Theme' },
 *     { value: 'dark', label: 'Dark Theme' },
 *   ],
 *   onChange: (theme) => applyTheme(theme),
 * });
 */
export class RadioGroup extends UIComponent {
  public options: RadioOption[];
  public value: string;
  public direction: 'horizontal' | 'vertical';
  public gap: number;
  public size: number;
  public font: string;
  public color: string;
  public accent: string;
  public border: string;

  private _hoverIdx: number = -1;
  /** One `role="radio"` hotspot per option, kept in sync with the layout. */
  private _hotspots: RadioHotspot[] = [];

  constructor(opts: RadioGroupOptions) {
    super();
    this.options = opts.options;
    this.value = opts.value ?? (opts.options.length > 0 ? opts.options[0].value : '');
    this.direction = opts.direction ?? 'vertical';
    this.gap = opts.gap ?? 12;
    this.size = opts.size ?? 18;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.accent = opts.accent ?? '#2563eb';
    this.border = opts.border ?? '#475569';
    this.interactive = true;

    this._layout();
    this._syncHotspots();

    this.on('pointerdown', (e: { localX?: number; localY?: number }) => {
      if (e.localX === undefined || e.localY === undefined) return;
      const idx = this._idxAt(e.localX, e.localY);
      if (idx !== -1) {
        const opt = this.options[idx];
        if (!opt.disabled && opt.value !== this.value) {
          this.emit('change', { value: opt.value });
        }
      }
    });

    this.on('pointermove', (e: { localX?: number; localY?: number }) => {
      this._hoverIdx =
        e.localX === undefined || e.localY === undefined ? -1 : this._idxAt(e.localX, e.localY);
      this.scene?.markDirty();
    });

    this.on('pointerleave', () => {
      this._hoverIdx = -1;
      this.scene?.markDirty();
    });

    this.on('change', (e: { value: string }) => {
      if (this.value === e.value) return;
      this.value = e.value;
      opts.onChange?.(this.value);
      this._syncHotspots();
      this.scene?.markDirty();
    });
  }

  /** Whether the option is disabled (used by the radio hotspots). */
  public isDisabled(value: string): boolean {
    return this.options.find((o) => o.value === value)?.disabled ?? false;
  }

  /** Roving-tabindex tab stop: the checked option, or the first enabled option
   *  when the current value matches none. */
  public isTabStop(value: string): boolean {
    if (this.options.some((o) => o.value === this.value)) return value === this.value;
    const firstEnabled = this.options.find((o) => !o.disabled);
    return !!firstEnabled && firstEnabled.value === value;
  }

  /** Select an option by value (from a hotspot click or keyboard), emitting
   *  `change` through the same path as a pointer selection. */
  public selectByValue(value: string, focusIt = false): void {
    if (this.isDisabled(value) || value === this.value) return;
    this.emit('change', { value });
    if (focusIt) this._focusHotspot(value);
  }

  /** Arrow-key navigation within the group (WCAG radio pattern): Up/Left → prev,
   *  Down/Right → next (wrapping, skipping disabled), selecting on move;
   *  Home/End → first/last enabled option; Space selects the focused option. */
  public handleRadioKey(e: KeyboardEvent, fromValue: string): void {
    const keys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      ' ',
      'Spacebar',
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    if (e.key === ' ' || e.key === 'Spacebar') {
      this.selectByValue(fromValue, true);
      return;
    }
    // Home/End jump to the first/last option, which the ARIA radiogroup pattern
    // requires and `Tabs` already implements. Scan inward so a disabled option at
    // either edge does not swallow the key — landing on a disabled radio would be
    // worse than not moving.
    if (e.key === 'Home' || e.key === 'End') {
      const n = this.options.length;
      for (let i = 0; i < n; i++) {
        const idx = e.key === 'Home' ? i : n - 1 - i;
        const opt = this.options[idx];
        if (opt && !opt.disabled) {
          this.selectByValue(opt.value, true);
          return;
        }
      }
      return;
    }
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const n = this.options.length;
    const startIdx = this.options.findIndex((o) => o.value === fromValue);
    if (startIdx === -1) return;
    for (let step = 1; step <= n; step++) {
      const idx = (startIdx + (forward ? step : -step) + n * step) % n;
      const opt = this.options[idx];
      if (!opt.disabled) {
        this.selectByValue(opt.value, true);
        return;
      }
    }
  }

  private _focusHotspot(value: string): void {
    this._hotspots.find((h) => h.optionValue === value)?.focus();
  }

  /** Create/position one transparent `role="radio"` hotspot per option over its
   *  circle+label box, matching `_idxAt`'s geometry. */
  private _syncHotspots(): void {
    // Rebuild if the option set changed (add/remove children as needed).
    if (this._hotspots.length !== this.options.length) {
      for (const h of this._hotspots) {
        this.scene?.detachA11y?.(h);
        this.remove(h);
      }
      this._hotspots = this.options.map((o) => new RadioHotspot(o.value, this, o.label));
      for (const h of this._hotspots) this.add(h);
    }

    let current = 0;
    const isH = this.direction === 'horizontal';
    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i];
      const labelW = measureText(opt.label, this.font);
      const itemW = this.size + 8 + labelW;
      const hotspot = this._hotspots[i];
      hotspot.setMeta(opt.label);
      if (isH) {
        hotspot.x = current;
        hotspot.y = 0;
        hotspot.width = itemW;
        hotspot.height = this.size;
        current += itemW + this.gap;
      } else {
        hotspot.x = 0;
        hotspot.y = current;
        hotspot.width = itemW;
        hotspot.height = this.size;
        current += this.size + this.gap;
      }
    }
    this.scene?.markDirty();
  }

  private _layout(): void {
    let totalW = 0;
    let totalH = 0;
    const isH = this.direction === 'horizontal';

    for (let i = 0; i < this.options.length; i++) {
      const labelW = measureText(this.options[i].label, this.font);
      const itemW = this.size + 8 + labelW;
      if (isH) {
        totalW += itemW + (i > 0 ? this.gap : 0);
        totalH = Math.max(totalH, this.size);
      } else {
        totalW = Math.max(totalW, itemW);
        totalH += this.size + (i > 0 ? this.gap : 0);
      }
    }

    this.width = totalW;
    this.height = totalH;
  }

  private _idxAt(lx: number, ly: number): number {
    let current = 0;
    const isH = this.direction === 'horizontal';

    for (let i = 0; i < this.options.length; i++) {
      const labelW = measureText(this.options[i].label, this.font);
      const itemW = this.size + 8 + labelW;

      if (isH) {
        if (lx >= current && lx <= current + itemW && ly >= 0 && ly <= this.size) {
          return i;
        }
        current += itemW + this.gap;
      } else {
        if (ly >= current && ly <= current + this.size && lx >= 0 && lx <= itemW) {
          return i;
        }
        current += this.size + this.gap;
      }
    }
    return -1;
  }

  public render(r: IRenderer): void {
    let current = 0;
    const isH = this.direction === 'horizontal';

    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i];
      const selected = opt.value === this.value;
      const x = isH ? current : 0;
      const y = isH ? 0 : current;

      const centerY = y + this.size / 2;
      const cX = x + this.size / 2;

      // Circle border
      r.beginPath();
      r.arc(cX, centerY, this.size / 2 - 1, 0, Math.PI * 2);
      r.stroke(selected ? this.accent : this.border, 2);

      // Selected inner dot
      if (selected) {
        r.beginPath();
        r.arc(cX, centerY, this.size / 4, 0, Math.PI * 2);
        r.fill(this.accent);
      }

      // Label text
      const disabledColor = 'rgba(255,255,255,0.3)';
      const color = opt.disabled ? disabledColor : this.color;
      r.fillText(opt.label, x + this.size + 8, centerY + 4, this.font, color);

      // Highlight/hover effect
      if (i === this._hoverIdx && !opt.disabled) {
        r.beginPath();
        r.arc(cX, centerY, this.size / 2 + 4, 0, Math.PI * 2);
        r.stroke('rgba(0,240,255,0.15)', 1);
      }

      const labelW = measureText(opt.label, this.font);
      const itemW = this.size + 8 + labelW;
      current += (isH ? itemW : this.size) + this.gap;
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'radiogroup',
      label: 'Radio group',
    };
  }
}
