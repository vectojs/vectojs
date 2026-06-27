// @vitest-environment jsdom
import { test, expect, beforeAll, vi } from 'vitest';
import { LayoutWorkerManager } from '../src/layout/LayoutWorkerManager';

// Mock Worker and URL.createObjectURL since they are not supported in JSDOM/Node environment
class MockWorker {
  public onmessage?: (e: MessageEvent) => void;
  public postMessage(data: any) {
    const { id, seqId, text, fontSize, lineHeight } = data;
    const codePoints = Array.from(text).map((c) => c.charCodeAt(0));
    const xCoords = codePoints.map((_, i) => i * 10);
    const yCoords = codePoints.map(() => fontSize);
    const packedStyles = codePoints.map(() => (0xffffff << 8) | 0);
    const actualLineHeight = lineHeight ?? fontSize * 1.0;

    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage({
          data: {
            id,
            seqId,
            width: text.length * 10,
            height: actualLineHeight,
            codePoints: new Uint32Array(codePoints),
            xCoords: new Float32Array(xCoords),
            yCoords: new Float32Array(yCoords),
            packedStyles: new Uint32Array(packedStyles),
          },
        } as MessageEvent);
      }
    }, 10);
  }
  public terminate() {}
}

beforeAll(() => {
  globalThis.Worker = MockWorker as any;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

test('LayoutWorkerManager singleton queuing and metrics cache registration', async () => {
  const manager = LayoutWorkerManager.getInstance();
  expect(manager).toBeDefined();

  let receivedResult = false;
  manager.queueLayout('test-entity', 'Hello', {
    fontId: 'mock-font',
    fontSize: 24,
    maxWidth: 200,
    maxHeight: 200,
    fontData: {
      id: 'mock-font',
      glyphs: [],
      metrics: { ascender: 0.8, descender: -0.2 },
      atlas: { type: 'msdf', width: 512, height: 512, yOrigin: 'bottom' },
    } as any,
    callback: (res) => {
      expect(res.width).toBeGreaterThan(0);
      receivedResult = true;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(receivedResult).toBe(true);
});
