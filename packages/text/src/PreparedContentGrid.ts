import { ArabicShaper } from './ArabicShaper';
import { BidiResolver } from './BidiResolver';

export interface PreparedContentGridCell {
  /** UTF-16 source start, matching DOM Range offsets. */
  readonly sourceStart: number;
  /** UTF-16 source end, matching DOM Range offsets. */
  readonly sourceEnd: number;
  /** Legal UTF-16 caret offsets relative to `sourceStart`. */
  readonly sourceCaretOffsets: readonly number[];
  /** Contextually shaped glyph text used by the canvas painter. */
  readonly glyph: string;
  /** Visual x coordinate inside the line. */
  readonly x: number;
  /** Grid advance in local CSS pixels. */
  readonly advance: number;
  /** Resolved bidi embedding level. */
  readonly level: number;
}

export interface PreparedContentGridLine {
  /** Start of this logical line in {@link PreparedContentGrid.source}. */
  readonly sourceStart: number;
  /** End of visible line content, excluding the hard break. */
  readonly sourceEnd: number;
  /** Start of the next line, thereby owning the intervening hard break. */
  readonly nextSourceStart: number;
  /** Total visual grid width in local CSS pixels. */
  readonly width: number;
  /** Cells stay in logical source order; their x coordinates encode visual order. */
  readonly cells: readonly PreparedContentGridCell[];
}

/**
 * Immutable source-aware geometry shared by canvas grid text and its semantic
 * DOM projection. It deliberately remains independent of syntax highlighting.
 */
export interface PreparedContentGrid {
  readonly kind: 'content-grid';
  readonly revision: number;
  readonly source: string;
  readonly font: string;
  readonly cellWidth: number;
  readonly lineHeight: number;
  readonly baseline: number;
  readonly tabSize: number;
  readonly lines: readonly PreparedContentGridLine[];
}

export interface PrepareContentGridOptions {
  /** CSS font shorthand shared by canvas and the projected DOM. */
  font: string;
  /** Width of one grid column in local CSS pixels. */
  cellWidth: number;
  /** Visual line advance in local CSS pixels. */
  lineHeight: number;
  /** Canvas baseline relative to each line's top. */
  baseline: number;
  /** Number of columns between tab stops. Defaults to 4. */
  tabSize?: number;
}

interface MutableCell {
  sourceStart: number;
  sourceEnd: number;
  sourceCaretOffsets: readonly number[];
  glyph: string;
  x: number;
  advance: number;
  level: number;
  char: string;
}

let nextRevision = 1;

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

const MARK = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const BIDI_CONTROL = /\p{Bidi_Control}/u;
const EAST_ASIAN_WIDE =
  /[ᄀ-ᅟ⌚-⌛⏩-⏬⏰⏳◽-◾⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

interface GraphemePart {
  segment: string;
  index: number;
}

function codePointAt(text: string, index: number): { value: string; next: number } {
  const point = text.codePointAt(index);
  if (point === undefined) return { value: '', next: index };
  const value = String.fromCodePoint(point);
  return { value, next: index + value.length };
}

/** Deterministic fallback for the clusters that affect grid geometry. */
function fallbackGraphemes(text: string): GraphemePart[] {
  const parts: GraphemePart[] = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    let current = codePointAt(text, index);
    let segment = current.value;
    index = current.next;
    let regionalCount = REGIONAL_INDICATOR.test(segment) ? 1 : 0;

    while (index < text.length) {
      current = codePointAt(text, index);
      const point = current.value.codePointAt(0) ?? 0;
      const isVariation = point >= 0xfe00 && point <= 0xfe0f;
      const isEmojiModifier = point >= 0x1f3fb && point <= 0x1f3ff;
      const isKeycap = point === 0x20e3;
      if (MARK.test(current.value) || isVariation || isEmojiModifier || isKeycap) {
        segment += current.value;
        index = current.next;
        continue;
      }
      if (REGIONAL_INDICATOR.test(current.value) && regionalCount === 1) {
        segment += current.value;
        index = current.next;
        regionalCount++;
        continue;
      }
      if (point === 0x200d) {
        segment += current.value;
        index = current.next;
        if (index < text.length) {
          current = codePointAt(text, index);
          segment += current.value;
          index = current.next;
        }
        continue;
      }
      break;
    }
    parts.push({ segment, index: start });
  }
  return parts;
}

function graphemes(text: string): GraphemePart[] {
  if (!graphemeSegmenter) return fallbackGraphemes(text);
  return Array.from(graphemeSegmenter.segment(text), (part) => ({
    segment: part.segment,
    index: part.index,
  }));
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isWideCluster(cluster: string): boolean {
  if (EXTENDED_PICTOGRAPHIC.test(cluster) || REGIONAL_INDICATOR.test(cluster)) return true;
  if (cluster.includes('\u20e3')) return true;
  if (EAST_ASIAN_WIDE.test(cluster)) return true;
  const point = cluster.codePointAt(0) ?? 0;
  return point >= 0x20000 && point <= 0x3fffd;
}

interface SourceLine {
  sourceStart: number;
  sourceEnd: number;
  nextSourceStart: number;
  text: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (true) {
    let end = start;
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end++;
    if (end === source.length) {
      lines.push({
        sourceStart: start,
        sourceEnd: end,
        nextSourceStart: end,
        text: source.slice(start),
      });
      break;
    }
    const next = source[end] === '\r' && source[end + 1] === '\n' ? end + 2 : end + 1;
    lines.push({
      sourceStart: start,
      sourceEnd: end,
      nextSourceStart: next,
      text: source.slice(start, end),
    });
    start = next;
    if (start === source.length) {
      lines.push({ sourceStart: start, sourceEnd: start, nextSourceStart: start, text: '' });
      break;
    }
  }
  return lines;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

/**
 * Compile logical source into one retained grid plan. Canvas paint and native
 * text projection must consume this same object rather than re-segmenting it.
 */
export function prepareContentGrid(
  source: string,
  options: PrepareContentGridOptions,
): PreparedContentGrid {
  assertPositiveFinite(options.cellWidth, 'cellWidth');
  assertPositiveFinite(options.lineHeight, 'lineHeight');
  if (!Number.isFinite(options.baseline)) throw new RangeError('baseline must be finite');
  const tabSize = options.tabSize ?? 4;
  if (!Number.isInteger(tabSize) || tabSize <= 0) {
    throw new RangeError('tabSize must be a positive integer');
  }

  const rawLines = sourceLines(source);
  const lines: PreparedContentGridLine[] = [];

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const sourceLine = rawLines[lineIndex];
    const rawLine = sourceLine.text;
    const { sourceStart: lineStart, sourceEnd, nextSourceStart } = sourceLine;
    const rawCaretBoundaries = [
      0,
      ...graphemes(rawLine).map((grapheme) => grapheme.index + grapheme.segment.length),
    ];
    const shaped = ArabicShaper.shapeArabic(rawLine);
    const shapedParts = graphemes(shaped.shapedText);
    const levels = BidiResolver.resolveLevels(shaped.shapedText);
    const cells: MutableCell[] = [];
    let column = 0;

    for (let index = 0; index < shapedParts.length; index++) {
      const part = shapedParts[index];
      const sourceOffset = shaped.indexMap[part.index] ?? part.index;
      const nextPart = shapedParts[index + 1];
      const sourceOffsetEnd = nextPart
        ? (shaped.indexMap[nextPart.index] ?? nextPart.index)
        : rawLine.length;
      const raw = rawLine.slice(sourceOffset, sourceOffsetEnd);
      const sourceCaretOffsets = [0];
      for (
        let caretIndex = lowerBound(rawCaretBoundaries, sourceOffset + 1);
        caretIndex < rawCaretBoundaries.length && rawCaretBoundaries[caretIndex] < sourceOffsetEnd;
        caretIndex++
      ) {
        sourceCaretOffsets.push(rawCaretBoundaries[caretIndex] - sourceOffset);
      }
      if (sourceCaretOffsets.at(-1) !== sourceOffsetEnd - sourceOffset) {
        sourceCaretOffsets.push(sourceOffsetEnd - sourceOffset);
      }
      let columns: number;
      if (BIDI_CONTROL.test(raw)) columns = 0;
      else if (raw === '\t') columns = tabSize - (column % tabSize);
      else columns = isWideCluster(raw) ? 2 : 1;
      const advance = columns * options.cellWidth;
      cells.push({
        sourceStart: lineStart + sourceOffset,
        sourceEnd: lineStart + sourceOffsetEnd,
        sourceCaretOffsets: Object.freeze(sourceCaretOffsets),
        glyph: part.segment,
        x: 0,
        advance,
        level: levels[part.index] ?? 0,
        char: part.segment,
      });
      column += columns;
    }

    const visualCells = [...cells];
    BidiResolver.reorderVisual(visualCells, BidiResolver.getBaseLevel(shaped.shapedText));
    let visualX = 0;
    for (const cell of visualCells) {
      cell.x = visualX;
      visualX += cell.advance;
    }

    const frozenCells = cells.map(({ char: _char, ...cell }) => Object.freeze(cell));
    lines.push(
      Object.freeze({
        sourceStart: lineStart,
        sourceEnd,
        nextSourceStart,
        width: visualX,
        cells: Object.freeze(frozenCells),
      }),
    );
  }

  return Object.freeze({
    kind: 'content-grid',
    revision: nextRevision++,
    source,
    font: options.font,
    cellWidth: options.cellWidth,
    lineHeight: options.lineHeight,
    baseline: options.baseline,
    tabSize,
    lines: Object.freeze(lines),
  });
}
