import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface TerminationOptions {
  procRoot?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  killProcess?: (pid: number, signal: ProcessSignal) => void;
  termWaitSteps?: number;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function profileProcessIds(profileDir: string, procRoot = '/proc'): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const matches: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = await readFile(join(procRoot, entry, 'cmdline'), 'utf8');
      if (commandLine.includes(profileDir)) matches.push(Number(entry));
    } catch {}
  }
  return matches;
}

export async function terminateProfileProcesses(
  profileDir: string,
  options: TerminationOptions = {},
): Promise<number[]> {
  const procRoot = options.procRoot ?? '/proc';
  const sleep = options.sleep ?? defaultSleep;
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const termWaitSteps = options.termWaitSteps ?? 20;

  let matches = await profileProcessIds(profileDir, procRoot);
  for (const pid of matches) {
    try {
      killProcess(pid, 'SIGTERM');
    } catch {}
  }
  for (let step = 0; step < termWaitSteps && matches.length > 0; step += 1) {
    await sleep(500);
    matches = await profileProcessIds(profileDir, procRoot);
  }
  for (const pid of matches) {
    try {
      killProcess(pid, 'SIGKILL');
    } catch {}
  }
  if (matches.length > 0) await sleep(500);
  return profileProcessIds(profileDir, procRoot);
}
