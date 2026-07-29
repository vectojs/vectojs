import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import puppeteer, { type Browser, type CDPSession, type Protocol } from 'puppeteer-core';
import type {
  BrowserProfileArtifact,
  BrowserProfileOptions,
  BrowserProfileSession,
} from '../types';

const ATTACH_TIMEOUT_MS = 15_000;
const TRACE_EVENT_TIMEOUT_MS = 30_000;
const CONTROL_POLL_MS = 25;
const IO_CHUNK_BYTES = 1 << 20;

/** Matches Puppeteer's timeline defaults and includes `performance.mark`/`measure` events. */
export const CHROME_TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
] as const;

export interface ChromeCdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitForEvent(method: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  disconnect(): Promise<void>;
}

interface ChromeProfileDependencies {
  connect(options: BrowserProfileOptions): Promise<ChromeCdpClient>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export class ChromeTraceDataLossError extends Error {
  public constructor(public readonly tracePath: string) {
    super(`Chrome reported trace data loss; partial trace saved at ${tracePath}`);
    this.name = 'ChromeTraceDataLossError';
  }
}

class PuppeteerCdpClient implements ChromeCdpClient {
  public constructor(
    private readonly browser: Browser,
    private readonly tracingSession: CDPSession,
    private readonly pageSession: CDPSession,
  ) {}

  public async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'Tracing.start':
        return this.tracingSession.send('Tracing.start', params as Protocol.Tracing.StartRequest);
      case 'Tracing.end':
        return this.tracingSession.send('Tracing.end');
      case 'Runtime.evaluate':
        return this.pageSession.send(
          'Runtime.evaluate',
          params as Protocol.Runtime.EvaluateRequest,
        );
      case 'IO.read':
        return this.tracingSession.send('IO.read', params as Protocol.IO.ReadRequest);
      case 'IO.close':
        return this.tracingSession.send('IO.close', params as Protocol.IO.CloseRequest);
      default:
        throw new Error(`unsupported Chrome CDP command: ${method}`);
    }
  }

  public async waitForEvent(
    method: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (method !== 'Tracing.tracingComplete') {
      throw new Error(`unsupported Chrome CDP event: ${method}`);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${method}`));
      }, TRACE_EVENT_TIMEOUT_MS);
      const completed = (event: Protocol.Tracing.TracingCompleteEvent): void => {
        cleanup();
        resolve(event as unknown as Record<string, unknown>);
      };
      const aborted = (): void => {
        cleanup();
        reject(signal ? abortError(signal) : new Error(`${method} wait aborted`));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', aborted);
        this.tracingSession.off('Tracing.tracingComplete', completed);
      };
      signal?.addEventListener('abort', aborted, { once: true });
      this.tracingSession.once('Tracing.tracingComplete', completed);
      if (signal?.aborted) aborted();
    });
  }

  public async disconnect(): Promise<void> {
    const sessions = [this.pageSession, this.tracingSession].filter((session) => !session.detached);
    const results = await Promise.allSettled(sessions.map((session) => session.detach()));
    this.browser.disconnect();
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Chrome CDP detach failed');
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Chrome profile aborted');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });

    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timeout);
      reject(abortError(signal));
    }
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`invalid ${label} response from Chrome`);
  }
  return value as Record<string, unknown>;
}

function runtimeValue(value: unknown): unknown {
  const response = record(value, 'Runtime.evaluate');
  if (response.exceptionDetails !== undefined) {
    throw new Error('Chrome benchmark control evaluation failed');
  }
  return record(response.result, 'Runtime.evaluate result').value;
}

async function waitForActivePort(
  profileDir: string,
  signal: AbortSignal,
  wait: ChromeProfileDependencies['sleep'],
): Promise<number> {
  const path = join(profileDir, 'DevToolsActivePort');
  const deadline = performance.now() + ATTACH_TIMEOUT_MS;
  while (performance.now() < deadline) {
    throwIfAborted(signal);
    try {
      const [portText] = (await readFile(path, 'utf8')).split('\n');
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
      throw new Error(`invalid Chrome DevTools port in ${path}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await wait(CONTROL_POLL_MS, signal);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function connectChrome(options: BrowserProfileOptions): Promise<ChromeCdpClient> {
  const port = await waitForActivePort(options.profileDir, options.signal, sleep);
  throwIfAborted(options.signal);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    protocolTimeout: TRACE_EVENT_TIMEOUT_MS,
  });
  try {
    const target = await browser.waitForTarget(
      (candidate) => candidate.type() === 'page' && candidate.url() === options.targetUrl,
      { timeout: ATTACH_TIMEOUT_MS },
    );
    throwIfAborted(options.signal);
    const page = await target.page();
    if (!page) throw new Error(`Chrome target has no page: ${options.targetUrl}`);
    // The benchmark closes its own page after posting results. Keep a second page
    // alive so the tracing session survives long enough to receive the stream.
    const keepalive = await browser.newPage();
    await page.bringToFront();
    return new PuppeteerCdpClient(
      browser,
      await keepalive.createCDPSession(),
      await page.createCDPSession(),
    );
  } catch (error) {
    browser.disconnect();
    throw error;
  }
}

async function waitForBenchmarkControl(
  client: ChromeCdpClient,
  signal: AbortSignal,
  wait: ChromeProfileDependencies['sleep'],
): Promise<void> {
  const deadline = performance.now() + ATTACH_TIMEOUT_MS;
  while (performance.now() < deadline) {
    throwIfAborted(signal);
    const ready = runtimeValue(
      await client.send('Runtime.evaluate', {
        expression: "typeof globalThis.__VECTO_BENCH__?.start === 'function'",
        returnByValue: true,
      }),
    );
    if (ready === true) return;
    await wait(CONTROL_POLL_MS, signal);
  }
  throw new Error('timed out waiting for window.__VECTO_BENCH__; benchmark must call awaitStart()');
}

async function releaseBenchmark(client: ChromeCdpClient): Promise<void> {
  const released = runtimeValue(
    await client.send('Runtime.evaluate', {
      expression: 'globalThis.__VECTO_BENCH__.start(); true',
      returnByValue: true,
    }),
  );
  if (released !== true) throw new Error('Chrome benchmark control did not start');
}

async function* readCdpStream(client: ChromeCdpClient, handle: string): AsyncGenerator<Buffer> {
  try {
    let eof = false;
    while (!eof) {
      const response = record(
        await client.send('IO.read', { handle, size: IO_CHUNK_BYTES }),
        'IO.read',
      );
      if (typeof response.data !== 'string' || typeof response.eof !== 'boolean') {
        throw new Error('invalid IO.read response from Chrome');
      }
      eof = response.eof;
      if (response.data.length > 0) {
        yield Buffer.from(response.data, response.base64Encoded === true ? 'base64' : 'utf8');
      }
    }
  } finally {
    await client.send('IO.close', { handle });
  }
}

async function writeTrace(
  client: ChromeCdpClient,
  handle: string,
  tracePath: string,
): Promise<void> {
  const temporaryPath = `${tracePath}.tmp`;
  await mkdir(dirname(tracePath), { recursive: true });
  await rm(temporaryPath, { force: true });
  try {
    await pipeline(
      readCdpStream(client, handle),
      createGzip(),
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    await rename(temporaryPath, tracePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

class ActiveChromeProfile implements BrowserProfileSession {
  public readonly stopAfterBrowserExit = false;
  public readonly shutdownGraceMs = 10_000;
  private releasePromise: Promise<void> | null = null;
  private stopPromise: Promise<BrowserProfileArtifact> | null = null;

  public constructor(
    private readonly client: ChromeCdpClient,
    private readonly tracePath: string,
  ) {}

  public releaseBenchmark(): Promise<void> {
    this.releasePromise ??= releaseBenchmark(this.client);
    return this.releasePromise;
  }

  public stop(): Promise<BrowserProfileArtifact> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<BrowserProfileArtifact> {
    const failures: unknown[] = [];
    let artifact: BrowserProfileArtifact | null = null;
    try {
      const completionAbort = new AbortController();
      const completed = this.client.waitForEvent('Tracing.tracingComplete', completionAbort.signal);
      let event: Record<string, unknown>;
      try {
        await this.client.send('Tracing.end');
        event = await completed;
      } catch (error) {
        completionAbort.abort(error);
        await completed.catch(() => {});
        throw error;
      }
      if (typeof event.stream !== 'string') {
        throw new Error('Chrome tracingComplete event did not provide a stream');
      }
      await writeTrace(this.client, event.stream, this.tracePath);
      if (event.dataLossOccurred === true) throw new ChromeTraceDataLossError(this.tracePath);
      artifact = { tracePath: this.tracePath, dataLossOccurred: false };
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.client.disconnect();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Chrome trace finalization and disconnect failed');
    }
    if (!artifact) throw new Error('Chrome trace finalization produced no artifact');
    return artifact;
  }
}

const defaultDependencies: ChromeProfileDependencies = {
  connect: connectChrome,
  sleep,
};

/** Attach and begin tracing while the shared `gate=1` control holds the benchmark. */
export async function startChromeProfile(
  options: BrowserProfileOptions,
  dependencies: Partial<ChromeProfileDependencies> = {},
): Promise<BrowserProfileSession> {
  const deps = { ...defaultDependencies, ...dependencies };
  const client = await deps.connect(options);
  let tracingStarted = false;
  try {
    await client.send('Tracing.start', {
      categories: CHROME_TRACE_CATEGORIES.join(','),
      streamFormat: 'json',
      transferMode: 'ReturnAsStream',
    });
    tracingStarted = true;
    await waitForBenchmarkControl(client, options.signal, deps.sleep);
    return new ActiveChromeProfile(client, options.tracePath);
  } catch (error) {
    if (!tracingStarted) {
      await client.disconnect();
      throw error;
    }
    try {
      await new ActiveChromeProfile(client, options.tracePath).stop();
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        'Chrome profile startup and trace finalization failed',
      );
    }
    throw error;
  }
}
