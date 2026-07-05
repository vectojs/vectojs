import { A11yAttributes, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

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

  constructor(opts: RadioGroupOptions) {
    super('RadioGroup');
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
      this.scene?.markDirty();
    });
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
