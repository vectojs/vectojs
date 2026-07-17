import { Entity, A11yAttributes, IRenderer } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { type FitContentOptions } from './ResizablePanel';

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
  /**
   * Makes the whole card clickable and interactive, the same `onClick`
   * pattern {@link import('./Button').Button} already uses — no more
   * stacking a transparent `Button` over a `Card` to make it pressable.
   * Requires `label`: the a11y projection needs an accessible name for the
   * interactive region this creates, and an unlabeled clickable Card would
   * recreate the exact "empty-label button in the a11y tree" problem this
   * option exists to remove.
   */
  onClick?: (e: unknown) => void;
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
  private _content: Entity | null = null;
  private _fitWidth = false;
  private _fitHeight = false;

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
    if (opts.onClick) {
      if (!this.label) {
        throw new Error(
          'Card: onClick requires a label (the a11y projection needs an accessible name for the interactive region it creates).',
        );
      }
      this.on('click', opts.onClick);
    }
  }

  public getA11yAttributes(): A11yAttributes {
    return this.label ? { role: 'group', label: this.label } : {};
  }

  /**
   * Place a single content entity inside the card, sized to match by
   * default. Same `fitContent` contract as {@link import('./ResizablePanel').Panel.setContent}
   * — pass `false` (or a per-axis object) to keep the old position-only
   * `add()` behavior instead. Unlike `Panel`, a `Card` is not required to
   * host content this way; use plain {@link add} for cards whose children
   * are manually positioned decorations rather than a single sized region.
   */
  public setContent(content: Entity, fit: FitContentOptions | boolean = true): this {
    if (this._content) super.remove(this._content);
    this._content = content;
    content.x = 0;
    content.y = 0;
    if (fit === false) {
      this._fitWidth = false;
      this._fitHeight = false;
    } else if (fit === true) {
      this._fitWidth = true;
      this._fitHeight = true;
    } else {
      this._fitWidth = fit.width ?? true;
      this._fitHeight = fit.height ?? true;
    }
    this._applyFit();
    super.add(content);
    return this;
  }

  private _applyFit(): void {
    if (!this._content) return;
    if (this._fitWidth) this._content.width = this.width;
    if (this._fitHeight) this._content.height = this.height;
  }

  public update(dt: number, time: number): void {
    super.update(dt, time);
    if (this._content) this._applyFit();
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
