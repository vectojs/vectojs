import type { MSDFFontData } from '@vectojs/text';
import { computeMSDFLayout } from './msdfLayout';

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
  /**
   * Set when the request could not be laid out (e.g. the font id is unknown —
   * no metrics were ever posted for it). The geometry buffers are then
   * zero-length. A bare `return` here used to leave the requester's callback
   * pending forever, indistinguishable from a crashed worker.
   */
  error?: string;
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

self.onmessage = (e: MessageEvent) => {
  if (!isExpectedOrigin(e) || !isLayoutWorkerRequest(e.data)) {
    return;
  }

  const request = e.data as LayoutWorkerRequest;
  if (request.fontData) {
    fontCache.set(request.fontId, request.fontData);
  }

  const font = fontCache.get(request.fontId);
  if (!font) {
    // Cannot layout without metrics. Reply with an error-shaped response
    // rather than returning silently: a dropped request left its pending
    // callback waiting forever, reading exactly like a hung worker.
    (self as any).postMessage({
      id: request.id,
      seqId: request.seqId,
      width: 0,
      height: 0,
      codePoints: new Uint32Array(0),
      xCoords: new Float32Array(0),
      yCoords: new Float32Array(0),
      packedStyles: new Uint32Array(0),
      error: `unknown-font:${request.fontId}`,
    });
    return;
  }

  // The algorithm itself lives in `msdfLayout.ts` so the main thread can run the
  // identical code when no worker is available (CSP, SSR, worker crash) instead
  // of leaving the text permanently unlaid-out. esbuild inlines it into this
  // worker's bundle, so there is no import at runtime.
  const response = computeMSDFLayout(request, font);

  (self as any).postMessage(response, [
    response.codePoints.buffer,
    response.xCoords.buffer,
    response.yCoords.buffer,
    response.packedStyles.buffer,
  ]);
};
