#!/usr/bin/env bun
/**
 * Capture the Markdown showcase in a real headed browser and compare each
 * construct group against its stored baseline.
 *
 * TWO ARTEFACTS, for two different jobs — the distinction is the whole design:
 *
 *   * `baselines/<preset>/<section>.png` — the GATE. Read out of the canvas
 *     backing store via `toDataURL`, cropped per section from the rects the
 *     page publishes on `window.__showcase`. Deterministic: the backing store
 *     is what the engine drew, at a pinned DPR of 1, with no compositor, no
 *     window decoration and no output scaling anywhere in the path.
 *   * `evidence/<preset>-<engine>-<stamp>.png` — a grim capture of the real
 *     window, for a human. NOT compared, because a compositor screenshot on
 *     this host goes through a 1.6x output scale and picks up window chrome,
 *     so a byte comparison of it would fail on things that are not the
 *     rendering. `screenshot-page.ts` documents a further hazard (CTX-0198):
 *     grim has photographed canvases blank while their backing stores were
 *     verified byte-identical.
 *
 * Both come from the SAME real headed browser window on the real GPU, launched
 * exactly the way `screenshot-page.ts` launches one — focused, on a dedicated
 * Hyprland workspace. Focus is not cosmetic: an unfocused window on an inactive
 * workspace loses compositor frame callbacks and may not have painted its
 * current state at all.
 *
 * This is a CORRECTNESS gate. It is not a benchmark and produces no timing;
 * `run-browsers.sh` remains the only quotable source of numbers.
 *
 *   bun run benchmarks/markdown-showcase/capture.ts [options]
 *
 *     --engine chrome|firefox   default chrome
 *     --preset <name|all>       default all six (default + five presets)
 *     --section <id|all>        default all
 *     --typographer             capture with theme.typographer on
 *     --update                  write/refresh baselines instead of comparing
 *     --tolerance <fraction>    max differing-pixel fraction, default 0
 *     --no-evidence             skip the grim window capture
 *     --keep                    leave the window and server up
 *
 * Exit code is non-zero if any section differs beyond tolerance, so this can be
 * wired into a check without further plumbing.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBenchmarkServer } from '../_shared/server';
import { browserAdapter } from '../runner/browser';
import { ENGINE_WORKSPACE } from '../runner/schema';
import { HyprlandWindowController } from '../runner/window/hyprland';
import { SHOWCASE_SECTIONS } from './corpus.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every preset the page accepts, `default` included. */
const PRESETS = [
  'default',
  'githubDark',
  'githubLight',
  'dracula',
  'solarizedDark',
  'solarizedLight',
] as const;

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: bun run benchmarks/markdown-showcase/capture.ts \\\n' +
      '         [--engine chrome|firefox] [--preset <name|all>] [--section <id|all>] \\\n' +
      '         [--typographer] [--update] [--tolerance F] [--no-evidence] [--keep]',
  );
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`);
  return value;
}

const engine = option('--engine') ?? 'chrome';
if (engine !== 'chrome' && engine !== 'firefox') usage(`unknown --engine '${engine}'`);

const presetArg = option('--preset') ?? 'all';
if (presetArg !== 'all' && !PRESETS.includes(presetArg as (typeof PRESETS)[number])) {
  usage(`unknown --preset '${presetArg}'`);
}
const presets: readonly string[] = presetArg === 'all' ? PRESETS : [presetArg];

const sectionArg = option('--section') ?? 'all';
if (sectionArg !== 'all' && !SHOWCASE_SECTIONS.some((s) => s.id === sectionArg)) {
  usage(`unknown --section '${sectionArg}'`);
}

const typographer = args.includes('--typographer');
const update = args.includes('--update');
const keep = args.includes('--keep');
const evidence = !args.includes('--no-evidence');
const tolerance = Number(option('--tolerance') ?? 0);
if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
  usage('--tolerance must be a fraction between 0 and 1');
}

const pageEntry = join(HERE, 'page', 'index.html');
if (!existsSync(pageEntry)) usage(`no built page at ${pageEntry} — run build.ts first`);

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');

/**
 * Baselines are keyed by typographer state as well as preset.
 *
 * Typographer rewrites characters the author did not type (`--` to an en dash,
 * straight quotes to curly), so the same source renders different glyphs with
 * it on. One directory for both would make every capture disagree with
 * whichever state was recorded last.
 */
const variant = typographer ? 'typographer' : 'plain';
const baselineRoot = join(HERE, 'baselines', variant);
const evidenceRoot = join(HERE, 'evidence');
const diffRoot = join(HERE, 'diffs', variant);

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
 * `magick compare -metric AE`: the count of differing pixels.
 *
 * AE (absolute error) rather than RMSE or SSIM because the question a gate asks
 * is "did any pixel change", not "how visually similar are these" — a 1px
 * baseline shift on one glyph is a real regression that a perceptual metric
 * would score as negligible. `compare` exits 1 when images differ, which is not
 * a tool failure, so the exit code is deliberately ignored and the metric on
 * stderr is what is read.
 *
 * Returns `null` when the two images have different dimensions, which `compare`
 * reports as an error rather than a count. That is itself a meaningful result —
 * a section changing size IS a regression — so the caller reports it as a
 * failure instead of treating it as a broken comparison.
 */
async function differingPixels(
  a: string,
  b: string,
  diffPath: string,
): Promise<{ pixels: number | null; note?: string }> {
  const proc = Bun.spawn(['magick', 'compare', '-metric', 'AE', a, b, diffPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const text = stderr.trim();
  // `123` or `123 (0.00187687)`; a size mismatch says "image widths or heights
  // differ" instead.
  const match = /^(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return { pixels: null, note: text.split('\n')[0] ?? 'comparison failed' };
  return { pixels: Number(match[1]) };
}

interface SectionRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ShowcaseState {
  preset: string;
  typographer: boolean;
  width: number;
  height: number;
  blocks: number;
  rects: SectionRect[];
}

interface Failure {
  preset: string;
  section: string;
  detail: string;
}

const failures: Failure[] = [];
const written: string[] = [];
let compared = 0;

await mkdir(baselineRoot, { recursive: true });
if (evidence) await mkdir(evidenceRoot, { recursive: true });

const server = await startBenchmarkServer({ benchRoot: HERE, port: 0 });
const browser = browserAdapter(engine);
const windows = new HyprlandWindowController();
const workspace = ENGINE_WORKSPACE[engine];
const profileDir = join(HERE, '..', 'tmp', `showcase-${engine}-${stamp}`);
await mkdir(profileDir, { recursive: true });
await browser.prepareProfile(profileDir, await windows.panelRefreshHz());

const previousWorkspace = await windows.activeWorkspace();
let address: string | null = null;

/**
 * Read the page's published state, cropping each section out of the backing
 * store, by evaluating in the page through the DevTools/BiDi bridge.
 *
 * Implemented as a page-side script the driver injects through a query
 * parameter rather than over a debugging protocol: this driver already owns a
 * Hyprland-launched window and adding a CDP/BiDi connection would mean a second
 * browser-control mechanism for one `toDataURL` call. The page instead POSTs
 * its own crops to the shared benchmark server, which already accepts a JSON
 * body at `/results` and writes it to disk.
 */
function urlFor(preset: string): string {
  const query = new URLSearchParams({
    preset,
    section: sectionArg,
    chrome: '0',
    dpr: '1',
    capture: '1',
    runId: `${stamp}-${preset}-${variant}`,
    start: '1',
  });
  if (typographer) query.set('typographer', '1');
  return `${server.url}?${query.toString()}`;
}

try {
  for (const preset of presets) {
    const url = urlFor(preset);
    const spec = browser.launchSpec(profileDir, url, { width: 1400, height: 1000 });

    await windows.launch(workspace, spec);
    address = null;
    for (let attempt = 0; attempt < 100 && address === null; attempt++) {
      await sleep(200);
      address = await windows.find(workspace, spec.windowClass, '');
    }
    if (!address) throw new Error(`${engine} window never appeared on workspace ${workspace}`);

    await windows.focusWorkspace(workspace);
    await windows.focusWindow(address);

    // Record how many results have been written BEFORE this preset starts,
    // so the payloadPath lookup below can find the one file that belongs to
    // THIS preset rather than a previous one.
    const seenBefore = server.written.length;

    // Wait for the window title to include `CAPTURED` — the page's own signal
    // that `awaitFirstPaint()` resolved, crops were taken, and the POST
    // completed. Stronger than waiting for `server.written` to grow: that fires
    // as soon as the server persists the file, while `CAPTURED` in the title
    // means the page received the 200 response, so the file is guaranteed to
    // exist by the time the driver reads it.
    //
    // Also stronger than `READY`: `__ready` and the title flip after layout
    // settles but BEFORE the canvas has been painted, and before `preloadMathJax`
    // resolves (both of which `capture=1` waits for). A driver that reads crops
    // on `READY` would pick up blank or math-fallback images.
    for (let attempt = 0; attempt < 300; attempt++) {
      await sleep(200);
      const clients: unknown = JSON.parse(await run(['hyprctl', 'clients', '-j']));
      if (Array.isArray(clients)) {
        const client = clients.find(
          (c) =>
            typeof c === 'object' && c !== null && (c as { address?: string }).address === address,
        ) as { title?: string } | undefined;
        if (client?.title?.includes('CAPTURED')) break;
        // READY means layout is done and capture will start soon. Re-focus in
        // case something else stole it — rAF does not fire on an unfocused
        // Hyprland window, and awaitFirstPaint() spins on setTimeout waiting
        // for the canvas to get its first rAF frame.
        if (client?.title?.includes('READY')) {
          await windows.focusWorkspace(workspace);
          await windows.focusWindow(address);
        }
        if (attempt === 299) throw new Error(`${preset}: window never reached CAPTURED state`);
      }
    }

    // CAPTURED in the title means the POST completed; seenBefore was recorded
    // before the loop, so `written.length > seenBefore` is now true.
    let payloadPath: string | null = null;
    for (let attempt = 0; attempt < 20 && payloadPath === null; attempt++) {
      await sleep(100);
      if (server.written.length > seenBefore) payloadPath = server.written.at(-1) ?? null;
    }
    if (!payloadPath) throw new Error(`${preset}: result file missing after CAPTURED signal`);

    const posted = (await Bun.file(payloadPath).json()) as {
      showcase?: ShowcaseState;
      crops?: Record<string, string>;
    };
    const state = posted.showcase;
    const crops = posted.crops ?? {};
    if (!state) throw new Error(`${preset}: capture payload had no showcase state`);
    if (state.preset !== preset) {
      throw new Error(`${preset}: page reported preset '${state.preset}'`);
    }
    if (state.typographer !== typographer) {
      throw new Error(`${preset}: page reported typographer ${state.typographer}`);
    }
    if (state.blocks === 0) throw new Error(`${preset}: page rendered zero blocks`);

    const presetBaselines = join(baselineRoot, preset);
    await mkdir(presetBaselines, { recursive: true });

    for (const rect of state.rects) {
      const dataUrl = crops[rect.id];
      if (!dataUrl) {
        failures.push({ preset, section: rect.id, detail: 'page produced no crop' });
        continue;
      }
      if (rect.width === 0 || rect.height === 0) {
        failures.push({
          preset,
          section: rect.id,
          detail: `empty rect ${rect.width}x${rect.height}`,
        });
        continue;
      }
      const bytes = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      const baseline = join(presetBaselines, `${rect.id}.png`);

      if (update || !existsSync(baseline)) {
        await writeFile(baseline, bytes);
        written.push(baseline);
        console.log(`  ${update ? 'updated' : 'created'} ${preset}/${rect.id}.png`);
        continue;
      }

      // Compare against the stored baseline. The candidate is written to a
      // temporary path because `magick compare` reads files, not stdin streams.
      await mkdir(diffRoot, { recursive: true });
      const candidate = join(diffRoot, `${preset}-${rect.id}.candidate.png`);
      const diff = join(diffRoot, `${preset}-${rect.id}.diff.png`);
      await writeFile(candidate, bytes);
      const { pixels, note } = await differingPixels(baseline, candidate, diff);
      compared++;
      if (pixels === null) {
        failures.push({ preset, section: rect.id, detail: note ?? 'comparison failed' });
        continue;
      }
      const total = rect.width * rect.height;
      const fraction = total > 0 ? pixels / total : 1;
      if (fraction > tolerance) {
        failures.push({
          preset,
          section: rect.id,
          detail: `${pixels} px differ (${(fraction * 100).toFixed(4)}% > ${(tolerance * 100).toFixed(4)}%), diff at ${diff}`,
        });
      }
    }

    if (evidence) {
      const clients: unknown = JSON.parse(await run(['hyprctl', 'clients', '-j']));
      let geometry: string | null = null;
      if (Array.isArray(clients)) {
        const client = clients.find(
          (c) =>
            typeof c === 'object' && c !== null && (c as { address?: string }).address === address,
        ) as { at?: [number, number]; size?: [number, number] } | undefined;
        if (client?.at && client.size) {
          geometry = `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`;
        }
      }
      const shot = join(evidenceRoot, `${preset}-${variant}-${engine}-${stamp}.png`);
      if (geometry) await run(['grim', '-g', geometry, shot]);
      else await run(['grim', shot]);
      console.log(`  evidence ${shot}`);
    }

    if (!keep) {
      await windows.closeWindow(address).catch(() => {});
      address = null;
    }
    console.log(`${preset}: ${state.rects.length} sections, ${state.blocks} blocks`);
  }
} finally {
  if (address && !keep) await windows.closeWindow(address).catch(() => {});
  if (previousWorkspace !== workspace) {
    await windows.focusWorkspace(previousWorkspace).catch(() => {});
  }
  if (!keep) server.stop();
}

const baselineCount = (await readdir(baselineRoot, { recursive: true })).filter((f) =>
  f.endsWith('.png'),
).length;

console.log(
  `\n${engine} · ${variant} · ${presets.length} preset(s) · ` +
    `${compared} compared, ${written.length} written, ${baselineCount} baselines on disk`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} section(s) differ from baseline:`);
  for (const failure of failures) {
    console.error(`  ${failure.preset}/${failure.section}: ${failure.detail}`);
  }
  console.error('\nIf the change is intended, re-run with --update to re-record these baselines.');
  process.exit(1);
}

console.log(failures.length === 0 && compared > 0 ? 'all sections match baseline' : 'done');
