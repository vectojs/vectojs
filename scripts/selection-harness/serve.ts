// Loopback static + results server for the selection harness. Serves a surface
// page from a given dir and accepts the JSON verdict at POST /results, writing
// it next to the screenshot so the shell driver can collect it. Loopback-only;
// no COOP/COEP needed (this is a correctness check, not a perf timer).
//   bun serve.ts <port> <page-dir> <results-file>
import { resolve } from 'node:path';

const port = Number(process.argv[2] ?? 8210);
const pageDir = resolve(process.argv[3] ?? 'page');
const resultsFile = process.argv[4] ?? '';

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/results') {
      const body = await req.text();
      if (resultsFile) await Bun.write(resultsFile, body);
      return new Response('ok');
    }
    // Path-traversal containment: resolve under pageDir and verify prefix.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolve(pageDir, '.' + rel);
    if (!file.startsWith(pageDir)) return new Response('forbidden', { status: 403 });
    const f = Bun.file(file);
    if (await f.exists()) return new Response(f);
    return new Response('not found', { status: 404 });
  },
});
console.log(`selection-harness serving ${pageDir} on http://127.0.0.1:${port}/`);
