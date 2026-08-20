import { startChromeProfile } from '../profile/chrome';
import type {
  BenchmarkMode,
  BrowserAdapter,
  BrowserLaunchSpec,
  BrowserProfiler,
  Viewport,
} from '../types';
import { firstExecutable } from './interface';

export class ChromeAdapter implements BrowserAdapter {
  public readonly name = 'chrome';
  public readonly profiler: BrowserProfiler = {
    gate: true,
    prepare: () => Promise.resolve({}),
    start: startChromeProfile,
  };

  public constructor(private readonly executableOverride?: string) {}

  public resolveExecutable(): string | null {
    return (
      this.executableOverride ??
      firstExecutable(['google-chrome-stable', 'chromium', 'google-chrome'])
    );
  }

  public async prepareProfile(_profileDir: string): Promise<void> {}

  public launchSpec(
    profileDir: string,
    url: string,
    viewport: Viewport | null,
    mode: BenchmarkMode = 'measure',
  ): BrowserLaunchSpec {
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
    if (mode === 'profile') {
      args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0');
    }
    // Chromium interprets --window-size as outer window geometry. It does not
    // guarantee window.innerWidth/innerHeight; the page records those actual
    // content dimensions in the result envelope.
    if (viewport) args.push(`--window-size=${viewport.width},${viewport.height}`);
    args.push(url);
    return { executable, args, windowClass };
  }
}
