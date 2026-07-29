import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface TerminationOptions {
  procRoot?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  killProcess?: (pid: number, signal: ProcessSignal) => void;
  termWaitSteps?: number;
  gracefulWaitSteps?: number;
  rootPid?: number | null;
}

export interface ProfileTerminationResult {
  forcedTerminationPids: number[];
  forcedKillPids: number[];
  survivors: number[];
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

async function processTreeIds(rootPid: number, procRoot: string): Promise<number[]> {
  const found: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = await readFile(
        join(procRoot, String(pid), 'task', String(pid), 'children'),
        'utf8',
      );
      found.push(pid);
      for (const child of children.trim().split(/\s+/)) {
        if (/^\d+$/.test(child)) pending.push(Number(child));
      }
    } catch {}
  }
  return found;
}

async function processDirectoryExists(pid: number, procRoot: string): Promise<boolean> {
  try {
    await readdir(join(procRoot, String(pid)));
    return true;
  } catch {
    return false;
  }
}

async function ownedProcessIds(
  profileDir: string,
  procRoot: string,
  rootPid: number | null,
  trackedTree: Set<number>,
): Promise<number[]> {
  if (rootPid !== null) {
    for (const pid of await processTreeIds(rootPid, procRoot)) trackedTree.add(pid);
  }
  const matches = new Set(await profileProcessIds(profileDir, procRoot));
  for (const pid of trackedTree) {
    if (await processDirectoryExists(pid, procRoot)) matches.add(pid);
    else trackedTree.delete(pid);
  }
  return [...matches].sort((left, right) => left - right);
}

export async function terminateProfileProcessesDetailed(
  profileDir: string,
  options: TerminationOptions = {},
): Promise<ProfileTerminationResult> {
  const procRoot = options.procRoot ?? '/proc';
  const sleep = options.sleep ?? defaultSleep;
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const termWaitSteps = options.termWaitSteps ?? 20;
  const rootPid = options.rootPid ?? null;
  const trackedTree = new Set<number>();

  let matches = await ownedProcessIds(profileDir, procRoot, rootPid, trackedTree);
  for (let step = 0; step < (options.gracefulWaitSteps ?? 0) && matches.length > 0; step += 1) {
    await sleep(500);
    matches = await ownedProcessIds(profileDir, procRoot, rootPid, trackedTree);
  }
  const forcedTerminationPids = [...matches];
  for (const pid of matches) {
    try {
      killProcess(pid, 'SIGTERM');
    } catch {}
  }
  for (let step = 0; step < termWaitSteps && matches.length > 0; step += 1) {
    await sleep(500);
    matches = await ownedProcessIds(profileDir, procRoot, rootPid, trackedTree);
  }
  const forcedKillPids = matches;
  for (const pid of forcedKillPids) {
    try {
      killProcess(pid, 'SIGKILL');
    } catch {}
  }
  if (forcedKillPids.length > 0) await sleep(500);
  return {
    forcedTerminationPids,
    forcedKillPids,
    survivors: await ownedProcessIds(profileDir, procRoot, rootPid, trackedTree),
  };
}

export async function terminateProfileProcesses(
  profileDir: string,
  options: TerminationOptions = {},
): Promise<number[]> {
  return (await terminateProfileProcessesDetailed(profileDir, options)).survivors;
}
