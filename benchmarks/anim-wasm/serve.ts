/**
 * Serves the in-browser sweep with COOP/COEP so `performance.now()` keeps its
 * high-resolution (5 µs) timing rather than the 100 µs cross-origin penalty,
 * and exposes /metrics (nvidia-smi + /proc) so a single screenshot captures
 * both the results and the machine state they were measured on.
 */

import { resolve, sep } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
/** Only files under page/ are servable; everything else is a 403. */
const PAGE_ROOT = resolve(ROOT, 'page');

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

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

async function gpuInfo() {
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
    return { name: o[0], util: +o[1]!, mem: +o[2]!, temp: +o[3]!, clock: +o[4]! };
  } catch {
    return null;
  }
}

Bun.serve({
  port: Number(process.env.PORT ?? 8178),
  // Loopback only: this exposes /proc and nvidia-smi output and must not be
  // reachable from the network.
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    // Results are POSTed by the page when a run completes, so a benchmark run
    // needs no screenshot and no interactive step: launch the browser, wait for
    // the file to appear, read it.
    if (url.pathname === '/results' && req.method === 'POST') {
      const body = (await req.json()) as { engine?: string; name?: string };
      const safe = (v: unknown, fallback: string) =>
        String(v ?? fallback)
          .replace(/[^a-zA-Z0-9._-]/g, '-')
          .slice(0, 64);
      const file = `${safe(body.name, 'run')}-${safe(body.engine, 'unknown')}.json`;
      await Bun.write(ROOT + 'results/' + file, JSON.stringify(body, null, 2));
      console.log('wrote results/' + file);
      return Response.json({ ok: true, file }, { headers: ISOLATION });
    }

    if (url.pathname === '/log' && req.method === 'POST') {
      const { level = 'info', msg = '' } = (await req.json()) as { level?: string; msg?: string };
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
    // here rather than relying on the caller.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = resolve(PAGE_ROOT, '.' + requested);
    if (resolved !== PAGE_ROOT && !resolved.startsWith(PAGE_ROOT + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    const file = Bun.file(resolved);
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    const path = requested;
    const type = path.endsWith('.wasm')
      ? 'application/wasm'
      : path.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'application/octet-stream';
    return new Response(file, { headers: { 'content-type': type, ...ISOLATION } });
  },
});

console.log('sweep server on http://127.0.0.1:8178');
