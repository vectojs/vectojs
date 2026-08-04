/**
 * Serve one benchmark page and stay up.
 *
 * `run-browsers.sh` and `screenshot-page.ts` both own the browser lifecycle. This
 * serves the page and nothing else, so an external headed browser (MCP) can be
 * pointed at it and the SAME window can be both inspected and photographed —
 * which is what it takes to settle a backing-store-vs-display disagreement.
 *
 *   bun run benchmarks/serve-visual.ts [bench-dir] [port]
 */
import { startBenchmarkServer } from './_shared/server';

const bench = process.argv[2] ?? 'hybrid-projection-visual';
const port = Number(process.argv[3] ?? 8250);
const server = await startBenchmarkServer({
  benchRoot: new URL(`./${bench}`, import.meta.url).pathname,
  port,
});
console.log(`serving ${bench} on ${server.url} — Ctrl+C to stop`);
await new Promise(() => {});
