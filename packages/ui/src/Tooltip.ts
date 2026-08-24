import { Entity, IRenderer } from '@vectojs/core';
import { Overlay, OverlayPlacement } from './Overlay';
import { measureText, fontSizePx } from './measure';

export interface TooltipOptions {
  /** The entity this tooltip is attached to. */
  target: Entity;
  /** Text content of the tooltip. */
  content: string;
  /** Preferred placement. Default `'top'`. */
  placement?: OverlayPlacement;
  /** Delay in milliseconds before the tooltip appears. Default `320`. */
  delay?: number;
  font?: string;
  color?: string;
  bg?: string;
}

/** Widest box the tooltip may occupy; text wraps within it instead of drawing
 *  unclipped past the edge (the old length*7.5 estimate capped the BOX while
 *  the text kept going). */
const TOOLTIP_MAX_WIDTH = 320;
/** Horizontal padding on both sides of the text. */
const TOOLTIP_PAD_X = 10;

/**
 * Greedy word-wrap for tooltip text: split on spaces, break a word wider than
 * the line at the character level. Returns at least one line.
 */
function wrapTooltipText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (measure(word) > maxWidth && word.length > 1) {
      // Flush the current line, then char-break the oversized word.
      if (current) {
        lines.push(current);
        current = '';
      }
      let chunk = '';
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    } else if (current && measure(`${current} ${word}`) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * A hover-triggered tooltip that appears near a target entity after a short delay.
 * Add once to the scene; it manages its own show/hide lifecycle.
 *
 * @example
 * const tooltip = new Tooltip({ target: myButton, content: 'Save file (Ctrl+S)' });
 * scene.add(tooltip);
 */
export class Tooltip extends Overlay {
  private _font: string;
  private _textColor: string;
  private _bg: string;
  private _delay: number;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _target: Entity;
  private _onHover: () => void;
  private _onLeave: () => void;
  /** Wrapped lines actually drawn — one per visual row inside the box. */
  private _lines: string[];

  constructor(opts: TooltipOptions) {
    const font = opts.font ?? '12px sans-serif';
    const maxInner = TOOLTIP_MAX_WIDTH - TOOLTIP_PAD_X * 2;
    const fullW = measureText(opts.content, font);
    // Fits → one line exactly as written; otherwise wrap inside the cap so no
    // glyph is ever painted past the measured box.
    const lines =
      fullW <= maxInner
        ? [opts.content]
        : wrapTooltipText(opts.content, maxInner, (s) => measureText(s, font));
    const lineH = fontSizePx(font) * 1.25;
    super({
      width: Math.min(fullW, maxInner) + TOOLTIP_PAD_X * 2,
      height: Math.max(30, lines.length * lineH + 14),
      placement: opts.placement ?? 'top',
      offset: 8,
    });
    this._lines = lines;
    this._font = opts.font ?? '12px sans-serif';
    this._textColor = opts.color ?? '#e2e8f0';
    this._bg = opts.bg ?? 'rgba(15,15,30,0.92)';
    this._delay = opts.delay ?? 320;
    this._target = opts.target;

    this._onHover = () => {
      // Re-hover before the delay elapsed: restart instead of stacking timers.
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.showAt(opts.target);
      }, this._delay);
    };
    this._onLeave = () => {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this.hide();
    };
    opts.target.on('hover', this._onHover);
    opts.target.on('pointerleave', this._onLeave);
  }

  public override destroy(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // Otherwise the (still-alive) target keeps a closure referencing this
    // destroyed tooltip, and a later hover would resurrect it into the tree.
    this._target.off('hover', this._onHover);
    this._target.off('pointerleave', this._onLeave);
    super.destroy();
  }

  public render(r: IRenderer): void {
    // Background + border
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.fill(this._bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 6);
    r.stroke('rgba(255,255,255,0.12)', 1);
    // Label — one fillText per wrapped line, so long content stays inside the
    // box instead of drawing unclipped past it.
    const lineH = fontSizePx(this._font) * 1.25;
    const firstBaseline = this.height / 2 - ((this._lines.length - 1) * lineH) / 2 + 4;
    this._lines.forEach((line, i) => {
      r.fillText(line, TOOLTIP_PAD_X, firstBaseline + i * lineH, this._font, this._textColor);
    });
  }
}
