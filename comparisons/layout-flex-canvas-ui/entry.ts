// VectoJS `Stack` (@vectojs/ui) vs `@canvas-ui/core` `RenderFlex` — canvas box
// layout head-to-head.
//
// Why this pair. Of every library cloned into `references/`, `@canvas-ui/core`
// (Alibaba) is the only one attempting the same thing VectoJS is: a general UI
// runtime that renders components to a canvas with a DOM-like scene tree, its
// own text layout, and a box layout system. Konva and Fabric are scene-graph /
// object-model libraries with no layout system at all, which is why
// `render-canvas-libs` compares them on rendering and semantics instead.
//
// The interesting difference is architectural and decision-changing: canvas-ui
// delegates layout to **Yoga**, Facebook's C++ flexbox engine, while VectoJS
// computes layout in hand-written TypeScript. "Is a compiled flexbox engine
// faster than hand-written JS?" is a question a reader may reasonably assume is
// settled in Yoga's favour.
//
// IMPORTANT, and checked rather than assumed: the build canvas-ui 2.0.0 depends
// on is `yoga-layout-prebuilt-fork@1.10.6`, which ships **asm.js, not
// WebAssembly** — its `build/Release/nbind.js` contains `"use asm"` and zero
// references to `WebAssembly`, and the package contains no `.wasm` file at all.
// So this is not "WASM vs JS". It is an Emscripten/nbind asm.js port against
// native JIT-compiled TypeScript, which is a very different proposition: modern
// V8 and SpiderMonkey optimize idiomatic JS well, while asm.js pays marshalling
// on every call across its boundary and no longer gets the dedicated
// ahead-of-time pipeline it once did.
//
// SCOPE DIFFERENCE, stated plainly (README ground rule 3):
//   • canvas-ui `RenderFlex` implements a large share of the flexbox spec —
//     flexGrow/Shrink/Basis, wrap, justifyContent, alignItems/alignContent/
//     alignSelf, per-side margin/padding, min/max on both axes, percentage and
//     'auto' sizes, absolute positioning.
//   • VectoJS `Stack` implements single-axis stacking: direction, gap, cross-axis
//     align, and optional wrap against a main-axis limit.
// So Stack is a SUBSET. This benchmark deliberately drives only that subset —
// stacked rows of fixed-size children with a gap — which both express natively.
// It is not evidence that Stack could replace RenderFlex; it measures the cost of
// the layout both perform, on the workload both support.
//
// ASYMMETRY ALSO STATED (ground rule 4): canvas-ui's `gap` has no direct
// equivalent, so the cells carry `marginRight`/`marginBottom` instead, which is
// how a canvas-ui author writes a gap. That gives Yoga per-child margin work
// VectoJS folds into one scalar — a real difference in what the two engines are
// asked to do, not a rigged workload.
import { Entity, type IRenderer } from '@vectojs/core';
import { Stack } from '@vectojs/ui';
import { RenderFlex, RenderPipeline, RenderSingleChild } from '@canvas-ui/core';

const q = new URLSearchParams(location.search);
const TRIALS = Number(q.get('trials') ?? 15);
/**
 * Untimed passes before each phase's timed trials. Three rather than one because
 * the VectoJS arm here is sub-millisecond and therefore the most sensitive to
 * still being in the interpreter: with a single warmup its 200-row and 500-row
 * build medians came out 0.53 ms and 0.56 ms, which is not a per-node cost and
 * was an artifact, not sublinear scaling.
 */
const WARMUPS = 3;
/** Children per row. Kept small so row count, not row width, drives the tree. */
const CELLS_PER_ROW = 3;
const CELL_W = 100;
const CELL_H = 20;
const GAP = 8;
/** Content width of one row: cells plus the gaps between them. */
const ROW_CONTENT_W = CELLS_PER_ROW * CELL_W + (CELLS_PER_ROW - 1) * GAP;
/**
 * The two widths the relayout phase alternates between. Both are > the row's
 * content width and differ by 1px, so every cell keeps its position and the
 * trees stay geometrically equivalent while still forcing a full re-derivation.
 * A larger swing would be a different workload, not a bigger one.
 *
 * Neither may EQUAL `ROW_CONTENT_W`, and that is load-bearing rather than
 * cosmetic. A row that was never given an explicit width sizes to its content,
 * i.e. exactly `ROW_CONTENT_W`. So if `ROW_W_A` were `ROW_CONTENT_W`, a relayout
 * that silently did nothing would leave `size.width` at that same value and the
 * `reflowVerified` check below would read true — the check would pass under the
 * very failure it exists to catch. Verified by sabotage: with `ROW_W_A =
 * ROW_CONTENT_W` and the relayout reverted to the no-op `alignItems` write,
 * `allReflowsVerified` came back **true** for all three row counts. Offsetting
 * both widths off the content width is what gives the check teeth.
 */
const ROW_W_A = ROW_CONTENT_W + 1;
const ROW_W_B = ROW_CONTENT_W + 2;

const median = (xs: number[]): number => {
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
};
const time = (f: () => void): number => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

/**
 * Time `reps` repetitions of `f` in ONE timed region and return the per-call
 * cost. Necessary, not decorative: `performance.now()` is quantised even under
 * cross-origin isolation — measured here at 5 µs in Chrome and **20 µs in
 * Firefox** — and the VectoJS arms of this benchmark are far below a millisecond.
 * Timing them one call at a time produced a Firefox relayout sample set of
 * `[0.02, 0.02, 0, 0.02, 0, 0.02, …]`: literally one timer tick or zero, i.e. a
 * quantisation pattern rather than a measurement. Batching moves the timed region
 * to tens of milliseconds, where a 20 µs tick is negligible.
 */
const timePer = (reps: number, f: () => void): number => {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) f();
  return (performance.now() - t0) / reps;
};

/** Timed region long enough that a 20 µs timer tick is <0.1% of it. */
const TARGET_MS = 20;
/** Cap so a slow arm (canvas-ui incremental at 500 rows is ~0.5 s) stays sane. */
const MAX_REPS = 500;

/**
 * Choose a repetition count for `f` from one probe call, so every arm is timed
 * over a comparable wall-clock window regardless of whether one call costs 25 µs
 * or 500 ms. Returns at least 1, so the slow arms behave exactly as before.
 */
const calibrateReps = (f: () => void): number => {
  const probe = timePer(1, f);
  if (probe <= 0) return MAX_REPS; // below timer resolution entirely
  return Math.max(1, Math.min(MAX_REPS, Math.ceil(TARGET_MS / probe)));
};
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

/**
 * A fixed-size leaf. `Entity` is abstract and `Stack` only reads `width`/`height`
 * and writes `x`/`y`, so this is the minimal symmetric counterpart to an empty
 * `RenderFlex` cell with a fixed width/height style: neither side paints.
 */
class Cell extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  public render(_r: IRenderer): void {}
}

// ── VectoJS ──────────────────────────────────────────────────────────────────

/**
 * Build `rows` rows of `CELLS_PER_ROW` cells. `Stack.add()` positions the new
 * child and grows the container immediately, so geometry is valid after every
 * single call — no flush step exists or is needed.
 */
function vectoBuild(rows: number): Stack {
  const root = new Stack({ direction: 'vertical', gap: GAP });
  for (let i = 0; i < rows; i++) {
    const row = new Stack({ direction: 'horizontal', gap: GAP });
    for (let j = 0; j < CELLS_PER_ROW; j++) row.add(new Cell(CELL_W, CELL_H));
    root.add(row);
  }
  return root;
}

/**
 * Reflow every row and the root.
 *
 * `Stack` has no width *input* — it sizes to its content — so there is no
 * "set the width and let it invalidate" path to trigger. The equivalent unit of
 * work is a direct `layout()` on every row plus the root, which re-derives every
 * child position and both container sizes.
 *
 * That is the same *work* as the canvas-ui arm even though the *trigger* differs
 * (a direct call here, a dirty-marking width write there): both re-derive the
 * whole tree's geometry. Stating it explicitly because the asymmetry in trigger
 * is real and a reader should be able to judge it — what is compared is
 * "re-derive this tree's layout", not "handle a resize event".
 */
function vectoRelayout(root: Stack): void {
  for (const child of root.children) (child as Stack).layout();
  root.layout();
}

// ── canvas-ui ────────────────────────────────────────────────────────────────

type AnyStyle = Record<string, unknown>;
/** `RenderObject.style` is a readonly Proxy-backed StyleMap: assign per property. */
const styleOf = (el: { style: unknown }) => el.style as AnyStyle;

interface CanvasUiTree {
  pipeline: RenderPipeline;
  root: RenderFlex;
  rows: RenderFlex[];
}

/**
 * A `RenderPipeline` whose `rootNode` is a `RenderSingleChild` acting as the
 * relayout boundary — the exact harness canvas-ui's own `render-flex.spec.ts`
 * uses. `flushLayout()` is what their frame scheduler calls, so driving it
 * directly measures their layout with no rendering or scheduling attached.
 */
function newCanvasUiTree(): CanvasUiTree {
  const boundary = new RenderSingleChild() as unknown as {
    _relayoutBoundary: unknown;
    child: unknown;
  };
  boundary._relayoutBoundary = boundary;
  const pipeline = new RenderPipeline(() => {});
  (pipeline as unknown as { rootNode: unknown }).rootNode = boundary;

  const root = new RenderFlex();
  styleOf(root).flexDirection = 'column';
  boundary.child = root;
  return { pipeline, root, rows: [] };
}

/**
 * canvas-ui has no `gap`, so the gap is expressed as a leading margin on every
 * child except the first — `marginTop` between rows, `marginLeft` between cells.
 * Leading rather than trailing margin on purpose: it is knowable at append time
 * without lookahead, so the incremental build below needs no "is this the last
 * one" foreknowledge it would not have while streaming.
 *
 * Both axes carry the gap, because `Stack` applies its gap on both. An earlier
 * version of this file set only `marginRight` on cells, which left the canvas-ui
 * column with no row gap: it produced a root height of 80 against VectoJS's 104
 * and made canvas-ui look faster by giving Yoga strictly less work. The geometry
 * check below is what caught it, which is why it runs before any timing.
 */
function newRow(isFirst: boolean): RenderFlex {
  const row = new RenderFlex();
  const s = styleOf(row);
  s.flexDirection = 'row';
  if (!isFirst) s.marginTop = GAP;
  return row;
}

function newCell(isFirstInRow: boolean): RenderFlex {
  const cell = new RenderFlex();
  const s = styleOf(cell);
  s.width = CELL_W;
  s.height = CELL_H;
  if (!isFirstInRow) s.marginLeft = GAP;
  return cell;
}

/**
 * Incremental build: flush after each row so geometry is valid at every step,
 * matching the guarantee `Stack.add()` gives for free. This is the streaming
 * shape — a feed or chat appending one item at a time and needing correct
 * geometry before the next frame.
 */
function canvasUiBuildIncremental(rows: number): CanvasUiTree {
  const t = newCanvasUiTree();
  for (let i = 0; i < rows; i++) {
    const row = newRow(i === 0);
    for (let j = 0; j < CELLS_PER_ROW; j++) row.appendChild(newCell(j === 0));
    t.root.appendChild(row);
    t.rows.push(row);
    t.pipeline.flushLayout();
  }
  return t;
}

/**
 * Batched build: append everything, flush once. This is what a canvas-ui author
 * writes when they can defer to the next frame, and it is the fairer number for
 * "build a tree of N rows". Reported separately rather than instead of the
 * incremental one, because the two answer different questions.
 */
function canvasUiBuildBatched(rows: number): CanvasUiTree {
  const t = newCanvasUiTree();
  for (let i = 0; i < rows; i++) {
    const row = newRow(i === 0);
    for (let j = 0; j < CELLS_PER_ROW; j++) row.appendChild(newCell(j === 0));
    t.root.appendChild(row);
    t.rows.push(row);
  }
  t.pipeline.flushLayout();

  return t;
}

/**
 * Reflow the same tree: mark every row dirty, then flush.
 *
 * Which property is used matters, and getting it wrong silently measures
 * nothing. A `StyleMap` write only fires its change event when the value
 * actually differs, and — measured in canvas-ui 2.0.0 — `RenderFlex`'s five
 * container-style handlers (`flexDirection`, `flexWrap`, `justifyContent`,
 * `alignItems`, `alignContent`, at render-flex.ts:42-65) set the Yoga property
 * but **never call `markLayoutDirty()`**, unlike `RenderObject`'s `width`/
 * `height`/`flexGrow`/… handlers which all do. So writing `alignItems` leaves
 * `pipeline.layoutDirtyObjects` empty and `flushLayout()` returns immediately:
 * a first version of this function did exactly that and reported 0.045 ms for
 * 500 rows, which is a no-op flush, not a fast Yoga.
 *
 * `width` is therefore the property used here: it routes through
 * `handleWidthChange`, which does mark dirty. Alternating between two widths
 * mirrors a container resize, which is the same thing VectoJS's `layout()` pass
 * re-derives.
 */
function canvasUiRelayout(t: CanvasUiTree, tick: number): void {
  canvasUiMarkDirty(t, tick);
  t.pipeline.flushLayout();
}

/**
 * The dirty-marking half of `canvasUiRelayout`, split out so the two halves can
 * be timed separately.
 *
 * This matters for attributing the cost honestly. Each `styleOf(row).width = w`
 * goes through the StyleMap Proxy's `set` trap, an eventemitter3 `emit`,
 * `handleWidthChange`, `yogaNode.setWidth` (a call across the asm.js boundary),
 * and `markLayoutDirty`. None of that is Yoga computing a layout, but all of it
 * is unavoidable in canvas-ui's API — a caller has no other way to invalidate.
 * Reporting only the total would leave a reader unable to tell whether Yoga is
 * slow or the invalidation path around it is.
 */
function canvasUiMarkDirty(t: CanvasUiTree, tick: number): void {
  const w = tick % 2 === 0 ? ROW_W_A : ROW_W_B;
  for (const row of t.rows) styleOf(row).width = w;
  styleOf(t.root).width = w;
}

// ── Phases ───────────────────────────────────────────────────────────────────

function buildPhase(rows: number) {
  // Warm both paths so neither pays first-call JIT or Yoga module init. Several
  // warmup passes rather than one: with a single pass the VectoJS arm was still
  // climbing out of the interpreter during the first timed trials, which showed
  // up as a build time that barely moved between 200 and 500 rows — i.e. a
  // measurement artifact masquerading as sublinear scaling.
  for (let i = 0; i < WARMUPS; i++) {
    vectoBuild(rows);
    canvasUiBuildIncremental(rows);
    canvasUiBuildBatched(rows);
  }
  // Each arm gets its own repetition count, calibrated from a probe call, so all
  // four are timed over a ~20 ms window despite spanning 4 orders of magnitude
  // per call. Without this the VectoJS arms sit at the timer floor while the
  // canvas-ui arms do not, which is not a fair basis for a ratio.
  const vectoReps = calibrateReps(() => vectoBuild(rows));
  const incrReps = calibrateReps(() => canvasUiBuildIncremental(rows));
  const batchedReps = calibrateReps(() => canvasUiBuildBatched(rows));

  const vectoSamples = Array.from({ length: TRIALS }, () =>
    timePer(vectoReps, () => vectoBuild(rows)),
  );
  return {
    reps: { vecto: vectoReps, canvasUiIncremental: incrReps, canvasUiBatched: batchedReps },
    // Raw per-call samples for the fastest arm, so a reader can see whether a
    // sub-millisecond median is a stable measurement or timer noise.
    vectoSamplesMs: vectoSamples.map((x) => +x.toFixed(5)),
    vectoMs: +median(vectoSamples.slice()).toFixed(5),
    canvasUiIncrementalMs: +median(
      Array.from({ length: TRIALS }, () => timePer(incrReps, () => canvasUiBuildIncremental(rows))),
    ).toFixed(4),
    canvasUiBatchedMs: +median(
      Array.from({ length: TRIALS }, () => timePer(batchedReps, () => canvasUiBuildBatched(rows))),
    ).toFixed(4),
  };
}

function relayoutPhase(rows: number) {
  const v = vectoBuild(rows);
  const c = canvasUiBuildBatched(rows);
  let tick = 0;
  for (let i = 0; i < WARMUPS; i++) {
    vectoRelayout(v);
    canvasUiRelayout(c, tick++);
  }

  // Prove the canvas-ui arm actually reflowed rather than flushing an empty
  // dirty list — the exact failure the `alignItems` version had. A width write
  // that marks dirty leaves the row's size equal to the width just written, so
  // reading it back distinguishes "reflowed" from "did nothing" without any
  // dependence on the timing it is meant to validate.
  const lastWritten = (tick - 1) % 2 === 0 ? ROW_W_A : ROW_W_B;
  const row0 = c.rows[0] as unknown as { size: { width: number } };
  const reflowVerified = row0.size.width === lastWritten;

  // Attribute canvas-ui's relayout cost between marking dirty and computing the
  // layout. Measured by timing the mark phase alone, then the flush alone, in
  // the same iteration — so the two always sum to a real end-to-end relayout of
  // the same tree at the same tick rather than to two unrelated runs.
  const markSamples: number[] = [];
  const flushSamples: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    markSamples.push(time(() => canvasUiMarkDirty(c, tick)));
    flushSamples.push(time(() => c.pipeline.flushLayout()));
    tick++;
  }

  // Only the VectoJS arm needs repetition batching: it is tens of microseconds,
  // i.e. one or two Firefox timer ticks. Every canvas-ui arm above is already
  // milliseconds (mark 1.1-13 ms, flush 1.1-6.6 ms), so a 20 µs tick is under 2%
  // of the smallest of them and single-shot timing is sound there.
  const vectoReps = calibrateReps(() => vectoRelayout(v));
  const vectoSamples = Array.from({ length: TRIALS }, () =>
    timePer(vectoReps, () => vectoRelayout(v)),
  );
  return {
    reflowVerified,
    vectoReps,
    vectoSamplesMs: vectoSamples.map((x) => +x.toFixed(5)),
    vectoMs: +median(vectoSamples.slice()).toFixed(5),
    canvasUiMs: +median(
      Array.from({ length: TRIALS }, () => time(() => canvasUiRelayout(c, tick++))),
    ).toFixed(4),
    canvasUiMarkDirtyMs: +median(markSamples).toFixed(4),
    canvasUiFlushMs: +median(flushSamples).toFixed(4),
  };
}

/**
 * Both engines must AGREE on the geometry, or a speed number is meaningless.
 * Asserted in-page and reported in the payload so a wrong result cannot be
 * quoted as a fast one.
 */
function geometryCheck() {
  const rows = 4;
  const v = vectoBuild(rows);
  const c = canvasUiBuildBatched(rows);

  const expectedRowW = ROW_CONTENT_W;
  const expectedRootH = rows * CELL_H + (rows - 1) * GAP;

  const vRow0 = v.children[0]!;
  const vRow1 = v.children[1]!;
  const cRow0 = c.rows[0] as unknown as {
    size: { width: number; height: number };
  };
  const cRow1 = c.rows[1] as unknown as { offset: { x: number; y: number } };

  return {
    expected: {
      rowWidth: expectedRowW,
      rootHeight: expectedRootH,
      row1Y: CELL_H + GAP,
    },
    vecto: {
      rowWidth: vRow0.width,
      rootHeight: v.height,
      row1Y: vRow1.y,
    },
    canvasUi: {
      rowWidth: cRow0.size.width,
      rootHeight: (c.root as unknown as { size: { height: number } }).size.height,
      row1Y: cRow1.offset.y,
    },
    /**
     * True only when all three sides agree. A timing number from a run where
     * this is false is measuring two different workloads, so the summary must
     * refuse to quote it.
     */
    agree:
      vRow0.width === expectedRowW &&
      v.height === expectedRootH &&
      vRow1.y === CELL_H + GAP &&
      cRow0.size.width === expectedRowW &&
      (c.root as unknown as { size: { height: number } }).size.height === expectedRootH &&
      cRow1.offset.y === CELL_H + GAP,
  };
}

async function main() {
  const engineName = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const geometry = geometryCheck();
  await yieldToPaint();

  // Refuse to produce timings from a run where the two engines disagree on the
  // geometry: that would be timing two different workloads, and the number would
  // be quotable-looking nonsense. This is not belt-and-braces — the first draft
  // of this file DID disagree (canvas-ui root height 80 vs 104, because only the
  // horizontal gap was expressed), and a version without this gate would have
  // reported canvas-ui as faster for doing less work.
  const rows: unknown[] = [];
  if (geometry.agree) {
    for (const rowCount of [50, 200, 500]) {
      const build = buildPhase(rowCount);
      await yieldToPaint();
      const relayout = relayoutPhase(rowCount);
      await yieldToPaint();
      rows.push({
        rows: rowCount,
        cellsPerRow: CELLS_PER_ROW,
        build,
        relayout,
      });
    }
  }

  const payload = {
    name: 'layout-flex-canvas-ui',
    engine: engineName,
    userAgent: navigator.userAgent,
    versions: { canvasUiCore: '2.0.0', vectojsUi: '2.10.0' },
    note: 'canvas-ui RenderFlex is a large subset of flexbox backed by Yoga via yoga-layout-prebuilt-fork@1.10.6, which ships asm.js ("use asm", no .wasm file, no WebAssembly reference) rather than WebAssembly; VectoJS Stack is single-axis stacking in TypeScript. Stack is a SUBSET, and this drives only the workload both express natively. Gap model differs: canvas-ui uses per-child margin. Scope difference is not a defect on either side — see comparisons/README.md.',
    params: { TRIALS, WARMUPS, TARGET_MS, MAX_REPS, CELLS_PER_ROW, CELL_W, CELL_H, GAP },
    geometry,
    geometryAgrees: geometry.agree,
    // Every relayout row must have proved it actually reflowed. False here means
    // the canvas-ui relayout number is a no-op flush and must not be quoted.
    allReflowsVerified:
      rows.length > 0 &&
      rows.every((r) => (r as { relayout: { reflowVerified: boolean } }).relayout.reflowVerified),
    rows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* the page still shows the payload below */
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
