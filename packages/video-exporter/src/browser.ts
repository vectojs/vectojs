import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

export interface PageLike {
  setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  }): Promise<unknown>;
  goto(url: string, options: { waitUntil: 'networkidle0' }): Promise<unknown>;
  waitForFunction(expression: string, options: { timeout: number }): Promise<unknown>;
  evaluate<TResult>(
    operation: string | ((...arguments_: never[]) => TResult),
    ...args: unknown[]
  ): Promise<TResult>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  headless: true;
  executablePath?: string;
  args?: string[];
}

export interface BrowserDependencies {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  getuid(): number | undefined;
  warn(message: string): void;
  launch(options: BrowserLaunchOptions): Promise<BrowserLike>;
}

const defaultDependencies: BrowserDependencies = {
  env: process.env,
  exists: existsSync,
  getuid: () => process.getuid?.(),
  warn: (message) => console.warn(message),
  launch: async (options) => (await puppeteer.launch(options)) as unknown as BrowserLike,
};

export function resolveBrowserLaunchOptions(
  dependencies: Pick<BrowserDependencies, 'env' | 'exists' | 'getuid' | 'warn'>,
): BrowserLaunchOptions {
  const options: BrowserLaunchOptions = { headless: true };
  const configuredExecutable = dependencies.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (configuredExecutable) options.executablePath = configuredExecutable;
  else if (dependencies.exists('/usr/bin/chromium')) options.executablePath = '/usr/bin/chromium';

  const sandboxDisabled =
    dependencies.getuid() === 0 || dependencies.env.VECTO_CHROMIUM_NO_SANDBOX === '1';
  if (sandboxDisabled) {
    options.args = ['--no-sandbox', '--disable-setuid-sandbox'];
    dependencies.warn(
      'Chromium sandbox is disabled for this VectoJS video export. Run as a non-root user when possible.',
    );
  }

  return options;
}

export async function launchBrowser(
  dependencies: BrowserDependencies = defaultDependencies,
): Promise<BrowserLike> {
  return dependencies.launch(resolveBrowserLaunchOptions(dependencies));
}
