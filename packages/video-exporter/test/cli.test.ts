import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from '../src/cli.js';

function runtime(exporter = vi.fn(async () => {})) {
  const signals = new EventEmitter();
  const error = vi.fn();
  const value: CliRuntime = {
    exportVideo: exporter,
    error,
    once: (signal, listener) => signals.once(signal, listener),
    off: (signal, listener) => signals.off(signal, listener),
  };
  return { value, exporter, error, signals };
}

describe('runCli', () => {
  it('prints usage and returns 1 when input is missing', async () => {
    const fixture = runtime();

    await expect(runCli([], fixture.value)).resolves.toBe(1);

    expect(fixture.exporter).not.toHaveBeenCalled();
    expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining('Usage: vecto-export'));
  });

  it.each([
    ['--width', '12px'],
    ['--height', '0'],
    ['--fps', 'Infinity'],
    ['--duration', '-1'],
  ])('rejects invalid numeric option %s %s', async (flag, value) => {
    const fixture = runtime();

    await expect(runCli(['scene.ts', flag, value], fixture.value)).resolves.toBe(1);

    expect(fixture.exporter).not.toHaveBeenCalled();
    expect(fixture.error).toHaveBeenCalledWith(expect.stringMatching(/invalid/i));
  });

  it('forwards all flags and defaults to exportVideo', async () => {
    const fixture = runtime();

    await expect(
      runCli(
        [
          'scene.ts',
          '--output',
          'movie.mp4',
          '--width',
          '1920',
          '--height',
          '1080',
          '--fps',
          '30',
          '--duration',
          '2.5',
        ],
        fixture.value,
      ),
    ).resolves.toBe(0);

    expect(fixture.exporter).toHaveBeenCalledOnce();
    expect(fixture.exporter).toHaveBeenCalledWith({
      url: 'scene.ts',
      outputPath: 'movie.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 2.5,
      signal: expect.any(AbortSignal),
    });
  });

  it('reports exporter failures and returns 1', async () => {
    const failure = new Error('encoder unavailable');
    const fixture = runtime(vi.fn(async () => Promise.reject(failure)));

    await expect(runCli(['scene.ts'], fixture.value)).resolves.toBe(1);

    expect(fixture.error).toHaveBeenCalledWith('Export failed:', failure);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'aborts and waits for cleanup on %s before returning %s',
    async (signal, exitCode) => {
      const exporter = vi.fn(
        (options: { signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      );
      const fixture = runtime(exporter);

      const result = runCli(['scene.ts'], fixture.value);
      await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
      fixture.signals.emit(signal);

      await expect(result).resolves.toBe(exitCode);
      expect(exporter.mock.calls[0]![0].signal.aborted).toBe(true);
      expect(fixture.error).not.toHaveBeenCalledWith('Export failed:', expect.anything());
      expect(fixture.signals.listenerCount('SIGINT')).toBe(0);
      expect(fixture.signals.listenerCount('SIGTERM')).toBe(0);
    },
  );

  it('removes both signal listeners after success', async () => {
    const fixture = runtime();

    await runCli(['scene.ts'], fixture.value);

    expect(fixture.signals.listenerCount('SIGINT')).toBe(0);
    expect(fixture.signals.listenerCount('SIGTERM')).toBe(0);
  });
});
