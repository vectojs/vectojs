import { A11yAttributes, IRenderer } from '@vecto-ui/core';
import { UIComponent } from './UIComponent';
import { measureText, wrapLines } from './measure';

/** Construction options for {@link Text}. */
export interface TextOptions {
  /** CSS font shorthand. Default `'16px sans-serif'`. */
  font?: string;
  /** Fill color. Default `'#e2e8f0'`. */
  color?: string;
  /** Wrap width in pixels. When omitted, only explicit newlines break lines. */
  maxWidth?: number;
  /** Line advance in pixels. Default `20`. */
  lineHeight?: number;
}

/**
 * A multi-line text component rendered with native canvas `fillText`.
 *
 * Projects a `div` shadow node carrying the text as its accessible name.
 *
 * @example new Text('Hello world', { maxWidth: 200 }).setPosition(20, 20);
 */
export class Text extends UIComponent {
  public text: string;
  public font: string;
  public color: string;
  public maxWidth?: number;
  public lineHeight: number;
  private lines: string[] = [];

  constructor(text: string, opts: TextOptions = {}) {
    super();
    this.text = text;
    this.font = opts.font ?? '16px sans-serif';
    this.color = opts.color ?? '#e2e8f0';
    this.maxWidth = opts.maxWidth;
    this.lineHeight = opts.lineHeight ?? 20;
    this.interactive = true;
    this.layout();
  }

  /**
   * Replace the text and re-run layout (updates wrapped lines and box size).
   *
   * @param text - The new text content.
   * @returns `this` for chaining.
   */
  public setText(text: string): this {
    this.text = text;
    this.layout();
    return this;
  }

  private layout(): void {
    this.lines =
      this.maxWidth != null
        ? wrapLines(this.text, this.font, this.maxWidth)
        : this.text.split('\n');
    this.width = this.lines.reduce((max, l) => Math.max(max, measureText(l, this.font)), 0);
    this.height = this.lines.length * this.lineHeight;
  }

  public getA11yAttributes(): A11yAttributes {
    return { label: this.text };
  }

  public render(r: IRenderer): void {
    for (let i = 0; i < this.lines.length; i++) {
      r.fillText(this.lines[i], 0, (i + 0.8) * this.lineHeight, this.font, this.color);
    }
  }
}
