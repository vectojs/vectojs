import type { BrowserName, RunnerConfig, Viewport } from './types';

const USAGE =
  'usage: run-browsers.sh <bench-dir> <port> [--workspace N] [--keep-going] ' +
  '[--viewport WxH] [--iterations N] [--warm] [--mode measure|profile] ' +
  '[--param KEY=VALUE ...] [chrome|firefox ...]';

/**
 * Dedicated test workspace per engine on this host.
 *
 * Both are reserved for testing, so a benchmark window is never occluded by real
 * work and never steals focus from it — which matters because an unfocused
 * window on an inactive Hyprland workspace loses compositor frame callbacks and
 * its rAF silently drops to a ~60Hz timer. Measured on the 240Hz panel: the same
 * page reported 59.88Hz unfocused against 240.1Hz focused, while
 * `document.hasFocus()` returned `true` in both, so the page cannot detect it.
 *
 * One workspace *per engine* rather than one shared: two browser windows on the
 * same workspace tile side by side, which halves each viewport and silently
 * changes the workload being measured.
 */
export const ENGINE_WORKSPACE: Readonly<Record<BrowserName, number>> = {
  chrome: 5,
  firefox: 6,
};

export class RunnerUsageError extends Error {}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new RunnerUsageError(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new RunnerUsageError(`${label} must be a positive integer, got '${value}'`);
  }
  return Number(value);
}

function nonnegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RunnerUsageError(`${label} must be a non-negative integer, got '${value}'`);
  }
  return Number(value);
}

function timeoutMs(
  value: string | undefined,
  fallbackSeconds: number,
  label: string,
  allowZero = false,
): number {
  if (value === undefined) return fallbackSeconds * 1_000;
  return (allowZero ? nonnegativeInteger(value, label) : positiveInteger(value, label)) * 1_000;
}

function viewport(value: string): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new RunnerUsageError(`--viewport must be WIDTHxHEIGHT, got '${value}'`);
  return {
    width: positiveInteger(match[1]!, '--viewport width'),
    height: positiveInteger(match[2]!, '--viewport height'),
  };
}

/**
 * Query keys `runUrl` sets itself. A `--param` may not write these: `runId` and
 * `suiteRunId` are how a posted result is matched back to its run, and `mode`
 * selects the profiler, so silently letting a caller override one would produce
 * a run that either cannot be matched or does not measure what it reports.
 */
export const RESERVED_PARAMS: readonly string[] = [
  'runId',
  'suiteRunId',
  'iteration',
  'mode',
  'profileState',
  'gate',
];

function param(value: string, into: Map<string, string>): void {
  const separator = value.indexOf('=');
  if (separator < 1) {
    throw new RunnerUsageError(`--param must be KEY=VALUE, got '${value}'`);
  }
  const key = value.slice(0, separator);
  if (RESERVED_PARAMS.includes(key)) {
    throw new RunnerUsageError(`--param ${key} is set by the runner and cannot be overridden`);
  }
  if (into.has(key)) {
    throw new RunnerUsageError(`--param ${key} given more than once`);
  }
  into.set(key, value.slice(separator + 1));
}

function browser(value: string): BrowserName {
  if (value === 'chrome' || value === 'firefox') return value;
  throw new RunnerUsageError(`unknown browser: ${value}`);
}

export function parseRunnerArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunnerConfig {
  const benchDir = args[0];
  const portText = args[1];
  if (!benchDir || !portText) throw new RunnerUsageError(USAGE);
  const port = positiveInteger(portText, 'port');
  if (port > 65_535) throw new RunnerUsageError(`port must be at most 65535, got '${portText}'`);

  // `null` means "use the per-engine default" (see ENGINE_WORKSPACE): Chrome on
  // 5, Firefox on 6. Both are reserved for testing on this host, so a benchmark
  // window cannot be occluded by real work — and giving each engine its own
  // workspace stops the two tiling side by side, which halves each window and
  // changes the viewport being measured. `--workspace N` overrides both.
  let workspace: number | null = null;
  let keepGoing = false;
  let configuredViewport: Viewport | null = null;
  let iterations = 1;
  let profileState: RunnerConfig['profileState'] = 'cold';
  let mode: RunnerConfig['mode'] = 'measure';
  const params = new Map<string, string>();
  let index = 2;

  while (index < args.length && args[index]?.startsWith('--')) {
    const option = args[index]!;
    switch (option) {
      case '--workspace':
        workspace = positiveInteger(optionValue(args, index, option), option);
        index += 2;
        break;
      case '--keep-going':
        keepGoing = true;
        index += 1;
        break;
      case '--viewport':
        // Browser launch flags request the native outer window. The page records
        // its resulting CSS content viewport in the shared result envelope.
        configuredViewport = viewport(optionValue(args, index, option));
        index += 2;
        break;
      case '--iterations':
        iterations = positiveInteger(optionValue(args, index, option), option);
        index += 2;
        break;
      case '--warm':
        profileState = 'warm';
        index += 1;
        break;
      case '--param':
        param(optionValue(args, index, option), params);
        index += 2;
        break;
      case '--mode': {
        const value = optionValue(args, index, option);
        if (value !== 'measure' && value !== 'profile') {
          throw new RunnerUsageError(`unknown --mode '${value}' (expected measure or profile)`);
        }
        mode = value;
        index += 2;
        break;
      }
      default:
        throw new RunnerUsageError(`unknown option: ${option}`);
    }
  }

  if (mode === 'profile' && iterations > 1) {
    throw new RunnerUsageError(
      '--mode profile does not support --iterations > 1: profiler overhead makes aggregated timings misleading',
    );
  }

  const browserArgs = args.slice(index);
  const browsers = browserArgs.length === 0 ? ['chrome' as const] : browserArgs.map(browser);
  // Resolved per engine at launch time, not here: one invocation can run both
  // browsers, so a single number cannot serve them.
  return {
    benchDir,
    port,
    workspace,
    keepGoing,
    viewport: configuredViewport,
    iterations,
    profileState,
    mode,
    params: Object.fromEntries(params),
    browsers,
    timeoutMs: timeoutMs(env.RUN_TIMEOUT, 60, 'RUN_TIMEOUT'),
    extendMs: timeoutMs(env.RUN_EXTEND, 180, 'RUN_EXTEND', true),
  };
}

export interface RunnerResult {
  runId: string;
  suiteRunId: string;
  engine: string;
  rows: unknown[];
}

export function parseRunnerResult(value: unknown): RunnerResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runId' in value) ||
    typeof value.runId !== 'string' ||
    !('suiteRunId' in value) ||
    typeof value.suiteRunId !== 'string' ||
    !('engine' in value) ||
    typeof value.engine !== 'string' ||
    !('rows' in value) ||
    !Array.isArray(value.rows)
  ) {
    throw new Error('benchmark result does not match the runner envelope');
  }
  return {
    runId: value.runId,
    suiteRunId: value.suiteRunId,
    engine: value.engine,
    rows: value.rows,
  };
}
