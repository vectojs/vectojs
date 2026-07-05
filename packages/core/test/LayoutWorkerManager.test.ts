// @vitest-environment jsdom
import { test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { LayoutWorkerManager } from '../src/layout/LayoutWorkerManager';

// Mock Worker and URL.createObjectURL since they are not supported in JSDOM/Node environment
class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage?: (e: MessageEvent) => void;
  public onerror?: (e: Event) => void;
  public onmessageerror?: (e: MessageEvent) => void;
  public terminated = false;
  public posts: any[] = [];

  constructor() {
    MockWorker.instances.push(this);
  }

  public postMessage(data: any) {
    this.posts.push(data);
    const { id, seqId, text, fontSize, lineHeight } = data;
    const codePoints = Array.from(text).map((c) => c.charCodeAt(0));
    const xCoords = codePoints.map((_, i) => i * 10);
    const yCoords = codePoints.map(() => fontSize);
    const packedStyles = codePoints.map(() => (0xffffff << 8) | 0);
    const actualLineHeight = lineHeight ?? fontSize * 1.0;

    setTimeout(() => {
      if (!this.terminated && this.onmessage) {
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
  public terminate() {
    this.terminated = true;
  }
}

let activeManager: LayoutWorkerManager | null = null;

beforeAll(() => {
  globalThis.Worker = MockWorker as any;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  MockWorker.instances.length = 0;
});

afterEach(() => {
  activeManager?.destroy();
  activeManager = null;
});

test('LayoutWorkerManager singleton queuing and metrics cache registration', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
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

test('cancelLayout drops an in-flight callback for that entity', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const callback = vi.fn();
  manager.queueLayout('cancelled', 'Hello', {
    fontId: 'font-a',
    fontSize: 24,
    maxWidth: 200,
    maxHeight: 200,
    fontData: { glyphs: [], metrics: {} },
    callback,
  });

  manager.cancelLayout('cancelled');
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(callback).not.toHaveBeenCalled();
});

test('a worker error releases pending callbacks and recreates before the next request', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const abandoned = vi.fn();
  manager.queueLayout('first', 'First', {
    fontId: 'font-a',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: { glyphs: [], metrics: {} },
    callback: abandoned,
  });
  const failedWorker = MockWorker.instances[0];

  failedWorker.onerror?.(new Event('error'));

  const next = vi.fn();
  manager.queueLayout('second', 'Second', {
    fontId: 'font-a',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: { glyphs: [], metrics: {} },
    callback: next,
  });

  expect(abandoned).not.toHaveBeenCalled();
  expect(failedWorker.terminated).toBe(true);
  expect(MockWorker.instances).toHaveLength(2);
  expect(MockWorker.instances[1].posts).toHaveLength(1);
});

test('destroy clears singleton ownership so getInstance returns a live manager', () => {
  const first = LayoutWorkerManager.getInstance();
  const firstWorker = MockWorker.instances[0];
  first.destroy();

  const second = (activeManager = LayoutWorkerManager.getInstance());

  expect(second).not.toBe(first);
  expect(firstWorker.terminated).toBe(true);
  expect(MockWorker.instances).toHaveLength(2);
  expect(MockWorker.instances[1].terminated).toBe(false);
});
