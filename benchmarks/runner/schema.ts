import type { BrowserName, RunnerConfig, Viewport } from './types';

const USAGE = 'usage: run-browsers.sh <bench-dir> <port> [options] [chrome|firefox ...]';

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

  let workspace = 3;
  let keepGoing = false;
  let configuredViewport: Viewport | null = null;
  let iterations = 1;
  let profileState: RunnerConfig['profileState'] = 'cold';
  let mode: RunnerConfig['mode'] = 'measure';
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
  if (mode === 'profile' && browsers.some((name) => name !== 'chrome')) {
    throw new RunnerUsageError(
      '--mode profile currently supports Chrome only; Firefox Gecko profiling is not implemented',
    );
  }
  return {
    benchDir,
    port,
    workspace,
    keepGoing,
    viewport: configuredViewport,
    iterations,
    profileState,
    mode,
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
