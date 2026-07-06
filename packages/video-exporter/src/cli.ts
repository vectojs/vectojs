#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportVideo } from './index.js';
import type { ExportOptions } from './options.js';

type Signal = 'SIGINT' | 'SIGTERM';
type SignalListener = () => void;

export interface CliRuntime {
  exportVideo(options: ExportOptions): Promise<void>;
  error(...values: unknown[]): void;
  once(signal: Signal, listener: SignalListener): unknown;
  off(signal: Signal, listener: SignalListener): unknown;
}

const defaultRuntime: CliRuntime = {
  exportVideo,
  error: (...values) => console.error(...values),
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

const USAGE = `Usage: vecto-export <url> [options]
Options:
  -o, --output <file>    Output file (default: out.mp4)
  -w, --width <pixels>   Width in pixels (default: 1280)
  -h, --height <pixels>  Height in pixels (default: 720)
  -f, --fps <number>     Frames per second (default: 60)
  -d, --duration <secs>  Duration in seconds (default: 5)`;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`Invalid ${name}: expected a positive integer, received ${value}`);
  }
  return parsed;
}

function positiveNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(`Invalid ${name}: expected a positive number, received ${value}`);
  }
  return parsed;
}

export async function runCli(
  args: string[],
  runtime: CliRuntime = defaultRuntime,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        output: { type: 'string', short: 'o', default: 'out.mp4' },
        width: { type: 'string', short: 'w', default: '1280' },
        height: { type: 'string', short: 'h', default: '720' },
        fps: { type: 'string', short: 'f', default: '60' },
        duration: { type: 'string', short: 'd', default: '5' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    runtime.error(`Invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
    runtime.error(USAGE);
    return 1;
  }

  const url = parsed.positionals[0];
  if (!url) {
    runtime.error(USAGE);
    return 1;
  }

  let width: number;
  let height: number;
  let fps: number;
  let duration: number;
  const values = parsed.values as {
    output: string;
    width: string;
    height: string;
    fps: string;
    duration: string;
  };
  try {
    width = positiveInteger('width', values.width);
    height = positiveInteger('height', values.height);
    fps = positiveInteger('fps', values.fps);
    duration = positiveNumber('duration', values.duration);
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const controller = new AbortController();
  let signalExitCode: number | undefined;
  const onSigint = () => {
    signalExitCode = 130;
    controller.abort(new Error('Interrupted by SIGINT'));
  };
  const onSigterm = () => {
    signalExitCode = 143;
    controller.abort(new Error('Terminated by SIGTERM'));
  };
  runtime.once('SIGINT', onSigint);
  runtime.once('SIGTERM', onSigterm);

  try {
    await runtime.exportVideo({
      url,
      outputPath: values.output,
      width,
      height,
      fps,
      duration,
      signal: controller.signal,
    });
    return signalExitCode ?? 0;
  } catch (error) {
    if (signalExitCode !== undefined) return signalExitCode;
    runtime.error('Export failed:', error);
    return 1;
  } finally {
    runtime.off('SIGINT', onSigint);
    runtime.off('SIGTERM', onSigterm);
  }
}

function isExecutableEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isExecutableEntry()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
