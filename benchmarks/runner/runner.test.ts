import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChromeAdapter } from './browser/chrome';
import { FirefoxAdapter } from './browser/firefox';
import {
  profileProcessIds,
  terminateProfileProcesses,
  terminateProfileProcessesDetailed,
  type ProcessSignal,
} from './processes';
import { findResult, starvationWarnings } from './results';
import { runOne, runUrl } from './runner';
import {
  ENGINE_WORKSPACE,
  parseRunnerArgs,
  parseRunnerResult,
  RESERVED_PARAMS,
  RunnerUsageError,
} from './schema';
import { startRunnerServer } from './server';
import { selectPanelRefreshHz } from './window/hyprland';
import type {
  BrowserAdapter,
  BrowserProfileSession,
  RunnerConfig,
  WindowController,
} from './types';
import {
  formatBrowserLaunchCommand,
  formatHyprlandLaunchDispatcher,
  formatHyprlandWindowDispatcher,
  formatHyprlandWorkspaceDispatcher,
  quoteShellArgument,
  selectWindow,
} from './window/hyprland';

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
      // null = use the per-engine default (ENGINE_WORKSPACE): chrome 5, firefox 6.
      workspace: null,
      keepGoing: false,
      viewport: null,
      iterations: 1,
      profileState: 'cold',
      mode: 'measure',
      params: {},
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

  test('gives each engine its own dedicated workspace', () => {
    // Two windows on one workspace tile side by side, which halves each
    // viewport and silently changes the workload being measured.
    expect(ENGINE_WORKSPACE.chrome).not.toBe(ENGINE_WORKSPACE.firefox);
    expect(ENGINE_WORKSPACE).toEqual({ chrome: 5, firefox: 6 });
  });

  test('leaves workspace unresolved so the runner can pick per engine', () => {
    // A single number cannot serve an invocation that runs both browsers, so the
    // default must stay null until an adapter is in hand.
    expect(parseRunnerArgs(['ondemand-raf', '8178', 'chrome', 'firefox'], {}).workspace).toBeNull();
  });

  test('rejects profile aggregation before starting a server', () => {
    expect(() =>
      parseRunnerArgs(['ondemand-raf', '8178', '--iterations', '2', '--mode', 'profile']),
    ).toThrow('--mode profile does not support --iterations > 1');
  });

  test('accepts Firefox and dual-browser profile capture', () => {
    expect(
      parseRunnerArgs(['ondemand-raf', '8178', '--mode', 'profile', 'firefox']).browsers,
    ).toEqual(['firefox']);
    expect(
      parseRunnerArgs(['ondemand-raf', '8178', '--mode', 'profile', 'chrome', 'firefox']).browsers,
    ).toEqual(['chrome', 'firefox']);
  });

  test('rejects malformed values and unknown browsers', () => {
    expect(() => parseRunnerArgs(['x', '8178', '--iterations', '0'])).toThrow(RunnerUsageError);
    expect(() => parseRunnerArgs(['x', '8178', '--viewport', '900-700'])).toThrow(
      '--viewport must be WIDTHxHEIGHT',
    );
    expect(() => parseRunnerArgs(['x', '8178', 'safari'])).toThrow('unknown browser: safari');
  });
});

describe('benchmark query passthrough', () => {
  test('collects repeated --param into the config', () => {
    expect(
      parseRunnerArgs(['glyph-batch', '8178', '--param', 'hud=1', '--param', 'holdMs=0', 'firefox'])
        .params,
    ).toEqual({ hud: '1', holdMs: '0' });
  });

  test('defaults to no extra params', () => {
    expect(parseRunnerArgs(['glyph-batch', '8178']).params).toEqual({});
  });

  test('keeps a value containing = and accepts an empty value', () => {
    // Only the first `=` separates; a benchmark may legitimately want a value
    // that itself contains one (a comma-list, an expression).
    expect(parseRunnerArgs(['x', '8178', '--param', 'expr=a=b']).params).toEqual({ expr: 'a=b' });
    expect(parseRunnerArgs(['x', '8178', '--param', 'note=']).params).toEqual({
      note: '',
    });
  });

  test('rejects a malformed --param', () => {
    expect(() => parseRunnerArgs(['x', '8178', '--param', 'hud'])).toThrow(
      '--param must be KEY=VALUE',
    );
    // A leading `=` would name an empty key.
    expect(() => parseRunnerArgs(['x', '8178', '--param', '=1'])).toThrow(
      '--param must be KEY=VALUE',
    );
    expect(() => parseRunnerArgs(['x', '8178', '--param'])).toThrow('--param requires a value');
  });

  test('rejects a duplicate key instead of silently keeping one', () => {
    expect(() => parseRunnerArgs(['x', '8178', '--param', 'hud=1', '--param', 'hud=0'])).toThrow(
      '--param hud given more than once',
    );
  });

  test('refuses to override any key the runner owns', () => {
    // These carry run identity and profiler selection; a caller overriding one
    // would produce a run that cannot be matched back or does not measure what
    // it reports.
    for (const key of RESERVED_PARAMS) {
      expect(() => parseRunnerArgs(['x', '8178', '--param', `${key}=x`])).toThrow(
        `--param ${key} is set by the runner and cannot be overridden`,
      );
    }
  });

  test('reaches the benchmark URL without disturbing runner-owned keys', () => {
    const config = parseRunnerArgs([
      'glyph-batch',
      '8178',
      '--param',
      'hud=1',
      '--param',
      'holdMs=0',
      '--param',
      'sustainGlyphs=24800',
    ]);
    const url = new URL(runUrl('http://127.0.0.1:8178/', 'run-7', 'suite-3', 2, config, false));

    expect(url.searchParams.get('hud')).toBe('1');
    expect(url.searchParams.get('holdMs')).toBe('0');
    expect(url.searchParams.get('sustainGlyphs')).toBe('24800');
    expect(url.searchParams.get('runId')).toBe('run-7');
    expect(url.searchParams.get('suiteRunId')).toBe('suite-3');
    expect(url.searchParams.get('iteration')).toBe('2');
    expect(url.searchParams.get('mode')).toBe('measure');
    expect(url.searchParams.get('profileState')).toBe('cold');
    expect(url.searchParams.get('gate')).toBeNull();
  });

  test('leaves the URL identical to before when no --param is given', () => {
    const bare = parseRunnerArgs(['glyph-batch', '8178']);
    expect(runUrl('http://127.0.0.1:8178/', 'r', 's', 1, bare, true)).toBe(
      'http://127.0.0.1:8178/?runId=r&suiteRunId=s&iteration=1&mode=measure&profileState=cold&gate=1',
    );
  });

  test('percent-encodes a value rather than injecting a second parameter', () => {
    const config = parseRunnerArgs(['x', '8178', '--param', 'glyphs=1000&hud=1']);
    const url = new URL(runUrl('http://127.0.0.1:8178/', 'r', 's', 1, config, false));
    expect(url.searchParams.get('glyphs')).toBe('1000&hud=1');
    expect(url.searchParams.get('hud')).toBeNull();
  });
});

describe('browser launch contracts', () => {
  test('uses the Hyprland Lua dispatcher with a silent workspace rule', () => {
    expect(formatHyprlandLaunchDispatcher(5, `'browser' 'a\\b' 'c"d'`)).toBe(
      "hl.dsp.exec_cmd(\"'browser' 'a\\\\b' 'c\\\"d'\", { workspace = \"5 silent\" })",
    );
    expect(() => formatHyprlandLaunchDispatcher(0, 'browser')).toThrow(
      'invalid benchmark workspace',
    );
  });

  test('uses Hyprland Lua dispatchers for workspace and window lifecycle', () => {
    expect(formatHyprlandWorkspaceDispatcher(6)).toBe('hl.dsp.focus({ workspace = "6" })');
    expect(formatHyprlandWindowDispatcher('focus', '0xCAFE')).toBe(
      'hl.dsp.focus({ window = "address:0xCAFE" })',
    );
    expect(formatHyprlandWindowDispatcher('close', '0xcafe')).toBe(
      'hl.dsp.window.close({ window = "address:0xcafe" })',
    );
    expect(() => formatHyprlandWindowDispatcher('focus', '0x1" })')).toThrow(
      'invalid Hyprland window address',
    );
  });

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

  test('quotes each Firefox profiler environment assignment as one shell token', () => {
    const command = formatBrowserLaunchCommand({
      executable: '/usr/bin/firefox',
      args: ['--profile', '/repo/profile with space'],
      environment: {
        MOZ_PROFILER_STARTUP: '1',
        MOZ_PROFILER_SHUTDOWN: "/repo/traces/run's profile.json",
      },
      windowClass: 'firefox',
    });
    expect(command).toBe(
      "'/usr/bin/env' 'MOZ_PROFILER_STARTUP=1' 'MOZ_PROFILER_SHUTDOWN=/repo/traces/run'\\''s profile.json' '/usr/bin/firefox' '--profile' '/repo/profile with space'",
    );
    expect(command).not.toContain("MOZ_PROFILER_SHUTDOWN='/repo");
  });
});

async function exerciseProfileLifecycle(
  completes: boolean,
  browser: 'chrome' | 'firefox' = 'chrome',
) {
  const benchRoot = await mkdtemp(join(tempRoot, 'profile-run-'));
  const resultPath = join(benchRoot, 'result.json');
  const events: string[] = [];
  const server = {
    port: 8178,
    url: 'http://127.0.0.1:8178/',
    written: [] as string[],
    stop() {},
  };
  const stopsAfterBrowserExit = browser === 'firefox';
  let requestedTracePath = '';
  let requestedGate: string | null = null;
  let preparedPanelHz: number | null | undefined;
  let launchedEnvironment: Readonly<Record<string, string>> | undefined;
  let terminationOptions: { graceMs?: number; requireGracefulExit?: boolean } | undefined;
  const profileSession: BrowserProfileSession = {
    stopAfterBrowserExit: stopsAfterBrowserExit,
    shutdownGraceMs: stopsAfterBrowserExit ? 60_000 : 10_000,
    async releaseBenchmark() {
      events.push('release');
      if (completes) {
        await Bun.write(
          resultPath,
          JSON.stringify({
            runId: `suite-${browser}-i1`,
            suiteRunId: 'suite',
            engine: browser,
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
    name: browser,
    profiler: {
      gate: !stopsAfterBrowserExit,
      async prepare(options) {
        events.push('profile-prepare');
        requestedTracePath = options.tracePath;
        return stopsAfterBrowserExit
          ? {
              MOZ_PROFILER_STARTUP: '1',
              MOZ_PROFILER_SHUTDOWN: options.tracePath.slice(0, -3),
            }
          : {};
      },
      async start(options) {
        events.push('attach');
        requestedGate = new URL(options.targetUrl).searchParams.get('gate');
        return profileSession;
      },
    },
    resolveExecutable: () => `/usr/bin/${browser}`,
    async prepareProfile(_profileDir, panelHz) {
      events.push('prepare');
      preparedPanelHz = panelHz;
    },
    launchSpec: () => ({
      executable: `/usr/bin/${browser}`,
      args: [],
      windowClass: browser,
    }),
  };
  const windows: WindowController = {
    activeWorkspace: async () => 1,
    panelRefreshHz: async () => 240,
    async launch(_workspace, spec) {
      events.push('launch');
      launchedEnvironment = spec.environment;
    },
    async find() {
      events.push('find');
      return '0xcafe';
    },
    async processId() {
      events.push('process-id');
      return 4242;
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
    params: {},
    browsers: [browser],
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
      async terminate(_windows, _address, _profileDir, _homeWorkspace, options) {
        events.push('terminate');
        terminationOptions = options;
      },
    },
  );
  return {
    benchRoot,
    events,
    launchedEnvironment,
    match,
    preparedPanelHz,
    requestedGate,
    requestedTracePath,
    terminationOptions,
  };
}

describe('profile orchestration', () => {
  test('focuses before release and stops tracing before browser termination on success', async () => {
    const { benchRoot, events, match, requestedGate, requestedTracePath, terminationOptions } =
      await exerciseProfileLifecycle(true);
    expect(match?.path).toEndWith('result.json');
    expect(events.indexOf('profile-prepare')).toBeLessThan(events.indexOf('launch'));
    expect(requestedTracePath).toBe(join(benchRoot, 'traces', 'suite-chrome-i1.json.gz'));
    expect(requestedGate).toBe('1');
    expect(events.indexOf('process-id')).toBeLessThan(events.indexOf('focus-window'));
    expect(events.indexOf('attach')).toBeLessThan(events.indexOf('focus-window'));
    expect(events.indexOf('focus-window')).toBeLessThan(events.indexOf('release'));
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('stop'));
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('terminate'));
    expect(terminationOptions).toEqual({
      graceMs: 10_000,
      requireGracefulExit: false,
      rootPid: 4242,
    });
  });

  test('still stops and preserves a partial profile when the benchmark times out', async () => {
    const { events, match } = await exerciseProfileLifecycle(false);
    expect(match).toBeNull();
    expect(events).toContain('release');
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('stop'));
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('terminate'));
  });

  test('lets Firefox run ungated and finalizes only after graceful browser exit', async () => {
    const result = await exerciseProfileLifecycle(true, 'firefox');
    expect(result.match?.path).toEndWith('result.json');
    expect(result.requestedGate).toBeNull();
    expect(result.launchedEnvironment).toEqual({
      MOZ_PROFILER_STARTUP: '1',
      MOZ_PROFILER_SHUTDOWN: result.requestedTracePath.slice(0, -3),
    });
    expect(result.events.indexOf('profile-prepare')).toBeLessThan(result.events.indexOf('launch'));
    expect(result.events.indexOf('release')).toBeLessThan(result.events.indexOf('terminate'));
    expect(result.events.indexOf('process-id')).toBeLessThan(result.events.indexOf('release'));
    expect(result.events.indexOf('terminate')).toBeLessThan(result.events.indexOf('stop'));
    expect(result.terminationOptions).toEqual({
      graceMs: 60_000,
      requireGracefulExit: true,
      rootPid: 4242,
    });
  });

  test('uses the same post-exit Firefox finalization order after timeout', async () => {
    const result = await exerciseProfileLifecycle(false, 'firefox');
    expect(result.match).toBeNull();
    expect(result.events.indexOf('release')).toBeLessThan(result.events.indexOf('terminate'));
    expect(result.events.indexOf('terminate')).toBeLessThan(result.events.indexOf('stop'));
  });
});

test('window selection prefers the benchmark title on the dedicated workspace', () => {
  const clients = [
    {
      address: '0x1',
      className: 'firefox',
      title: 'Private Browsing',
      workspace: 3,
    },
    {
      address: '0x2',
      className: 'firefox',
      title: 'VectoJS benchmark',
      workspace: 3,
    },
    {
      address: '0x3',
      className: 'firefox',
      title: 'VectoJS user tab',
      workspace: 1,
    },
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
        rows: [
          {
            starved: true,
            shape: 'scene',
            expectedFrames: 100,
            streamOffered: 2,
          },
        ],
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

  test('tracks a Firefox window PID tree while waiting for natural exit', async () => {
    const procRoot = await mkdtemp(join(tempRoot, 'proc-tree-'));
    for (const pid of [303, 404]) {
      await mkdir(join(procRoot, String(pid), 'task', String(pid)), {
        recursive: true,
      });
    }
    await writeFile(join(procRoot, '303', 'task', '303', 'children'), '404');
    await writeFile(join(procRoot, '404', 'task', '404', 'children'), '');

    const signals: Array<[number, ProcessSignal]> = [];
    let sleeps = 0;
    const result = await terminateProfileProcessesDetailed('/profile-not-in-argv', {
      procRoot,
      rootPid: 303,
      gracefulWaitSteps: 2,
      termWaitSteps: 1,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          rmSync(join(procRoot, '303'), { recursive: true, force: true });
          rmSync(join(procRoot, '404'), { recursive: true, force: true });
        }
      },
      killProcess: (pid, signal) => signals.push([pid, signal]),
    });
    expect(result).toEqual({
      forcedTerminationPids: [],
      forcedKillPids: [],
      survivors: [],
    });
    expect(signals).toEqual([]);
  });

  test('reports SIGTERM as a non-graceful fallback after the Firefox grace expires', async () => {
    const procRoot = await mkdtemp(join(tempRoot, 'proc-tree-timeout-'));
    for (const pid of [505, 606]) {
      await mkdir(join(procRoot, String(pid), 'task', String(pid)), {
        recursive: true,
      });
    }
    await writeFile(join(procRoot, '505', 'task', '505', 'children'), '606');
    await writeFile(join(procRoot, '606', 'task', '606', 'children'), '');

    const signals: Array<[number, ProcessSignal]> = [];
    const result = await terminateProfileProcessesDetailed('/profile-not-in-argv', {
      procRoot,
      rootPid: 505,
      gracefulWaitSteps: 1,
      termWaitSteps: 1,
      sleep: async () => {},
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        rmSync(join(procRoot, String(pid)), { recursive: true, force: true });
      },
    });
    expect(result).toEqual({
      forcedTerminationPids: [505, 606],
      forcedKillPids: [],
      survivors: [],
    });
    expect(signals).toEqual([
      [505, 'SIGTERM'],
      [606, 'SIGTERM'],
    ]);
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

describe('firefox frame rate preference', () => {
  test('writes the panel rate into the profile so rAF runs at display cadence', async () => {
    // The whole fix. Firefox's `layout.frame_rate` default of -1 ("follow the
    // display") resolves to 60Hz on this Hyprland/Wayland host even with the window
    // focused on the active workspace: measured 2026-08-03, seven launches with a
    // fresh profile each, every 500ms rAF bucket between 58.1 and 61.9Hz, while the
    // same probe gave Chromium ~240Hz from its first bucket. Without this pref every
    // Firefox measure-mode row samples a 60Hz page.
    const directory = await mkdtemp(join(tempRoot, 'ff-prefs-'));
    try {
      await new FirefoxAdapter('/usr/bin/firefox').prepareProfile(directory, 240);
      const prefs = await Bun.file(join(directory, 'user.js')).text();
      expect(prefs).toContain('user_pref("layout.frame_rate", 240);');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rounds a fractional panel rate, because the pref is an integer', async () => {
    // hyprctl reports 239.76 on some modes; `layout.frame_rate` takes an int, and an
    // unparseable value would leave Firefox on its 60Hz default.
    const directory = await mkdtemp(join(tempRoot, 'ff-prefs-round-'));
    try {
      await new FirefoxAdapter('/usr/bin/firefox').prepareProfile(directory, 143.94);
      const prefs = await Bun.file(join(directory, 'user.js')).text();
      expect(prefs).toContain('user_pref("layout.frame_rate", 144);');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('omits the preference when the panel rate is unknown', async () => {
    // Better to leave Firefox on its default than to invent a rate: a wrong explicit
    // value would be quoted as though the page ran at it, whereas an absent one is
    // caught by the page's cadence gate.
    const directory = await mkdtemp(join(tempRoot, 'ff-prefs-none-'));
    try {
      const adapter = new FirefoxAdapter('/usr/bin/firefox');
      for (const panelHz of [null, undefined, 0, Number.NaN]) {
        await adapter.prepareProfile(directory, panelHz);
        const prefs = await Bun.file(join(directory, 'user.js')).text();
        expect(prefs).not.toContain('layout.frame_rate');
        // The suppression preferences must survive regardless.
        expect(prefs).toContain('browser.shell.checkDefaultBrowser');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('never unthrottles rAF, which would decouple it from vsync', async () => {
    // `layout.frame_rate=0` measured 820-1044Hz — frames nobody sees, and not
    // comparable to any user-visible cadence. A panel rate must never produce it.
    const directory = await mkdtemp(join(tempRoot, 'ff-prefs-zero-'));
    try {
      await new FirefoxAdapter('/usr/bin/firefox').prepareProfile(directory, 240);
      const prefs = await Bun.file(join(directory, 'user.js')).text();
      expect(prefs).not.toContain('user_pref("layout.frame_rate", 0);');
      expect(prefs).not.toContain('user_pref("layout.frame_rate", -1);');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('panel refresh rate from the compositor', () => {
  test('reads the rate hyprctl reports', () => {
    expect(selectPanelRefreshHz([{ name: 'eDP-1', refreshRate: 240.00001, disabled: false }])).toBe(
      240,
    );
  });

  test('ignores a disabled monitor', () => {
    // A disabled panel's mode is not what any window renders against.
    expect(
      selectPanelRefreshHz([
        { name: 'HDMI-A-1', refreshRate: 360, disabled: true },
        { name: 'eDP-1', refreshRate: 240, disabled: false },
      ]),
    ).toBe(240);
  });

  test('takes the fastest monitor, since the window does not exist yet', () => {
    // The rate is written into a browser profile before launch, so there is no
    // window whose monitor could be consulted.
    expect(
      selectPanelRefreshHz([
        { name: 'eDP-1', refreshRate: 60 },
        { name: 'DP-1', refreshRate: 144 },
      ]),
    ).toBe(144);
  });

  test('returns null rather than a guess on unusable output', () => {
    // Null leaves Firefox on its default, which the cadence gate then reports. A
    // fabricated rate would be silently wrong and still quoted.
    for (const value of [null, undefined, {}, [], 'nope', [{ name: 'x' }], [{ refreshRate: 0 }]]) {
      expect(selectPanelRefreshHz(value)).toBeNull();
    }
  });
});

test('the runner reads the panel rate and hands it to the browser profile', async () => {
  // The wiring the whole Firefox fix depends on, and the one step no other test
  // covers: `framePreference` can be perfect and the pref still never reach the
  // profile. Firefox's frame rate is a profile preference, so it must be read from
  // the compositor and written BEFORE launch — there is no way to set it after.
  const { events, preparedPanelHz } = await exerciseProfileLifecycle(true);
  expect(preparedPanelHz).toBe(240);
  expect(events.indexOf('prepare')).toBeLessThan(events.indexOf('launch'));
});
