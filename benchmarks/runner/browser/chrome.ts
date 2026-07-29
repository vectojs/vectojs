import type { BrowserAdapter, BrowserLaunchSpec, Viewport } from '../types';
import { firstExecutable } from './interface';

export class ChromeAdapter implements BrowserAdapter {
  public readonly name = 'chrome';

  public constructor(private readonly executableOverride?: string) {}

  public resolveExecutable(): string | null {
    return (
      this.executableOverride ??
      firstExecutable(['google-chrome-stable', 'chromium', 'google-chrome'])
    );
  }

  public async prepareProfile(_profileDir: string): Promise<void> {}

  public launchSpec(profileDir: string, url: string, viewport: Viewport | null): BrowserLaunchSpec {
    const executable = this.resolveExecutable();
    if (!executable) throw new Error('chrome is not installed');
    const basename = executable.split('/').at(-1);
    const windowClass = basename === 'chromium' ? 'chromium' : 'google-chrome';
    const args = [
      '--incognito',
      '--new-window',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (viewport) args.push(`--window-size=${viewport.width},${viewport.height}`);
    args.push(url);
    return { executable, args, windowClass };
  }
}
