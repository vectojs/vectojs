import { describe, expect, it, vi } from 'vitest';
import { ExportSession, type ExportSessionDependencies } from '../src/export-session.js';
import type { NormalizedExportOptions } from '../src/options.js';

const PNG_BASE64 = Buffer.from('png-frame').toString('base64');

function options(overrides: Partial<NormalizedExportOptions> = {}): NormalizedExportOptions {
  return {
    url: '/project/scene.ts',
    outputPath: '/project/export.mp4',
    width: 1280,
    height: 720,
    fps: 25,
    duration: 0.08,
    isRemote: false,
    totalFrames: 2,
    dt: 40,
    ...overrides,
  };
}

interface Harness {
  events: string[];
  dependencies: ExportSessionDependencies;
  evaluate: ReturnType<typeof vi.fn>;
  encoderWrite: ReturnType<typeof vi.fn>;
  progressUpdate: ReturnType<typeof vi.fn>;
  outputCommit: ReturnType<typeof vi.fn>;
  failAt(stage: string, error?: Error): void;
}

function harness(): Harness {
  const events: string[] = [];
  const failures = new Map<string, Error>();
  const failAt = (stage: string, error = new Error(`${stage} failed`)) =>
    failures.set(stage, error);
  const run = async <T>(stage: string, value: T): Promise<T> => {
    events.push(stage);
    const failure = failures.get(stage);
    if (failure) throw failure;
    return value;
  };
  const evaluate = vi.fn(async (operation: unknown, argument?: number) => {
    const source = String(operation);
    if (source.includes('hasStop: typeof')) {
      events.push('scene.validate');
      return { hasStop: true, hasStep: true };
    }
    if (source.includes('scene.stop')) return run('scene.stop', undefined);
    if (source.includes('scene.step')) return run(`scene.step:${String(argument)}`, undefined);
    if (source.includes('toDataURL')) return run('page.capture', PNG_BASE64);
    throw new Error(`Unexpected page evaluation: ${source}`);
  });
  const encoderWrite = vi.fn(async (frame: Uint8Array) => {
    events.push(`ffmpeg.write:${Buffer.from(frame).toString()}`);
    const failure = failures.get('ffmpeg.write');
    if (failure) throw failure;
  });
  const progressUpdate = vi.fn((frame: number) => events.push(`progress.update:${frame}`));
  const outputCommit = vi.fn(async () => run('output.commit', undefined));

  const dependencies: ExportSessionDependencies = {
    resolveInputTarget: async () => {
      const target = await run('target.acquire', {
        url: 'http://127.0.0.1:4000/scene',
        close: async () => run('target.close', undefined),
      });
      events.push('target.acquired');
      return target;
    },
    createStagedOutput: () => {
      events.push('output.acquire');
      const failure = failures.get('output.acquire');
      if (failure) throw failure;
      events.push('output.acquired');
      return {
        path: '/project/.export.vecto-id.mp4',
        commit: outputCommit,
        cleanup: async () => run('output.cleanup', undefined),
      };
    },
    launchBrowser: async () => {
      const browser = await run('browser.acquire', {
        newPage: async () =>
          run('page.acquire', {
            setViewport: async () => run('page.viewport', undefined),
            goto: async () => run('page.goto', undefined),
            waitForFunction: async () => run('scene.wait', undefined),
            evaluate,
          }),
        close: async () => run('browser.close', undefined),
      });
      events.push('browser.acquired');
      return browser;
    },
    startFfmpeg: () => {
      events.push('ffmpeg.acquire');
      const failure = failures.get('ffmpeg.acquire');
      if (failure) throw failure;
      events.push('ffmpeg.acquired');
      return {
        write: encoderWrite,
        finish: async () => run('ffmpeg.finish', undefined),
        terminate: async () => run('ffmpeg.terminate', undefined),
      };
    },
    createProgress: () => {
      events.push('progress.acquire');
      const failure = failures.get('progress.acquire');
      if (failure) throw failure;
      events.push('progress.acquired');
      return {
        start: () => events.push('progress.start'),
        update: progressUpdate,
        stop: () => {
          events.push('progress.stop');
          const failure = failures.get('progress.stop');
          if (failure) throw failure;
        },
      };
    },
    log: vi.fn(),
  };

  return {
    events,
    dependencies,
    evaluate,
    encoderWrite,
    progressUpdate,
    outputCommit,
    failAt,
  };
}

describe('ExportSession', () => {
  it('steps and captures every frame before atomically committing output', async () => {
    const fixture = harness();

    await new ExportSession(options(), fixture.dependencies).run();

    expect(fixture.evaluate).toHaveBeenCalled();
    expect(fixture.events.filter((event) => event === 'scene.step:40')).toHaveLength(2);
    expect(fixture.encoderWrite).toHaveBeenCalledTimes(2);
    expect(fixture.encoderWrite).toHaveBeenNthCalledWith(1, Buffer.from('png-frame'));
    expect(fixture.progressUpdate).toHaveBeenNthCalledWith(1, 1);
    expect(fixture.progressUpdate).toHaveBeenNthCalledWith(2, 2);
    expect(fixture.events.indexOf('ffmpeg.finish')).toBeLessThan(
      fixture.events.indexOf('output.commit'),
    );
    expect(fixture.outputCommit).toHaveBeenCalledOnce();
    expect(fixture.events.slice(-5)).toEqual([
      'progress.stop',
      'ffmpeg.terminate',
      'browser.close',
      'target.close',
      'output.cleanup',
    ]);
  });

  it.each([
    'target.acquire',
    'output.acquire',
    'browser.acquire',
    'page.acquire',
    'page.viewport',
    'page.goto',
    'scene.wait',
    'scene.stop',
    'ffmpeg.acquire',
    'progress.acquire',
    'page.capture',
    'ffmpeg.write',
    'ffmpeg.finish',
    'output.commit',
  ])('cleans every acquired resource when %s fails', async (stage) => {
    const fixture = harness();
    fixture.failAt(stage);

    await expect(new ExportSession(options(), fixture.dependencies).run()).rejects.toThrow(
      `${stage} failed`,
    );

    const cleanup = fixture.events.filter((event) =>
      [
        'progress.stop',
        'ffmpeg.terminate',
        'browser.close',
        'target.close',
        'output.cleanup',
      ].includes(event),
    );
    const expected = [
      fixture.events.includes('progress.acquired') ? 'progress.stop' : null,
      fixture.events.includes('ffmpeg.acquired') ? 'ffmpeg.terminate' : null,
      fixture.events.includes('browser.acquired') ? 'browser.close' : null,
      fixture.events.includes('target.acquired') ? 'target.close' : null,
      fixture.events.includes('output.acquired') ? 'output.cleanup' : null,
    ].filter(Boolean);
    expect(cleanup).toEqual(expected);
    for (const event of cleanup) {
      expect(fixture.events.filter((value) => value === event)).toHaveLength(1);
    }
  });

  it('keeps the primary failure first and attaches cleanup failures', async () => {
    const fixture = harness();
    const primary = new Error('capture failed');
    const cleanup = new Error('browser close failed');
    fixture.failAt('page.capture', primary);
    fixture.failAt('browser.close', cleanup);

    const failure = await new ExportSession(options(), fixture.dependencies)
      .run()
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('capture failed');
    expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, cleanup]);
  });

  it('rejects an invalid Scene contract before starting FFmpeg', async () => {
    const fixture = harness();
    fixture.evaluate.mockImplementationOnce(async () => ({ hasStop: false, hasStep: true }));

    await expect(new ExportSession(options(), fixture.dependencies).run()).rejects.toThrow(
      /vectoScene.*stop.*step/i,
    );
    expect(fixture.events).not.toContain('ffmpeg.acquire');
  });

  it('reports a missing canvas', async () => {
    const fixture = harness();
    fixture.evaluate.mockImplementation(async (operation: unknown, argument?: number) => {
      const source = String(operation);
      if (source.includes('hasStop: typeof')) return { hasStop: true, hasStep: true };
      if (source.includes('scene.stop')) return undefined;
      if (source.includes('scene.step')) {
        fixture.events.push(`scene.step:${String(argument)}`);
        return undefined;
      }
      if (source.includes('toDataURL')) throw new Error('No canvas found');
    });

    await expect(new ExportSession(options(), fixture.dependencies).run()).rejects.toThrow(
      'No canvas found',
    );
  });

  it('honors an already-aborted signal before acquiring resources', async () => {
    const fixture = harness();
    const controller = new AbortController();
    controller.abort('cancelled');

    const failure = await new ExportSession(
      options({ signal: controller.signal }),
      fixture.dependencies,
    )
      .run()
      .catch((error) => error);

    expect(failure.name).toBe('AbortError');
    expect(fixture.events).toEqual([]);
  });

  it('checks abort between frames', async () => {
    const fixture = harness();
    const controller = new AbortController();
    fixture.progressUpdate.mockImplementationOnce(() => {
      fixture.events.push('progress.update:1');
      controller.abort('stop now');
    });

    const failure = await new ExportSession(
      options({ signal: controller.signal }),
      fixture.dependencies,
    )
      .run()
      .catch((error) => error);

    expect(failure.name).toBe('AbortError');
    expect(fixture.encoderWrite).toHaveBeenCalledOnce();
    expect(fixture.outputCommit).not.toHaveBeenCalled();
  });
});
