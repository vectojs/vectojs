import { join } from 'node:path';
import { parseRunnerResult, type RunnerResult } from './schema';

export interface ResultMatch {
  path: string;
  result: RunnerResult;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value : null;
}

export async function findResult(
  paths: readonly string[],
  startIndex: number,
  runId: string,
): Promise<ResultMatch | null> {
  for (let index = paths.length - 1; index >= startIndex; index -= 1) {
    const path = paths[index]!;
    const value: unknown = await Bun.file(path).json();
    const candidate = record(value);
    if (candidate?.runId !== runId) continue;
    return { path, result: parseRunnerResult(value) };
  }
  return null;
}

export function starvationWarnings(matches: readonly ResultMatch[]): string[] {
  const warnings: string[] = [];
  for (const { result } of matches) {
    for (const value of result.rows) {
      const row = record(value);
      if (row?.starved !== true) continue;
      warnings.push(
        `  ${result.engine} ${String(row.shape ?? '?')} ${String(row.chunkRate ?? '?')}/s ${String(row.mode ?? '?')}: offered ${String(row.streamOffered ?? '?')} of ~${String(row.expectedFrames ?? '?')}`,
      );
    }
  }
  return warnings;
}

export async function aggregateSuite(
  benchmarksRoot: string,
  benchRoot: string,
  suiteRunId: string,
): Promise<boolean> {
  const aggregatePath = join(benchmarksRoot, '_shared', 'aggregate.ts');
  const subprocess = Bun.spawn([process.execPath, 'run', aggregatePath, benchRoot, suiteRunId], {
    cwd: benchmarksRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return (await subprocess.exited) === 0;
}
