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

self.onmessage = (e: MessageEvent) => {
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
  const ascender = font.metrics?.ascender ?? 0.8;
  const descender = font.metrics?.descender ?? -0.2;
  const actualLineHeight = lineHeight ?? fontSize * (ascender - descender);

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)!;
    // Resolve advance width
    const glyph = font.glyphs?.find((g: any) => g.unicode === code);
    const advance = (glyph?.advance ?? 1) * fontSize;

    if (curX + advance > maxWidth && code === 32) {
      // space wraps
      curX = 0;
      lineIndex++;
    }

    codePoints.push(code);
    xCoords.push(curX);

    // Baseline yCoords calculation (nodeY = node.y + ascender * fontSize)
    const lineY = lineIndex * actualLineHeight;
    const nodeY = lineY + ascender * fontSize;
    yCoords.push(nodeY);

    // Color white tint default: packed RGB 0xFFFFFF (bits 8-31) + flags (bit 0 = normal)
    const packedStyle = (0xffffff << 8) | 0;
    packedStyles.push(packedStyle);

    curX += advance + (letterSpacing ?? 0);
  }

  const response: LayoutWorkerResponse = {
    id,
    seqId,
    width: Math.min(curX, maxWidth),
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
