import cliProgress from 'cli-progress';
import { launchBrowser, type BrowserLike, type PageLike } from './browser.js';
import { startFfmpeg, type FfmpegOptions } from './ffmpeg-supervisor.js';
import { resolveInputTarget, type InputTarget } from './input-target.js';
import type { NormalizedExportOptions } from './options.js';
import { StagedOutput } from './staged-output.js';

interface StagedOutputLike {
  path: string;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

interface EncoderLike {
  write(frame: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  terminate(): Promise<void>;
}

interface ProgressLike {
  start(total: number, startValue: number): void;
  update(value: number): void;
  stop(): void;
}

export interface ExportSessionDependencies {
  resolveInputTarget(options: NormalizedExportOptions): Promise<InputTarget>;
  createStagedOutput(targetPath: string): StagedOutputLike;
  launchBrowser(): Promise<BrowserLike>;
  startFfmpeg(options: FfmpegOptions): EncoderLike;
  createProgress(): ProgressLike;
  log(message: string): void;
}

const defaultDependencies: ExportSessionDependencies = {
  resolveInputTarget,
  createStagedOutput: (targetPath) => StagedOutput.create(targetPath),
  launchBrowser,
  startFfmpeg,
  createProgress: () => new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic),
  log: (message) => console.log(message),
};

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : reason == null ? 'Export aborted' : String(reason),
    { cause: reason },
  );
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExportSession {
  constructor(
    private readonly options: NormalizedExportOptions,
    private readonly dependencies: ExportSessionDependencies = defaultDependencies,
  ) {}

  private throwIfAborted(): void {
    const signal = this.options.signal;
    if (signal?.aborted) throw abortError(signal);
  }

  private async validateAndStopScene(page: PageLike): Promise<void> {
    await page.waitForFunction('!!window.vectoScene', { timeout: 10_000 });
    const contract = await page.evaluate(() => {
      const scene = (window as unknown as { vectoScene?: { stop?: unknown; step?: unknown } })
        .vectoScene;
      return {
        hasStop: typeof scene?.stop === 'function',
        hasStep: typeof scene?.step === 'function',
      };
    });
    if (!contract.hasStop || !contract.hasStep) {
      throw new Error('window.vectoScene must provide callable stop() and step(dt) methods');
    }
    await page.evaluate(() => {
      const scene = (window as unknown as { vectoScene: { stop(): void } }).vectoScene;
      scene.stop();
    });
  }

  private async sizeCanvas(page: PageLike): Promise<void> {
    await page.evaluate(({ width, height }: { width: number; height: number }) => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('No canvas found');
      canvas.width = width;
      canvas.height = height;
    }, this.options);
  }

  private async captureFrame(page: PageLike): Promise<Buffer> {
    const base64 = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('No canvas found');
      const dataUrl = canvas.toDataURL('image/png');
      const separator = dataUrl.indexOf(',');
      if (separator < 0) throw new Error('Canvas returned an invalid PNG data URL');
      return dataUrl.slice(separator + 1);
    });
    return Buffer.from(base64, 'base64');
  }

  async run(): Promise<void> {
    let target: InputTarget | undefined;
    let output: StagedOutputLike | undefined;
    let browser: BrowserLike | undefined;
    let encoder: EncoderLike | undefined;
    let progress: ProgressLike | undefined;
    let primaryError: unknown;

    try {
      this.throwIfAborted();
      target = await this.dependencies.resolveInputTarget(this.options);
      output = this.dependencies.createStagedOutput(this.options.outputPath);
      browser = await this.dependencies.launchBrowser();
      const page = await browser.newPage();
      await page.setViewport({
        width: this.options.width,
        height: this.options.height,
        deviceScaleFactor: 1,
      });

      this.dependencies.log(`Loading URL: ${target.url}`);
      await page.goto(target.url, { waitUntil: 'networkidle0' });
      await this.sizeCanvas(page);
      await this.validateAndStopScene(page);
      this.throwIfAborted();

      encoder = this.dependencies.startFfmpeg({
        fps: this.options.fps,
        outputPath: output.path,
        signal: this.options.signal,
      });
      progress = this.dependencies.createProgress();
      progress.start(this.options.totalFrames, 0);

      for (let frame = 0; frame < this.options.totalFrames; frame += 1) {
        this.throwIfAborted();
        await page.evaluate((dt: number) => {
          const scene = (window as unknown as { vectoScene: { step(deltaTime: number): void } })
            .vectoScene;
          scene.step(dt);
        }, this.options.dt);
        await encoder.write(await this.captureFrame(page));
        progress.update(frame + 1);
      }

      this.throwIfAborted();
      await encoder.finish();
      this.throwIfAborted();
      await output.commit();
      this.dependencies.log(`Export complete: ${this.options.outputPath}`);
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    const clean = async (operation: (() => void | Promise<void>) | undefined) => {
      if (!operation) return;
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await clean(progress ? () => progress.stop() : undefined);
    await clean(encoder ? () => encoder.terminate() : undefined);
    await clean(browser ? () => browser.close() : undefined);
    await clean(target ? () => target.close() : undefined);
    await clean(output ? () => output.cleanup() : undefined);

    if (primaryError !== undefined) {
      if (cleanupErrors.length === 0) throw primaryError;
      throw new AggregateError([primaryError, ...cleanupErrors], errorMessage(primaryError), {
        cause: primaryError,
      });
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Video export cleanup failed');
    }
  }
}
