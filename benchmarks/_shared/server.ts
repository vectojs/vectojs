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

/**
 * Static host facts, gathered once per server lifetime.
 *
 * These are the fields that make a number comparable across machines, and the
 * page cannot see any of them: `navigator` exposes neither the CPU model nor the
 * GPU nor the driver version. `/metrics` already shells out for live GPU
 * utilization; this is the immutable counterpart, cached because a CPU model does
 * not change between two arms of a run.
 *
 * The commit is included here rather than passed in the URL because the runner
 * already computed it, printed it to the terminal and then dropped it — every
 * result file was anonymous as to which build produced it. Reading it server-side
 * also means a hand-opened page records the right commit without anyone
 * remembering a query parameter.
 */
let hostCache: Promise<Record<string, unknown>> | null = null;

async function firstLine(command: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, { stderr: 'ignore' });
    const text = (await new Response(proc.stdout).text()).trim();
    return text.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The display's refresh rate in Hz, from the compositor, or null.
 *
 * This exists so that a measured cadence can be checked against something. The
 * page can measure the rate it is *getting* but has no way to know the rate it
 * *should* be getting, and the failure this catches produces a perfectly ordinary
 * looking number: an unfocused window on an inactive Hyprland workspace loses
 * compositor frame callbacks and its rAF drops to a ~60 Hz timer while still
 * reporting `visibilityState: 'visible'` and `document.hasFocus() === true`.
 *
 * The fastest enabled monitor, not the one the benchmark window is on. A window
 * can move and this value is cached for the server's lifetime, so anything
 * per-window would go stale; the fastest enabled panel is a property of the host
 * and is the right denominator for the question actually being asked, which is
 * whether a page fell far below what this host can deliver.
 *
 * Null rather than a guess when `hyprctl` is absent or unparseable — a fabricated
 * expectation would produce false validation issues on every run of a machine
 * this happens not to know how to interrogate.
 */
async function readPanelHz(): Promise<number | null> {
  try {
    const proc = Bun.spawn(['hyprctl', 'monitors', '-j'], { stderr: 'ignore' });
    const parsed: unknown = JSON.parse(await new Response(proc.stdout).text());
    if (!Array.isArray(parsed)) return null;
    let best = 0;
    for (const monitor of parsed) {
      if (typeof monitor !== 'object' || monitor === null) continue;
      if ('disabled' in monitor && monitor.disabled === true) continue;
      if (!('refreshRate' in monitor) || typeof monitor.refreshRate !== 'number') continue;
      if (Number.isFinite(monitor.refreshRate) && monitor.refreshRate > best) {
        best = monitor.refreshRate;
      }
    }
    // Round to 2dp: hyprctl reports 240.00000, and an exact float here would make
    // the recorded expectation noisier than the thing it is checking.
    return best > 0 ? Math.round(best * 100) / 100 : null;
  } catch {
    return null;
  }
}

async function readHostInfo(benchRoot: string): Promise<Record<string, unknown>> {
  const cpuinfo = await Bun.file('/proc/cpuinfo')
    .text()
    .catch(() => '');
  const modelLine = /^model name\s*:\s*(.+)$/m.exec(cpuinfo);
  const cores = (cpuinfo.match(/^processor\s*:/gm) ?? []).length;

  // nvidia-smi first, then the DRM device name, so an AMD or Intel GPU is still
  // identified rather than reported as null.
  let gpu = await firstLine(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader']);
  let driver = await firstLine([
    'nvidia-smi',
    '--query-gpu=driver_version',
    '--format=csv,noheader',
  ]);
  if (gpu === null) {
    gpu = await Bun.file('/sys/class/drm/card0/device/label')
      .text()
      .then((t) => t.trim() || null)
      .catch(() => null);
  }
  if (driver === null) {
    driver = await firstLine(['glxinfo', '-B']);
  }

  const commit = await firstLine(['git', '-C', benchRoot, 'rev-parse', '--short', 'HEAD']);

  const osRelease = await Bun.file('/etc/os-release')
    .text()
    .catch(() => '');
  const prettyName = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(osRelease);

  return {
    cpu: modelLine?.[1]?.trim() ?? null,
    cores: cores > 0 ? cores : null,
    gpu,
    driver,
    kernel: await firstLine(['uname', '-r']),
    os: prettyName?.[1] ?? null,
    commit,
    panelHz: await readPanelHz(),
  };
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

      // Static host identity: CPU, GPU, driver, kernel and the commit that built
      // the bundle. Cached for the server's lifetime, since none of it changes
      // between two arms of a run.
      if (url.pathname === '/host') {
        hostCache ??= readHostInfo(benchRoot);
        return Response.json(await hostCache, { headers: ISOLATION });
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
