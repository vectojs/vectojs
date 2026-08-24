// @vitest-environment jsdom
import { test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { LayoutWorkerManager } from '../src/LayoutWorkerManager';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from '../src/LayoutWorker';

/**
 * Font metrics good enough for the main-thread fallback to produce real
 * geometry. The pre-existing tests pass `{ glyphs: [], metrics: {} }`, which the
 * MockWorker ignores; `computeMSDFLayout` actually reads these, so the fallback
 * assertions need real advances.
 */
const metricsFont = {
  atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 256, height: 256, yOrigin: 'bottom' },
  metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 0x61, advance: 0.5 }, // a
    { unicode: 0x46, advance: 0.6 }, // F
    { unicode: 0x69, advance: 0.3 }, // i
    { unicode: 0x72, advance: 0.4 }, // r
    { unicode: 0x73, advance: 0.4 }, // s
    { unicode: 0x74, advance: 0.3 }, // t
    { unicode: 0x20, advance: 0.25 },
  ],
} as unknown as LayoutWorkerRequest['fontData'];

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

test('a worker error completes the abandoned layout on the main thread and recreates', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const abandoned = vi.fn();
  manager.queueLayout('first', 'First', {
    fontId: 'font-a',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
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
    fontData: metricsFont,
    callback: next,
  });

  // The whole point of the fix: the in-flight request is finished here rather
  // than dropped. Dropping it left `MSDFTextEntity.layoutResult` null forever,
  // and `render()` early-returns on that — permanently invisible text.
  expect(abandoned).toHaveBeenCalledTimes(1);
  const res = abandoned.mock.calls[0][0] as LayoutWorkerResponse;
  expect(res.id).toBe('first');
  expect(res.codePoints).toHaveLength(5); // 'First'
  expect(res.width).toBeGreaterThan(0);
  expect(res.height).toBeGreaterThan(0);

  expect(failedWorker.terminated).toBe(true);
  expect(MockWorker.instances).toHaveLength(2);
  expect(MockWorker.instances[1].posts).toHaveLength(1);
});

test('a second consecutive worker failure stops recreation and stays on the main thread', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const results: LayoutWorkerResponse[] = [];
  const opts = {
    fontId: 'font-a',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: (r: LayoutWorkerResponse) => results.push(r),
  };

  // Fail the first worker, then the one that replaces it.
  manager.queueLayout('e1', 'aa', opts);
  MockWorker.instances[0].onerror?.(new Event('error'));
  manager.queueLayout('e2', 'aa', opts);
  MockWorker.instances[1].onerror?.(new Event('error'));

  const workersAfterTwoFailures = MockWorker.instances.length;

  // Every later request is served synchronously, with no further Worker churn.
  manager.queueLayout('e3', 'aa', opts);
  manager.queueLayout('e4', 'aa', opts);

  expect(MockWorker.instances).toHaveLength(workersAfterTwoFailures);
  expect(results.map((r) => r.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
});

test('a healthy reply resets the failure count so an isolated error stays transient', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const opts = {
    fontId: 'font-a',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: vi.fn(),
  };

  manager.queueLayout('a', 'aa', opts);
  MockWorker.instances[0].onerror?.(new Event('error')); // failure 1

  // Let the replacement worker answer successfully.
  manager.queueLayout('b', 'aa', opts);
  await new Promise((r) => setTimeout(r, 30));

  MockWorker.instances[1].onerror?.(new Event('error')); // failure 1 again, not 2
  manager.queueLayout('c', 'aa', opts);

  // Still recreating: the successful reply cleared the streak, so this is not
  // treated as a permanently worker-hostile environment.
  expect(MockWorker.instances).toHaveLength(3);
});

test('no Worker at all: layout is computed on the calling thread, not dropped', () => {
  const savedWorker = globalThis.Worker;
  (globalThis as { Worker?: unknown }).Worker = undefined;
  try {
    const manager = (activeManager = LayoutWorkerManager.getInstance());
    const cb = vi.fn();
    manager.queueLayout('ssr', 'aa', {
      fontId: 'font-a',
      fontSize: 16,
      maxWidth: 200,
      maxHeight: 200,
      fontData: metricsFont,
      callback: cb,
    });

    expect(MockWorker.instances).toHaveLength(0);
    expect(cb).toHaveBeenCalledTimes(1);
    const res = cb.mock.calls[0][0] as LayoutWorkerResponse;
    expect(res.codePoints).toHaveLength(2);
    expect(res.width).toBeGreaterThan(0);
  } finally {
    globalThis.Worker = savedWorker;
  }
});

test('a throwing Worker constructor does not escape queueLayout', () => {
  const savedWorker = globalThis.Worker;
  // A constructor-only class IS the stub: the test needs `new Worker()` to
  // throw, which cannot be expressed without a constructor.
  // oxlint-disable-next-line typescript/no-extraneous-class
  globalThis.Worker = class {
    constructor() {
      throw new DOMException('Blocked', 'SecurityError');
    }
  } as unknown as typeof Worker;
  try {
    let manager!: LayoutWorkerManager;
    expect(() => {
      manager = activeManager = LayoutWorkerManager.getInstance();
    }).not.toThrow();
    const cb = vi.fn();
    // Measured 2026-07-31: a real CSP fires onerror rather than throwing here,
    // but `new Worker` can still throw (exhausted pool, rejected URL) and that
    // exception used to propagate out of `new MSDFTextEntity(...)`.
    expect(() => {
      manager.queueLayout('throws', 'aa', {
        fontId: 'font-a',
        fontSize: 16,
        maxWidth: 200,
        maxHeight: 200,
        fontData: metricsFont,
        callback: cb,
      });
    }).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.Worker = savedWorker;
  }
});

test('main-thread fallback reuses font metrics from an earlier request', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  // First request carries the metrics and is answered by the worker.
  manager.queueLayout('e1', 'aa', {
    fontId: 'font-cached',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: vi.fn(),
  });

  const cb = vi.fn();
  // Second request omits fontData (the option is optional) and the worker dies.
  manager.queueLayout('e2', 'aa', {
    fontId: 'font-cached',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    callback: cb,
  });
  MockWorker.instances[0].onerror?.(new Event('error'));

  expect(cb).toHaveBeenCalledTimes(1);
  expect((cb.mock.calls[0][0] as LayoutWorkerResponse).width).toBeGreaterThan(0);
});

test('a request with no font metrics anywhere resolves with an error response', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const cb = vi.fn();
  manager.queueLayout('nofont', 'aa', {
    fontId: 'font-never-supplied',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    callback: cb,
  });

  // Nothing to lay out against, so the pre-flight guard resolves the callback
  // immediately with an error-shaped response instead of posting it into the
  // worker's unknown-font drop (which used to hang the caller forever).
  expect(cb).toHaveBeenCalledTimes(1);
  const res = cb.mock.calls[0]![0] as LayoutWorkerResponse;
  expect(res.error).toBe('unknown-font:font-never-supplied');
  expect(res.id).toBe('nofont');
  expect(res.codePoints.length).toBe(0);
});

test('the unknown-font warning fires once per font id, not per request', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (let i = 0; i < 3; i++) {
      manager.queueLayout('spammy', 'aa', {
        fontId: 'font-never-supplied',
        fontSize: 16,
        maxWidth: 200,
        maxHeight: 200,
        callback: () => undefined,
      });
    }
    const unknownFontWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('font-never-supplied'),
    );
    expect(unknownFontWarnings.length).toBe(1);
  } finally {
    warn.mockRestore();
  }
});

test('a restarted worker gets stored metrics re-sent for callers that omit fontData', () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  // First request registers 'font-restart' with the live worker.
  manager.queueLayout('e1', 'aa', {
    fontId: 'font-restart',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: vi.fn(),
  });
  expect(MockWorker.instances[0].posts[0].fontData).toBeDefined();

  // The worker dies: registeredFonts is cleared and a replacement is created.
  MockWorker.instances[0].onerror?.(new Event('error'));

  const cb = vi.fn();
  // This caller omits fontData — documented as optional after the first call
  // because the manager retains the metrics. A restarted worker starts with an
  // empty font cache, so unless the manager re-sends them the worker's
  // unknown-fontId guard swallows the request and cb never fires (#672).
  manager.queueLayout('e2', 'aa', {
    fontId: 'font-restart',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    callback: cb,
  });

  const posts = MockWorker.instances[1].posts as LayoutWorkerRequest[];
  expect(posts).toHaveLength(1);
  expect(posts[0].fontData).toBe(metricsFont);
});

test('a stale reply after cancel is not routed to the replacement request', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const cancelledCb = vi.fn();
  manager.queueLayout('race', 'AAA', {
    fontId: 'f',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: cancelledCb,
  });

  // Cancel while the worker is still processing the request above…
  manager.cancelLayout('race');
  // …then immediately queue again for the same entity id. With the counter
  // deleted by cancelLayout, both requests carried seqId 1, so the stale
  // in-flight reply for 'AAA' matched the NEW pending entry and handed the
  // old geometry to the new callback (#673).
  const freshCb = vi.fn();
  manager.queueLayout('race', 'BB', {
    fontId: 'f',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: freshCb,
  });

  // The replacement goes through the normal 50ms debounce (the kept counter no
  // longer re-arms a leading-edge immediate run), then the mock replies ~10ms
  // later.
  await new Promise((r) => setTimeout(r, 120));
  expect(cancelledCb).not.toHaveBeenCalled();
  expect(freshCb).toHaveBeenCalledTimes(1);
  expect((freshCb.mock.calls[0][0] as LayoutWorkerResponse).codePoints).toHaveLength(2);
});

test('cancelLayout purges only the target entity, not hyphen-prefix siblings', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  // 'text' + '-' is a hyphen-boundary prefix of sibling id 'text-1': cancelling
  // 'text' used to purge 'text-1-<seq>' too, silently cancelling the other
  // entity's in-flight layout (#675).
  const siblingCb = vi.fn();
  manager.queueLayout('text-1', 'aa', {
    fontId: 'f',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: siblingCb,
  });
  const cb = vi.fn();
  manager.queueLayout('text', 'bb', {
    fontId: 'f',
    fontSize: 16,
    maxWidth: 200,
    maxHeight: 200,
    fontData: metricsFont,
    callback: cb,
  });

  manager.cancelLayout('text');
  await new Promise((r) => setTimeout(r, 60));

  expect(cb).not.toHaveBeenCalled();
  expect(siblingCb).toHaveBeenCalledTimes(1);
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

test('cancelLayoutForEntity does NOT resurrect the singleton when none exists', () => {
  // No manager instantiated yet in this test (beforeEach cleared instances,
  // afterEach destroyed the prior one) — cancelling for a destroyed MSDF
  // entity must stay a no-op, not spawn a Worker (would throw in SSR).
  expect(MockWorker.instances).toHaveLength(0);

  LayoutWorkerManager.cancelLayoutForEntity('entity-that-never-queued');

  expect(MockWorker.instances).toHaveLength(0);
});

test('cancelLayoutForEntity delegates to the live singleton when one exists', async () => {
  const manager = (activeManager = LayoutWorkerManager.getInstance());
  const cb = vi.fn();
  manager.queueLayout('e1', 'hello', {
    fontId: 'f',
    fontSize: 16,
    maxWidth: 100,
    maxHeight: 100,
    // Servable metrics: the request reaches the worker, so the cancel below
    // is what actually prevents the callback.
    fontData: metricsFont,
    callback: cb,
  });
  // Cancel before the (setTimeout-scheduled) worker response would arrive.
  LayoutWorkerManager.cancelLayoutForEntity('e1');
  await new Promise((r) => setTimeout(r, 5));
  expect(cb).not.toHaveBeenCalled();
  // Did not spawn an extra worker.
  expect(MockWorker.instances).toHaveLength(1);
});

test('SSR-safe: no Worker → getInstance + queueLayout do not throw and no-op', () => {
  const savedWorker = globalThis.Worker;
  // Simulate a server / non-DOM environment.
  (globalThis as any).Worker = undefined;
  try {
    let manager!: LayoutWorkerManager;
    expect(() => {
      manager = activeManager = LayoutWorkerManager.getInstance();
    }).not.toThrow();
    const cb = vi.fn();
    expect(() => {
      manager.queueLayout('ssr', 'hi', {
        fontId: 'f',
        fontSize: 16,
        maxWidth: 100,
        maxHeight: 100,
        callback: cb,
      });
    }).not.toThrow();
    // No worker was created and the pending callback wasn't retained.
    expect(MockWorker.instances).toHaveLength(0);
  } finally {
    globalThis.Worker = savedWorker;
  }
});
