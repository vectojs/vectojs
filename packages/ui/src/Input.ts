import { A11yAttributes, IRenderer, LayoutEngine } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText, fontSizePx } from './measure';

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
  /** Selection highlight color. Default `'rgba(56, 189, 248, 0.35)'`. */
  selectionColor?: string;
  /** Corner radius. Default `6`. */
  radius?: number;
  /** Inner padding. Default `10`. */
  padding?: number;
  /** Invoked with the new value whenever the field changes. */
  onChange?: (value: string) => void;
}

/**
 * A single-line text field backed by a real, transparent `<input>` shadow node.
 * The browser handles all input — clicks, keyboard, **IME composition**,
 * selection, clipboard, undo — natively on that real element; the canvas is a
 * pure visual mirror. So an agent (or assistive tech) can `fill()` it by role,
 * a human can type CJK into it, and the value/caret/selection flow back via the
 * `change` event for the canvas to draw.
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
  public selectionColor: string;
  public radius: number;

  /** Caret / selection anchor & focus offsets, mirrored from the real input. */
  public selectionStart: number;
  public selectionEnd: number;
  /** Active IME pre-edit range `[start, start+length)`, or `null`. */
  public composition: { start: number; length: number } | null = null;
  /** Whether the shadow input currently holds focus (drives caret blink). */
  public focused = false;

  /** Horizontal scroll offset so the caret stays in view (scroll-to-caret). */
  private scrollLeft = 0;

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
    this.selectionColor = opts.selectionColor ?? 'rgba(56, 189, 248, 0.35)';
    this.radius = opts.radius ?? 6;
    this.padding = opts.padding ?? 10;
    this.selectionStart = this.value.length;
    this.selectionEnd = this.value.length;
    this.interactive = true;

    this.on(
      'change',
      (e: {
        value: string;
        selectionStart?: number;
        selectionEnd?: number;
        composition?: { start: number; length: number } | null;
      }) => {
        this.value = e.value;
        this.selectionStart = e.selectionStart ?? this.value.length;
        this.selectionEnd = e.selectionEnd ?? this.value.length;
        this.composition = e.composition ?? null;
        opts.onChange?.(this.value);
      },
    );
    this.on('focus', () => (this.focused = true));
    this.on('blur', () => (this.focused = false));
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

  private cachedValue: string = '';
  private cachedFont: string = '';
  private cachedLayout: any = null;

  private _rtlCacheValue: string | null = null;
  private _rtlCacheResult = false;

  /**
   * Whether `value` contains any RTL-script character. Cached per distinct
   * `value` — otherwise this O(n) scan re-runs from scratch on every
   * `charOffset()` call, and a single render/caret-blink tick calls it several
   * times (caret, selection start, selection end, composition bounds).
   */
  private hasRTL(): boolean {
    if (this._rtlCacheValue === this.value) return this._rtlCacheResult;
    let result = false;
    for (let j = 0; j < this.value.length; j++) {
      const code = this.value.charCodeAt(j);
      if (
        (code >= 0x0590 && code <= 0x05ff) ||
        (code >= 0x0600 && code <= 0x06ff) ||
        (code >= 0xfb50 && code <= 0xfeff)
      ) {
        result = true;
        break;
      }
    }
    this._rtlCacheValue = this.value;
    this._rtlCacheResult = result;
    return result;
  }

  private getLayout(): any {
    if (this.value === this.cachedValue && this.font === this.cachedFont && this.cachedLayout) {
      return this.cachedLayout;
    }

    const fSize = fontSizePx(this.font);
    const engine = new LayoutEngine(1000000, 1000, {
      measure: (char: string) => measureText(char, this.font),
    });
    engine.preserveLeadingSpaces = true;
    const layout = engine.layoutText(this.value, {}, fSize);

    this.cachedValue = this.value;
    this.cachedFont = this.font;
    this.cachedLayout = layout;
    return layout;
  }

  /** Measured x of the glyph boundary before char index `i` (text-relative). */
  private charOffset(i: number): number {
    if (this.value.length === 0) return 0;

    if (!this.hasRTL()) {
      return measureText(this.value.slice(0, i), this.font);
    }

    const layout = this.getLayout();
    if (layout.nodes.length === 0) return 0;

    let targetNode: any = null;
    let isRTL = false;

    for (const node of layout.nodes) {
      const start = node.sourceIndex ?? 0;
      const len = node.sourceLength ?? 0;
      if (i >= start && i <= start + len) {
        targetNode = node;
        isRTL = !!node.isRTL;
        if (i > start && i < start + len) {
          break;
        }
      }
    }

    if (!targetNode) {
      let maxNode = layout.nodes[0];
      for (const node of layout.nodes) {
        if (
          (node.sourceIndex ?? 0) + (node.sourceLength ?? 0) >
          (maxNode.sourceIndex ?? 0) + (maxNode.sourceLength ?? 0)
        ) {
          maxNode = node;
        }
      }
      targetNode = maxNode;
      isRTL = !!maxNode.isRTL;
    }

    const start = targetNode.sourceIndex ?? 0;
    const len = targetNode.sourceLength ?? 0;
    const fraction = len > 0 ? (i - start) / len : 0;

    if (isRTL) {
      return targetNode.x + targetNode.width * (1.0 - fraction);
    } else {
      return targetNode.x + targetNode.width * fraction;
    }
  }

  /** Screen-space x of the caret (after scroll), in the component's box coords. */
  private caretScreenX(): number {
    return this.padding - this.scrollLeft + this.charOffset(this.selectionStart);
  }

  /** Keep the caret within the padded inner box by adjusting `scrollLeft`. */
  private updateScroll(): void {
    const innerWidth = this.width - 2 * this.padding;
    const caretAbs = this.charOffset(this.selectionStart);
    if (caretAbs - this.scrollLeft > innerWidth) this.scrollLeft = caretAbs - innerWidth;
    if (caretAbs - this.scrollLeft < 0) this.scrollLeft = caretAbs;
    if (this.scrollLeft < 0) this.scrollLeft = 0;
  }

  /** Caret blink "on" phase (500ms cadence). */
  private caretOn(): boolean {
    return Math.floor(Date.now() / 500) % 2 === 0;
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.stroke(this.border, 1);

    this.updateScroll();
    const innerWidth = this.width - 2 * this.padding;
    const baseline = this.height * 0.66;
    const textOriginX = this.padding - this.scrollLeft;

    r.save();
    r.clip(this.padding, 0, innerWidth, this.height);

    // Selection highlight (drawn behind the text, even when not focused).
    if (this.selectionStart !== this.selectionEnd) {
      const a = Math.min(this.selectionStart, this.selectionEnd);
      const b = Math.max(this.selectionStart, this.selectionEnd);

      if (!this.hasRTL()) {
        const sx = textOriginX + this.charOffset(a);
        const ex = textOriginX + this.charOffset(b);
        r.beginPath();
        r.roundRect(sx, this.height * 0.2, ex - sx, this.height * 0.6, 0);
        r.fill(this.selectionColor);
      } else {
        const layout = this.getLayout();
        r.beginPath();
        for (const node of layout.nodes) {
          const start = node.sourceIndex ?? 0;
          const len = node.sourceLength ?? 0;
          if (!(start + len <= a || start >= b)) {
            r.roundRect(textOriginX + node.x, this.height * 0.2, node.width, this.height * 0.6, 0);
          }
        }
        r.fill(this.selectionColor);
      }
    }

    // Value (or placeholder) text.
    const text = this.value || this.placeholder;
    const color = this.value ? this.color : this.placeholderColor;
    r.fillText(text, textOriginX, baseline, this.font, color);

    // IME composition underline.
    if (this.composition && this.composition.length > 0) {
      const ux0 = textOriginX + this.charOffset(this.composition.start);
      const ux1 = textOriginX + this.charOffset(this.composition.start + this.composition.length);
      const uy = baseline + 2;
      r.beginPath();
      r.moveTo(ux0, uy);
      r.lineTo(ux1, uy);
      r.stroke(this.color, 1);
    }

    // Blinking caret.
    if (this.focused && this.caretOn()) {
      const cx = this.caretScreenX();
      r.beginPath();
      r.moveTo(cx, this.height * 0.2);
      r.lineTo(cx, this.height * 0.8);
      r.stroke(this.color, 1);
    }

    r.restore();
  }
}
