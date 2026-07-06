import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';

const STDERR_LIMIT = 64 * 1024;

export interface WritableLike extends EventEmitter {
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
}

export interface ChildProcessLike extends EventEmitter {
  stdin: WritableLike;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface FfmpegDependencies {
  spawn(command: string, args: string[]): ChildProcessLike;
}

export interface FfmpegOptions {
  fps: number;
  outputPath: string;
  signal?: AbortSignal;
  terminateTimeoutMs?: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : reason == null ? 'Export aborted' : String(reason),
    { cause: reason },
  );
  error.name = 'AbortError';
  return error;
}

export class FfmpegSupervisor {
  private stderrBuffer = Buffer.alloc(0);
  private closed = false;
  private closedBeforeInputCompleted = false;
  private closeCode: number | null = null;
  private closeSignal: NodeJS.Signals | null = null;
  private spawnError: Error | null = null;
  private inputCompleted = false;
  private finishPromise: Promise<void> | null = null;
  private terminatePromise: Promise<void> | null = null;
  private resolveClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly child: ChildProcessLike,
    private readonly options: FfmpegOptions,
  ) {
    child.stderr.on('data', (value: string | Uint8Array) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const combined = Buffer.concat([this.stderrBuffer, chunk]);
      this.stderrBuffer =
        combined.byteLength <= STDERR_LIMIT
          ? combined
          : combined.subarray(combined.byteLength - STDERR_LIMIT);
    });
    child.on('error', (error: Error) => {
      this.spawnError = new Error(`Failed to start FFmpeg: ${error.message}`, { cause: error });
      this.markClosed(null, null);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.markClosed(code, signal);
    });
  }

  get stderr(): string {
    return this.stderrBuffer.toString('utf8');
  }

  private markClosed(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.closedBeforeInputCompleted = !this.inputCompleted;
    this.closeCode = code;
    this.closeSignal = signal;
    this.resolveClosed();
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) throw abortError(this.options.signal);
  }

  private exitDescription(): string {
    if (this.closeCode !== null) return `code ${this.closeCode}`;
    if (this.closeSignal) return `signal ${this.closeSignal}`;
    return 'an unknown status';
  }

  private processError(early: boolean): Error | null {
    if (this.spawnError) return this.spawnError;
    if (!this.closed) return null;
    if (!early && this.closeCode === 0) return null;
    const phase = early ? 'exited before input completed' : 'exited';
    const stderr = this.stderr.trim();
    return new Error(
      `FFmpeg ${phase} with ${this.exitDescription()}${stderr ? `:\n${stderr}` : ''}`,
    );
  }

  private async waitForDrain(): Promise<void> {
    this.throwIfAborted();
    const processError = this.processError(true);
    if (processError) throw processError;

    await new Promise<void>((resolve, reject) => {
      const signal = this.options.signal;
      const cleanup = () => {
        this.child.stdin.off('drain', onDrain);
        this.child.stdin.off('error', onStdinError);
        this.child.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (operation: () => void) => {
        cleanup();
        operation();
      };
      const onDrain = () => settle(resolve);
      const onStdinError = (error: Error) =>
        settle(() => reject(new Error(`FFmpeg stdin failed: ${error.message}`, { cause: error })));
      const onClose = () => settle(() => reject(this.processError(true)!));
      const onAbort = () => settle(() => reject(abortError(signal!)));

      this.child.stdin.once('drain', onDrain);
      this.child.stdin.once('error', onStdinError);
      this.child.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    this.throwIfAborted();
    const processError = this.processError(true);
    if (processError) throw processError;

    let accepted: boolean;
    try {
      accepted = this.child.stdin.write(frame);
    } catch (error) {
      throw new Error(
        `FFmpeg stdin failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!accepted) await this.waitForDrain();

    this.throwIfAborted();
    const afterWriteError = this.processError(true);
    if (afterWriteError) throw afterWriteError;
  }

  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.finishOnce();
    return this.finishPromise;
  }

  private async finishOnce(): Promise<void> {
    this.throwIfAborted();
    if (this.closedBeforeInputCompleted) throw this.processError(true)!;
    if (this.spawnError) throw this.spawnError;

    this.inputCompleted = true;
    try {
      this.child.stdin.end();
    } catch (error) {
      throw new Error(
        `FFmpeg stdin failed while finishing: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    await this.waitForCloseOrAbort();
    const processError = this.processError(false);
    if (processError) throw processError;
  }

  private async waitForCloseOrAbort(): Promise<void> {
    const signal = this.options.signal;
    if (!signal) return this.closedPromise;
    this.throwIfAborted();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void this.closedPromise.then(() => {
        cleanup();
        resolve();
      });
    });
  }

  terminate(): Promise<void> {
    if (this.terminatePromise) return this.terminatePromise;
    this.terminatePromise = this.terminateOnce();
    return this.terminatePromise;
  }

  private async terminateOnce(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    await this.waitForCloseOrTimeout();
    if (this.closed) return;
    this.child.kill('SIGKILL');
    await this.waitForCloseOrTimeout();
  }

  private async waitForCloseOrTimeout(): Promise<void> {
    const timeoutMs = this.options.terminateTimeoutMs ?? 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

const defaultDependencies: FfmpegDependencies = {
  spawn: (command, args) => spawnChild(command, args) as unknown as ChildProcessLike,
};

export function startFfmpeg(
  options: FfmpegOptions,
  dependencies: FfmpegDependencies = defaultDependencies,
): FfmpegSupervisor {
  const child = dependencies.spawn('ffmpeg', [
    '-y',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-r',
    String(options.fps),
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    options.outputPath,
  ]);
  return new FfmpegSupervisor(child, options);
}
