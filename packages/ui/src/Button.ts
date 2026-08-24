import { A11yAttributes, IRenderer } from '@vectojs/core';
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
  /**
   * Focus-ring color, stroked 2px when the button is focused. Default
   * `'#00f0ff'`.
   *
   * Set it on a light or warm theme: the default cyan is tuned for the dark
   * default palette and reads as off-brand elsewhere, and a focus ring is the
   * one affordance a keyboard user cannot do without. Ignored under forced-colors
   * mode, which always uses the system `Highlight` color.
   */
  focusColor?: string;
  /**
   * Start disabled. A disabled button is drawn muted, projects `disabled` on its
   * shadow `<button>`, and does not fire `onClick` from either the canvas
   * hit-test or the DOM click.
   */
  disabled?: boolean;
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
/** Muted fill/text for the disabled state, chosen to stay legible (AA) rather
 *  than merely faint — a disabled control still has to be readable. */
const DISABLED_BG = '#334155';
const DISABLED_TEXT = '#94a3b8';

export class Button extends UIComponent {
  public label: string;
  public bg: string;
  public hoverBg: string;
  public color: string;
  public font: string;
  public radius: number;
  public focusColor: string;
  public focused = false;
  private hovered = false;
  private _disabled = false;

  public textWidth: number;

  constructor(label: string, opts: ButtonOptions & { width?: number; height?: number } = {}) {
    super();
    this.label = label;
    this.bg = opts.bg ?? '#2563eb';
    this.hoverBg = opts.hoverBg ?? '#3b82f6';
    this.color = opts.color ?? '#ffffff';
    this.font = opts.font ?? '600 16px sans-serif';
    this.padding = opts.padding ?? 12;
    this.radius = opts.radius ?? 8;
    this.focusColor = opts.focusColor ?? '#00f0ff';
    this._disabled = opts.disabled ?? false;
    this.interactive = true;

    this.textWidth = measureText(this.label, this.font);
    this.width = opts.width ?? this.textWidth + this.padding * 2;
    this.height = opts.height ?? fontSizePx(this.font) + this.padding * 2;

    // Re-measure once a webfont finishes loading, or the label's centering and
    // intrinsic width keep the pre-load pixels (see watchFontMetrics).
    this.watchFontMetrics(() => {
      const prevText = this.textWidth;
      this.textWidth = measureText(this.label, this.font);
      // Same content-driven rule as setLabel: an explicit constructor width
      // stays fixed; only textWidth (centering) updates.
      if (Math.abs(this.width - (prevText + this.padding * 2)) < 0.5) {
        this.width = this.textWidth + this.padding * 2;
      }
      this.scene?.markDirty();
    });

    this.on('hover', () => {
      // A disabled control must not react to hover: an affordance that looks
      // interactive while the semantics say otherwise is the same divergence in
      // the other direction.
      if (this._disabled || this.hovered) return;
      this.hovered = true;
      this.scene?.markDirty();
    });
    this.on('pointerleave', () => {
      if (!this.hovered) return;
      this.hovered = false;
      this.scene?.markDirty();
    });
    // Drive the focus ring from real DOM focus/blur on the shadow <button>
    // (Scene emits these when the a11y element focuses/blurs). Without this the
    // ring in render() never appears — keyboard users get no focus indicator.
    this.on('focus', () => {
      if (this._disabled || this.focused) return;
      this.focused = true;
      this.scene?.markDirty();
    });
    this.on('blur', () => {
      if (!this.focused) return;
      this.focused = false;
      this.scene?.markDirty();
    });
    if (opts.onClick) {
      const onClick = opts.onClick;
      // Gate here rather than relying on the shadow `<button disabled>`: the
      // browser suppresses a DOM click on a disabled button, but the canvas
      // hit-test path dispatches independently, so without this a disabled
      // button would still fire when clicked on the canvas.
      this.on('click', (event) => {
        if (this._disabled) return;
        onClick(event);
      });
    }
  }

  /**
   * Whether the button is disabled.
   *
   * Setting this keeps the drawn state and the projected semantics in step — the
   * failure mode worth preventing is a control drawn as unavailable whose shadow
   * node still reports enabled, which tells sighted and screen-reader users
   * opposite things.
   */
  public get disabled(): boolean {
    return this._disabled;
  }

  public set disabled(value: boolean) {
    if (this._disabled === value) return;
    this._disabled = value;
    // Drop transient states that no longer apply, or a button disabled while
    // hovered keeps its hover fill.
    if (value) {
      this.hovered = false;
      this.focused = false;
    }
    // The projected `disabled` attribute changes, so the a11y layer must re-sync.
    this.scene?.markDirty();
  }

  /**
   * Update the visible label and remeasure intrinsic width when the button
   * was not given an explicit constructor `width`. Fixed-size chrome buttons
   * keep their box; only `textWidth` (centering) updates.
   */
  public setLabel(label: string): void {
    if (this.label === label) return;
    const prevText = this.textWidth;
    this.label = label;
    this.textWidth = measureText(this.label, this.font);
    // Grow/shrink only when width was content-driven (matches constructor:
    // width === textWidth + padding*2 at the previous label).
    if (Math.abs(this.width - (prevText + this.padding * 2)) < 0.5) {
      this.width = this.textWidth + this.padding * 2;
    }
    this.scene?.markDirty();
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'button',
      role: 'button',
      label: this.label,
      // Projected so assistive technology reports the same availability the
      // canvas draws. `undefined` rather than `false` when enabled: the
      // projection removes an attribute set to undefined, and a native
      // `<button>` needs no explicit enabled marker.
      disabled: this._disabled ? true : undefined,
    };
  }

  public render(r: IRenderer): void {
    // Under a forced-colors mode (Windows High Contrast) the canvas is exempt
    // from the browser's color remapping, so draw with CSS system colors: a
    // `ButtonFace` fill, `ButtonText` label + border, and a `Highlight` focus
    // ring. Otherwise use the themed palette.
    const forced = this.scene?.forcedColors ?? false;
    // Under forced colors, `GrayText` is the system's own disabled colour — the
    // point of that mode is that the OS, not the app, picks contrast.
    const bg = forced
      ? 'ButtonFace'
      : this._disabled
        ? DISABLED_BG
        : this.hovered
          ? this.hoverBg
          : this.bg;
    const border = forced ? (this._disabled ? 'GrayText' : 'ButtonText') : null;
    const focusColor = forced ? 'Highlight' : this.focusColor;
    const textColor = forced
      ? this._disabled
        ? 'GrayText'
        : 'ButtonText'
      : this._disabled
        ? DISABLED_TEXT
        : this.color;

    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(bg);
    if (this.focused) {
      r.stroke(focusColor, 2);
    } else if (border) {
      r.stroke(border, 1);
    }
    const textX = (this.width - this.textWidth) / 2;
    r.fillText(this.label, textX, this.height * 0.66, this.font, textColor);
  }
}
