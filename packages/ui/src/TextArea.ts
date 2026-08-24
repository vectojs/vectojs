import { A11yAttributes, cssLineBoxBaseline, IRenderer, LayoutEngine } from '@vectojs/core';
import { UIComponent } from './UIComponent';
import { measureText, fontSizePx } from './measure';

/** One visual line produced by {@link wrapText}: its text plus the absolute char range it spans. */
export interface WrappedLine {
  /** The line's rendered text (no trailing newline). */
  text: string;
  /** Absolute offset into the source value where this line begins. */
  start: number;
  /** Absolute offset into the source value where this line ends (exclusive). */
  end: number;
  /**
   * Paragraph-relative minimum `sourceIndex` over the line's layout nodes.
   * Set by TextArea's internal `computeLines` (absent on `wrapText` output).
   * Needed because the nodes are kept in VISUAL (x-sorted) order, so the
   * source-first node is not `nodes[0]` on an RTL line — see `offsetX`.
   */
  minSourceIndex?: number;
}

/**
 * Greedily wrap `value` into lines no wider than `maxWidth`, tracking each line's
 * absolute character range so a linear caret offset can be mapped to a visual
 * (line, x) position. Honors hard newlines (the `\n` is consumed, so a trailing
 * newline yields a trailing empty line the caret can sit on) and breaks an
 * over-long single word at the character level.
 *
 * @param value - The full text.
 * @param maxWidth - Max line width in the same unit `measure` returns.
 * @param measure - Width of a string (e.g. `(s) => measureText(s, font)`).
 * @returns One {@link WrappedLine} per visual line (always at least one).
 */
export function wrapText(
  value: string,
  maxWidth: number,
  measure: (s: string) => number,
): WrappedLine[] {
  const lines: WrappedLine[] = [];

  // Hard split on '\n', tracking each paragraph's absolute start offset.
  let paraStart = 0;
  const paragraphs: Array<{ start: number; text: string }> = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') {
      paragraphs.push({ start: paraStart, text: value.slice(paraStart, i) });
      paraStart = i + 1;
    }
  }
  paragraphs.push({ start: paraStart, text: value.slice(paraStart) });

  for (const para of paragraphs) {
    if (para.text === '') {
      lines.push({ text: '', start: para.start, end: para.start });
      continue;
    }
    softWrap(para.text, para.start, maxWidth, measure, lines);
  }
  return lines;
}

/** Greedy word-wrap of a single (newline-free) paragraph, appending to `lines`. */
function softWrap(
  text: string,
  base: number,
  maxWidth: number,
  measure: (s: string) => number,
  lines: WrappedLine[],
): void {
  let lineText = '';
  let lineStart = base;
  let lineEnd = base;
  let started = false;

  /** Begin a fresh line at `word`, char-breaking it first if it alone overflows. */
  const startWith = (word: string, absStart: number) => {
    if (measure(word) <= maxWidth || word.length <= 1) {
      lineText = word;
      lineStart = absStart;
      lineEnd = absStart + word.length;
      return;
    }
    // Word wider than the box: emit full chunks, keep the remainder as the line.
    let chunkStart = absStart;
    let chunk = '';
    for (let k = 0; k < word.length; k++) {
      const c = word[k];
      if (chunk !== '' && measure(chunk + c) > maxWidth) {
        lines.push({
          text: chunk,
          start: chunkStart,
          end: chunkStart + chunk.length,
        });
        chunkStart += chunk.length;
        chunk = c;
      } else {
        chunk += c;
      }
    }
    lineText = chunk;
    lineStart = chunkStart;
    lineEnd = chunkStart + chunk.length;
  };

  let i = 0;
  while (i < text.length) {
    const ws = i;
    while (i < text.length && text[i] !== ' ') i++;
    const word = text.slice(ws, i);
    // Consume the separator space(s) — they collapse at the wrap point.
    while (i < text.length && text[i] === ' ') i++;
    if (word === '') continue; // leading/standalone spaces

    if (!started) {
      startWith(word, base + ws);
      started = true;
    } else if (measure(`${lineText} ${word}`) <= maxWidth) {
      lineText = `${lineText} ${word}`;
      lineEnd = base + ws + word.length;
    } else {
      lines.push({ text: lineText, start: lineStart, end: lineEnd });
      startWith(word, base + ws);
    }
  }

  if (started) {
    lines.push({ text: lineText, start: lineStart, end: lineEnd });
  } else {
    lines.push({ text: '', start: base, end: base });
  }
}

/** Construction options for {@link TextArea}. */
export interface TextAreaOptions {
  /**
   * Mark the field as required. Projected as `required`, so a screen reader
   * announces the constraint instead of the user discovering it on submit.
   */
  required?: boolean;
  /**
   * Mark the field as failing validation. Projected as `aria-invalid` and drawn
   * with an error border — a red outline alone is invisible to assistive tech.
   */
  invalid?: boolean;
  /** Box width in pixels. */
  width: number;
  /** Box height in pixels. Default `120`. */
  height?: number;
  /** Placeholder shown when empty. */
  placeholder?: string;
  /** Initial value. Default `''`. */
  value?: string;
  /** CSS font shorthand. Default `'16px sans-serif'`. */
  font?: string;
  /** Line height as a multiple of the font size. Default `1.4`. */
  lineHeight?: number;
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
 * A multi-line text field backed by a real, transparent `<textarea>` shadow node.
 * The browser handles all editing — keyboard, **IME composition**, selection,
 * clipboard, undo, multi-line navigation — natively on that element; the canvas
 * is a pure visual mirror. Value and caret/selection flow back via the `change`
 * event, and the canvas re-wraps and draws the text, selection, and caret. So an
 * agent (or assistive tech) can `fill()` it by role and a human can type CJK,
 * while the rendering stays Zero-DOM.
 *
 * @example new TextArea({ width: 320, height: 160, placeholder: 'Notes…' });
 */
/** Error border for an invalid field. Colour alone is never the only signal —
 *  `aria-invalid` carries it to assistive tech (WCAG 1.4.1). */
const INVALID_BORDER = '#ef4444';

export class TextArea extends UIComponent {
  public value: string;
  private _required = false;
  private _invalid = false;
  public placeholder: string;
  public font: string;
  public lineHeightFactor: number;
  public color: string;
  public placeholderColor: string;
  public bg: string;
  public border: string;
  public selectionColor: string;
  public radius: number;

  /** Caret / selection anchor & focus offsets, mirrored from the real textarea. */
  public selectionStart: number;
  public selectionEnd: number;
  /** Active IME pre-edit range `[start, start+length)`, or `null`. */
  public composition: { start: number; length: number } | null = null;
  /** Whether the shadow textarea currently holds focus (drives caret blink). */
  public focused = false;

  /** Vertical scroll offset of the drawn view, in CSS pixels. */
  private scrollTop = 0;
  /**
   * Whether the shadow `<textarea>` has reported a scroll offset. Once it has,
   * it is the authority: the browser owns this element's scrolling (wheel,
   * scrollbar drag, caret-into-view) and every offset it reports for a click is
   * measured against *its* view. The caret-following fallback below must then
   * stop writing `scrollTop`, or the two fight and a click lands on the wrong
   * line. Stays `false` when there is no mirror (no scene, or a headless
   * environment), where caret-following is the only thing that can scroll.
   */
  private mirrorOwnsScroll = false;

  constructor(opts: TextAreaOptions) {
    super();
    this.width = opts.width;
    this.height = opts.height ?? 120;
    this.value = opts.value ?? '';
    this._required = opts.required ?? false;
    this._invalid = opts.invalid ?? false;
    this.placeholder = opts.placeholder ?? '';
    this.font = opts.font ?? '16px sans-serif';
    this.lineHeightFactor = opts.lineHeight ?? 1.4;
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

    // Drop the keyed wrap cache when a webfont finishes loading: the key is
    // (value, font, width), so the same key would hit after the font's pixels
    // changed and wrap points would disagree with the painted ink until an
    // edit re-keyed it. computeLines() re-wraps on the next call (see
    // watchFontMetrics).
    this.watchFontMetrics(() => {
      this.cachedValue = '';
      this.cachedFont = '';
      this.cachedWidth = 0;
      this.cachedLines = [];
      this.scene?.markDirty();
    });

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
    this.on('focus', () => {
      this.focused = true;
      this.startCaretBlinkWake();
    });
    this.on('blur', () => {
      this.focused = false;
      this.stopCaretBlinkWake();
    });
    // Follow the shadow textarea's own scrolling. This is what makes the wheel
    // work: the browser already scrolled the real element (it is the topmost
    // node under the pointer), so the canvas only has to draw the same view.
    // It equally covers a scrollbar drag and the browser scrolling the caret
    // back into view after a keystroke — and because the mirror's offset is the
    // one a click's `selectionStart` is measured against, following it is also
    // what keeps the caret landing where the user clicked.
    this.on('scroll', (e: { scrollTop: number }) => {
      this.mirrorOwnsScroll = true;
      if (this.scrollTop === e.scrollTop) return;
      this.scrollTop = e.scrollTop;
      this.scene?.markDirty();
    });
  }

  /**
   * Whether the field is required. Kept as accessors so the drawn state and the
   * projected constraint cannot drift apart.
   */
  public get required(): boolean {
    return this._required;
  }

  public set required(value: boolean) {
    if (this._required === value) return;
    this._required = value;
    this.scene?.markDirty();
  }

  /** Whether the field currently fails validation. */
  public get invalid(): boolean {
    return this._invalid;
  }

  public set invalid(value: boolean) {
    if (this._invalid === value) return;
    this._invalid = value;
    this.scene?.markDirty();
  }

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'textarea',
      placeholder: this.placeholder,
      value: this.value,
      label: this.placeholder,
      // `undefined` when not set, not `false`: the projection removes an
      // undefined attribute, whereas `aria-invalid="false"` means "explicitly
      // valid" and is deliberately preserved — so only emit these when they hold.
      required: this._required ? true : undefined,
      invalid: this._invalid ? true : undefined,
      textInputStyle: {
        font: this.font,
        lineHeight: this.lineHeight(),
        padding: this.padding,
      },
    };
  }

  private innerWidth(): number {
    return this.width - 2 * this.padding;
  }

  private lineHeight(): number {
    return fontSizePx(this.font) * this.lineHeightFactor;
  }

  private cachedValue: string = '';
  private cachedFont: string = '';
  private cachedWidth: number = 0;
  private cachedLines: WrappedLine[] = [];

  /** Wrap the current value to the inner box width. */
  private computeLines(): WrappedLine[] {
    const innerW = this.innerWidth();
    if (
      this.value === this.cachedValue &&
      this.font === this.cachedFont &&
      innerW === this.cachedWidth &&
      this.cachedLines.length > 0
    ) {
      return this.cachedLines;
    }

    const lines: WrappedLine[] = [];
    const paragraphs = this.value.split('\n');
    let pStart = 0;
    const fSize = fontSizePx(this.font);

    const engine = new LayoutEngine(innerW, 1000000, {
      measure: (char: string) => measureText(char, this.font),
    });
    engine.preserveLeadingSpaces = true;

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const paragraphText = paragraphs[pIdx];
      if (paragraphText === '') {
        lines.push({ text: '', start: pStart, end: pStart });
        pStart += 1; // consume '\n'
        continue;
      }

      const layout = engine.layoutText(paragraphText, {}, fSize);

      const lineGroups: any[][] = [];
      let currentGroup: any[] = [];
      let currentY = -1;

      for (const node of layout.nodes) {
        if (currentY === -1) {
          currentY = node.y;
        }
        if (Math.abs(node.y - currentY) > 0.1 * fSize) {
          lineGroups.push(currentGroup);
          currentGroup = [node];
          currentY = node.y;
        } else {
          currentGroup.push(node);
        }
      }
      if (currentGroup.length > 0) {
        lineGroups.push(currentGroup);
      }

      if (lineGroups.length === 0) {
        lines.push({
          text: '',
          start: pStart,
          end: pStart + paragraphText.length,
        });
      } else {
        for (const group of lineGroups) {
          // Visual (x) order — this is what makes `nodes[0]` the visually
          // leftmost glyph, which for an RTL run is the source-LAST node. So
          // `minSourceIndex` must be captured here, before any caller assumes
          // source order.
          group.sort((a, b) => a.x - b.x);

          const text = group.map((n) => n.char).join('');

          let start = paragraphText.length;
          let end = 0;
          let minSourceIndex = paragraphText.length;
          for (const node of group) {
            const nodeStart = node.sourceIndex ?? 0;
            const nodeLen = node.sourceLength ?? 0;
            if (nodeStart < start) start = nodeStart;
            if (nodeStart < minSourceIndex) minSourceIndex = nodeStart;
            if (nodeStart + nodeLen > end) end = nodeStart + nodeLen;
          }

          lines.push({
            text,
            start: pStart + start,
            end: pStart + end,
            nodes: group,
            minSourceIndex,
          } as any);
        }
      }

      pStart += paragraphText.length + 1;
    }

    this.cachedValue = this.value;
    this.cachedFont = this.font;
    this.cachedWidth = innerW;
    this.cachedLines = lines;
    return lines;
  }

  /**
   * The visual line index containing caret `offset` (0-based). Boundary offsets
   * resolve to the earliest containing line; out-of-range clamps to the last.
   *
   * @param offset - A linear character offset into the value.
   * @returns The wrapped-line index.
   */
  public lineOfOffset(offset: number): number {
    const lines = this.computeLines();
    for (let i = 0; i < lines.length; i++) {
      if (offset >= lines[i].start && offset <= lines[i].end) return i;
    }
    return lines.length - 1;
  }

  /** X (text-relative) of `offset` within its line. */
  private offsetX(line: any, offset: number): number {
    if (!line.nodes || line.nodes.length === 0) return 0;

    // Base on the line's minimum sourceIndex, NOT nodes[0]: the nodes are in
    // visual (x) order, so on an RTL line nodes[0] is the source-LAST node and
    // a nodes[0]-based base shifts every offset by the run length.
    const pStart = line.start - (line.minSourceIndex ?? 0);
    let targetNode: any = null;
    let isRTL = false;

    for (const node of line.nodes) {
      const nodeAbsStart = pStart + (node.sourceIndex ?? 0);
      const len = node.sourceLength ?? 0;
      if (offset >= nodeAbsStart && offset <= nodeAbsStart + len) {
        targetNode = node;
        isRTL = !!node.isRTL;
        if (offset > nodeAbsStart && offset < nodeAbsStart + len) {
          break;
        }
      }
    }

    if (!targetNode) {
      let maxNode = line.nodes[0];
      for (const node of line.nodes) {
        const nodeAbsStart = pStart + (node.sourceIndex ?? 0);
        const maxAbsStart = pStart + (maxNode.sourceIndex ?? 0);
        if (nodeAbsStart + (node.sourceLength ?? 0) > maxAbsStart + (maxNode.sourceLength ?? 0)) {
          maxNode = node;
        }
      }
      targetNode = maxNode;
      isRTL = !!maxNode.isRTL;
    }

    const nodeAbsStart = pStart + (targetNode.sourceIndex ?? 0);
    const len = targetNode.sourceLength ?? 0;
    const fraction = len > 0 ? (offset - nodeAbsStart) / len : 0;

    if (isRTL) {
      return targetNode.x + targetNode.width * (1.0 - fraction);
    } else {
      return targetNode.x + targetNode.width * fraction;
    }
  }

  /**
   * Keep the caret line within the padded box by adjusting `scrollTop`.
   *
   * A fallback only. It runs while no mirror has reported a scroll offset — a
   * headless render, or before the shadow textarea has scrolled — and yields
   * permanently once one has. It cannot be the primary mechanism because it is
   * driven by the caret rather than by the view: with the caret seeded to the
   * end of the value it scrolls to the bottom on the very first frame, while
   * the freshly-projected mirror is still at 0. Measured before this gate, that
   * put the canvas 640px (32.6 lines) from the view every click offset was
   * being resolved against.
   */
  private updateScroll(caretLine: number, lh: number, innerH: number): void {
    if (this.mirrorOwnsScroll) return;
    const caretY = caretLine * lh;
    if (caretY - this.scrollTop > innerH - lh) this.scrollTop = caretY - (innerH - lh);
    if (caretY - this.scrollTop < 0) this.scrollTop = caretY;
    if (this.scrollTop < 0) this.scrollTop = 0;
  }

  private caretOn(): boolean {
    return Math.floor(Date.now() / 500) % 2 === 0;
  }

  public render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    r.fill(this.bg);
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, this.radius);
    // An invalid field gets a heavier error border. Under forced colors the OS
    // owns contrast, so defer to its system colour rather than a themed red.
    if (this._invalid) {
      r.stroke(this.scene?.forcedColors ? 'LinkText' : INVALID_BORDER, 2);
    } else {
      r.stroke(this.border, 1);
    }

    const lines = this.computeLines();
    const lh = this.lineHeight();
    const innerW = this.innerWidth();
    const innerH = this.height - 2 * this.padding;

    const caretLine = this.lineOfOffset(this.selectionStart);
    this.updateScroll(caretLine, lh, innerH);

    const originX = this.padding;
    const originY = this.padding - this.scrollTop;
    const baselineOffset = cssLineBoxBaseline(this.font, lh);

    r.save();
    r.clip(this.padding, this.padding, innerW, innerH);

    // Placeholder (only when empty).
    if (!this.value && this.placeholder) {
      r.fillText(
        this.placeholder,
        originX,
        originY + baselineOffset,
        this.font,
        this.placeholderColor,
      );
    }

    // Selection highlight across lines (drawn behind the text). Suppressed while
    // an IME composition is active for the same reason as in `Input`: composing
    // over a selection replaces that range, but the native element keeps
    // reporting the pre-composition offsets until commit, so the highlight would
    // be stale. The composition underline below marks the active region instead.
    const composing = !!this.composition && this.composition.length > 0;
    if (!composing && this.selectionStart !== this.selectionEnd) {
      const a = Math.min(this.selectionStart, this.selectionEnd);
      const b = Math.max(this.selectionStart, this.selectionEnd);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as any;
        const lo = Math.max(a, line.start);
        const hi = Math.min(b, line.end);
        if (hi <= lo) continue;

        const y = originY + i * lh;

        if (!line.nodes || line.nodes.length === 0) {
          // Fallback for empty/whitespace-only selection
          const sx = originX + this.offsetX(line, lo);
          const ex = originX + this.offsetX(line, hi);
          r.beginPath();
          r.roundRect(sx, y, Math.max(1, ex - sx), lh, 0);
          r.fill(this.selectionColor);
        } else {
          // Precise per-glyph highlight
          r.beginPath();
          // Same base-offset rule as offsetX: minSourceIndex, not nodes[0]
          // (visual order), or RTL lines compare shifted offsets and the wrong
          // glyphs light up.
          const pStart = line.start - (line.minSourceIndex ?? 0);
          for (const node of line.nodes) {
            const start = pStart + (node.sourceIndex ?? 0);
            const len = node.sourceLength ?? 0;
            if (!(start + len <= lo || start >= hi)) {
              r.roundRect(originX + node.x, y, node.width, lh, 0);
            }
          }
          r.fill(this.selectionColor);
        }
      }
    }

    // Text, line by line.
    if (this.value) {
      for (let i = 0; i < lines.length; i++) {
        r.fillText(
          lines[i].text,
          originX,
          originY + i * lh + baselineOffset,
          this.font,
          this.color,
        );
      }
    }

    // IME composition underline. Marks the text the IME is still composing (not
    // yet committed) — the only in-canvas feedback that a multi-keystroke
    // conversion is in progress. Drawn per line so a composition that wraps is
    // underlined on every line it covers.
    if (composing && this.composition) {
      const cs = this.composition.start;
      const ce = cs + this.composition.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lo = Math.max(cs, line.start);
        const hi = Math.min(ce, line.end);
        if (hi <= lo) continue;
        const ux0 = originX + this.offsetX(line, lo);
        const ux1 = originX + this.offsetX(line, hi);
        const uy = originY + i * lh + baselineOffset + 2;
        r.beginPath();
        r.moveTo(ux0, uy);
        r.lineTo(ux1, uy);
        r.stroke(this.color, 1);
      }
    }

    // Blinking caret.
    if (this.focused && this.caretOn()) {
      const line = lines[caretLine];
      const cx = originX + this.offsetX(line, this.selectionStart);
      const cy = originY + caretLine * lh;
      r.beginPath();
      r.moveTo(cx, cy + 2);
      r.lineTo(cx, cy + lh - 2);
      r.stroke(this.color, 1);
    }

    r.restore();
  }
}
