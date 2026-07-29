import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type {
  BrowserProfileArtifact,
  BrowserProfileOptions,
  BrowserProfileSession,
} from '../types';

const STABILITY_POLL_MS = 100;
const STABILITY_ATTEMPTS = 50;
const BOUNDARY_BYTES = 4096;

export interface FirefoxProfileDependencies {
  sleep(milliseconds: number): Promise<void>;
  compress(rawPath: string, temporaryPath: string): Promise<void>;
}

const defaultDependencies: FirefoxProfileDependencies = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  compress: (rawPath, temporaryPath) =>
    pipeline(
      createReadStream(rawPath),
      createGzip(),
      createWriteStream(temporaryPath, { flags: 'wx' }),
    ),
};

export class FirefoxProfileArtifactError extends Error {}

export function firefoxRawProfilePath(tracePath: string): string {
  if (!tracePath.endsWith('.json.gz')) {
    throw new FirefoxProfileArtifactError(`Firefox trace path must end in .json.gz: ${tracePath}`);
  }
  return tracePath.slice(0, -3);
}

export async function prepareFirefoxProfile(
  options: BrowserProfileOptions,
): Promise<Readonly<Record<string, string>>> {
  if (!isAbsolute(options.tracePath)) {
    throw new FirefoxProfileArtifactError(
      `Firefox profile output must be an absolute path: ${options.tracePath}`,
    );
  }

  const rawPath = firefoxRawProfilePath(options.tracePath);
  await mkdir(dirname(options.tracePath), { recursive: true });
  await Promise.all(
    [rawPath, `${options.tracePath}.tmp`, options.tracePath].map((path) =>
      rm(path, { force: true }),
    ),
  );

  return {
    MOZ_PROFILER_STARTUP: '1',
    MOZ_PROFILER_SHUTDOWN: rawPath,
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function waitForStableProfile(
  rawPath: string,
  dependencies: FirefoxProfileDependencies,
): Promise<number> {
  let priorSize = -1;
  for (let attempt = 0; attempt < STABILITY_ATTEMPTS; attempt++) {
    try {
      const info = await stat(rawPath);
      if (!info.isFile()) {
        throw new FirefoxProfileArtifactError(`Firefox profile output is not a file: ${rawPath}`);
      }
      if (info.size > 0 && info.size === priorSize) return info.size;
      priorSize = info.size;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      priorSize = -1;
    }
    if (attempt + 1 < STABILITY_ATTEMPTS) {
      await dependencies.sleep(STABILITY_POLL_MS);
    }
  }
  throw new FirefoxProfileArtifactError(
    `Firefox profile output was missing, empty, or unstable after browser exit: ${rawPath}`,
  );
}

async function validateProfileBoundaries(rawPath: string, size: number): Promise<void> {
  const handle = await open(rawPath, 'r');
  try {
    const boundaryLength = Math.min(BOUNDARY_BYTES, size);
    const head = Buffer.allocUnsafe(boundaryLength);
    const tail = Buffer.allocUnsafe(boundaryLength);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    if (
      head.toString('utf8').trimStart().at(0) !== '{' ||
      tail.toString('utf8').trimEnd().at(-1) !== '}'
    ) {
      throw new FirefoxProfileArtifactError(`Firefox profile output is truncated: ${rawPath}`);
    }
  } finally {
    await handle.close();
  }
}

class ActiveFirefoxProfile implements BrowserProfileSession {
  public readonly stopAfterBrowserExit = true;
  public readonly shutdownGraceMs = 60_000;
  private stopPromise: Promise<BrowserProfileArtifact> | null = null;

  public constructor(
    private readonly tracePath: string,
    private readonly dependencies: FirefoxProfileDependencies,
  ) {}

  public releaseBenchmark(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): Promise<BrowserProfileArtifact> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<BrowserProfileArtifact> {
    const rawPath = firefoxRawProfilePath(this.tracePath);
    const temporaryPath = `${this.tracePath}.tmp`;
    try {
      const size = await waitForStableProfile(rawPath, this.dependencies);
      await validateProfileBoundaries(rawPath, size);
      await rm(temporaryPath, { force: true });
      await this.dependencies.compress(rawPath, temporaryPath);
      await rename(temporaryPath, this.tracePath);
      await rm(rawPath);
      return { tracePath: this.tracePath, dataLossOccurred: false };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new FirefoxProfileArtifactError(
        `Firefox profile finalization failed; raw output retained at ${rawPath}`,
        { cause: error },
      );
    }
  }
}

export function startFirefoxProfile(
  options: BrowserProfileOptions,
  dependencies: Partial<FirefoxProfileDependencies> = {},
): Promise<BrowserProfileSession> {
  return Promise.resolve(
    new ActiveFirefoxProfile(options.tracePath, { ...defaultDependencies, ...dependencies }),
  );
}
