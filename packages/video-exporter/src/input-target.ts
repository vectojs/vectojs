import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { NormalizedExportOptions } from './options.js';

interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

type Middleware = (
  request: unknown,
  response: ResponseLike,
  next?: (error?: unknown) => void,
) => void | Promise<void>;

export interface ViteServerLike {
  middlewares: { use(path: string, handler: Middleware): unknown };
  transformIndexHtml(path: string, html: string): Promise<string>;
  listen(): Promise<unknown>;
  close(): Promise<void>;
  httpServer?: { address(): unknown } | null;
}

interface ViteModuleLike {
  createServer(config: Record<string, unknown>): Promise<ViteServerLike>;
}

export interface InputTargetDependencies {
  randomUUID(): string;
  loadVite(): Promise<ViteModuleLike>;
}

export interface InputTarget {
  url: string;
  close(): Promise<void>;
}

const defaultDependencies: InputTargetDependencies = {
  randomUUID,
  loadVite: async () => (await import('vite')) as unknown as ViteModuleLike,
};

function inertTarget(url: string): InputTarget {
  return { url, close: async () => {} };
}

export async function resolveInputTarget(
  options: NormalizedExportOptions,
  dependencies: InputTargetDependencies = defaultDependencies,
): Promise<InputTarget> {
  if (options.isRemote) return inertTarget(options.url);

  const root = dirname(options.url);
  const entryUrl = `/${encodeURIComponent(basename(options.url))}`;
  const pathname = `/__vecto_export_${dependencies.randomUUID()}.html`;
  const { createServer } = await dependencies.loadVite();
  const server = await createServer({
    root,
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };

  try {
    server.middlewares.use(pathname, async (_request, response, next) => {
      try {
        const source = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <style>html,body{margin:0;overflow:hidden;background:#000}</style>
  </head>
  <body>
    <canvas id="app"></canvas>
    <script type="module" src="${entryUrl}"></script>
  </body>
</html>`;
        const html = await server.transformIndexHtml(pathname, source);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      } catch (error) {
        if (next) next(error);
        else {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      }
    });

    await server.listen();
    const address = server.httpServer?.address();
    if (
      typeof address !== 'object' ||
      address === null ||
      !('port' in address) ||
      typeof address.port !== 'number'
    ) {
      throw new Error('Vite did not expose a TCP address');
    }

    return {
      url: `http://127.0.0.1:${String(address.port)}${pathname}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
