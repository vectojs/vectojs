import { describe, expect, it, vi } from 'vitest';
import { launchBrowser, resolveBrowserLaunchOptions } from '../src/browser.js';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    env: {},
    exists: () => false,
    getuid: () => 1000,
    warn: vi.fn(),
    launch: vi.fn(async () => ({ close: async () => {}, newPage: async () => ({}) })),
    ...overrides,
  };
}

describe('browser launch policy', () => {
  it('prefers PUPPETEER_EXECUTABLE_PATH over the system Chromium fallback', () => {
    const deps = dependencies({
      env: { PUPPETEER_EXECUTABLE_PATH: '/custom/chrome' },
      exists: (path: string) => path === '/usr/bin/chromium',
    });

    expect(resolveBrowserLaunchOptions(deps)).toEqual({
      headless: true,
      executablePath: '/custom/chrome',
      args: ['--disable-gpu'],
    });
  });

  it('uses /usr/bin/chromium when present and no override is configured', () => {
    const deps = dependencies({ exists: (path: string) => path === '/usr/bin/chromium' });

    expect(resolveBrowserLaunchOptions(deps)).toEqual({
      headless: true,
      executablePath: '/usr/bin/chromium',
      args: ['--disable-gpu'],
    });
  });

  it('lets Puppeteer resolve its bundled browser when no executable exists', () => {
    expect(resolveBrowserLaunchOptions(dependencies())).toEqual({
      headless: true,
      args: ['--disable-gpu'],
    });
  });

  it.each([
    ['root', { getuid: () => 0 }],
    ['explicit opt-in', { env: { VECTO_CHROMIUM_NO_SANDBOX: '1' } }],
  ])('adds sandbox bypass flags for %s and warns once', (_label, overrides) => {
    const deps = dependencies(overrides);

    expect(resolveBrowserLaunchOptions(deps)).toEqual({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox'],
    });
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/sandbox.*disabled/i));
  });

  it('does not disable the sandbox for a normal user', () => {
    const deps = dependencies();

    resolveBrowserLaunchOptions(deps);

    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('launches Puppeteer with the resolved options', async () => {
    const browser = { close: vi.fn(async () => {}), newPage: vi.fn(async () => ({})) };
    const deps = dependencies({
      env: { PUPPETEER_EXECUTABLE_PATH: '/custom/chrome' },
      launch: vi.fn(async () => browser),
    });

    await expect(launchBrowser(deps)).resolves.toBe(browser);
    expect(deps.launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/custom/chrome',
      args: ['--disable-gpu'],
    });
  });
});
