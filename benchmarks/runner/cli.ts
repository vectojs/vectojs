import { runBenchmarkSuite, RunnerInterruptedError } from './runner';
import { parseRunnerArgs, RunnerUsageError } from './schema';

async function main(): Promise<number> {
  const config = parseRunnerArgs(process.argv.slice(2));
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    return await runBenchmarkSuite(config, controller.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof RunnerInterruptedError) {
    console.error(error.message);
    process.exitCode = 130;
  } else if (error instanceof RunnerUsageError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
