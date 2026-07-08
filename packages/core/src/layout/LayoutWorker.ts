import { MSDFFontData } from '../text/MSDFFont';

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
    (request.letterSpacing === undefined || isFiniteNumber(request.letterSpacing))
  );
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

  // O(1) advance lookup instead of a find() per character.
  const advanceByCode = new Map<number, number>();
  for (const g of font.glyphs ?? []) advanceByCode.set(g.unicode, g.advance);

  const breakLine = () => {
    if (curX > maxLineWidth) maxLineWidth = curX;
    curX = 0;
    lineIndex++;
    wordStartIdx = -1;
  };

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!;
    if (code === 10) {
      breakLine();
      continue;
    }

    const advance = (advanceByCode.get(code) ?? 1) * fontSize;

    // CJK/ideographs/emoji have no space-delimited words — break before any glyph.
    const breakableAnywhere = code >= 0x2e80;
    if (breakableAnywhere) wordStartIdx = -1;

    if (curX + advance > maxWidth && curX > 0) {
      if (code === 32) {
        breakLine(); // swallow the wrapping space entirely
        continue;
      }
      if (wordStartIdx >= 0 && xCoords[wordStartIdx] > 0) {
        // Keep the word intact: move its already-placed glyphs onto a new line.
        const shift = xCoords[wordStartIdx];
        if (shift > maxLineWidth) maxLineWidth = shift;
        lineIndex++;
        const nodeY = lineIndex * actualLineHeight + ascender * fontSize;
        for (let j = wordStartIdx; j < xCoords.length; j++) {
          xCoords[j] -= shift;
          yCoords[j] = nodeY;
        }
        curX -= shift;
      } else {
        // No usable word boundary on this line (word longer than maxWidth, or
        // CJK): break before this glyph.
        breakLine();
      }
    }

    if (code === 32) wordStartIdx = -1;
    else if (wordStartIdx === -1 && !breakableAnywhere) wordStartIdx = codePoints.length;

    codePoints.push(code);
    xCoords.push(curX);

    // Baseline yCoords calculation (nodeY = node.y + ascender * fontSize)
    yCoords.push(lineIndex * actualLineHeight + ascender * fontSize);

    // Color white tint default: packed RGB 0xFFFFFF (bits 8-31) + flags (bit 0 = normal)
    packedStyles.push((0xffffff << 8) | 0);

    curX += advance + spacing;
  }
  if (curX > maxLineWidth) maxLineWidth = curX;

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
