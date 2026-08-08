export interface IWebGLPointRenderer {
  resize(width: number, height: number): void;
}
export type WebGLPointRendererCreator = (canvas: HTMLCanvasElement) => any;

export interface IWebGPUParticleSystemManager {
  new (device: GPUDevice): any;
  initPipelines(format: GPUTextureFormat): Promise<void> | void;
  setupEntityResources(entity: any): void;
  recordComputePass(
    pass: GPUComputePassEncoder,
    entity: any,
    dt: number,
    mouseX: number,
    mouseY: number,
    width: number,
    height: number,
  ): void;
  recordRenderPass(renderPassEncoder: GPURenderPassEncoder, entity: any): void;
  destroy(): void;
}

import {
  Entity,
  VectoJSEvent,
  type AffineTransform,
  type Bounds,
  type ContentProjection,
  type ContentProjectionLine,
  type AnimatableProp,
} from './Entity';
import { SpringDriver, TweenDriver } from '@vectojs/animation';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { SVGRenderer } from '../renderer/SVGRenderer';
import { IRenderer, setRendererDevMode } from '../renderer/IRenderer';
import type { PointRenderer, WebGLDrawStats } from '../renderer/WebGLPointRenderer';
import { DOMPortalEntity } from './DOMPortalEntity';
import type { WebGPUParticleSystemManager } from '../renderer/WebGPUParticleSystemManager';
import { ComputeParticleEntity } from './ComputeParticleEntity';
import { buildTreeStore } from '../wasm/scene-store';
import type { TransformStore } from '../wasm/soa';
import { WASM_STATUS, type WasmModuleSource, type WasmTransformBackend } from '../wasm/backend';
import { gatherHitAABBs } from '../wasm/hit-store';
import { createHitGatherBuffer, gatherHitAABBsFromStore } from '../wasm/hit-store-fused';
import { type CoreModuleSource, type CoreWasmRuntime, loadCoreWasmRuntime } from '../wasm/runtime';
import {
  beginVectoUserTiming,
  endVectoUserTiming,
  measureVectoUserTiming,
  VECTO_USER_TIMING,
} from '../performance/UserTiming';
import { type HitModuleSource, type HitTestBackend } from '../wasm/hit-backend';
import { type AnimModuleSource, type AnimBackend } from '../wasm/anim-backend';
import { type ParticleModuleSource, type ParticleBackend } from '../wasm/particle-backend';
import { sanitizeUrl } from '../renderer/url';
import { clearCssLineBoxMetrics, cssLineBoxBaseline } from '@vectojs/text';
import type { PreparedContentGrid, PreparedContentGridLine } from '@vectojs/text';

/**
 * Roles for which `aria-valuenow` is valid. It is defined as a NUMBER on range
 * widgets only; setting it elsewhere is both a disallowed attribute and an
 * invalid value.
 */
const RANGE_VALUE_ROLES = new Set(['slider', 'spinbutton', 'progressbar', 'scrollbar', 'meter']);

const INTERACTIVE_A11Y_ROLES = new Set([
  'button',
  'switch',
  'checkbox',
  'radio',
  'link',
  'tab',
  'menuitem',
  'slider',
  'combobox',
]);

/**
 * Container roles whose children ARIA requires to be *DOM-contained*, mapped to
 * the child roles each one may own.
 *
 * The projection is otherwise flat — every mirror is a sibling under
 * `a11yRoot`, with reading order maintained by sorting (see
 * {@link Scene.sortNormalElementsVisually}). That is valid for most of ARIA,
 * which relates elements by IDREF (`aria-labelledby`, `aria-controls`,
 * `aria-activedescendant`), but a handful of composite widgets are specified in
 * terms of ownership: a `gridcell` is only a grid cell because a `row` contains
 * it. Flat, those widgets are structurally invalid no matter how correct their
 * individual attributes are, which is why `aria-required-children` and
 * `aria-required-parent` had to be disabled in the axe audit.
 *
 * Derived from axe-core 4.12.1's own `ariaRoles` table (`requiredOwned` /
 * `requiredContext`) rather than hand-written, so what we nest and what axe
 * checks cannot drift apart. Deliberately narrow — only the pairs ARIA
 * *requires*:
 *
 * - `radiogroup`/`radio` appears in **neither** axe table, so `RadioGroup`
 *   stays flat. Nesting it would be churn with no conformance gain.
 * - `treeitem` is not itself a container here: nested tree levels convey depth
 *   through `aria-level`, which is the flat pattern ARIA explicitly allows.
 * - Roles absent from a container's value set are **not** nested under it.
 *   axe's "unallowed children" branch runs *before* its empty-container
 *   review, so nesting a role the parent may not own converts a passing tree
 *   into a hard violation — strictly worse than leaving it flat.
 */
const A11Y_REQUIRED_OWNED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['grid', new Set(['row', 'rowgroup'])],
  ['table', new Set(['row', 'rowgroup'])],
  ['treegrid', new Set(['row', 'rowgroup'])],
  ['rowgroup', new Set(['row'])],
  ['row', new Set(['cell', 'columnheader', 'gridcell', 'rowheader'])],
  ['tablist', new Set(['tab'])],
  ['tree', new Set(['treeitem', 'group'])],
  ['group', new Set(['treeitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'])],
  ['menu', new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group', 'separator'])],
  ['menubar', new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group', 'separator'])],
  ['listbox', new Set(['option', 'group'])],
  ['list', new Set(['listitem'])],
]);

function isNativelyFocusable(element: HTMLElement): boolean {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLAnchorElement && element.hasAttribute('href'))
  );
}

/**
 * A nested mirror's box, expressed relative to its projected parent.
 *
 * Reused across calls rather than returned fresh: the geometry write runs for
 * every projected node on every synced frame, and a virtualized table can
 * nest several hundred cells, so a per-node literal here would allocate in the
 * frame loop. The single caller consumes the fields immediately.
 */
interface RebasedBox {
  left: number;
  top: number;
  matrix: string;
}

const REBASED_BOX: RebasedBox = { left: 0, top: 0, matrix: '' };

/**
 * The nearest ancestor mirror that nested descendants attach to, threaded down
 * the {@link Scene.syncA11y} walk.
 *
 * Carries the parent's world transform and origin as they were when the parent
 * was synced *on this same frame*, which is what {@link rebaseChildBox} needs.
 * Reading them again at the child would be equivalent today but would silently
 * break if a parent's geometry ever became lazier than its subtree's.
 */
interface A11yContainer {
  el: HTMLElement;
  /** The child roles this container may own, per {@link A11Y_REQUIRED_OWNED}. */
  owned: ReadonlySet<string>;
  transform: AffineTransform;
  originX: number;
  originY: number;
}

/**
 * Re-express a child's **world** transform as a box positioned inside its
 * projected parent's box.
 *
 * Mirrors are `position: absolute`, so their `left`/`top` resolve against the
 * nearest positioned ancestor. While the projection is flat that ancestor is
 * always `a11yRoot` and world coordinates are correct as-written. The moment a
 * mirror is nested inside another mirror, its containing block becomes the
 * parent — writing world coordinates then *double-offsets* every descendant,
 * and the parent's `matrix()` compounds on top. Measured in real Chrome and
 * Firefox: a row at world (110, 80) under a grid at (100, 50) landed at
 * (210, 130), and a cell at (120, 90) landed at (330, 220).
 *
 * The correction is not a plain subtraction. `left`/`top` are applied *before*
 * the ancestor's `transform`, so the offset has to be expressed in the parent's
 * pre-transform space: divide the world delta by the parent's linear part
 * rather than subtracting its translation. The linear part is likewise relative
 * — `inv(P) · C`, which collapses to the identity when the child adds no
 * rotation or scale of its own.
 *
 * Both engines reproduce the flat layout exactly under this transform,
 * including a parent rotated 30° and scaled 1.5×. That agreement depends on
 * `transformOrigin: '0 0'` (set on every mirror at creation); with the default
 * `50% 50%` each nested box rotates about its own centre and the results
 * diverge by tens of pixels.
 *
 * A singular parent matrix (zero width or height, or a collapsed scale) has no
 * inverse. Rather than emit `NaN` — which reads as `left: 0` and silently
 * relocates the element to the parent's origin, where the reading-order sort
 * would then treat it as the top-left-most element on screen — the child is
 * pinned to the parent's origin with an identity matrix. A zero-area parent is
 * already invisible, and `projectionBoxVisible` hides it on the same frame.
 */
function rebaseChildBox(
  parent: AffineTransform,
  parentOriginX: number,
  parentOriginY: number,
  child: AffineTransform,
  childOriginX: number,
  childOriginY: number,
): RebasedBox {
  const det = parent.a * parent.d - parent.b * parent.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    REBASED_BOX.left = 0;
    REBASED_BOX.top = 0;
    REBASED_BOX.matrix = 'matrix(1, 0, 0, 1, 0, 0)';
    return REBASED_BOX;
  }

  // inv(P) linear part
  const ia = parent.d / det;
  const ib = -parent.b / det;
  const ic = -parent.c / det;
  const id = parent.a / det;

  // World translation delta, mapped back through inv(P) so it is expressed in
  // the space `left`/`top` actually apply in. Each box's `a11yOffset` is part
  // of its origin, so it belongs inside the delta rather than being added
  // afterwards: added afterwards, the child's own offset would be scaled by the
  // parent's transform and the parent's would not be subtracted at all.
  const dx = childOriginX - parentOriginX;
  const dy = childOriginY - parentOriginY;
  REBASED_BOX.left = ia * dx + ic * dy;
  REBASED_BOX.top = ib * dx + id * dy;

  // inv(P) · C, i.e. the child's transform relative to the parent's.
  const a = ia * child.a + ic * child.b;
  const b = ib * child.a + id * child.b;
  const c = ia * child.c + ic * child.d;
  const d = ib * child.c + id * child.d;
  REBASED_BOX.matrix = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;

  return REBASED_BOX;
}

/**
 * A timed phase of a frame.
 *
 * `render` is the ENCLOSING phase — it contains `transform`, `drawWalk` and
 * `flush` — so it is reported without a share to avoid double-counting.
 * `a11ySync` and `a11yOrder` run after `render` in the frame loop, so they are
 * siblings of it, not children.
 */
export type RenderPhase =
  | 'render'
  | 'transform'
  | 'drawWalk'
  | 'flush'
  | 'a11ySync'
  /**
   * Time inside {@link Scene.syncContentGridProjection} materializing DOM
   * carriers, nested inside `a11ySync`.
   *
   * Split out because `a11ySync` for a streaming code block measured 1661-1875 ms
   * against a 210-671 ms render, and attributing that to grid materialization was
   * an assumption. Nothing should be optimised here on the strength of the parent
   * phase alone.
   */
  | 'gridMaterialize'
  /**
   * Whole of {@link Scene.syncContentProjection}, nested inside `a11ySync`.
   *
   * Measured at 99.8-99.9% of `a11ySync` for a streaming code block, so per-node
   * a11y attribute and geometry work is not where that phase's cost lives.
   */
  | 'contentProjection'
  /** Per-node a11y attribute/geometry work, excluding content projection and descendants. */
  | 'a11yNodes'
  /** Whole of `syncContentGridProjection`, of which `gridMaterialize` is one part. */
  | 'gridSync'
  /**
   * Synchronous part of `scheduleContentGridCalibration` — building the probe DOM.
   *
   * The measurement itself is deferred to a rAF, but the probe is constructed
   * here. Measured at 77-80% of `gridSync` on Chrome (3.7-4.5 ms per frame, i.e.
   * the entire 240Hz budget) against about 1 ms on Firefox, making it the largest
   * remaining cost of projecting a streaming code block once carrier reuse landed.
   */
  | 'gridCalibrateSchedule'
  /** The `querySelectorAll` + per-cell scan inside calibration scheduling. */
  | 'calibScan'
  /** Probe DOM construction and insertion inside calibration scheduling. */
  | 'calibProbeBuild'
  | 'a11yOrder'
  /** Sum of every entity's own render(), nested inside drawWalk. */
  | 'entityPaint';

export interface RenderPhaseEntry {
  phase: RenderPhase;
  totalMs: number;
  calls: number;
  avgMs: number;
  /** Worst single sample — a spiky phase is a different problem from a slow one. */
  maxMs: number;
  /** Percent of the measured total, or `null` for the enclosing `render` phase. */
  share: number | null;
}

/**
 * Who marked the scene dirty, and why.
 *
 * Every field is optional except `reason` so a call site can be as specific as it
 * cheaply can — an entity id costs nothing to pass, a property name is often
 * already in scope.
 */
export interface DirtySource {
  /** Entity id responsible, when one is. Omitted for scene-level invalidation. */
  entity?: string;
  /** Short, stable category — e.g. `'text-changed'`, `'animation'`, `'resize'`. */
  reason: string;
  /** Property that changed, when the reason alone is ambiguous. */
  property?: string;
}

/** An aggregated dirty attribution. */
export interface DirtyReasonEntry {
  entity?: string;
  reason: string;
  property?: string;
  /** How many times this exact attribution was recorded. */
  count: number;
  firstFrame: number;
  lastFrame: number;
}

/**
 * Options for {@link Scene}.
 */
export interface SceneOptions {
  /**
   * Backend for `getBatchCircle()` point-cloud entities:
   * - `'canvas'` (default): the Canvas2D order-preserving same-color batch.
   * - `'webgl'`: a stacked WebGL2 layer drawing all such circles in one draw
   *   call (10–100× throughput for 100k+). Auto-falls back to `'canvas'` when
   *   WebGL2 is unavailable. The GL layer composites above the 2D content, so its
   *   points don't interleave per-entity with 2D draws.
   */
  pointBackend?: 'canvas' | 'webgl';
  /**
   * Backend for particle simulation and rendering:
   * - `'auto'` (default): tries WebGPU first, falls back to CPU if WebGPU is unavailable or fails.
   * - `'webgpu'`: explicitly requests WebGPU; the current runtime still falls back to CPU if initialization fails.
   * - `'cpu'`: forces CPU simulation and rendering (disabling WebGPU completely).
   */
  particleBackend?: 'auto' | 'webgpu' | 'cpu';
  /**
   * Render the accessibility/automation shadow nodes with a visible blue dashed
   * outline (development aid). Default `false`: shadow nodes are transparent
   * (`opacity:0`) — still operable by Playwright/assistive tech, but the canvas
   * is the only thing seen.
   */
  debugA11y?: boolean;
  /**
   * Cap the render loop to at most this many frames per second (power saving —
   * e.g. a quieter fan in a library). `0` means uncapped (native refresh
   * rate). Defaults to `60` (`0` under test runners). Continuous animations
   * still run, just less often. Also settable later via {@link Scene.maxFPS}.
   */
  maxFPS?: number;
  /**
   * When `true` (default), a system **prefers-reduced-motion** setting auto-caps
   * the loop to {@link REDUCED_MOTION_FPS} (or the lower of that and `maxFPS`).
   * Set `false` to ignore the OS setting.
   */
  respectReducedMotion?: boolean;
  /**
   * Throttle the accessibility/automation shadow-DOM sync to at most once per this
   * many milliseconds. `0` (default) syncs every rendered frame. During heavy
   * animation, a small value (e.g. `100`) keeps the a11y layer eventually
   * consistent while sparing the per-frame DOM writes that can drag Canvas FPS.
   * Also settable later via {@link Scene.a11ySyncInterval}.
   */
  a11ySyncInterval?: number;
  /**
   * Custom renderer implementation (e.g., ThreeRenderer from @vectojs/three).
   * If provided, this renderer will be used for drawing rather than the default CanvasRenderer.
   */
  renderer?: IRenderer;
  /**
   * Disable the automatic registration of window resize listener.
   * Useful when Vecto is running inside a custom layout container or offscreen canvas.
   */
  disableWindowResize?: boolean;
  /**
   * Cap the effective device pixel ratio used to size the Canvas2D and WebGL
   * point-layer backing stores. `undefined` (default) reads the real,
   * uncapped `window.devicePixelRatio` — unchanged from prior versions.
   * Backing-store render cost scales with `logical size × dpr²`, so a
   * full-screen HiDPI scene (`pointBackend: 'webgl'` in particular) can
   * overrun its frame budget on a DPR-3 display while running fine on the
   * DPR-1 dev machine it was tuned on (findings.md, 2026-07-16). `maxDPR: 2`
   * keeps the display retina-crisp (2x already exceeds what most eyes
   * resolve) while roughly halving the backing-store pixel count at DPR 3.
   * Applied at construction and re-applied on every {@link resize} call
   * (including the automatic window-resize listener), since the real DPR
   * can change at runtime (a window dragged between displays).
   */
  maxDPR?: number;
  /**
   * Enable automatic throttling to 2 FPS when the scene is static (no active transitions
   * and not marked dirty) to save power/CPU. Default is `true`.
   */
  autoThrottle?: boolean;
  /**
   * Emit User Timing marks and measures for render phases. Default `false`.
   * Intended for short profiler captures; enable only while collecting one.
   */
  userTiming?: boolean;
  /**
   * Mirror static text from entities implementing
   * {@link Entity.getContentProjection} as transparent, position-synced DOM
   * nodes, so find-in-page, screen readers, crawlers, and translation work on
   * canvas-rendered text. Default is `true`; disable for purely decorative
   * scenes to skip the sync walk.
   */
  contentProjection?: boolean;
  /**
   * How far outside the viewport (in CSS px, each side) content projections are
   * materialized as DOM. Projections whose box is farther than this are not
   * created — and are removed when they scroll past it — so a document taller
   * than the viewport keeps only a bounded, near-viewport set of DOM nodes
   * instead of one element (plus a `<span>` per line) per block for the whole
   * document. A larger margin keeps more off-screen text ready for native
   * find-in-page / selection at the cost of more DOM; `Infinity` restores the
   * legacy "materialize the entire document" behavior. Default: one viewport
   * height (`undefined` → resolved to `Scene.height` at sync time).
   */
  contentProjectionMargin?: number;
  /**
   * Virtualization margin (px) for the *semantic* tier of content projection —
   * whether a block has **any** projected DOM at all, as opposed to
   * {@link SceneOptions.contentProjectionMargin}, which decides whether that
   * block's per-line **carriers** are windowed.
   *
   * Splitting the two makes a coarse resident tier expressible: with
   * `contentSemanticMargin: Infinity` and a finite `contentProjectionMargin`,
   * every block in the document keeps an element holding its full text — so
   * find-in-page and screen-reader read-ahead see the whole document — while
   * only blocks near the viewport pay for per-line carriers. One scalar could
   * not express that, because a finite value freed off-band blocks entirely and
   * `Infinity` also unwindowed every carrier, which is O(total document glyphs).
   *
   * `Infinity` is safe **here** and remains unsupported for
   * `contentProjectionMargin`: the cost that made it unsupported comes from an
   * unwindowed carrier band, not from resident text.
   *
   * Note the one-time cost. A resident tier materializes one element per block
   * on the first sync — measured unbudgeted at 21.3ms for 1000 blocks and 139.5ms
   * for 10000 on Chrome — as one synchronous block. Steady state is cheap
   * (unchanged blocks skip via {@link Entity.getContentEpoch}), so this is a
   * document-open stall, not a per-frame cost. That stall is what
   * {@link SceneOptions.contentSemanticBudget} spreads across frames.
   *
   * Default: whatever `contentProjectionMargin` resolves to, so omitting this
   * leaves behaviour unchanged.
   */
  contentSemanticMargin?: number;
  /**
   * How many resident (coarse-tier) blocks may be materialized in **one** sync,
   * bounding the document-open stall a wide {@link
   * SceneOptions.contentSemanticMargin} otherwise pays all at once.
   *
   * The cost of a resident tier is per node **created**, not per node held: 10000
   * resident blocks cost ~3.0 ms/sync at steady state, while creating them costs
   * ~0.03 ms each plus a per-pass floor that grows with how many are already
   * resident. So the front-load is a *scheduling* problem, and this is the
   * schedule — remaining blocks materialize on subsequent syncs, a few per frame,
   * until the document is fully resident.
   *
   * What it does **not** change is the end state: the same blocks end up with the
   * same DOM, only later. Nothing is dropped, so the reachability the semantic
   * tier exists for is preserved; a block still waiting is simply not yet in the
   * DOM, exactly as a block beyond the margin is not.
   *
   * Applies **only** to the coarse tier. A block inside the interaction margin is
   * on screen and materializes immediately regardless of this budget — deferring
   * visible text would make it briefly unselectable, which is a user-visible
   * regression rather than a cost saving.
   *
   * `Infinity` disables the budget and restores one synchronous pass. Default:
   * {@link DEFAULT_CONTENT_SEMANTIC_BUDGET}. Because the coarse tier exists only
   * when `contentSemanticMargin` is wider than `contentProjectionMargin`, a scene
   * that does not opt into a resident tier has no coarse blocks and is therefore
   * unaffected by any value here.
   */
  contentSemanticBudget?: number;
  /**
   * Reading direction used to order the accessibility/automation shadow tree so
   * keyboard **tab order** and screen-reader traversal follow the *visual*
   * reading order (top-to-bottom, then inline) rather than scene-graph
   * insertion order — two entities added in any order but drawn left/right of
   * each other should Tab left→right (`'ltr'`, default) or right→left
   * (`'rtl'`). Also settable later via {@link Scene.readingDirection}.
   */
  readingDirection?: 'ltr' | 'rtl';
  /**
   * When to repaint:
   * - `'always'` (default): drive a continuous rAF loop, throttling to 2 FPS
   *   while the scene is idle if {@link SceneOptions.autoThrottle} is on.
   * - `'onDemand'`: paint only after {@link Scene.markDirty} (or an active
   *   transition), so a genuinely static scene costs zero frames.
   *
   * Also settable later via {@link Scene.renderMode}. Prefer this option when
   * the mode is known at construction: it applies before the first frame, so an
   * `onDemand` scene never pays for the initial always-on frames.
   */
  renderMode?: 'always' | 'onDemand';
}

/**
 * Every recognized {@link SceneOptions} key, used only to warn about unknown
 * ones in dev mode.
 *
 * This exists because `SceneOptions` is structural: passing a key it does not
 * declare is a **silent** no-op, and TypeScript only catches it when the object
 * is written inline at the call site. Code that builds options dynamically, or
 * plain untranspiled JS, gets no diagnostic at all. `renderMode` was a public
 * field with no matching option for several releases, and four `@vectojs` demos
 * shipped `new Scene(canvas, { renderMode: 'onDemand' })` — reading correctly,
 * doing nothing, and sitting on the 2 FPS idle floor.
 *
 * Kept as a literal rather than derived from a type: `keyof SceneOptions` does
 * not survive to runtime, so this list is the only form a constructor can check
 * against. A new option must be added here too — the test suite asserts the two
 * stay in sync.
 */
export const SCENE_OPTION_KEYS = [
  'a11ySyncInterval',
  'autoThrottle',
  'contentProjection',
  'contentProjectionMargin',
  'contentSemanticBudget',
  'contentSemanticMargin',
  'debugA11y',
  'disableWindowResize',
  'maxDPR',
  'maxFPS',
  'particleBackend',
  'pointBackend',
  'readingDirection',
  'renderer',
  'renderMode',
  'respectReducedMotion',
  'userTiming',
] as const;

/**
 * Public `Scene` fields that are commonly mistaken for constructor options, and
 * the message to show instead of a generic "unknown key". A near-miss
 * suggestion is what makes the warning actionable; naming the assignment form
 * is what makes it fixable.
 */
const SCENE_FIELD_NOT_OPTION: Record<string, string> = {
  devMode: 'set the static `Scene.devMode = true` before constructing',
};

/** Levenshtein distance, bounded — only used for dev-mode key suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = Array.from<number>({ length: n + 1 });
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr.slice();
  }
  return prev[n]!;
}

/**
 * The closest recognized option key to `key`, or `undefined` when nothing is
 * near enough to be worth suggesting. The threshold scales with length so short
 * keys don't match everything.
 */
function closestOptionKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of SCENE_OPTION_KEYS) {
    // Case-only differences are the most common mistake and should always win.
    if (candidate.toLowerCase() === lower) return candidate;
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  const limit = Math.max(2, Math.floor(key.length / 3));
  return bestScore <= limit ? best : undefined;
}

/** Frame-rate the loop is capped to when the OS requests reduced motion. */
export const REDUCED_MOTION_FPS = 30;

/**
 * Why an accelerator did or did not run on the most recent frame.
 *
 * `'active'` is the only value that means the accelerator ran. Everything else
 * is a distinct decline, kept separate because they call for different actions:
 * `'not-installed'` means enable it, `'below-gate'` means the workload is too
 * small to be worth it (working as designed), and `'rejected'` means the kernel
 * refused its arguments — a fault worth reporting, not a tuning outcome.
 */
export type AcceleratorReason =
  /** Ran on this frame. */
  | 'active'
  /** No backend installed; the JS path is the permanent fallback. */
  | 'not-installed'
  /** Installed, but the per-frame gate chose JS (workload below threshold). */
  | 'below-gate'
  /** Installed and gated in, but the kernel rejected the call and wrote nothing. */
  | 'rejected'
  /** Not applicable to this pass (e.g. a non-main renderer, or nothing to do). */
  | 'not-applicable';

/**
 * One accelerator's per-frame status, read from {@link Scene.accelerators}.
 *
 * The pair exists because `available` and `activeThisFrame` genuinely differ:
 * before this shape, `transformBackend`/`animBackend` reported only that a
 * backend was *installed*, which invites concluding an accelerator is doing work
 * when its gate never opens. Read `activeThisFrame` for what actually happened
 * and `reason` for why.
 */
export interface AcceleratorStatus {
  /** A backend is installed and could run, gate permitting. */
  available: boolean;
  /** It ran on the most recent frame. */
  activeThisFrame: boolean;
  /** Why it did or did not run. */
  reason: AcceleratorReason;
  /** Which implementation actually did the work on the most recent frame. */
  path: string;
}

/**
 * Per-frame status of every invisible accelerator, read from
 * {@link Scene.accelerators}. Each is independent: a scene can compose
 * transforms in WASM while ticking drivers in JS.
 */
export interface AcceleratorReport {
  /** World-matrix composition (`compose_simd`). */
  transform: AcceleratorStatus;
  /** Batched property drivers (`spring_step`/`tween_step`). */
  animation: AcceleratorStatus;
  /** Hit-test broad phase (`hit_build`/`hit_query`) and its gather source. */
  hitTest: AcceleratorStatus;
  /** Particle simulation — WebGPU compute, the WASM CPU kernel, or JS. */
  particle: AcceleratorStatus;
}

/**
 * Live render-loop telemetry, read from {@link Scene.frameStats}. See that
 * getter for how each field is measured.
 */
export interface FrameStats {
  /** Rendered-frame cadence (Hz), clamped to `maxFPS`. `0` before the first pair of rendered frames. */
  fps: number;
  /** Wall-clock ms of the last `render()` pass (excludes a11y/content sync). */
  frameTimeMs: number;
  /** Smoothed interval between rendered frames, in ms (EMA). */
  frameIntervalMs: number;
  /** dt (ms) handed to the last rendered frame. */
  dt: number;
  /** Total frames rendered since `start()`. */
  renderedFrames: number;
  /** Total rAF ticks skipped (idle/onDemand/capped) since `start()`. */
  skippedFrames: number;
  /** The scene's current render mode. */
  renderMode: 'always' | 'onDemand';
  /** Whether a redraw is currently pending (the boolean dirty flag). */
  dirty: boolean;
}

export interface A11yTreeNode {
  id: string;
  tag: string;
  role?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
  valuemin?: string;
  valuemax?: string;
  children: A11yTreeNode[];
}

/**
 * Parse an inline `"<n>px"` style value into a positive number, or `null` for
 * anything else (empty, percentages, calc(), zero).
 */
function parseInlinePx(value: string | undefined): number | null {
  if (!value || !value.endsWith('px')) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Default {@link SceneOptions.contentSemanticBudget}: resident blocks
 * materialized per sync.
 *
 * Sized against the two costs a pass actually pays, both measured in real headed
 * Chrome on a 240Hz panel. Per created block is cheap and flat (~0.03ms). What
 * dominates is style+layout of the projection subtree, which scales with how many
 * blocks are already RESIDENT and is paid once per pass: traced at 10000 blocks,
 * `UpdateLayoutTree` 391.7ms + `Layout` 305.8ms over 40 passes (~17ms each), with
 * per-pass cost roughly doubling from the first pass to the last while the number
 * created stayed constant.
 *
 * So total drain cost is approximately `passes × f(resident)`, and a SMALLER
 * budget multiplies the term that does not shrink. Measured to completion, 3
 * repeats, medians:
 *
 * ```text
 *  1000 blocks   budget  32 →   67.1ms total,  4.3ms worst pass
 *                budget  64 →   54.0ms total,  5.1ms worst pass
 *                budget 256 →   27.7ms total,  7.7ms worst pass
 *                Infinity   →   24.1ms total, 23.6ms worst pass
 * 10000 blocks   budget  32 → 3773.2ms total, 42.6ms worst pass
 *                budget  64 → 1896.2ms total, 41.6ms worst pass
 *                budget 256 →  648.1ms total, 35.2ms worst pass
 *                Infinity   →  319.4ms total, 307.3ms worst pass
 * ```
 *
 * 256 is where the two goals stop trading against each other. Below it there is no
 * frame-bound improvement at 10000 blocks — every budget lands at 35-43ms, because
 * the worst pass is the LAST one laying out the complete subtree — while total time
 * rises 6x. At 1000 blocks it still holds 7.7ms, inside a 60Hz frame, for less than
 * half the total time of 64.
 *
 * This replaces an earlier default of 64, which was sized against a per-block cost
 * of ~0.4ms. That figure was inflated by a forced layout per materialized block
 * (see `contentSelectionPresentThisSync`); with that removed, 64 spends 6x the
 * total time for no frame-bound gain.
 */
export const DEFAULT_CONTENT_SEMANTIC_BUDGET = 256;

/**
 * Which tier of content projection a block gets.
 *
 * `fine` is the historical behavior: an element plus a carrier per visual line
 * (or per glyph cluster, for a grid), windowed to the interaction band. `coarse`
 * is text-only — one text node holding the block's whole string, no carriers —
 * for a block that is resident under the semantic margin but outside the
 * interaction margin. Coarse text still serves find-in-page, copy and
 * screen-reader read-ahead; only per-line selection geometry needs carriers, and
 * that is unreachable without scrolling the block into the band anyway.
 */
type ContentSyncTier = 'fine' | 'coarse';

/** Half-open range of projected line indices to materialize. */
interface ProjectionLineWindow {
  start: number;
  /** Exclusive. */
  end: number;
  /** False when the whole document is being projected. */
  gated: boolean;
}

/**
 * {@link projectionLineWindow} for a prepared grid.
 *
 * A grid line's y comes from the parallel `projection.lines` entry when present
 * and otherwise from `lineIndex * grid.lineHeight`, which is the same fallback
 * the materialization loop uses for positioning — so the window and the carriers
 * always agree on where a line is.
 */
function projectionGridLineWindow(
  grid: PreparedContentGrid,
  projectionLines: ContentProjection['lines'],
  band: { minY: number; maxY: number } | null,
): ProjectionLineWindow {
  const count = grid.lines.length;
  const all: ProjectionLineWindow = { start: 0, end: count, gated: false };
  if (!band || count === 0) return all;
  const lines: Array<{ y: number; lineHeight?: number }> = [];
  for (let i = 0; i < count; i++) {
    const projected = projectionLines?.[i];
    lines.push({
      y: projected?.y ?? i * grid.lineHeight,
      lineHeight: projected?.lineHeight ?? grid.lineHeight,
    });
  }
  return projectionLineWindow(lines, band, grid.lineHeight);
}

/**
 * Everything a completed content-projection sync depended on.
 *
 * Compared field-by-field against the next sync's inputs to decide whether the
 * existing DOM is already correct. Deliberately holds the *results* of the two
 * O(ancestor-depth) geometry queries (`hasBand`/`bandMin`/`bandMax`, `visible`)
 * rather than the inputs they derive from: an ancestor resizing or toggling
 * `clipChildren` changes both without changing this entity's own world
 * transform, so keying on the inputs would skip a sync that genuinely needed to
 * run.
 *
 * A single mutable object is reused per entity, so a steady state allocates
 * nothing. (carryctx CTX-0199)
 */
interface ContentSyncState {
  epoch: number;
  /**
   * Scene's font/metric epoch at the time of the sync.
   *
   * Not redundant with the geometry fields: a webfont finishing load or a
   * browser zoom bumps it without moving the entity, and the grid calibration
   * key is built from it, so a skip that ignored it would leave grid carriers
   * measured against the old metrics with nothing to trigger a re-measure. It
   * also subsumes page scale, since `getContentMetricScaleX` is itself memoized
   * against this epoch.
   */
  fontEpoch: number;
  /**
   * Scene's viewport epoch at the time of the sync.
   *
   * Needed only by the settled-walk fast path, whose two transforms are both
   * viewport-independent: a resize re-tiers blocks without moving any of them, so
   * without this a resized scene would keep DOM built for the old viewport.
   */
  viewportEpoch: number;
  /** World transform, flattened — a moved or scaled entity must re-place its DOM. */
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /**
   * Which projection tier the DOM was built for.
   *
   * Not derivable from `hasBand`: the coarse tier has no band, but so does an
   * in-band ROTATED entity (a y band is meaningless once local x mixes into
   * world y), and those two want opposite DOM — one plain text node versus every
   * line's carrier. Recorded explicitly so a scene resize that re-tiers a block
   * without moving it still invalidates, which is otherwise invisible to every
   * other field here.
   */
  tier: ContentSyncTier;
  /** `false` when the line band was null, in which case the bounds are meaningless. */
  hasBand: boolean;
  bandMin: number;
  bandMax: number;
  /** Result of the exact (margin 0) visibility test, which drives `display`. */
  visible: boolean;
  /** Written to `el.style.width`/`height` from the node, not from the projection. */
  width: number;
  height: number;
  /** Drives `aria-hidden` on the text copy. */
  interactive: boolean;
  /**
   * This entity's own LOCAL transform, plus its parent's WORLD transform, as of
   * the last sync. Together these are what let a settled walk skip a block
   * *before* composing its world transform or running any box test.
   *
   * The world transform is the parent's world matrix composed with this
   * entity's local one (`Entity.getWorldTransform`), so if both inputs are
   * unchanged the world matrix is unchanged **by construction** — and then so
   * are the tier, the line band and the exact visibility flag, every one of
   * which is derived from it. That is what makes the box tests provably
   * redundant on an unchanged block rather than merely usually redundant.
   *
   * Recorded in addition to, not instead of, the flattened world matrix above:
   * the world fields remain the authority whenever this cheap check does not
   * hold, and are what a rotated or reparented entity is still compared on.
   *
   * `pa`…`pf` are the identity when the entity has no parent.
   */
  lx: number;
  ly: number;
  lScaleX: number;
  lScaleY: number;
  lRotation: number;
  pa: number;
  pb: number;
  pc: number;
  pd: number;
  pe: number;
  pf: number;
}

/**
 * The contiguous run of lines overlapping `band`, in entity-local y.
 *
 * **Contiguous on purpose.** A gap would break selection: the DOM order of
 * carriers is what the browser walks when extending a selection or serialising
 * a copy, so materializing lines 0-9 and 90-99 with nothing between them would
 * let a drag from line 5 to line 95 silently splice out 80 lines of text. A
 * single window can only lose text at its *edges*, where the user cannot reach
 * without scrolling, and scrolling rebuilds the window.
 *
 * Falls back to the whole document whenever the answer is not clearly better:
 * a null band, a document that fits, or a window that would cover everything
 * anyway. Emitting nothing is never correct — projected text is what serves
 * find-in-page, copy and, for static text, the screen reader.
 */
function projectionLineWindow(
  lines: ReadonlyArray<{ y: number; lineHeight?: number }>,
  band: { minY: number; maxY: number } | null,
  fallbackLineHeight: number,
): ProjectionLineWindow {
  const all: ProjectionLineWindow = {
    start: 0,
    end: lines.length,
    gated: false,
  };
  if (!band || lines.length === 0) return all;

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.lineHeight ?? fallbackLineHeight;
    // A line counts as visible when its box overlaps the band at all, so a line
    // straddling the edge is kept rather than clipped mid-glyph.
    if (line.y + h >= band.minY && line.y <= band.maxY) {
      if (start === -1) start = i;
      end = i + 1;
    } else if (start !== -1 && line.y > band.maxY) {
      // Lines are emitted in document order, so once past the band we are done.
      // Guard on `start` first: a document whose first line is already past the
      // band must keep scanning, not stop at index 0.
      break;
    }
  }

  if (start === -1) {
    // Nothing overlapped. Rather than project nothing, keep the single nearest
    // line so the entity still has a non-empty projection and the text stays
    // reachable.
    //
    // This is now only reachable for an entity the caller has already decided is
    // in the interaction band — a partially-overlapping box whose own lines all
    // miss the band. A FULLY off-band entity does not arrive here at all: it is
    // either released by the semantic gate or routed to the coarse plain-text
    // tier, which is why this fallback no longer needs to be the thing that keeps
    // its text reachable. Before the semantic/interaction split it was, because a
    // surviving entity was by definition in the one band there was.
    return { start: 0, end: Math.min(1, lines.length), gated: true };
  }
  if (start === 0 && end === lines.length) return all;
  return { start, end, gated: true };
}

/** A concrete text caret position, usable as a Selection anchor or focus. */
interface TextCaretPosition {
  node: Text;
  offset: number;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Bounding rect of a text node's full contents (null when it has no boxes). */
const caretGraphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
const caretWordSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

function graphemeBoundaries(text: string): number[] {
  if (!caretGraphemeSegmenter) {
    const boundaries = [0];
    for (let offset = 0; offset < text.length;) {
      const codePoint = text.codePointAt(offset) ?? 0;
      offset += codePoint > 0xffff ? 2 : 1;
      boundaries.push(offset);
    }
    return boundaries;
  }
  const boundaries = [0];
  for (const segment of caretGraphemeSegmenter.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (end > boundaries[boundaries.length - 1]) boundaries.push(end);
  }
  return boundaries;
}

function distanceToRectSquared(rect: DOMRect, x: number, y: number): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

/** Grapheme-safe offset whose transformed native caret is nearest to a viewport point. */
function nearestOffsetForPoint(
  node: Text,
  x: number,
  y: number,
): {
  offset: number;
  distance: number;
} {
  const boundaries = graphemeBoundaries(node.data);
  const range = document.createRange();
  let nearest = { offset: boundaries[0] ?? 0, distance: Infinity };
  for (const offset of boundaries) {
    range.setStart(node, offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    const distance = distanceToRectSquared(rect, x, y);
    if (distance < nearest.distance) nearest = { offset, distance };
  }
  return nearest;
}

function gridCellCaret(cell: HTMLElement, localX: number): TextCaretPosition | null {
  const node = cell.firstChild;
  if (!(node instanceof Text)) return null;
  const sourceLength = Number(cell.dataset.vectoGridSourceLength ?? node.data.length);
  const level = Number(cell.dataset.vectoGridLevel ?? 0);
  const cellX = Number(cell.dataset.vectoGridX ?? 0);
  const advance = Number(cell.dataset.vectoGridAdvance ?? 0);
  const caretOffsets = (cell.dataset.vectoGridCaretOffsets ?? `0,${sourceLength}`)
    .split(',')
    .map(Number)
    .filter((offset) => Number.isInteger(offset) && offset >= 0 && offset <= sourceLength);
  const visuallyRtl = (level & 1) !== 0;
  const visualFraction = advance > 0 ? Math.max(0, Math.min(1, (localX - cellX) / advance)) : 0;
  const sourceFraction = visuallyRtl ? 1 - visualFraction : visualFraction;
  const caretIndex = Math.round(sourceFraction * Math.max(0, caretOffsets.length - 1));
  return {
    node,
    offset: caretOffsets[caretIndex] ?? 0,
  };
}

function nearestGridPositionInLine(line: HTMLElement, localX: number): TextCaretPosition | null {
  let nearest: { cell: HTMLElement; distance: number } | null = null;
  for (const cell of line.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')) {
    const x = Number(cell.dataset.vectoGridX ?? 0);
    const advance = Number(cell.dataset.vectoGridAdvance ?? 0);
    if (localX >= x && localX <= x + advance) return gridCellCaret(cell, localX);
    const distance = localX < x ? x - localX : localX - (x + advance);
    if (!nearest || distance < nearest.distance) nearest = { cell, distance };
  }
  if (!nearest) return null;
  return gridCellCaret(nearest.cell, localX);
}

function parseCssMatrix(transform: string): [number, number, number, number] {
  if (!transform || transform === 'none') return [1, 0, 0, 1];
  const values = transform
    .slice(transform.indexOf('(') + 1, transform.lastIndexOf(')'))
    .split(',')
    .map(Number);
  return values.length >= 4 && values.slice(0, 4).every(Number.isFinite)
    ? [values[0], values[1], values[2], values[3]]
    : [1, 0, 0, 1];
}

function clientToGridLocal(
  contentEl: HTMLElement,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const line = contentEl.querySelector<HTMLElement>('[data-vecto-grid-line]');
  const originMarker = line?.querySelector<HTMLElement>('[data-vecto-grid-basis="origin"]');
  const xMarker = line?.querySelector<HTMLElement>('[data-vecto-grid-basis="x"]');
  const yMarker = line?.querySelector<HTMLElement>('[data-vecto-grid-basis="y"]');
  if (line && originMarker && xMarker && yMarker) {
    const origin = originMarker.getBoundingClientRect();
    const xPoint = xMarker.getBoundingClientRect();
    const yPoint = yMarker.getBoundingClientRect();
    const xx = xPoint.left - origin.left;
    const xy = xPoint.top - origin.top;
    const yx = yPoint.left - origin.left;
    const yy = yPoint.top - origin.top;
    const determinant = xx * yy - xy * yx;
    if (Number.isFinite(determinant) && Math.abs(determinant) > 1e-9) {
      const dx = clientX - origin.left;
      const dy = clientY - origin.top;
      return {
        x: (Number.parseFloat(line.style.left) || 0) + (yy * dx - yx * dy) / determinant,
        y: (Number.parseFloat(line.style.top) || 0) + (-xy * dx + xx * dy) / determinant,
      };
    }
  }
  const [a, b, c, d] = parseCssMatrix(getComputedStyle(contentEl).transform);
  const canvasRect = canvas.getBoundingClientRect();
  const logicalWidth = Number.parseFloat(canvas.style.width) || canvas.clientWidth || canvas.width;
  const logicalHeight =
    Number.parseFloat(canvas.style.height) || canvas.clientHeight || canvas.height;
  const scaleX = logicalWidth > 0 ? canvasRect.width / logicalWidth : 1;
  const scaleY = logicalHeight > 0 ? canvasRect.height / logicalHeight : 1;
  const worldX = (clientX - canvasRect.left) / scaleX;
  const worldY = (clientY - canvasRect.top) / scaleY;
  const dx = worldX - (Number.parseFloat(contentEl.style.left) || 0);
  const dy = worldY - (Number.parseFloat(contentEl.style.top) || 0);
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-9) return null;
  return {
    x: (d * dx - c * dy) / determinant,
    y: (-b * dx + a * dy) / determinant,
  };
}

function nearestGridPosition(
  contentEl: HTMLElement,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): TextCaretPosition | null {
  const lines = [...contentEl.querySelectorAll<HTMLElement>('[data-vecto-grid-line]')];
  if (lines.length === 0) return null;
  const [a, b, c, d] = parseCssMatrix(getComputedStyle(contentEl).transform);
  if (a > 0 && d > 0 && Math.abs(b) <= 1e-9 && Math.abs(c) <= 1e-9) {
    let nearest: { line: HTMLElement; distance: number; rect: DOMRect } | null = null;
    for (const line of lines) {
      const rect = line.getBoundingClientRect();
      const dy =
        clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const dx =
        clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const distance = dy * 4096 + dx;
      if (!nearest || distance < nearest.distance) nearest = { line, distance, rect };
    }
    if (!nearest) return null;
    const localWidth = Number.parseFloat(nearest.line.style.width) || 0;
    const scaleX = localWidth > 0 && nearest.rect.width > 0 ? nearest.rect.width / localWidth : 1;
    const localX = (clientX - nearest.rect.left) / scaleX;
    return nearestGridPositionInLine(nearest.line, localX);
  }
  const local = clientToGridLocal(contentEl, canvas, clientX, clientY);
  if (!local) return null;
  let nearest: { line: HTMLElement; distance: number } | null = null;
  for (const line of lines) {
    const left = Number.parseFloat(line.style.left) || 0;
    const top = Number.parseFloat(line.style.top) || 0;
    const width = Number.parseFloat(line.style.width) || 0;
    const height = Number.parseFloat(line.style.height) || 0;
    const dy = local.y < top ? top - local.y : local.y > top + height ? local.y - top - height : 0;
    const dx =
      local.x < left ? left - local.x : local.x > left + width ? local.x - left - width : 0;
    const distance = dy * 4096 + dx;
    if (!nearest || distance < nearest.distance) nearest = { line, distance };
  }
  if (!nearest) return null;
  const lineLeft = Number.parseFloat(nearest.line.style.left) || 0;
  return nearestGridPositionInLine(nearest.line, local.x - lineLeft);
}

/**
 * Nearest text position inside one projected visual line for viewport `x`:
 * before the first character, at the caret under `x`, or at the end of the
 * visible text (excluding the trailing hard-break separator so a horizontal
 * drag through padding doesn't silently select a newline).
 */
function nearestTextPositionInLine(
  line: HTMLElement,
  x: number,
  y: number,
): TextCaretPosition | null {
  const texts = collectTextNodes(line);
  if (texts.length === 0) return null;
  let nearest: { position: TextCaretPosition; distance: number } | null = null;
  for (const node of texts) {
    const candidate = nearestOffsetForPoint(node, x, y);
    if (!nearest || candidate.distance < nearest.distance) {
      let { offset } = candidate;
      while (offset > 0 && node.data[offset - 1] === '\n') offset--;
      nearest = { position: { node, offset }, distance: candidate.distance };
    }
  }
  return nearest?.position ?? null;
}

/**
 * Resolve the text position nearest to viewport `(x, y)` inside a content
 * projection whose line boxes are absolutely positioned (out of flow — the
 * browser itself cannot anchor a selection in the container's blank space).
 * Picks the vertically nearest line, then the caret nearest to `x` within it.
 */
function nearestTextPositionInProjection(
  contentEl: HTMLElement,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  eventTarget?: HTMLElement | null,
): TextCaretPosition | null {
  if (contentEl.dataset.vectoContentGrid !== undefined) {
    return nearestGridPosition(contentEl, canvas, x, y);
  }
  let targetLine = eventTarget;
  while (targetLine && targetLine.parentElement !== contentEl) {
    if (!contentEl.contains(targetLine)) {
      targetLine = null;
      break;
    }
    targetLine = targetLine.parentElement;
  }
  if (targetLine?.parentElement === contentEl) {
    return nearestTextPositionInLine(targetLine, x, y);
  }
  let bestLine: HTMLElement | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < contentEl.children.length; i++) {
    const child = contentEl.children[i] as HTMLElement;
    const rect = child.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    // The vertically nearest line wins; x only breaks ties within a band.
    const dist = dy * 4096 + dx;
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = child;
    }
  }
  if (bestLine) return nearestTextPositionInLine(bestLine, x, y);
  // Projection with a single flowed text node (no per-line children).
  return nearestTextPositionInLine(contentEl, x, y);
}

function projectionAbsoluteOffset(root: HTMLElement, caret: TextCaretPosition): number | null {
  let offset = 0;
  for (const node of collectTextNodes(root)) {
    if (node === caret.node) return offset + Math.min(caret.offset, node.data.length);
    offset += node.data.length;
  }
  return null;
}

function projectionCaretAt(
  root: HTMLElement,
  absoluteOffset: number,
  affinity: 'forward' | 'backward',
): TextCaretPosition | null {
  const nodes = collectTextNodes(root);
  if (nodes.length === 0) return null;
  let remaining = Math.max(0, absoluteOffset);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (
      remaining < node.data.length ||
      (remaining === node.data.length && affinity === 'backward')
    ) {
      return { node, offset: remaining };
    }
    if (remaining === node.data.length && index === nodes.length - 1) {
      return { node, offset: remaining };
    }
    remaining -= node.data.length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}

function selectProjectionUnit(
  selection: Selection,
  root: HTMLElement,
  caret: TextCaretPosition,
  unit: 'word' | 'line',
): boolean {
  const absoluteOffset = projectionAbsoluteOffset(root, caret);
  const text = root.textContent ?? '';
  if (absoluteOffset === null || text.length === 0) return false;
  let start = absoluteOffset;
  let end = absoluteOffset;
  if (unit === 'line') {
    for (let index = Math.max(0, absoluteOffset - 1); index >= 0; index--) {
      if (text[index] === '\n' || text[index] === '\r') {
        start = index + 1;
        if (text[index] === '\r' && text[index + 1] === '\n') start++;
        break;
      }
    }
    const cr = text.indexOf('\r', absoluteOffset);
    const lf = text.indexOf('\n', absoluteOffset);
    const separator = [cr, lf].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    end = separator === undefined ? text.length : separator;
  } else if (caretWordSegmenter) {
    const segments = [...caretWordSegmenter.segment(text)];
    const selected =
      segments.find(
        (segment) =>
          segment.isWordLike &&
          absoluteOffset >= segment.index &&
          absoluteOffset <= segment.index + segment.segment.length,
      ) ??
      segments.find((segment) => segment.isWordLike && segment.index >= absoluteOffset) ??
      [...segments].reverse().find((segment) => segment.isWordLike);
    if (selected) {
      start = selected.index;
      end = selected.index + selected.segment.length;
    }
  } else {
    const isWord = (character: string) => /[\p{L}\p{N}_]/u.test(character);
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length && isWord(text[end])) end++;
  }
  const anchor = projectionCaretAt(root, start, 'forward');
  const focus = projectionCaretAt(root, end, 'backward');
  if (!anchor || !focus) return false;
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  return true;
}

function extendSelection(
  selection: Selection,
  anchor: TextCaretPosition,
  focus: TextCaretPosition,
) {
  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return;
  } catch {
    // Some older engines reject a reverse cross-node base/extent. Preserve the
    // direction through collapse/extend before the final normalized fallback.
  }
  try {
    selection.collapse(anchor.node, anchor.offset);
    selection.extend(focus.node, focus.offset);
    return;
  } catch {
    // The final fallback keeps source fidelity on engines without direction APIs.
  }
  const anchorRange = document.createRange();
  anchorRange.setStart(anchor.node, anchor.offset);
  anchorRange.collapse(true);
  const focusRange = document.createRange();
  focusRange.setStart(focus.node, focus.offset);
  focusRange.collapse(true);
  const range = document.createRange();
  if (anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) <= 0) {
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
  } else {
    range.setStart(focus.node, focus.offset);
    range.setEnd(anchor.node, anchor.offset);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Top-level orchestrator that owns the entity tree, drive the render loop,
 * and maintains the accessibility/automation shadow layer.
 *
 * Create one `Scene` per `<canvas>` element.  Add {@link Entity} objects via
 * {@link add}, then call {@link start} to begin the 60-FPS render loop.
 *
 * @example
 * const scene = new Scene(document.querySelector('canvas')!);
 * scene.add(new CircleEntity().setPosition(100, 100));
 * scene.start();
 */
export class Scene {
  private static webglCreator: WebGLPointRendererCreator | null = null;
  private static webgpuManagerClass: any = null;
  /** Upper bound (ms) on a single frame's `dt`. Caps the giant elapsed gap a
   *  backgrounded/refocused tab produces so physics advances at most one slow
   *  frame instead of the whole idle duration (~100ms ≈ 6 frames at 60fps). */
  private static readonly MAX_FRAME_DT = 100;

  public static registerWebGLPointRendererCreator(creator: WebGLPointRendererCreator) {
    Scene.webglCreator = creator;
  }

  public static registerWebGPUParticleSystemManager(managerClass: any) {
    Scene.webgpuManagerClass = managerClass;
  }

  private root: Entity;
  public overlayRoot: Entity;
  private renderer: IRenderer;
  private isRunning: boolean = false;
  /** Whether the canvas is at least partially in the viewport. When it scrolls
   *  fully off-screen the rAF loop pauses (stops rescheduling) instead of
   *  burning frames on a scene nobody can see; an IntersectionObserver resumes
   *  it on re-entry. Defaults true (and stays true where IntersectionObserver
   *  is unavailable, e.g. SSR/jsdom, so behavior is unchanged there). */
  private _canvasOnScreen = true;
  private _canvasObserver: IntersectionObserver | null = null;
  private lastTime: number = 0;
  public canvas: HTMLCanvasElement;

  /**
   * Redraw strategy:
   * - `'always'` (default): re-render every animation frame (legacy behavior).
   * - `'onDemand'`: only re-render when the scene is marked dirty (via
   *   {@link markDirty}) or while an animation is pending. Ideal for static /
   *   event-driven UIs where idle frames should cost ~0.
   */
  public renderMode: 'always' | 'onDemand' = 'always';

  /** Cap on distinct recorded dirty reasons (see `recordDirtyReason`). */
  private static readonly MAX_DIRTY_REASONS = 200;
  private _phaseTiming = false;
  private _userTiming = false;
  private _phaseTotals = new Map<RenderPhase, { totalMs: number; calls: number; maxMs: number }>();

  /**
   * Start or stop per-phase render timing.
   *
   * Off by default, and the probes compile to a single boolean test when off:
   * these sit on the frame path, so the disabled cost has to be nothing. Enable,
   * run the scene, then read {@link renderPhases}.
   *
   * Exists because a frame total cannot tell you where the time went. The
   * markdown streaming benchmark put render at 85-99% of an append's cost, and
   * there was no way to decompose that number further — which is exactly the
   * position that led to two wrong optimisation guesses earlier
   * (`CodeBlock` reuse, hit-grid fusion), both of which measured as no change.
   */
  public setPhaseTiming(enabled: boolean): void {
    this._phaseTiming = enabled;
    if (!enabled) this.clearRenderPhases();
  }

  /** Whether per-phase render timing is being recorded. */
  public get phaseTiming(): boolean {
    return this._phaseTiming;
  }

  /**
   * Enable or disable browser User Timing phase instrumentation.
   *
   * Off by default. The disabled frame path performs only boolean checks and
   * emits no Performance Timeline entries.
   */
  public setUserTiming(enabled: boolean): void {
    this._userTiming = enabled;
  }

  /** Whether browser User Timing phase instrumentation is enabled. */
  public get userTiming(): boolean {
    return this._userTiming;
  }

  /**
   * Accumulate one phase sample.
   *
   * Totals rather than a per-frame log: the question is always "which phase owns
   * the frame", and a log of thousands of samples answers it less directly while
   * costing far more memory. `maxMs` is kept because a phase that is cheap on
   * average but spikes is a different problem from one that is uniformly slow.
   */
  private _recordPhase(phase: RenderPhase, ms: number): void {
    const existing = this._phaseTotals.get(phase);
    if (existing) {
      existing.totalMs += ms;
      existing.calls++;
      if (ms > existing.maxMs) existing.maxMs = ms;
      return;
    }
    this._phaseTotals.set(phase, { totalMs: ms, calls: 1, maxMs: ms });
  }

  /**
   * Recorded phase timings, most expensive first, with each phase's share of the
   * measured total.
   *
   * `share` is the number that matters: a phase at 4% cannot be worth optimising
   * however inefficient it looks in isolation.
   */
  public get renderPhases(): RenderPhaseEntry[] {
    const entries = [...this._phaseTotals.entries()];
    // `render` is the enclosing phase for transform/drawWalk/flush, so counting
    // it in the denominator would double-count and halve every share.
    const denominator = entries
      .filter(([phase]) => phase !== 'render')
      .reduce((sum, [, v]) => sum + v.totalMs, 0);
    return entries
      .map(([phase, v]) => ({
        phase,
        totalMs: +v.totalMs.toFixed(3),
        calls: v.calls,
        avgMs: +(v.totalMs / Math.max(1, v.calls)).toFixed(4),
        maxMs: +v.maxMs.toFixed(3),
        share:
          phase === 'render' ? null : +((100 * v.totalMs) / Math.max(1e-9, denominator)).toFixed(1),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Drop recorded phase timings, keeping timing enabled. */
  public clearRenderPhases(): void {
    this._phaseTotals.clear();
  }

  private _dirtyTracking = false;
  private _dirtyReasons = new Map<string, DirtyReasonEntry>();
  private dirty: boolean = true;
  /** Whether to throttle rendering to 2 FPS when the scene is static to save power. */
  public autoThrottle: boolean = true;

  // --- Frame telemetry (read via `frameStats`) ---------------------------
  /** Wall-clock ms spent inside the last `render()` call. */
  private _lastFrameMs = 0;
  /** Rolling exponential average of rendered-frame intervals, in ms. */
  private _avgFrameIntervalMs = 0;
  /** dt (ms) handed to the last rendered frame. */
  private _lastDt = 0;
  /** Count of frames actually rendered since the loop started. */
  private _renderedFrames = 0;
  /** Count of rAF ticks skipped (idle / capped) since the loop started. */
  private _skippedFrames = 0;
  /** `time` of the previous *rendered* frame, for interval measurement. */
  private _lastRenderTick = 0;

  /**
   * Frame-rate cap (power saving). `0` = uncapped (native refresh). When set,
   * the loop renders at most `maxFPS` times per second; animations still run,
   * just less often. See {@link SceneOptions.maxFPS}.
   */
  public maxFPS: number = 60;
  /** Whether the OS prefers-reduced-motion setting auto-caps the loop. */
  public respectReducedMotion: boolean = true;
  /**
   * Reading direction for accessibility tab/traversal order (`'ltr'` default,
   * `'rtl'`). Controls the inline sort within a visual row in
   * {@link enforceA11yDomOrder}. Set at runtime to re-flow tab order on the
   * next sync (also trips a reorder).
   */
  public get readingDirection(): 'ltr' | 'rtl' {
    return this._readingDirection;
  }
  public set readingDirection(dir: 'ltr' | 'rtl') {
    if (dir !== this._readingDirection) {
      this._readingDirection = dir;
      this.a11yNeedsReorder = true;
    }
  }
  private _readingDirection: 'ltr' | 'rtl' = 'ltr';
  /** Cached media-query list; `.matches` is read live each frame. */
  private reducedMotionQuery: MediaQueryList | null = null;
  /** Cached `(forced-colors: active)` query (Windows High Contrast etc.). A
   *  canvas gets NO automatic forced-colors treatment from the browser (it's
   *  opaque pixels), so components must read {@link forcedColors} and repaint
   *  with system colors themselves; a change listener repaints idle scenes. */
  private forcedColorsQuery: MediaQueryList | null = null;
  private forcedColorsChangeHandler: (() => void) | null = null;

  /** True when the OS asks for reduced motion and we respect it. Read by the animation drivers. */
  public get prefersReducedMotion(): boolean {
    return this.respectReducedMotion && !!this.reducedMotionQuery?.matches;
  }

  /**
   * True when the OS is in a forced-colors mode (Windows High Contrast, and the
   * `forced-colors: active` media feature generally). Canvas pixels are exempt
   * from the browser's forced-colors remapping, so accessible components should
   * read this and draw with CSS system colors (`CanvasText`, `Canvas`,
   * `Highlight`, …) instead of their themed palette. Re-rendered automatically
   * when the setting toggles.
   */
  public get forcedColors(): boolean {
    return !!this.forcedColorsQuery?.matches;
  }

  /**
   * Throttle interval (ms) for the a11y/automation shadow sync. `0` = every
   * frame. See {@link SceneOptions.a11ySyncInterval}.
   */
  public a11ySyncInterval: number = 0;
  /** Timestamp of the last a11y sync, for throttling. */
  private lastA11ySync: number = -Infinity;
  /** True if we skipped an a11y sync during animation and need to sync when at rest. */
  private a11yPendingSyncAfterAnimation: boolean = false;

  // A11y / Automation Layer. `null` in non-DOM (SSR/Node) environments — the
  // whole projection degrades to a no-op so the engine's logic stays usable
  // server-side (e.g. headless layout / vector export) without jsdom.
  private a11yRoot: HTMLDivElement | null;
  private a11yElements: Map<string, HTMLElement> = new Map();
  /** DOM nodes mirroring static text content, keyed by entity id. */
  private contentElements: Map<string, HTMLElement> = new Map();
  /**
   * What the last completed content-projection sync was built from, per entity.
   *
   * Compared at the top of {@link syncContentProjection} to skip a block whose
   * content AND geometry are both unchanged, before the O(glyphs) projection
   * build. Only populated for entities that opt in via
   * {@link Entity.getContentEpoch}. (carryctx CTX-0199)
   */
  private contentSyncState: Map<string, ContentSyncState> = new Map();
  /** Pending cold font-calibration frame per projected grid entity. */
  private contentGridCalibrationFrames: Map<string, number> = new Map();
  /** Detached, untransformed font probes used by the cold calibration pass. */
  private contentGridCalibrationProbes: Map<string, HTMLElement> = new Map();
  /**
   * Monotonic stamp identifying the conditions grid cells were calibrated under.
   *
   * Calibration measures the difference between the advance the canvas grid assigns
   * a cluster and the width the browser lays it out at, then writes a per-cell
   * `scaleX`. That result stays valid until the font or the page scale changes, and
   * it lives on the cell element — so a cell carrying this stamp needs no further
   * work.
   *
   * The scan that feeds calibration was O(cells) on every revision bump: for a
   * streaming code block it re-derived a measurement key for every cell in the
   * block each frame in order to produce only ~20 distinct keys, costing about
   * 2.5 ms/frame after the `style.font` fix and still over half of `a11ySync`. Since
   * carrier reuse (#244) leaves untouched lines — and therefore their calibrated
   * transforms — in place, cells stamped with the current generation can simply be
   * skipped, making the scan O(new cells) instead.
   *
   * A plain incrementing integer rather than the descriptive calibration key,
   * because it goes into an attribute selector and must not need escaping.
   */
  private contentGridCalibrationGeneration = 0;
  /** The `(fontEpoch, pageScale)` pair the current generation corresponds to. */
  private contentGridCalibrationStamp = '';
  /** Invalidates grid font calibration after browser font availability changes. */
  private contentFontEpoch = 0;
  /**
   * Bumped whenever the viewport itself changes shape, which re-tiers blocks
   * without moving any of them.
   *
   * The settled-walk fast path in {@link syncContentProjection} decides a block
   * is unchanged from its own local transform plus its parent's world transform.
   * Both are viewport-independent, so a resize alone would slip past it and leave
   * every block holding DOM built for the old viewport — a block that should have
   * been promoted to the fine tier keeping no carriers, or a demoted one keeping
   * carriers it no longer needs. Scrolling needs no such epoch: it moves the root,
   * so every block's parent world transform changes and the check fails honestly.
   */
  private contentViewportEpoch = 0;
  /**
   * One-entry memo for a parent's world transform, held as scalars.
   *
   * The a11y walk visits all of one parent's children consecutively, so a
   * one-entry memo hits for every child after the first — turning an
   * O(children) sequence of `getWorldTransform()` calls, each of which
   * allocates a fresh object on its cache-hit path
   * ({@link Entity.getWorldTransform}), into one call per parent. Flattened to
   * scalars rather than a cached object so the memo itself never allocates.
   *
   * Keyed on `(entity, syncSerial)`: the serial is bumped once per top-level
   * sync, so a memo can never survive into a frame in which the parent has
   * moved.
   */
  private _pwNode: Entity | null = null;
  private _pwSerial = -1;
  private _pwa = 1;
  private _pwb = 0;
  private _pwc = 0;
  private _pwd = 1;
  private _pwe = 0;
  private _pwf = 0;
  /** Incremented once per top-level `syncA11y`, invalidating `_pwNode`. */
  private _syncSerial = 0;
  /**
   * Disables the settled-walk fast path in {@link syncContentProjection}.
   *
   * Exists so a benchmark can measure both arms in ONE run on ONE commit, rather
   * than comparing two builds and inheriting every difference between them. Also
   * lets a test assert that a behaviour is genuinely unchanged by the fast path
   * rather than merely unobserved.
   *
   * Not part of the public API and not documented as an option: turning it on only
   * makes a settled document slower, never more correct.
   */
  public disableSettledFastPath = false;
  /** Cached Canvas-to-client scale for the current font/viewport epoch. */
  private contentMetricScaleEpoch = -1;
  private contentMetricScaleX = 1;
  private contentProjectionEnabled: boolean = true;
  // Virtualization margin (px) for the content-projection CARRIER band;
  // `undefined` → one viewport height, resolved at sync time. `Infinity` is
  // unsupported here: it unwindows every carrier, which is O(total glyphs).
  private contentProjectionMargin: number | undefined = undefined;
  // Virtualization margin (px) for the SEMANTIC tier — whether a block has
  // any projected DOM. `undefined` → falls back to contentProjectionMargin, so
  // the default keeps one gate. `Infinity` = every block keeps resident text.
  private contentSemanticMargin: number | undefined = undefined;
  // How many coarse-tier blocks may be MATERIALIZED per sync, spreading the
  // resident tier's document-open cost across frames. `Infinity` = one
  // synchronous pass.
  private contentSemanticBudget: number = DEFAULT_CONTENT_SEMANTIC_BUDGET;
  // Remaining materializations in the CURRENT sync. Reset at the start of each
  // a11y walk; decremented per coarse block that creates its element.
  private contentSemanticBudgetLeft = 0;
  // Set when a sync deferred at least one block, so the scene knows to keep
  // drawing frames until the resident tier is complete. Without it a static
  // scene in `onDemand` mode would stop rendering with the document half
  // materialized and never finish.
  private contentSemanticDeferred = false;
  /**
   * Per-sync memo of "does the document hold a selection at all".
   *
   * Reading ANY property of a `Selection` (`anchorNode`, `rangeCount`, `type`,
   * `isCollapsed`) forces a synchronous layout, because Blink validates the
   * selection against current box geometry before answering. Measured in real
   * Chrome against a 1000-carrier subtree with layout dirtied between reads:
   * `anchorNode` 0.5ms, `rangeCount` 0.4ms, `type` 0.5ms, `isCollapsed` 0.5ms —
   * all indistinguishable from `offsetHeight` (0.5ms), against a 0ms floor for
   * mutating without reading. So there is no cheap property to probe with; the
   * only way to avoid the layout is to not touch the object at all.
   *
   * Materializing a block rebuilds its carriers, which asks whether the rebuild
   * would destroy a selection. Once per block, that read cost a forced layout
   * over the whole (and growing) projection subtree, which is what made
   * per-block cost rise with resident count: profiled at 1973 forced layouts
   * totalling 633ms of an 847ms 1000-block drain (75%).
   *
   * A selection is a single document-wide object and a sync walk cannot yield to
   * the user, so its presence cannot change mid-walk. Resolving it once per walk
   * turns O(blocks) forced layouts into O(1). `null` = not yet resolved.
   */
  private contentSelectionPresentThisSync: boolean | null = null;
  /**
   * True while a text-selection drag that started on a projection's blank
   * region (no text node under the press) is being driven manually — the
   * browser has no native anchor for it, so mousemove extends the Selection
   * from the position we resolved ourselves.
   */
  private blankRegionSelectionDrag = false;
  private contentSelectionAnchor: TextCaretPosition | null = null;
  private contentSelectionEndListener: (() => void) | null = null;
  // Animation/interactive flags collected during the render walk (tree-walk
  // fusion): the loop reads last frame's answers instead of re-walking the
  // tree up to 4× per tick. Start true so the first tick stays conservative.
  private frameHadAnimation = true;
  private frameHadInteractive = true;
  private resizeHandler: () => void;
  /** Active `(resolution: Ndppx)` media query watching for a runtime DPR change
   *  (window moved between monitors, browser zoom) so the canvas backing store
   *  can be re-scaled — otherwise it stays rasterized at the old DPR and blurs.
   *  A resolution media query only fires when leaving its exact value, so the
   *  handler re-arms a fresh query for the new DPR each time. */
  private dprMediaQuery: MediaQueryList | null = null;
  /** For embedded (`disableWindowResize`) scenes: observes the canvas element so
   *  a CSS/layout-driven size change re-runs `resize()`. A window `resize`
   *  listener never fires for these (the window isn't what changed), so without
   *  this an embedded canvas stayed at its initial size forever. */
  private canvasResizeObserver: ResizeObserver | null = null;
  private dprChangeHandler: (() => void) | null = null;
  private focusedA11yElement: HTMLElement | null = null;
  /** Last geometry `syncOverlayGeometry` wrote, so an unchanged frame can skip the
   *  style writes entirely. Reset to `null` to force the next sync (a new overlay
   *  layer was created and has never been positioned). */
  private _overlayGeometry: {
    left: number;
    top: number;
    cssWidth: number;
    cssHeight: number;
    width: number;
    height: number;
  } | null = null;
  /** Shadow elements the pointer is currently inside. Lets a removal that happens
   *  mid-hover synthesize the `pointerleave` the browser never sends for a
   *  detached element, so the entity doesn't keep its hover state. */
  private readonly hoveredA11yElements = new WeakSet<HTMLElement>();
  /**
   * Entity ids the application has pinned via {@link requestA11yProjection}.
   *
   * Ids rather than entities so a removed entity cannot be retained by this set;
   * a stale id simply never matches. Cleared per-entity by
   * {@link releaseA11yProjection}.
   */
  private readonly a11yProjectionRequests = new Set<string>();
  /** Persistent tabindex=-1 element in a11yRoot. When the focused a11y mirror is
   *  pruned (virtualization/streaming/removal) while it holds focus, we move
   *  focus here instead of letting the browser drop it to <body> — keeping the
   *  screen-reader virtual cursor inside the scene's a11y region. */
  private focusSentinel: HTMLElement | null = null;
  private caretBlinkTimer: any = null;
  public a11yNeedsReorder: boolean = true;
  private portalRoot: HTMLDivElement | null = null;
  private fullViewportElements: HTMLElement[] = [];
  private normalElements: HTMLElement[] = [];
  private activeIds: Set<string> = new Set<string>();
  /** Per-parent insertion cursor, reused by `enforceA11yDomOrder`. */
  private a11yOrderCursors: Map<Node, number> = new Map<Node, number>();
  /** Membership set for the elements being ordered, reused per reorder pass. */
  private a11yOrderMembers: Set<HTMLElement> = new Set<HTMLElement>();
  /**
   * Elements that are an *ancestor* of another ordered element, reused per pass.
   *
   * A composite widget's container (a `grid` around its rows, a `tree` around its
   * items) spans every descendant row, so it must not extend a visual row band —
   * see {@link sortNormalElementsVisually}.
   */
  private a11yOrderContainers: Set<HTMLElement> = new Set<HTMLElement>();
  /**
   * Nearest `clipChildren` ancestor per ordered element — its *region* — reused
   * per pass. Written by `enforceA11yDomOrder`'s collect walk, which already has
   * the entity in hand, so a region costs one comparison per node rather than an
   * ancestor walk per element.
   *
   * Absent means the element sits under no clipping ancestor and belongs to the
   * implicit root region. See {@link sortNormalElementsVisually}.
   */
  private a11yOrderRegions: Map<HTMLElement, Entity> = new Map<HTMLElement, Entity>();

  private activePortalsThisFrame: Set<string> = new Set();
  private activePortalsPrevFrame: Set<string> = new Set();
  private portalEntities: Map<string, DOMPortalEntity> = new Map();
  private renderOrderCounter: number = 0;

  /**
   * Monotonic render-frame counter, bumped once per authoritative `render()`
   * pass. Entities stamp their per-frame world-matrix cache with this value and
   * {@link Entity.getWorldTransform} trusts that cache only while it still
   * matches, so a query outside the frame that produced it transparently falls
   * back to the ancestor walk. Public for the same reason `Entity._getTrig`/
   * `_setWorldCache` are: it is a cross-class render-internal contract.
   */
  public currentFrame = 0;

  // ── WASM transform backend (invisible accelerator) ──────────────────────────
  // When `_transformBackend === 'wasm'`, the main render walk sources each
  // entity's world matrix from an SoA store composed by `_wasm` (see
  // `renderNode`), instead of composing it in JS. The JS path is the permanent
  // fallback and the default: a null backend, a non-main renderer, or any entity
  // absent from the store all fall back to the JS composition, so WASM can only
  // ever change *how fast* a world matrix is produced, never *what* it is.
  private _wasm: WasmTransformBackend | null = null;
  private _transformBackend: 'js' | 'wasm' = 'js';

  // Resident store state (Stage 3). The store layout — slot assignment + sibling
  // runs — depends only on tree TOPOLOGY, so it is rebuilt only when the
  // structure changes (add/remove/reparent bump `_structureVersion`). Between
  // rebuilds the per-frame cost is: gather each entity's transform into the
  // resident wasm input view + run the kernel — no reallocation, no readback.
  private _treeStore: TransformStore | null = null;
  private _slotEntity: Entity[] = []; // store slot -> entity (also validates slots)
  private _wasmInputs: ReturnType<WasmTransformBackend['inputView']> | null = null;
  private _wasmWorld: ReturnType<WasmTransformBackend['worldView']> | null = null;
  private _structureVersion = 0;
  private _storeStructureVersion = -1;

  // Cached list of ComputeParticleEntity instances in the tree, keyed by the
  // structure version it was gathered at. Rebuilt only on a topology change.
  private _computeEntities: ComputeParticleEntity[] = [];
  private _computeEntitiesVersion = -1;

  /** Invalidate the resident WASM store layout; the next wasm-mode frame rebuilds
   *  it. Called by `Entity.add`/`remove` (topology changes only). */
  public markStructureChanged(): void {
    this._structureVersion++;
  }

  /** The tree's ComputeParticleEntity instances, cached per structure version so
   *  a compute-free scene doesn't re-walk the whole tree every frame. */
  private _computeEntitiesFor(version: number): ComputeParticleEntity[] {
    if (this._computeEntitiesVersion === version) return this._computeEntities;
    const list: ComputeParticleEntity[] = [];
    const collect = (node: Entity) => {
      if (node instanceof ComputeParticleEntity) list.push(node);
      for (const child of node.children) collect(child);
    };
    collect(this.root);
    for (const overlay of this.overlayRoot.children) collect(overlay);
    this._computeEntities = list;
    this._computeEntitiesVersion = version;
    return list;
  }

  /** Which backend composes world matrices for the main render walk. */
  public get transformBackend(): 'js' | 'wasm' {
    return this._transformBackend;
  }

  /**
   * Install (or clear) a WASM transform backend. Passing a backend switches the
   * main render walk onto it; passing `null` reverts to the JS path. Synchronous
   * and safe to call between frames — the next `render()` picks it up. Prefer
   * {@link enableWasmTransforms} for the normal async hot-swap.
   */
  public setTransformBackend(backend: WasmTransformBackend | null): void {
    this._wasm = backend;
    this._transformBackend = backend ? 'wasm' : 'js';
  }

  /**
   * Asynchronously instantiate the WASM transform core and, on success, hot-swap
   * the render walk onto it. Accepts whatever is convenient at the call site:
   *
   * ```ts
   * // The common case — a bundler-emitted, co-located asset URL:
   * await scene.enableWasmTransforms(new URL('./vectojs_core.wasm', import.meta.url));
   * // …or a path string, a Response, or raw bytes you already have:
   * await scene.enableWasmTransforms('/assets/vectojs_core.wasm');
   * await scene.enableWasmTransforms(await fetch(url));
   * await scene.enableWasmTransforms(myUint8Array);
   * ```
   *
   * A URL/Response streams (compiles while it downloads, with a buffered
   * fallback for a wrong MIME type); raw bytes instantiate directly. The Scene
   * keeps rendering on the JS path until this resolves, and stays on JS if
   * instantiation fails (CSP `wasm-unsafe-eval`, unsupported SIMD, corrupt or
   * missing bytes, a 404) — failure is the default state, not an error path.
   * Resolves `true` if WASM is now active, `false` if the JS path remains.
   */
  public async enableWasmTransforms(source: WasmModuleSource): Promise<boolean> {
    const runtime = await this.ensureWasmRuntime(source);
    if (!runtime) return false;
    this.setTransformBackend(runtime.transform());
    return true;
  }

  // ── WASM hit-test backend (invisible accelerator, G3) ───────────────────────
  // Served by the same instance as every other accelerator (see
  // `_wasmRuntime`): the crate keeps transform/anim/hit/particle in distinct
  // statics, so one instance runs them all without aliasing. It indexes the
  // main tree's world AABBs into a dense viewport grid for findEntityAt. Note
  // that sharing one linear memory means an allocation here can grow it and
  // detach views built over the old buffer, so each backend re-checks buffer
  // identity (`revalidateViews`) before use. The JS depth-first walk
  // (findHitRecursively) is the permanent fallback: a null backend, a build
  // that overflows its item budget, or the overlay tree (never indexed — small
  // and rare, not worth accelerating) all fall through to it, so WASM can only
  // ever change *how fast* a hit is found, never *which* entity is returned —
  // every grid candidate is re-confirmed against its own precise
  // isPointInside before being trusted (see hit-store.ts / hit-backend.ts).
  /**
   * The one WASM instance this Scene's accelerators share.
   *
   * Each `enableWasm*` used to instantiate the binary itself, so enabling all
   * four compiled the same module four times and held four linear memories. The
   * Rust crate already keeps transform/anim/hit/particle in separate statics, so
   * one instance serves all of them without aliasing. The compiled module is
   * cached globally; the instance is per-Scene, which is the isolation that
   * actually matters.
   */
  private _wasmRuntime: CoreWasmRuntime | null = null;

  /**
   * Load (or reuse) this Scene's shared WASM runtime.
   *
   * Returns `null` on any failure — CSP `wasm-unsafe-eval`, a 404, corrupt bytes,
   * unsupported SIMD — so every caller keeps its JS path. Failure is the default
   * state here, not an error path.
   */
  private async ensureWasmRuntime(source: CoreModuleSource): Promise<CoreWasmRuntime | null> {
    if (this._wasmRuntime) return this._wasmRuntime;
    const runtime = await loadCoreWasmRuntime(source);
    if (!runtime) return null;
    // A concurrent `enableWasm*` may have won the race while we awaited; keep
    // whichever landed first so the backends cannot end up on two instances.
    if (this._wasmRuntime) return this._wasmRuntime;
    this._wasmRuntime = runtime;
    return runtime;
  }

  /**
   * Install a pre-built runtime, so several Scenes can share one compile while
   * each keeps its own stores. Pass `null` to detach (backends already installed
   * keep working; only subsequent `enableWasm*` calls re-load).
   */
  public setWasmRuntime(runtime: CoreWasmRuntime | null): void {
    this._wasmRuntime = runtime;
  }

  /** The shared WASM runtime, if one has been loaded. */
  public get wasmRuntime(): CoreWasmRuntime | null {
    return this._wasmRuntime;
  }

  private _hitWasm: HitTestBackend | null = null;
  // Cache key: which frame + structure version the grid was last (successfully,
  // non-overflowing) built for. findEntityAt is called ad-hoc (pointer
  // hover/click), not every frame, so the grid is refreshed lazily on demand
  // rather than proactively every render() — unlike the transform store, which
  // every frame's draw depends on.
  private _hitGridFrame = -1;
  private _hitGridOk = false;
  private _hitSlotEntity: Entity[] = [];
  private _hitBoundless: Array<{ entity: Entity; index: number }> = [];
  /** Reused buffer for the fused gather, so a pointer query allocates nothing. */
  private _hitGatherBuffer: ReturnType<typeof createHitGatherBuffer> | null = null;
  /**
   * Whether the last grid build sourced its AABBs from the WASM transform store
   * rather than recomputing them in JS. Diagnostic only — both paths must
   * produce the same entity for a given point.
   */
  private _hitFusedGather = false;
  /**
   * Whether `compute_aabbs` has run against the current frame's world matrices.
   * The AABB pass is only meaningful after a `compose_*`, so the fused gather
   * must not read the views before then.
   */
  private _wasmAabbsFresh = false;

  /** Did the last hit-grid build use the fused (WASM-store) gather? */
  public get hitGatherPath(): 'fused' | 'js' {
    return this._hitFusedGather ? 'fused' : 'js';
  }

  /**
   * Why the transform accelerator did or did not run on the most recent frame.
   * Written by the render walk and `_syncWasmStore`.
   */
  private _transformReason: AcceleratorReason = 'not-installed';
  /** Why the batched-driver accelerator did or did not run. */
  private _animReason: AcceleratorReason = 'not-installed';
  /**
   * Why the hit-test accelerator did or did not serve the last pointer query.
   * The grid is built lazily on demand, not every frame, so this describes the
   * most recent BUILD. Starts at `'not-installed'` because that is the truth
   * before a backend exists; `_ensureHitGrid` moves it to `'not-applicable'`
   * once one is installed but nothing has queried yet.
   */
  private _hitReason: AcceleratorReason = 'not-installed';
  /** Why the particle accelerator did or did not run. */
  private _particleReason: AcceleratorReason = 'not-applicable';
  /** Which particle implementation actually simulated the most recent frame. */
  private _particlePath = 'none';

  /**
   * Per-frame status of every invisible accelerator: whether each is installed,
   * whether it actually ran on the most recent frame, and why.
   *
   * This exists because the older per-accelerator getters
   * ({@link transformBackend}, {@link animBackend}, {@link hitTestBackend},
   * {@link particleBackend}) report only that a backend is INSTALLED. Reading
   * `'wasm'` from one of those and concluding the accelerator is doing work is
   * wrong whenever a gate never opens, a kernel rejects its arguments, or a
   * faster backend takes the pass instead. Read {@link AcceleratorStatus.reason}
   * for which of those happened.
   *
   * Reflects the most recent main-renderer frame; a secondary renderer (SVG
   * export, offscreen snapshot) does not overwrite it.
   */
  public get accelerators(): AcceleratorReport {
    return {
      transform: {
        available: this._wasm !== null && this._transformBackend === 'wasm',
        activeThisFrame: this._transformReason === 'active',
        reason: this._transformReason,
        path: this._transformReason === 'active' ? 'wasm' : 'js',
      },
      animation: {
        available: this._animWasm !== null,
        activeThisFrame: this._animBatchedLastFrame,
        reason: this._animReason,
        path: this._animBatchedLastFrame ? 'wasm' : 'js',
      },
      hitTest: {
        available: this._hitWasm !== null,
        // The grid is built lazily on a pointer query, not every frame, so this
        // describes the last BUILD rather than the last frame.
        activeThisFrame: this._hitReason === 'active',
        reason: this._hitReason,
        path: this._hitReason !== 'active' ? 'js' : this._hitFusedGather ? 'wasm-fused' : 'wasm',
      },
      particle: {
        available: this._particleWasm !== null || this.webgpuActive,
        activeThisFrame: this._particleReason === 'active',
        reason: this._particleReason,
        path: this._particlePath,
      },
    };
  }

  /** Which backend answers `findEntityAt` for the main tree. */
  public get hitTestBackend(): 'js' | 'wasm' {
    return this._hitWasm ? 'wasm' : 'js';
  }

  /** Install (or clear) a WASM hit-test backend directly. Prefer
   *  {@link enableWasmHitTest} for the normal async hot-swap. */
  public setHitTestBackend(backend: HitTestBackend | null): void {
    this._hitWasm = backend;
    this._hitGridFrame = -1; // force a rebuild under the (possibly new) backend
    // Installed but not yet queried is 'not-applicable', not 'not-installed' —
    // the grid is built lazily, so an untouched backend has declined nothing.
    this._hitReason = backend ? 'not-applicable' : 'not-installed';
  }

  /**
   * Asynchronously instantiate the WASM hit-test core and, on success, hot-swap
   * `findEntityAt` onto it. Accepts the same source shapes as
   * {@link enableWasmTransforms} (URL, path string, Response, or raw bytes).
   * Stays on the JS walk if instantiation fails — failure is the default
   * state, not an error path. Resolves `true` if WASM is now active.
   */
  public async enableWasmHitTest(source: HitModuleSource): Promise<boolean> {
    const runtime = await this.ensureWasmRuntime(source);
    if (!runtime) return false;
    this.setHitTestBackend(runtime.hit());
    return true;
  }

  /**
   * Refresh the hit-test grid for the CURRENT tree state if it is stale (a
   * structural or transform change may have happened since the last build —
   * there is no cheap "nothing moved" shortcut for a spatial index the way
   * there is for the transform store's topology-only run table, since ANY
   * entity moving invalidates its AABB, not just add/remove/reparent; the
   * measured build cost is cheap enough to redo per call). Returns `false`
   * (grid untrustworthy — caller must use the JS walk) when there is no
   * backend or the build overflowed its item budget.
   */
  private _ensureHitGrid(): boolean {
    const backend = this._hitWasm;
    if (!backend) {
      this._hitReason = 'not-installed';
      return false;
    }
    if (this._hitGridFrame === this.currentFrame) return this._hitGridOk;

    // Prefer the fused path: when the transform backend is active it has already
    // reduced every world matrix to an AABB inside the SAME linear memory (all
    // backends share one instance), so the gather becomes a copy plus an index
    // remap instead of re-deriving four transformed corners per entity in JS.
    //
    // That JS gather is what made the integrated hit-test path *slower* than the
    // JS walk for an ordinary hover despite a 65-170x faster kernel: 11.2ms vs
    // 39us at 100k entities, essentially all of it in front of the kernel.
    //
    // It returns null when the store cannot answer (a tree change since the last
    // rebuild leaves a stale `_storeSlot`), in which case fall through to the JS
    // gather — a wrong AABB would mean the wrong entity under the cursor, and a
    // slower correct answer beats a faster wrong one.
    let gathered: ReturnType<typeof gatherHitAABBs> | null = null;
    if (this._wasm && this._ensureWasmAabbs()) {
      this._hitGatherBuffer ??= createHitGatherBuffer();
      this._wasm.revalidateViews();
      gathered = gatherHitAABBsFromStore(
        this.root,
        this._wasm.aabbView(),
        this._slotEntity,
        this._hitGatherBuffer,
      );
      if (gathered) this._hitFusedGather = true;
    }
    if (!gathered) {
      this._hitFusedGather = false;
      gathered = gatherHitAABBs(this.root, this.currentFrame);
    }
    // ensure() must run BEFORE writing AABBs: a capacity growth detaches the
    // previous typed-array views, so sizing after writing would write into a
    // stale buffer.
    backend.ensure(gathered.count, this.width, this.height, 64);
    const view = backend.inputView();
    view.minx.set(gathered.minx.subarray(0, gathered.count));
    view.miny.set(gathered.miny.subarray(0, gathered.count));
    view.maxx.set(gathered.maxx.subarray(0, gathered.count));
    view.maxy.set(gathered.maxy.subarray(0, gathered.count));
    const ok = backend.runBuild(gathered.count, this.width, this.height, 64);

    this._hitSlotEntity = gathered.slotEntity;
    this._hitBoundless = gathered.boundless;
    this._hitGridFrame = this.currentFrame;
    this._hitGridOk = ok;
    // `runBuild` returns false when the build overflowed its item budget, which
    // makes the grid untrustworthy — a real decline, not merely "not asked".
    this._hitReason = ok ? 'active' : 'rejected';
    return ok;
  }

  /**
   * `findEntityAt`'s WASM-accelerated path for the main tree. Scans only the
   * queried cell's candidates (confirming each against its own AABB and precise
   * `isPointInside`) merged against the (typically empty or tiny) list of
   * entities with no `getBounds()`, taking whichever confirmed match has the
   * higher pre-order index — see hit-store.ts for why that is exactly
   * equivalent to findHitRecursively's topmost-hit priority. Always
   * conclusive: returns the correct entity or `null`, never "inconclusive".
   */
  private _findEntityAtWasm(x: number, y: number): Entity | null {
    const backend = this._hitWasm!;
    const { minx, miny, maxx, maxy } = backend.inputView();
    let bestIndex = -1;
    let bestEntity: Entity | null = null;

    const cell = backend.candidatesAt(x, y);
    if (cell) {
      // Ascending index order; scan from the end for topmost (highest index)
      // first, so the first candidate that passes both checks is already the
      // topmost possible confirmed hit among the grid's candidates.
      for (let k = cell.length - 1; k >= 0; k--) {
        const idx = cell[k];
        if (x < minx[idx] || x > maxx[idx] || y < miny[idx] || y > maxy[idx]) continue;
        const entity = this._hitSlotEntity[idx];
        if (entity?.isPointInside(x, y) && this.isHitEligible(entity, x, y)) {
          bestIndex = idx;
          bestEntity = entity;
          break;
        }
      }
    }
    for (const { entity, index } of this._hitBoundless) {
      if (index > bestIndex && entity.isPointInside(x, y) && this.isHitEligible(entity, x, y)) {
        bestIndex = index;
        bestEntity = entity;
      }
    }
    return bestEntity;
  }

  // ── WASM batched-animation backend (invisible accelerator, G2) ──────────────
  // Advances every currently-active SpringDriver/TweenDriver in one WASM call
  // each (spring_step/tween_step) instead of Entity.tickDrivers()'s per-driver
  // JS loop. The JS tick loop is the permanent fallback: a null backend, a
  // driver count below `animDriverGateCount`, or a TweenDriver using a custom
  // EasingFn (which cannot cross into WASM) all fall through to it — WASM can
  // only ever change *how* a driver is advanced, never *what* value it lands
  // on.
  private _animWasm: AnimBackend | null = null;
  // Entities with at least one active driver, added by Entity._spawnDriver.
  // Self-pruning: _tickBatchedDrivers drops an entry the first time it visits
  // an entity whose drivers have since all completed or been removed. This is
  // what lets the batch pass find its candidates in O(active drivers), not
  // O(tree size) — the exact mistake G3's first integrated benchmark made.
  private _activeDriverEntities = new Set<Entity>();
  // Reused across frames instead of allocating a fresh array + N {entity,prop,
  // driver} objects every call — the integrated benchmark
  // (benchmarks/anim-wasm-scene) found that allocation churn was the
  // dominant integrated cost, not the wasm kernel itself. Parallel arrays,
  // truncated to the live count after each use so a stale tail slot never
  // pins a no-longer-active entity/driver in memory.
  private _springEntities: Entity[] = [];
  private _springProps: AnimatableProp[] = [];
  private _springDrivers: SpringDriver[] = [];
  private _tweenEntities: Entity[] = [];
  private _tweenProps: AnimatableProp[] = [];
  private _tweenDrivers: TweenDriver[] = [];
  /**
   * Minimum number of batchable (spring, or named-easing tween) active drivers
   * before a frame engages the WASM batch path at all; below it, every driver
   * ticks on the normal JS per-entity path, unmodified.
   *
   * Re-measured on the INTEGRATED path (benchmarks/anim-wasm-scene, real
   * Chrome 150 / Firefox 153, 2026-07-24 — correctness verified 0 mismatches
   * across all three kinds before any of these numbers were trusted): the
   * isolated kernel spike's "<100 drivers, wins everywhere" verdict did NOT
   * survive integration, and neither did the first integrated pass's single
   * gate-count verdict once broken out by driver kind. On Chrome, spring and
   * mixed drivers are a real ~1.4–2.3× win from n=128 up through the tested
   * ceiling of 16384, but pure-tween drivers are a LOSS at n=128 (0.71×,
   * i.e. ~40% slower than the JS path) and only turn net-positive around
   * n≈256 (1.52×). A single scalar gate can't be tight for spring/mixed
   * without occasionally opening early on a tween-heavy scene and making it
   * slower — 256 is chosen to keep the gate net-positive across all three
   * kinds rather than optimal for any one of them; a kind-aware gate (see
   * `_tickBatchedDrivers`'s per-kind arrays, which already separate spring
   * from tween) would recover the 128–255 spring/mixed win without the
   * tween regression, but that's a larger change than this measurement pass
   * covers. On Firefox it is a net loss at every driver count measured, up
   * to 16384 — not an allocation artifact (confirmed after removing all
   * per-frame allocation from the gather/scatter path); SpiderMonkey's
   * wasm-boundary/property-dispatch cost for this shape of call appears to
   * structurally exceed the saving, at least at the scales tested here.
   *
   * 256 is set as a Chrome-oriented default so an app that opts in (this
   * path is never engaged without an explicit {@link enableWasmAnimBatching}
   * call) sees the gate open only where it reliably helps on Chromium,
   * regardless of whether the scene's active drivers are spring, tween, or
   * a mix of both. Unlike G1 (safe to default on everywhere) and G3 (opt-in,
   * but a reliable win once its own gate condition holds), G2 has no
   * threshold that is safe on every engine — raise or lower this per your
   * own target browser mix and driver-kind distribution, or leave WASM
   * animation batching disabled entirely on a Firefox-heavy audience.
   */
  /**
   * Back-compat alias for {@link animGate}. Reading it returns the tween gate
   * (the conservative one the single knob used to represent); writing it sets all
   * three, so code that tuned one number keeps behaving as before.
   *
   * Prefer {@link animGate} — a single threshold cannot be right for both kinds,
   * which is why this exists as an alias rather than the primary control.
   */
  public get animDriverGateCount(): number {
    return this.animGate.tween;
  }

  public set animDriverGateCount(n: number) {
    this.animGate = { spring: n, tween: n, mixed: n };
  }

  /**
   * Per-kind driver gates, in active batchable drivers.
   *
   * Measured on the integrated path (`benchmarks/anim-wasm-scene`, real Chrome
   * 150 / Firefox 153): spring and mixed workloads are a ~1.4-2.3x win from 128
   * drivers up through 16384, while pure tween is a **0.71x loss** at 128 and
   * only turns net-positive near 256. One scalar threshold therefore had to be
   * set for the worst kind, discarding the 128-255 spring win to avoid making a
   * tween-heavy scene slower.
   *
   * Firefox is a net loss at every count measured up to 16384 — not an
   * allocation artifact (confirmed after removing all per-frame allocation from
   * gather/scatter); SpiderMonkey's wasm-boundary cost for this call shape
   * appears to structurally exceed the saving at these scales. These defaults are
   * Chrome-oriented; on a Firefox-heavy audience, leave
   * {@link enableWasmAnimBatching} off entirely rather than tuning these.
   *
   * Setting {@link animDriverGateCount} overwrites all three, so existing code
   * that tuned the single knob keeps working unchanged.
   */
  private _animBatchedLastFrame = false;

  /**
   * Whether the WASM batch path actually ran on the most recent frame.
   *
   * Distinct from {@link animBackend}, which reports only that a backend is
   * installed — a gate below the driver count means the frame still ticked in JS.
   * Conflating the two makes it easy to believe an accelerator is active when it
   * never opens.
   */
  public get animBatchedLastFrame(): boolean {
    return this._animBatchedLastFrame;
  }

  public animGate: { spring: number; tween: number; mixed: number } = {
    spring: 128,
    tween: 256,
    mixed: 128,
  };

  /** Which backend advances active property drivers on the current gate
   *  decision. Reflects only whether a backend is installed — the per-frame
   *  gate can still choose the JS path even when this reads `'wasm'`. */
  public get animBackend(): 'js' | 'wasm' {
    return this._animWasm ? 'wasm' : 'js';
  }

  /** Install (or clear) a WASM batched-animation backend directly. Prefer
   *  {@link enableWasmAnimBatching} for the normal async hot-swap. */
  public setAnimBackend(backend: AnimBackend | null): void {
    this._animWasm = backend;
  }

  /**
   * Asynchronously instantiate the WASM batched-animation core and, on
   * success, make it available to the per-frame gate (see
   * {@link animDriverGateCount}). Accepts the same source shapes as
   * {@link enableWasmTransforms}. Stays on the JS tick loop if instantiation
   * fails — failure is the default state, not an error path. Resolves `true`
   * if WASM is now available (not necessarily active every frame).
   */
  public async enableWasmAnimBatching(source: AnimModuleSource): Promise<boolean> {
    const runtime = await this.ensureWasmRuntime(source);
    if (!runtime) return false;
    this.setAnimBackend(runtime.anim());
    return true;
  }

  // ── WASM particle CPU-sim backend (invisible accelerator, G4) ───────────────
  // Advances a ComputeParticleEntity's whole buffer in one `particle_step` call
  // (spring/mouse/explosion/integrate/bounce/life), replacing the per-particle
  // JS `updateCPU` loop on the GPU-less fallback path. Measured ~2.1-2.5x on
  // Chrome and ~1.4-2.0x on Firefox including the per-frame AoS<->SoA transpose
  // (benchmarks/particle-wasm). f32 (matches the WGSL shader), bit-identical to
  // a JS f32 reference oracle; updateCPU (f64) stays the permanent fallback when
  // no backend is installed or a scene runs on WebGPU.
  private _particleWasm: ParticleBackend | null = null;

  /** Which backend runs the CPU particle simulation. Reflects only whether a
   *  backend is installed (the WebGPU compute path, when active, is used first
   *  regardless). */
  public get particleSimBackend(): 'js' | 'wasm' {
    return this._particleWasm ? 'wasm' : 'js';
  }

  /** Install (or clear) a WASM particle backend directly. Prefer
   *  {@link enableWasmParticles} for the normal async hot-swap. */
  public setParticleBackend(backend: ParticleBackend | null): void {
    this._particleWasm = backend;
  }

  /**
   * Asynchronously instantiate the WASM particle core and, on success, use it
   * for the CPU particle fallback. Accepts the same source shapes as
   * {@link enableWasmTransforms}. Stays on the JS `updateCPU` path if
   * instantiation fails — failure is the default state, not an error path.
   * Resolves `true` if WASM is now active.
   */
  public async enableWasmParticles(source: ParticleModuleSource): Promise<boolean> {
    const runtime = await this.ensureWasmRuntime(source);
    if (!runtime) return false;
    this.setParticleBackend(runtime.particle());
    return true;
  }

  /** Internal: called by `Entity._spawnDriver` when a new property driver
   *  starts. See {@link _activeDriverEntities}. */
  public _registerActiveDriverEntity(entity: Entity): void {
    this._activeDriverEntities.add(entity);
  }

  /**
   * Drop `entity` and its whole subtree from the batched-driver candidate set.
   * Called by {@link remove}/{@link hideOverlay} on detach: without this a
   * removed-but-still-animating entity stays pinned in the Set (a leak) and its
   * drivers keep ticking every frame even though it is off-tree. If it is later
   * re-added, {@link registerActiveDriverSubtree} re-registers any node that
   * still has live drivers, so the motion resumes.
   */
  private unregisterActiveDriverSubtree(entity: Entity): void {
    if (this._activeDriverEntities.size === 0) return;
    const stack: Entity[] = [entity];
    while (stack.length > 0) {
      const node = stack.pop()!;
      this._activeDriverEntities.delete(node);
      for (const child of node.children) stack.push(child);
    }
  }

  /**
   * Re-register every node in `entity`'s subtree that still has live property
   * drivers. Called by {@link add}/{@link showOverlay} so re-attaching a subtree
   * that was removed mid-animation resumes its batched drivers (they were
   * dropped from the candidate set on removal, but the driver state still lives
   * on each entity).
   */
  private registerActiveDriverSubtree(entity: Entity): void {
    const stack: Entity[] = [entity];
    while (stack.length > 0) {
      const node = stack.pop()!;
      const entries = node._driverEntries();
      if (entries && entries.size > 0) this._activeDriverEntities.add(node);
      for (const child of node.children) stack.push(child);
    }
  }

  /**
   * Advance every registered entity's active drivers for this frame, batching
   * whichever are batchable (`SpringDriver`; `TweenDriver` with a named
   * easing) through one WASM call each when the driver-count gate is open, and
   * ticking the rest (a `TweenDriver` using a custom `EasingFn`) directly in
   * JS regardless of the gate. A "claimed" entity must have ALL its drivers
   * advanced here so it can be safely stamped `_driversTickedFrame` — leaving
   * one unclaimed would silently stall it, since `tickDrivers()` skips the
   * whole entity once stamped.
   *
   * Must run before ANY entity's `update()`/`tickDrivers()` this frame (see
   * the call site in {@link render}) — the same ordering constraint G1 Stage 4
   * discovered: a value this pass writes must be final before anything reads
   * it, including the JS-mode interleaved walk and the WASM-mode transform
   * pre-pass.
   */
  private _tickBatchedDrivers(dt: number): void {
    if (this._activeDriverEntities.size === 0) {
      // No drivers in flight, so no accelerator declined anything.
      this._animReason = 'not-applicable';
      return;
    }

    // Pass 1 (always, cheap): prune completed entities, count batchable
    // drivers to decide the gate. O(active drivers), never O(tree size).
    // _driverEntries() returns the entity's Map directly (no callback, no
    // per-entity closure allocation).
    let springBatchable = 0;
    let tweenBatchable = 0;
    for (const entity of this._activeDriverEntities) {
      const entries = entity._driverEntries();
      if (!entries || entries.size === 0) {
        this._activeDriverEntities.delete(entity);
        continue;
      }
      for (const driver of entries.values()) {
        if (driver instanceof SpringDriver) springBatchable++;
        else if (driver instanceof TweenDriver && driver.wasmEasingId !== null) tweenBatchable++;
      }
    }
    const batchable = springBatchable + tweenBatchable;

    const backend = this._animWasm;
    // Kind-aware gate. Spring and tween have measurably different break-even
    // points — spring/mixed win from ~128 drivers while pure tween is a 0.71x
    // LOSS there and only turns positive near 256 — so a single scalar gate had
    // to be set for the worse case, giving up the 128-255 spring win to avoid a
    // tween regression. The counts were already separated here; only the
    // threshold was shared.
    //
    // A mixed frame uses the mixed gate: the batch is one call per kind, so its
    // economics track the combined driver count rather than either kind alone.
    this._animBatchedLastFrame = false;
    if (!backend) {
      this._animReason = 'not-installed';
      return; // stay on the JS tick path
    }
    const gate =
      springBatchable > 0 && tweenBatchable > 0
        ? this.animGate.mixed
        : tweenBatchable > 0
          ? this.animGate.tween
          : this.animGate.spring;
    if (batchable < gate) {
      // Working as designed, not a fault: below the measured break-even the JS
      // tick loop is genuinely faster.
      this._animReason = 'below-gate';
      return;
    }
    // Record that the gate actually opened this frame. `animBackend === 'wasm'`
    // only means the backend is INSTALLED, which has misled readers into
    // assuming every frame runs through WASM.
    this._animBatchedLastFrame = true;
    this._animReason = 'active';

    // Pass 2: claim every registered entity. Gather batchable drivers into the
    // reused scratch arrays; tick+finalize non-batchable ones directly in JS;
    // stamp the entity so tickDrivers() skips it later this same frame.
    const sE = this._springEntities;
    const sP = this._springProps;
    const sD = this._springDrivers;
    const tE = this._tweenEntities;
    const tP = this._tweenProps;
    const tD = this._tweenDrivers;
    let springCount = 0;
    let tweenCount = 0;
    for (const entity of this._activeDriverEntities) {
      const entries = entity._driverEntries()!;
      for (const [prop, driver] of entries) {
        if (driver instanceof SpringDriver) {
          sE[springCount] = entity;
          sP[springCount] = prop;
          sD[springCount] = driver;
          springCount++;
        } else if (driver instanceof TweenDriver && driver.wasmEasingId !== null) {
          tE[tweenCount] = entity;
          tP[tweenCount] = prop;
          tD[tweenCount] = driver;
          tweenCount++;
        } else {
          // Custom-easing tween: cannot cross into WASM. Tick it here (same
          // dt, same math as tickDrivers() would use) so the entity as a
          // whole can still be claimed this frame.
          driver.tick(dt);
          entity._applyDriverTick(prop, driver);
        }
      }
      entity._driversTickedFrame = this.currentFrame;
    }
    // Drop stale tail slots beyond this frame's count so a no-longer-active
    // entity/driver from a busier past frame isn't pinned in memory.
    sE.length = springCount;
    sP.length = springCount;
    sD.length = springCount;
    tE.length = tweenCount;
    tP.length = tweenCount;
    tD.length = tweenCount;

    backend.ensure(springCount, tweenCount);
    if (springCount > 0) {
      const sv = backend.springView();
      for (let i = 0; i < springCount; i++) {
        const phys = sD[i].physics;
        sv.val[i] = phys.value;
        sv.target[i] = phys.target;
        sv.vel[i] = phys.velocity;
        sv.stiff[i] = phys.stiffness;
        sv.damp[i] = phys.damping;
        sv.mass[i] = phys.mass;
      }
      if (backend.stepSprings(dt, springCount)) {
        for (let i = 0; i < springCount; i++) sD[i].syncExternal(sv.val[i], sv.vel[i]);
      } else {
        // The kernel declined and wrote nothing, so the views still hold the
        // pre-step state — syncing them back would freeze every spring. Every
        // entity here was already stamped `_driversTickedFrame` above, so
        // tickDrivers() will skip them for the rest of the frame; tick them in
        // JS now (same dt, same math) or they lose the frame entirely.
        for (let i = 0; i < springCount; i++) sD[i].tick(dt);
        this._animReason = 'rejected';
        this._animBatchedLastFrame = false;
      }
    }
    if (tweenCount > 0) {
      const tv = backend.tweenView();
      for (let i = 0; i < tweenCount; i++) {
        const d = tD[i];
        tv.from[i] = d.fromValue;
        tv.to[i] = d.target;
        tv.elapsed[i] = d.elapsedMs;
        tv.dur[i] = d.durationMs;
        tv.delay[i] = d.delayMs;
        tv.ease[i] = d.wasmEasingId!;
      }
      if (backend.stepTweens(dt, tweenCount)) {
        for (let i = 0; i < tweenCount; i++) tD[i].syncExternal(tv.val[i], tv.elapsed[i]);
      } else {
        for (let i = 0; i < tweenCount; i++) tD[i].tick(dt);
        this._animReason = 'rejected';
        this._animBatchedLastFrame = false;
      }
    }

    // Finalize every batchable driver this pass touched (completion check +
    // apply + settle + delete), exactly mirroring tickDrivers()'s own
    // per-driver body — the non-batchable ones were already finalized above.
    for (let i = 0; i < springCount; i++) sE[i]._applyDriverTick(sP[i], sD[i]);
    for (let i = 0; i < tweenCount; i++) tE[i]._applyDriverTick(tP[i], tD[i]);
  }

  /**
   * Compose the whole main tree's world matrices through the resident WASM store
   * and return the world-matrix views for the render walk to read. Rebuilds the
   * store layout (slots + runs) only when the tree structure changed since the
   * last rebuild; otherwise it just gathers current transforms into the resident
   * input view and runs the kernel. Returns `null` if there is no backend.
   */
  private _syncWasmStore(): ReturnType<WasmTransformBackend['worldView']> | null {
    const backend = this._wasm;
    if (!backend) return null;

    if (this._treeStore === null || this._storeStructureVersion !== this._structureVersion) {
      const built = buildTreeStore(this.root);
      const slotEntity = Array.from<Entity>({ length: built.store.count });
      for (const [entity, slot] of built.indexOf) {
        slotEntity[slot] = entity;
        entity._storeSlot = slot;
      }
      // sizes wasm memory + publishes the run table
      if (!backend.uploadRuns(built.store)) {
        // The crate rejected the run count, so the run table still describes the
        // PREVIOUS topology. Composing against it would lay this frame's entities
        // out along last frame's parent links. Leave `_storeStructureVersion`
        // untouched so the next frame retries the rebuild.
        this._transformReason = 'rejected';
        return null;
      }
      this._treeStore = built.store;
      this._slotEntity = slotEntity;
      this._wasmInputs = backend.inputView(); // valid until the next capacity growth
      this._wasmWorld = backend.worldView();
      this._storeStructureVersion = this._structureVersion;
    }

    // Another backend sharing this instance (hit_init allocates its own grid
    // arrays in the same linear memory) may have grown memory and detached these
    // views since the last frame. Re-acquire them before writing, or every write
    // silently lands nowhere.
    backend.revalidateViews();
    if (this._wasmInputs && this._wasmInputs.x.length === 0) {
      this._wasmInputs = backend.inputView();
      this._wasmWorld = backend.worldView();
    }

    // Gather local transforms into the resident input view. Slot 0 is the root,
    // which the kernel seeds to identity, so start at 1. cos/sin come from the
    // Phase-0 per-entity trig cache (recomputed only when rotation changed).
    const inp = this._wasmInputs!;
    const slotEntity = this._slotEntity;
    for (let slot = 1; slot < slotEntity.length; slot++) {
      const e = slotEntity[slot];
      inp.x[slot] = e.x;
      inp.y[slot] = e.y;
      inp.sx[slot] = e.scaleX;
      inp.sy[slot] = e.scaleY;
      const trig = e._getTrig();
      inp.cos[slot] = trig.cos;
      inp.sin[slot] = trig.sin;
      inp.opacity[slot] = e.opacity;
    }
    if (backend.runKernel('simd') !== WASM_STATUS.OK) {
      // A rejected kernel wrote nothing, so the world views still hold the
      // PREVIOUS frame's matrices. Returning them would render last frame's
      // geometry as if it were current — the batch `compose()` path already
      // guards this; the resident path did not. Returning null routes the render
      // walk through JS composition, which is the permanent fallback.
      this._transformReason = 'rejected';
      return null;
    }
    // The world matrices just changed, so any AABBs computed from the previous
    // frame's matrices are stale. They are recomputed on demand rather than every
    // frame: a pointer query happens ad-hoc, and most frames never need them.
    this._wasmAabbsFresh = false;
    this._transformReason = 'active';
    return this._wasmWorld;
  }

  /**
   * Run the WASM world-AABB pass over the current frame's world matrices, so the
   * fused hit gather can read AABBs straight out of the store.
   *
   * Local bounds are uploaded here rather than in the per-frame transform sync
   * because `getBounds()` is a virtual call that allocates a rect on most
   * entities — paying it every frame for a query that may never come would move
   * cost onto the render path to save it on hover. Returns `false` if any entity
   * cannot supply bounds through the store, so the caller uses the JS gather.
   */
  private _ensureWasmAabbs(): boolean {
    const backend = this._wasm;
    const store = this._treeStore;
    if (!backend || !store) return false;
    if (this._wasmAabbsFresh) return true;

    backend.revalidateViews();
    const bounds = backend.boundsView();
    const slotEntity = this._slotEntity;
    for (let slot = 0; slot < slotEntity.length; slot++) {
      const e = slotEntity[slot];
      if (!e) continue;
      const b = e.getBounds();
      // A boundless entity keeps zeroed bounds; the fused gather routes it
      // through `boundless` and never reads its AABB slots.
      bounds.bx[slot] = b ? b.x : 0;
      bounds.by[slot] = b ? b.y : 0;
      bounds.bw[slot] = b ? b.width : 0;
      bounds.bh[slot] = b ? b.height : 0;
    }
    // A rejected pass leaves the store's AABB slots holding the previous
    // frame's bounds. Marking them fresh anyway would hand the fused gather
    // stale geometry and silently mis-hit every pointer event this frame, so
    // report failure and let the caller fall back to the JS gather.
    if (!backend.runAabbs(slotEntity.length)) return false;
    this._wasmAabbsFresh = true;
    return true;
  }

  /**
   * Authoritative paint order for semantic nodes discovered during the main
   * render. A node may not have a DOM projection until the following a11y
   * sync, so retaining the order prevents a newly opened overlay from spending
   * its first frame below previously projected controls.
   */
  private a11yRenderOrders: Map<string, number> = new Map();

  // Optional WebGL point-cloud layer (see SceneOptions.pointBackend).
  private pointRenderer: PointRenderer | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private glContextLostHandler: ((e: Event) => void) | null = null;
  private glContextRestoredHandler: (() => void) | null = null;
  private debugA11y: boolean;
  public width: number;
  public height: number;
  private disableWindowResize: boolean = false;
  /** See {@link SceneOptions.maxDPR}. `undefined` = uncapped (real DPR). */
  public maxDPR?: number;

  // WebGPU properties
  private destroyed: boolean = false;
  private device: GPUDevice | null = null;
  private deviceLost: boolean = false;
  public particleBackend: 'auto' | 'webgpu' | 'cpu' = 'auto';
  private _webgpuDisabled: boolean = false;
  public get webgpuDisabled(): boolean {
    return this._webgpuDisabled || this.particleBackend === 'cpu';
  }

  /**
   * Draw accounting for the WebGL point layer, or null when that layer is not in
   * use.
   *
   * Null and all-zero mean different things: null is "this backend is not
   * running", zero is "it ran and drew nothing". A readout that conflates them
   * sends someone looking for a performance problem in a backend that was never
   * active.
   */
  public get webglDrawStats(): WebGLDrawStats | null {
    return this.pointRenderer?.stats?.() ?? null;
  }

  /**
   * Whether a WebGPU device is currently live for particle compute.
   *
   * The WebGPU path only activates when a `ComputeParticleEntity` is present, so
   * most scenes never touch it.
   */
  public get webgpuActive(): boolean {
    return this.device !== null && !this.deviceLost;
  }
  public set webgpuDisabled(value: boolean) {
    this._webgpuDisabled = value;
  }
  private recoveryTimerId: any = null;
  private manager: WebGPUParticleSystemManager | null = null;
  private initializingWebGPU: boolean = false;
  private gpuCanvas: HTMLCanvasElement | null = null;
  private gpuContext: any = null;
  /** True while the GPU canvas holds a presented particle frame (needs clearing when they leave). */
  private gpuHasContent: boolean = false;
  private mouseX: number = -9999;
  private mouseY: number = -9999;
  private pointerMoveListener: ((e: PointerEvent) => void) | null = null;
  private pointerLeaveListener: (() => void) | null = null;
  /** Element the pointer listeners are bound to (parent container if present,
   *  else the canvas). Stored so `destroy()` detaches from the same element. */
  private pointerEventTarget: HTMLElement | null = null;
  private hasWarnedZeroSize: boolean = false;
  private fontLoadHandler: (() => void) | null = null;

  // ── Dev-mode warning infrastructure ──────────────────────────────
  //
  // Enable with `Scene.devMode = true` or by setting `globalThis.__DEV__`.
  // Auto-detected when `NODE_ENV === 'development'`.
  //
  // Checks run once every ~120 frames (~2s at 60fps) to keep overhead
  // negligible even when dev mode is on.

  private static _devMode = false;

  /**
   * Toggle development-mode runtime warnings globally.
   *
   * An accessor rather than a plain field so the renderer layer learns about it
   * immediately: renderers cannot import `Scene` (the dependency runs
   * `Scene → renderer`), and their diagnostics are installed per instance at
   * construction. A plain field would only reach them the next time a `Scene`
   * happened to be built, which made a directly-constructed `CanvasRenderer`
   * silently untrapped.
   */
  public static get devMode(): boolean {
    return Scene._devMode;
  }

  public static set devMode(active: boolean) {
    Scene._devMode = active;
    setRendererDevMode(active);
  }

  private static _devModeDetected(): boolean {
    if (Scene._devMode) return true;
    const gp = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
    if (gp?.__DEV__) return true;
    if (gp?.process?.env?.NODE_ENV === 'development') return true;
    return false;
  }

  private _devActive: boolean;
  private _devFrameCount = 0;

  private _devWarn(message: string): void {
    if (!this._devActive) return;
    console.warn(`[vectojs/dev] ${message}`);
  }

  /**
   * Warn (dev mode only) about `SceneOptions` keys this version does not read.
   *
   * A structural type makes an unrecognized key a silent no-op, and TypeScript
   * only rejects one when the object literal sits inline at the call site — not
   * when options are built dynamically, and never in plain JS. Since the
   * failure mode is "the option appears to work", a runtime check is the only
   * thing that surfaces it.
   *
   * Dev-mode only on purpose: the loop is O(keys × known keys) with an edit
   * distance per pair, which is nothing at construction but is still pure
   * overhead in production, where the value has already been shipped.
   */
  private _warnUnknownOptions(options: SceneOptions): void {
    if (!this._devActive) return;
    const known = new Set<string>(SCENE_OPTION_KEYS);
    for (const key of Object.keys(options)) {
      if (known.has(key)) continue;
      const fieldHint = SCENE_FIELD_NOT_OPTION[key];
      if (fieldHint) {
        this._devWarn(
          `SceneOptions: \`${key}\` is not a constructor option — ${fieldHint}. ` +
            `Passing it here has no effect.`,
        );
        continue;
      }
      const suggestion = closestOptionKey(key);
      this._devWarn(
        `SceneOptions: unknown option \`${key}\` is ignored.` +
          (suggestion ? ` Did you mean \`${suggestion}\`?` : ''),
      );
    }
  }

  /** @internal Periodic dev checks — called once per frame in dev mode. */
  private _devRunChecks(): void {
    this._devFrameCount++;
    if (this._devFrameCount % 120 !== 0) return; // ~every 2s

    // 1. detachA11y leak detection
    if (this.a11yElements) {
      // Count with the same predicate that decides projection, so the
      // comparison is exact. This previously tested `interactive && width > 0`,
      // which undercounts `a11yFullViewport` nodes (projected with width 0) and
      // needed a `+2` fudge to avoid false positives — that slack also hid real
      // leaks of one or two elements.
      let projectableCount = 0;
      const walk = (node: Entity): void => {
        if (this.shouldProjectA11y(node)) projectableCount++;
        for (const c of node.children) walk(c);
      };
      walk(this.root);
      for (const c of this.overlayRoot.children) walk(c);

      const shadowCount = this.a11yElements.size;
      if (shadowCount > projectableCount) {
        this._devWarn(
          `a11yElements (${shadowCount}) exceeds projectable entities (${projectableCount}). ` +
            'Call scene.detachA11y(entity) before removing interactive children ' +
            'from the tree, or their shadow nodes leak.',
        );
      }
    }

    // 2. Content projection mismatch — spot-check a few entities
    let checked = 0;
    const walkProjections = (node: Entity): void => {
      if (checked > 10) return; // limit per frame
      const proj = node.getContentProjection?.();
      if (proj?.text && proj.selectable !== false) {
        const el = this.contentElements?.get(node.id);
        if (el) {
          const projectedText = el.textContent || '';
          // A line-windowed entity holds a deliberate SUBSET of its text: the
          // carriers outside the viewport band are not materialized, so an
          // equality check here would warn on every tall document. Require
          // containment instead, which still catches genuinely wrong text.
          const windowed = el.dataset.vectoProjectionWindow !== undefined;
          const mismatched = windowed
            ? !proj.text.includes(projectedText)
            : projectedText !== proj.text;
          // If the projection text differs from what's in the DOM, warn
          if (projectedText !== '' && mismatched) {
            this._devWarn(
              `Content projection mismatch for entity "${node.id}": ` +
                `projection says "${proj.text.slice(0, 60)}" ` +
                `but DOM shows "${projectedText.slice(0, 60)}". ` +
                'Ensure getContentProjection() output matches what drawSelf renders.',
            );
          }
        }
      }
      checked++;
      for (const c of node.children) walkProjections(c);
    };
    walkProjections(this.root);
  }

  constructor(canvas: HTMLCanvasElement, options: SceneOptions = {}) {
    this.canvas = canvas;
    this.debugA11y = options.debugA11y ?? false;
    this.disableWindowResize = options.disableWindowResize ?? false;
    this.maxDPR = options.maxDPR;
    if (this.disableWindowResize) {
      // Prefer the inline px style: it's where the renderer records the
      // *logical* size. On a remount, canvas.width holds the previous
      // renderer's DPR-scaled backing store — reading it as logical would
      // compound the scale on every mount (400 → 800 → 1600 at DPR 2).
      const styleWidth = parseInlinePx(canvas.style?.width);
      const styleHeight = parseInlinePx(canvas.style?.height);
      this.width = styleWidth ?? (canvas.width || canvas.clientWidth || 0);
      this.height = styleHeight ?? (canvas.height || canvas.clientHeight || 0);
    } else {
      this.width =
        typeof window !== 'undefined'
          ? window.innerWidth
          : canvas.clientWidth || canvas.width || 800;
      this.height =
        typeof window !== 'undefined'
          ? window.innerHeight
          : canvas.clientHeight || canvas.height || 600;
    }
    const globalProcess =
      typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined;
    const isTest =
      globalProcess &&
      (globalProcess.env?.NODE_ENV === 'test' || globalProcess.env?.VITEST === 'true');
    this.maxFPS = options.maxFPS ?? (isTest ? 0 : 60);
    this.respectReducedMotion = options.respectReducedMotion ?? true;
    this.autoThrottle = options.autoThrottle ?? true;
    this._userTiming = options.userTiming ?? false;
    this.particleBackend = options.particleBackend ?? 'auto';
    this.a11ySyncInterval = options.a11ySyncInterval ?? 0;
    this.contentProjectionEnabled = options.contentProjection ?? true;
    this.contentProjectionMargin = options.contentProjectionMargin;
    this.contentSemanticMargin = options.contentSemanticMargin;
    this.contentSemanticBudget = options.contentSemanticBudget ?? DEFAULT_CONTENT_SEMANTIC_BUDGET;
    this.readingDirection = options.readingDirection ?? 'ltr';
    this.renderMode = options.renderMode ?? 'always';
    this._devActive = Scene._devModeDetected();
    // The renderer layer cannot import Scene (the dependency runs the other
    // way), so publish dev state to it instead of having it reach back.
    setRendererDevMode(this._devActive);
    // Validate before anything else uses the options, so a typo is reported
    // even if a later step throws on the resulting bad state.
    this._warnUnknownOptions(options);
    this.reducedMotionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    // Forced-colors (High Contrast): repaint when it toggles so components can
    // swap to system colors. Read live via the `forcedColors` getter otherwise.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.forcedColorsQuery = window.matchMedia('(forced-colors: active)');
      this.forcedColorsChangeHandler = () => this.markDirty();
      this.forcedColorsQuery.addEventListener?.('change', this.forcedColorsChangeHandler);
    }
    this.root = new (class RootEntity extends Entity {
      isPointInside() {
        return false;
      }
      // Root renders nothing itself — renderNode() handles all child traversal.
      render(_r: any) {}
    })('root');
    (this.root as any)._scene = this;

    this.overlayRoot = new (class OverlayRoot extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    })('overlayRoot');
    (this.overlayRoot as any)._scene = this;

    if (options.renderer) {
      this.renderer = options.renderer;
    } else {
      // Embedded scenes (disableWindowResize) keep the canvas's own size; the
      // default fullscreen path lets CanvasRenderer size to the window.
      this.renderer = new CanvasRenderer(
        canvas,
        this.disableWindowResize ? { width: this.width, height: this.height } : undefined,
        this.maxDPR,
      );
    }
    // Repaint after a lost drawing context is restored (the canvas comes back
    // cleared). markDirty covers onDemand; the direct render covers a paused/
    // idle loop so the scene doesn't stay blank until the next interaction.
    this.renderer.onContextRestored?.(() => {
      this.markDirty();
      if (this.renderer.isContextLost?.() !== true) this.render(this.renderer);
    });

    // Setup Agent / Automation Semantic Layer (only where there's a DOM).
    if (typeof document !== 'undefined') {
      this.a11yRoot = document.createElement('div');
      // Marks the projected layer so an audit can scope to it instead of the
      // whole document (the embedding page's own markup is not ours to fix).
      // `packages/ui/e2e/axe-audit.e2e.ts` selects on this; before it existed
      // that selector fell through to `body` and silently audited the harness.
      this.a11yRoot.setAttribute('data-vecto-a11y-root', '');
      this.a11yRoot.style.position = 'absolute';
      this.a11yRoot.style.top = '0';
      this.a11yRoot.style.left = '0';
      this.a11yRoot.style.width = '100vw';
      this.a11yRoot.style.height = '100vh';
      this.a11yRoot.style.pointerEvents = 'none';
      this.a11yRoot.style.overflow = 'hidden';
      this.a11yRoot.style.zIndex = '10'; // Render above canvas
      // Let text selection span across multiple content projection divs.
      // Individual divs opt in via pointer-events:auto; during an active drag
      // the root temporarily gains pointer-events so the browser can extend
      // the Selection Range beyond any single entity's bounds.
      this.a11yRoot.style.userSelect = 'text';

      // Focus sentinel: a zero-size, programmatically-focusable-only element
      // that catches focus when the currently-focused mirror is removed, so a
      // virtualized/streamed-away control doesn't dump focus onto <body> (which
      // yanks a screen reader out of the app region and back to the page top).
      this.focusSentinel = document.createElement('div');
      this.focusSentinel.setAttribute('data-vecto-focus-sentinel', '');
      this.focusSentinel.tabIndex = -1;
      this.focusSentinel.style.position = 'absolute';
      this.focusSentinel.style.width = '0';
      this.focusSentinel.style.height = '0';
      this.focusSentinel.style.outline = 'none';
      this.focusSentinel.style.overflow = 'hidden';
      this.a11yRoot.appendChild(this.focusSentinel);

      this.a11yRoot.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // Only promote when the mousedown lands on a selectable content div.
        const target = e.target as HTMLElement;
        const contentEl = target.closest('[data-vecto-content]') as HTMLElement | null;
        if (target === this.a11yRoot || !contentEl) return;
        if (getComputedStyle(contentEl).pointerEvents !== 'auto') return;
        const selection = window.getSelection();
        if (!selection) return;
        this.a11yRoot!.style.pointerEvents = 'auto';
        // Transparent absolute projections expose browser inconsistencies at
        // CSS zoom: Chromium can hit the correct node yet derive its native
        // caret from the document origin. Resolve the source anchor from the
        // projection's own Range geometry for both ink and blank regions.
        const resolved = nearestTextPositionInProjection(
          contentEl,
          this.canvas,
          e.clientX,
          e.clientY,
          target,
        );
        if (resolved) {
          if (e.detail >= 2) {
            selection.removeAllRanges();
            selectProjectionUnit(selection, contentEl, resolved, e.detail >= 3 ? 'line' : 'word');
            this.endContentSelectionDrag();
            e.preventDefault();
            return;
          }
          const existingAnchor =
            e.shiftKey && selection.anchorNode instanceof Text
              ? { node: selection.anchorNode, offset: selection.anchorOffset }
              : null;
          const anchor =
            existingAnchor && this.a11yRoot!.contains(existingAnchor.node)
              ? existingAnchor
              : resolved;
          if (e.shiftKey && existingAnchor) extendSelection(selection, anchor, resolved);
          else selection.collapse(resolved.node, resolved.offset);
          this.contentSelectionAnchor = anchor;
          this.blankRegionSelectionDrag = true;
          e.preventDefault();
        }
      });
      this.a11yRoot.addEventListener('dblclick', (e) => {
        const target = e.target as HTMLElement;
        const contentEl = target.closest('[data-vecto-content]') as HTMLElement | null;
        if (!contentEl || getComputedStyle(contentEl).pointerEvents !== 'auto') return;
        const selection = window.getSelection();
        const caret = nearestTextPositionInProjection(
          contentEl,
          this.canvas,
          e.clientX,
          e.clientY,
          target,
        );
        if (!selection || !caret) return;
        selection.removeAllRanges();
        selectProjectionUnit(selection, contentEl, caret, 'word');
        this.endContentSelectionDrag();
        e.preventDefault();
      });
      this.a11yRoot.addEventListener('mousemove', (e) => {
        if (!this.blankRegionSelectionDrag) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const target = e.target as HTMLElement;
        let contentEl = target.closest('[data-vecto-content]') as HTMLElement | null;
        if (!contentEl) {
          let bestDistance = Infinity;
          for (const candidate of this.contentElements.values()) {
            if (getComputedStyle(candidate).pointerEvents !== 'auto') continue;
            const rect = candidate.getBoundingClientRect();
            const dx =
              e.clientX < rect.left
                ? rect.left - e.clientX
                : e.clientX > rect.right
                  ? e.clientX - rect.right
                  : 0;
            const dy =
              e.clientY < rect.top
                ? rect.top - e.clientY
                : e.clientY > rect.bottom
                  ? e.clientY - rect.bottom
                  : 0;
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
              bestDistance = distance;
              contentEl = candidate;
            }
          }
        }
        const focus = contentEl
          ? nearestTextPositionInProjection(contentEl, this.canvas, e.clientX, e.clientY, target)
          : null;
        const anchor = this.contentSelectionAnchor;
        if (focus && anchor) {
          extendSelection(selection, anchor, focus);
        }
      });
      const endDrag = () => this.endContentSelectionDrag();
      this.a11yRoot.addEventListener('mouseup', endDrag);
      // Pointer may leave the overlay entirely (e.g. moving above the viewport).
      this.a11yRoot.addEventListener('mouseleave', endDrag);
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('blur', endDrag);
      this.contentSelectionEndListener = endDrag;
      if (canvas.parentElement) {
        canvas.parentElement.appendChild(this.a11yRoot);
      }

      this.portalRoot = document.createElement('div');
      this.portalRoot.style.position = 'absolute';
      this.portalRoot.style.top = '0';
      this.portalRoot.style.left = '0';
      this.portalRoot.style.width = '100vw';
      this.portalRoot.style.height = '100vh';
      this.portalRoot.style.pointerEvents = 'none';
      this.portalRoot.style.overflow = 'hidden';
      this.portalRoot.style.zIndex = '9'; // Placed below a11yRoot
      if (canvas.parentElement) {
        canvas.parentElement.appendChild(this.portalRoot);
      }
    } else {
      this.a11yRoot = null;
      this.portalRoot = null;
    }

    // Optional WebGL2 point-cloud layer, stacked above the 2D canvas (below a11y).
    if (options.pointBackend === 'webgl' && typeof document !== 'undefined') {
      const gl = document.createElement('canvas');
      gl.style.position = 'absolute';
      gl.style.top = '0';
      gl.style.left = '0';
      gl.style.pointerEvents = 'none';
      gl.style.zIndex = '5';
      if (canvas.parentElement) canvas.parentElement.appendChild(gl);
      const pr = Scene.webglCreator ? Scene.webglCreator(gl) : null;
      if (pr) {
        pr.maxDPR = this.maxDPR;
        pr.resize(this.width, this.height);
        this.glCanvas = gl;
        this.pointRenderer = pr;
        // A brand-new layer has never been positioned; force the next geometry
        // sync to write instead of short-circuiting on an unchanged box.
        this._overlayGeometry = null;
        this.setupGLContextRecovery(gl);
      } else {
        gl.remove(); // WebGL2 unavailable → fall back to the Canvas2D batch
      }
    }

    this.resizeHandler = () => {
      this.resize(window.innerWidth, window.innerHeight);
    };

    if (typeof document !== 'undefined' && document.fonts) {
      this.fontLoadHandler = () => {
        clearCssLineBoxMetrics();
        this.contentFontEpoch++;
        this.markDirty();
      };
      document.fonts.ready.then(this.fontLoadHandler);
      document.fonts.addEventListener('loadingdone', this.fontLoadHandler);
    }

    this.setupEvents();
  }

  /**
   * Arm a `(resolution: Ndppx)` media query for the current devicePixelRatio and
   * re-apply the canvas scale when it changes. Such a query only fires when the
   * DPR leaves its exact value, so on each change the old query is detached and
   * a fresh one is armed for the new DPR. Re-runs `resize(width, height)` (which
   * re-scales the backing store via the renderer) so text/vectors stay crisp
   * after a monitor move or zoom. No-op without `matchMedia`.
   */
  private watchDevicePixelRatio(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    // Tear down any previously-armed query first.
    if (this.dprMediaQuery && this.dprChangeHandler) {
      this.dprMediaQuery.removeEventListener?.('change', this.dprChangeHandler);
    }
    const dpr = window.devicePixelRatio || 1;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const handler = () => {
      // Re-scale the backing store for the new DPR, then re-arm for the next
      // change (the fired query is now stale for the new ratio).
      this.resize(this.width, this.height);
      this.watchDevicePixelRatio();
    };
    query.addEventListener?.('change', handler);
    this.dprMediaQuery = query;
    this.dprChangeHandler = handler;
  }

  /**
   * Recover the WebGL point layer from a GPU context loss (driver TDR reset,
   * tab backgrounded on mobile, GPU switch). Two things are required:
   *
   *  1. The `webglcontextlost` handler MUST call `preventDefault()`, or the
   *     browser never fires `webglcontextrestored` and the layer is blank
   *     forever. While lost, the old renderer's GL calls are silently ignored,
   *     so we drop it and the render loop simply skips the point layer.
   *  2. On `webglcontextrestored`, all GL objects (programs, buffers, textures)
   *     are gone, so we rebuild the renderer from scratch via `Scene.webglCreator`
   *     on the same canvas, restore DPR/size, and repaint.
   */
  private setupGLContextRecovery(gl: HTMLCanvasElement): void {
    if (typeof gl.addEventListener !== 'function') return;
    this.glContextLostHandler = (e: Event) => {
      e.preventDefault(); // mandatory — otherwise 'restored' never fires
      this.pointRenderer?.destroy();
      this.pointRenderer = null;
    };
    this.glContextRestoredHandler = () => {
      if (this.destroyed || !this.glCanvas) return;
      const pr = Scene.webglCreator ? Scene.webglCreator(this.glCanvas) : null;
      if (pr) {
        pr.maxDPR = this.maxDPR;
        pr.resize(this.width, this.height);
        this.pointRenderer = pr;
        this.markDirty();
      }
    };
    gl.addEventListener('webglcontextlost', this.glContextLostHandler);
    gl.addEventListener('webglcontextrestored', this.glContextRestoredHandler);
  }

  private endContentSelectionDrag(): void {
    this.blankRegionSelectionDrag = false;
    this.contentSelectionAnchor = null;
    if (this.a11yRoot) this.a11yRoot.style.pointerEvents = 'none';
  }

  /**
   * Index of the carrier line currently holding a selection inside `el`, or
   * `null`.
   *
   * Lets a partial re-materialization decide whether the user's selection is even
   * affected. Checks the tracked anchor first (it survives a drag) and falls back
   * to the live DOM selection.
   */
  private contentGridSelectionLine(el: HTMLElement): number | null {
    const candidates: Array<Node | null | undefined> = [this.contentSelectionAnchor?.node];
    if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
      const selection = window.getSelection();
      candidates.push(selection?.anchorNode, selection?.focusNode);
    }
    for (const candidate of candidates) {
      if (!candidate || !el.contains(candidate)) continue;
      // Walk up to the direct child of `el`, which is the carrier line.
      let cursor: Node | null = candidate;
      while (cursor && cursor.parentNode !== el) cursor = cursor.parentNode;
      const lineIndex = (cursor as HTMLElement | null)?.dataset?.vectoGridLine;
      if (lineIndex !== undefined) return Number(lineIndex);
    }
    return null;
  }

  /**
   * Does the document hold a selection right now, memoized for this sync walk?
   *
   * Pays one forced layout per walk instead of one per rebuilt element — see
   * {@link Scene.contentSelectionPresentThisSync} for the measurements. When the
   * answer is `false` no element can own a selection, so every per-element
   * ownership test can be skipped without touching the object.
   */
  private contentSelectionPresent(): boolean {
    if (this.contentSelectionPresentThisSync !== null) {
      return this.contentSelectionPresentThisSync;
    }
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    // `anchorNode`/`focusNode` rather than `rangeCount`: a collapsed caret still
    // has an anchor and still belongs to whoever contains it, and every property
    // costs the same single forced layout anyway.
    const present = !!selection && (!!selection.anchorNode || !!selection.focusNode);
    this.contentSelectionPresentThisSync = present;
    return present;
  }

  private releaseContentSelectionForRebuild(el: HTMLElement): void {
    // Cheap rejection first. `contentSelectionAnchor` is the scene's own field so
    // it costs nothing, and the memo costs one forced layout per sync walk rather
    // than one per element. With neither an anchor nor a document selection there
    // is nothing to release — the case for every block of a bulk materialization.
    if (!this.contentSelectionAnchor && !this.contentSelectionPresent()) return;
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    const ownsSelection =
      (this.contentSelectionAnchor && el.contains(this.contentSelectionAnchor.node)) ||
      (selection?.anchorNode ? el.contains(selection.anchorNode) : false) ||
      (selection?.focusNode ? el.contains(selection.focusNode) : false);
    if (!ownsSelection) return;
    this.endContentSelectionDrag();
    selection?.removeAllRanges();
    // The memo described the document before this release; it no longer does.
    this.contentSelectionPresentThisSync = null;
  }

  /**
   * Rebuild a content-projection element's DOM (`rebuild`) while preserving a
   * text selection the user made inside it. A streaming message replaces its
   * projection children on every appended chunk; without this, a selection in
   * the UNCHANGED prefix is wiped on each frame ("can't select text in a
   * message still receiving tokens"). We snapshot the selection's anchor/focus
   * as linear character offsets within `el` before the rebuild and re-resolve
   * them against the new DOM after, clamped to the new text length.
   *
   * Only fires when `el` owns the current selection and there is no active drag
   * (mid-drag the browser is authoritative). The virtualization case — where
   * `el` itself is removed from the DOM — is out of scope here (the node is
   * genuinely freed; the browser clears the selection and there is nothing to
   * restore against).
   */
  private preserveContentSelectionAcrossRebuild(el: HTMLElement, rebuild: () => void): void {
    // Nothing selected anywhere in the document means nothing to preserve and
    // nothing to release, so rebuild without touching the Selection object. This
    // is the bulk-materialization path, where reading a selection property would
    // force a layout over the whole projection subtree once per block — see
    // {@link Scene.contentSelectionPresentThisSync}.
    if (!this.contentSelectionAnchor && !this.contentSelectionPresent()) {
      rebuild();
      return;
    }
    const selection =
      typeof window !== 'undefined' && typeof window.getSelection === 'function'
        ? window.getSelection()
        : null;
    const owns =
      !!selection &&
      !this.blankRegionSelectionDrag &&
      ((selection.anchorNode ? el.contains(selection.anchorNode) : false) ||
        (selection.focusNode ? el.contains(selection.focusNode) : false));

    if (!owns || !selection.anchorNode || !selection.focusNode) {
      // Nothing to preserve — fall back to the plain release + rebuild.
      this.releaseContentSelectionForRebuild(el);
      rebuild();
      return;
    }

    // Snapshot as linear offsets within this element's text. Selection
    // endpoints are only meaningful to the offset walk when they are text
    // nodes; a non-Text endpoint yields null and we skip restore.
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const anchorOffset =
      anchorNode instanceof Text
        ? projectionAbsoluteOffset(el, {
            node: anchorNode,
            offset: selection.anchorOffset,
          })
        : null;
    const focusOffset =
      focusNode instanceof Text
        ? projectionAbsoluteOffset(el, {
            node: focusNode,
            offset: selection.focusOffset,
          })
        : null;

    this.endContentSelectionDrag();
    selection.removeAllRanges();
    rebuild();

    if (anchorOffset === null || focusOffset === null) return;
    const textLen = (el.textContent ?? '').length;
    if (anchorOffset > textLen || focusOffset > textLen) return; // selection ran into removed tail
    const anchor = projectionCaretAt(el, anchorOffset, 'forward');
    const focus = projectionCaretAt(el, focusOffset, 'backward');
    if (!anchor || !focus) return;
    try {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } catch {
      // Engine rejected a reverse/cross-node range — leave selection cleared.
    }
  }

  /**
   * Expose the underlying {@link IRenderer} for advanced direct-draw operations.
   *
   * @returns The active renderer instance.
   */
  public getRenderer(): IRenderer {
    return this.renderer;
  }

  /** Convert browser viewport coordinates into this Scene's logical coordinates. */
  public clientToScene(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect?.();
    if (!rect) return { x: clientX, y: clientY };
    const cssWidth = rect.width || this.canvas.clientWidth || this.width;
    const cssHeight = rect.height || this.canvas.clientHeight || this.height;
    return {
      x: (clientX - rect.left) * (cssWidth > 0 ? this.width / cssWidth : 1),
      y: (clientY - rect.top) * (cssHeight > 0 ? this.height / cssHeight : 1),
    };
  }

  /**
   * Add a top-level entity to the scene graph.
   *
   * @param entity - The entity to attach to the scene root.
   * @returns `this` for method chaining.
   * @example scene.add(new CircleEntity());
   */
  public add(entity: Entity): this {
    this.root.add(entity);
    this.registerActiveDriverSubtree(entity);
    return this;
  }

  /**
   * Reset per-grid calibration and bookkeeping before a (re)materialization.
   *
   * @param entityId - Owning entity, keyed into the calibration maps.
   * @param el - The projection element.
   * @param releaseSelection - Whether to drop a selection this element owns.
   *   Pass `false` when carrier lines are being reused: the selection's DOM nodes
   *   survive the pass, so tearing it down would wipe a user's selection on every
   *   streamed chunk — the exact bug `preserveContentSelectionAcrossRebuild`
   *   exists to prevent on the non-grid path.
   */
  private clearContentGridState(entityId: string, el: HTMLElement, releaseSelection = true): void {
    const calibrationFrame = this.contentGridCalibrationFrames.get(entityId);
    if (calibrationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(calibrationFrame);
    }
    this.contentGridCalibrationFrames.delete(entityId);
    this.contentGridCalibrationProbes.get(entityId)?.remove();
    this.contentGridCalibrationProbes.delete(entityId);
    delete el.dataset.vectoGridCalibrationPending;
    delete el.dataset.vectoGridCalibration;
    delete el.dataset.vectoGridReady;
    delete el.dataset.vectoContentGrid;
    delete el.dataset.vectoGridCarriers;
    delete el.dataset.vectoGridMaterializeMs;
    delete el.dataset.vectoGridCalibrationSamples;
    delete el.dataset.vectoGridCalibrationMs;
    if (releaseSelection) this.releaseContentSelectionForRebuild(el);
  }

  /**
   * Drop any projected elements under `node` without touching the entity tree.
   *
   * Used when the walk reaches an invisible subtree: the entities stay put (a
   * later `show()` re-projects them), but nothing under here may remain
   * focusable or announced while hidden.
   */
  private pruneA11ySubtree(node: Entity): void {
    if (this.a11yElements.has(node.id) || this.contentElements.has(node.id)) {
      this.removeA11yRecursively(node);
      return;
    }
    for (const child of node.children) this.pruneA11ySubtree(child);
  }

  private removeA11yRecursively(node: Entity) {
    if (node.isDOMPortal) {
      // Release the portal's ResizeObserver + DOM listeners, not just its
      // element — otherwise a `scene.remove()` (which routes here) leaves the
      // observer connected, keeping the detached element alive and firing.
      // The next projection frame re-attaches them if the portal is re-added.
      (node as DOMPortalEntity).releaseDOMBindings();
      (node as any).domElement.remove();
      this.portalEntities.delete(node.id);
      this.activePortalsThisFrame.delete(node.id);
      this.activePortalsPrevFrame.delete(node.id);
    }
    // Content projections must go with their entity: a surviving node is
    // still selectable (pointer-events: auto), still find-in-page-able at its
    // stale position, and leaks — the same orphan class as a11y elements.
    const contentEl = this.contentElements.get(node.id);
    if (contentEl) {
      this.clearContentGridState(node.id, contentEl);
      contentEl.remove();
      this.contentElements.delete(node.id);
      this.contentSyncState.delete(node.id);
      this.a11yNeedsReorder = true;
    }
    const el = this.a11yElements.get(node.id);
    if (el) {
      if (el === this.focusedA11yElement) {
        this.focusedA11yElement = null;
        if (this.caretBlinkTimer) {
          clearInterval(this.caretBlinkTimer);
          this.caretBlinkTimer = null;
        }
      }
      // Hover is driven by the shadow element's mouseenter/mouseleave. Detaching
      // it fires no `mouseleave`, so an entity removed WHILE hovered would keep
      // its hover state forever — visible the moment it's re-added (a pooled
      // virtualized row, a reopened menu) as hover styling with no pointer over
      // it. Synthesize the leave before the element goes away.
      if (this.hoveredA11yElements.has(el)) {
        this.hoveredA11yElements.delete(el);
        node.dispatchEvent(new VectoJSEvent('pointerleave', node, undefined, false));
      }
      this.preserveFocusOnRemoval(el);
      el.remove();
      this.a11yElements.delete(node.id);
      this.a11yNeedsReorder = true;
    }
    for (const child of node.children) {
      this.removeA11yRecursively(child);
    }
  }

  /**
   * If `el` is about to be removed from the DOM while it holds browser focus,
   * move focus to the a11y focus sentinel first. Removing the active element
   * otherwise drops focus to `<body>`, which pulls a screen reader out of the
   * scene's a11y region and back to the top of the page — the classic
   * "lost my place on scroll/stream" bug for virtualized/recycled controls.
   */
  private preserveFocusOnRemoval(el: HTMLElement): void {
    if (!this.focusSentinel || typeof document === 'undefined') return;
    if (document.activeElement !== el) return;
    // Sentinel lives in a11yRoot; focusing it keeps the active element inside
    // the app region. preventScroll avoids a jump on refocus.
    this.focusSentinel.focus({ preventScroll: true });
  }

  /**
   * Remove a top-level entity from the scene graph and clean up its
   * accessibility shadow elements recursively.
   *
   * @param entity - The entity to detach from the scene root.
   * @returns `this` for method chaining.
   */
  public remove(entity: Entity): this {
    this.root.remove(entity);
    this.removeA11yRecursively(entity);
    this.unregisterActiveDriverSubtree(entity);
    return this;
  }

  /**
   * Tear down the a11y/automation shadow nodes for `entity` and its descendants
   * without removing it from the scene graph. Components that manage dynamic
   * interactive *child* entities (e.g. a {@link Entity}'s per-link hotspots) call
   * this before discarding those children so their shadow `<a>`/controls don't
   * leak.
   *
   * `syncA11y` itself only creates and updates, never prunes — but it is always
   * followed by `enforceA11yDomOrder`, whose prune pass removes any element
   * whose entity is no longer reachable in the tree or no longer satisfies
   * {@link shouldProjectA11y}. So an entity that is `remove()`d, or whose
   * `interactive` flips to `false`, has its element torn down on the next synced
   * frame without any explicit call.
   *
   * This method is for the case that pass cannot see: a child dropped from a
   * component's own bookkeeping while still parented, or one discarded before
   * the next sync runs. Calling it is always safe and is the right habit for
   * pooled children.
   *
   * @param entity - The subtree whose shadow nodes should be removed.
   */
  public detachA11y(entity: Entity): void {
    // removeA11yRecursively prunes a11y elements, DOM portals, AND content
    // projections for the whole subtree.
    this.removeA11yRecursively(entity);
  }

  /**
   * Add an overlay entity to the overlay root, bypassing main tree clipping bounds.
   */
  public showOverlay(overlay: Entity): void {
    this.overlayRoot.add(overlay);
    this.registerActiveDriverSubtree(overlay);
    this.markDirty();
  }

  /**
   * Remove an overlay entity from the overlay root.
   */
  public hideOverlay(overlay: Entity): void {
    this.overlayRoot.remove(overlay);
    this.removeA11yRecursively(overlay);
    this.unregisterActiveDriverSubtree(overlay);
    this.markDirty();
  }

  private destroyEntitySubtree(entity: Entity): void {
    // `Entity.destroy()` now recurses leaf-first over the whole subtree, so a
    // single call tears down every descendant. Kept as a named method for the
    // Scene teardown call sites and future scene-specific pre-destroy hooks.
    entity.destroy();
  }

  /**
   * Tear down the Scene, halt the loop, and clean up event listeners and DOM elements.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    if (typeof document !== 'undefined' && document.fonts && this.fontLoadHandler) {
      document.fonts.removeEventListener('loadingdone', this.fontLoadHandler);
    }
    while (this.root.children.length > 0) this.destroyEntitySubtree(this.root.children.at(-1)!);
    while (this.overlayRoot.children.length > 0) {
      this.destroyEntitySubtree(this.overlayRoot.children.at(-1)!);
    }
    if (typeof window !== 'undefined' && !this.disableWindowResize) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (this.canvasResizeObserver) {
      this.canvasResizeObserver.disconnect();
      this.canvasResizeObserver = null;
    }
    if (this.dprMediaQuery && this.dprChangeHandler) {
      this.dprMediaQuery.removeEventListener?.('change', this.dprChangeHandler);
      this.dprMediaQuery = null;
      this.dprChangeHandler = null;
    }
    if (this.forcedColorsQuery && this.forcedColorsChangeHandler) {
      this.forcedColorsQuery.removeEventListener?.('change', this.forcedColorsChangeHandler);
      this.forcedColorsQuery = null;
      this.forcedColorsChangeHandler = null;
    }
    if (typeof window !== 'undefined' && this.contentSelectionEndListener) {
      window.removeEventListener('mouseup', this.contentSelectionEndListener);
      window.removeEventListener('blur', this.contentSelectionEndListener);
      this.contentSelectionEndListener = null;
    }
    if (
      typeof window !== 'undefined' &&
      this.pointerEventTarget &&
      typeof this.pointerEventTarget.removeEventListener === 'function'
    ) {
      if (this.pointerMoveListener) {
        this.pointerEventTarget.removeEventListener('pointermove', this.pointerMoveListener);
      }
      if (this.pointerLeaveListener) {
        this.pointerEventTarget.removeEventListener('pointerleave', this.pointerLeaveListener);
      }
      this.pointerEventTarget = null;
    }
    this.a11yRoot?.remove();
    this.focusSentinel = null;
    this.portalRoot?.remove();
    this.a11yElements.clear();
    for (const el of this.contentElements.values()) el.remove();
    this.contentElements.clear();
    this.contentSyncState.clear();
    if (typeof cancelAnimationFrame === 'function') {
      for (const frame of this.contentGridCalibrationFrames.values()) {
        cancelAnimationFrame(frame);
      }
    }
    this.contentGridCalibrationFrames.clear();
    for (const probe of this.contentGridCalibrationProbes.values()) probe.remove();
    this.contentGridCalibrationProbes.clear();
    this.endContentSelectionDrag();
    if (this.glCanvas) {
      if (this.glContextLostHandler) {
        this.glCanvas.removeEventListener('webglcontextlost', this.glContextLostHandler);
      }
      if (this.glContextRestoredHandler) {
        this.glCanvas.removeEventListener('webglcontextrestored', this.glContextRestoredHandler);
      }
    }
    this.glContextLostHandler = null;
    this.glContextRestoredHandler = null;
    this.pointRenderer?.destroy();
    // Release the main renderer's backend (e.g. WebGLRenderer + GL context)
    // before GC — prevents context leakage across SPA/XR recreate cycles.
    this.renderer.dispose?.();
    this.glCanvas?.remove();
    this.gpuCanvas?.remove();
    this.gpuCanvas = null;
    this.gpuContext = null;
    if (this.recoveryTimerId) {
      clearTimeout(this.recoveryTimerId);
      this.recoveryTimerId = null;
    }
    if (this.manager) {
      this.manager.destroy();
      this.manager = null;
    }
    // Release the GPUDevice itself — without this, repeated Scene
    // create/destroy cycles (SPA routes, XR sessions) leak WebGPU devices.
    if (this.device) {
      this.device.destroy?.();
      this.device = null;
    }
  }

  private setupEvents(): void {
    if (typeof window !== 'undefined' && !this.disableWindowResize) {
      window.addEventListener('resize', this.resizeHandler);
    } else if (
      this.disableWindowResize &&
      typeof ResizeObserver !== 'undefined' &&
      this.canvas &&
      typeof (this.canvas as HTMLCanvasElement).getBoundingClientRect === 'function'
    ) {
      // Embedded scene: the window never resizes, but the canvas element can be
      // resized by CSS/layout. Observe it and re-run resize() at its new logical
      // (CSS) size so the backing store tracks the element.
      this.canvasResizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const box = entry.contentRect;
        const w = Math.round(box.width);
        const h = Math.round(box.height);
        if (w > 0 && h > 0 && (w !== this.width || h !== this.height)) {
          this.resize(w, h);
        }
      });
      this.canvasResizeObserver.observe(this.canvas as HTMLCanvasElement);
    }
    // Watch for a runtime DPR change (window dragged to a monitor with a
    // different pixel density, or browser zoom) so the canvas backing store is
    // re-scaled. `resize` alone does not fire for a DPR-only change, and an
    // embedded (disableWindowResize) scene blurs just the same, so this runs
    // regardless of that flag.
    this.watchDevicePixelRatio();
    if (
      typeof window !== 'undefined' &&
      this.canvas &&
      typeof this.canvas.addEventListener === 'function'
    ) {
      this.pointerMoveListener = (e: PointerEvent) => {
        const point = this.clientToScene(e.clientX, e.clientY);
        this.mouseX = point.x;
        this.mouseY = point.y;
      };
      this.pointerLeaveListener = () => {
        this.mouseX = -9999;
        this.mouseY = -9999;
      };
      // Bind to the parent container, not the canvas: content-projection and
      // a11y mirror elements sit *above* the canvas with `pointer-events:auto`,
      // so a pointermove over projected text fires on that element and never
      // reaches a canvas-bound listener — freezing `mouseX/mouseY` (and any
      // pointer-driven particle repulsion) while the cursor is over text. The
      // parent wraps the canvas and both overlay roots, so moves over any layer
      // bubble up here, and `pointerleave` on the parent fires only when the
      // pointer truly exits the whole region (crossing between canvas and an
      // overlay child does not). Falls back to the canvas when it has no parent.
      this.pointerEventTarget = (this.canvas.parentElement as HTMLElement | null) ?? this.canvas;
      this.pointerEventTarget.addEventListener('pointermove', this.pointerMoveListener);
      this.pointerEventTarget.addEventListener('pointerleave', this.pointerLeaveListener);
    }
  }

  /**
   * Begin the `requestAnimationFrame` render loop.
   *
   * Idempotent — calling `start()` on an already-running scene is a no-op.
   */
  public start(): void {
    if (this.isRunning) return;

    if ((this.width === 0 || this.height === 0) && !this.hasWarnedZeroSize) {
      console.warn(
        `[VectoJS] Scene started with width or height set to 0 (width: ${this.width}, height: ${this.height}). ` +
          'Entities may not render or simulate correctly. Please call scene.resize(width, height) to set valid dimensions.',
      );
      this.hasWarnedZeroSize = true;
    }

    this.isRunning = true;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : 0;
    this.watchCanvasVisibility();
    this.scheduleFrame();

    const isTextFocused =
      this.focusedA11yElement instanceof HTMLInputElement ||
      this.focusedA11yElement instanceof HTMLTextAreaElement;
    if (isTextFocused && this.renderMode === 'onDemand' && !this.caretBlinkTimer) {
      this.caretBlinkTimer = setInterval(() => {
        this.markDirty();
      }, 500);
    }
  }

  /** Schedule the next frame, or no-op where `requestAnimationFrame` is absent (SSR). */
  private scheduleFrame(): void {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  /**
   * Observe whether the canvas is on-screen so the rAF loop can pause when it
   * scrolls fully out of view (a dashboard tab, a chart below the fold) and
   * resume when it returns — instead of running the full update/render every
   * frame for a scene nobody can see. No-op (stays "on screen") where
   * `IntersectionObserver` is unavailable, so SSR/jsdom behavior is unchanged.
   *
   * Also a no-op for a canvas that is not in the document. An offscreen canvas
   * used purely as a texture source — `@vectojs/three`'s `ThreeAdapter` wraps
   * one in a `CanvasTexture`, and the same pattern shows up in any
   * render-to-texture setup — is never appended anywhere, and an
   * `IntersectionObserver` reports a detached element as not intersecting.
   * Observing it would therefore set `_canvasOnScreen = false` on the first
   * callback, and since {@link loop} returns without rescheduling in that
   * state, the loop would stop permanently: the only resume path is an
   * `isIntersecting` transition, which a detached element can never produce.
   * Such a canvas is always "visible" as far as this scene is concerned,
   * because whether its output is seen depends on the consumer sampling the
   * texture, which this scene cannot observe.
   */
  private watchCanvasVisibility(): void {
    if (this._canvasObserver || typeof IntersectionObserver === 'undefined') return;
    if (!this.canvas || typeof this.canvas.getBoundingClientRect !== 'function') return;
    // `isConnected` is undefined on a non-Node canvas mock; only skip when it
    // is explicitly false, so test doubles keep their previous behavior.
    if (this.canvas.isConnected === false) return;
    this._canvasObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const nowOnScreen = entry.isIntersecting;
      const wasOffScreen = !this._canvasOnScreen;
      this._canvasOnScreen = nowOnScreen;
      // Re-entering the viewport while running: the loop paused itself (stopped
      // rescheduling), so kick it back off. Reset lastTime so the first frame
      // back doesn't integrate the whole off-screen gap (the dt clamp also caps
      // it, but this keeps telemetry honest).
      if (nowOnScreen && wasOffScreen && this.isRunning) {
        this.lastTime = typeof performance !== 'undefined' ? performance.now() : 0;
        this.scheduleFrame();
      }
    });
    this._canvasObserver.observe(this.canvas);
  }

  /**
   * Halt the render loop after the current frame completes.
   *
   * Call {@link start} again to resume rendering.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.caretBlinkTimer) {
      clearInterval(this.caretBlinkTimer);
      this.caretBlinkTimer = null;
    }
    if (this._canvasObserver) {
      this._canvasObserver.disconnect();
      this._canvasObserver = null;
    }
    // Assume visible again on next start(); the observer re-establishes truth.
    this._canvasOnScreen = true;
  }

  /**
   * Manually advance the scene clock by `dt` milliseconds and render synchronously.
   * Essential for deterministic rendering (e.g. video export).
   * Note: You should call `scene.stop()` before using this to avoid conflict with the rAF loop.
   */
  /**
   * The scene-graph root entity. Exposed read-only for tooling — the devtools
   * inspector walks it to build the Virtual Math Tree view. Mutate the graph
   * through {@link add}/{@link remove}, not by editing this node directly.
   */
  public get rootEntity(): Entity {
    return this.root;
  }

  /** The overlay layer root (see {@link showOverlay}), read-only for tooling. */
  public get overlayRootEntity(): Entity {
    return this.overlayRoot;
  }

  /**
   * Advance and render exactly one frame, synchronously.
   *
   * This renders UNCONDITIONALLY: it consults neither {@link renderMode} nor
   * {@link dirty}, and it does not apply the `always`-mode idle auto-throttle.
   * That is deliberate — a deterministic driver (video export, a test, a
   * fixed-step benchmark) asks for a frame because it wants that frame, not a
   * scheduler opinion about whether it is needed.
   *
   * The consequence is a measurement footgun worth stating explicitly: a
   * benchmark that drives frames through `step()` CANNOT observe frame skipping,
   * so `always` and `onDemand` produce byte-identical draw counts through this
   * path. An investigation into whether `onDemand` skips redundant repaints once
   * concluded "it does not" on exactly that basis; on the real rAF loop the same
   * workload rendered ~1.0 frames per content change. To measure anything about
   * scheduling, use {@link start} and let `requestAnimationFrame` drive.
   *
   * @param dt Seconds to advance. Not clamped by `MAX_FRAME_DT` — the caller
   *   chooses the step, since determinism is the point.
   */
  public step(dt: number): void {
    const time = this.lastTime + dt;
    this.lastTime = time;
    // Time the render phase here too: the loop-level probe only covers the rAF
    // path, so a benchmark or a deterministic export driving frames through
    // `step()` reported `render` as exactly 0 while its sub-phases were nonzero —
    // internally inconsistent, and the kind of result that makes a reader distrust
    // the whole table.
    const t0 = this._phaseTiming ? performance.now() : 0;
    this.render(this.renderer, dt, time);
    if (this._phaseTiming) this._recordPhase('render', performance.now() - t0);
    this.dirty = false;
  }

  /**
   * Mark the scene as needing a redraw on the next frame.
   *
   * Only meaningful in `onDemand` {@link renderMode}: call it after mutating
   * entity state outside of {@link Entity.animate} so the change is rendered.
   */
  public markDirty(source?: DirtySource): void {
    this.dirty = true;
    // Attribution is opt-in and costs nothing when off: `markDirty` is called
    // from dozens of sites, several of them per-frame, so the common path must
    // stay a single field write.
    if (this._dirtyTracking && source) this.recordDirtyReason(source);
  }

  /**
   * Increments whenever the tree's shape changes: add, remove or reparent.
   *
   * Already maintained for the resident WASM transform store (see
   * {@link markStructureChanged}, called from `Entity.add`/`remove`), and exposed
   * here because a cache of the tree's shape — a DevTools tree model, a serialized
   * snapshot — is valid exactly as long as this value is unchanged. Comparing it is
   * O(1) against re-walking the tree, which is what it replaces: DevTools rebuilt
   * both trees on a fixed 500 ms interval, a constant cost proportional to entity
   * count, purely because it had no way to ask whether the shape had changed.
   *
   * Property changes do NOT bump it. Moving or restyling an entity leaves the
   * shape intact, so a consumer that also cares about values must read those
   * directly rather than rebuilding a tree.
   */
  public get structureVersion(): number {
    return this._structureVersion;
  }

  /**
   * Record who marked the scene dirty and why.
   *
   * Kept separate from {@link markDirty} so the hot path is not a function call
   * with a branch — V8 inlines the one-field version reliably.
   */
  private recordDirtyReason(source: DirtySource): void {
    const key = `${source.entity ?? 'scene'}:${source.reason}${
      source.property ? `.${source.property}` : ''
    }`;
    const existing = this._dirtyReasons.get(key);
    if (existing) {
      existing.count++;
      existing.lastFrame = this.currentFrame;
      return;
    }
    // Bounded: a scene that mints a unique reason per frame (an id in the key,
    // say) must not grow this map forever. FIFO eviction — the same rationale as
    // the color cache, and for the same reason true LRU is not worth the
    // bookkeeping here.
    if (this._dirtyReasons.size >= Scene.MAX_DIRTY_REASONS) {
      const oldest = this._dirtyReasons.keys().next().value;
      if (oldest !== undefined) this._dirtyReasons.delete(oldest);
    }
    this._dirtyReasons.set(key, {
      entity: source.entity,
      reason: source.reason,
      property: source.property,
      count: 1,
      firstFrame: this.currentFrame,
      lastFrame: this.currentFrame,
    });
  }

  /**
   * Start or stop recording dirty attributions.
   *
   * Off by default. `renderMode: 'onDemand'` silently degrades to always-on when
   * something marks the scene dirty every frame, and until now there was no way
   * to find out what — `dirty === true` said nothing about the cause. Enable
   * this, run the scene, then read {@link dirtyReasons}.
   */
  public setDirtyTracking(enabled: boolean): void {
    this._dirtyTracking = enabled;
    if (!enabled) this._dirtyReasons.clear();
  }

  /** Whether dirty attribution is currently being recorded. */
  public get dirtyTracking(): boolean {
    return this._dirtyTracking;
  }

  /**
   * Recorded dirty attributions, most frequent first.
   *
   * `count` is what matters for the `onDemand` diagnosis: a reason appearing once
   * per frame over hundreds of frames is the thing keeping the scene awake.
   */
  public get dirtyReasons(): DirtyReasonEntry[] {
    return [...this._dirtyReasons.values()].sort((a, b) => b.count - a.count);
  }

  /** Drop recorded attributions, keeping tracking enabled. */
  public clearDirtyReasons(): void {
    this._dirtyReasons.clear();
  }

  /**
   * Live frame telemetry for profilers and devtools overlays. All timings are
   * measured on the `requestAnimationFrame` loop; a scene driven only by
   * {@link step} (e.g. deterministic video export) leaves these at their zero
   * defaults.
   *
   * `fps` is derived from the interval between *rendered* frames, so idle
   * `onDemand` scenes and frames skipped by the {@link maxFPS} cap or the
   * static auto-throttle do not deflate it — it reports the cadence of actual
   * redraws, not the raw rAF rate. `frameTimeMs` is the wall-clock cost of the
   * last `render()` pass alone (excludes a11y/content-projection sync).
   *
   * The renderer always repaints the full canvas, so there is no partial
   * dirty-rectangle to expose; `dirty` is the boolean redraw-pending flag and
   * `pendingRedraw` reflects whether the next `onDemand` tick will actually
   * render.
   */
  public get frameStats(): FrameStats {
    const interval = this._avgFrameIntervalMs;
    return {
      fps:
        interval > 0
          ? Math.min(1000 / interval, this.maxFPS > 0 ? this.maxFPS : 1000 / interval)
          : 0,
      frameTimeMs: this._lastFrameMs,
      frameIntervalMs: interval,
      dt: this._lastDt,
      renderedFrames: this._renderedFrames,
      skippedFrames: this._skippedFrames,
      renderMode: this.renderMode,
      dirty: this.dirty,
    };
  }

  /** True when any node in the subtree has a pending animation. */
  /** True when any node in the subtree is interactive (drives a11y sync). */
  private syncOptionalAttribute(
    element: HTMLElement,
    name: string,
    value: string | undefined,
  ): void {
    if (value === undefined) {
      if (element.hasAttribute(name)) element.removeAttribute(name);
      return;
    }
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  /**
   * Whether `node` should have an a11y shadow element projected for it.
   *
   * The single authority for that decision. It was previously inlined verbatim
   * at four call sites — `syncA11y` (create/update), `enforceA11yDomOrder`
   * (which ids survive pruning), `getA11yTree` (the public snapshot) and
   * `render` (z-index / reading-order assignment). Four copies of one predicate
   * is a standing correctness hazard: if any of them drifts, elements either
   * leak (created but never marked active, so pruned every frame and rebuilt) or
   * go missing from the semantic tree while still present in the DOM.
   *
   * A box is required because a zero-size element is unfocusable and
   * unhittable; `a11yFullViewport` is the deliberate exception, since those
   * nodes are boundless interaction surfaces mounted behind everything else.
   *
   * Keep this the only place the rule is written. A planned per-entity
   * `a11yProjection` mode ('eager' | 'onDemand' | 'never') extends exactly this
   * predicate, which is only tractable while it has one home.
   */
  private shouldProjectA11y(node: Entity): boolean {
    if (!node.interactive) return false;
    if (!(node.width > 0 || node.a11yFullViewport)) return false;
    switch (node.a11yProjection) {
      case 'never':
        return false;
      case 'onDemand':
        return this.a11yEngaged(node);
      default:
        return true;
    }
  }

  /**
   * Whether an `a11yProjection: 'onDemand'` entity is currently engaged enough to
   * deserve a shadow node.
   *
   * Deliberately **not** hover alone. A keyboard or assistive-technology user
   * generates no pointer events, so a hover-only trigger would withhold the
   * semantic node from precisely the users it exists for. Three signals, any of
   * which counts:
   *
   * - **Focus.** Covers keyboard traversal and AT-driven focus. Checked against
   *   the live element so a node keeps its own focus rather than being pruned out
   *   from under the user mid-interaction.
   * - **Pointer target.** The entity under the pointer, so a mouse user gets the
   *   same node a hover-gated design would have given them.
   * - **Explicit request.** {@link Scene.requestA11yProjection}, for anything the
   *   app knows is significant — the selected item, a search hit, a
   *   just-announced element. This is the escape hatch that keeps the mode usable
   *   when neither focus nor pointer applies.
   *
   * The entity stays hit-testable on canvas regardless, so a click always reaches
   * it and promotes it on the next sync.
   */
  private a11yEngaged(node: Entity): boolean {
    if (this.a11yProjectionRequests.has(node.id)) return true;
    // Pointer engagement asks the ENTITY whether the pointer is inside it, rather
    // than asking the DOM what is hovered or the scene what is hit.
    //
    // Not the DOM, because an `onDemand` entity has no element until it is
    // engaged, so a hover test could never promote it — the thing that would
    // receive the hover does not exist yet. That circularity is what makes
    // hover-driven materialization awkward in the first place.
    //
    // And deliberately not `findEntityAt`, which was the first implementation and
    // broke a real test: it calls `_ensureHitGrid()`, so running it from the a11y
    // sync rebuilds the spatial index mid-frame and made Firefox lose an
    // in-progress drag selection over a Table cell (`text: ''` with the correct
    // element under the pointer). `isPointInside` is the entity's own predicate,
    // has no shared state, and is what the pointer pipeline itself uses.
    //
    // Overlap is accepted rather than resolved to the topmost entity: deciding
    // that needs the very hit-test being avoided, and promoting a few stacked
    // entities is harmless — each is genuinely under the pointer, and the cost is
    // bounded by how many entities can overlap one point, not by scene size.
    //
    // Pointer engagement is skipped for an entity that projects SELECTABLE text of
    // its own. Its a11y node carries `pointer-events: auto` and stacks above the
    // transparent text mirror, so materializing one under the pointer swallows the
    // mousedown and native drag-selection never starts — the same conflict that
    // makes `Text`/`RichText` set `interactive = false` (`Text.ts:126-130`).
    // Measured: promoting a Table cell this way left Firefox with the right
    // element under the pointer and an empty selection. Focus and explicit
    // requests still apply, so such an entity is still reachable; it just is not
    // promoted by hovering the text it is trying to let you select.
    if (this.mouseX > -9000 && !this.projectsSelectableText(node)) {
      if (node.isPointInside(this.mouseX, this.mouseY)) return true;
    }
    // Keep a focused node projected even if it stopped qualifying otherwise:
    // pruning the element under the user's focus moves focus to <body> and
    // silently drops them out of the scene.
    const existing = this.a11yElements?.get(node.id);
    if (existing && typeof document !== 'undefined' && document.activeElement === existing) {
      return true;
    }
    return false;
  }

  /**
   * Whether `node` mirrors selectable text of its own.
   *
   * Such an entity must not be promoted by the pointer: its interactive a11y node
   * would sit above the text mirror and eat the mousedown that starts a native
   * selection.
   */
  private projectsSelectableText(node: Entity): boolean {
    const projection = node.getContentProjection?.();
    return !!projection?.text && projection.selectable !== false;
  }

  /**
   * Keep `entity`'s a11y shadow node projected while it has
   * `a11yProjection: 'onDemand'`.
   *
   * For anything the application knows matters but the engine cannot infer — the
   * selected danmaku, a search hit, a node just announced in a live region.
   * Without this, `'onDemand'` would be reachable only by focus or pointer, and
   * an app-driven selection change would leave the selected entity semantically
   * invisible.
   *
   * Idempotent. Has no effect on an `'eager'` entity, which is always projected.
   */
  public requestA11yProjection(entity: Entity | string): void {
    const id = typeof entity === 'string' ? entity : entity.id;
    if (this.a11yProjectionRequests.has(id)) return;
    this.a11yProjectionRequests.add(id);
    this.a11yNeedsReorder = true;
    this.markDirty({ entity: id, reason: 'a11y-reorder' });
  }

  /**
   * Drop a projection request made by {@link requestA11yProjection}.
   *
   * The node is not removed immediately: it survives while it is focused or under
   * the pointer, and is pruned on the next sync that finds it unengaged. Releasing
   * a request the scene does not hold is a no-op.
   */
  public releaseA11yProjection(entity: Entity | string): void {
    const id = typeof entity === 'string' ? entity : entity.id;
    if (!this.a11yProjectionRequests.delete(id)) return;
    this.a11yNeedsReorder = true;
    this.markDirty({ entity: id, reason: 'a11y-reorder' });
  }

  private syncA11y(node: Entity, container: A11yContainer | null = null) {
    if (!this.a11yRoot) return; // no DOM (SSR) → a11y projection is a no-op
    if (node === this.root) {
      // Refill the per-sync materialization budget at the start of each walk.
      //
      // Keyed on the root rather than sited in the render loop because this method
      // is also the entry point for tests and benchmarks, which drive syncs
      // directly; a refill in the loop would leave those callers at a permanently
      // spent budget, deferring every resident block forever. Recursive calls and
      // the overlay pass both carry non-root nodes, so they correctly share one
      // budget rather than refilling it per subtree.
      this.contentSemanticBudgetLeft = this.contentSemanticBudget;
      this.contentSemanticDeferred = false;
      // Invalidate the one-entry parent-transform memo: a new walk may see a
      // parent that has moved since the previous one.
      this._syncSerial++;
      // Invalidate the selection memo: a new walk may see a selection the
      // previous one did not.
      this.contentSelectionPresentThisSync = null;
    }
    if (node.isDOMPortal) {
      return;
    }
    // A fully transparent subtree must not project — for itself OR its
    // descendants. `Overlay.hide()` sets `opacity = 0`, drops its own
    // `interactive`, and calls `detachA11y`, which correctly prunes the subtree;
    // but the walk then descended into the hidden overlay's children anyway, and
    // any still-interactive child was re-created on the very next frame. Measured
    // in a real browser: after `Popover.hide()` the popover's own element was gone
    // while its button stayed projected with `tabIndex: 0` and a live box, so a
    // keyboard user could Tab into a hidden popover.
    //
    // The condition is `a11yHidden`, an explicit opt-out, NOT `opacity === 0`.
    // Opacity looked like the natural signal and is wrong: `Overlay.hide()` springs
    // opacity toward 0 rather than setting it, so mid-transition it reads ~0.26 and
    // the check never fires — measured. Nor is a threshold right, since a
    // deliberately faint-but-live control would be silently removed from the
    // accessibility tree.
    //
    // Checked here rather than inside `shouldProjectA11y` because this has to stop
    // the RECURSION, not just skip one node: that gate is also consulted for
    // pruning and reading order, where per-node semantics are what matter.
    if (node.a11yHidden) {
      this.pruneA11ySubtree(node);
      return;
    }
    const nodeStart = this._phaseTiming ? performance.now() : 0;
    // A projected node with a container role becomes the container for the
    // subtree below it; anything else passes the inherited one straight
    // through. Passing it through is what lets a `row` reach its `grid` across
    // `Table`'s non-interactive `bodyClip`, which never projects and so cannot
    // be a container itself.
    let childContainer = container;
    if (this.shouldProjectA11y(node)) {
      let el = this.a11yElements.get(node.id);
      const attrs = node.getA11yAttributes();
      const expectedTag = attrs.tag || 'div';
      /** Set when a mirror is created, called once its geometry is written. */
      let emitInitialScroll: (() => void) | null = null;

      // If tag name changes at runtime, recreate the element
      if (el && el.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
        if (el === this.focusedA11yElement) {
          this.focusedA11yElement = null;
          if (this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
        }
        // Parent-agnostic for the same reason as the prune sweep: a nested
        // mirror hangs off its container, not the root.
        if (el.parentNode) {
          this.preserveFocusOnRemoval(el);
          el.remove();
        }
        this.a11yElements.delete(node.id);
        el = undefined;
        this.a11yNeedsReorder = true; // Mark reorder as DOM structure has mutated
      }

      if (!el) {
        el = document.createElement(expectedTag);
        el.id = node.id;
        el.setAttribute('data-vecto-id', node.id);

        // Default shadow DOM styling (with outline disabled to let Vecto handle visual focus outlines)
        el.style.position = 'absolute';
        el.style.transformOrigin = '0 0';
        el.style.pointerEvents = 'auto'; // allow Playwright/Agent to click!
        el.style.touchAction = 'pinch-zoom';
        el.style.margin = '0';
        el.style.padding = '0';
        el.style.outline = 'none';
        el.style.cursor = node.a11yFullViewport ? 'default' : 'pointer';

        if (this.debugA11y) {
          el.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          el.style.border = '1px dashed rgba(56, 189, 248, 0.4)';
        } else {
          el.style.opacity = '0';
          el.style.border = 'none';
          el.style.background = 'transparent';
        }

        // Bind pointer click
        el.addEventListener('click', (e) => {
          node.dispatchEvent(new VectoJSEvent('click', node, e));
        });

        // Bind double-click (the a11yRoot already has its own dblclick handler
        // for text word-selection via selectProjectionUnit — that fires on the
        // content-projection DOM, not on entity shadow elements, so it is
        // unaffected by this per-entity dispatch).
        el.addEventListener('dblclick', (e) => {
          node.dispatchEvent(new VectoJSEvent('dblclick', node, e));
        });

        // Developer debugger mode hover feedback. The enter/leave pair is also
        // tracked in `hoveredA11yElements` so a mid-hover removal can synthesize
        // the leave the browser will never send (see removeA11yRecursively).
        el.addEventListener('mouseenter', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          this.hoveredA11yElements.add(el!);
          node.dispatchEvent(new VectoJSEvent('hover', node, e, false));
        });
        el.addEventListener('mouseleave', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
          this.hoveredA11yElements.delete(el!);
          node.dispatchEvent(new VectoJSEvent('pointerleave', node, e, false));
        });

        const capEl = el;
        const releasePointer = (event: PointerEvent): void => {
          if (typeof capEl.releasePointerCapture !== 'function') return;
          if (
            typeof capEl.hasPointerCapture === 'function' &&
            !capEl.hasPointerCapture(event.pointerId)
          ) {
            return;
          }
          try {
            capEl.releasePointerCapture(event.pointerId);
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
          }
        };
        el.addEventListener('pointerdown', (e) => {
          if (typeof capEl.setPointerCapture === 'function') capEl.setPointerCapture(e.pointerId);
          node.dispatchEvent(new VectoJSEvent('pointerdown', node, e));
        });
        el.addEventListener('pointerup', (e) => {
          releasePointer(e);
          node.dispatchEvent(new VectoJSEvent('pointerup', node, e));
        });
        el.addEventListener('pointercancel', (e) => {
          releasePointer(e);
          node.dispatchEvent(new VectoJSEvent('pointercancel', node, e));
        });
        el.addEventListener('pointermove', (e) =>
          node.dispatchEvent(new VectoJSEvent('pointermove', node, e)),
        );
        el.addEventListener(
          'wheel',
          (e) => {
            node.dispatchEvent(new VectoJSEvent('wheel', node, e));
          },
          { passive: false },
        );
        // The mirror scrolling itself is a *state change*, not a gesture: the
        // browser has already applied it (wheel, scrollbar drag, or scrolling a
        // caret back into view) and the entity's only job is to follow. Without
        // this an entity that paints scrollable content has no way to learn the
        // offset its own mirror is using, so every offset the element reports —
        // `selectionStart` from a click — is measured against a view the canvas
        // is not drawing. `scroll` does not bubble in the DOM, hence a direct
        // `emit` to the owning entity rather than a tree dispatch.
        const scrollTarget = el;
        const emitScroll = (): void => {
          node.emit('scroll', {
            scrollTop: scrollTarget.scrollTop,
            scrollLeft: scrollTarget.scrollLeft,
            scrollHeight: scrollTarget.scrollHeight,
            scrollWidth: scrollTarget.scrollWidth,
            clientHeight: scrollTarget.clientHeight,
            clientWidth: scrollTarget.clientWidth,
          });
        };
        el.addEventListener(
          'scroll',
          () => {
            emitScroll();
            this.markDirty();
          },
          { passive: true },
        );
        // Publish the mirror's *initial* offset once this frame's geometry has
        // been written (below), not here: a just-created element has no size, so
        // `clientHeight`/`scrollHeight` would both be 0 and the payload would be
        // a lie. A fresh mirror sits at 0 and fires no `scroll` until something
        // moves it, but an entity that scrolls to its caret on the first frame
        // draws a different view meanwhile — measured at 640px of disagreement
        // for a TextArea whose caret starts at the end of its value. Emitting
        // once at creation makes the two agree from the first frame rather than
        // from the first gesture.
        emitInitialScroll = emitScroll;
        el.addEventListener('keydown', (e) => {
          node.dispatchEvent(new VectoJSEvent('keydown', node, e));
        });
        el.addEventListener('keyup', (e) => {
          node.dispatchEvent(new VectoJSEvent('keyup', node, e));
        });

        // Form integration listeners
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const input = el;
          let composition: { start: number; length: number } | null = null;
          const forward = () => {
            (input as any)._lastSyncedValue = input.value;
            node.emit('change', {
              value: input.value,
              checked: input instanceof HTMLInputElement ? input.checked : undefined,
              selectionStart: input.selectionStart ?? input.value.length,
              selectionEnd: input.selectionEnd ?? input.value.length,
              composition,
            });
            this.markDirty();
          };
          el.addEventListener('input', forward);
          el.addEventListener('change', forward);
          el.addEventListener('keyup', forward);
          el.addEventListener('click', forward);
          el.addEventListener('select', forward);

          el.addEventListener('compositionstart', () => {
            composition = {
              start: input.selectionStart ?? input.value.length,
              length: 0,
            };
            forward();
          });
          el.addEventListener('compositionupdate', (e) => {
            const data = (e as CompositionEvent).data ?? '';
            composition = {
              start: composition?.start ?? 0,
              length: data.length,
            };
            forward();
          });
          el.addEventListener('compositionend', () => {
            composition = null;
            forward();
          });
        }

        // Focus / blur handlers (guard blink timer only on text inputs)
        const isTextInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        el.addEventListener('focus', () => {
          this.focusedA11yElement = el!;
          node.emit('focus', {});
          if (
            isTextInput &&
            this.renderMode === 'onDemand' &&
            this.isRunning &&
            !this.caretBlinkTimer
          ) {
            this.caretBlinkTimer = setInterval(() => {
              this.markDirty();
            }, 500);
          }
        });
        el.addEventListener('blur', () => {
          if (this.focusedA11yElement === el) {
            this.focusedA11yElement = null;
          }
          const isTextFocused =
            this.focusedA11yElement instanceof HTMLInputElement ||
            this.focusedA11yElement instanceof HTMLTextAreaElement;
          if (!isTextFocused && this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
          node.emit('blur', {});
        });

        // Keyboard accessibility for non-natively-focusable interactive controls
        if (!isNativelyFocusable(el) && attrs.role && INTERACTIVE_A11Y_ROLES.has(attrs.role)) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              node.dispatchEvent(new VectoJSEvent('click', node, e));
            }
          });
        }

        // Initial insertion order placement
        if (node.a11yFullViewport) {
          this.a11yRoot.insertBefore(el, this.a11yRoot.firstChild);
        } else {
          this.a11yRoot.appendChild(el);
        }
        this.a11yElements.set(node.id, el);
        this.a11yNeedsReorder = true;
      }

      // Refresh dynamic attributes (with Dirty Checking to minimize DOM API calls)
      this.syncOptionalAttribute(el, 'role', attrs.role);
      this.syncOptionalAttribute(el, 'aria-label', attrs.label);
      const semanticPointerEvents = attrs.pointerEvents ?? 'auto';
      if (el.style.pointerEvents !== semanticPointerEvents) {
        el.style.pointerEvents = semanticPointerEvents;
      }
      const renderOrder = this.a11yRenderOrders.get(node.id);
      if (renderOrder !== undefined && el.style.zIndex !== String(renderOrder)) {
        el.style.zIndex = String(renderOrder);
      }
      const implicitTabIndex =
        !isNativelyFocusable(el) && attrs.role && INTERACTIVE_A11Y_ROLES.has(attrs.role) ? 0 : null;
      const desiredTabIndex = attrs.tabIndex ?? implicitTabIndex;
      if (desiredTabIndex === null) {
        if (el.hasAttribute('tabindex')) el.removeAttribute('tabindex');
      } else if (el.getAttribute('tabindex') !== String(desiredTabIndex)) {
        el.setAttribute('tabindex', String(desiredTabIndex));
      }
      this.syncOptionalAttribute(el, 'type', attrs.inputType);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const placeholder = attrs.placeholder ?? '';
        if (el.placeholder !== placeholder) el.placeholder = placeholder;
      }
      if (el instanceof HTMLAnchorElement) {
        this.syncOptionalAttribute(
          el,
          'href',
          attrs.href === undefined ? undefined : sanitizeUrl(attrs.href),
        );
        this.syncOptionalAttribute(el, 'target', attrs.target);
      }
      if (el instanceof HTMLImageElement) {
        this.syncOptionalAttribute(el, 'src', attrs.src);
        this.syncOptionalAttribute(el, 'alt', attrs.alt);
      }

      if (el instanceof HTMLInputElement) {
        const checked = attrs.checked ?? false;
        if (el.checked !== checked) el.checked = checked;
      } else {
        this.syncOptionalAttribute(
          el,
          'aria-checked',
          attrs.checked === undefined ? undefined : String(attrs.checked),
        );
      }
      if ('disabled' in el) {
        const disabled = attrs.disabled ?? false;
        if ((el as any).disabled !== disabled) (el as any).disabled = disabled;
      } else {
        this.syncOptionalAttribute(
          el,
          'aria-disabled',
          attrs.disabled === undefined ? undefined : String(attrs.disabled),
        );
      }
      this.syncOptionalAttribute(
        el,
        'aria-expanded',
        attrs.expanded === undefined ? undefined : String(attrs.expanded),
      );
      this.syncOptionalAttribute(el, 'aria-controls', attrs.controls);
      this.syncOptionalAttribute(el, 'aria-haspopup', attrs.haspopup);
      this.syncOptionalAttribute(
        el,
        'aria-selected',
        attrs.selected === undefined ? undefined : String(attrs.selected),
      );
      this.syncOptionalAttribute(el, 'aria-activedescendant', attrs.activedescendant);
      this.syncOptionalAttribute(el, 'aria-valuemin', attrs.valuemin);
      this.syncOptionalAttribute(el, 'aria-valuemax', attrs.valuemax);
      // Live regions (streamed chat / toast / async validation) + label/describe
      // relationships and field validation state. WCAG 4.1.3 / 3.3.
      this.syncOptionalAttribute(el, 'aria-live', attrs.live);
      this.syncOptionalAttribute(
        el,
        'aria-atomic',
        attrs.atomic === undefined ? undefined : String(attrs.atomic),
      );
      this.syncOptionalAttribute(el, 'aria-relevant', attrs.relevant);
      this.syncOptionalAttribute(el, 'aria-modal', attrs.ariaModal);
      this.syncOptionalAttribute(el, 'aria-labelledby', attrs.labelledby);
      this.syncOptionalAttribute(el, 'aria-describedby', attrs.describedby);
      // Prefer the NATIVE `required` on a form control and fall back to
      // `aria-required` elsewhere. Native validity participates in form
      // submission and `:invalid` styling, which the ARIA attribute only
      // describes; on a `<div role="textbox">` there is no native attribute to
      // set, so both paths are needed.
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        const wantRequired = attrs.required === true;
        if (el.required !== wantRequired) el.required = wantRequired;
        // Don't also emit aria-required: duplicating native state is redundant
        // and can drift.
        this.syncOptionalAttribute(el, 'aria-required', undefined);
      } else {
        this.syncOptionalAttribute(
          el,
          'aria-required',
          attrs.required === undefined ? undefined : String(attrs.required),
        );
      }
      this.syncOptionalAttribute(
        el,
        'aria-invalid',
        attrs.invalid === undefined ? undefined : String(attrs.invalid),
      );
      this.syncOptionalAttribute(
        el,
        'aria-level',
        attrs.level === undefined ? undefined : String(attrs.level),
      );
      // Set position/size and grid extent. These matter specifically because a
      // virtualized widget projects only its visible rows: without them the
      // accessibility tree can only report what is mounted, so a list showing
      // rows 40-52 of 10,000 announces "item 3 of 12".
      this.syncOptionalAttribute(
        el,
        'aria-posinset',
        attrs.posInSet === undefined ? undefined : String(attrs.posInSet),
      );
      this.syncOptionalAttribute(
        el,
        'aria-setsize',
        attrs.setSize === undefined ? undefined : String(attrs.setSize),
      );
      this.syncOptionalAttribute(
        el,
        'aria-rowcount',
        attrs.rowCount === undefined ? undefined : String(attrs.rowCount),
      );
      this.syncOptionalAttribute(
        el,
        'aria-rowindex',
        attrs.rowIndex === undefined ? undefined : String(attrs.rowIndex),
      );
      this.syncOptionalAttribute(el, 'aria-valuetext', attrs.valueText);
      this.syncOptionalAttribute(el, 'aria-orientation', attrs.orientation);

      if (attrs.value !== undefined) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.value !== attrs.value) {
            const userTyped = (el as any)._lastSyncedValue;
            if (attrs.value !== userTyped || document.activeElement !== el) {
              el.value = attrs.value;
              (el as any)._lastSyncedValue = attrs.value;
            }
          }
        } else if (RANGE_VALUE_ROLES.has(attrs.role ?? '')) {
          // `aria-valuenow` is NUMERIC and only valid on range roles (slider,
          // spinbutton, progressbar, scrollbar, meter). Emitting it for every
          // non-input element made a combobox report
          // `aria-valuenow="Small"` — an invalid value on a disallowed
          // attribute, which axe flags as two separate critical violations.
          this.syncOptionalAttribute(el, 'aria-valuenow', attrs.value);
        } else {
          // A non-range role's "value" is its accessible text, not a number.
          this.syncOptionalAttribute(el, 'aria-valuenow', undefined);
        }
      } else if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        this.syncOptionalAttribute(el, 'aria-valuenow', undefined);
      }

      if (
        attrs.textInputStyle !== undefined &&
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
      ) {
        const textStyle = attrs.textInputStyle;
        if (el.style.font !== textStyle.font) el.style.font = textStyle.font;
        const lineHeight = `${textStyle.lineHeight}px`;
        if (el.style.lineHeight !== lineHeight) el.style.lineHeight = lineHeight;
        const padding = `${textStyle.padding}px`;
        if (el.style.padding !== padding) el.style.padding = padding;
        if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
        if (el instanceof HTMLTextAreaElement) el.style.resize = 'none';
        // Suppress the mirror's scrollbar. The element is transparent so a
        // scrollbar is never seen, but a *classic* one takes its width out of
        // the content box: measured on Firefox/Linux, clientWidth 504 vs
        // offsetWidth 516, so the element wrapped its text at 480px while the
        // canvas wrapped at 492px. The two then disagree about which line a
        // character sits on, and a click returns an offset for a line the canvas
        // never drew there. Chromium's overlay scrollbar takes 0 and already
        // agreed.
        if (el.style.scrollbarWidth !== 'none') el.style.scrollbarWidth = 'none';
      }

      // Nest under the inherited container only if ARIA requires this role to
      // be DOM-contained by it. A role the container may not own is left flat:
      // axe checks unallowed children before it reviews empty containers, so
      // nesting one turns a passing tree into a hard violation.
      const nestedIn =
        container && attrs.role && container.owned.has(attrs.role) ? container : null;

      // Sync position mappings
      if (node.a11yFullViewport) {
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = `${this.width}px`;
        el.style.height = `${this.height}px`;
        el.style.transform = '';
        // A full-viewport overlay is intentionally unbounded — never clip it.
        if (el.style.display === 'none') el.style.display = '';
      } else {
        const worldTf = node.getWorldTransform();
        const { a, b, c, d, e, f } = worldTf;
        const originX = e + node.a11yOffsetX;
        const originY = f + node.a11yOffsetY;

        // Attach to the owning container when ARIA requires containment, and
        // rebase the box into its coordinate space. Re-checked every frame
        // rather than only at creation: pooled hotspots migrate between parents
        // at runtime (a Table's rows re-parent when virtualization turns on),
        // and a mirror left under its previous container reads as a cell of the
        // wrong row.
        const parentEl =
          nestedIn && nestedIn.el !== el && nestedIn.el.isConnected ? nestedIn.el : this.a11yRoot;
        if (el.parentNode !== parentEl) {
          parentEl.appendChild(el);
          this.a11yNeedsReorder = true;
        }

        if (parentEl === this.a11yRoot) {
          el.style.left = `${originX}px`;
          el.style.top = `${originY}px`;
          el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;
        } else {
          const box = rebaseChildBox(
            nestedIn!.transform,
            nestedIn!.originX,
            nestedIn!.originY,
            worldTf,
            originX,
            originY,
          );
          el.style.left = `${box.left}px`;
          el.style.top = `${box.top}px`;
          el.style.transform = box.matrix;
        }
        el.style.width = `${node.width}px`;
        el.style.height = `${node.height}px`;

        // Hand this node down as the container for its own subtree if ARIA
        // makes it one. Reuses the transform computed just above rather than
        // re-deriving it, and captures it here so a descendant rebases against
        // the geometry actually written this frame.
        const owned = attrs.role ? A11Y_REQUIRED_OWNED.get(attrs.role) : undefined;
        if (owned) {
          childContainer = { el, owned, transform: worldTf, originX, originY };
        }

        // Viewport/clip gate: an interactive mirror scrolled outside its
        // clipChildren ancestor (a Button in a ScrollView/VirtualList) or the
        // viewport must stop intercepting clicks, taking focus, and being
        // announced — otherwise it steals input over whatever is drawn on top.
        // Same exact (margin 0) test the content-projection branch uses.
        const visible = this.projectionBoxVisible(node, worldTf, 0);
        const display = visible ? '' : 'none';
        if (el.style.display !== display) el.style.display = display;
      }

      // Geometry is now written, so the mirror can report a truthful scroll box.
      emitInitialScroll?.();
    }

    // Charge content projection and the per-node work separately, to the calling
    // node only — children recurse below and record their own — so totals are
    // additive across the walk rather than nested.
    if (this._phaseTiming) {
      const projectionStart = performance.now();
      this.syncContentProjection(node);
      this._recordPhase('contentProjection', performance.now() - projectionStart);
      this._recordPhase('a11yNodes', projectionStart - nodeStart);
    } else {
      this.syncContentProjection(node);
    }

    for (const child of node.children) this.syncA11y(child, childContainer);
    if (node === this.root) {
      // Overlays are their own stacking/containment context: a submenu mounts on
      // `overlayRoot`, not on the menu that opened it, so it must not inherit
      // whatever container the tree walk happened to end on.
      for (const overlay of this.overlayRoot.children) this.syncA11y(overlay, null);
    }
  }

  /**
   * Mirror one entity's static text ({@link Entity.getContentProjection}) as a
   * transparent DOM node positioned over the drawn glyphs. Runs on the a11y
   * sync cadence; all writes are dirty-checked. Off-viewport projections are
   * hidden (`display: none`) so text-heavy scenes only materialize what is
   * visible to the browser's text machinery anyway — except in the coarse
   * (resident) tier, which stays displayed because hiding it would make its text
   * unfindable and remove it from the accessibility tree, defeating the tier.
   */
  /**
   * Whether `node`'s world-space box, expanded by `margin` px on every side,
   * overlaps the scene viewport AND every `clipChildren` ancestor's box. Used
   * both to virtualize content projection (materialize only near-viewport text,
   * at `margin = contentProjectionMargin`) and for the exact `display:none`
   * visibility test (`margin = 0`). Boundless nodes (width/height 0) opt out of
   * culling and always count as visible, matching the legacy behavior.
   *
   * `viewportOnly` skips the `clipChildren` ancestor walk, answering the narrower
   * question "does this box overlap the viewport at all". The coarse content tier
   * needs the two apart: text that is merely off-viewport is clipped by
   * `a11yRoot`'s own `overflow: hidden` and can safely stay displayed, while text
   * rejected by an ancestor clip box that itself overlaps the viewport would sit
   * transparently on top of whatever is really drawn there.
   */
  /**
   * Load `parent`'s world transform into the `_pw*` scalar memo.
   *
   * Exists so the settled-walk fast path costs no allocation. The walk visits a
   * parent's children consecutively, so this recomputes at most once per parent
   * per sync and is a serial + identity comparison for every child after the
   * first. See the `_pwNode` field for why it is keyed the way it is.
   */
  private readParentWorld(parent: Entity): void {
    if (this._pwNode === parent && this._pwSerial === this._syncSerial) return;
    const tf = parent.getWorldTransform();
    this._pwa = tf.a;
    this._pwb = tf.b;
    this._pwc = tf.c;
    this._pwd = tf.d;
    this._pwe = tf.e;
    this._pwf = tf.f;
    this._pwNode = parent;
    this._pwSerial = this._syncSerial;
  }

  private projectionBoxVisible(
    node: Entity,
    tf: { a: number; b: number; c: number; d: number; e: number; f: number },
    margin: number,
    viewportOnly = false,
  ): boolean {
    if (!(node.width > 0 && node.height > 0)) return true;
    const { a, b, c, d, e, f } = tf;
    const worldCorners: Array<{ x: number; y: number }> = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const lx = i & 1 ? node.width : 0;
      const ly = i & 2 ? node.height : 0;
      const wx = a * lx + c * ly + e;
      const wy = b * lx + d * ly + f;
      worldCorners.push({ x: wx, y: wy });
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
    if (
      !(
        maxX >= -margin &&
        minX <= this.width + margin &&
        maxY >= -margin &&
        minY <= this.height + margin
      )
    ) {
      return false;
    }
    if (viewportOnly) return true;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.clipChildren || ancestor.width <= 0 || ancestor.height <= 0) continue;
      let localMinX = Infinity;
      let localMinY = Infinity;
      let localMaxX = -Infinity;
      let localMaxY = -Infinity;
      for (const corner of worldCorners) {
        const local = ancestor.worldToLocal(corner.x, corner.y);
        if (!local) continue;
        localMinX = Math.min(localMinX, local.x);
        localMinY = Math.min(localMinY, local.y);
        localMaxX = Math.max(localMaxX, local.x);
        localMaxY = Math.max(localMaxY, local.y);
      }
      if (
        !(
          localMaxX >= -margin &&
          localMinX <= ancestor.width + margin &&
          localMaxY >= -margin &&
          localMinY <= ancestor.height + margin
        )
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The band of an entity's own y coordinates that is worth projecting, or
   * `null` to project everything.
   *
   * {@link projectionBoxVisible} answers "is this entity near the viewport",
   * which frees whole blocks that scroll away. It cannot help a single entity
   * *taller* than the viewport: that entity's box always intersects, so every
   * one of its visual lines was materialized — a `<span>` per line and, on the
   * grid path, a `<span>` per glyph cluster. That is where "14.8k elements for a
   * 346KB Markdown doc" comes from, and it is O(document) rather than
   * O(viewport) in both element count and per-frame walk cost.
   *
   * Measured on one entity scrolled to its middle, real headed browsers
   * (`benchmarks/projection-per-line/`): at 4000 lines, materializing every line
   * costs 6.28 ms/frame on Chrome and 6.51 ms on Firefox with 36,000 child
   * elements, against 0.28/0.16 ms and 963 elements when only the visible band
   * is emitted. The gated cost is *flat* across a 20x document-size range, so
   * this converts an asymptote rather than shaving a constant.
   *
   * Returns local-y bounds in the entity's own coordinate space, already
   * expanded by `margin` and intersected with every `clipChildren` ancestor, so
   * a line inside a scrolled container is measured against the container rather
   * than the window. `null` means "no useful bound" — a degenerate transform, a
   * rotation/skew that makes a y-band meaningless, or a boundless entity — and
   * the caller must then project every line, because emitting nothing would
   * silently drop text from selection, find-in-page and screen readers.
   */
  private projectionVisibleLocalYBand(
    node: Entity,
    tf: { a: number; b: number; c: number; d: number; e: number; f: number },
    margin: number,
  ): { minY: number; maxY: number } | null {
    const { b, d, f } = tf;
    // A y band is only meaningful when local y maps to world y monotonically.
    // Any rotation or skew mixes local x into world y (b !== 0), so one local-y
    // interval no longer corresponds to one world band and the whole entity has
    // to be projected.
    if (b !== 0 || d === 0 || !Number.isFinite(d) || !Number.isFinite(f)) return null;

    // Invert wy = d * ly + f over the viewport band, expanded by margin.
    const top = (-margin - f) / d;
    const bottom = (this.height + margin - f) / d;
    let minY = Math.min(top, bottom);
    let maxY = Math.max(top, bottom);

    // Intersect with each clipping ancestor's own visible band, expressed in
    // this entity's local y. `worldToLocal` handles the full ancestor chain, so
    // two points are enough to recover the mapping for an axis-aligned case.
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.clipChildren || ancestor.width <= 0 || ancestor.height <= 0) continue;
      const originWorldY = f;
      const unitWorldY = d + f;
      const originLocal = ancestor.worldToLocal(tf.e, originWorldY);
      const unitLocal = ancestor.worldToLocal(tf.e + tf.c, unitWorldY);
      if (!originLocal || !unitLocal) return null;
      const slope = unitLocal.y - originLocal.y;
      if (slope === 0 || !Number.isFinite(slope)) return null;
      const a1 = (-margin - originLocal.y) / slope;
      const a2 = (ancestor.height + margin - originLocal.y) / slope;
      minY = Math.max(minY, Math.min(a1, a2));
      maxY = Math.min(maxY, Math.max(a1, a2));
    }

    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY < minY) return null;
    return { minY, maxY };
  }

  private syncContentProjection(node: Entity): void {
    if (!this.contentProjectionEnabled || !this.a11yRoot) return;
    let el = this.contentElements.get(node.id);

    // Settled-walk fast path: answer "nothing about this block changed" from
    // scalar field reads alone, BEFORE composing a world transform or running a
    // single box test. (vectojs#350, CTX-0222)
    //
    // The dirty-track comparison further down already stops an unchanged block,
    // but only after paying `getWorldTransform()` plus two `projectionBoxVisible()`
    // calls, each an O(ancestor-depth) ancestor walk. On a settled document that
    // is the *entire* remaining per-frame cost, and it is paid forever on a
    // document where nothing changes: measured 3.0-3.2 ms at 10 000 blocks, 72%
    // of a 4.16 ms frame at 240 Hz (CTX-0203, PX-0401). The resident tier pays it
    // twice per block, because `contentSemanticMargin: Infinity` means the cheap
    // semantic gate below never fires.
    //
    // Why the two recorded transforms are sufficient, and not merely a heuristic:
    // `Entity.getWorldTransform()` composes the parent chain's world matrix with
    // this entity's local `{x, y, scaleX, scaleY, rotation}` and nothing else. So
    // an unchanged parent world matrix and unchanged local components imply an
    // unchanged world matrix by construction. Everything the full path then
    // derives — `tier`, `lineBand`, `visible` — is a pure function of that matrix,
    // the node's box, and scene state that has its own recorded key
    // (`fontEpoch`, and the viewport, handled below). Hence: same inputs, same
    // outputs, no DOM write needed.
    //
    // The four things that can change WITHOUT touching either transform are all
    // still checked here, and each one is load-bearing:
    //
    //   - `epoch` — the block's own text. A coarse resident block emits one text
    //     node carrying its whole text, so a streaming edit to a block far above
    //     the viewport would otherwise leave permanently stale text in the
    //     accessibility tree and in find-in-page, with nothing to ever correct
    //     it. This is why the fast path can never key on position alone.
    //   - `fontEpoch` — a webfont finishing load or a browser zoom re-measures
    //     every block without moving any of them.
    //   - `width`/`height` — a re-wrapped block changes box without changing
    //     position, which changes both its tier and its band.
    //   - `interactive` — drives `aria-hidden` on the text copy.
    //
    // And the viewport: scrolling a document moves the ROOT, so every block's
    // parent world matrix changes and the check correctly fails for all of them.
    // A scene *resize* moves nothing, so `contentViewportEpoch` is bumped by the
    // resize path and compared here; without it a re-tiered block would keep DOM
    // built for the old viewport.
    const prior0 = this.disableSettledFastPath ? undefined : this.contentSyncState.get(node.id);
    if (prior0 !== undefined && el !== undefined) {
      const epoch0 = node.getContentEpoch();
      if (
        epoch0 !== null &&
        prior0.epoch === epoch0 &&
        prior0.fontEpoch === this.contentFontEpoch &&
        prior0.viewportEpoch === this.contentViewportEpoch &&
        prior0.lx === node.x &&
        prior0.ly === node.y &&
        prior0.lScaleX === node.scaleX &&
        prior0.lScaleY === node.scaleY &&
        prior0.lRotation === node.rotation &&
        prior0.width === node.width &&
        prior0.height === node.height &&
        prior0.interactive === node.interactive
      ) {
        const parent = node.parent;
        if (parent === null) {
          if (
            prior0.pa === 1 &&
            prior0.pb === 0 &&
            prior0.pc === 0 &&
            prior0.pd === 1 &&
            prior0.pe === 0 &&
            prior0.pf === 0
          ) {
            return;
          }
        } else {
          this.readParentWorld(parent);
          if (
            prior0.pa === this._pwa &&
            prior0.pb === this._pwb &&
            prior0.pc === this._pwc &&
            prior0.pd === this._pwd &&
            prior0.pe === this._pwe &&
            prior0.pf === this._pwf
          ) {
            return;
          }
        }
      }
    }

    const releaseProjectionEl = (): void => {
      if (el) {
        this.clearContentGridState(node.id, el);
        el.remove();
        this.contentElements.delete(node.id);
        this.a11yNeedsReorder = true;
      }
      // Also when there was no element: an entity whose projection has gone
      // null keeps no state, so a later re-materialization starts clean rather
      // than comparing against a record describing DOM that no longer exists.
      this.contentSyncState.delete(node.id);
    };

    // Virtualize FIRST, before computing the projection. Only materialize
    // projections near the viewport. Without this, a document taller than the
    // screen creates a DOM element (plus a `<span>` per visual line) for EVERY
    // block — measured 14.8k elements for a 346KB Markdown doc — which dominates
    // heap and forces the browser to reflow all of them whenever the view
    // scrolls. Far-off-screen projections are freed here and re-materialized
    // when they scroll back within the margin.
    //
    // The gate is hoisted ABOVE getContentProjection() on purpose: that call is
    // O(glyphs-in-block) and, run unconditionally for every block every synced
    // frame, made a streaming/long document cost O(total document glyphs) per
    // frame — the dominant driver of the streaming FPS decay (CTX-0024). The
    // gate needs only node/worldTf/margin, not the projection, so off-viewport
    // blocks now cost O(1). (carryctx CTX-0024)
    const worldTf = node.getWorldTransform();
    // Two margins, two independent gates. `interactionMargin` decides whether
    // this block's per-line CARRIERS are built; `semanticMargin` decides whether
    // it has any projected DOM at all. They default to the same value, so a scene
    // that sets neither, or only the interaction margin, behaves exactly as
    // before. Setting `contentSemanticMargin: Infinity` with a finite interaction
    // margin is the coarse resident tier: whole-document text findable, carriers
    // still bounded by the viewport. (carryctx CTX-0201, DEC-01KZ6RSS)
    const interactionMargin = this.contentProjectionMargin ?? this.height;
    const semanticMargin = this.contentSemanticMargin ?? interactionMargin;
    if (
      Number.isFinite(semanticMargin) &&
      !this.projectionBoxVisible(node, worldTf, semanticMargin)
    ) {
      releaseProjectionEl();
      return;
    }

    // Which tier this block gets. `coarse` means it survived the semantic gate
    // but is outside the interaction margin, so it projects its full text as one
    // node and NO carriers.
    //
    // Decided by a box test rather than by inspecting the line window, for two
    // reasons. It is O(ancestor-depth) and allocation-free, where the window
    // needs the projection built first — the very O(glyphs) call this avoids. And
    // it must be knowable BEFORE the dirty-track comparison below, because the
    // tier is part of what that comparison keys on.
    const inInteractionBand =
      !Number.isFinite(interactionMargin) ||
      this.projectionBoxVisible(node, worldTf, interactionMargin);
    const tier: ContentSyncTier = inInteractionBand ? 'fine' : 'coarse';

    // Which of this entity's own lines are worth materializing. Only meaningful
    // for an entity taller than the band; `null` disables per-line gating and
    // every line is projected, which is the conservative direction.
    //
    // Deliberately NOT computed for the coarse tier. The band is the viewport
    // expressed in entity-local y, UNCLAMPED to the entity's own box, so it
    // carries the viewport's position and moves whenever the view or the entity
    // does. A resident off-band block that recorded one could never match on a
    // later frame, so every resident block would rebuild — O(total document
    // glyphs) per frame, the CTX-0024 regression this tier exists to avoid.
    const lineBand =
      tier === 'coarse'
        ? null
        : Number.isFinite(interactionMargin)
          ? this.projectionVisibleLocalYBand(node, worldTf, interactionMargin)
          : null;

    // Exact (margin 0) viewport/clip test, used both for the dirty-track
    // comparison below and for `display` at the end of a full sync. Computed
    // once: it is an O(ancestor-depth) walk and both readers want the same
    // answer for the same frame.
    const visible = this.projectionBoxVisible(node, worldTf, 0);

    // Dirty-track: an entity that can stamp its own content lets a sync whose
    // content AND geometry are both unchanged stop here — crucially BEFORE
    // getContentProjection(), which is O(glyphs-in-block), and before the DOM
    // diff around it.
    //
    // The margin gate above already frees blocks far from the viewport, so what
    // remains is the resident set; for a long document with a wide margin that
    // set is most of it, and re-deriving byte-identical DOM for all of it every
    // synced frame is the dominant idle cost. Measured on a 1500-block resident
    // document: a sync in which `a11yRoot.textContent` was byte-identical before
    // and after still cost 17.875 ms, and 19.455 ms fell to 0.475 ms once
    // unchanged blocks stopped here (~41x). Memoizing the projection object
    // instead saved only 19%, because the walk and the diff — not the build —
    // are where the time goes. (carryctx CTX-0199, vectojs#343)
    //
    // Requires `el` to already exist: with no DOM node there is nothing to
    // preserve, so a first sync (or one after the margin gate freed the node)
    // always runs in full.
    const epoch = node.getContentEpoch();
    const prior = this.contentSyncState.get(node.id);
    if (epoch !== null && el && prior !== undefined) {
      const { a, b, c, d, e, f } = worldTf;
      if (
        prior.epoch === epoch &&
        prior.fontEpoch === this.contentFontEpoch &&
        prior.a === a &&
        prior.b === b &&
        prior.c === c &&
        prior.d === d &&
        prior.e === e &&
        prior.f === f &&
        prior.tier === tier &&
        prior.hasBand === (lineBand !== null) &&
        (lineBand === null ||
          (prior.bandMin === lineBand.minY && prior.bandMax === lineBand.maxY)) &&
        prior.visible === visible &&
        prior.width === node.width &&
        prior.height === node.height &&
        prior.interactive === node.interactive
      ) {
        return;
      }
    }

    // Materialization budget: spread a resident tier's document-open cost across
    // frames instead of paying it in one synchronous pass.
    //
    // Measured unbudgeted, `firstSyncMs` for the resident tier is 21.3 ms at 1000
    // blocks and 139.5 ms at 10000 on Chrome (21.9 / 141.6 Firefox) — at 10000 far
    // past the ~30 ms trigger DEC-01KZ6RSS set for needing exactly this. The cost
    // is per node CREATED, not per node held (10000 resident blocks cost ~3.0
    // ms/sync at steady state, the same as a settled document of that size), which
    // is what makes it a scheduling problem rather than a caching one.
    //
    // Do not reuse the 46.72 ms / ~13µs-per-node figures that DEC-01KZ6Z2K recorded
    // for this path: both were taken while a coarse block was `display: none` and
    // therefore outside layout, i.e. against a tier that did not yet deliver the
    // reachability it exists for. Removing that (CTX-0203) changed the cost, and
    // fixing the forced layout per rebuilt element changed it again.
    //
    // Four conditions, each load-bearing:
    //
    // - `tier === 'coarse'`: the fine tier is on screen or next to it, and text a
    //   user can see must be selectable in the same frame it is drawn. Only the
    //   resident tier's off-viewport blocks are deferrable.
    // - `!el`: a block that already HAS an element is being updated, not created.
    //   Deferring that would leave stale text in the DOM — silently wrong, and
    //   worse than the stall. The budget only ever delays a FIRST appearance.
    // - budget exhausted: the count for this sync is spent.
    // - placed AFTER the dirty-track early-return and BEFORE
    //   `getContentProjection()`, so a deferred block costs only the O(ancestor-
    //   depth) box tests already computed above and never the O(glyphs) build.
    //
    // A deferred block is simply not yet in the DOM — the same state as a block
    // beyond the margin — so nothing is findable-yet-empty. It cannot thrash
    // either: with no element, there is no DOM to rebuild, and `contentSyncState`
    // records nothing for it. The walk visits blocks in scene-graph order, so
    // already-materialized blocks stop consuming budget and the frontier advances
    // on every sync until the document is complete.
    //
    // A COUNT, not a time slice — deliberately, and re-tested after the per-block
    // cost changed. A deadline is deterministic only if the clock is injected, and
    // is unreproducible in a benchmark. It also cannot help here: a pass pays a
    // floor before creating anything (measured 3.2ms at 10000 blocks, and the same
    // 3.0ms for a fully-settled document, so it is the pre-existing cost of walking
    // the tree rather than anything the budget introduced). A deadline only adapts
    // the count to that floor — at 10000 blocks a 4.2ms/240Hz deadline admits ~35
    // blocks per pass, which is ~285 passes and worse than a fixed 256 on both
    // total time and worst pass. Per-block cost is also flat and small (~0.03ms),
    // because a coarse block emits one text node regardless of its length, so a
    // count predicts the work well.
    if (tier === 'coarse' && !el && this.contentSemanticBudgetLeft <= 0) {
      this.contentSemanticDeferred = true;
      return;
    }

    // Hand the band to the entity so an O(glyphs) projection build can become
    // O(visible glyphs). Windowing only the DOM leaves this call rebuilding the
    // whole document every synced frame, which measured as no time win at all
    // (Chrome 1.1x, Firefox 0.95x) despite 35x fewer elements.
    const projection = node.getContentProjection(
      lineBand ? { minY: lineBand.minY, maxY: lineBand.maxY } : undefined,
    );

    if (!projection || !projection.text) {
      releaseProjectionEl();
      return;
    }

    if (!el) {
      // Charged only for the coarse tier, and only on creation. The fine tier is
      // never budgeted, so it must not consume from the same pool — otherwise a
      // viewport full of new text would starve the resident tier, or vice versa.
      if (tier === 'coarse') this.contentSemanticBudgetLeft--;
      el = document.createElement('div');
      el.setAttribute('data-vecto-content', node.id);
      const s = el.style;
      s.position = 'absolute';
      s.transformOrigin = '0 0';
      s.margin = '0';
      s.padding = '0';
      // The canvas owns the pixels; the DOM node only carries the text.
      s.color = 'transparent';
      s.forcedColorAdjust = 'none';
      s.setProperty('-webkit-text-fill-color', 'transparent');
      s.whiteSpace = 'pre-wrap';
      // No overflow:hidden — the a11yRoot clips at the viewport boundary.
      // Removing it lets the browser start text selection from padding/blank
      // regions inside the entity and extend selection beyond entity bounds.
      s.zIndex = '0'; // beneath the interactive a11y elements
      // Keep scroll containers working when the pointer is over selectable text.
      el.addEventListener(
        'wheel',
        (e) => {
          node.dispatchEvent(new VectoJSEvent('wheel', node, e));
        },
        { passive: false },
      );
      this.a11yRoot.appendChild(el);
      this.contentElements.set(node.id, el);
      this.a11yNeedsReorder = true;
    }

    const lines = projection.lines;
    // Tier, not `lines`, selects the branch.
    //
    // This used to read `else if (lines && lines.length > 0)`, so an entity that
    // returned lines could never reach the plain-text branch. Under a resident
    // semantic tier that is wrong in both directions: keeping the lines branch
    // emits one spurious carrier per off-band block (`projectionLineWindow`
    // falls back to the nearest line when nothing overlaps the band), while
    // handing it an empty window would `replaceChildren()` and add nothing,
    // BLANKING the text — the silent-staleness failure, worse than the carrier.
    //
    // The plain-text branch below is already exactly the coarse tier, and every
    // real `getContentProjection` returns the block's FULL text regardless of the
    // hint (`ui/Text`, `ui/RichText`, `markdown/CodeBlock` all narrow only
    // `lines`), so routing to it preserves the whole string. Keeping the decision
    // here also keeps it in the engine, rather than depending on every entity
    // voluntarily returning a coarse-only projection.
    const useCarriers = tier === 'fine';
    if ((!projection.grid || !useCarriers) && el.dataset.vectoContentGrid !== undefined) {
      this.clearContentGridState(node.id, el);
    }
    if (projection.grid && useCarriers) {
      const gridSyncStart = this._phaseTiming ? performance.now() : 0;
      this.syncContentGridProjection(node, el, projection, projection.grid, lineBand);
      if (this._phaseTiming) this._recordPhase('gridSync', performance.now() - gridSyncStart);
    } else if (useCarriers && lines && lines.length > 0) {
      // Which lines to materialize. A tall entity passes the box gate above and
      // would otherwise emit a carrier for every line in the document; only the
      // band near the viewport is observable, so only that band is built.
      const lineWindow = projectionLineWindow(lines, lineBand, projection.lineHeight ?? 16);
      const signature = JSON.stringify({
        lines,
        fallbackFont: projection.font ?? '',
        fallbackLineHeight: projection.lineHeight ?? 16,
        // Part of the signature, or scrolling would not rebuild the carriers and
        // the window would stay frozen where it was first built. Quantized to
        // whole line indices by construction, so a sub-pixel scroll inside one
        // line does not churn the DOM.
        window: lineWindow.gated ? `${lineWindow.start}-${lineWindow.end}` : 'all',
      });
      if (el.dataset.vectoProjectionLines !== signature) {
        this.preserveContentSelectionAcrossRebuild(el, () => {
          el.replaceChildren();
          for (let index = lineWindow.start; index < lineWindow.end; index++) {
            const line = lines[index];
            const lineElement = document.createElement('span');
            const lineFont = line.font ?? projection.font ?? '';
            const lineHeight = line.lineHeight ?? projection.lineHeight ?? 16;
            const hasPositionedRuns = !!line.runs && line.runs.some((run) => run.x !== undefined);
            lineElement.style.position = 'absolute';
            // Positioned carriers already encode visual order via each run's x
            // (the engine did the bidi reorder). Force LTR flow so the browser
            // lays them out in DOM order and does NOT re-bidi them — otherwise an
            // RTL line re-reverses the carriers and the running left = x - logicalX
            // accounting breaks. Natural-flow lines keep auto so the browser bidis
            // the plain text.
            lineElement.dir = hasPositionedRuns ? 'ltr' : 'auto';
            lineElement.style.left = `${line.x}px`;
            lineElement.style.top = `${line.y + line.baseline - cssLineBoxBaseline(lineFont, lineHeight)}px`;
            lineElement.style.whiteSpace = 'pre';
            if (lineFont) lineElement.style.font = lineFont;
            // Assigning the CSS `font` shorthand resets line-height to `normal`.
            // Set the explicit line box afterwards, or selection geometry drifts
            // differently in each browser for mixed-size text.
            lineElement.style.lineHeight = `${lineHeight}px`;
            // Against the DOCUMENT's last line, not the window's: a windowed
            // last line still has text after it, so it keeps its separator and a
            // copy spanning the window boundary stays line-broken correctly.
            const separator = line.separatorAfter ?? (index < lines.length - 1 ? '\n' : '');
            if (line.runs && line.runs.length > 0) {
              // Positioned runs (justify / RTL / non-natural spacing): each run
              // carries its own absolute canvas x. Place each as an ABSOLUTELY
              // positioned carrier at `left = run.x - line.x` inside the line
              // (itself absolutely positioned, so it is the containing block).
              // Absolute (not flow-relative) positioning is what lets the DOM
              // order stay LOGICAL — correct for copy / screen readers / RTL —
              // while every box still lands at its VISUAL x, so the selection
              // rectangles overlap the drawn glyphs regardless of order. (A
              // flow-relative `left = x - runningX` only works when runs are in
              // visual order, which RTL logical-order runs are not.)
              const positioned = line.runs.some((run) => run.x !== undefined);
              for (let runIndex = 0; runIndex < line.runs.length; runIndex++) {
                const run = line.runs[runIndex];
                const runElement = document.createElement('span');
                // Keep the separator in the final logical Text node. Firefox
                // emits a duplicate Range rectangle when the same positioned
                // line contains a second, separator-only Text node.
                runElement.textContent =
                  run.text + (runIndex === line.runs.length - 1 ? separator : '');
                if (run.font) runElement.style.font = run.font;
                // A run-level font shorthand also resets line-height. Preserve
                // the visual line's shared baseline for every mixed-size run.
                runElement.style.lineHeight = `${lineHeight}px`;
                if (positioned && run.x !== undefined) {
                  runElement.style.position = 'absolute';
                  runElement.style.left = `${run.x - line.x}px`;
                  runElement.style.top = '0';
                  if (run.width !== undefined) runElement.style.width = `${run.width}px`;
                  runElement.style.whiteSpace = 'pre';
                  runElement.style.verticalAlign = 'top';
                  // Isolate each carrier's own bidi so a single RTL/base char in
                  // the box isn't mirrored relative to its neighbors — the
                  // carrier's x already places it in visual order.
                  runElement.style.unicodeBidi = 'isolate';
                  runElement.dir = 'ltr';
                }
                lineElement.appendChild(runElement);
              }
            } else {
              lineElement.textContent = line.text + separator;
            }
            el.appendChild(lineElement);
          }
        });
        el.dataset.vectoProjectionLines = signature;
        // Publish the window so a consumer can tell "this text is not here" from
        // "this text does not exist", and so the dev-mode projection check knows
        // the DOM holds a subset by design. Removed when not gated, or a stale
        // attribute would keep suppressing the equality check.
        if (lineWindow.gated) {
          el.dataset.vectoProjectionWindow = `${lineWindow.start}-${lineWindow.end}/${lines.length}`;
        } else {
          delete el.dataset.vectoProjectionWindow;
        }
      }
    } else {
      // Demoting a block from the fine tier leaves carrier spans whose
      // concatenated text can already EQUAL `projection.text`, so a text-only
      // comparison would skip the assignment and strand them. Setting
      // `textContent` is what removes them.
      //
      // Scoped to the coarse tier deliberately. An entity can reach this branch
      // in the DEFAULT configuration while still holding carriers from an earlier
      // sync — a Table cell does, and its spans are what give the browser the
      // geometry to drag-select through. Rebuilding it there would release the
      // selection mid-drag, since `releaseContentSelectionForRebuild` fires
      // exactly when the element owns the selection. Withdrawing carriers is
      // right only when the block really is leaving the interaction band, which
      // is what `tier === 'coarse'` means.
      const demoted = tier === 'coarse' && el.children.length > 0;
      if (el.textContent !== projection.text || demoted) {
        this.releaseContentSelectionForRebuild(el);
        el.textContent = projection.text;
      }
      delete el.dataset.vectoProjectionLines;
      // A demoted block was gated while it was fine-tiered, so it carries a
      // window marker claiming its DOM holds a subset by design — which would
      // suppress the dev-mode projection equality check even though the coarse
      // tier holds the whole text. Left alone outside the coarse tier to keep the
      // default path byte-identical.
      if (tier === 'coarse') delete el.dataset.vectoProjectionWindow;
    }

    const font = projection.font ?? '';
    if (el.style.font !== font) el.style.font = font;
    const lineHeight = projection.lineHeight !== undefined ? `${projection.lineHeight}px` : '';
    if (el.style.lineHeight !== lineHeight) el.style.lineHeight = lineHeight;

    // Grid-drawn text (ligatures: 'none') needs the DOM copy laid out with
    // the same per-cell advances as the canvas; inherited by the line spans.
    const ligatures = projection.ligatures === 'none' ? 'none' : '';
    if (el.style.getPropertyValue('font-variant-ligatures') !== ligatures) {
      el.style.setProperty('font-variant-ligatures', ligatures);
      el.style.setProperty('font-kerning', ligatures ? 'none' : '');
    }

    // Interactive entities already project an a11y node — hide the text copy
    // from screen readers so nothing is announced twice. Static text has no
    // other semantic presence, so it stays exposed.
    const hidden = node.interactive ? 'true' : null;
    if (el.getAttribute('aria-hidden') !== hidden) {
      if (hidden) el.setAttribute('aria-hidden', hidden);
      else el.removeAttribute('aria-hidden');
    }

    // Selection is opt-in: pointer-events on the text would otherwise
    // intercept canvas input over every text block.
    const selectable = projection.selectable === true;
    const pointerEvents = selectable ? 'auto' : 'none';
    if (el.style.pointerEvents !== pointerEvents) {
      el.style.pointerEvents = pointerEvents;
      el.style.userSelect = selectable ? 'text' : 'none';
      el.style.cursor = selectable ? 'text' : '';
    }

    // Geometry: same threading as the interactive branch. Reuse the world
    // transform already read for the virtualization gate above.
    const { a, b, c, d, e, f } = worldTf;
    const contentX = projection.contentX ?? 0;
    const contentY = projection.contentY ?? 0;
    const baselineOffset =
      lines && lines.length > 0
        ? 0
        : projection.baseline === undefined
          ? 0
          : projection.baseline - cssLineBoxBaseline(font, projection.lineHeight ?? 16);
    // `contentX/Y` are local coordinates, like the arguments to Canvas
    // fillText. Map them through the world matrix before moving the DOM root;
    // otherwise a scaled or rotated entity selects text in a different place.
    const localY = contentY + baselineOffset;
    el.style.left = `${e + a * contentX + c * localY}px`;
    el.style.top = `${f + b * contentX + d * localY}px`;
    if (node.width > 0) el.style.width = `${node.width}px`;
    if (node.height > 0) el.style.height = `${node.height}px`;
    el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;

    // Viewport/clip: a materialized-but-off-viewport mirror (inside the
    // virtualization margin) must not keep intercepting input or announce text.
    // Exact (margin 0) test against viewport + clipChildren ancestors, computed
    // once above and shared with the dirty-track comparison.
    //
    // A scene that opted into a WIDER SEMANTIC MARGIN is the exception, and it has
    // to be: `display: none` text is skipped by find-in-page and absent from the
    // accessibility tree, so hiding a resident block would leave the tier
    // delivering a DOM node and none of the capability it exists for. The coarse
    // tier also IMPLIES `visible === false` — a coarse block is outside the
    // interaction margin, every margin is >= 0, so it fails the margin-0 test by
    // construction. Left as-is, `contentSemanticMargin: Infinity` could never
    // expose anything at all.
    //
    // Keyed on the OPT-IN rather than on `tier === 'coarse'`, which would leave a
    // hole: a block inside the interaction margin but outside the exact viewport is
    // fine-tiered, so it would stay hidden while blocks FURTHER away were exposed.
    // Find-in-page would then skip a band of matches just off-screen while
    // reporting ones below it — text closer to the viewport being less reachable
    // than text far from it. `tier === 'coarse'` already implies this opt-in (with
    // equal margins, failing the interaction gate means failing the semantic gate,
    // so the block was released above), so testing the opt-in subsumes the coarse
    // case rather than widening it.
    //
    // Exposing it is safe only because of where these elements live. `a11yRoot` is
    // viewport-sized with `overflow: hidden` and is not scrollable, so an
    // off-viewport carrier is clipped rather than painted, and the browser has
    // nowhere to scroll a find match into view — measured in real Chrome 151:
    // `window.find` reaches the clipped text while `a11yRoot.scrollTop` and
    // `window.scrollY` both stay 0. Its `pointer-events` also still follow
    // `projection.selectable`, and its geometry is off-viewport, so it intercepts
    // nothing a user can reach.
    //
    // That reasoning only covers text the VIEWPORT rejects. A block rejected by a
    // `clipChildren` ancestor whose own box overlaps the viewport (scrolled out of
    // a ScrollView, but still over the canvas) would be transparent selectable
    // text on top of whatever is really drawn there, so it keeps `display: none`.
    // Hence the narrower viewport-only test rather than reusing `visible`.
    //
    // The default configuration is untouched: with no semantic margin the two
    // resolve equal, `residentTier` is false, and `display` is exactly
    // `visible ? '' : 'none'` as before. That matters beyond compatibility — a
    // scene that never asked for a resident tier should NOT have a screen reader
    // announcing text the sighted user cannot see.
    const residentTier = semanticMargin > interactionMargin;
    const display =
      visible || (residentTier && !this.projectionBoxVisible(node, worldTf, 0, true)) ? '' : 'none';
    if (el.style.display !== display) el.style.display = display;

    // Record what this sync was built from, so the next one can skip. Only for
    // entities that stamp their content: without an epoch the comparison can
    // never pass, and storing state for every projected entity in a long
    // document would be a per-entity allocation that never pays off.
    if (epoch !== null) {
      const { a, b, c, d, e, f } = worldTf;
      // Mutate the existing record in place when there is one — a steady-state
      // sync of an unchanged-but-not-skippable entity then allocates nothing.
      const next = prior ?? ({} as ContentSyncState);
      next.epoch = epoch;
      next.fontEpoch = this.contentFontEpoch;
      next.viewportEpoch = this.contentViewportEpoch;
      // Inputs to the world transform, for the settled-walk fast path. Recorded
      // from the node rather than derived from `worldTf`, because the point is to
      // compare them next sync WITHOUT composing a world transform.
      next.lx = node.x;
      next.ly = node.y;
      next.lScaleX = node.scaleX;
      next.lScaleY = node.scaleY;
      next.lRotation = node.rotation;
      if (node.parent === null) {
        next.pa = 1;
        next.pb = 0;
        next.pc = 0;
        next.pd = 1;
        next.pe = 0;
        next.pf = 0;
      } else {
        this.readParentWorld(node.parent);
        next.pa = this._pwa;
        next.pb = this._pwb;
        next.pc = this._pwc;
        next.pd = this._pwd;
        next.pe = this._pwe;
        next.pf = this._pwf;
      }
      next.a = a;
      next.b = b;
      next.c = c;
      next.d = d;
      next.e = e;
      next.f = f;
      next.tier = tier;
      next.hasBand = lineBand !== null;
      next.bandMin = lineBand?.minY ?? 0;
      next.bandMax = lineBand?.maxY ?? 0;
      next.visible = visible;
      next.width = node.width;
      next.height = node.height;
      next.interactive = node.interactive;
      if (prior === undefined) this.contentSyncState.set(node.id, next);
    }
  }

  /**
   * Materialize a prepared grid in logical source order while positioning each
   * carrier from the shared canvas geometry. Browser font measurement happens
   * later in one cold read/write batch, never inside projection synchronization.
   */
  private syncContentGridProjection(
    node: Entity,
    el: HTMLElement,
    projection: ContentProjection,
    grid: PreparedContentGrid,
    lineBand: { minY: number; maxY: number } | null,
  ): void {
    if (grid.source !== projection.text) {
      throw new Error('ContentProjection.grid.source must equal ContentProjection.text');
    }
    // Only the lines near the viewport get carriers. The grid path is where the
    // element volume lives — one `<span>` per glyph CLUSTER, not per line — so a
    // tall code block or table is exactly the case this bounds.
    const gridWindow = projectionGridLineWindow(grid, projection.lines, lineBand);
    // The window is part of the signature: scrolling changes which lines belong
    // without changing `grid.revision`, and without this the carriers would stay
    // frozen at whatever band was first built.
    const signature = gridWindow.gated
      ? `${grid.revision}:${gridWindow.start}-${gridWindow.end}`
      : `${grid.revision}`;
    if (el.dataset.vectoContentGrid !== signature) {
      const materializeStart = typeof performance !== 'undefined' ? performance.now() : 0;
      // Defer the selection decision until it is known which lines are rebuilt: a
      // selection sitting in an untouched line must survive, or streaming would
      // wipe it every frame.
      this.clearContentGridState(node.id, el, false);
      const projectionLines = projection.lines ?? [];
      const selectionLine = this.contentGridSelectionLine(el);
      let rebuiltSelectionLine = false;

      // Reuse carrier lines that did not change.
      //
      // The old code called `el.replaceChildren()` and rebuilt one `<span>` per
      // cell on every revision bump. Streaming text bumps the revision on every
      // append, so a growing code block re-created its whole carrier grid each
      // frame — about 8,200 `createElement` calls per frame for a 200x40 block,
      // measured as 898-1431 ms of `gridMaterialize` (53% of `a11ySync` on Chrome,
      // 79% on Firefox) while a streamed block dropped a third of its input.
      //
      // Appending text leaves every earlier line byte-identical, so each line
      // carries a signature of everything that determines its DOM and is rebuilt
      // only when that changes. This mirrors the line-prefix reuse already in
      // `CodeBlock.buildLines` (#232) — same insight, one layer further out.
      const existingLines = el.children;
      for (let lineIndex = gridWindow.start; lineIndex < gridWindow.end; lineIndex++) {
        // Children hold only the window, so a line's DOM slot is its offset from
        // the window start, not its document index.
        const domIndex = lineIndex - gridWindow.start;
        const gridLine = grid.lines[lineIndex];
        const projectedLine = projectionLines[lineIndex];
        const lineHeight = projectedLine?.lineHeight ?? grid.lineHeight;
        const baseline = projectedLine?.baseline ?? grid.baseline;
        const lineFont = projectedLine?.font ?? grid.font;

        const lineSignature = contentGridLineSignature(
          grid,
          gridLine,
          projectedLine,
          lineHeight,
          baseline,
          lineFont,
          lineIndex === 0,
        );
        const reusable = existingLines[domIndex] as HTMLElement | undefined;
        if (
          reusable !== undefined &&
          reusable.dataset.vectoGridLineSig === lineSignature &&
          reusable.dataset.vectoGridLine === `${lineIndex}`
        ) {
          continue;
        }

        if (selectionLine !== null && selectionLine === lineIndex) rebuiltSelectionLine = true;

        const lineElement = document.createElement('span');
        lineElement.dataset.vectoGridLineSig = lineSignature;
        // The prepared grid already resolved bidi x coordinates. Keep carrier
        // flow logical/LTR so the browser does not reorder it a second time.
        lineElement.dir = 'ltr';
        lineElement.dataset.vectoGridLine = `${lineIndex}`;
        lineElement.style.position = 'absolute';
        lineElement.style.left = `${projectedLine?.x ?? 0}px`;
        lineElement.style.top = `${
          (projectedLine?.y ?? lineIndex * grid.lineHeight) +
          baseline -
          cssLineBoxBaseline(lineFont, lineHeight)
        }px`;
        lineElement.style.width = `${gridLine.width}px`;
        lineElement.style.height = `${lineHeight}px`;
        lineElement.style.whiteSpace = 'pre';
        lineElement.style.font = lineFont;
        lineElement.style.lineHeight = `${lineHeight}px`;

        if (gridLine.cells.length === 0) {
          lineElement.textContent = grid.source.slice(gridLine.sourceEnd, gridLine.nextSourceStart);
        } else {
          let logicalX = 0;
          for (let cellIndex = 0; cellIndex < gridLine.cells.length; cellIndex++) {
            const cell = gridLine.cells[cellIndex];
            const cellElement = document.createElement('span');
            cellElement.dir = 'ltr';
            const separator =
              cellIndex === gridLine.cells.length - 1
                ? grid.source.slice(gridLine.sourceEnd, gridLine.nextSourceStart)
                : '';
            const sourceText = grid.source.slice(cell.sourceStart, cell.sourceEnd);
            cellElement.textContent = sourceText + separator;
            cellElement.dataset.vectoGridCell = `${cellIndex}`;
            cellElement.dataset.vectoGridSourceLength = `${sourceText.length}`;
            cellElement.dataset.vectoGridSourceStart = `${cell.sourceStart}`;
            cellElement.dataset.vectoGridSourceEnd = `${cell.sourceEnd}`;
            cellElement.dataset.vectoGridCaretOffsets = cell.sourceCaretOffsets.join(',');
            cellElement.dataset.vectoGridLevel = `${cell.level}`;
            cellElement.dataset.vectoGridAdvance = `${cell.advance}`;
            cellElement.dataset.vectoGridX = `${cell.x}`;
            // Stay in one logical inline flow so Firefox copy/find does not
            // synthesize a newline between carriers. Relative offsets encode
            // bidi visual order without changing DOM source order.
            cellElement.style.position = 'relative';
            cellElement.style.display = 'inline-block';
            cellElement.style.left = `${cell.x - logicalX}px`;
            cellElement.style.top = '0';
            cellElement.style.width = `${cell.advance}px`;
            cellElement.style.height = `${lineHeight}px`;
            cellElement.style.boxSizing = 'border-box';
            cellElement.style.verticalAlign = 'top';
            cellElement.style.whiteSpace = 'pre';
            cellElement.style.font = lineFont;
            cellElement.style.lineHeight = `${lineHeight}px`;
            cellElement.style.transformOrigin = '0 50%';
            // Mirror the font onto data attributes so calibration can read it back
            // without touching `style.font`, whose shorthand getter Chrome
            // re-serializes on every access (measured 99.3% of the calibration pass).
            cellElement.dataset.vectoGridFont = lineFont;
            cellElement.dataset.vectoGridLineHeight = `${lineHeight}px`;
            lineElement.appendChild(cellElement);
            logicalX += cell.advance;
          }
        }
        if (lineIndex === 0) {
          for (const [basis, left, top] of [
            ['origin', 0, 0],
            ['x', 1, 0],
            ['y', 0, 1],
          ] as const) {
            const marker = document.createElement('span');
            marker.dataset.vectoGridBasis = basis;
            marker.setAttribute('aria-hidden', 'true');
            marker.style.position = 'absolute';
            marker.style.left = `${left}px`;
            marker.style.top = `${top}px`;
            marker.style.width = '0';
            marker.style.height = '0';
            marker.style.pointerEvents = 'none';
            marker.style.userSelect = 'none';
            lineElement.appendChild(marker);
          }
        }
        // Replace in place when a line already occupies this index, so untouched
        // neighbours keep their identity (and any live selection anchored in them).
        const occupant = el.children[domIndex];
        if (occupant) el.replaceChild(lineElement, occupant);
        else el.appendChild(lineElement);
      }
      // Drop carriers past the end: the grid can shrink (an edit, a re-highlight),
      // and stale lines would otherwise stay visible to a screen reader and to
      // copy/find.
      const windowLength = gridWindow.end - gridWindow.start;
      while (el.children.length > windowLength) {
        // A selection outside the retained window loses its carrier, so treat it
        // as rebuilt and release it rather than leaving a Selection pointing at a
        // detached node.
        if (selectionLine !== null && selectionLine >= gridWindow.end) {
          rebuiltSelectionLine = true;
        }
        el.lastElementChild?.remove();
      }
      // Only now drop the selection, and only if the line holding it was actually
      // replaced. A selection in a reused line keeps its DOM nodes and stays live.
      if (rebuiltSelectionLine) this.releaseContentSelectionForRebuild(el);
      el.dataset.vectoProjectionLines = signature;
      el.dataset.vectoContentGrid = signature;
      if (gridWindow.gated) {
        el.dataset.vectoProjectionWindow = `${gridWindow.start}-${gridWindow.end}/${grid.lines.length}`;
      } else {
        delete el.dataset.vectoProjectionWindow;
      }
      el.dataset.vectoGridCarriers = `${el.querySelectorAll('[data-vecto-grid-cell]').length}`;
      if (typeof performance !== 'undefined') {
        const materializeMs = performance.now() - materializeStart;
        el.dataset.vectoGridMaterializeMs = `${materializeMs}`;
        if (this._phaseTiming) this._recordPhase('gridMaterialize', materializeMs);
      }
      delete el.dataset.vectoGridCalibration;
      delete el.dataset.vectoGridReady;
    }

    const pageScaleX = this.getContentMetricScaleX();
    const calibrationKey = `${signature}:${this.contentFontEpoch}:${pageScaleX.toFixed(4)}`;
    if (el.dataset.vectoGridCalibration !== calibrationKey) {
      const calibStart = this._phaseTiming ? performance.now() : 0;
      this.scheduleContentGridCalibration(node.id, el, calibrationKey, pageScaleX);
      if (this._phaseTiming) {
        this._recordPhase('gridCalibrateSchedule', performance.now() - calibStart);
      }
    }
  }

  private getContentMetricScaleX(): number {
    if (this.contentMetricScaleEpoch === this.contentFontEpoch) {
      return this.contentMetricScaleX;
    }
    const rect = this.canvas.getBoundingClientRect();
    const inlineWidth = parseInlinePx(this.canvas.style.width);
    const logicalWidth = inlineWidth ?? (this.canvas.clientWidth || this.width);
    const scale = logicalWidth > 0 ? rect.width / logicalWidth : 1;
    this.contentMetricScaleX = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.contentMetricScaleEpoch = this.contentFontEpoch;
    return this.contentMetricScaleX;
  }

  private scheduleContentGridCalibration(
    entityId: string,
    el: HTMLElement,
    calibrationKey: string,
    pageScaleX: number,
  ): void {
    if (typeof requestAnimationFrame !== 'function') return;
    if (el.dataset.vectoGridCalibrationPending === calibrationKey) return;

    // Advance the calibration generation when the conditions a measurement depends
    // on change. The font epoch covers font availability; page scale covers browser
    // zoom. Both alter the laid-out width of the same text, so every existing
    // per-cell scaleX becomes wrong and must be re-measured rather than trusted.
    const stamp = `${this.contentFontEpoch}:${pageScaleX.toFixed(4)}`;
    if (this.contentGridCalibrationStamp !== stamp) {
      this.contentGridCalibrationStamp = stamp;
      this.contentGridCalibrationGeneration++;
    }
    const generation = `${this.contentGridCalibrationGeneration}`;

    // Cells not yet calibrated for this generation. Carrier reuse (#244) leaves an
    // untouched line's cells — and the transforms already written on them — in
    // place, so a streamed append leaves this matching only the rebuilt tail.
    // Queried before any probe DOM is built so the common no-op case costs one
    // selector match.
    const pendingCells = el.querySelectorAll<HTMLElement>(
      `[data-vecto-grid-cell]:not([data-vecto-grid-calib="${generation}"])`,
    );

    // Complete without a probe when nothing is pending: no probe construction, no
    // forced layout, and no two-frame round trip. This is the steady state while
    // streaming.
    //
    // The condition is `pendingCells.length` and NOT the number of measurable
    // cells. Those differ on a FIRST projection, where every cell is pending yet all
    // may be legitimately skipped as unmeasurable (zero advance, empty text). Using
    // the measurable count marked such a grid ready without ever measuring it: a
    // standalone Table's cell selection then returned '' instead of its text,
    // because the e2e waits on `vectoGridReady` and proceeded before the browser had
    // laid the new carriers out.
    if (pendingCells.length === 0) {
      el.dataset.vectoGridCalibrationSamples = '0';
      delete el.dataset.vectoGridCalibrationPending;
      // `vectoGridReady` must be published from a frame callback, not synchronously.
      //
      // Its contract is "this projection's geometry is settled and safe to measure",
      // which is stronger than "calibration has no work to do". Consumers act on it
      // by immediately calling `getBoundingClientRect` — the e2e locates a drag that
      // way — and carriers materialized earlier in this same task have not been laid
      // out yet, so a synchronous flag hands out a zero-width rect and a drag lands
      // outside the text. The probe path implicitly satisfied the contract by
      // spending two frames before setting it; this path has no probe, so it waits
      // one frame explicitly. Still far cheaper than building and measuring a probe.
      const readyFrame = requestAnimationFrame(() => {
        this.contentGridCalibrationFrames.delete(entityId);
        if (!el.isConnected) return;
        el.dataset.vectoGridCalibration = calibrationKey;
        el.dataset.vectoGridReady = 'true';
      });
      this.contentGridCalibrationFrames.set(entityId, readyFrame);
      return;
    }
    const previous = this.contentGridCalibrationFrames.get(entityId);
    if (previous !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(previous);
    }
    this.contentGridCalibrationProbes.get(entityId)?.remove();
    this.contentGridCalibrationProbes.delete(entityId);
    const calibrationStart = typeof performance !== 'undefined' ? performance.now() : 0;

    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.dataset.vectoGridProbe = entityId;
    probe.style.position = 'absolute';
    probe.style.left = '-100000px';
    probe.style.top = '0';
    probe.style.width = '100000px';
    probe.style.height = '1px';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.whiteSpace = 'pre';
    probe.style.contain = 'layout style paint';
    const probeOrigin = document.createElement('span');
    probeOrigin.style.position = 'absolute';
    probeOrigin.style.left = '0';
    probeOrigin.style.top = '0';
    const probeX = document.createElement('span');
    probeX.style.position = 'absolute';
    probeX.style.left = '1px';
    probeX.style.top = '0';
    probe.append(probeOrigin, probeX);
    const measurements: Array<{
      targets: HTMLElement[];
      targetWidth: number;
      sourceLength: number;
      source: Text;
    }> = [];
    const measurementsByKey = new Map<string, (typeof measurements)[number]>();
    const scanStart = this._phaseTiming ? performance.now() : 0;
    for (const target of pendingCells) {
      const sourceLength = Number(target.dataset.vectoGridSourceLength ?? 0);
      const targetWidth = Number(target.dataset.vectoGridAdvance ?? 0);
      // Cells with nothing to measure are stamped immediately: leaving them
      // unstamped would keep them in the selector and re-scan them every frame,
      // which is the cost this whole change exists to remove.
      if (sourceLength <= 0 || targetWidth <= 0) {
        target.dataset.vectoGridCalib = generation;
        continue;
      }
      const sourceText = target.textContent?.slice(0, sourceLength) ?? '';
      if (!sourceText) {
        target.dataset.vectoGridCalib = generation;
        continue;
      }
      // Read the font from a data attribute, not `target.style.font`.
      //
      // `style.font` is a shorthand getter: Chrome re-serializes it from every font
      // longhand on each read. Done once per cell per frame that made the scan
      // 288 ms of a 290 ms calibration pass — 99.3% — while Firefox, whose getter
      // is cheap, spent 0.6 ms on the identical loop. A 480x cross-engine gap on
      // the same code is the signal that the cost is the property access itself,
      // not the work around it. The carrier already knows its font (the projection
      // just assigned it), so it records it as a plain string for reading back.
      const cellFont = target.dataset.vectoGridFont ?? '';
      const cellLineHeight = target.dataset.vectoGridLineHeight ?? '';
      const measurementKey = JSON.stringify([cellFont, cellLineHeight, targetWidth, sourceText]);
      const shared = measurementsByKey.get(measurementKey);
      if (shared) {
        shared.targets.push(target);
        continue;
      }
      const carrier = document.createElement('span');
      carrier.dir = 'ltr';
      carrier.style.position = 'absolute';
      carrier.style.left = '0';
      carrier.style.top = '0';
      carrier.style.whiteSpace = 'pre';
      carrier.style.font = cellFont;
      carrier.style.lineHeight = cellLineHeight;
      carrier.style.fontVariantLigatures = 'none';
      carrier.style.fontKerning = 'none';
      const source = document.createTextNode(sourceText);
      carrier.appendChild(source);
      probe.appendChild(carrier);
      const measurement = {
        targets: [target],
        targetWidth,
        sourceLength,
        source,
      };
      measurements.push(measurement);
      measurementsByKey.set(measurementKey, measurement);
    }
    // Keep the probe under the projection root so CSS zoom and font
    // substitution match the live carriers. Gecko may still return an
    // unzoomed Range width for a missing-glyph fallback; pageScaleX below
    // compensates that engine behavior without special-casing the font.
    if (this._phaseTiming) this._recordPhase('calibScan', performance.now() - scanStart);

    // No measurable cell among the pending ones: every one was zero-advance or
    // empty text and has just been stamped, so there is nothing to lay out and no
    // reason to spend two animation frames. Distinct from the `pendingCells` early
    // exit above, which covers the already-calibrated steady state.
    if (measurements.length === 0) {
      // The probe is not in the document yet (it is appended below), so it needs no
      // removal here — it simply goes unreferenced.
      el.dataset.vectoGridCalibration = calibrationKey;
      el.dataset.vectoGridReady = 'true';
      el.dataset.vectoGridCalibrationSamples = '0';
      delete el.dataset.vectoGridCalibrationPending;
      return;
    }

    const appendStart = this._phaseTiming ? performance.now() : 0;
    (this.a11yRoot ?? document.body ?? document.documentElement).appendChild(probe);
    if (this._phaseTiming) this._recordPhase('calibProbeBuild', performance.now() - appendStart);
    el.dataset.vectoGridCalibrationSamples = `${measurements.length}`;
    this.contentGridCalibrationProbes.set(entityId, probe);
    el.dataset.vectoGridCalibrationPending = calibrationKey;
    delete el.dataset.vectoGridReady;
    const readFrame = requestAnimationFrame(() => {
      if (!el.isConnected || el.dataset.vectoGridCalibrationPending !== calibrationKey) {
        probe.remove();
        this.contentGridCalibrationProbes.delete(entityId);
        this.contentGridCalibrationFrames.delete(entityId);
        return;
      }
      const updates: Array<{ element: HTMLElement; scale: number }> = [];
      const probeOriginRect = probeOrigin.getBoundingClientRect();
      const probeXRect = probeX.getBoundingClientRect();
      const basisScale = Math.abs(probeXRect.left - probeOriginRect.left);
      const projectionPageScaleX =
        Number.isFinite(basisScale) && basisScale > 0 ? basisScale : pageScaleX;
      let valid = true;
      for (const measurement of measurements) {
        const range = document.createRange();
        range.setStart(measurement.source, 0);
        range.setEnd(measurement.source, measurement.sourceLength);
        const natural = range.getBoundingClientRect().width;
        if (!Number.isFinite(natural) || natural <= 0) {
          valid = false;
          break;
        }
        const scale = (measurement.targetWidth * projectionPageScaleX) / natural;
        for (const element of measurement.targets) updates.push({ element, scale });
      }
      probe.remove();
      this.contentGridCalibrationProbes.delete(entityId);
      if (!valid) {
        delete el.dataset.vectoGridCalibrationPending;
        this.contentGridCalibrationFrames.delete(entityId);
        return;
      }
      const writeFrame = requestAnimationFrame(() => {
        if (!el.isConnected || el.dataset.vectoGridCalibrationPending !== calibrationKey) {
          this.contentGridCalibrationFrames.delete(entityId);
          return;
        }
        for (const { element, scale } of updates) {
          element.style.transform = Math.abs(scale - 1) <= 0.001 ? '' : `scaleX(${scale})`;
          // Stamp only after the transform is actually applied. If the pass bails
          // out as invalid, these stay unstamped and are retried next revision,
          // which is the behaviour that keeps a failed measurement from being
          // silently treated as done.
          element.dataset.vectoGridCalib = generation;
        }
        el.dataset.vectoGridCalibration = calibrationKey;
        el.dataset.vectoGridReady = 'true';
        if (typeof performance !== 'undefined') {
          el.dataset.vectoGridCalibrationMs = `${performance.now() - calibrationStart}`;
        }
        delete el.dataset.vectoGridCalibrationPending;
        this.contentGridCalibrationFrames.delete(entityId);
      });
      this.contentGridCalibrationFrames.set(entityId, writeFrame);
    });
    this.contentGridCalibrationFrames.set(entityId, readFrame);
  }

  private enforceA11yDomOrder(): void {
    if (!this.a11yRoot) return;

    // Zero-GC cleanups
    this.fullViewportElements.length = 0;
    this.normalElements.length = 0;
    this.activeIds.clear();
    this.a11yOrderRegions.clear();

    // `region` is the nearest `clipChildren` ancestor, threaded down the walk so
    // establishing it costs one comparison per node instead of an ancestor walk
    // per element.
    const collect = (node: Entity, region: Entity | null) => {
      if (node.isDOMPortal) return;

      const contentEl = this.contentElements.get(node.id);
      if (contentEl) {
        if (node.a11yFullViewport) this.fullViewportElements.push(contentEl);
        else this.normalElements.push(contentEl);
        if (region) this.a11yOrderRegions.set(contentEl, region);
      }

      if (this.shouldProjectA11y(node)) {
        const el = this.a11yElements.get(node.id);
        if (el) {
          this.activeIds.add(node.id);
          if (node.a11yFullViewport) this.fullViewportElements.push(el);
          else this.normalElements.push(el);
          if (region) this.a11yOrderRegions.set(el, region);
        }
      }
      // A zero-area clipper clips nothing, matching `isWithinClippedViewport`.
      const childRegion = node.clipChildren && node.width > 0 && node.height > 0 ? node : region;
      for (const child of node.children) collect(child, childRegion);
      if (node === this.root) {
        for (const overlay of this.overlayRoot.children) collect(overlay, null);
      }
    };

    collect(this.root, null);

    // Prune removed/inactive elements and guard focus leaks
    let elementsPruned = false;
    for (const [id, el] of this.a11yElements.entries()) {
      if (!this.activeIds.has(id)) {
        elementsPruned = true;
        if (el === this.focusedA11yElement) {
          this.focusedA11yElement = null;
          if (this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
        }
        // Parent-agnostic: a nested mirror's parent is its owning container,
        // not `a11yRoot`, so an equality check against the root would skip it
        // and leak the element (and its focus) for the lifetime of the scene.
        if (el.parentNode) {
          this.preserveFocusOnRemoval(el);
          el.remove();
        }
        this.a11yElements.delete(id);
      }
    }

    if (elementsPruned) {
      this.a11yNeedsReorder = true;
    }

    // Only reorder if the hierarchy flag is set
    if (!this.a11yNeedsReorder) return;

    // Tab / screen-reader order must follow the *visual* reading order, not the
    // scene-graph insertion order in which we just collected the elements. Two
    // buttons added in any order but drawn side by side should Tab left→right
    // (or right→left under RTL). Sort the non-overlay elements by their synced
    // world position (top → row, then inline). Full-viewport overlays keep
    // insertion order (they cover everything, so their relative order is what
    // the author declared).
    this.sortNormalElementsVisually();

    const fullLen = this.fullViewportElements.length;
    const normalLen = this.normalElements.length;
    const totalLen = fullLen + normalLen;

    // Reorder nodes with zero allocations (no expectedOrder array or concats).
    //
    // Position is tracked per DOM parent rather than as one index into
    // `a11yRoot.childNodes`: composite widgets nest (a `gridcell` is a child of
    // its `row`, not of the root), so a single running index would compare a
    // nested element against whatever happened to sit at that offset under the
    // root and shuffle unrelated siblings on every frame. Walking the globally
    // sorted sequence and advancing each parent's own cursor gives every
    // container its children in global reading order, which is what document
    // order — and therefore Tab order — is read from.
    //
    // Filling each parent's indices from 0 upwards is also what keeps the focus
    // sentinel last: it is the one child of `a11yRoot` never collected here, so
    // every positioned element is placed before it.
    //
    // Moving a node also destroys any `Selection` anchored inside its subtree —
    // the same class of collateral damage as the focus loss handled below.
    // Measured in CTX-0207 with the document parked and the write head ~300
    // sections away: a selection held 176 chars across three sync passes and
    // collapsed in the exact pass that MOVED its carrier (`removedNodes` and
    // `addedNodes` both recorded the same node, `isConnected` stayed true, so no
    // eviction path was involved).
    //
    // The endpoints are snapshotted at most ONCE per pass, and only once a move
    // is actually about to happen. Reading any `Selection` property forces a
    // synchronous layout (CTX-0203 measured ~0.5ms per read in real Chrome, with
    // no cheap property to probe with), so the read is deliberately NOT hoisted
    // above the loop: a pass that reorders nothing — the steady state — pays
    // nothing at all. It must still precede the first `insertBefore`, because
    // after that the live endpoints are already gone.
    //
    // `contentSelectionPresentThisSync` is deliberately NOT used as the gate
    // here. That memo is invalidated by `syncA11y`, and this pass also runs in
    // frames where `syncA11y` is skipped (`a11yElements.size > 0` alone reaches
    // it), so it can hold a value describing an earlier frame.
    let selection: Selection | null = null;
    let selAnchorNode: Node | null = null;
    let selFocusNode: Node | null = null;
    let selAnchorOffset = 0;
    let selFocusOffset = 0;
    let selectionSnapshotTaken = false;
    let selectionMoved = false;
    const snapshotSelection = (): void => {
      selectionSnapshotTaken = true;
      if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
      const live = window.getSelection();
      if (!live?.anchorNode || !live.focusNode) return;
      selection = live;
      selAnchorNode = live.anchorNode;
      selFocusNode = live.focusNode;
      selAnchorOffset = live.anchorOffset;
      selFocusOffset = live.focusOffset;
    };

    this.a11yOrderCursors.clear();
    for (let i = 0; i < totalLen; i++) {
      const expected =
        i < fullLen ? this.fullViewportElements[i] : this.normalElements[i - fullLen];
      const parent = expected.parentNode;
      if (!parent) continue;
      const at = this.a11yOrderCursors.get(parent) ?? 0;
      this.a11yOrderCursors.set(parent, at + 1);
      const current = parent.childNodes[at];
      if (current !== expected) {
        // Moving a focused element blanks `document.activeElement`, and a
        // component whose keyboard contract rides an entity `keydown` listener
        // then stops receiving keys entirely — measured on `Dropdown`, whose
        // Escape-to-close (Dropdown.ts:95,123) silently died because opening the
        // popup reordered the mirror that held focus. Restore it after the move.
        const refocus = document.activeElement === expected;
        // Resolved on the first move of the pass and reused for the rest, so the
        // forced layout is paid once per REORDERING pass rather than once per
        // moved element.
        if (!selectionSnapshotTaken) snapshotSelection();
        // A move only breaks the selection when an endpoint lives inside the
        // moved subtree, so each subsequent moved element costs one `contains`
        // against the snapshot — no further `Selection` access.
        if (
          !selectionMoved &&
          ((selAnchorNode !== null && expected.contains(selAnchorNode)) ||
            (selFocusNode !== null && expected.contains(selFocusNode)))
        ) {
          selectionMoved = true;
        }
        parent.insertBefore(expected, current || null);
        if (refocus) expected.focus({ preventScroll: true });
      }
    }

    // Restore after the whole pass rather than per move: a selection spanning
    // two carriers can have both of them moved, and re-applying between the two
    // would only be undone by the second move.
    //
    // A move preserves the text nodes themselves, so the snapshotted nodes and
    // offsets are still valid as-is. That is why this needs no offset remapping,
    // unlike `preserveContentSelectionAcrossRebuild`, which reasons in linear
    // character offsets because a rebuild replaces the nodes.
    if (selectionMoved && selection && selAnchorNode && selFocusNode) {
      try {
        selection.setBaseAndExtent(selAnchorNode, selAnchorOffset, selFocusNode, selFocusOffset);
      } catch {
        // Engine rejected the range — an endpoint detached by the prune pass, or
        // a shape it will not accept. Leaving the selection as the move left it
        // is the honest outcome; there is nothing valid to restore onto.
      }
    }

    this.a11yNeedsReorder = false;
  }

  /**
   * Reorder `normalElements` (in place) into visual reading order using the
   * positions `syncA11y` already wrote to each element's inline style
   * (`top`/`left`/`height`). Elements are grouped into rows top-to-bottom (an
   * element belongs to the current row while its top is above the row's
   * running bottom edge), then sorted within a row by `left` — ascending for
   * `'ltr'`, descending for `'rtl'`. The sort is stable, so entities at the
   * same position keep their scene-graph (collection) order as a tiebreak.
   *
   * Those inline values are world coordinates for a top-level mirror but
   * PARENT-RELATIVE for a nested one, so this list mixes coordinate spaces.
   * That is sound because the result is only ever applied per DOM parent
   * ({@link enforceA11yDomOrder} advances a cursor per parent), and all of one
   * parent's children share one space: a `grid`'s rows are all grid-relative, a
   * `row`'s cells all row-relative. Comparisons ACROSS spaces do happen while
   * banding, but they only affect the relative order of elements in different
   * parents, which no `insertBefore` ever acts on. Normalizing everything back
   * to world coordinates here would cost a transform per element per frame to
   * change nothing observable.
   *
   * Banding runs **per region** — per nearest `clipChildren` ancestor, recorded
   * by {@link enforceA11yDomOrder}'s collect walk — rather than once over the
   * whole scene. Purely visual banding is right for a screen reader but wrong
   * for selection: a DOM `Selection` covers everything between anchor and focus
   * in DOM order, so under one global banding a vertical drag through a
   * transcript also swallowed a sidebar whose headings happened to fall in the
   * same rows. Regions are laid out side by side, so ordering region-major keeps
   * each one a contiguous DOM run and a drag stays inside it, while reading
   * order *within* a region is unchanged. Regions are emitted in the order their
   * clipper is first reached by the depth-first walk, so a screen reader still
   * meets them in the author's declared order.
   */
  private sortNormalElementsVisually(): void {
    const els = this.normalElements;
    if (els.length < 2) return;

    const rtl = this._readingDirection === 'rtl';
    // A zero-height mirror (rare) still needs a row band so same-top siblings
    // group together; clamp to a small minimum.
    const heightOf = (el: HTMLElement) => Math.max(Number.parseFloat(el.style.height) || 0, 4);

    // Identify which of these elements contain another one. Composite widgets
    // nest (`grid` > `row` > `gridcell`), and a container necessarily spans every
    // row it owns, so letting it extend a row band merges all of its rows into a
    // single band — after which the inline sort orders every cell by `left`
    // alone and yields column-major order. Walking ancestors is O(n · depth)
    // against the O(n log n) sort below, and the projection nests at most three
    // levels deep.
    const members = this.a11yOrderMembers;
    const containers = this.a11yOrderContainers;
    members.clear();
    containers.clear();
    for (const el of els) members.add(el);
    for (const el of els) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (members.has(p)) containers.add(p);
      }
    }

    // `top`/`left` are written **parent-relative** for a nested mirror (see
    // `rebaseChildBox`) and world-relative for a flat one, so the raw values are
    // not comparable across nesting levels: every `gridcell` inside a `row`
    // reports `top: 0`, which sorts all of them as if they sat at the top of the
    // document. Accumulate ancestor offsets to put every element back into one
    // space. The walk stops at the first ancestor that is not itself being
    // ordered, which is `a11yRoot`.
    const absolute = (el: HTMLElement): { top: number; left: number } => {
      let top = 0;
      let left = 0;
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        top += Number.parseFloat(node.style.top) || 0;
        left += Number.parseFloat(node.style.left) || 0;
        const parent = node.parentElement;
        if (!parent || !members.has(parent)) break;
      }
      return { top, left };
    };

    // Decorate with the original index so the sort is stable across engines.
    const decorated = els.map((el, i) => {
      const { top, left } = absolute(el);
      return { el, i, top, left, container: containers.has(el) };
    });

    // Partition into regions, keeping first-encounter order. `normalElements` is
    // filled by a depth-first walk, so first encounter is the author's declared
    // order and a region's own members are already adjacent here.
    const regions = this.a11yOrderRegions;
    const buckets = new Map<Entity | null, (typeof decorated)[number][]>();
    for (const d of decorated) {
      const key = regions.get(d.el) ?? null;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(d);
      else buckets.set(key, [d]);
    }

    const bandBottom = (r: (typeof decorated)[number]) =>
      r.top + (r.container ? 4 : heightOf(r.el));
    const sorted: HTMLElement[] = [];

    // Band within a region only, so a row never spans two regions.
    for (const order of buckets.values()) {
      order.sort((p, q) => p.top - q.top || p.i - q.i);

      // Bucket into visual rows by vertical overlap, then sort each row inline. A
      // container contributes its position — so it still sorts ahead of its own
      // descendants — but not its height, which is what keeps its rows separate.
      let rowStart = 0;
      let rowBottom = order.length ? bandBottom(order[0]) : 0;
      const flushRow = (end: number) => {
        const row = order.slice(rowStart, end);
        row.sort((p, q) => (rtl ? q.left - p.left : p.left - q.left) || p.i - q.i);
        for (const r of row) sorted.push(r.el);
      };
      for (let k = 1; k < order.length; k++) {
        if (order[k].top < rowBottom) {
          // Same row — extend the band to the tallest element seen so far.
          rowBottom = Math.max(rowBottom, bandBottom(order[k]));
        } else {
          flushRow(k);
          rowStart = k;
          rowBottom = bandBottom(order[k]);
        }
      }
      flushRow(order.length);
    }

    for (let i = 0; i < sorted.length; i++) els[i] = sorted[i];
  }

  /** Keep DOM/WebGL overlay layers aligned with the canvas's CSS box. */
  private syncOverlayGeometry(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const canvasRect = this.canvas.getBoundingClientRect?.();
    const parentRect = parent.getBoundingClientRect?.();
    const cssWidth = canvasRect?.width || this.canvas.clientWidth || this.width;
    const cssHeight = canvasRect?.height || this.canvas.clientHeight || this.height;
    const left =
      (canvasRect?.left ?? 0) -
      (parentRect?.left ?? 0) -
      (parent.clientLeft || 0) +
      parent.scrollLeft;
    const top =
      (canvasRect?.top ?? 0) - (parentRect?.top ?? 0) - (parent.clientTop || 0) + parent.scrollTop;
    const scaleX = this.width > 0 ? cssWidth / this.width : 1;
    const scaleY = this.height > 0 ? cssHeight / this.height : 1;

    // The overlay layers only move when the canvas box, the logical size, or the
    // CSS↔logical scale actually changes — which is rare (resize, zoom, a
    // scrolled ancestor), not every frame. Bail out when nothing moved instead of
    // re-writing ten style properties per layer per frame: identical assignments
    // still touch the CSSOM, and the write set grows with every overlay layer.
    const prev = this._overlayGeometry;
    if (
      prev !== null &&
      prev.left === left &&
      prev.top === top &&
      prev.cssWidth === cssWidth &&
      prev.cssHeight === cssHeight &&
      prev.width === this.width &&
      prev.height === this.height
    ) {
      return;
    }
    this._overlayGeometry = {
      left,
      top,
      cssWidth,
      cssHeight,
      width: this.width,
      height: this.height,
    };

    for (const root of [this.a11yRoot, this.portalRoot]) {
      if (!root) continue;
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.width = `${this.width}px`;
      root.style.height = `${this.height}px`;
      root.style.transformOrigin = '0 0';
      root.style.transform = `scale(${scaleX}, ${scaleY})`;
    }

    for (const canvas of [this.glCanvas, this.gpuCanvas]) {
      if (!canvas) continue;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
  }

  public getA11yTree(): A11yTreeNode[] {
    const map = new Map<string, A11yTreeNode>();
    const roots: A11yTreeNode[] = [];

    const traverse = (node: Entity, parentNode: Entity | null) => {
      if (node.isDOMPortal) return;

      let currentA11yNode: A11yTreeNode | null = null;

      if (this.shouldProjectA11y(node)) {
        const el = this.a11yElements.get(node.id);
        if (el) {
          const attrs = node.getA11yAttributes();
          currentA11yNode = {
            id: node.id,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            label: el.getAttribute('aria-label') || undefined,
            value: attrs.value,
            checked: attrs.checked,
            expanded: attrs.expanded,
            valuemin: attrs.valuemin,
            valuemax: attrs.valuemax,
            children: [],
          };
          map.set(node.id, currentA11yNode);

          // Find parent interactive container directly using the cached map
          const parentA11y = parentNode ? map.get(parentNode.id) : null;
          if (parentA11y) {
            parentA11y.children.push(currentA11yNode);
          } else {
            roots.push(currentA11yNode);
          }
        }
      }

      for (const child of node.children) {
        traverse(child, currentA11yNode ? node : parentNode);
      }

      if (node === this.root) {
        for (const overlay of this.overlayRoot.children) {
          traverse(overlay, currentA11yNode ? node : parentNode);
        }
      }
    };

    traverse(this.root, null);
    return roots;
  }

  private renderPortalDOM(
    portal: DOMPortalEntity,
    te: number,
    tf: number,
    a: number,
    b: number,
    c: number,
    d: number,
    opacity: number,
  ): void {
    if (!this.portalRoot) return;

    this.activePortalsThisFrame.add(portal.id);
    this.portalEntities.set(portal.id, portal);

    if (portal.domElement.parentElement !== this.portalRoot) {
      this.portalRoot.appendChild(portal.domElement);
    }

    // Re-bind observer/listeners if a prior scene.remove() released them
    // (idempotent — a no-op while already bound, so it's cheap per frame).
    portal.attachDOMBindings();

    if (!portal.domElement.hasAttribute('data-vecto-id')) {
      portal.domElement.setAttribute('data-vecto-id', portal.id);
    }

    const transformStr = `matrix(${a}, ${b}, ${c}, ${d}, ${te}, ${tf})`;
    let widthStr = '';
    let heightStr = '';
    if (portal.width > 0) widthStr = `${portal.width}px`;
    if (portal.height > 0) heightStr = `${portal.height}px`;

    const zIndexStr = String(this.renderOrderCounter++);

    if (portal.lastWidth !== widthStr) {
      portal.domElement.style.width = widthStr;
      portal.lastWidth = widthStr;
    }
    if (portal.lastHeight !== heightStr) {
      portal.domElement.style.height = heightStr;
      portal.lastHeight = heightStr;
    }
    if (portal.lastTransform !== transformStr) {
      portal.domElement.style.left = '0px';
      portal.domElement.style.top = '0px';
      portal.domElement.style.transform = transformStr;
      portal.lastTransform = transformStr;
    }
    if (portal.lastZIndex !== zIndexStr) {
      portal.domElement.style.zIndex = zIndexStr;
      portal.lastZIndex = zIndexStr;
    }
    const opacityStr = String(opacity);
    if (portal.lastOpacity !== opacityStr) {
      portal.domElement.style.opacity = opacityStr;
      portal.lastOpacity = opacityStr;
    }
  }

  private reconcilePortals(): void {
    if (!this.portalRoot) return;

    for (const oldId of this.activePortalsPrevFrame) {
      if (!this.activePortalsThisFrame.has(oldId)) {
        const portal = this.portalEntities.get(oldId);
        if (portal) {
          if (
            portal.domElement.parentElement === this.portalRoot &&
            (!portal.scene || portal.scene === this)
          ) {
            // Portal no longer projected (culled/hidden): release its observer
            // + listeners so an off-screen portal doesn't keep them live. The
            // projection re-attaches them (attachDOMBindings) if it reappears.
            portal.releaseDOMBindings();
            portal.domElement.remove();
          }
          this.portalEntities.delete(oldId);
        }
      }
    }

    this.activePortalsPrevFrame = new Set(this.activePortalsThisFrame);
    this.activePortalsThisFrame.clear();
  }

  /**
   * The frame-rate cap actually in effect: the explicit {@link maxFPS}, further
   * lowered to {@link REDUCED_MOTION_FPS} when the OS requests reduced motion
   * (and {@link respectReducedMotion} is on). `0` means uncapped.
   */
  private effectiveMaxFPS(): number {
    const reduced = this.respectReducedMotion && !!this.reducedMotionQuery?.matches;
    if (reduced)
      return this.maxFPS > 0 ? Math.min(this.maxFPS, REDUCED_MOTION_FPS) : REDUCED_MOTION_FPS;
    return this.maxFPS;
  }

  private loop(time: number): void {
    if (!this.isRunning) return;

    // Canvas scrolled fully off-screen: pause the loop entirely (do no work and
    // stop rescheduling) rather than burn a full update/render every frame on a
    // scene nobody can see. The IntersectionObserver resumes it on re-entry.
    // markDirty() while hidden is harmless — the dirty flag persists and the
    // resume frame consumes it.
    if (!this._canvasOnScreen) return;

    let cap = this.effectiveMaxFPS();

    // Idle = nothing marked dirty and no animation in flight. This drives two
    // independent behaviors: the onDemand frame skip (always active in that
    // mode) and the `always`-mode 2 FPS auto-throttle (opt-out via
    // `autoThrottle` — it must NOT gate the onDemand skip, or disabling the
    // throttle would silently turn onDemand into per-frame rendering).
    // Flags come from the last rendered frame (collected during the render
    // walk). Skipped frames change no state, so they stay valid while idle;
    // anything that starts motion marks the scene dirty, which wakes the loop
    // and refreshes them on the next rendered frame.
    // A sync that deferred resident blocks is NOT idle: the document is still
    // materializing and needs further frames to finish. Without this, `onDemand`
    // would skip the frame outright and `autoThrottle` would drop an `always`
    // scene to 2 FPS — at a 64-block budget, 1000 blocks would then take 16 syncs
    // across 8 seconds, so text would sit unfindable long after it looked done.
    // Deliberately NOT `markDirty()`: materializing off-viewport DOM changes no
    // pixel, so requesting a canvas repaint would be a lie about the frame.
    const isIdle = !this.dirty && !this.frameHadAnimation && !this.contentSemanticDeferred;

    if (isIdle && this.autoThrottle && this.renderMode === 'always' && this.maxFPS > 0) {
      cap = Math.min(cap, 2);
    }

    // Frame-rate cap (power saving / prefers-reduced-motion): if this frame
    // arrived sooner than the target interval, skip rendering this tick.
    // `lastTime` only advances on rendered frames, so `dt` stays accurate.
    if (cap > 0 && time - this.lastTime < 1000 / cap - 1) {
      this._skippedFrames++;
      this.scheduleFrame();
      return;
    }

    let dt = time - this.lastTime;
    // Frame-pacing: on a display whose refresh interval doesn't evenly
    // divide the render loop's own scheduling margin (e.g. maxFPS=60 on a
    // 240Hz panel — every 4th rAF tick nominally qualifies, but sub-ms
    // compositor/OS jitter can flip which tick actually crosses the
    // `1000/cap - 1` gate above), the raw elapsed time can bounce by a full
    // display-refresh interval frame-to-frame (e.g. ~13-20ms around a
    // 16.67ms target) even though the AVERAGE dt still converges on
    // `1000/cap`. That per-frame variance fed straight into physics/
    // animation `update(dt)` produces visible stutter despite a correct
    // average FPS reading. Snap dt to the nominal interval whenever it's
    // already close (within 30%) so ordinary scheduling jitter quantizes to
    // a stable value; a real stall (backgrounded tab, GC pause, slow frame)
    // is far outside that band and passes through unmodified — this never
    // hides genuine slowness or accumulates a "catch up" backlog, it only
    // removes noise from frames that were already hitting their target.
    if (cap > 0) {
      const nominal = 1000 / cap;
      if (Math.abs(dt - nominal) < nominal * 0.3) dt = nominal;
    }
    // Clamp a huge elapsed gap: a backgrounded tab (rAF paused) or a long stall
    // makes `time - lastTime` seconds long, and feeding that straight into
    // `update(dt)` / property drivers on refocus jumps physics forward by a
    // giant step (a spring explodes, a tween snaps past its end). Cap to
    // MAX_FRAME_DT so the first frame after a stall advances by at most one
    // "slow frame" instead of the whole idle duration. Frame telemetry below
    // still uses the true `time`, so FPS/interval readings are unaffected.
    if (dt > Scene.MAX_FRAME_DT) dt = Scene.MAX_FRAME_DT;
    this.lastTime = time;

    // onDemand: only redraw when dirty or an animation is in flight.
    if (this.renderMode === 'onDemand' && isIdle) {
      this._skippedFrames++;
      this.scheduleFrame();
      return;
    }

    // Consume the dirty flag BEFORE the update/render pass: any markDirty()
    // call made inside an entity's update() must survive into the next frame
    // (self-animating entities re-arm themselves this way). Clearing after
    // render would silently wipe those marks and freeze the entity.
    this.dirty = false;

    // Frame telemetry: measure the interval since the last *rendered* frame
    // (skipped/idle ticks excluded, so FPS reflects real redraw cadence, not
    // the rAF rate) and the wall-clock cost of the render pass itself.
    const now = typeof performance !== 'undefined' ? performance.now() : time;
    if (this._lastRenderTick > 0) {
      const interval = time - this._lastRenderTick;
      if (interval > 0) {
        // EMA (α=0.1) smooths per-frame jitter without a ring buffer.
        this._avgFrameIntervalMs =
          this._avgFrameIntervalMs === 0
            ? interval
            : this._avgFrameIntervalMs * 0.9 + interval * 0.1;
      }
    }
    this._lastRenderTick = time;
    this._lastDt = dt;

    const phaseClock = this._phaseTiming ? performance.now() : 0;
    this.render(this.renderer, dt, time);
    if (this._phaseTiming) this._recordPhase('render', performance.now() - phaseClock);

    this._lastFrameMs = (typeof performance !== 'undefined' ? performance.now() : time) - now;
    this._renderedFrames++;

    // Sync Automation Shadow DOM (skip the whole walk when nothing is interactive).
    // Performance Throttling: If an animation is currently flying, we freeze A11y writes
    // to prevent DOM reflow from thrashing Canvas render loop. We sync once it's at rest.
    const hasActiveAnimation = this.frameHadAnimation;

    const hasInteractive = this.frameHadInteractive;
    // Content projection rides the same walk. It must run even with zero
    // existing mirrors (new text entities need discovery), so enabling the
    // option opts into the walk; per-node writes are all dirty-checked, so an
    // unchanged frame costs only the traversal.
    const wantsContentSync = this.contentProjectionEnabled;
    const shouldSyncInterval =
      this.a11ySyncInterval <= 0 || time - this.lastA11ySync >= this.a11ySyncInterval;

    if (
      (hasInteractive || this.a11yElements.size > 0 || wantsContentSync) &&
      (shouldSyncInterval || this.a11yPendingSyncAfterAnimation)
    ) {
      this.lastA11ySync = time;
      if (hasInteractive || wantsContentSync) {
        const userTiming = this._userTiming
          ? beginVectoUserTiming(VECTO_USER_TIMING.scene.a11ySync)
          : null;
        const t0 = this._phaseTiming ? performance.now() : 0;
        this.syncA11y(this.root);
        if (this._phaseTiming) this._recordPhase('a11ySync', performance.now() - t0);
        if (userTiming) endVectoUserTiming(userTiming);
      }
      const t1 = this._phaseTiming ? performance.now() : 0;
      this.enforceA11yDomOrder();
      if (this._phaseTiming) this._recordPhase('a11yOrder', performance.now() - t1);
      this.a11yPendingSyncAfterAnimation = hasActiveAnimation;
    } else if (hasActiveAnimation) {
      this.a11yPendingSyncAfterAnimation = true;
    }

    this.scheduleFrame();
  }

  /**
   * Render the entire scene graph onto the specified renderer.
   *
   * Main-frame causal order is a correctness contract:
   *
   * 1. Browser/input callbacks finish before the scheduled frame begins.
   * 2. Batched property drivers and particle simulation advance.
   * 3. Entity `update()` hooks run.
   * 4. Transform inputs are gathered and world matrices are composed.
   * 5. Updated world bounds are tested for culling.
   * 6. Visible entities paint in scene-graph order.
   * 7. Canvas/GPU batches flush and retained renderers present.
   * 8. The rAF loop synchronizes content and accessibility projections after
   *    this method returns.
   *
   * The causal order is fixed; physical walks may stay fused. The JavaScript
   * transform path interleaves update → compose → cull → paint per node in
   * pre-order. The WASM path updates the whole tree first, then gathers and
   * composes it in one store pass before the same cull/paint walk. Both must
   * expose an update's transform mutation in that same rendered frame.
   * Secondary renderers are read-only snapshots: they skip simulation and
   * updates, then compose/cull/paint/flush the current state.
   *
   * @param renderer - The renderer instance to draw to.
   * @param dt - Delta time in milliseconds (default 0).
   * @param time - Current absolute time in milliseconds (default 0).
   */
  public render(renderer: IRenderer, dt = 0, time = 0): void {
    // Renderer's drawing context is lost (e.g. Canvas2D contextlost): every draw
    // call is a no-op until it's restored, so skip the whole pass rather than
    // walk the tree for nothing. The renderer's contextrestored handler triggers
    // a repaint (see enableContextLossRepaint).
    if (renderer.isContextLost?.()) return;

    const isMainRenderer = renderer === this.renderer;
    if (isMainRenderer && this.a11yRoot && this.canvas.parentElement) {
      const parentStyle = this.canvas.parentElement.style;
      if (!parentStyle.position || parentStyle.position === 'static') {
        parentStyle.position = 'relative';
      }
      this.syncOverlayGeometry();
    }

    if (isMainRenderer) {
      // Monotonic frame counter. renderNode stamps each entity's world-matrix
      // cache with this value; getWorldTransform() trusts the cache only while
      // it still equals currentFrame, so bumping it here invalidates every
      // entity's cache in O(1) at the start of the authoritative walk.
      this.currentFrame++;
      this.renderOrderCounter = 0;
      this.a11yRenderOrders.clear();
      this.activePortalsThisFrame.clear();
      // Must run before any entity's update()/tickDrivers() below (JS-mode
      // interleaved walk or WASM-mode transform pre-pass alike) — see
      // _tickBatchedDrivers's own doc comment for why.
      this._tickBatchedDrivers(dt);
    }

    // Collect all ComputeParticleEntity instances in the tree. Membership only
    // changes when the tree topology does, so the list is cached and rebuilt
    // solely on a `_structureVersion` bump (add/remove/reparent) — otherwise a
    // scene with zero compute entities (the overwhelmingly common case) walked
    // the whole tree every frame just to build an empty array.
    const computeEntities = this._computeEntitiesFor(this._structureVersion);

    if (computeEntities.length > 0) {
      // Particle simulation (WebGPU compute pass / CPU fallback) mutates
      // `entity.particleData` even when `dt === 0`. Secondary renderers such as
      // SVG export are read-only snapshots; deterministic `step()` still uses
      // the Scene's main renderer and therefore advances simulation.
      const isMainRenderPath = renderer === this.renderer;
      // Provisional verdict for this frame, refined by whichever branch runs
      // below. A secondary renderer leaves the main pass's verdict alone.
      if (isMainRenderPath) {
        this._particleReason = this._particleWasm ? 'active' : 'not-installed';
        this._particlePath = this._particleWasm ? 'wasm' : 'js';
      }
      // Async initialize WebGPU context on the first frame we encounter a ComputeParticleEntity
      if (
        isMainRenderPath &&
        !this.device &&
        !this.webgpuDisabled &&
        !this.initializingWebGPU &&
        !this.deviceLost
      ) {
        this.initializingWebGPU = true;
        this.initWebGPUContext(computeEntities)
          .then((newDevice) => {
            this.device = newDevice;
            this.initializingWebGPU = false;
            const format = navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm';
            if (Scene.webgpuManagerClass) {
              this.manager = new Scene.webgpuManagerClass(newDevice);
            } else if (this.particleBackend === 'webgpu') {
              throw new Error(
                'WebGPU particle manager is not registered. Please call Scene.registerWebGPUParticleSystemManager(WebGPUParticleSystemManager) first.',
              );
            }
            if (this.manager) {
              this.manager.initPipelines(format);
              for (const entity of computeEntities) {
                this.manager.setupEntityResources(entity);
                if (entity.gpuStorageBuffer) {
                  newDevice.queue.writeBuffer(entity.gpuStorageBuffer, 0, entity.particleData);
                }
              }
            }
          })
          .catch((err) => {
            if (this.particleBackend === 'webgpu') {
              console.error('Failed to initialize WebGPU:', err);
            } else {
              console.warn('WebGPU unavailable; using CPU particle fallback.', err);
            }
            this.webgpuDisabled = true;
            this.initializingWebGPU = false;
          });
      }

      // Dispatch WebGPU Compute + Render passes OR run CPU physics updates fallback
      if (
        isMainRenderPath &&
        this.device &&
        this.manager &&
        !this.deviceLost &&
        !this.webgpuDisabled
      ) {
        try {
          const commandEncoder = this.device.createCommandEncoder();

          // Compute Pass
          const computePass = commandEncoder.beginComputePass();
          for (const entity of computeEntities) {
            if (!entity.gpuStorageBuffer || entity.needsInit) {
              if (!entity.gpuStorageBuffer) {
                this.manager.setupEntityResources(entity);
              }
              this.device.queue.writeBuffer(entity.gpuStorageBuffer!, 0, entity.particleData);
              entity.needsInit = false;
            }
            this.manager.recordComputePass(
              computePass,
              entity,
              dt / 1000,
              this.mouseX,
              this.mouseY,
              this.width,
              this.height,
            );
          }
          computePass.end();

          // Render Pass
          if (this.gpuContext) {
            const view = this.gpuContext.getCurrentTexture().createView();
            const renderPassDescriptor: GPURenderPassDescriptor = {
              colorAttachments: [
                {
                  view,
                  clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
                  loadOp: 'clear',
                  storeOp: 'store',
                },
              ],
            };
            const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);
            for (const entity of computeEntities) {
              this.manager.recordRenderPass(renderPass, entity);
            }
            renderPass.end();
          }

          this.device.queue.submit([commandEncoder.finish()]);
          if (this.gpuContext) this.gpuHasContent = true;
          this._particleReason = 'active';
          this._particlePath = 'webgpu';
        } catch (e) {
          console.error('WebGPU frame execution failed. Falling back.', e);
          this.deviceLost = true;
          this.device = null;
          this.recreateWebGPUDeviceWithRetry(computeEntities);
        }
      } else if (isMainRenderPath) {
        // Fallback updates. The simulation runs in entity-local space, so the
        // scene-space mouse must be converted per entity (repulsion would
        // otherwise only work for untransformed entities at the origin).
        for (const entity of computeEntities) {
          let mx = this.mouseX;
          let my = this.mouseY;
          if (mx > -9000 && my > -9000) {
            const local = entity.worldToLocal(mx, my);
            if (local) {
              mx = local.x;
              my = local.y;
            } else {
              mx = -9999;
              my = -9999;
            }
          }
          if (this._particleWasm) {
            // `stepWithBackend` silently runs updateCPU when the kernel declines,
            // so take its verdict rather than assuming the installed backend ran.
            // One rejecting entity downgrades the frame: the report describes what
            // simulated the scene, and a partial WASM frame is not a WASM frame.
            if (
              !entity.stepWithBackend(
                this._particleWasm,
                dt / 1000,
                mx,
                my,
                this.width,
                this.height,
              )
            ) {
              this._particleReason = 'rejected';
              this._particlePath = 'js';
            }
          } else {
            entity.updateCPU(dt / 1000, mx, my, this.width, this.height);
          }
        }
      }
    } else if (isMainRenderer) {
      // No particle entities in the tree, so no accelerator was asked to do
      // anything. Clear the verdict or a scene that once had particles keeps
      // reporting the last frame that did.
      this._particleReason = 'not-applicable';
      this._particlePath = 'none';
      // The GPU canvas presents its last frame until told otherwise: once the
      // final ComputeParticleEntity leaves the tree, clear it or the particles
      // stay frozen on screen.
      this.clearGPUCanvasIfStale();
    }

    renderer.clear();
    if (isMainRenderer) {
      this.pointRenderer?.begin();
    }

    const vw = this.width;
    const vh = this.height;

    // Tree-walk fusion: animation/interactive state is collected during this
    // walk (before any cull/portal early-return) so the loop doesn't re-walk.
    let walkHadAnimation = false;
    let walkHadInteractive = false;

    // Per-node update(), shared by the interleaved JS walk and the WASM pre-pass.
    // Passive-node update skip: the base update() only advances property drivers
    // and queued animations, so for a node with neither — and no update()
    // override — the call is a guaranteed no-op. Eliding it trades a virtual
    // update() dispatch (plus its internal tickDrivers/animations early-returns)
    // for one hasPendingAnimations() read, cheaper for the passive majority of a
    // large tree and helping the JS and WASM transform paths equally. It reads
    // LIVE state every frame (never a cached passive flag): a node that begins
    // animating reports pending motion and is updated that same frame, so nothing
    // can freeze — the correctness a cached-subtree-flag approach cannot promise.
    const runUpdate = (node: Entity): void => {
      const overridesUpdate = node.update !== Entity.prototype.update;
      let pending = node.hasPendingAnimations();
      if (pending || overridesUpdate) {
        node.update(dt, time);
        pending = node.hasPendingAnimations(); // update() may start/finish motion
      }
      if (pending) walkHadAnimation = true;
      if (!walkHadInteractive && node.interactive) walkHadInteractive = true;

      // Dev check: entity overrides update() but not hasPendingAnimations()
      if (this._devActive && this._devFrameCount % 120 === 0) {
        if (
          overridesUpdate &&
          node.hasPendingAnimations === Entity.prototype.hasPendingAnimations
        ) {
          this._devWarn(
            `Entity "${node.id}" overrides update() but not hasPendingAnimations(). ` +
              'Custom motion in update() without overriding hasPendingAnimations() causes ' +
              'the idle throttle to drop the animation to ~2fps. ' +
              'Override hasPendingAnimations() to return true while motion is in flight.',
          );
        }
      }
    };

    // WASM transform path: compose every main-tree world matrix up front into an
    // SoA store, then let renderNode read each node's matrix instead of composing
    // it. Only for the main renderer; overlays and any node not in the store fall
    // through to the JS composition below. worldView() is read AFTER compose()
    // because a capacity-growing compose re-inits and re-views wasm memory.
    const wasmMain = isMainRenderer && this._wasm !== null && this._transformBackend === 'wasm';
    // Classify this frame's transform path. Unlike animation and hit-test, this
    // accelerator has no workload gate — it is installed or it is not — so when
    // `wasmMain` holds, `_syncWasmStore` below always overwrites this with
    // 'active' or 'rejected'. Only a non-main renderer keeps 'not-applicable'.
    // Only the main renderer writes it: the report describes the scene's frame,
    // and a secondary renderer running afterwards would otherwise clobber the
    // main pass's verdict with its own 'not-applicable'.
    if (isMainRenderer) {
      this._transformReason = wasmMain ? 'active' : 'not-installed';
    }

    // In WASM mode update() MUST run for the whole tree BEFORE the store is
    // gathered: the kernel composes every world matrix up front, so a transform
    // an entity mutates in its update() (animation/driver output) has to be
    // finalized first — otherwise the store would render that entity one frame
    // stale. This pre-pass walks root + overlays in pre-order (identical update()
    // ordering to the JS walk); renderNode then skips update() in WASM mode. In
    // JS mode update() stays interleaved with compose in the render walk below.
    if (wasmMain) {
      const updateWalk = (node: Entity): void => {
        runUpdate(node);
        const kids = node.children;
        for (let i = 0; i < kids.length; i++) updateWalk(kids[i]);
      };
      updateWalk(this.root);
      for (const overlay of this.overlayRoot.children) updateWalk(overlay);
    }

    const transformTiming = this._userTiming
      ? beginVectoUserTiming(VECTO_USER_TIMING.scene.transform)
      : null;
    const wasmT0 = this._phaseTiming ? performance.now() : 0;
    const wasmWorld = wasmMain ? this._syncWasmStore() : null;
    if (this._phaseTiming) this._recordPhase('transform', performance.now() - wasmT0);
    if (transformTiming) endVectoUserTiming(transformTiming);
    const wasmSlotEntity = this._slotEntity;

    // renderNode carries the parent's accumulated world matrix as six scalar
    // params (canvas T*S*R order) to avoid per-node array allocation — important
    // for large scenes. Off-viewport entities with a known getBounds() are culled.
    let userEntityPaintMs = 0;
    const renderNode = (
      node: Entity,
      pa: number,
      pb: number,
      pc: number,
      pd: number,
      pe: number,
      pf: number,
      parentOpacity: number,
    ) => {
      // JS mode: update() is interleaved with compose here. WASM mode already
      // ran the update pre-pass above (so the store gather saw final transforms),
      // so skip it here to avoid a double update().
      if (isMainRenderer && !wasmMain) {
        runUpdate(node);
      }

      // Compose parent * translate(x,y) * scale(sx,sy) * rotate(rot).
      // Six scalars of this node's world matrix. In the WASM path they are read
      // from the pre-composed SoA store (bit-identical to the JS composition —
      // proven by the differential tests); otherwise, and for any node the store
      // does not cover (overlays, entities added after the store was built), they
      // are composed here in JS. Either way the same a,b,c,d,te,tf flow into
      // culling, _setWorldCache, and the child recursion below.
      let a: number;
      let b: number;
      let c: number;
      let d: number;
      let te: number;
      let tf: number;
      const slot = node._storeSlot;
      // Trust the slot only if it still maps back to this node in the current
      // store — guards against a stale slot on an overlay/detached/reparented
      // entity (which then falls back to the JS composition, never a wrong read).
      if (wasmWorld !== null && slot >= 0 && wasmSlotEntity[slot] === node) {
        a = wasmWorld.wa[slot];
        b = wasmWorld.wb[slot];
        c = wasmWorld.wc[slot];
        d = wasmWorld.wd[slot];
        te = wasmWorld.we[slot];
        tf = wasmWorld.wf[slot];
      } else {
        // node._getTrig() caches cos/sin and only recomputes when rotation
        // changes — most entities never rotate, so this skips two libm calls per
        // node per frame (V8's Math.cos/sin are software, ~2.5x slower elsewhere).
        const trig = node._getTrig();
        const cos = trig.cos;
        const sin = trig.sin;
        te = pa * node.x + pc * node.y + pe;
        tf = pb * node.x + pd * node.y + pf;
        const sxCos = node.scaleX * cos;
        const sxSin = node.scaleX * sin;
        const syCos = node.scaleY * cos;
        const sySin = node.scaleY * sin;
        // Canvas calls translate → scale → rotate, so the local matrix is
        // T * S * R = [sx*cos, -sx*sin; sy*sin, sy*cos]. Keep culling,
        // portals, and GPU fast paths in the exact same coordinate system.
        a = pa * sxCos + pc * sySin;
        b = pb * sxCos + pd * sySin;
        c = pa * -sxSin + pc * syCos;
        d = pb * -sxSin + pd * syCos;
      }
      // Publish this node's world matrix for the current frame so ad-hoc
      // getWorldTransform()/localToWorld() callers (hit-testing, content
      // projection, app code) reuse it instead of re-walking the ancestor
      // chain. Only the main renderer's walk is authoritative; secondary
      // renderers (portals, overlays) must not overwrite the cache.
      if (isMainRenderer) node._setWorldCache(a, b, c, d, te, tf, this.currentFrame);
      const worldScaleX = Math.hypot(a, b);
      const worldScaleY = Math.hypot(c, d);
      const worldOpacity = parentOpacity * node.opacity;
      const scaleTolerance = Math.max(1, worldScaleX, worldScaleY) * 1e-6;
      const orthogonalTolerance = Math.max(1, worldScaleX * worldScaleY) * 1e-6;
      const isSimilarityTransform =
        Number.isFinite(worldScaleX) &&
        Number.isFinite(worldScaleY) &&
        Math.abs(worldScaleX - worldScaleY) <= scaleTolerance &&
        Math.abs(a * c + b * d) <= orthogonalTolerance;

      const a11yEl = isMainRenderer ? this.a11yElements.get(node.id) : undefined;
      const willProjectA11y = isMainRenderer && this.shouldProjectA11y(node);
      if (a11yEl || willProjectA11y) {
        const renderOrder = this.renderOrderCounter++;
        if (willProjectA11y) this.a11yRenderOrders.set(node.id, renderOrder);
        if (a11yEl) a11yEl.style.zIndex = String(renderOrder);
      }

      if ((node as any).isDOMPortal) {
        if (isMainRenderer) {
          this.renderPortalDOM(node as DOMPortalEntity, te, tf, a, b, c, d, worldOpacity);
        }
        return;
      }

      // Cull test: transform the local bounds box and check viewport overlap.
      let visible = true;
      const bounds = node.getBounds();
      if (bounds) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < 4; i++) {
          const lx = i & 1 ? bounds.x + bounds.width : bounds.x;
          const ly = i & 2 ? bounds.y + bounds.height : bounds.y;
          const wx = a * lx + c * ly + te;
          const wy = b * lx + d * ly + tf;
          if (wx < minX) minX = wx;
          if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy;
          if (wy > maxY) maxY = wy;
        }
        visible = maxX >= 0 && minX <= vw && maxY >= 0 && minY <= vh;
      }

      // Fully skip invisible leaf nodes (no transform, no render, no recursion).
      if (!visible && node.children.length === 0) return;

      // Batch fast-path: a uniform-scaled leaf circle draws through the renderer
      // batch in the parent's transform space (center = local pos, radius scaled),
      // skipping its own save/translate/scale/rotate/render/restore. Runs of
      // same-color siblings coalesce into one fill(). Rotation is irrelevant for
      // a circle; non-uniform scale would shear it, so fall back in that case.
      if (node.children.length === 0 && node.scaleX === node.scaleY) {
        const bc = node.getBatchCircle();
        if (bc) {
          if (!visible) return;
          if (isMainRenderer && this.pointRenderer) {
            if (isSimilarityTransform) {
              // GPU layer: emit in world coords (center = (te,tf), radius scaled
              // by the accumulated uniform scale = hypot(a,b)).
              this.pointRenderer.addCircle(te, tf, bc.radius * worldScaleX, bc.color, worldOpacity);
              return;
            }
            // A non-uniform or sheared ancestor turns the circle into an
            // ellipse. The point backend only accepts one radius, so retain the
            // exact Canvas transform by falling through to node.render().
          } else {
            renderer.fillCircle(node.x, node.y, bc.radius * node.scaleX, bc.color, worldOpacity);
            return;
          }
        } else if (isMainRenderer && this.pointRenderer) {
          // GPU instanced rectangle (WebGL backend only; otherwise falls through
          // to the normal render path below). Origin (te,tf), world scale hypot(a,b),
          // rotation atan2(b,a).
          const br = node.getBatchRect();
          // A single size + rotation cannot represent non-uniform scale, shear,
          // or a reflection, so those cases use the normal Canvas path.
          if (br && isSimilarityTransform && a * d - b * c >= 0) {
            if (visible) {
              this.pointRenderer.addRect(
                te,
                tf,
                br.width * worldScaleX,
                br.height * worldScaleX,
                br.color,
                worldOpacity,
                Math.atan2(b, a),
              );
            }
            return;
          }
        }
      }

      // Any normal (non-batched) draw must commit the pending batch first so
      // painter's order is preserved across the sibling group.
      renderer.flush();
      renderer.save();
      renderer.translate(node.x, node.y);
      renderer.scale(node.scaleX, node.scaleY);
      renderer.rotate(node.rotation);
      renderer.setGlobalAlpha(worldOpacity);

      if (visible) {
        if (node instanceof ComputeParticleEntity) {
          if (this.deviceLost || this.webgpuDisabled || !this.device || !this.manager) {
            this.renderCPUParticles(
              renderer,
              node,
              worldOpacity,
              a,
              b,
              c,
              d,
              te,
              tf,
              worldScaleX,
              isSimilarityTransform,
            );
          }
        } else {
          // Split the entity's own paint from the walk that visits it. drawWalk
          // measured 100% of render, which makes it the only opaque block left —
          // and "the draw walk is expensive" is not actionable without knowing
          // whether the cost is per-entity painting or the traversal around it.
          if (this._userTiming || this._phaseTiming) {
            const t0 = performance.now();
            try {
              node.render(renderer);
            } finally {
              const elapsed = performance.now() - t0;
              if (this._userTiming) userEntityPaintMs += elapsed;
              if (this._phaseTiming) this._recordPhase('entityPaint', elapsed);
            }
          } else {
            node.render(renderer);
          }
        }
      }

      if (node.clipChildren) {
        renderer.clip(0, 0, node.width, node.height);
      }

      for (const child of node.children) {
        renderNode(child, a, b, c, d, te, tf, worldOpacity);
      }
      // Commit any batched leaf children before popping this node's transform.
      renderer.flush();
      renderer.restore();
    };

    const drawTiming = this._userTiming
      ? beginVectoUserTiming(VECTO_USER_TIMING.scene.drawWalk)
      : null;
    const drawT0 = this._phaseTiming ? performance.now() : 0;
    renderNode(this.root, 1, 0, 0, 1, 0, 0, 1);
    for (const overlay of this.overlayRoot.children) {
      renderNode(overlay, 1, 0, 0, 1, 0, 0, 1);
    }
    if (this._phaseTiming) this._recordPhase('drawWalk', performance.now() - drawT0);
    if (drawTiming) endVectoUserTiming(drawTiming);
    if (this._userTiming) {
      measureVectoUserTiming(VECTO_USER_TIMING.scene.entityPaint, userEntityPaintMs);
    }
    if (isMainRenderer) {
      this.frameHadAnimation = walkHadAnimation;
      this.frameHadInteractive = walkHadInteractive;
      this.reconcilePortals();
    }
    const flushTiming = this._userTiming
      ? beginVectoUserTiming(VECTO_USER_TIMING.scene.flush)
      : null;
    const flushT0 = this._phaseTiming ? performance.now() : 0;
    renderer.flush();
    if (isMainRenderer) {
      this.pointRenderer?.flush();
    }
    // Retained-scene backends (ThreeRenderer) render exactly once per frame here.
    renderer.present?.();
    if (this._phaseTiming) this._recordPhase('flush', performance.now() - flushT0);
    if (flushTiming) endVectoUserTiming(flushTiming);
    if (this._devActive) {
      this._devFrameCount++;
      this._devRunChecks();
    }
  }

  /**
   * Export the current scene state to a lightweight, flat SVG XML string.
   */
  public toSVG(): string {
    const renderer = new SVGRenderer(this.width, this.height);
    this.render(renderer, 0, 0);
    return renderer.toXMLString();
  }

  /**
   * Manually resize the Scene's viewport.
   */
  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // Browser zoom emits resize and may change native Range geometry even
    // when the logical Canvas font is unchanged (notably Firefox at
    // fractional scale). Treat every explicit viewport resize as a cold text
    // projection metric boundary so prepared grids can recalibrate once.
    this.contentFontEpoch++;
    // A resize re-tiers blocks without moving any of them, which is invisible to
    // the settled-walk fast path's two transforms. Bumped explicitly rather than
    // leaning on the `contentFontEpoch++` above: that one is about text metrics
    // and could reasonably be narrowed later, and this guarantee should not
    // silently depend on it.
    this.contentViewportEpoch++;
    if (typeof (this.renderer as any).resize === 'function') {
      if ('maxDPR' in this.renderer) (this.renderer as any).maxDPR = this.maxDPR;
      (this.renderer as any).resize(width, height);
    }
    if (this.pointRenderer) {
      this.pointRenderer.maxDPR = this.maxDPR;
      this.pointRenderer.resize(width, height);
    }
    // Keep the WebGPU particle layer's backing store in step — otherwise it
    // rasterizes at the creation-time resolution and gets CSS-stretched.
    if (this.gpuCanvas) this.sizeGpuCanvas(this.gpuCanvas, width, height);
    this.markDirty();
  }

  /** Effective device pixel ratio, matching CanvasRenderer: real DPR clamped to
   *  `maxDPR` when set. */
  private effectiveDPR(): number {
    const real = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return this.maxDPR !== undefined ? Math.min(real, this.maxDPR) : real;
  }

  /** Size the WebGPU particle canvas: backing store at logical × DPR, CSS box at
   *  the logical size. Sizing the backing store in logical px (the old
   *  behavior) left it rasterized at 1× and CSS-stretched — blurry on HiDPI. */
  private sizeGpuCanvas(gpuCanvas: HTMLCanvasElement, width: number, height: number): void {
    const dpr = this.effectiveDPR();
    gpuCanvas.width = Math.max(1, Math.round(width * dpr));
    gpuCanvas.height = Math.max(1, Math.round(height * dpr));
    gpuCanvas.style.width = `${width}px`;
    gpuCanvas.style.height = `${height}px`;
  }

  /**
   * Gets the accessibility DOM element projected for the given entity ID.
   */
  public getA11yElement(entityId: string): HTMLElement | undefined {
    return this.a11yElements.get(entityId);
  }

  /** Gets the static-content DOM projection for an entity ID, when materialized. */
  public getContentElement(entityId: string): HTMLElement | undefined {
    return this.contentElements.get(entityId);
  }

  /**
   * Gets the root entity of the scene.
   */
  public getRoot(): Entity {
    return this.root;
  }

  /**
   * Finds the topmost interactive entity at the given coordinates.
   */
  public findEntityAt(x: number, y: number): Entity | null {
    // 1. Search overlay root first (drawn on top). Overlays are never indexed
    // by the WASM grid (modals/menus are few and rare — not worth
    // accelerating), so this always uses the JS walk.
    const overlayHit = this.findHitRecursively(this.overlayRoot, x, y);
    if (overlayHit) return overlayHit;

    // 2. Search main scene tree. The WASM path is conclusive whenever the
    // grid is trustworthy (backend present, build didn't overflow) — it
    // returns the correct entity or null, never "inconclusive" — so no
    // further JS fallback is needed for that call. Otherwise (no backend, or
    // an overflowing build) fall back to the permanent JS walk.
    if (this._hitWasm && this._ensureHitGrid()) {
      return this._findEntityAtWasm(x, y);
    }
    return this.findHitRecursively(this.root, x, y);
  }

  /** Submit one transparent clear pass when particle content lingers on the GPU canvas. */
  private clearGPUCanvasIfStale(): void {
    if (!this.gpuHasContent || !this.device || !this.gpuContext || this.deviceLost) return;
    try {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.gpuContext.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch {
      // Device may be mid-loss; the recovery machinery owns that state.
    }
    this.gpuHasContent = false;
  }

  private async initWebGPUContext(entities: ComputeParticleEntity[]): Promise<GPUDevice> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported on this platform.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No GPUAdapter found.');
    }
    const device = await adapter.requestDevice();

    if (typeof document !== 'undefined' && !this.gpuCanvas) {
      const gpuCanvas = document.createElement('canvas');
      this.sizeGpuCanvas(gpuCanvas, this.width, this.height);
      gpuCanvas.style.position = 'absolute';
      gpuCanvas.style.top = '0';
      gpuCanvas.style.left = '0';
      gpuCanvas.style.pointerEvents = 'none';
      gpuCanvas.style.zIndex = '6';
      if (this.canvas.parentElement) {
        this.canvas.parentElement.appendChild(gpuCanvas);
      }
      this.gpuCanvas = gpuCanvas;
      // Never positioned yet — force the next geometry sync (see _overlayGeometry).
      this._overlayGeometry = null;
      this.gpuContext = gpuCanvas.getContext('webgpu');
    }

    if (this.gpuContext) {
      this.gpuContext.configure({
        device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
      });
    }

    // Register context lost handler re-binding
    this.setupDeviceLostHandler(device, entities);
    return device;
  }

  private setupDeviceLostHandler(device: GPUDevice, entities: ComputeParticleEntity[]): void {
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      console.warn(`WebGPU device lost: ${info.message}`);

      this.deviceLost = true;
      this.device = null;

      this.recreateWebGPUDeviceWithRetry(entities);
    });
  }

  private recreateWebGPUDeviceWithRetry(
    entities: ComputeParticleEntity[],
    attempt: number = 0,
  ): void {
    if (this.destroyed) return;

    if (attempt >= 3) {
      console.error(
        'Failed to recover WebGPU device after 3 retries. Remaining on fallback renderer.',
      );
      this.webgpuDisabled = true;
      this.deviceLost = true;
      return;
    }

    // Destroy old entities and manager references
    for (const entity of entities) {
      entity.destroyGPUResources();
    }
    if (this.manager) {
      this.manager.destroy();
      this.manager = null;
    }

    const backoff = Math.pow(2, attempt) * 1000;
    if (this.recoveryTimerId) clearTimeout(this.recoveryTimerId);

    this.recoveryTimerId = setTimeout(() => {
      if (this.destroyed) return;

      this.initWebGPUContext(entities)
        .then((newDevice) => {
          if (this.destroyed) {
            newDevice.destroy();
            return;
          }
          console.log('Successfully recovered WebGPU device.');
          this.device = newDevice;
          this.deviceLost = false;

          const format = navigator.gpu.getPreferredCanvasFormat();
          if (Scene.webgpuManagerClass) {
            this.manager = new Scene.webgpuManagerClass(newDevice);
          } else if (this.particleBackend === 'webgpu') {
            throw new Error(
              'WebGPU particle manager is not registered. Please call Scene.registerWebGPUParticleSystemManager(WebGPUParticleSystemManager) first.',
            );
          }
          if (this.manager) {
            this.manager.initPipelines(format);

            for (const entity of entities) {
              this.manager.setupEntityResources(entity);
              // Re-upload particle fallback states
              if (entity.gpuStorageBuffer) {
                newDevice.queue.writeBuffer(entity.gpuStorageBuffer, 0, entity.particleData);
              }
            }
          }
        })
        .catch(() => this.recreateWebGPUDeviceWithRetry(entities, attempt + 1));
    }, backoff);
  }

  private renderCPUParticles(
    renderer: IRenderer,
    entity: ComputeParticleEntity,
    worldOpacity: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    worldScale: number,
    isSimilarityTransform: boolean,
  ): void {
    const data = entity.particleData;
    const size = entity.maxParticles;
    // The GL point layer takes world coordinates and a single radius, so it
    // can only represent the entity's transform when it is a similarity
    // (uniform scale, no shear). Anything else draws through the canvas
    // branch, which runs under the entity's own transform in local space.
    const useGL = renderer === this.renderer && !!this.pointRenderer && isSimilarityTransform;

    for (let i = 0; i < size; i++) {
      const idx = i * 8;
      const x = data[idx];
      const y = data[idx + 1];
      const pSize = data[idx + 6];
      const life = data[idx + 7];
      if (life === 0.0) continue; // dead

      const opacity = life < 0.0 ? worldOpacity : worldOpacity * Math.min(1.0, life);
      const scale = life >= 0.0 ? Math.min(1.0, life) : 1.0;
      if (useGL) {
        this.pointRenderer!.addCircle(
          a * x + c * y + e,
          b * x + d * y + f,
          pSize * scale * worldScale,
          entity.baseColor,
          opacity,
        );
      } else {
        renderer.fillCircle(x, y, pSize * scale, entity.baseColor, opacity);
      }
    }
  }

  private findHitRecursively(
    node: Entity,
    x: number,
    y: number,
    clip: Bounds | null = null,
  ): Entity | null {
    // An invisible subtree (opacity 0) is not drawn, so nothing in it should be
    // hit — skip the node AND its children (opacity accumulates down the tree).
    if (node.opacity <= 0) return null;

    // A `clipChildren` node clips its descendants to its world box: intersect it
    // into the clip rect passed down to the children (but the node itself is
    // still hit-testable against the incoming clip).
    let childClip = clip;
    if (node.clipChildren) {
      const box = node.getWorldBounds();
      childClip = clip ? intersectBounds(clip, box) : box;
    }

    // Walk children in reverse order (drawn last/top-most first).
    for (let i = node.children.length - 1; i >= 0; i--) {
      const hit = this.findHitRecursively(node.children[i], x, y, childClip);
      if (hit) return hit;
    }

    // The node itself is a hit target only if the point is inside it, inside any
    // clipping ancestor, and it isn't opted out of pointer input (a disabled
    // control or an explicit `pointerEvents: 'none'`).
    if (
      node.isPointInside &&
      node.isPointInside(x, y) &&
      (!clip || pointInBounds(clip, x, y)) &&
      !this.isPointerTransparent(node)
    ) {
      return node;
    }

    return null;
  }

  /** Whether `node` opts out of being a pointer hit target: a disabled control
   *  or an explicit `pointerEvents: 'none'` in its a11y attributes. Its children
   *  are still walked (a transparent container can hold hittable descendants). */
  private isPointerTransparent(node: Entity): boolean {
    const attrs = node.getA11yAttributes();
    return attrs.disabled === true || attrs.pointerEvents === 'none';
  }

  /**
   * Whether a confirmed geometric hit on `node` at world `(x, y)` is a REAL hit,
   * applying the same visibility/input gating as {@link findHitRecursively} but
   * from a flat candidate (the WASM grid has no recursion clip-stack): the node
   * and all ancestors are visible (`opacity > 0`), the point lies inside every
   * `clipChildren` ancestor's world box, and the node isn't pointer-transparent
   * (disabled / `pointerEvents: 'none'`). Keeps the WASM and JS hit paths in
   * lockstep so they return the same entity.
   */
  private isHitEligible(node: Entity, x: number, y: number): boolean {
    if (this.isPointerTransparent(node)) return false;
    if (node.opacity <= 0) return false;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.opacity <= 0) return false;
      if (ancestor.clipChildren && ancestor.width > 0 && ancestor.height > 0) {
        const local = ancestor.worldToLocal(x, y);
        if (
          !local ||
          local.x < 0 ||
          local.y < 0 ||
          local.x > ancestor.width ||
          local.y > ancestor.height
        ) {
          return false;
        }
      }
    }
    return true;
  }
}

/** Axis-aligned intersection of two world-space boxes (empty if disjoint). */
function intersectBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

/** Whether world point `(x, y)` lies within box `b`. */
function pointInBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/**
 * A digest of everything about one grid line that determines its projected DOM.
 *
 * Used to skip rebuilding carrier lines that did not change. Streaming text bumps
 * `grid.revision` on every append while leaving all earlier lines byte-identical,
 * so without this the projection re-creates one `<span>` per cell for the entire
 * block every frame.
 *
 * **Every field the projection reads must appear here.** A missing field means a
 * stale carrier is served: geometry drifts from the canvas, and DOM Range offsets
 * stop matching the source, which breaks selection and screen-reader position
 * rather than merely looking wrong. The corresponding writes live in
 * `syncContentGridProjection`; keep the two in step.
 */
function contentGridLineSignature(
  grid: PreparedContentGrid,
  line: PreparedContentGridLine,
  projected: ContentProjectionLine | undefined,
  lineHeight: number,
  baseline: number,
  font: string,
  isFirstLine: boolean,
): string {
  const parts: string[] = [
    // Line box: position, size, and the font that resolves its baseline.
    `${projected?.x ?? 0}`,
    `${projected?.y ?? ''}`,
    `${lineHeight}`,
    `${baseline}`,
    font,
    `${line.width}`,
    // The trailing hard break belongs to this line and lands in the DOM text.
    grid.source.slice(line.sourceEnd, line.nextSourceStart),
    // The basis markers are appended only to line 0, so a line moving to or from
    // index 0 changes its DOM even when nothing else does.
    isFirstLine ? '1' : '0',
  ];
  if (line.cells.length === 0) {
    // An empty line projects its break text directly, with no cell carriers.
    parts.push('empty');
  } else {
    for (const cell of line.cells) {
      parts.push(
        `${cell.sourceStart}`,
        `${cell.sourceEnd}`,
        `${cell.x}`,
        `${cell.advance}`,
        `${cell.level}`,
        cell.sourceCaretOffsets.join('.'),
        // Source text, not `cell.glyph`: the carrier holds the original characters
        // (the shaped glyph is the canvas's business), so a change in shaping alone
        // must not invalidate a carrier, and a change in source must.
        grid.source.slice(cell.sourceStart, cell.sourceEnd),
      );
    }
  }
  return parts.join('\u0001');
}
