import type { BrowserLaunchSpec, WindowController } from '../types';
import type { HyprlandClient } from './interface';

async function command(args: string[]): Promise<string> {
  const subprocess = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(subprocess.stdout).text();
  const stderr = new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;
  const output = await stdout;
  const error = await stderr;
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed (${exitCode}): ${error.trim()}`);
  }
  return output;
}

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function formatBrowserLaunchCommand(spec: BrowserLaunchSpec): string {
  const environment = Object.entries(spec.environment ?? {});
  for (const [name] of environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid browser environment variable name: ${name}`);
    }
  }
  const command =
    environment.length === 0
      ? [spec.executable, ...spec.args]
      : [
          '/usr/bin/env',
          ...environment.map(([name, value]) => `${name}=${value}`),
          spec.executable,
          ...spec.args,
        ];
  return command.map(quoteShellArgument).join(' ');
}

export function selectWindow(
  clients: readonly HyprlandClient[],
  workspace: number,
  className: string,
  titleFragment: string,
): string | null {
  const wantedClass = className.toLowerCase();
  const wantedTitle = titleFragment.toLowerCase();
  let fallback: string | null = null;
  for (const client of clients) {
    if (client.workspace !== workspace || !client.className.toLowerCase().includes(wantedClass)) {
      continue;
    }
    fallback ??= client.address;
    if (wantedTitle && client.title.toLowerCase().includes(wantedTitle)) return client.address;
  }
  return fallback;
}

function parseClients(value: unknown): HyprlandClient[] {
  if (!Array.isArray(value)) throw new Error('hyprctl clients did not return an array');
  const clients: HyprlandClient[] = [];
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('address' in item) ||
      typeof item.address !== 'string' ||
      !('class' in item) ||
      typeof item.class !== 'string' ||
      !('title' in item) ||
      typeof item.title !== 'string' ||
      !('workspace' in item) ||
      typeof item.workspace !== 'object' ||
      item.workspace === null ||
      !('id' in item.workspace) ||
      typeof item.workspace.id !== 'number'
    ) {
      continue;
    }
    clients.push({
      address: item.address,
      className: item.class,
      title: item.title,
      pid: 'pid' in item && typeof item.pid === 'number' ? item.pid : undefined,
      workspace: item.workspace.id,
    });
  }
  return clients;
}

export class HyprlandWindowController implements WindowController {
  public async activeWorkspace(): Promise<number> {
    try {
      const value: unknown = JSON.parse(await command(['hyprctl', 'activeworkspace', '-j']));
      if (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'number'
      ) {
        return value.id;
      }
    } catch {}
    return 2;
  }

  public async launch(workspace: number, spec: BrowserLaunchSpec): Promise<void> {
    const browserCommand = formatBrowserLaunchCommand(spec);
    await command(['hyprctl', 'dispatch', 'exec', `[workspace ${workspace}] ${browserCommand}`]);
  }

  public async find(
    workspace: number,
    className: string,
    titleFragment: string,
  ): Promise<string | null> {
    const value: unknown = JSON.parse(await command(['hyprctl', 'clients', '-j']));
    return selectWindow(parseClients(value), workspace, className, titleFragment);
  }

  public async processId(address: string): Promise<number | null> {
    const value: unknown = JSON.parse(await command(['hyprctl', 'clients', '-j']));
    return parseClients(value).find((client) => client.address === address)?.pid ?? null;
  }

  public async focusWorkspace(workspace: number): Promise<void> {
    await command(['hyprctl', 'dispatch', 'workspace', String(workspace)]);
  }

  public async focusWindow(address: string): Promise<void> {
    await command(['hyprctl', 'dispatch', 'focuswindow', `address:${address}`]);
  }

  public async closeWindow(address: string): Promise<void> {
    await command(['hyprctl', 'dispatch', 'closewindow', `address:${address}`]);
  }
}
