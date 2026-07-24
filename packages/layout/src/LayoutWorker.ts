import type { MSDFFontData } from '@vectojs/text';

export interface LayoutWorkerRequest {
  id: string;
  seqId: number;
  text: string;
  fontId: string;
  fontData?: MSDFFontData;
  maxWidth: number;
  maxHeight: number;
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
  /**
   * Horizontal alignment. `'justify'` stretches every wrapped line flush to
   * `maxWidth` (widening inter-word spaces, or distributing between glyphs on a
   * space-less CJK line); the paragraph-final line and any line ended by an
   * explicit newline stay ragged. Defaults to `'left'`.
   */
  textAlign?: 'left' | 'justify';
}

export interface LayoutWorkerResponse {
  id: string;
  seqId: number;
  width: number;
  height: number;
  codePoints: Uint32Array;
  xCoords: Float32Array;
  yCoords: Float32Array;
  packedStyles: Uint32Array;
}

const fontCache: Map<string, MSDFFontData> = new Map();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isExpectedOrigin(e: MessageEvent): boolean {
  if (!e.origin) return true;
  return e.origin === self.location.origin;
}

function isLayoutWorkerRequest(data: unknown): data is LayoutWorkerRequest {
  if (!data || typeof data !== 'object') return false;
  const request = data as Partial<LayoutWorkerRequest>;
  return (
    typeof request.id === 'string' &&
    isFiniteNumber(request.seqId) &&
    typeof request.text === 'string' &&
    typeof request.fontId === 'string' &&
    (request.fontData === undefined || typeof request.fontData === 'object') &&
    isFiniteNumber(request.maxWidth) &&
    isFiniteNumber(request.maxHeight) &&
    isFiniteNumber(request.fontSize) &&
    (request.lineHeight === undefined || isFiniteNumber(request.lineHeight)) &&
    (request.letterSpacing === undefined || isFiniteNumber(request.letterSpacing)) &&
    (request.textAlign === undefined ||
      request.textAlign === 'left' ||
      request.textAlign === 'justify')
  );
}

/**
 * Stretch each soft-wrapped line flush to `maxWidth` in place, mirroring
 * `LayoutEngine`'s justify pass: widen inter-word (space) gaps equally, or —
 * on a space-less CJK line — distribute the slack between every glyph. Guarded
 * against grotesque stretching on very short lines (slack capped at half the
 * line's span). Returns the possibly-updated `maxLineWidth`.
 */
function justifyLines(
  wrapClosedLines: Set<number>,
  lineOf: number[],
  xCoords: number[],
  codePoints: number[],
  advances: number[],
  maxWidth: number,
  maxLineWidth: number,
): number {
  const SPACE = 32;
  // Group glyph indices by line in one pass over the flat arrays.
  const byLine = new Map<number, number[]>();
  for (let i = 0; i < lineOf.length; i++) {
    const ln = lineOf[i];
    let arr = byLine.get(ln);
    if (!arr) {
      arr = [];
      byLine.set(ln, arr);
    }
    arr.push(i);
  }

  for (const line of wrapClosedLines) {
    const idx = byLine.get(line);
    if (!idx || idx.length === 0) continue;

    // Trailing spaces don't count toward the content end (a wrapped line can
    // keep the space that preceded the moved word).
    let lastContent = idx.length - 1;
    while (lastContent >= 0 && codePoints[idx[lastContent]] === SPACE) lastContent--;
    if (lastContent <= 0) continue;

    const runStartX = xCoords[idx[0]];
    const lastIdx = idx[lastContent];
    const contentEnd = xCoords[lastIdx] + advances[lastIdx];
    const slack = maxWidth - contentEnd;
    // Positive slack only, and never stretch a short line grotesquely.
    if (slack <= 0 || slack > (maxWidth - runStartX) * 0.5) continue;

    // Inter-word spaces (exclude the leading/trailing content bounds).
    const spaceIdx: number[] = [];
    for (let k = 1; k < lastContent; k++) {
      if (codePoints[idx[k]] === SPACE) spaceIdx.push(k);
    }

    if (spaceIdx.length > 0) {
      // Word-spaced line: widen each gap equally, shifting following glyphs.
      const extra = slack / spaceIdx.length;
      let shift = 0;
      let nextSpace = 0;
      for (let k = 0; k <= lastContent; k++) {
        xCoords[idx[k]] += shift;
        if (nextSpace < spaceIdx.length && k === spaceIdx[nextSpace]) {
          shift += extra;
          nextSpace++;
        }
      }
    } else {
      // Space-less (CJK) line: spread the slack between every glyph.
      const extra = slack / lastContent;
      for (let k = 1; k <= lastContent; k++) xCoords[idx[k]] += extra * k;
    }
    if (maxWidth > maxLineWidth) maxLineWidth = maxWidth;
  }
  return maxLineWidth;
}

self.onmessage = (e: MessageEvent) => {
  if (!isExpectedOrigin(e) || !isLayoutWorkerRequest(e.data)) {
    return;
  }

  const {
    id,
    seqId,
    text,
    fontId,
    fontData,
    maxWidth,
    maxHeight: _maxHeight,
    fontSize,
    lineHeight,
    letterSpacing,
    textAlign,
  } = e.data as LayoutWorkerRequest;

  if (fontData) {
    fontCache.set(fontId, fontData);
  }

  const font = fontCache.get(fontId);
  if (!font) {
    // Cannot layout without metrics
    return;
  }

  // Measure and wrap words
  const codePoints: number[] = [];
  const xCoords: number[] = [];
  const yCoords: number[] = [];
  const packedStyles: number[] = [];
  // Per-glyph line index, kept in lockstep with the arrays above so the justify
  // post-pass can group glyphs by line without recomputing from yCoords.
  const lineOf: number[] = [];
  // Advance width per glyph (no letter-spacing), so justify can measure a line's
  // true content end without re-looking-up the font.
  const advances: number[] = [];

  let curX = 0;
  let lineIndex = 0;
  let maxLineWidth = 0;
  // Index into the output arrays where the current word's first glyph landed;
  // -1 while in whitespace or after a per-glyph-breakable (CJK) character.
  let wordStartIdx = -1;
  const ascender = font.metrics?.ascender ?? 0.8;
  const descender = font.metrics?.descender ?? -0.2;
  const actualLineHeight = lineHeight ?? fontSize * (ascender - descender);
  const spacing = letterSpacing ?? 0;
  // Lines closed by a soft wrap (not an explicit newline, not end-of-text) are
  // the only ones justify stretches — a paragraph-final or newline-ended line
  // stays ragged, matching LayoutEngine's paragraph-final rule.
  const wrapClosedLines = new Set<number>();
  // Soft-hyphen (U+00AD) break opportunities recorded within the current word:
  // `at` is the output index of the first glyph *after* the break, `x` is the
  // curX where a visible hyphen would sit. Consumed at wrap time to break a
  // word mid-way instead of moving the whole word down. Cleared whenever the
  // word ends or its glyphs move lines (recorded x would otherwise be stale).
  let softBreaks: { at: number; x: number }[] = [];

  // O(1) advance lookup instead of a find() per character.
  const advanceByCode = new Map<number, number>();
  for (const g of font.glyphs ?? []) advanceByCode.set(g.unicode, g.advance);
  // '-' advance for wrap-time hyphen insertion (fallback ~0.3em if the font
  // lacks the glyph — the hyphen still renders via the Canvas2D fallback path).
  const hyphenWidth = (advanceByCode.get(0x2d) ?? 0.3) * fontSize;

  const breakLine = (soft: boolean) => {
    if (curX > maxLineWidth) maxLineWidth = curX;
    if (soft) wrapClosedLines.add(lineIndex);
    curX = 0;
    lineIndex++;
    wordStartIdx = -1;
    softBreaks = [];
  };

  /** Emit a visible hyphen glyph at (x, current line) — used at a soft-hyphen
   *  break. Rendered from its own coords, so appending out of order is fine. */
  const emitHyphen = (x: number, line: number) => {
    codePoints.push(0x2d);
    xCoords.push(x);
    lineOf.push(line);
    advances.push(hyphenWidth);
    yCoords.push(line * actualLineHeight + ascender * fontSize);
    packedStyles.push((0xffffff << 8) | 0);
  };

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!;
    if (code === 10) {
      breakLine(false); // explicit newline: hard break, never justified
      continue;
    }

    // Soft hyphen: an invisible break opportunity. Record where a visible
    // hyphen would go (curX) and which output glyph starts the tail, then
    // render nothing — matching LayoutEngine's soft-hyphen handling.
    if (code === 0x00ad) {
      if (curX > 0) softBreaks.push({ at: codePoints.length, x: curX });
      continue;
    }

    const advance = (advanceByCode.get(code) ?? 1) * fontSize;

    // CJK/ideographs/emoji have no space-delimited words — break before any glyph.
    const breakableAnywhere = code >= 0x2e80;
    if (breakableAnywhere) wordStartIdx = -1;

    if (curX + advance > maxWidth && curX > 0) {
      if (code === 32) {
        breakLine(true); // swallow the wrapping space entirely
        continue;
      }
      // Prefer a soft-hyphen break: the last recorded opportunity whose hyphen
      // still fits the line splits the word here rather than moving it whole.
      let hy = -1;
      for (let s = softBreaks.length - 1; s >= 0; s--) {
        if (softBreaks[s].x + hyphenWidth <= maxWidth) {
          hy = s;
          break;
        }
      }
      if (hy >= 0) {
        const brk = softBreaks[hy];
        const brokenLine = lineIndex;
        if (brk.x + hyphenWidth > maxLineWidth) maxLineWidth = brk.x + hyphenWidth;
        wrapClosedLines.add(brokenLine); // hyphenated line can be justified
        // Move the tail (glyphs from brk.at onward) onto the next line FIRST,
        // then append the hyphen — appending first would let the move loop
        // (j < length) drag the hyphen down onto the new line too.
        const shift = xCoords[brk.at];
        lineIndex++;
        const nodeY = lineIndex * actualLineHeight + ascender * fontSize;
        for (let j = brk.at; j < xCoords.length; j++) {
          xCoords[j] -= shift;
          yCoords[j] = nodeY;
          lineOf[j] = lineIndex;
        }
        curX -= shift;
        emitHyphen(brk.x, brokenLine); // visible hyphen stays on the old line
        wordStartIdx = brk.at;
        softBreaks = [];
      } else if (wordStartIdx >= 0 && xCoords[wordStartIdx] > 0) {
        // Keep the word intact: move its already-placed glyphs onto a new line.
        const shift = xCoords[wordStartIdx];
        if (shift > maxLineWidth) maxLineWidth = shift;
        wrapClosedLines.add(lineIndex); // the line the word left behind wrapped
        lineIndex++;
        const nodeY = lineIndex * actualLineHeight + ascender * fontSize;
        for (let j = wordStartIdx; j < xCoords.length; j++) {
          xCoords[j] -= shift;
          yCoords[j] = nodeY;
          lineOf[j] = lineIndex;
        }
        curX -= shift;
        softBreaks = [];
      } else {
        // No usable word boundary on this line (word longer than maxWidth, or
        // CJK): break before this glyph.
        breakLine(true);
      }
    }

    if (code === 32) {
      wordStartIdx = -1;
      softBreaks = [];
    } else if (wordStartIdx === -1 && !breakableAnywhere) {
      wordStartIdx = codePoints.length;
    }

    codePoints.push(code);
    xCoords.push(curX);
    lineOf.push(lineIndex);
    advances.push(advance);

    // Baseline yCoords calculation (nodeY = node.y + ascender * fontSize)
    yCoords.push(lineIndex * actualLineHeight + ascender * fontSize);

    // Color white tint default: packed RGB 0xFFFFFF (bits 8-31) + flags (bit 0 = normal)
    packedStyles.push((0xffffff << 8) | 0);

    curX += advance + spacing;
  }
  if (curX > maxLineWidth) maxLineWidth = curX;

  if (textAlign === 'justify' && wrapClosedLines.size > 0) {
    maxLineWidth = justifyLines(
      wrapClosedLines,
      lineOf,
      xCoords,
      codePoints,
      advances,
      maxWidth,
      maxLineWidth,
    );
  }

  const response: LayoutWorkerResponse = {
    id,
    seqId,
    width: maxLineWidth,
    height: (lineIndex + 1) * actualLineHeight,
    codePoints: new Uint32Array(codePoints),
    xCoords: new Float32Array(xCoords),
    yCoords: new Float32Array(yCoords),
    packedStyles: new Uint32Array(packedStyles),
  };

  (self as any).postMessage(response, [
    response.codePoints.buffer,
    response.xCoords.buffer,
    response.yCoords.buffer,
    response.packedStyles.buffer,
  ]);
};
