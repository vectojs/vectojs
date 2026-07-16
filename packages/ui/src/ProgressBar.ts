import { A11yAttributes, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText } from './measure';

export interface ProgressBarOptions {
  /** Current progress fraction from `0` to `1`. */
  value: number;
  width?: number;
  height?: number;
  /** Corner radius. Default `8`. */
  radius?: number;
  /** Background track color. Default `'rgba(255, 255, 255, 0.1)'`. */
  bg?: string;
  /** Progress indicator color. Default `'#00f0ff'`. */
  accent?: string;
  /** Render centered percentage label (e.g. "60%"). Default `false`. */
  showText?: boolean;
  font?: string;
  color?: string;
}

/**
 * A standard progress bar widget.
 * Renders a track background and filled accent bar.
 * Supports rendering percentage text at the center.
 *
 * @example
 * const progress = new ProgressBar({ value: 0.45, showText: true });
 * scene.add(progress);
 * progress.setValue(0.8);
 */
export class ProgressBar extends UIComponent {
  public value: number;
  public radius: number;
  public bg: string;
  public accent: string;
  public showText: boolean;
  public font: string;
  public color: string;

  constructor(opts: ProgressBarOptions = { value: 0 }) {
    super();
    this.value = opts.value;
    this.width = opts.width ?? 200;
    this.height = opts.height ?? 16;
    this.radius = opts.radius ?? 8;
    this.bg = opts.bg ?? 'rgba(255, 255, 255, 0.1)';
    this.accent = opts.accent ?? '#00f0ff';
    this.showText = opts.showText ?? false;
    this.font = opts.font ?? '12px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.interactive = false;
  }

  /** Set new progress value (clamped between `0` and `1`). */
  public setValue(val: number): void {
    const clamped = Math.max(0, Math.min(val, 1));
    if (this.value === clamped) return;
    this.value = clamped;
    this.scene?.markDirty();
  }

  public render(r: IRenderer): void {
    // Background bar
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.bg);

    // Progress bar
    if (this.value > 0) {
      r.beginPath();
      r.roundRect(0, 0, this.width * this.value, this.height, this.radius);
      r.fill(this.accent);
    }

    // Centered percentage text option
    if (this.showText) {
      const pct = `${Math.round(this.value * 100)}%`;
      const textW = measureText(pct, this.font);
      const textX = this.width / 2 - textW / 2;
      r.fillText(pct, textX, this.height / 2 + 4, this.font, this.color);
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      role: 'progressbar',
      value: String(Math.round(this.value * 100)),
    };
  }
}
