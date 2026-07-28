/**
 * The one benchmark HTTP server, shared by every benchmark directory.
 *
 * This replaced 24 per-benchmark `serve.ts` files, 21 of which were byte-identical
 * and the other three differing only in a default port number. Duplicating a
 * server that enforces path containment and cross-origin isolation is a liability:
 * a fix to the traversal check or the COOP/COEP headers had to be applied 24 times
 * to actually hold, and there was no way to tell from one copy whether the others
 * had drifted.
 *
 * Two properties matter enough to state:
 *
 *   * COOP/COEP make the document cross-origin isolated, which restores
 *     `performance.now()` to ~5 µs resolution. Without it the browser coarsens the
 *     clock to ~100 µs, which is the same order as the per-frame costs being
 *     measured — the measurement would be quantisation noise.
 *   * Loopback only. `/metrics` exposes `/proc` and `nvidia-smi` output, so this
 *     must never be reachable off the machine.
 */

import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export interface BenchmarkServerOptions {
  /** Directory holding the built `page/` and the `results/` output. */
  benchRoot: string;
  /** Port to bind. `0` asks the OS for a free one, which is what a runner should do. */
  port?: number;
}

export interface BenchmarkServer {
  port: number;
  url: string;
  /** Result files written during this server's lifetime, newest last. */
  written: string[];
  stop(): void;
}

let prevCpu: { idle: number; total: number } | null = null;

async function cpuPercent(): Promise<number> {
  const parts = (await Bun.file('/proc/stat').text())
    .split('\n')[0]!
    .split(/\s+/)
    .slice(1)
    .filter(Boolean)
    .map(Number);
  const idle = parts[3]! + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);
  let pct = 0;
  if (prevCpu) {
    const dIdle = idle - prevCpu.idle;
    const dTotal = total - prevCpu.total;
    pct = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
  }
  prevCpu = { idle, total };
  return pct;
}

async function gpuInfo(): Promise<Record<string, unknown> | null> {
  try {
    const proc = Bun.spawn([
      'nvidia-smi',
      '--query-gpu=name,utilization.gpu,memory.used,temperature.gpu,clocks.sm',
      '--format=csv,noheader,nounits',
    ]);
    const o = (await new Response(proc.stdout).text())
      .trim()
      .split(',')
      .map((s) => s.trim());
    return {
      name: o[0],
      util: +o[1]!,
      mem: +o[2]!,
      temp: +o[3]!,
      clock: +o[4]!,
    };
  } catch {
    return null;
  }
}

const sanitize = (value: unknown, fallback: string): string =>
  String(value ?? fallback)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 64);

/**
 * Start the server. Returns once it is listening, with the port actually bound.
 *
 * Prefer `port: 0`: the OS hands out a free port, so a runner never has to find
 * and kill whatever already holds a hardcoded one. That killing was a real hazard
 * — the previous shell implementation matched the port number anywhere in `ss`
 * output, including inside a `pid=` field, and would happily terminate an
 * unrelated dev server.
 */
export async function startBenchmarkServer(
  options: BenchmarkServerOptions,
): Promise<BenchmarkServer> {
  const benchRoot = resolve(options.benchRoot);
  const pageRoot = resolve(benchRoot, 'page');
  const resultsRoot = resolve(benchRoot, 'results');
  await mkdir(resultsRoot, { recursive: true });
  await mkdir(resolve(resultsRoot, 'history'), { recursive: true });
  await mkdir(resolve(resultsRoot, 'latest'), { recursive: true });

  let pageRootReal: string;
  try {
    pageRootReal = realpathSync(pageRoot);
  } catch {
    throw new Error(`no built page at ${pageRoot}; run the benchmark's build first`);
  }

  const written: string[] = [];

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/results' && req.method === 'POST') {
        const body = (await req.json()) as {
          engine?: string;
          name?: string;
          runId?: string;
        };
        const name = sanitize(body.name, 'run');
        const engine = sanitize(body.engine, 'unknown');
        const runId = sanitize(body.runId, 'norun');
        const payload = JSON.stringify(body, null, 2);

        // Written twice on purpose. `history/` is keyed by runId so nothing is
        // ever overwritten — the previous single-file scheme silently destroyed
        // the run you were about to compare against. `latest/` keeps the stable
        // path that existing tooling and humans look for.
        const historyFile = resolve(resultsRoot, 'history', `${name}-${engine}-${runId}.json`);
        const latestFile = resolve(resultsRoot, 'latest', `${name}-${engine}.json`);
        await Bun.write(historyFile, payload);
        await Bun.write(latestFile, payload);
        written.push(historyFile);
        console.log(`wrote results/history/${name}-${engine}-${runId}.json`);
        return Response.json({ ok: true, runId: body.runId }, { headers: ISOLATION });
      }

      if (url.pathname === '/log' && req.method === 'POST') {
        const { level = 'info', msg = '' } = (await req.json()) as {
          level?: string;
          msg?: string;
        };
        console.log(`  [${level}] ${String(msg).slice(0, 400)}`);
        return Response.json({ ok: true }, { headers: ISOLATION });
      }

      if (url.pathname === '/metrics') {
        const mem = await Bun.file('/proc/meminfo').text();
        const get = (k: string) => +(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mem)?.[1] ?? 0);
        return Response.json(
          {
            cpu: await cpuPercent(),
            ramUsed: (get('MemTotal') - get('MemAvailable')) / 1048576,
            ramTotal: get('MemTotal') / 1048576,
            gpu: await gpuInfo(),
          },
          { headers: ISOLATION },
        );
      }

      // Everything is served out of page/, so the document's relative asset URLs
      // (./kernels.wasm) resolve against the same directory they sit in.
      //
      // Resolve then containment-check: browsers normalize `..` before sending,
      // but a raw client (curl --path-as-is) does not, so the check has to happen
      // here rather than relying on the caller. The lexical check alone blocks
      // `..` traversal but not a symlink inside page/ pointing outside it, so the
      // real (symlink-resolved) path is re-checked before the file is served.
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const resolved = resolve(pageRoot, '.' + requested);
      if (resolved !== pageRoot && !resolved.startsWith(pageRoot + sep)) {
        return new Response('forbidden', { status: 403 });
      }
      let real: string;
      try {
        real = realpathSync(resolved);
      } catch {
        return new Response('not found', { status: 404 });
      }
      if (real !== pageRootReal && !real.startsWith(pageRootReal + sep)) {
        return new Response('forbidden', { status: 403 });
      }
      const file = Bun.file(real);
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      const type = requested.endsWith('.wasm')
        ? 'application/wasm'
        : requested.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : requested.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : requested.endsWith('.map')
              ? 'application/json; charset=utf-8'
              : 'application/octet-stream';
      return new Response(file, {
        headers: { 'content-type': type, ...ISOLATION },
      });
    },
  });

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}/`,
    written,
    stop: () => server.stop(true),
  };
}

/** CLI entry: `bun run benchmarks/_shared/server.ts <bench-dir>`, honouring PORT. */
if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: server.ts <bench-dir>');
    process.exit(1);
  }
  // Resolved against the CALLER's cwd, not this file's directory: the runner
  // invokes it from inside the benchmark directory with `.`, and resolving that
  // against `_shared/..` pointed at `benchmarks/` itself.
  const server = await startBenchmarkServer({
    benchRoot: resolve(process.cwd(), dir),
    port: Number(process.env.PORT ?? 0),
  });

  console.log(`benchmark server for ${dir} on ${server.url}`);
}
