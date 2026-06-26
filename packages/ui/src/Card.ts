import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';

/** Construction options for {@link Card}. */
export interface CardOptions {
  /** Box width in pixels. */
  width: number;
  /** Box height in pixels. */
  height: number;
  /** Background fill. Default `'#0f172a'`. */
  bg?: string;
  /** Border color. When omitted, no border is drawn. */
  border?: string;
  /** Border width in pixels. Default `1`. */
  borderWidth?: number;
  /** Corner radius in pixels. Default `12`. */
  radius?: number;
  /** Inner padding in pixels (for consumers positioning children). Default `0`. */
  padding?: number;
  /**
   * Accessible name. When given, the card becomes interactive and projects a
   * `role="group"` shadow node so assistive tech / agents can find the region.
   */
  label?: string;
}

/**
 * A container panel: rounded background with an optional border. Add children
 * via {@link add}; they render on top in the card's local space.
 *
 * Decorative by default (no shadow node). Pass a `label` to project a
 * `role="group"` landmark.
 *
 * @example
 * const card = new Card({ width: 280, height: 160, border: '#334155' });
 * card.add(new Text('Feature').setPosition(16, 16));
 */
export class Card extends UIComponent {
  public bg: string;
  public border: string | null;
  public borderWidth: number;
  public radius: number;
  public label: string | null;

  constructor(opts: CardOptions) {
    super();
    this.width = opts.width;
    this.height = opts.height;
    this.bg = opts.bg ?? '#0f172a';
    this.border = opts.border ?? null;
    this.borderWidth = opts.borderWidth ?? 1;
    this.radius = opts.radius ?? 12;
    this.padding = opts.padding ?? 0;
    this.label = opts.label ?? null;
    if (this.label) this.interactive = true;
  }

  public getA11yAttributes(): A11yAttributes {
    return this.label ? { role: 'group', label: this.label } : {};
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.bg);
    if (this.border) {
      r.beginPath();
      r.roundRect(0, 0, this.width, this.height, this.radius);
      r.stroke(this.border, this.borderWidth);
    }
  }
}
