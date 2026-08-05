import { startBenchmarkServer, type BenchmarkServer } from '../_shared/server';

export async function startRunnerServer(benchRoot: string, port: number): Promise<BenchmarkServer> {
  try {
    return await startBenchmarkServer({ benchRoot, port });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`benchmark server failed to start: ${detail}`, { cause: error });
  }
}
