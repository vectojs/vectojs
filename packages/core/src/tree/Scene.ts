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

import { Entity, VectoJSEvent, type ContentProjection } from './Entity';
import { CanvasRenderer } from '../renderer/CanvasRenderer';
import { SVGRenderer } from '../renderer/SVGRenderer';
import { IRenderer } from '../renderer/IRenderer';
import type { PointRenderer } from '../renderer/WebGLPointRenderer';
import { DOMPortalEntity } from './DOMPortalEntity';
import type { WebGPUParticleSystemManager } from '../renderer/WebGPUParticleSystemManager';
import { ComputeParticleEntity } from './ComputeParticleEntity';
import { sanitizeUrl } from '../renderer/url';
import { clearCssLineBoxMetrics, cssLineBoxBaseline } from '../text/Typography';
import type { PreparedContentGrid } from '../text/PreparedContentGrid';

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
   * Mirror static text from entities implementing
   * {@link Entity.getContentProjection} as transparent, position-synced DOM
   * nodes, so find-in-page, screen readers, crawlers, and translation work on
   * canvas-rendered text. Default is `true`; disable for purely decorative
   * scenes to skip the sync walk.
   */
  contentProjection?: boolean;
}

/** Frame-rate the loop is capped to when the OS requests reduced motion. */
export const REDUCED_MOTION_FPS = 30;

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
  /** Cached media-query list; `.matches` is read live each frame. */
  private reducedMotionQuery: MediaQueryList | null = null;

  /** True when the OS asks for reduced motion and we respect it. Read by the animation drivers. */
  public get prefersReducedMotion(): boolean {
    return this.respectReducedMotion && !!this.reducedMotionQuery?.matches;
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
  /** Pending cold font-calibration frame per projected grid entity. */
  private contentGridCalibrationFrames: Map<string, number> = new Map();
  /** Detached, untransformed font probes used by the cold calibration pass. */
  private contentGridCalibrationProbes: Map<string, HTMLElement> = new Map();
  /** Invalidates grid font calibration after browser font availability changes. */
  private contentFontEpoch = 0;
  /** Cached Canvas-to-client scale for the current font/viewport epoch. */
  private contentMetricScaleEpoch = -1;
  private contentMetricScaleX = 1;
  private contentProjectionEnabled: boolean = true;
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
  private focusedA11yElement: HTMLElement | null = null;
  private caretBlinkTimer: any = null;
  public a11yNeedsReorder: boolean = true;
  private portalRoot: HTMLDivElement | null = null;
  private fullViewportElements: HTMLElement[] = [];
  private normalElements: HTMLElement[] = [];
  private activeIds: Set<string> = new Set<string>();

  private activePortalsThisFrame: Set<string> = new Set();
  private activePortalsPrevFrame: Set<string> = new Set();
  private portalEntities: Map<string, DOMPortalEntity> = new Map();
  private renderOrderCounter: number = 0;
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
  private hasWarnedZeroSize: boolean = false;
  private fontLoadHandler: (() => void) | null = null;

  // ── Dev-mode warning infrastructure ──────────────────────────────
  //
  // Enable with `Scene.devMode = true` or by setting `globalThis.__DEV__`.
  // Auto-detected when `NODE_ENV === 'development'`.
  //
  // Checks run once every ~120 frames (~2s at 60fps) to keep overhead
  // negligible even when dev mode is on.

  /** Toggle development-mode runtime warnings globally. */
  public static devMode: boolean = false;

  private static _devModeDetected(): boolean {
    if (Scene.devMode) return true;
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

  /** @internal Periodic dev checks — called once per frame in dev mode. */
  private _devRunChecks(): void {
    this._devFrameCount++;
    if (this._devFrameCount % 120 !== 0) return; // ~every 2s

    // 1. detachA11y leak detection
    if (this.a11yElements) {
      let interactiveCount = 0;
      const walk = (node: Entity): void => {
        if (node.interactive && node.width > 0) interactiveCount++;
        for (const c of node.children) walk(c);
      };
      walk(this.root);
      for (const c of this.overlayRoot.children) walk(c);

      const shadowCount = this.a11yElements.size;
      // Allow some slack for a11yFullViewport entities and timing
      if (shadowCount > interactiveCount + 2) {
        this._devWarn(
          `a11yElements (${shadowCount}) exceeds interactive entities (${interactiveCount}). ` +
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
          // If the projection text differs from what's in the DOM, warn
          if (projectedText !== '' && projectedText !== proj.text) {
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
    this.particleBackend = options.particleBackend ?? 'auto';
    this.a11ySyncInterval = options.a11ySyncInterval ?? 0;
    this.contentProjectionEnabled = options.contentProjection ?? true;
    this._devActive = Scene._devModeDetected();
    this.reducedMotionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
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

    // Setup Agent / Automation Semantic Layer (only where there's a DOM).
    if (typeof document !== 'undefined') {
      this.a11yRoot = document.createElement('div');
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

  private endContentSelectionDrag(): void {
    this.blankRegionSelectionDrag = false;
    this.contentSelectionAnchor = null;
    if (this.a11yRoot) this.a11yRoot.style.pointerEvents = 'none';
  }

  private releaseContentSelectionForRebuild(el: HTMLElement): void {
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
    return this;
  }

  private clearContentGridState(entityId: string, el: HTMLElement): void {
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
    this.releaseContentSelectionForRebuild(el);
  }

  private removeA11yRecursively(node: Entity) {
    if (node.isDOMPortal) {
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
      el.remove();
      this.a11yElements.delete(node.id);
      this.a11yNeedsReorder = true;
    }
    for (const child of node.children) {
      this.removeA11yRecursively(child);
    }
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
    return this;
  }

  /**
   * Tear down the a11y/automation shadow nodes for `entity` and its descendants
   * without removing it from the scene graph. Components that manage dynamic
   * interactive *child* entities (e.g. a {@link Entity}'s per-link hotspots) call
   * this before discarding those children so their shadow `<a>`/controls don't
   * leak (the per-frame `syncA11y` only creates/updates, it never prunes).
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
    this.markDirty();
  }

  /**
   * Remove an overlay entity from the overlay root.
   */
  public hideOverlay(overlay: Entity): void {
    this.overlayRoot.remove(overlay);
    this.removeA11yRecursively(overlay);
    this.markDirty();
  }

  private destroyEntitySubtree(entity: Entity): void {
    while (entity.children.length > 0) this.destroyEntitySubtree(entity.children.at(-1)!);
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
    if (typeof window !== 'undefined' && this.contentSelectionEndListener) {
      window.removeEventListener('mouseup', this.contentSelectionEndListener);
      window.removeEventListener('blur', this.contentSelectionEndListener);
      this.contentSelectionEndListener = null;
    }
    if (
      typeof window !== 'undefined' &&
      this.canvas &&
      typeof this.canvas.removeEventListener === 'function'
    ) {
      if (this.pointerMoveListener) {
        this.canvas.removeEventListener('pointermove', this.pointerMoveListener);
      }
      if (this.pointerLeaveListener) {
        this.canvas.removeEventListener('pointerleave', this.pointerLeaveListener);
      }
    }
    this.a11yRoot?.remove();
    this.portalRoot?.remove();
    this.a11yElements.clear();
    for (const el of this.contentElements.values()) el.remove();
    this.contentElements.clear();
    if (typeof cancelAnimationFrame === 'function') {
      for (const frame of this.contentGridCalibrationFrames.values()) {
        cancelAnimationFrame(frame);
      }
    }
    this.contentGridCalibrationFrames.clear();
    for (const probe of this.contentGridCalibrationProbes.values()) probe.remove();
    this.contentGridCalibrationProbes.clear();
    this.endContentSelectionDrag();
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
    }
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
      this.canvas.addEventListener('pointermove', this.pointerMoveListener);
      this.canvas.addEventListener('pointerleave', this.pointerLeaveListener);
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

  public step(dt: number): void {
    const time = this.lastTime + dt;
    this.lastTime = time;
    this.render(this.renderer, dt, time);
    this.dirty = false;
  }

  /**
   * Mark the scene as needing a redraw on the next frame.
   *
   * Only meaningful in `onDemand` {@link renderMode}: call it after mutating
   * entity state outside of {@link Entity.animate} so the change is rendered.
   */
  public markDirty(): void {
    this.dirty = true;
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

  private syncA11y(node: Entity) {
    if (!this.a11yRoot) return; // no DOM (SSR) → a11y projection is a no-op
    if (node.isDOMPortal) {
      return;
    }
    if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
      let el = this.a11yElements.get(node.id);
      const attrs = node.getA11yAttributes();
      const expectedTag = attrs.tag || 'div';

      // If tag name changes at runtime, recreate the element
      if (el && el.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
        if (el === this.focusedA11yElement) {
          this.focusedA11yElement = null;
          if (this.caretBlinkTimer) {
            clearInterval(this.caretBlinkTimer);
            this.caretBlinkTimer = null;
          }
        }
        if (el.parentNode === this.a11yRoot) {
          this.a11yRoot.removeChild(el);
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

        // Developer debugger mode hover feedback
        el.addEventListener('mouseenter', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.2)';
          node.dispatchEvent(new VectoJSEvent('hover', node, e, false));
        });
        el.addEventListener('mouseleave', (e) => {
          if (this.debugA11y) el!.style.backgroundColor = 'rgba(56, 189, 248, 0.05)';
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
            composition = { start: input.selectionStart ?? input.value.length, length: 0 };
            forward();
          });
          el.addEventListener('compositionupdate', (e) => {
            const data = (e as CompositionEvent).data ?? '';
            composition = { start: composition?.start ?? 0, length: data.length };
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

      if (attrs.value !== undefined) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (el.value !== attrs.value) {
            const userTyped = (el as any)._lastSyncedValue;
            if (attrs.value !== userTyped || document.activeElement !== el) {
              el.value = attrs.value;
              (el as any)._lastSyncedValue = attrs.value;
            }
          }
        } else {
          this.syncOptionalAttribute(el, 'aria-valuenow', attrs.value);
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
      }

      // Sync position mappings
      if (node.a11yFullViewport) {
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = `${this.width}px`;
        el.style.height = `${this.height}px`;
        el.style.transform = '';
      } else {
        const { a, b, c, d, e, f } = node.getWorldTransform();
        el.style.left = `${e + node.a11yOffsetX}px`;
        el.style.top = `${f + node.a11yOffsetY}px`;
        el.style.width = `${node.width}px`;
        el.style.height = `${node.height}px`;
        el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;
      }
    }

    this.syncContentProjection(node);

    for (const child of node.children) this.syncA11y(child);
    if (node === this.root) {
      for (const overlay of this.overlayRoot.children) this.syncA11y(overlay);
    }
  }

  /**
   * Mirror one entity's static text ({@link Entity.getContentProjection}) as a
   * transparent DOM node positioned over the drawn glyphs. Runs on the a11y
   * sync cadence; all writes are dirty-checked. Off-viewport projections are
   * hidden (`display: none`) so text-heavy scenes only materialize what is
   * visible to the browser's text machinery anyway.
   */
  private syncContentProjection(node: Entity): void {
    if (!this.contentProjectionEnabled || !this.a11yRoot) return;
    const projection = node.getContentProjection();
    let el = this.contentElements.get(node.id);

    if (!projection || !projection.text) {
      if (el) {
        this.clearContentGridState(node.id, el);
        el.remove();
        this.contentElements.delete(node.id);
        this.a11yNeedsReorder = true;
      }
      return;
    }

    if (!el) {
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
    if (!projection.grid && el.dataset.vectoContentGrid !== undefined) {
      this.clearContentGridState(node.id, el);
    }
    if (projection.grid) {
      this.syncContentGridProjection(node, el, projection, projection.grid);
    } else if (lines && lines.length > 0) {
      const signature = JSON.stringify({
        lines,
        fallbackFont: projection.font ?? '',
        fallbackLineHeight: projection.lineHeight ?? 16,
      });
      if (el.dataset.vectoProjectionLines !== signature) {
        this.releaseContentSelectionForRebuild(el);
        el.replaceChildren();
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const lineElement = document.createElement('span');
          const lineFont = line.font ?? projection.font ?? '';
          const lineHeight = line.lineHeight ?? projection.lineHeight ?? 16;
          lineElement.style.position = 'absolute';
          lineElement.dir = 'auto';
          lineElement.style.left = `${line.x}px`;
          lineElement.style.top = `${line.y + line.baseline - cssLineBoxBaseline(lineFont, lineHeight)}px`;
          lineElement.style.whiteSpace = 'pre';
          if (lineFont) lineElement.style.font = lineFont;
          // Assigning the CSS `font` shorthand resets line-height to `normal`.
          // Set the explicit line box afterwards, or selection geometry drifts
          // differently in each browser for mixed-size text.
          lineElement.style.lineHeight = `${lineHeight}px`;
          const separator = line.separatorAfter ?? (index < lines.length - 1 ? '\n' : '');
          if (line.runs && line.runs.length > 0) {
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
              lineElement.appendChild(runElement);
            }
          } else {
            lineElement.textContent = line.text + separator;
          }
          el.appendChild(lineElement);
        }
        el.dataset.vectoProjectionLines = signature;
      }
    } else {
      if (el.textContent !== projection.text) {
        this.releaseContentSelectionForRebuild(el);
        el.textContent = projection.text;
      }
      delete el.dataset.vectoProjectionLines;
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

    // Geometry: same threading as the interactive branch.
    const { a, b, c, d, e, f } = node.getWorldTransform();
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

    // Viewport/clip lazy: a flat DOM mirror must not keep intercepting input
    // after its VMT box has scrolled outside a clipChildren ancestor.
    let visible = true;
    if (node.width > 0 && node.height > 0) {
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
      visible = maxX >= 0 && minX <= this.width && maxY >= 0 && minY <= this.height;

      for (let ancestor = node.parent; visible && ancestor; ancestor = ancestor.parent) {
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
        visible =
          localMaxX >= 0 &&
          localMinX <= ancestor.width &&
          localMaxY >= 0 &&
          localMinY <= ancestor.height;
      }
    }
    const display = visible ? '' : 'none';
    if (el.style.display !== display) el.style.display = display;
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
  ): void {
    if (grid.source !== projection.text) {
      throw new Error('ContentProjection.grid.source must equal ContentProjection.text');
    }
    const signature = `${grid.revision}`;
    if (el.dataset.vectoContentGrid !== signature) {
      const materializeStart = typeof performance !== 'undefined' ? performance.now() : 0;
      this.clearContentGridState(node.id, el);
      el.replaceChildren();
      const projectionLines = projection.lines ?? [];
      for (let lineIndex = 0; lineIndex < grid.lines.length; lineIndex++) {
        const gridLine = grid.lines[lineIndex];
        const projectedLine = projectionLines[lineIndex];
        const lineHeight = projectedLine?.lineHeight ?? grid.lineHeight;
        const baseline = projectedLine?.baseline ?? grid.baseline;
        const lineFont = projectedLine?.font ?? grid.font;
        const lineElement = document.createElement('span');
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
        el.appendChild(lineElement);
      }
      el.dataset.vectoProjectionLines = signature;
      el.dataset.vectoContentGrid = signature;
      el.dataset.vectoGridCarriers = `${el.querySelectorAll('[data-vecto-grid-cell]').length}`;
      if (typeof performance !== 'undefined') {
        el.dataset.vectoGridMaterializeMs = `${performance.now() - materializeStart}`;
      }
      delete el.dataset.vectoGridCalibration;
      delete el.dataset.vectoGridReady;
    }

    const pageScaleX = this.getContentMetricScaleX();
    const calibrationKey = `${signature}:${this.contentFontEpoch}:${pageScaleX.toFixed(4)}`;
    if (el.dataset.vectoGridCalibration !== calibrationKey) {
      this.scheduleContentGridCalibration(node.id, el, calibrationKey, pageScaleX);
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
    for (const target of el.querySelectorAll<HTMLElement>('[data-vecto-grid-cell]')) {
      const sourceLength = Number(target.dataset.vectoGridSourceLength ?? 0);
      const targetWidth = Number(target.dataset.vectoGridAdvance ?? 0);
      if (sourceLength <= 0 || targetWidth <= 0) continue;
      const sourceText = target.textContent?.slice(0, sourceLength) ?? '';
      if (!sourceText) continue;
      const measurementKey = JSON.stringify([
        target.style.font,
        target.style.lineHeight,
        targetWidth,
        sourceText,
      ]);
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
      carrier.style.font = target.style.font;
      carrier.style.lineHeight = target.style.lineHeight;
      carrier.style.fontVariantLigatures = 'none';
      carrier.style.fontKerning = 'none';
      const source = document.createTextNode(sourceText);
      carrier.appendChild(source);
      probe.appendChild(carrier);
      const measurement = { targets: [target], targetWidth, sourceLength, source };
      measurements.push(measurement);
      measurementsByKey.set(measurementKey, measurement);
    }
    // Keep the probe under the projection root so CSS zoom and font
    // substitution match the live carriers. Gecko may still return an
    // unzoomed Range width for a missing-glyph fallback; pageScaleX below
    // compensates that engine behavior without special-casing the font.
    (this.a11yRoot ?? document.body ?? document.documentElement).appendChild(probe);
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

    const collect = (node: Entity) => {
      if (node.isDOMPortal) return;

      const contentEl = this.contentElements.get(node.id);
      if (contentEl) {
        if (node.a11yFullViewport) this.fullViewportElements.push(contentEl);
        else this.normalElements.push(contentEl);
      }

      if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
        const el = this.a11yElements.get(node.id);
        if (el) {
          this.activeIds.add(node.id);
          if (node.a11yFullViewport) this.fullViewportElements.push(el);
          else this.normalElements.push(el);
        }
      }
      for (const child of node.children) collect(child);
      if (node === this.root) {
        for (const overlay of this.overlayRoot.children) collect(overlay);
      }
    };

    collect(this.root);

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
        if (el.parentNode === this.a11yRoot) {
          this.a11yRoot.removeChild(el);
        }
        this.a11yElements.delete(id);
      }
    }

    if (elementsPruned) {
      this.a11yNeedsReorder = true;
    }

    // Only reorder if the hierarchy flag is set
    if (!this.a11yNeedsReorder) return;

    const fullLen = this.fullViewportElements.length;
    const normalLen = this.normalElements.length;
    const totalLen = fullLen + normalLen;

    // Reorder nodes with zero allocations (no expectedOrder array or concats)
    for (let i = 0; i < totalLen; i++) {
      const expected =
        i < fullLen ? this.fullViewportElements[i] : this.normalElements[i - fullLen];
      const current = this.a11yRoot.childNodes[i];
      if (current !== expected) {
        this.a11yRoot.insertBefore(expected, current || null);
      }
    }

    this.a11yNeedsReorder = false;
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

      if (node.interactive && (node.width > 0 || node.a11yFullViewport)) {
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
    const isIdle = !this.dirty && !this.frameHadAnimation;

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

    this.render(this.renderer, dt, time);

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
        this.syncA11y(this.root);
      }
      this.enforceA11yDomOrder();
      this.a11yPendingSyncAfterAnimation = hasActiveAnimation;
    } else if (hasActiveAnimation) {
      this.a11yPendingSyncAfterAnimation = true;
    }

    this.scheduleFrame();
  }

  /**
   * Render the entire scene graph onto the specified renderer.
   *
   * @param renderer - The renderer instance to draw to.
   * @param dt - Delta time in milliseconds (default 0).
   * @param time - Current absolute time in milliseconds (default 0).
   */
  public render(renderer: IRenderer, dt = 0, time = 0): void {
    const isMainRenderer = renderer === this.renderer;
    if (isMainRenderer && this.a11yRoot && this.canvas.parentElement) {
      const parentStyle = this.canvas.parentElement.style;
      if (!parentStyle.position || parentStyle.position === 'static') {
        parentStyle.position = 'relative';
      }
      this.syncOverlayGeometry();
    }

    if (isMainRenderer) {
      this.renderOrderCounter = 0;
      this.a11yRenderOrders.clear();
      this.activePortalsThisFrame.clear();
    }

    // Collect all ComputeParticleEntity instances in the tree
    const computeEntities: ComputeParticleEntity[] = [];
    const collectComputeEntities = (node: Entity) => {
      if (node instanceof ComputeParticleEntity) {
        computeEntities.push(node);
      }
      for (const child of node.children) {
        collectComputeEntities(child);
      }
    };
    collectComputeEntities(this.root);
    for (const overlay of this.overlayRoot.children) {
      collectComputeEntities(overlay);
    }

    if (computeEntities.length > 0) {
      // Particle simulation (WebGPU compute pass / CPU fallback) mutates
      // `entity.particleData` even when `dt === 0`. Secondary renderers such as
      // SVG export are read-only snapshots; deterministic `step()` still uses
      // the Scene's main renderer and therefore advances simulation.
      const isMainRenderPath = renderer === this.renderer;
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
          entity.updateCPU(dt / 1000, mx, my, this.width, this.height);
        }
      }
    } else if (isMainRenderer) {
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

    // renderNode carries the parent's accumulated world matrix as six scalar
    // params (canvas T*S*R order) to avoid per-node array allocation — important
    // for large scenes. Off-viewport entities with a known getBounds() are culled.
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
      if (isMainRenderer) {
        node.update(dt, time);
        if (!walkHadAnimation && node.hasPendingAnimations()) walkHadAnimation = true;
        if (!walkHadInteractive && node.interactive) walkHadInteractive = true;

        // Dev check: entity overrides update() but not hasPendingAnimations()
        if (this._devActive && this._devFrameCount % 120 === 0) {
          if (
            node.update !== Entity.prototype.update &&
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
      }

      // Compose parent * translate(x,y) * scale(sx,sy) * rotate(rot).
      const cos = Math.cos(node.rotation);
      const sin = Math.sin(node.rotation);
      const te = pa * node.x + pc * node.y + pe;
      const tf = pb * node.x + pd * node.y + pf;
      const sxCos = node.scaleX * cos;
      const sxSin = node.scaleX * sin;
      const syCos = node.scaleY * cos;
      const sySin = node.scaleY * sin;
      // Canvas calls translate → scale → rotate, so the local matrix is
      // T * S * R = [sx*cos, -sx*sin; sy*sin, sy*cos]. Keep culling,
      // portals, and GPU fast paths in the exact same coordinate system.
      const a = pa * sxCos + pc * sySin;
      const b = pb * sxCos + pd * sySin;
      const c = pa * -sxSin + pc * syCos;
      const d = pb * -sxSin + pd * syCos;
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
      const willProjectA11y =
        isMainRenderer && node.interactive && (node.width > 0 || node.a11yFullViewport);
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
          node.render(renderer);
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

    renderNode(this.root, 1, 0, 0, 1, 0, 0, 1);
    for (const overlay of this.overlayRoot.children) {
      renderNode(overlay, 1, 0, 0, 1, 0, 0, 1);
    }
    if (isMainRenderer) {
      this.frameHadAnimation = walkHadAnimation;
      this.frameHadInteractive = walkHadInteractive;
      this.reconcilePortals();
    }
    renderer.flush();
    if (isMainRenderer) {
      this.pointRenderer?.flush();
    }
    // Retained-scene backends (ThreeRenderer) render exactly once per frame here.
    renderer.present?.();
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
    if (this.gpuCanvas) {
      this.gpuCanvas.width = width;
      this.gpuCanvas.height = height;
    }
    this.markDirty();
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
    // 1. Search overlay root first (drawn on top)
    const overlayHit = this.findHitRecursively(this.overlayRoot, x, y);
    if (overlayHit) return overlayHit;

    // 2. Search main scene tree
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
      gpuCanvas.width = this.width;
      gpuCanvas.height = this.height;
      gpuCanvas.style.position = 'absolute';
      gpuCanvas.style.top = '0';
      gpuCanvas.style.left = '0';
      gpuCanvas.style.pointerEvents = 'none';
      gpuCanvas.style.zIndex = '6';
      if (this.canvas.parentElement) {
        this.canvas.parentElement.appendChild(gpuCanvas);
      }
      this.gpuCanvas = gpuCanvas;
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

  private findHitRecursively(node: Entity, x: number, y: number): Entity | null {
    // Walk children in reverse order (drawn last/top-most first)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const hit = this.findHitRecursively(node.children[i], x, y);
      if (hit) return hit;
    }

    // If the node itself has isPointInside and is hit
    if (node.isPointInside && node.isPointInside(x, y)) {
      return node;
    }

    return null;
  }
}
