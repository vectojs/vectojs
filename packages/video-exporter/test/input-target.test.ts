import { describe, expect, it, vi } from 'vitest';
import type { NormalizedExportOptions } from '../src/options.js';
import {
  resolveInputTarget,
  type InputTargetDependencies,
  type ViteServerLike,
} from '../src/input-target.js';

function options(overrides: Partial<NormalizedExportOptions> = {}): NormalizedExportOptions {
  return {
    url: '/workspace/scenes/my scene.ts',
    outputPath: '/workspace/output.mp4',
    width: 1280,
    height: 720,
    fps: 60,
    duration: 5,
    isRemote: false,
    totalFrames: 300,
    dt: 1000 / 60,
    ...overrides,
  };
}

function fakeVite(port = 4173) {
  let middleware:
    | ((
        request: unknown,
        response: { statusCode: number; setHeader: Function; end: Function },
      ) => void)
    | undefined;
  const close = vi.fn(async () => {});
  const transformIndexHtml = vi.fn(async (_path: string, html: string) => `transformed:${html}`);
  const server: ViteServerLike = {
    middlewares: {
      use: vi.fn((_path, handler) => {
        middleware = handler;
      }),
    },
    transformIndexHtml,
    listen: vi.fn(async () => {}),
    close,
    httpServer: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port }) },
  };
  const createServer = vi.fn(async () => server);
  return { server, createServer, close, transformIndexHtml, getMiddleware: () => middleware };
}

describe('resolveInputTarget', () => {
  it('returns remote URLs without loading Vite', async () => {
    const loadVite = vi.fn(async () => {
      throw new Error('Vite must stay lazy for remote exports');
    });

    const target = await resolveInputTarget(
      options({ url: 'https://example.test/demo', isRemote: true }),
      { loadVite } as unknown as InputTargetDependencies,
    );

    expect(target.url).toBe('https://example.test/demo');
    expect(loadVite).not.toHaveBeenCalled();
    await target.close();
  });

  it('serves an in-memory transformed HTML entry for local files', async () => {
    const vite = fakeVite();
    const dependencies: InputTargetDependencies = {
      randomUUID: () => 'session-a',
      loadVite: vi.fn(async () => ({ createServer: vite.createServer })),
    };

    const target = await resolveInputTarget(options(), dependencies);
    expect(vite.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ root: '/workspace/scenes', appType: 'custom' }),
    );
    expect(vite.server.middlewares.use).toHaveBeenCalledWith(
      '/__vecto_export_session-a.html',
      expect.any(Function),
    );
    expect(target.url).toBe('http://127.0.0.1:4173/__vecto_export_session-a.html');

    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await vite.getMiddleware()!({}, response);
    expect(vite.transformIndexHtml).toHaveBeenCalledWith(
      '/__vecto_export_session-a.html',
      expect.stringContaining('<script type="module" src="/my%20scene.ts"></script>'),
    );
    expect(response.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    expect(response.end).toHaveBeenCalledWith(
      expect.stringContaining('transformed:<!doctype html>'),
    );
  });

  it('uses unique paths and closes a local server exactly once', async () => {
    const viteA = fakeVite(4101);
    const viteB = fakeVite(4102);
    const ids = ['one', 'two'];
    const servers = [viteA, viteB];
    const dependencies: InputTargetDependencies = {
      randomUUID: () => ids.shift()!,
      loadVite: vi.fn(async () => ({ createServer: servers.shift()!.createServer })),
    };

    const first = await resolveInputTarget(options(), dependencies);
    const second = await resolveInputTarget(options(), dependencies);
    expect(first.url).not.toBe(second.url);

    await first.close();
    await first.close();
    await second.close();
    expect(viteA.close).toHaveBeenCalledTimes(1);
    expect(viteB.close).toHaveBeenCalledTimes(1);
  });

  it('closes the server when startup does not expose a TCP port', async () => {
    const vite = fakeVite();
    vite.server.httpServer = { address: () => 'not-a-tcp-address' };

    await expect(
      resolveInputTarget(options(), {
        randomUUID: () => 'bad-address',
        loadVite: vi.fn(async () => ({ createServer: vite.createServer })),
      }),
    ).rejects.toThrow(/TCP address/i);
    expect(vite.close).toHaveBeenCalledTimes(1);
  });
});
