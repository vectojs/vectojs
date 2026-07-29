import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import {
  CHROME_TRACE_CATEGORIES,
  ChromeTraceDataLossError,
  startChromeProfile,
  type ChromeCdpClient,
} from './profile/chrome';

const tempRoot = resolve(import.meta.dir, '../../tmp/chrome-profile-tests');

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

interface FakeClientOptions {
  controls?: boolean[];
  chunks?: Array<{ data: string; base64Encoded?: boolean; eof: boolean }>;
  dataLossOccurred?: boolean;
  readError?: Error;
  disconnectError?: Error;
  endError?: Error;
}

class FakeClient implements ChromeCdpClient {
  public readonly calls: string[] = [];
  public disconnected = false;
  private readonly controls: boolean[];
  private readonly chunks: Array<{ data: string; base64Encoded?: boolean; eof: boolean }>;
  private readonly dataLossOccurred: boolean;
  private readonly readError?: Error;
  private readonly disconnectError?: Error;
  private readonly endError?: Error;

  public constructor(options: FakeClientOptions = {}) {
    this.controls = [...(options.controls ?? [true])];
    this.chunks = [...(options.chunks ?? [{ data: '{"traceEvents":[]}', eof: true }])];
    this.dataLossOccurred = options.dataLossOccurred ?? false;
    this.readError = options.readError;
    this.disconnectError = options.disconnectError;
    this.endError = options.endError;
  }

  public async send(
    method: string,
    _params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.calls.push(`send:${method}`);
    if (method === 'Tracing.end' && this.endError) throw this.endError;
    if (method === 'Runtime.evaluate') {
      return { result: { value: this.controls.shift() ?? true } };
    }
    if (method === 'IO.read') {
      if (this.readError) throw this.readError;
      return this.chunks.shift() ?? { data: '', eof: true };
    }
    return {};
  }

  public async waitForEvent(
    method: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.calls.push(`wait:${method}`);
    if (this.endError) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return {
      stream: 'trace-stream',
      dataLossOccurred: this.dataLossOccurred,
    };
  }

  public async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    this.disconnected = true;
    if (this.disconnectError) throw this.disconnectError;
  }
}

async function profileWith(client: FakeClient, tracePath: string) {
  return startChromeProfile(
    {
      profileDir: '/profiles/chrome-i1',
      targetUrl: 'http://127.0.0.1:8178/?runId=suite-chrome-i1&gate=1',
      tracePath,
      signal: new AbortController().signal,
    },
    {
      connect: async () => client,
      sleep: async () => {},
    },
  );
}

describe('Chrome CDP profile lifecycle', () => {
  test('uses timeline, stack, and shared User Timing trace categories', () => {
    expect(CHROME_TRACE_CATEGORIES).toContain('blink.user_timing');
    expect(CHROME_TRACE_CATEGORIES).toContain('devtools.timeline');
    expect(CHROME_TRACE_CATEGORIES).toContain('disabled-by-default-devtools.timeline.stack');
  });

  test('starts tracing before releasing the gated benchmark and streams gzip atomically', async () => {
    const dir = await mkdtemp(join(tempRoot, 'success-'));
    const tracePath = join(dir, 'traces', 'suite-chrome-i1.json.gz');
    const trace = '{"traceEvents":[{"name":"vecto:scene:flush"}]}';
    const client = new FakeClient({
      controls: [false, true],
      chunks: [
        { data: trace.slice(0, 18), eof: false },
        { data: trace.slice(18), eof: true },
      ],
    });

    const session = await profileWith(client, tracePath);
    expect(client.calls.slice(0, 3)).toEqual([
      'send:Tracing.start',
      'send:Runtime.evaluate',
      'send:Runtime.evaluate',
    ]);
    await session.releaseBenchmark();
    await session.releaseBenchmark();
    expect(client.calls.filter((call) => call === 'send:Runtime.evaluate')).toHaveLength(3);

    const artifact = await session.stop();
    expect(client.calls.indexOf('wait:Tracing.tracingComplete')).toBeLessThan(
      client.calls.indexOf('send:Tracing.end'),
    );
    expect(client.calls).toContain('send:IO.close');
    expect(client.disconnected).toBe(true);
    expect(artifact).toEqual({ tracePath, dataLossOccurred: false });
    expect(gunzipSync(await readFile(tracePath)).toString()).toBe(trace);
    expect(existsSync(`${tracePath}.tmp`)).toBe(false);
  });

  test('decodes base64 IO chunks', async () => {
    const dir = await mkdtemp(join(tempRoot, 'base64-'));
    const tracePath = join(dir, 'trace.json.gz');
    const trace = '{"traceEvents":[{"name":"base64"}]}';
    const client = new FakeClient({
      chunks: [{ data: Buffer.from(trace).toString('base64'), base64Encoded: true, eof: true }],
    });

    const session = await profileWith(client, tracePath);
    await session.stop();
    expect(gunzipSync(await readFile(tracePath)).toString()).toBe(trace);
  });

  test('persists a valid trace but fails the run when Chrome reports data loss', async () => {
    const dir = await mkdtemp(join(tempRoot, 'data-loss-'));
    const tracePath = join(dir, 'trace.json.gz');
    const client = new FakeClient({ dataLossOccurred: true });

    const session = await profileWith(client, tracePath);
    expect(session.stop()).rejects.toBeInstanceOf(ChromeTraceDataLossError);
    expect(existsSync(tracePath)).toBe(true);
    expect(client.disconnected).toBe(true);
  });

  test('removes a corrupt temporary file when streaming fails', async () => {
    const dir = await mkdtemp(join(tempRoot, 'read-failure-'));
    const tracePath = join(dir, 'trace.json.gz');
    const client = new FakeClient({ readError: new Error('IO.read failed') });

    const session = await profileWith(client, tracePath);
    expect(session.stop()).rejects.toThrow('IO.read failed');
    expect(existsSync(tracePath)).toBe(false);
    expect(existsSync(`${tracePath}.tmp`)).toBe(false);
    expect(client.disconnected).toBe(true);
  });

  test('cancels the completion wait when Tracing.end fails', async () => {
    const dir = await mkdtemp(join(tempRoot, 'end-failure-'));
    const client = new FakeClient({ endError: new Error('Tracing.end failed') });

    const session = await profileWith(client, join(dir, 'trace.json.gz'));
    expect(session.stop()).rejects.toThrow('Tracing.end failed');
    expect(client.disconnected).toBe(true);
  });

  test('reports both stream and disconnect failures without masking either cause', async () => {
    const dir = await mkdtemp(join(tempRoot, 'combined-failure-'));
    const client = new FakeClient({
      readError: new Error('IO.read failed'),
      disconnectError: new Error('detach failed'),
    });

    const session = await profileWith(client, join(dir, 'trace.json.gz'));
    const failure = await session.stop().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual(['IO.read failed', 'detach failed']);
  });
});
