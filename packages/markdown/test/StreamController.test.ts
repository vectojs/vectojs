// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../src/Markdown';
import {
  createStreamController,
  type StreamController,
  type StreamControllerOptions,
} from '../src/StreamController';

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pumpFrame(timestamp: number): void {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(timestamp);
}

function sourceOf(markdown: Markdown): string {
  const value: unknown = markdown;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('rawMarkdown' in value) ||
    typeof value.rawMarkdown !== 'string'
  ) {
    throw new Error('Markdown source is unavailable');
  }
  return value.rawMarkdown;
}

function streamField(markdown: Markdown, groupLabel: string, fieldLabel: string): number {
  const group = markdown
    .getDevtoolsDescriptor()
    .groups?.find((candidate) => candidate.label === groupLabel);
  const field = group?.fields.find((candidate) => candidate.label === fieldLabel);
  if (typeof field?.value !== 'number') {
    throw new Error(`Missing numeric ${groupLabel}/${fieldLabel} descriptor`);
  }
  return field.value;
}

function makeController(
  options: StreamControllerOptions = {},
  append?: (chunk: string) => void,
): {
  controller: StreamController;
  commits: string[];
  releaseCount: () => number;
} {
  const commits: string[] = [];
  let releases = 0;
  const controller = createStreamController(
    {
      append: append ?? ((chunk) => commits.push(chunk)),
      release: () => {
        releases++;
      },
    },
    options,
  );
  return { controller, commits, releaseCount: () => releases };
}

describe('StreamController', () => {
  it('coalesces a synchronous burst into one append in one frame', async () => {
    const { controller, commits } = makeController();
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 100; index++) writes.push(controller.write('x'));

    await Promise.all(writes);
    expect(frames.size).toBe(1);
    expect(commits).toEqual([]);

    pumpFrame(16);
    expect(commits).toEqual(['x'.repeat(100)]);
    expect(frames.size).toBe(0);
  });

  it('flushes synchronously when requestAnimationFrame is unavailable', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const { controller, commits } = makeController();

    await controller.write('immediate');

    expect(commits).toEqual(['immediate']);
    expect(controller.bufferedChars).toBe(0);
  });

  it('preserves direct Markdown append ordering including a blocked write', async () => {
    const markdown = new Markdown('');
    const controller = markdown.createStream({ maxBufferedChars: 1 });
    await controller.write('A');
    const blocked = controller.write('B');

    markdown.appendMarkdown('C');
    await blocked;
    await controller.close();

    expect(sourceOf(markdown)).toBe('ABC');
    expect(streamField(markdown, 'Streaming', 'appends')).toBe(2);
    expect(frames.size).toBe(0);
  });

  it('retains only one blocked write and admits it after capacity frees', async () => {
    const { controller, commits } = makeController({ maxBufferedChars: 3 });
    await controller.write('abc');
    let admitted = false;
    const blocked = controller.write('def').then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(controller.bufferedChars).toBe(6);
    await expect(controller.write('ghi')).rejects.toThrow('already has a blocked write');

    pumpFrame(16);
    await blocked;
    expect(commits).toEqual(['abc']);
    expect(controller.bufferedChars).toBe(3);
    expect(frames.size).toBe(1);

    pumpFrame(32);
    expect(commits).toEqual(['abc', 'def']);
    expect(controller.bufferedChars).toBe(0);
  });

  it('accepts one oversized chunk when the admitted queue is empty', async () => {
    const { controller, commits } = makeController({ maxBufferedChars: 3 });

    await controller.write('oversized');
    expect(controller.bufferedChars).toBe(9);
    pumpFrame(16);

    expect(commits).toEqual(['oversized']);
    expect(controller.bufferedChars).toBe(0);
  });

  it('close admits a blocked write, final-flushes once, and is idempotent', async () => {
    const { controller, commits, releaseCount } = makeController({ maxBufferedChars: 1 });
    await controller.write('A');
    const blocked = controller.write('B');

    const firstClose = controller.close();
    await blocked;
    await firstClose;
    await controller.close();

    expect(commits).toEqual(['AB']);
    expect(controller.state).toBe('closed');
    expect(frames.size).toBe(0);
    expect(releaseCount()).toBe(1);
    await expect(controller.write('C')).rejects.toThrow('closed');
  });

  it('rejects re-entrant writes and shares an in-progress close', async () => {
    let controller!: StreamController;
    let nestedClose: Promise<void> | null = null;
    let nestedWrite: Promise<void> | null = null;
    const created = makeController({}, () => {
      nestedWrite = controller.write('late');
      nestedClose = controller.close();
    });
    controller = created.controller;
    await controller.write('first');

    const outerClose = controller.close();

    expect(nestedClose).toBe(outerClose);
    await expect(nestedWrite!).rejects.toThrow('closing');
    await outerClose;
    expect(controller.state).toBe('closed');
    expect(controller.bufferedChars).toBe(0);
  });

  it('moves re-entrant frame writes to the next frame', async () => {
    let controller!: StreamController;
    const commits: string[] = [];
    const created = makeController({}, (chunk) => {
      commits.push(chunk);
      if (chunk === 'A') void controller.write('B');
    });
    controller = created.controller;
    await controller.write('A');

    pumpFrame(16);
    expect(commits).toEqual(['A']);
    expect(frames.size).toBe(1);

    pumpFrame(32);
    expect(commits).toEqual(['A', 'B']);
  });

  it('abort discards accepted and blocked text and retains one reason', async () => {
    const reason = new Error('cancelled');
    const { controller, commits, releaseCount } = makeController({ maxBufferedChars: 1 });
    await controller.write('A');
    const blocked = controller.write('B');
    const blockedRejection = expect(blocked).rejects.toBe(reason);

    controller.abort(reason);
    controller.abort(new Error('later'));

    await blockedRejection;
    expect(controller.state).toBe('aborted');
    expect(controller.bufferedChars).toBe(0);
    expect(commits).toEqual([]);
    expect(frames.size).toBe(0);
    expect(releaseCount()).toBe(1);
    await expect(controller.write('C')).rejects.toBe(reason);
    await expect(controller.close()).rejects.toBe(reason);
    expect(() => controller.flush()).toThrow(reason);
  });

  it('honors an already-aborted signal without scheduling', async () => {
    const signal = new AbortController();
    signal.abort('already stopped');
    const { controller, releaseCount } = makeController({ signal: signal.signal });

    expect(controller.state).toBe('aborted');
    expect(frames.size).toBe(0);
    expect(releaseCount()).toBe(1);
    await expect(controller.write('ignored')).rejects.toBe('already stopped');
  });

  it('removes signal listeners and retains an active signal reason', async () => {
    const closedSignal = new AbortController();
    const removeListener = vi.spyOn(closedSignal.signal, 'removeEventListener');
    const closed = makeController({ signal: closedSignal.signal }).controller;
    await closed.close();

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const activeSignal = new AbortController();
    const reason = new Error('signal cancelled');
    const { controller, commits } = makeController({ signal: activeSignal.signal });
    await controller.write('discard');
    activeSignal.abort(reason);
    pumpFrame(16);

    expect(controller.state).toBe('aborted');
    expect(commits).toEqual([]);
    await expect(controller.close()).rejects.toBe(reason);
  });

  it('destroy cancels the frame and releases the controller once', async () => {
    const { controller, commits, releaseCount } = makeController();
    await controller.write('discard');

    controller.destroy();
    controller.destroy();
    pumpFrame(16);

    expect(controller.state).toBe('aborted');
    expect(commits).toEqual([]);
    expect(releaseCount()).toBe(1);
  });

  it('retains a frame sink error instead of throwing from rAF', async () => {
    const sinkError = new Error('sink failed');
    const { controller, releaseCount } = makeController({}, () => {
      throw sinkError;
    });
    await controller.write('A');

    expect(() => pumpFrame(16)).not.toThrow();

    expect(controller.state).toBe('aborted');
    expect(releaseCount()).toBe(1);
    await expect(controller.write('B')).rejects.toBe(sinkError);
    await expect(controller.close()).rejects.toBe(sinkError);
  });

  it('rejects the current close when its forced commit fails', async () => {
    const sinkError = new Error('close failed');
    const { controller } = makeController({}, () => {
      throw sinkError;
    });
    await controller.write('A');

    await expect(controller.close()).rejects.toBe(sinkError);

    expect(controller.state).toBe('aborted');
    await expect(controller.close()).rejects.toBe(sinkError);
  });

  it('throws a forced flush sink failure synchronously', async () => {
    const sinkError = new Error('flush failed');
    const { controller } = makeController({}, () => {
      throw sinkError;
    });
    await controller.write('A');

    expect(() => controller.flush()).toThrow(sinkError);
    expect(controller.state).toBe('aborted');
  });

  it('paces by elapsed time rather than display frame count', async () => {
    const simulate = async (steps: number): Promise<number> => {
      frames.clear();
      const { controller, commits } = makeController({
        pacing: { graphemesPerSecond: 10 },
      });
      await controller.write('abcdefghijk');
      pumpFrame(0);
      for (let step = 1; step <= steps; step++) {
        const before = commits.length;
        pumpFrame((step * 1000) / steps);
        expect(commits.length - before).toBeLessThanOrEqual(1);
      }
      controller.destroy();
      return commits.join('').length;
    };

    const at60Hz = await simulate(60);
    const at240Hz = await simulate(240);

    expect(at60Hz).toBeGreaterThanOrEqual(9);
    expect(at60Hz).toBeLessThanOrEqual(10);
    expect(at240Hz).toBeGreaterThanOrEqual(9);
    expect(at240Hz).toBeLessThanOrEqual(10);
    expect(Math.abs(at60Hz - at240Hz)).toBeLessThanOrEqual(1);
  });

  it('clamps suspended-tab catch-up to 100ms', async () => {
    const { controller, commits } = makeController({
      pacing: { graphemesPerSecond: 10 },
    });
    await controller.write('abcdefghijk');

    pumpFrame(0);
    pumpFrame(1000);

    expect(commits.join('').length).toBe(1);
  });

  it.each([
    ['combining mark', 'e', '\u0301X', 'e\u0301'],
    ['ZWJ emoji', '👩', '\u200d💻X', '👩‍💻'],
    ['regional-indicator flag', '🇺', '🇳X', '🇺🇳'],
    ['surrogate pair', '\ud83d', '\udc69X', '👩'],
  ])('keeps a cross-frame %s intact', async (_label, first, second, expected) => {
    const { controller, commits } = makeController({
      pacing: { graphemesPerSecond: 1000 },
    });
    await controller.write(first);
    pumpFrame(0);
    pumpFrame(16);
    expect(commits).toEqual([]);
    expect(frames.size).toBe(0);

    await controller.write(second);
    pumpFrame(32);
    pumpFrame(48);

    expect(commits).toEqual([expected]);
    await controller.close();
    expect(commits.join('')).toBe(first + second);
  });

  it('uses a code-point boundary when one unbounded grapheme exhausts the buffer', async () => {
    const { controller, commits } = makeController({
      maxBufferedChars: 1,
      pacing: { graphemesPerSecond: 1000 },
    });
    await controller.write('e');
    pumpFrame(0);
    pumpFrame(16);
    const blocked = controller.write('\u0301');

    pumpFrame(32);
    pumpFrame(48);
    await blocked;

    expect(commits).toEqual(['e']);
    await controller.close();
    expect(commits.join('')).toBe('e\u0301');
  });

  it('validates finite positive limits before scheduling', () => {
    for (const maxBufferedChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeController({ maxBufferedChars })).toThrow(RangeError);
    }
    for (const graphemesPerSecond of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeController({ pacing: { graphemesPerSecond } })).toThrow(RangeError);
    }
    expect(frames.size).toBe(0);
  });

  it('binds one active controller to Markdown replacement and destruction', async () => {
    const markdown = new Markdown('original');
    const first = markdown.createStream();
    expect(() => markdown.createStream()).toThrow('already has an active StreamController');
    await first.write(' discarded');

    markdown.setContent('replacement');
    expect(first.state).toBe('aborted');
    expect(sourceOf(markdown)).toBe('replacement');

    const second = markdown.createStream();
    await second.write(' discarded');
    markdown.destroy();
    expect(second.state).toBe('aborted');
  });
});
