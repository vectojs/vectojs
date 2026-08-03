import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkServer } from '../_shared/server';
import { browserAdapter } from './browser';
import { terminateProfileProcessesDetailed } from './processes';
import { aggregateSuite, findResult, starvationWarnings, type ResultMatch } from './results';
import { ENGINE_WORKSPACE } from './schema';
import { startRunnerServer } from './server';
import type {
  BrowserAdapter,
  BrowserLaunchSpec,
  BrowserProfileSession,
  RunnerConfig,
  WindowController,
} from './types';
import { HyprlandWindowController } from './window/hyprland';

const benchmarksRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(benchmarksRoot, '..');

export class RunnerInterruptedError extends Error {}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve: complete } = Promise.withResolvers<void>();
  setTimeout(complete, milliseconds);
  return promise;
}

function suiteRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${randomBytes(3).toString('hex')}`;
}

async function shortCommit(): Promise<string> {
  const subprocess = Bun.spawn(['git', '-C', repositoryRoot, 'rev-parse', '--short', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(subprocess.stdout).text();
  return (await subprocess.exited) === 0 ? output.trim() : 'unknown';
}

/**
 * Exported for tests: the passthrough is only correct if it reaches the URL
 * *and* leaves the runner-owned identity keys intact, which is cheap to assert
 * here and expensive to observe through a live browser run.
 */
export function runUrl(
  serverUrl: string,
  runId: string,
  currentSuiteRunId: string,
  iteration: number,
  config: RunnerConfig,
  gated: boolean,
): string {
  const url = new URL(serverUrl);
  url.searchParams.set('runId', runId);
  url.searchParams.set('suiteRunId', currentSuiteRunId);
  url.searchParams.set('iteration', String(iteration));
  url.searchParams.set('mode', config.mode);
  url.searchParams.set('profileState', config.profileState);
  if (gated) url.searchParams.set('gate', '1');
  // Applied last, but `parseRunnerArgs` has already rejected any key set above,
  // so this cannot overwrite the identity a posted result is matched on.
  for (const [key, value] of Object.entries(config.params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

async function safely(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {}
}

export interface BrowserTerminationOptions {
  graceMs?: number;
  requireGracefulExit?: boolean;
  rootPid?: number | null;
}

async function terminateBrowser(
  windows: WindowController,
  address: string | null,
  profileDir: string,
  homeWorkspace: number,
  options: BrowserTerminationOptions = {},
): Promise<void> {
  let rootPid = options.rootPid ?? null;
  if (rootPid === null && address && windows.processId) {
    try {
      rootPid = await windows.processId(address);
    } catch {}
  }
  if (address) {
    await safely(() => windows.closeWindow(address));
    await delay(500);
  }
  const termination = await terminateProfileProcessesDetailed(profileDir, {
    rootPid,
    gracefulWaitSteps: options.requireGracefulExit
      ? Math.ceil((options.graceMs ?? 60_000) / 500)
      : 0,
    termWaitSteps: options.requireGracefulExit ? 20 : Math.ceil((options.graceMs ?? 10_000) / 500),
  });
  if (termination.survivors.length > 0) {
    console.warn(
      `  warning: browser processes for ${profileDir} survived SIGKILL: ${termination.survivors.join(', ')}`,
    );
  }
  await safely(() => windows.focusWorkspace(homeWorkspace));
  if (options.requireGracefulExit && termination.forcedTerminationPids.length > 0) {
    throw new Error(
      `Firefox profile shutdown did not finish gracefully within ${options.graceMs ?? 60_000}ms; sent SIGTERM to ${termination.forcedTerminationPids.join(', ')}`,
    );
  }
}

function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunnerInterruptedError('benchmark run interrupted');
}

export interface RunOneDependencies {
  wait(milliseconds: number): Promise<void>;
  terminate(
    windows: WindowController,
    address: string | null,
    profileDir: string,
    homeWorkspace: number,
    options?: BrowserTerminationOptions,
  ): Promise<void>;
}

const defaultRunOneDependencies: RunOneDependencies = {
  wait: delay,
  terminate: terminateBrowser,
};

export async function runOne(
  config: RunnerConfig,
  server: BenchmarkServer,
  benchRoot: string,
  windows: WindowController,
  adapter: BrowserAdapter,
  profileDir: string,
  iteration: number,
  currentSuiteRunId: string,
  homeWorkspace: number,
  signal: AbortSignal,
  dependencies: RunOneDependencies = defaultRunOneDependencies,
): Promise<ResultMatch | null> {
  const runId = `${currentSuiteRunId}-${adapter.name}-i${iteration}`;
  // Each engine gets its own dedicated workspace unless `--workspace` overrode
  // it, so running both browsers never tiles two windows onto one workspace and
  // halves the viewport each is measuring.
  const workspace = config.workspace ?? ENGINE_WORKSPACE[adapter.name];
  const profiler = config.mode === 'profile' ? adapter.profiler : null;
  if (config.mode === 'profile' && !profiler) {
    throw new Error(`${adapter.name} profile mode is not implemented`);
  }
  const url = runUrl(
    server.url,
    runId,
    currentSuiteRunId,
    iteration,
    config,
    profiler?.gate ?? false,
  );
  const profileOptions = profiler
    ? {
        profileDir,
        targetUrl: url,
        tracePath: resolve(benchRoot, 'traces', `${runId}.json.gz`),
        signal,
      }
    : null;
  const resultStart = server.written.length;
  let address: string | null = null;
  let browserPid: number | null = null;
  let profileSession: BrowserProfileSession | null = null;

  // Read before launch: Firefox's frame rate is a profile preference, so it has to
  // be written before the process starts. Null leaves the pref unset, which puts
  // Firefox back on its 60Hz default — the page's cadence gate reports that rather
  // than letting it pass as a measurement.
  const panelHz = await windows.panelRefreshHz();
  await adapter.prepareProfile(profileDir, panelHz);
  const environment = profileOptions ? await profiler?.prepare(profileOptions) : undefined;
  const launchSpec = adapter.launchSpec(profileDir, url, config.viewport, config.mode);
  const spec: BrowserLaunchSpec =
    environment && Object.keys(environment).length > 0
      ? { ...launchSpec, environment }
      : launchSpec;
  let result: ResultMatch | null = null;
  const failures: unknown[] = [];
  try {
    result = await (async () => {
      console.log(`  launching ${adapter.name} on workspace ${workspace} (incognito)…`);
      await windows.launch(workspace, spec);
      if (profileOptions && profiler) {
        profileSession = await profiler.start(profileOptions);
      }
      await windows.focusWorkspace(workspace);

      const windowDeadline = Date.now() + 30_000;
      while (Date.now() < windowDeadline) {
        checkInterrupted(signal);
        address = await windows.find(workspace, spec.windowClass, 'vectojs');
        if (address) {
          if (windows.processId) {
            try {
              browserPid = await windows.processId(address);
            } catch {}
          }
          break;
        }
        const finished = await findResult(server.written, resultStart, runId);
        if (finished) {
          console.log(
            `  ${adapter.name} -> ${finished.path} (finished before its window was seen)`,
          );
          return finished;
        }
        await dependencies.wait(500);
      }

      if (!address) {
        const finished = await findResult(server.written, resultStart, runId);
        if (finished) {
          console.log(`  ${adapter.name} -> ${finished.path}`);
          return finished;
        }
        console.error(`  ${adapter.name}: no window appeared on workspace ${workspace}`);
        return null;
      }

      await windows.focusWindow(address);
      console.log(`  focused ${address}`);
      await profileSession?.releaseBenchmark();
      let deadline = Date.now() + config.timeoutMs;
      let nextFocus = Date.now() + 20_000;
      let extended = false;
      while (true) {
        checkInterrupted(signal);
        const finished = await findResult(server.written, resultStart, runId);
        if (finished) {
          console.log(`  ${adapter.name} -> ${finished.path}`);
          return finished;
        }

        const now = Date.now();
        if (now >= deadline) {
          if (!extended && config.extendMs > 0) {
            console.log(
              `  not finished at ${config.timeoutMs / 1_000}s — extending by ${config.extendMs / 1_000}s`,
            );
            deadline += config.extendMs;
            extended = true;
          } else {
            console.error(
              `  ${adapter.name} timed out after ${(config.timeoutMs + config.extendMs) / 1_000}s`,
            );
            return null;
          }
        }
        if (now >= nextFocus) {
          await safely(() => windows.focusWorkspace(workspace));
          await safely(() => windows.focusWindow(address));
          nextFocus = now + 20_000;
        }
        await dependencies.wait(500);
      }
    })();
  } catch (error) {
    failures.push(error);
  }

  const stopProfile = async (): Promise<void> => {
    if (!profileSession) return;
    try {
      const artifact = await profileSession.stop();
      console.log(`  ${adapter.name} trace -> ${artifact.tracePath}`);
    } catch (error) {
      failures.push(error);
    }
  };
  if (profileSession && !profileSession.stopAfterBrowserExit) {
    await stopProfile();
  }
  try {
    await dependencies.terminate(windows, address, profileDir, homeWorkspace, {
      graceMs: profileSession?.shutdownGraceMs,
      requireGracefulExit: profileSession?.stopAfterBrowserExit,
      rootPid: browserPid,
    });
  } catch (error) {
    failures.push(error);
  }
  if (profileSession?.stopAfterBrowserExit) {
    await stopProfile();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${adapter.name} run and cleanup failed`);
  }
  return result;
}

export async function runBenchmarkSuite(
  config: RunnerConfig,
  signal: AbortSignal,
): Promise<number> {
  const benchRoot = resolve(benchmarksRoot, config.benchDir);
  const resultsRoot = join(benchRoot, 'results');
  const currentSuiteRunId = suiteRunId();
  const runRoot = join(repositoryRoot, 'tmp', 'benchmark-runner', currentSuiteRunId);
  await mkdir(runRoot, { recursive: true });

  const windows = new HyprlandWindowController();
  const homeWorkspace = await windows.activeWorkspace();
  let server: BenchmarkServer | null = null;
  const warmProfiles = new Map<string, string>();
  const matches: ResultMatch[] = [];
  let status = 0;

  try {
    server = await startRunnerServer(benchRoot, config.port);
    console.log(`serving ${config.benchDir} on ${server.url} (runId ${currentSuiteRunId})`);

    browserLoop: for (const browserName of config.browsers) {
      const adapter = browserAdapter(browserName);
      if (!adapter.resolveExecutable()) {
        console.log(`  ${browserName}: not installed, skipping`);
        continue;
      }

      try {
        for (let iteration = 1; iteration <= config.iterations; iteration += 1) {
          checkInterrupted(signal);
          if (config.iterations > 1) {
            console.log(`  iteration ${iteration}/${config.iterations} (${config.profileState})`);
          }
          let profileDir = warmProfiles.get(browserName);
          if (!profileDir) {
            profileDir = await mkdtemp(join(runRoot, `${browserName}-`));
            if (config.profileState === 'warm') warmProfiles.set(browserName, profileDir);
          }

          let match: ResultMatch | null = null;
          try {
            match = await runOne(
              config,
              server,
              benchRoot,
              windows,
              adapter,
              profileDir,
              iteration,
              currentSuiteRunId,
              homeWorkspace,
              signal,
            );
          } catch (error) {
            if (error instanceof RunnerInterruptedError) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`  ${browserName} iteration ${iteration} failed: ${detail}`);
          } finally {
            if (config.profileState === 'cold')
              await rm(profileDir, { recursive: true, force: true });
          }

          if (match) {
            matches.push(match);
          } else {
            status = 1;
            if (!config.keepGoing) {
              console.error(
                `  aborting after ${browserName} iteration ${iteration} failed (pass --keep-going to try the rest)`,
              );
              break browserLoop;
            }
          }
        }
      } finally {
        const warmProfile = warmProfiles.get(browserName);
        if (warmProfile) {
          await rm(warmProfile, { recursive: true, force: true });
          warmProfiles.delete(browserName);
        }
      }
    }

    const warnings = starvationWarnings(matches);
    if (warnings.length > 0) {
      console.warn('');
      console.warn(
        'WARNING: rAF was starved in these arms — their per-frame numbers are NOT usable:',
      );
      for (const warning of warnings) console.warn(warning);
      console.warn('  Keep the benchmark window focused and visible for the whole run');
      console.warn('  (no workspace switching, no other browser raising itself).');
    }

    if (config.iterations > 1 && config.mode === 'measure') {
      console.log('');
      console.log(`aggregating ${config.iterations} iteration(s) per browser:`);
      if (!(await aggregateSuite(benchmarksRoot, benchRoot, currentSuiteRunId))) status = 1;
    }

    console.log(
      `results in ${resultsRoot}/ (history/ keyed by runId, latest/ for the stable path)`,
    );
    if (config.iterations > 1) {
      console.log('aggregate in results/aggregate/ (median/p90/p95/MAD across processes)');
    }
    console.log(
      `runId ${currentSuiteRunId}  commit ${await shortCommit()}  mode ${config.mode}  profile ${config.profileState}`,
    );
    return status;
  } finally {
    server?.stop();
    for (const profileDir of warmProfiles.values()) {
      await terminateBrowser(windows, null, profileDir, homeWorkspace);
    }
    await safely(() => windows.focusWorkspace(homeWorkspace));
    await rm(runRoot, { recursive: true, force: true });
  }
}
