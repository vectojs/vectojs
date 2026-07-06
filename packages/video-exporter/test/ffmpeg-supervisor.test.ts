import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  startFfmpeg,
  type ChildProcessLike,
  type FfmpegDependencies,
  type WritableLike,
} from '../src/ffmpeg-supervisor.js';

class FakeWritable extends EventEmitter implements WritableLike {
  writeResult = true;
  write = vi.fn((_chunk: Uint8Array) => this.writeResult);
  end = vi.fn();
  destroy = vi.fn();
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdin = new FakeWritable();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

function setup(signal?: AbortSignal) {
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const dependencies: FfmpegDependencies = { spawn };
  const supervisor = startFfmpeg(
    { fps: 30, outputPath: '/workspace/output.mp4', signal, terminateTimeoutMs: 50 },
    dependencies,
  );
  return { child, spawn, supervisor };
}

describe('FfmpegSupervisor', () => {
  it('starts the compatible PNG-to-libx264 pipeline', () => {
    const { spawn } = setup();
    expect(spawn).toHaveBeenCalledWith('ffmpeg', [
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-r',
      '30',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '/workspace/output.mp4',
    ]);
  });

  it('surfaces spawn errors', async () => {
    const { child, supervisor } = setup();
    child.emit('error', new Error('ffmpeg missing'));
    await expect(supervisor.write(Buffer.from('frame'))).rejects.toThrow(
      /failed to start.*ffmpeg missing/i,
    );
  });

  it('surfaces an early exit and its stderr tail', async () => {
    const { child, supervisor } = setup();
    child.stderr.emit('data', Buffer.from('invalid PNG'));
    child.close(2);
    await expect(supervisor.write(Buffer.from('frame'))).rejects.toThrow(
      /exited before input completed.*code 2.*invalid PNG/is,
    );
  });

  it('requires a zero exit code after finishing input', async () => {
    const { child, supervisor } = setup();
    const finished = supervisor.finish();
    child.stderr.emit('data', Buffer.from('encoder failed'));
    child.close(1);
    await expect(finished).rejects.toThrow(/exited with code 1.*encoder failed/is);
  });

  it('keeps only the last 64 KiB of stderr', () => {
    const { child, supervisor } = setup();
    child.stderr.emit('data', Buffer.from(`prefix-${'x'.repeat(70 * 1024)}-tail`));
    expect(Buffer.byteLength(supervisor.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(supervisor.stderr.endsWith('-tail')).toBe(true);
    expect(supervisor.stderr.startsWith('prefix-')).toBe(false);
  });

  it('waits for drain when stdin applies backpressure', async () => {
    const { child, supervisor } = setup();
    child.stdin.writeResult = false;
    const write = supervisor.write(Buffer.from('frame'));
    let settled = false;
    void write.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdin.emit('drain');
    await expect(write).resolves.toBeUndefined();
  });

  it('rejects a backpressure wait when stdin errors', async () => {
    const { child, supervisor } = setup();
    child.stdin.writeResult = false;
    const write = supervisor.write(Buffer.from('frame'));
    child.stdin.emit('error', new Error('broken pipe'));
    await expect(write).rejects.toThrow(/stdin.*broken pipe/i);
  });

  it('rejects a backpressure wait when aborted', async () => {
    const controller = new AbortController();
    const { child, supervisor } = setup(controller.signal);
    child.stdin.writeResult = false;
    const write = supervisor.write(Buffer.from('frame'));
    controller.abort(new Error('cancel export'));
    await expect(write).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ends stdin and waits for a successful close only once', async () => {
    const { child, supervisor } = setup();
    const first = supervisor.finish();
    const second = supervisor.finish();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    child.close(0);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('terminates with SIGTERM and escalates to SIGKILL after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { child, supervisor } = setup();
      const terminating = supervisor.terminate();
      expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(50);
      await terminating;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not signal an already closed process', async () => {
    const { child, supervisor } = setup();
    child.close(0);
    await supervisor.terminate();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
