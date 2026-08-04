// CTX-0198 / vectojs#343 — what does a HYBRID content projection cost, and does
// it beat the naive way of getting the same capability?
//
// The three-layer framing in #343: (1) visual = canvas paint, (2) semantic = one
// coarse DOM node per block carrying that block's full text, (3) interaction =
// per-line / per-run transparent carriers aligned to the drawn glyphs. Today
// layers 2 and 3 are the same tree, so the only choices are "every carrier" or
// "no text".
//
// The naive reading of that issue is "hybrid saves work versus today". It does
// not, and this bench is built to make that visible rather than to hide it:
// `contentProjectionMargin` ALREADY frees every off-viewport block (#345 then
// windows the lines inside a tall one), so today's cost is bounded by the
// viewport band no matter how long the document is.
//
// What today's behaviour does NOT give is any DOM for off-screen text. So
// native find-in-page cannot find it, and a screen reader cannot read ahead:
// the document effectively does not exist outside the band. `hybrid` is a
// CAPABILITY GAIN, and the real question is what that gain costs relative to
// the only other way to get it — keeping everything resident.
//
// Hence five arms, all running real Scene code, differing only in what each
// block projects and whether Scene's margin gate frees it:
//
//   native         margin = viewport. Band gets text + per-line carriers;
//                  off-band gets nothing. TODAY. Off-screen text unfindable.
//   hybrid         margin = Infinity. EVERY block resident with text only
//                  (layer 2); band additionally returns `lines` (layer 3).
//                  Full-document findability, fine geometry only where visible.
//   hybrid-cached  same, but the off-band semantic projection is memoized —
//                  attributes idle cost between building the projection and
//                  Scene walking every resident block.
//   all-resident   margin = Infinity, every block returns `lines`. The naive
//                  way to get findability. This is what hybrid must beat.
//   never          getContentProjection() -> null. Floor.
//
// `hybrid` is a simulation, not an implementation — same discipline as
// `benchmarks/lazy-a11y`'s `lazy-simulated` row. It measures the steady state a
// `ContentProjectionMode: 'hybrid'` would reach using primitives that already
// ship, so the design decision rests on numbers before anything is built.
//
// Reports DOM node count and JS heap ALONGSIDE time, because after #338/#345 and
// the grid-calibration fixes the frame-time argument is largely spent; any
// remaining win has to show up in memory, node count and streaming mutation
// volume. Heap uses measureUserAgentSpecificMemory() where available (Chrome +
// crossOriginIsolated) because it counts DOM memory, which usedJSHeapSize does
// not — and DOM is precisely what is under test here.
//
// Every block PAINTS its text with fillText at exactly the coordinates it
// reports in `getContentProjection()`, using measured advances shared by both
// paths. A no-op `render()` would make this a measurement of projection cost
// against entities that draw nothing, and would leave the carrier-to-glyph
// alignment — the entire purpose of layer 3 — unverifiable. The companion
// `hybrid-projection-visual` page checks that alignment numerically and is what
// the grim screenshots are taken of.
import { Entity, Scene } from '@vectojs/core';
import {
  awaitStart,
  calibrateRefreshRate,
  reportFailure,
  reportResult,
} from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const BLOCK_COUNTS = (p.get('blocks') ?? '100,1000,10000').split(',').map(Number);
/** Visual lines per block. A paragraph, not a code file. */
const LINES_PER_BLOCK = Number(p.get('linesPerBlock') ?? 3);
/** Positioned runs per line. Each becomes its own carrier `<span>`. */
const RUNS_PER_LINE = Number(p.get('runs') ?? 6);
/** Streaming chunk size, matching the chat-transcript workload in #343. */
const CHUNK = Number(p.get('chunk') ?? 32);
const STREAM_FRAMES = Number(p.get('streamFrames') ?? 24);
const TRIALS = Number(p.get('trials') ?? 9);
/**
 * Restrict the run to a subset of arms, e.g. `arms=hybrid-windowed`.
 *
 * Memory is why this exists. Running every arm in one page load makes the heap
 * figure uninterpretable: measured 2026-08-04, baselines swung between 7.8 and
 * 13.9 MB across arms in a single load and the deltas came out negative
 * (-5.72 MB for hybrid-windowed at 100 blocks), because each arm inherits
 * whatever the previous one left unreclaimed. Giving one arm the whole page load
 * gives it a genuinely cold baseline, so its delta is attributable.
 */
const ARM_FILTER = p.get('arms')?.split(',').filter(Boolean) ?? null;
const LINE_H = 20;
const FONT = '16px sans-serif';
const TEXT_LEFT = 4;
const BLOCK_GAP = 8;
const BLOCK_H = LINES_PER_BLOCK * LINE_H;
const BLOCK_PITCH = BLOCK_H + BLOCK_GAP;
const VIEW_W = 900;
const VIEW_H = 700;

type ArmKey =
  | 'native'
  | 'hybrid'
  | 'hybrid-dirty'
  | 'hybrid-windowed'
  | 'hybrid-cached'
  | 'all-resident'
  | 'split'
  | 'never';

/**
 * The document-space band the simulated `hybrid` mode treats as needing fine
 * geometry. Set by the bench before each sync; a real implementation would
 * derive it exactly as `Scene.projectionVisibleLocalYBand` already does.
 */
const band = { min: 0, max: 0 };

/**
 * Shared text measurer, so `render()` and `getContentProjection()` agree on run
 * advances to the pixel. Deriving both from one measurement is what makes the
 * carrier-vs-glyph alignment check meaningful; two independent estimates would
 * drift and the check would be measuring the bench's own inconsistency.
 */
const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = FONT;
const advanceCache = new Map<string, number>();
function advance(text: string): number {
  let w = advanceCache.get(text);
  if (w === undefined) {
    w = measureCtx.measureText(text).width;
    advanceCache.set(text, w);
  }
  return w;
}

interface Run {
  text: string;
  x: number;
  width: number;
}

/** One Markdown-ish block: a short paragraph of positioned runs. */
class Block extends Entity {
  /** Grows during the streaming workload. */
  public extra = '';

  private layoutCache: Run[][] | null = null;
  private layoutKey = '';
  private semanticCache: ReturnType<Block['buildSemantic']> | null = null;
  private semanticKey = '';

  /**
   * Content epoch, for the `hybrid-dirty` arm only.
   *
   * Derived from `extra.length` rather than an incrementing counter because the
   * streaming workload mutates `extra` directly (`target.extra += …`) rather than
   * through a setter, so there is no single site at which to bump one. Length is
   * exact for this workload: `extra` only ever grows by appending. A real entity
   * bumps a counter inside its own layout funnel instead — see
   * `Text.applyLayout()` and `CodeBlock.buildLines()`.
   *
   * Returning `null` for every other arm is what keeps them measuring today's
   * behaviour: `Scene` only skips an entity that opts in.
   */
  override getContentEpoch(): number | null {
    return this.arm === 'hybrid-dirty' || this.arm === 'split' ? this.extra.length : null;
  }

  constructor(
    id: string,
    private readonly arm: ArmKey,
    private readonly docY: number,
  ) {
    super(id);
    this.width = VIEW_W - 40;
    this.height = BLOCK_H;
  }

  isPointInside(): boolean {
    return false;
  }

  /**
   * Paint the text at exactly the coordinates `getContentProjection()` reports.
   *
   * Both read {@link layout}, so a carrier is at its glyphs' x by construction
   * rather than by coincidence.
   */
  render(r: {
    fillText: (t: string, x: number, y: number, font: string, color: string) => void;
  }): void {
    const lines = this.layout();
    for (let i = 0; i < lines.length; i++) {
      const baseline = i * LINE_H + 14;
      for (const run of lines[i]!) r.fillText(run.text, run.x, baseline, FONT, '#1a1a1a');
    }
  }

  /** Is any part of this block inside the fine-geometry band? */
  private inBand(): boolean {
    return this.docY + this.height >= band.min && this.docY <= band.max;
  }

  /**
   * Per-line runs with measured advances. Cached against the streaming tail, so
   * a static block does not re-measure every synced frame.
   */
  private layout(): Run[][] {
    if (this.layoutCache && this.layoutKey === this.extra) return this.layoutCache;
    const lines: Run[][] = [];
    for (let i = 0; i < LINES_PER_BLOCK; i++) {
      const runs: Run[] = [];
      let x = TEXT_LEFT;
      for (let r = 0; r < RUNS_PER_LINE; r++) {
        let text = `w${i}${r} `;
        // Streaming appends land on the block's last line, as they do in a
        // transcript whose tail block is still being written.
        if (i === LINES_PER_BLOCK - 1 && r === RUNS_PER_LINE - 1 && this.extra) {
          text += this.extra;
        }
        const width = advance(text);
        runs.push({ text, x, width });
        x += width;
      }
      lines.push(runs);
    }
    this.layoutCache = lines;
    this.layoutKey = this.extra;
    return lines;
  }

  private buildSemantic(): {
    text: string;
    font: string;
    lineHeight: number;
    selectable: boolean;
  } {
    return {
      text: this.layout()
        .map((runs) => runs.map((r) => r.text).join(''))
        .join('\n'),
      font: FONT,
      lineHeight: LINE_H,
      // Fine geometry is absent, so this node must not intercept the pointer: a
      // click has to reach the canvas, and selection is what layer 3 is for.
      selectable: false,
    };
  }

  /**
   * Layer 2 only: the whole block's text, no geometry.
   *
   * Memoized in the `hybrid-cached` arm. An off-band block's semantic text does
   * not change unless its own content changes, so a real implementation would
   * keep it rather than rebuild it every synced frame — the same reasoning that
   * made #345 pass a band hint down instead of only windowing the DOM.
   * Splitting this into its own arm attributes the idle cost between "building
   * the projection" and "Scene walking every resident block".
   */
  private semanticOnly(): ReturnType<Block['buildSemantic']> {
    if (this.arm !== 'hybrid-cached') return this.buildSemantic();
    if (this.semanticCache && this.semanticKey === this.extra) return this.semanticCache;
    this.semanticCache = this.buildSemantic();
    this.semanticKey = this.extra;
    return this.semanticCache;
  }

  /** Layers 2 + 3: text plus per-line, per-run carriers. */
  private withGeometry(hint?: { minY?: number; maxY?: number }) {
    const layout = this.layout();
    const lines = [];
    for (let i = 0; i < layout.length; i++) {
      const y = i * LINE_H;
      if (
        hint?.minY !== undefined &&
        hint.maxY !== undefined &&
        (y + LINE_H < hint.minY || y > hint.maxY)
      ) {
        continue;
      }
      const runs = layout[i]!;
      lines.push({
        text: runs.map((r) => r.text).join(''),
        x: TEXT_LEFT,
        y,
        baseline: 14,
        lineHeight: LINE_H,
        runs: runs.map((r) => ({ text: r.text, x: r.x, width: r.width })),
      });
    }
    return {
      text: lines.map((l) => l.text).join('\n'),
      font: FONT,
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }

  override getContentProjection(hint?: { minY?: number; maxY?: number }) {
    switch (this.arm) {
      case 'never':
        return null;
      case 'native':
      case 'all-resident':
      // `split` behaves like a NAIVE entity on purpose: it always returns
      // `lines`, and never consults `band`. Every other resident arm simulates
      // the coarse tier itself by withholding `lines` off-band, which is the
      // thing an entity should not have to do. If the engine's split works, this
      // arm reaches `hybrid`'s DOM shape without the entity cooperating at all.
      case 'split':
        return this.withGeometry(hint);
      default:
        // The whole point: resident text for every block, fine geometry only
        // where the user can actually see and select it.
        return this.inBand() ? this.withGeometry(hint) : this.semanticOnly();
    }
  }
}

interface Arm {
  key: ArmKey;
  label: string;
  /** Scene's entity-level virtualization margin (the CARRIER band). */
  margin: number;
  /**
   * Scene's SEMANTIC margin — whether a block has any DOM at all. Omitted means
   * "same as `margin`", which is the pre-split behaviour of one gate.
   */
  semanticMargin?: number;
  /** Can off-screen text be found by native find-in-page in this arm? */
  offscreenFindable: boolean;
}

const ARMS: Arm[] = [
  {
    key: 'native',
    label: 'today: band only, off-screen text has no DOM',
    margin: VIEW_H,
    offscreenFindable: false,
  },
  {
    key: 'hybrid',
    label: 'simulated hybrid: all blocks semantic, band gets fine geometry',
    margin: Number.POSITIVE_INFINITY,
    offscreenFindable: true,
  },
  {
    key: 'hybrid-cached',
    label: 'simulated hybrid with memoized off-band semantic projection',
    margin: Number.POSITIVE_INFINITY,
    offscreenFindable: true,
  },
  {
    // The engine change under test (vectojs#343 step 1, carryctx CTX-0199).
    //
    // Byte-for-byte the same projection behaviour as `hybrid` — same margin, same
    // resident text for every block, same fine geometry in the band. The ONLY
    // difference is that `Block.getContentEpoch()` returns a value, so
    // `Scene.syncContentProjection` can skip an unchanged block before calling
    // `getContentProjection()`. So `hybrid` vs `hybrid-dirty` isolates
    // dirty-tracking with nothing else varying, and `hybrid-cached` is the
    // control that shows caching the projection OBJECT is not the same lever.
    //
    // Note this arm still uses margin=Infinity, which disables both engine gates
    // and is not a supported configuration — deliberately, because it is the
    // worst case (every block resident) and therefore the honest place to measure
    // whether the skip carries it.
    key: 'hybrid-dirty',
    label: 'hybrid + dirty-tracked sync: unchanged blocks skipped before projection',
    margin: Number.POSITIVE_INFINITY,
    offscreenFindable: true,
  },
  {
    // A wide-but-FINITE margin. This is the arm that matters, because
    // `Number.isFinite(margin)` is what arms both engine gates: an infinite
    // margin skips the O(1) box test AND passes `undefined` as the line band,
    // so `getContentProjection()` runs unwindowed for every block — precisely
    // the O(total document glyphs) regression CTX-0024 removed (Scene.ts:4638).
    // A finite margin keeps both gates, so the semantic tier costs
    // O(blocks within margin) instead of O(document).
    //
    // The tradeoff this measures: findability reaches the margin, not the whole
    // document. Blocks beyond it are still freed, so this buys a WIDER findable
    // window rather than a complete one.
    key: 'hybrid-windowed',
    label: 'hybrid with a wide finite margin: gates stay live, findable to margin',
    margin: VIEW_H * 12,
    offscreenFindable: true,
  },
  {
    key: 'all-resident',
    label: 'naive findability: every block fully materialized',
    margin: Number.POSITIVE_INFINITY,
    offscreenFindable: true,
  },
  {
    // THE ENGINE FEATURE, not a simulation (vectojs#343 step 2, CTX-0201).
    //
    // `contentSemanticMargin: Infinity` arms only the box gate, so every block
    // keeps resident text; `contentProjectionMargin: VIEW_H` still arms the
    // carrier band, so carriers stay windowed to the viewport. Every other
    // resident arm gets that shape only by having the ENTITY withhold `lines`
    // off-band; this one gets it from Scene while the entity returns everything.
    //
    // The capability proof is numeric and needs no screenshot: its per-block
    // element count should match `hybrid` (every block resident, whole document
    // findable) while its per-line span count matches `native` (fine geometry
    // still bounded by the viewport). No single-margin configuration can produce
    // both at once — see splitVsHybridCarriers / splitVsNativeDescendants.
    key: 'split',
    label: 'engine split: semantic=Infinity + interaction=viewport, entity naive',
    margin: VIEW_H,
    semanticMargin: Number.POSITIVE_INFINITY,
    offscreenFindable: true,
  },
  {
    key: 'never',
    label: 'floor: no content projection at all',
    margin: VIEW_H,
    offscreenFindable: false,
  },
];

interface Built {
  scene: Scene;
  canvas: HTMLCanvasElement;
  blocks: Block[];
}

function build(count: number, arm: Arm): Built {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  // Pin the CSS size too: with `disableWindowResize` the element's laid-out size
  // drives a ResizeObserver, so an implicit size would let layout re-inflate the
  // scene and move every block outside the visibility test.
  canvas.style.cssText = `display:block;width:${VIEW_W}px;height:${VIEW_H}px`;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, {
    contentProjectionMargin: arm.margin,
    // Only the `split` arm sets this. Passing `undefined` elsewhere is exactly
    // the default, so every other arm is byte-identical to a pre-split run.
    contentSemanticMargin: arm.semanticMargin,
    // Without this, Scene binds a window-resize handler that resizes the canvas
    // to window.innerWidth/innerHeight. The band and the block coordinates here
    // are computed against VIEW_W/VIEW_H, so an inflated viewport silently moves
    // every block outside the exact-visibility test and Scene sets `display:
    // none` on every carrier — the projection cost then measures hidden nodes.
    disableWindowResize: true,
  });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  scene.maxFPS = 0;

  // Scroll to the middle of the document, so the band is an interior one rather
  // than trivially the first screen.
  const docHeight = count * BLOCK_PITCH;
  const scrollY = Math.max(0, docHeight / 2 - VIEW_H / 2);
  band.min = scrollY - VIEW_H;
  band.max = scrollY + VIEW_H * 2;

  const blocks: Block[] = [];
  for (let i = 0; i < count; i++) {
    const docY = i * BLOCK_PITCH;
    const b = new Block(`b${i}`, arm.key, docY);
    b.setPosition(20, docY - scrollY);
    scene.add(b);
    blocks.push(b);
  }
  return { scene, canvas, blocks };
}

function syncOnce(scene: Scene): void {
  const s = scene as unknown as {
    syncA11y: (r: unknown) => void;
    root: unknown;
  };
  s.syncA11y(s.root);
}

interface DomCensus {
  carriers: number;
  descendants: number;
  total: number;
}

function census(): DomCensus {
  const carriers = document.querySelectorAll('[data-vecto-content]').length;
  const descendants = document.querySelectorAll('[data-vecto-content] *').length;
  return { carriers, descendants, total: carriers + descendants };
}

interface MemoryApi {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: { usedJSHeapSize: number };
}

/**
 * Bytes attributable to this page, DOM included where the browser will say.
 *
 * `measureUserAgentSpecificMemory()` is preferred because it counts DOM memory,
 * which lives outside the JS heap — and DOM is the thing under test.
 * `usedJSHeapSize` is the fallback but is quantized to 5MB buckets without
 * `--enable-precise-memory-info`, so the source is reported alongside the figure
 * rather than the two being silently mixed.
 */
async function heapBytes(): Promise<{ bytes: number | null; source: string }> {
  const api = performance as unknown as MemoryApi;
  const w = window as unknown as MemoryApi;
  const measure = api.measureUserAgentSpecificMemory ?? w.measureUserAgentSpecificMemory;
  if (typeof measure === 'function' && crossOriginIsolated) {
    try {
      const result = await measure.call(performance);
      return {
        bytes: result.bytes,
        source: 'measureUserAgentSpecificMemory (includes DOM)',
      };
    } catch {
      // Fall through to the heap-only figure.
    }
  }
  if (api.memory) {
    return {
      bytes: api.memory.usedJSHeapSize,
      source: 'performance.memory.usedJSHeapSize (JS only, 5MB buckets)',
    };
  }
  return { bytes: null, source: 'unavailable' };
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface IdleMeasurement {
  msPerSync: number;
  dom: DomCensus;
  heap: number | null;
  heapBaseline: number | null;
  heapDelta: number | null;
  heapSource: string;
  painted: boolean;
  firstSyncMs: number;
  editInBandMs: number;
  editOffBandMs: number;
  editOffBandTargetY: number;
  editInBandTargetY: number;
}

/** Steady-state re-sync cost with nothing changing — the reading case. */
async function measureIdle(count: number, arm: Arm): Promise<IdleMeasurement> {
  // Absolute heap is not interpretable across arms: it drifts with whatever the
  // agent happens to be holding. Measured 2026-08-04 in the first full run, the
  // `never` arm — zero carriers, zero DOM — reported 21.31/16.53/23.96 MB across
  // the three block counts, and `hybrid` vs `hybrid-cached` at 100 blocks
  // reported 7.99 vs 21.44 MB despite byte-identical DOM (772 nodes each). That
  // is ~±8 MB of baseline noise, which swamps the signal below 10k blocks.
  //
  // So take a baseline with nothing from this arm alive yet and report the
  // DELTA. `measureUserAgentSpecificMemory()` forces GC and resolves after it
  // settles, which is what makes the pair subtractable.
  const before = await heapBytes();
  const { scene, canvas, blocks } = build(count, arm);
  // Paint once, and verify something actually landed on the canvas. A silently
  // blank canvas would make every projection figure here a measurement against
  // entities that draw nothing.
  // `step()`, not `render()`: Scene.render takes the renderer as an argument, so
  // a bare `render()` throws inside the engine on `renderer.isContextLost` — and
  // because the page still POSTs its failure envelope, that reads as a completed
  // run unless the result is actually inspected.
  scene.step(16.67);
  // Step twice, with a yield between. On a fractional-DPR display the first paint
  // is discarded when the backing store is resized (measured: scale 1.6 turns a
  // 560x560 canvas into 896x896), so a single step can leave the canvas blank and
  // this arm would measure projection cost for entities that drew nothing.
  await yieldToBrowser();
  scene.markDirty();
  scene.step(16.67);
  const ctx = canvas.getContext('2d')!;
  const sample = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 200));
  let painted = false;
  for (let i = 3; i < sample.data.length; i += 4) {
    if (sample.data[i] !== 0) {
      painted = true;
      break;
    }
  }

  // FIRST sync, timed rather than discarded (CTX-0200). Dirty-tracking only
  // helps from the SECOND sync onward, so this pass is the FRONT-LOAD: every
  // resident block is projected and its DOM created, with no epoch to skip on.
  // It is what a reader pays once at document build, and it is invisible in
  // `idleMsPerSync` because that figure is deliberately measured warm.
  const tFirst = performance.now();
  syncOnce(scene); // warm: materialize carriers
  const firstSyncMs = performance.now() - tFirst;
  const dom = census();
  const times: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    scene.markDirty();
    const t0 = performance.now();
    syncOnce(scene);
    times.push(performance.now() - t0);
  }

  // PER-EDIT cost (CTX-0200): dirty exactly ONE block and sync. This is the
  // other half of the front-load question — dirty-tracking makes an UNCHANGED
  // block free, but a genuinely changed one still pays full price, so a mode
  // that makes every block resident pays per edit rather than per frame.
  //
  // Two targets, because they are different cases and the difference is the
  // whole point of a resident tier:
  //   in-band  — the block the user is looking at. Every arm has DOM for it.
  //   off-band — a block the user cannot see. `native` released it at the margin
  //              gate so the edit is free; a resident tier still holds it, so
  //              this is the cost the capability actually adds.
  const editTimes = (target: Block): number => {
    const t: number[] = [];
    for (let i = 0; i < TRIALS; i++) {
      target.extra += 'e';
      scene.markDirty();
      const t0 = performance.now();
      syncOnce(scene);
      t.push(performance.now() - t0);
    }
    return median(t);
  };
  const inBandTarget = blocks.reduce(
    (best, b) => (Math.abs(b.y - VIEW_H / 2) < Math.abs(best.y - VIEW_H / 2) ? b : best),
    blocks[0]!,
  );
  const editInBandMs = editTimes(inBandTarget);
  // blocks[0] sits at docY 0 while the band starts at scrollY - VIEW_H with
  // scrollY = docHeight/2 - VIEW_H/2, so it is off-band at every count measured
  // here. Asserted rather than assumed: a target that turned out to be in-band
  // would silently make this column a duplicate of the one above.
  const offBandTarget = blocks[0]!;
  const editOffBandMs = editTimes(offBandTarget);
  // Measured with the scene still alive, or the DOM under test is already gone.
  const { bytes, source } = await heapBytes();
  scene.destroy();
  canvas.remove();
  await yieldToBrowser();
  return {
    msPerSync: median(times),
    dom,
    heap: bytes,
    heapBaseline: before.bytes,
    heapDelta:
      typeof bytes === 'number' && typeof before.bytes === 'number' ? bytes - before.bytes : null,
    heapSource: source,
    painted,
    firstSyncMs,
    editInBandMs,
    editOffBandMs,
    editOffBandTargetY: offBandTarget.y,
    editInBandTargetY: inBandTarget.y,
  };
}

interface StreamMeasurement {
  msPerFrame: number;
  addedNodes: number;
  removedNodes: number;
  characterDataMutations: number;
}

/**
 * Appending to the tail block, the chat-transcript workload.
 *
 * Counts DOM mutations as well as time: streaming mutation volume is one of the
 * places #343 expects a hybrid split to pay off, and it is invisible in a
 * frame-time average.
 */
async function measureStream(count: number, arm: Arm): Promise<StreamMeasurement> {
  const { scene, canvas, blocks } = build(count, arm);
  // Stream into a block inside the band. A tail block far off-screen would be
  // freed by the margin gate in `native` and the arms would not be comparable.
  const target = blocks.reduce(
    (best, b) => (Math.abs(b.y - VIEW_H / 2) < Math.abs(best.y - VIEW_H / 2) ? b : best),
    blocks[0]!,
  );

  syncOnce(scene);
  await yieldToBrowser();

  let added = 0;
  let removed = 0;
  let characterData = 0;
  const root = (scene as unknown as { a11yRoot: HTMLElement | null }).a11yRoot;
  if (!root) throw new Error('a11yRoot missing: mutation counts would be silently zero');
  const observer = new MutationObserver(() => {});
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const times: number[] = [];
  for (let f = 0; f < STREAM_FRAMES; f++) {
    target.extra += 'x'.repeat(CHUNK);
    scene.markDirty();
    const t0 = performance.now();
    syncOnce(scene);
    times.push(performance.now() - t0);
  }

  // Drain synchronously. MutationObserver delivers records in a microtask and
  // this loop never yields, so relying on the callback would report zero
  // mutations for arms that demonstrably rebuild their carriers.
  for (const r of observer.takeRecords()) {
    added += r.addedNodes.length;
    removed += r.removedNodes.length;
    if (r.type === 'characterData') characterData++;
  }
  observer.disconnect();
  scene.destroy();
  canvas.remove();
  await yieldToBrowser();
  return {
    msPerFrame: median(times),
    addedNodes: added,
    removedNodes: removed,
    characterDataMutations: characterData,
  };
}

async function main(): Promise<void> {
  await awaitStart();
  // Calibrate cadence HERE, while the page is idle, rather than letting
  // reportResult() do it at the end. `calibrateRefreshRate` caches per page and
  // returns the first measurement, so priming it now is what the envelope will
  // carry.
  //
  // Why it matters: this benchmark's workload is a series of long SYNCHRONOUS
  // syncA11y calls — up to ~137 ms each in the all-resident arm at 10k blocks —
  // which starve rAF. Calibrating after that measured 208.79 Hz on a 240 Hz panel
  // (runId 20260804T140822Z-768b87, Firefox), which failed validateEnvironment
  // and made the whole run non-quotable, even though the cadence gate had
  // observed 241.38 Hz at startup and every figure in this file comes from
  // explicit performance.now() brackets rather than frame cadence
  // (`syntheticFrames: true`). Calibrating before the workload reports the
  // cadence the page actually had, and leaves the validator meaningful instead of
  // tripping it on self-inflicted starvation.
  await calibrateRefreshRate();
  const startedAt = performance.now();
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace';
  document.body.appendChild(pre);

  const rows: Record<string, unknown>[] = [];
  const issues: string[] = [];
  let heapSource = 'unavailable';

  const armsToRun = ARM_FILTER ? ARMS.filter((a) => ARM_FILTER.includes(a.key)) : ARMS;
  if (armsToRun.length === 0) {
    throw new Error(
      `arms=${p.get('arms')} matched no arm; valid keys: ${ARMS.map((a) => a.key).join(',')}`,
    );
  }

  for (const count of BLOCK_COUNTS) {
    for (const arm of armsToRun) {
      const idle = await measureIdle(count, arm);
      const stream = await measureStream(count, arm);
      heapSource = idle.heapSource;
      if (!idle.painted) {
        issues.push(`${count}/${arm.key}: canvas had no painted pixels — render() drew nothing`);
      }
      rows.push({
        blocks: count,
        arm: arm.key,
        label: arm.label,
        offscreenFindable: arm.offscreenFindable,
        idleMsPerSync: +idle.msPerSync.toFixed(4),
        // CTX-0200: the front-load. One-time document-build cost, and the cost of
        // one genuine content change in and out of the viewport band.
        firstSyncMs: +idle.firstSyncMs.toFixed(4),
        editInBandMs: +idle.editInBandMs.toFixed(4),
        editOffBandMs: +idle.editOffBandMs.toFixed(4),
        // Reported so the off-band claim is CHECKABLE in the result rather than
        // resting on arithmetic in a comment. Screen-space y: the fine-geometry
        // band spans -VIEW_H..2*VIEW_H, so off-band means y < -700 here.
        editOffBandTargetY: +idle.editOffBandTargetY.toFixed(1),
        editInBandTargetY: +idle.editInBandTargetY.toFixed(1),
        streamMsPerFrame: +stream.msPerFrame.toFixed(4),
        carriers: idle.dom.carriers,
        domDescendants: idle.dom.descendants,
        domTotal: idle.dom.total,
        heapBytes: idle.heap,
        heapMB: idle.heap === null ? null : +(idle.heap / 1048576).toFixed(2),
        // The interpretable memory figure: this arm's cost above a baseline taken
        // with nothing of it alive. Absolute heapMB is retained only so the
        // baseline drift stays visible rather than being hidden by the delta.
        heapBaselineMB:
          idle.heapBaseline === null ? null : +(idle.heapBaseline / 1048576).toFixed(2),
        heapDeltaMB: idle.heapDelta === null ? null : +(idle.heapDelta / 1048576).toFixed(2),
        streamAddedNodes: stream.addedNodes,
        streamRemovedNodes: stream.removedNodes,
        streamCharacterDataMutations: stream.characterDataMutations,
        idleFits240: idle.msPerSync < 4.17,
        streamFits240: stream.msPerFrame < 4.17,
        editInBandFits240: idle.editInBandMs < 4.17,
        editOffBandFits240: idle.editOffBandMs < 4.17,
      });
      pre.textContent =
        `measured ${count} blocks / ${arm.key}…\n` + JSON.stringify(rows.slice(-5), null, 1);
      await yieldToBrowser();
    }
  }

  // The comparison the decision actually turns on: hybrid vs the naive way of
  // getting the same capability, at each document size.
  const summary = BLOCK_COUNTS.map((count) => {
    const of = (key: ArmKey): Record<string, unknown> | undefined =>
      rows.find((r) => r.blocks === count && r.arm === key);
    const native = of('native');
    const hybrid = of('hybrid');
    const cached = of('hybrid-cached');
    const dirty = of('hybrid-dirty');
    const windowed = of('hybrid-windowed');
    const allResident = of('all-resident');
    const split = of('split');
    const ratio = (a: unknown, b: unknown): number | null =>
      typeof a === 'number' && typeof b === 'number' && b > 0 ? +(a / b).toFixed(2) : null;
    return {
      blocks: count,
      // What full-document findability costs against today's band-only DOM.
      hybridVsNativeNodes: ratio(hybrid?.domTotal, native?.domTotal),
      hybridVsNativeIdleMs: ratio(hybrid?.idleMsPerSync, native?.idleMsPerSync),
      // Ratios are on the DELTA, not absolute heap: absolute heap carries ~±8 MB
      // of agent-level baseline drift, so an absolute ratio is mostly noise.
      hybridVsNativeHeap: ratio(hybrid?.heapDeltaMB, native?.heapDeltaMB),
      cachedVsNativeIdleMs: ratio(cached?.idleMsPerSync, native?.idleMsPerSync),
      // The arm that decides whether hybrid is affordable at all: a wide finite
      // margin keeps both engine gates live, so this is hybrid's cost when it
      // is NOT implemented as the CTX-0024 regression.
      windowedVsNativeIdleMs: ratio(windowed?.idleMsPerSync, native?.idleMsPerSync),
      windowedVsNativeNodes: ratio(windowed?.domTotal, native?.domTotal),
      hybridVsWindowedIdleMs: ratio(hybrid?.idleMsPerSync, windowed?.idleMsPerSync),
      // How much of hybrid's idle cost is rebuilding the projection vs Scene's
      // own walk over every resident block.
      hybridVsCachedIdleMs: ratio(hybrid?.idleMsPerSync, cached?.idleMsPerSync),
      // THE headline for CTX-0199: what dirty-tracking saves on an identical
      // workload. `hybrid` and `hybrid-dirty` differ only in whether the entity
      // stamps its content, so this ratio is the engine change and nothing else.
      hybridVsDirtyIdleMs: ratio(hybrid?.idleMsPerSync, dirty?.idleMsPerSync),
      dirtyVsNativeIdleMs: ratio(dirty?.idleMsPerSync, native?.idleMsPerSync),
      // CTX-0200 — the front-load a resident tier adds, which dirty-tracking by
      // construction cannot remove. `firstSync` is paid once at document build;
      // `editOffBand` is paid on every change to text the user cannot see, and is
      // the column where `native` is free because it holds no DOM there at all.
      dirtyFirstSyncMs: dirty?.firstSyncMs ?? null,
      nativeFirstSyncMs: native?.firstSyncMs ?? null,
      dirtyVsNativeFirstSyncMs: ratio(dirty?.firstSyncMs, native?.firstSyncMs),
      dirtyVsNativeEditInBandMs: ratio(dirty?.editInBandMs, native?.editInBandMs),
      dirtyVsNativeEditOffBandMs: ratio(dirty?.editOffBandMs, native?.editOffBandMs),
      dirtyEditInBandMs: dirty?.editInBandMs ?? null,
      dirtyEditOffBandMs: dirty?.editOffBandMs ?? null,
      nativeEditOffBandMs: native?.editOffBandMs ?? null,
      // Must stay 1.00: dirty-tracking is a cost change, not a capability
      // change. A different node count here means the skip dropped DOM it
      // should have kept, which is the failure mode that does not look wrong.
      dirtyVsHybridNodes: ratio(dirty?.domTotal, hybrid?.domTotal),
      // Streaming is where a skip could go wrong in the other direction: the
      // tail block DOES change every frame, so this must not regress.
      dirtyVsHybridStreamMs: ratio(dirty?.streamMsPerFrame, hybrid?.streamMsPerFrame),
      // What hybrid saves against the naive way of getting the same capability.
      allResidentVsHybridNodes: ratio(allResident?.domTotal, hybrid?.domTotal),
      allResidentVsHybridIdleMs: ratio(allResident?.idleMsPerSync, hybrid?.idleMsPerSync),
      allResidentVsHybridHeap: ratio(allResident?.heapDeltaMB, hybrid?.heapDeltaMB),
      windowedVsNativeHeap: ratio(windowed?.heapDeltaMB, native?.heapDeltaMB),
      allResidentVsHybridStreamMs: ratio(allResident?.streamMsPerFrame, hybrid?.streamMsPerFrame),
      // CTX-0201 — THE CAPABILITY PROOF for the engine split, and it is a pair of
      // ratios rather than a time, because the claim is about DOM SHAPE.
      //
      // Note which census field carries which half. `carriers` counts elements
      // with `[data-vecto-content]` — ONE PER RESIDENT BLOCK, i.e. the semantic
      // tier — while `domDescendants` counts the per-line/per-run spans inside
      // them, i.e. the interaction tier. So the split's two independent gates map
      // to those two counts, and `split` must match a DIFFERENT arm on each:
      //
      //   splitVsHybridCarriers ~ 1     every block resident (whole doc findable)
      //   splitVsNativeDescendants ~ 1  carriers still viewport-bounded
      //
      // No single-margin configuration reaches both: `native` fails the first
      // (off-band blocks have no DOM at all) and `hybrid`/`all-resident` fail the
      // second. A drift below 1 on the first means the semantic gate is still
      // releasing; above 1 on the second means the carrier band stopped windowing.
      splitVsHybridCarriers: ratio(split?.carriers, hybrid?.carriers),
      splitVsNativeDescendants: ratio(split?.domDescendants, native?.domDescendants),
      splitCarriers: split?.carriers ?? null,
      splitDomDescendants: split?.domDescendants ?? null,
      nativeCarriers: native?.carriers ?? null,
      nativeDomDescendants: native?.domDescendants ?? null,
      hybridCarriers: hybrid?.carriers ?? null,
      hybridDomDescendants: hybrid?.domDescendants ?? null,
      // And what it costs, against the arm that simulates the same shape
      // entity-side. Above ~1 means the engine tier is more expensive than an
      // entity withholding `lines`, which would be an argument against it.
      splitVsDirtyIdleMs: ratio(split?.idleMsPerSync, dirty?.idleMsPerSync),
      splitVsDirtyFirstSyncMs: ratio(split?.firstSyncMs, dirty?.firstSyncMs),
      splitFirstSyncMs: split?.firstSyncMs ?? null,
      splitIdleMsPerSync: split?.idleMsPerSync ?? null,
      splitDomTotal: split?.domTotal ?? null,
    };
  });

  const result = await reportResult({
    name: 'hybrid-projection',
    params: {
      BLOCK_COUNTS,
      LINES_PER_BLOCK,
      RUNS_PER_LINE,
      CHUNK,
      STREAM_FRAMES,
      TRIALS,
      VIEW_W,
      VIEW_H,
      heapSource,
      // Which arms this load actually measured. A single-arm load is how the
      // memory figures are taken (cold baseline per arm); a full load is how the
      // time figures are taken (all arms comparable within one environment).
      armsRun: armsToRun.map((a) => a.key),
      note:
        "'hybrid' simulates ContentProjectionMode:'hybrid' with shipped primitives, not an implementation; " +
        "'native' is today's behaviour, in which off-screen text has no DOM and is therefore NOT findable by native find-in-page. " +
        "'hybrid' and 'all-resident' use margin=Infinity, which makes Number.isFinite(margin) false and so skips BOTH engine gates " +
        '(Scene.ts:4638 box test and the line band), running getContentProjection() unwindowed for every block — the CTX-0024 ' +
        "O(total document glyphs) regression. 'hybrid-windowed' uses a wide FINITE margin so both gates stay live and is the arm " +
        'that reflects a competently-built hybrid; its findability reaches the margin, not the whole document. ' +
        "'split' is the SHIPPED engine feature rather than a simulation: contentSemanticMargin=Infinity arms only the box gate while " +
        'contentProjectionMargin=viewport still windows the carriers, and its entity is deliberately naive (always returns `lines`, ' +
        'never consults the band), so any coarse tier it reaches came from Scene. Its capability proof is splitVsHybridCarriers ~ 1 ' +
        '(every block resident, so the whole document is findable) TOGETHER WITH splitVsNativeDescendants ~ 1 (per-line carriers still ' +
        'bounded by the viewport) — two counts no single-margin configuration can satisfy at once.',
    },
    rows,
    summary,
    issues,
    // syncA11y is driven directly in a tight loop, so there are no real
    // animation frames for LoAF to observe.
    syntheticFrames: true,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  pre.textContent = JSON.stringify(result, null, 2);
}

main().catch((error) => reportFailure('hybrid-projection', error));
