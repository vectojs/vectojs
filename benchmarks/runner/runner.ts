import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkServer } from '../_shared/server';
import { browserAdapter } from './browser';
import { terminateProfileProcesses } from './processes';
import { aggregateSuite, findResult, starvationWarnings, type ResultMatch } from './results';
import { startRunnerServer } from './server';
import type { BrowserAdapter, BrowserLaunchSpec, RunnerConfig, WindowController } from './types';
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

function runUrl(
  serverUrl: string,
  runId: string,
  currentSuiteRunId: string,
  iteration: number,
  config: RunnerConfig,
): string {
  const url = new URL(serverUrl);
  url.searchParams.set('runId', runId);
  url.searchParams.set('suiteRunId', currentSuiteRunId);
  url.searchParams.set('iteration', String(iteration));
  url.searchParams.set('mode', config.mode);
  url.searchParams.set('profileState', config.profileState);
  return url.href;
}

async function safely(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {}
}

async function terminateBrowser(
  windows: WindowController,
  address: string | null,
  profileDir: string,
  homeWorkspace: number,
): Promise<void> {
  if (address) {
    await safely(() => windows.closeWindow(address));
    await delay(500);
  }
  const survivors = await terminateProfileProcesses(profileDir);
  if (survivors.length > 0) {
    console.warn(
      `  warning: browser processes for ${profileDir} survived SIGKILL: ${survivors.join(', ')}`,
    );
  }
  await safely(() => windows.focusWorkspace(homeWorkspace));
}

function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunnerInterruptedError('benchmark run interrupted');
}

async function runOne(
  config: RunnerConfig,
  server: BenchmarkServer,
  windows: WindowController,
  adapter: BrowserAdapter,
  profileDir: string,
  iteration: number,
  currentSuiteRunId: string,
  homeWorkspace: number,
  signal: AbortSignal,
): Promise<ResultMatch | null> {
  const runId = `${currentSuiteRunId}-${adapter.name}-i${iteration}`;
  const url = runUrl(server.url, runId, currentSuiteRunId, iteration, config);
  const resultStart = server.written.length;
  let address: string | null = null;

  await adapter.prepareProfile(profileDir);
  const spec: BrowserLaunchSpec = adapter.launchSpec(profileDir, url, config.viewport);
  try {
    console.log(`  launching ${adapter.name} on workspace ${config.workspace} (incognito)…`);
    await windows.launch(config.workspace, spec);
    await windows.focusWorkspace(config.workspace);

    const windowDeadline = Date.now() + 30_000;
    while (Date.now() < windowDeadline) {
      checkInterrupted(signal);
      const finished = await findResult(server.written, resultStart, runId);
      if (finished) {
        console.log(`  ${adapter.name} -> ${finished.path} (finished before its window was seen)`);
        return finished;
      }
      address = await windows.find(config.workspace, spec.windowClass, 'vectojs');
      if (address) break;
      await delay(500);
    }

    if (!address) {
      const finished = await findResult(server.written, resultStart, runId);
      if (finished) {
        console.log(`  ${adapter.name} -> ${finished.path}`);
        return finished;
      }
      console.error(`  ${adapter.name}: no window appeared on workspace ${config.workspace}`);
      return null;
    }

    await windows.focusWindow(address);
    console.log(`  focused ${address}`);
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
        await safely(() => windows.focusWorkspace(config.workspace));
        await safely(() => windows.focusWindow(address));
        nextFocus = now + 20_000;
      }
      await delay(500);
    }
  } finally {
    await terminateBrowser(windows, address, profileDir, homeWorkspace);
  }
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
