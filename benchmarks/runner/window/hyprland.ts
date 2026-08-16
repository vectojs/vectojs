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

export function formatHyprlandLaunchDispatcher(workspace: number, command: string): string {
  assertWorkspace(workspace);
  return `hl.dsp.exec_cmd(${JSON.stringify(command)}, { workspace = ${JSON.stringify(`${workspace} silent`)} })`;
}

export function formatHyprlandWorkspaceDispatcher(workspace: number): string {
  assertWorkspace(workspace);
  return `hl.dsp.focus({ workspace = ${JSON.stringify(String(workspace))} })`;
}

export function formatHyprlandWindowDispatcher(action: 'focus' | 'close', address: string): string {
  if (!/^0x[0-9a-f]+$/i.test(address))
    throw new Error(`invalid Hyprland window address: ${address}`);
  const selector = JSON.stringify(`address:${address}`);
  return action === 'focus'
    ? `hl.dsp.focus({ window = ${selector} })`
    : `hl.dsp.window.close({ window = ${selector} })`;
}

function assertWorkspace(workspace: number): void {
  if (!Number.isInteger(workspace) || workspace < 1) {
    throw new Error(`invalid benchmark workspace: ${workspace}`);
  }
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

/**
 * The fastest enabled monitor's refresh rate from `hyprctl monitors -j` output.
 *
 * Exported for tests: getting this wrong is silent and expensive. A null return
 * makes the runner leave `layout.frame_rate` alone, which puts Firefox back on the
 * 60 Hz default, so a parsing slip would restore the exact defect this fixes while
 * every run still completed and reported numbers.
 *
 * The fastest rather than the focused monitor, because the runner writes this into
 * a browser profile before the window exists, and therefore before there is a
 * window whose monitor could be consulted.
 */
export function selectPanelRefreshHz(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let best = 0;
  for (const monitor of value) {
    if (typeof monitor !== 'object' || monitor === null) continue;
    if ('disabled' in monitor && monitor.disabled === true) continue;
    if (!('refreshRate' in monitor) || typeof monitor.refreshRate !== 'number') continue;
    if (Number.isFinite(monitor.refreshRate) && monitor.refreshRate > best) {
      best = monitor.refreshRate;
    }
  }
  // Rounded to 2dp: hyprctl reports 240.00000, and Firefox's pref is an integer
  // anyway, so carrying more precision only invites a spurious mismatch.
  return best > 0 ? Math.round(best * 100) / 100 : null;
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

  public async panelRefreshHz(): Promise<number | null> {
    try {
      const value: unknown = JSON.parse(await command(['hyprctl', 'monitors', '-j']));
      return selectPanelRefreshHz(value);
    } catch {
      return null;
    }
  }

  public async launch(workspace: number, spec: BrowserLaunchSpec): Promise<void> {
    const browserCommand = formatBrowserLaunchCommand(spec);
    await command([
      'hyprctl',
      'dispatch',
      formatHyprlandLaunchDispatcher(workspace, browserCommand),
    ]);
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
    await command(['hyprctl', 'dispatch', formatHyprlandWorkspaceDispatcher(workspace)]);
  }

  public async focusWindow(address: string): Promise<void> {
    await command(['hyprctl', 'dispatch', formatHyprlandWindowDispatcher('focus', address)]);
  }

  public async closeWindow(address: string): Promise<void> {
    await command(['hyprctl', 'dispatch', formatHyprlandWindowDispatcher('close', address)]);
  }
}
