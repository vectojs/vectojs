#!/usr/bin/env bun
/**
 * Capture a grim screenshot of a benchmark page in a real, focused browser window.
 *
 * `run-browsers.sh` is the measurement path: it launches the browser, waits for
 * the page to POST, and closes the window. That is the wrong shape for a visual
 * check — by the time results land the window is already gone, so there is
 * nothing left to photograph.
 *
 * This driver keeps the window alive, focuses it (which matters: an unfocused
 * window on an inactive Hyprland workspace loses compositor frame callbacks, and
 * a capture can catch a stale or unpainted surface), waits for the page's own
 * readiness signal, captures with grim, and only then closes it.
 *
 * Reuses the same server and window controller as the runner, so the page is
 * served with COOP/COEP and the window lands on the same dedicated workspace.
 *
 *   bun run benchmarks/screenshot-page.ts <bench-dir> [--port N] [--out PATH]
 *                                         [--workspace N] [--viewport WxH]
 *                                         [--engine chrome|firefox] [--keep]
 *
 * Screenshots are NOT performance evidence. Quote `run-browsers.sh` for numbers;
 * use this for geometry, layout and selection correctness.
 *
 * KNOWN LIMITATION, unresolved as of 2026-08-04 (CTX-0198). On a page hosting more
 * than one canvas, grim captures taken through this driver have shown canvases
 * blank while the same page in an MCP-launched Chrome renders both correctly — with
 * the two canvases' backing stores verified byte-identical (`toDataURL` returned
 * identical 285,838-byte PNGs, and identical colour histograms). So the backing
 * store is right and the discrepancy is in capture/compositing, not in rendering.
 * Ruled out: a single shared rAF loop (both Scene instances read isRunning: true
 * with no live frame handle), Chrome backgrounding an occluded window
 * (--disable-backgrounding-occluded-windows changed nothing), and a
 * ResizeObserver-driven backing-store clear (both canvases held 79,648
 * non-transparent pixels).
 *
 * Consequence: for a multi-canvas page, take visual confirmation from an
 * MCP-launched window (`serve-visual.ts` plus chrome-devtools) and treat this
 * driver's output as unverified. Single-canvas pages are unaffected.
 *
 * Beware also that a "text is visible" reading can be the browser's SELECTION
 * HIGHLIGHT over transparent carriers rather than canvas paint: selected text
 * draws white-on-blue. A capture showing text only for the selected range is
 * showing an unpainted canvas. Any automated check must count non-transparent
 * pixels in the backing store per canvas, or diff against a reference image —
 * counting dark pixels per screen half measures "is this half selected" and is
 * how this was misdiagnosed for several iterations.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBenchmarkServer } from './_shared/server';
import { browserAdapter } from './runner/browser';
import { ENGINE_WORKSPACE } from './runner/schema';
import { HyprlandWindowController } from './runner/window/hyprland';

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    'usage: bun run benchmarks/screenshot-page.ts <bench-dir> [--port N] [--out PATH] ' +
      '[--workspace N] [--viewport WxH] [--engine chrome|firefox] [--keep]',
  );
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
const bench = args[0];
if (!bench || bench.startsWith('--')) usage('a benchmark directory is required');

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`);
  return value;
}

const engine = option('--engine') ?? 'chrome';
if (engine !== 'chrome' && engine !== 'firefox') usage(`unknown --engine '${engine}'`);
const port = Number(option('--port') ?? 0);
const keep = args.includes('--keep');
const viewportText = option('--viewport') ?? '1300x1100';
const viewportMatch = /^(\d+)x(\d+)$/.exec(viewportText);
if (!viewportMatch) usage(`--viewport must be WxH, got '${viewportText}'`);
const viewport = {
  width: Number(viewportMatch[1]),
  height: Number(viewportMatch[2]),
};
const workspace = Number(option('--workspace') ?? ENGINE_WORKSPACE[engine]);

const benchRoot = isAbsolute(bench) ? bench : join(HERE, bench);
if (!existsSync(join(benchRoot, 'page', 'index.html'))) {
  usage(`no built page at ${join(benchRoot, 'page', 'index.html')} — run its build.ts first`);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const outPath = resolve(
  option('--out') ?? join(benchRoot, 'screenshots', `${engine}-${stamp}.png`),
);
await mkdir(dirname(outPath), { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}): ${stderr.trim()}`);
  return stdout;
}

/**
 * `grim -g` geometry for one Hyprland window, or `null` if it cannot be read.
 *
 * Hyprland reports `at`/`size` in layout coordinates, which is what grim wants;
 * it applies the output scale itself. Passing scaled pixels here would crop the
 * wrong region on this 1.6x display.
 */
async function windowGeometry(address: string): Promise<string | null> {
  try {
    const clients: unknown = JSON.parse(await run(['hyprctl', 'clients', '-j']));
    if (!Array.isArray(clients)) return null;
    const client = clients.find(
      (c) => typeof c === 'object' && c !== null && (c as { address?: string }).address === address,
    ) as { at?: [number, number]; size?: [number, number] } | undefined;
    if (!client?.at || !client.size) return null;
    const [x, y] = client.at;
    const [w, h] = client.size;
    if (!(w > 0 && h > 0)) return null;
    return `${x},${y} ${w}x${h}`;
  } catch {
    return null;
  }
}

const server = await startBenchmarkServer({ benchRoot, port });
// `start=1` releases the page's awaitStart() gate; `runId` keeps the result file
// naming consistent with a measurement run.
const runId = `${stamp}-visual`;
const url = `${server.url}?runId=${runId}&start=1`;
console.log(`serving ${bench} on ${server.url} (runId ${runId})`);

const browser = browserAdapter(engine);
const windows = new HyprlandWindowController();
const profileDir = join(HERE, 'tmp', `screenshot-${engine}-${stamp}`);
await mkdir(profileDir, { recursive: true });
// Pass the measured panel rate. Firefox's `layout.frame_rate` default of -1
// resolves to 60Hz on this 240Hz panel even when focused, and the adapter writes
// the pref from this value — without it a Firefox capture would be of a page
// running at a quarter of the panel's cadence.
await browser.prepareProfile(profileDir, await windows.panelRefreshHz());
const spec = browser.launchSpec(profileDir, url, viewport);

const previousWorkspace = await windows.activeWorkspace();
let address: string | null = null;
try {
  await windows.launch(workspace, spec);
  console.log(`  launching ${engine} on workspace ${workspace}…`);

  for (let attempt = 0; attempt < 100 && address === null; attempt++) {
    await sleep(200);
    address = await windows.find(workspace, spec.windowClass, '');
  }
  if (!address) throw new Error(`${engine} window never appeared on workspace ${workspace}`);

  // Focus before capturing. Beyond frame callbacks, an unfocused window may not
  // have painted its current state at all.
  await windows.focusWorkspace(workspace);
  await windows.focusWindow(address);
  console.log(`  focused ${address}`);

  // Wait for the page's own readiness signal rather than a fixed sleep: the
  // title flips only after layout and the selection have been applied, so a
  // capture cannot catch a half-built page. Falls back to a bounded wait if the
  // page does not implement the flag.
  let ready = false;
  for (let attempt = 0; attempt < 75; attempt++) {
    await sleep(200);
    const clients: unknown = JSON.parse(await run(['hyprctl', 'clients', '-j']));
    if (Array.isArray(clients)) {
      const client = clients.find(
        (c) =>
          typeof c === 'object' && c !== null && (c as { address?: string }).address === address,
      ) as { title?: string } | undefined;
      if (client?.title?.includes('READY')) {
        ready = true;
        break;
      }
    }
  }
  if (!ready) {
    console.warn('  page never reported READY in its title — capturing anyway');
    await sleep(1500);
  }
  // One more compositor beat so the selection highlight is definitely composited.
  await sleep(400);

  // Crop to the window rather than grabbing the whole 2560x1600 panel: the
  // surrounding desktop is noise and a cropped capture is legible inline.
  const geometry = await windowGeometry(address);
  if (geometry) {
    await run(['grim', '-g', geometry, outPath]);
  } else {
    console.warn('  window geometry unavailable — capturing the full output');
    await run(['grim', outPath]);
  }
  console.log(`  wrote ${outPath}`);
} finally {
  if (address && !keep) await windows.closeWindow(address).catch(() => {});
  if (previousWorkspace !== workspace)
    await windows.focusWorkspace(previousWorkspace).catch(() => {});
  if (!keep) server.stop();
}

if (keep) {
  console.log('  --keep: window and server left running; Ctrl+C to stop');
} else {
  console.log(`screenshot: ${outPath}`);
  if (server.written.length > 0) console.log(`probe result: ${server.written.at(-1)}`);
}
