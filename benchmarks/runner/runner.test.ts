import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChromeAdapter } from './browser/chrome';
import { FirefoxAdapter } from './browser/firefox';
import { profileProcessIds, terminateProfileProcesses, type ProcessSignal } from './processes';
import { findResult, starvationWarnings } from './results';
import { runOne } from './runner';
import { parseRunnerArgs, parseRunnerResult, RunnerUsageError } from './schema';
import { startRunnerServer } from './server';
import type {
  BrowserAdapter,
  BrowserProfileSession,
  RunnerConfig,
  WindowController,
} from './types';
import { quoteShellArgument, selectWindow } from './window/hyprland';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = join(repositoryRoot, 'tmp', 'benchmark-runner-tests');

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('runner CLI schema', () => {
  test('applies the historical defaults', () => {
    expect(parseRunnerArgs(['ondemand-raf', '8178'], {})).toEqual({
      benchDir: 'ondemand-raf',
      port: 8178,
      workspace: 3,
      keepGoing: false,
      viewport: null,
      iterations: 1,
      profileState: 'cold',
      mode: 'measure',
      browsers: ['chrome'],
      timeoutMs: 60_000,
      extendMs: 180_000,
    });
  });

  test('parses orchestration, profile, and viewport options before browser names', () => {
    expect(
      parseRunnerArgs(
        [
          'ondemand-raf',
          '8178',
          '--workspace',
          '7',
          '--keep-going',
          '--viewport',
          '900x700',
          '--iterations',
          '3',
          '--warm',
          'chrome',
          'firefox',
        ],
        { RUN_TIMEOUT: '5', RUN_EXTEND: '0' },
      ),
    ).toMatchObject({
      workspace: 7,
      keepGoing: true,
      viewport: { width: 900, height: 700 },
      iterations: 3,
      profileState: 'warm',
      browsers: ['chrome', 'firefox'],
      timeoutMs: 5_000,
      extendMs: 0,
    });
  });

  test('rejects profile aggregation before starting a server', () => {
    expect(() =>
      parseRunnerArgs(['ondemand-raf', '8178', '--iterations', '2', '--mode', 'profile']),
    ).toThrow('--mode profile does not support --iterations > 1');
  });

  test('rejects Firefox profile mode until the Gecko profiler ships', () => {
    expect(() => parseRunnerArgs(['ondemand-raf', '8178', '--mode', 'profile', 'firefox'])).toThrow(
      '--mode profile currently supports Chrome only',
    );
  });

  test('rejects malformed values and unknown browsers', () => {
    expect(() => parseRunnerArgs(['x', '8178', '--iterations', '0'])).toThrow(RunnerUsageError);
    expect(() => parseRunnerArgs(['x', '8178', '--viewport', '900-700'])).toThrow(
      '--viewport must be WIDTHxHEIGHT',
    );
    expect(() => parseRunnerArgs(['x', '8178', 'safari'])).toThrow('unknown browser: safari');
  });
});

describe('browser launch contracts', () => {
  test('keeps Chromium URL and profile as distinct quoted launch arguments', () => {
    const spec = new ChromeAdapter('/usr/bin/chromium').launchSpec(
      '/repo/tmp/profile with space',
      'http://127.0.0.1:8178/?runId=a&iteration=1',
      { width: 900, height: 700 },
    );
    expect(spec).toEqual({
      executable: '/usr/bin/chromium',
      windowClass: 'chromium',
      args: [
        '--incognito',
        '--new-window',
        '--user-data-dir=/repo/tmp/profile with space',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=900,700',
        'http://127.0.0.1:8178/?runId=a&iteration=1',
      ],
    });
    expect(quoteShellArgument(spec.args.at(-1)!)).toBe(
      "'http://127.0.0.1:8178/?runId=a&iteration=1'",
    );
    expect(quoteShellArgument("a'b")).toBe("'a'\\''b'");
  });

  test('opens a loopback CDP endpoint only in Chrome profile mode', () => {
    const spec = new ChromeAdapter('/usr/bin/chromium').launchSpec(
      '/repo/tmp/chrome-profile',
      'http://127.0.0.1:8178/?runId=a&gate=1',
      null,
      'profile',
    );
    expect(spec.args).toContain('--remote-debugging-address=127.0.0.1');
    expect(spec.args).toContain('--remote-debugging-port=0');
    expect(spec.args.at(-1)).toBe('http://127.0.0.1:8178/?runId=a&gate=1');
  });

  test('passes the benchmark URL as Firefox --private-window argument', () => {
    const spec = new FirefoxAdapter('/usr/bin/firefox').launchSpec(
      '/repo/tmp/firefox-profile',
      'http://127.0.0.1:8178/?runId=a&iteration=1',
      { width: 900, height: 700 },
    );
    expect(spec.windowClass).toBe('firefox');
    expect(spec.args.slice(-2)).toEqual([
      '--private-window',
      'http://127.0.0.1:8178/?runId=a&iteration=1',
    ]);
    expect(spec.args).toContain('--width=900');
    expect(spec.args).toContain('--height=700');
  });
});

async function exerciseProfileLifecycle(completes: boolean) {
  const benchRoot = await mkdtemp(join(tempRoot, 'profile-run-'));
  const resultPath = join(benchRoot, 'result.json');
  const events: string[] = [];
  const server = {
    port: 8178,
    url: 'http://127.0.0.1:8178/',
    written: [] as string[],
    stop() {},
  };
  let requestedTracePath = '';
  const profileSession: BrowserProfileSession = {
    async releaseBenchmark() {
      events.push('release');
      if (completes) {
        await Bun.write(
          resultPath,
          JSON.stringify({
            runId: 'suite-chrome-i1',
            suiteRunId: 'suite',
            engine: 'chrome',
            rows: [],
          }),
        );
        server.written.push(resultPath);
      }
    },
    async stop() {
      events.push('stop');
      return { tracePath: requestedTracePath, dataLossOccurred: false };
    },
  };
  const adapter: BrowserAdapter = {
    name: 'chrome',
    profiler: {
      async start(options) {
        events.push('attach');
        requestedTracePath = options.tracePath;
        expect(new URL(options.targetUrl).searchParams.get('gate')).toBe('1');
        return profileSession;
      },
    },
    resolveExecutable: () => '/usr/bin/chromium',
    async prepareProfile() {
      events.push('prepare');
    },
    launchSpec: () => ({
      executable: '/usr/bin/chromium',
      args: [],
      windowClass: 'chromium',
    }),
  };
  const windows: WindowController = {
    activeWorkspace: async () => 1,
    async launch() {
      events.push('launch');
    },
    async find() {
      events.push('find');
      return '0xcafe';
    },
    async focusWorkspace() {
      events.push('focus-workspace');
    },
    async focusWindow() {
      events.push('focus-window');
    },
    async closeWindow() {},
  };
  const config: RunnerConfig = {
    benchDir: 'fixture',
    port: 8178,
    workspace: 3,
    keepGoing: false,
    viewport: null,
    iterations: 1,
    profileState: 'cold',
    mode: 'profile',
    browsers: ['chrome'],
    timeoutMs: 0,
    extendMs: 0,
  };

  const match = await runOne(
    config,
    server,
    benchRoot,
    windows,
    adapter,
    join(benchRoot, 'profile'),
    1,
    'suite',
    1,
    new AbortController().signal,
    {
      wait: async () => {},
      async terminate() {
        events.push('terminate');
      },
    },
  );
  return { benchRoot, events, match, requestedTracePath };
}

describe('profile orchestration', () => {
  test('focuses before release and stops tracing before browser termination on success', async () => {
    const { benchRoot, events, match, requestedTracePath } = await exerciseProfileLifecycle(true);
    expect(match?.path).toEndWith('result.json');
    expect(requestedTracePath).toBe(join(benchRoot, 'traces', 'suite-chrome-i1.json.gz'));
    expect(events.indexOf('attach')).toBeLessThan(events.indexOf('focus-window'));
    expect(events.indexOf('focus-window')).toBeLessThan(events.indexOf('release'));
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('stop'));
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('terminate'));
  });

  test('still stops and preserves a partial profile when the benchmark times out', async () => {
    const { events, match } = await exerciseProfileLifecycle(false);
    expect(match).toBeNull();
    expect(events).toContain('release');
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('stop'));
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('terminate'));
  });
});

test('window selection prefers the benchmark title on the dedicated workspace', () => {
  const clients = [
    { address: '0x1', className: 'firefox', title: 'Private Browsing', workspace: 3 },
    { address: '0x2', className: 'firefox', title: 'VectoJS benchmark', workspace: 3 },
    { address: '0x3', className: 'firefox', title: 'VectoJS user tab', workspace: 1 },
  ];
  expect(selectWindow(clients, 3, 'firefox', 'vectojs')).toBe('0x2');
  expect(selectWindow(clients, 3, 'firefox', 'missing')).toBe('0x1');
  expect(selectWindow(clients, 4, 'firefox', 'vectojs')).toBeNull();
});

describe('result matching', () => {
  test('matches the recorded runId rather than an unrelated newer result', async () => {
    const dir = await mkdtemp(join(tempRoot, 'results-'));
    const wanted = join(dir, 'wanted.json');
    const unrelated = join(dir, 'unrelated.json');
    await Bun.write(
      wanted,
      JSON.stringify({
        runId: 'suite-chrome-i1',
        suiteRunId: 'suite',
        engine: 'chrome',
        rows: [{ starved: true, shape: 'scene', expectedFrames: 100, streamOffered: 2 }],
      }),
    );
    await Bun.write(
      unrelated,
      JSON.stringify({
        runId: 'other-firefox-i1',
        suiteRunId: 'other',
        engine: 'firefox',
        rows: [],
      }),
    );

    const match = await findResult([wanted, unrelated], 0, 'suite-chrome-i1');
    expect(match?.path).toBe(wanted);
    expect(starvationWarnings(match ? [match] : [])).toEqual([
      '  chrome scene ?/s ?: offered 2 of ~100',
    ]);
  });

  test('rejects an exact-match file with an invalid envelope', async () => {
    const dir = await mkdtemp(join(tempRoot, 'invalid-result-'));
    const path = join(dir, 'bad.json');
    await Bun.write(path, JSON.stringify({ runId: 'wanted' }));
    expect(findResult([path], 0, 'wanted')).rejects.toThrow(
      'benchmark result does not match the runner envelope',
    );
    expect(() => parseRunnerResult(null)).toThrow('runner envelope');
  });
});

describe('profile-owned process cleanup', () => {
  test('signals only processes whose argv contains the exact profile path', async () => {
    const procRoot = await mkdtemp(join(tempRoot, 'proc-'));
    await mkdir(join(procRoot, '101'), { recursive: true });
    await mkdir(join(procRoot, '202'), { recursive: true });
    await writeFile(join(procRoot, '101', 'cmdline'), 'firefox\0--profile\0/profile-a');
    await writeFile(join(procRoot, '202', 'cmdline'), 'firefox\0--profile\0/profile-b');
    expect(await profileProcessIds('/profile-a', procRoot)).toEqual([101]);

    const signals: Array<[number, ProcessSignal]> = [];
    const survivors = await terminateProfileProcesses('/profile-a', {
      procRoot,
      termWaitSteps: 1,
      sleep: async () => {},
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        rmSync(join(procRoot, String(pid), 'cmdline'));
      },
    });
    expect(signals).toEqual([[101, 'SIGTERM']]);
    expect(survivors).toEqual([]);
  });
});

test('runner owns and stops an in-process loopback server', async () => {
  const benchRoot = await mkdtemp(join(tempRoot, 'server-'));
  await mkdir(join(benchRoot, 'page'), { recursive: true });
  await Bun.write(join(benchRoot, 'page', 'index.html'), '<!doctype html><title>fixture</title>');
  const server = await startRunnerServer(benchRoot, 0);
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    await fetch(new URL('/results', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'fixture',
        engine: 'chrome',
        runId: 'fixture-chrome-i1',
        suiteRunId: 'fixture',
        rows: [],
      }),
    });
    expect(server.written).toHaveLength(1);
  } finally {
    server.stop();
  }
});

test('thin shell entry preserves parser failures and exit status', async () => {
  const subprocess = Bun.spawn(
    [join(repositoryRoot, 'benchmarks', 'run-browsers.sh'), 'fixture', '8178', '--mode', 'bad'],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const stderr = await new Response(subprocess.stderr).text();
  expect(await subprocess.exited).toBe(1);
  expect(stderr).toContain("unknown --mode 'bad'");
});
