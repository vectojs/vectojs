import { Scene, MSDFTextEntity } from '../src/index';
import type { MSDFFont } from '@vectojs/text';
import { LayoutWorkerManager } from '@vectojs/layout';

declare global {
  interface Window {
    __ready?: boolean;
    __layoutFallbackResult?: LayoutFallbackBrowserResult;
    __layoutFallbackError?: string;
  }
}

/**
 * What one `MSDFTextEntity` produced on a real canvas.
 *
 * `ink` is the only field that separates "laid out" from "actually painted".
 * The defect this guards produced correct `width`/`height`, correct hit-testing,
 * and a correct DOM content projection while drawing nothing at all, so every
 * non-pixel assertion passed.
 */
export interface LayoutCaseResult {
  name: string;
  /** Did constructing the Scene/entity throw? `null` when it did not. */
  constructError: string | null;
  /** Did layout geometry ever arrive? */
  gotLayout: boolean;
  /** Glyph count from the layout result, 0 when there is none. */
  glyphs: number;
  /** Non-transparent pixels in the text's box. */
  ink: number;
  /** Non-transparent pixels in an untouched strip below the text. */
  inkBelow: number;
  /** How many `Worker` constructions were attempted during the case. */
  workerAttempts: number;
}

export interface LayoutFallbackBrowserResult {
  /** Whether this document could construct a blob Worker at all. */
  workerUsable: boolean;
  cases: LayoutCaseResult[];
}

/**
 * A minimal MSDF font. No atlas raster is involved: these cases deliberately
 * run on the Canvas2D fallback path (`fillText` per glyph), because the subject
 * under test is whether *layout* arrives, not whether a GL atlas uploads.
 * Advances are explicit so the expected box is arithmetic.
 */
const FONT_DATA = {
  atlas: {
    type: 'msdf',
    distanceRange: 4,
    size: 32,
    width: 256,
    height: 256,
    yOrigin: 'bottom',
  },
  metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 0x48, advance: 0.7 }, // H
    { unicode: 0x49, advance: 0.4 }, // I
    { unicode: 0x20, advance: 0.3 }, // space
  ],
};

function makeFont(): MSDFFont {
  return {
    id: 'e2e-msdf-font',
    data: FONT_DATA,
    atlasWidth: 256,
    atlasHeight: 256,
    distanceRange: 4,
    getGlyph: () => undefined,
  } as unknown as MSDFFont;
}

/** Count pixels with meaningful alpha in a rect. */
function inkIn(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const context = canvas.getContext('2d');
  if (!context || w <= 0 || h <= 0) return -1;
  const cw = Math.min(Math.round(w), canvas.width - Math.round(x));
  const ch = Math.min(Math.round(h), canvas.height - Math.round(y));
  if (cw <= 0 || ch <= 0) return -1;
  const data = context.getImageData(Math.round(x), Math.round(y), cw, ch).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) count++;
  }
  return count;
}

interface CaseSpec {
  name: string;
  /** Install the environment for this case; returns a restore function. */
  setup: () => () => void;
  /** Break the live worker after the entity is constructed. */
  breakAfterConstruct?: boolean;
  /**
   * Issue this many extra layout requests, spaced out so each one sees the
   * previous failure. Without them a case makes exactly ONE queueLayout call and
   * therefore creates at most one Worker, which makes the recreation-cap
   * assertion vacuous — measured: removing the cap entirely still reported
   * workerAttempts=1.
   */
  extraRequests?: number;
}

/** Can this document construct a blob-URL Worker? Under CSP it cannot. */
async function probeWorkerUsable(): Promise<boolean> {
  if (typeof Worker === 'undefined') return false;
  let url = '';
  try {
    url = URL.createObjectURL(
      new Blob(['self.onmessage=()=>self.postMessage(1)'], {
        type: 'application/javascript',
      }),
    );
    const worker = new Worker(url);
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      worker.onmessage = () => finish(true);
      worker.onerror = () => finish(false);
      worker.postMessage('ping');
      setTimeout(() => finish(false), 1500);
    });
    worker.terminate();
    return ok;
  } catch {
    return false;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function runCase(spec: CaseSpec): Promise<LayoutCaseResult> {
  const RealWorker = globalThis.Worker;
  let workerAttempts = 0;
  // Count construction attempts without changing behaviour.
  if (typeof RealWorker !== 'undefined') {
    globalThis.Worker = class extends RealWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        workerAttempts++;
        super(scriptURL, options);
      }
    } as unknown as typeof Worker;
  }
  const restoreCase = spec.setup();
  // Each case starts from a fresh manager. The manager is a process-wide
  // singleton, so without this an earlier case that exhausted the recreation cap
  // leaves `workerUnavailable` set and the next case attempts zero Workers —
  // which silently turns the cap assertion into a tautology (measured: the
  // repeated-requests case reported workerAttempts=0 and passed with the cap
  // removed).
  LayoutWorkerManager.getInstance().destroy();

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 140;
  document.body.appendChild(canvas);

  let constructError: string | null = null;
  let scene: Scene | null = null;
  let entity: MSDFTextEntity | null = null;

  try {
    scene = new Scene(canvas, { disableWindowResize: true });
    entity = new MSDFTextEntity('HIHI HIHI', {
      font: makeFont(),
      // A 1x1 canvas: a decoded, ready texture, so the atlas-decode path
      // (CTX-0154) cannot interfere with what this measures.
      texture: (() => {
        const atlas = document.createElement('canvas');
        atlas.width = 1;
        atlas.height = 1;
        return atlas;
      })(),
      fontSize: 32,
      color: '#00c000',
      maxWidth: 300,
    });
    entity.setPosition(8, 8);
    scene.add(entity);
  } catch (error: unknown) {
    constructError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  if (spec.breakAfterConstruct && !constructError) {
    // Fire the live worker's error handler, simulating a crash (an OOM or an
    // internal error) rather than a blocked construction. Reached through the
    // manager singleton's private field: deliberately not exposed as a public
    // hook, since production code should not carry a test-only seam.
    const manager = LayoutWorkerManager.getInstance() as unknown as { worker: Worker | null };
    const worker = manager.worker as unknown as { onerror?: (e: Event) => void } | null;
    worker?.onerror?.(new Event('error'));
  }

  // Drive further layout requests, each after the previous has had time to fail.
  // `setMaxWidth` is the cheapest public trigger; the debounce is per entity and
  // leading-edge, so the sleep matters.
  for (let extra = 0; extra < (spec.extraRequests ?? 0); extra++) {
    entity?.setMaxWidth(300 - (extra + 1));
    await new Promise((resolve) => setTimeout(resolve, 120));
    scene?.step(16.67);
  }

  // Layout may be async (worker) or already resolved (main thread). Poll.
  for (let frame = 0; frame < 90; frame++) {
    scene?.step(16.67);
    const done = Boolean((entity as unknown as { layoutResult: unknown } | null)?.layoutResult);
    if (done && frame > 3) break;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  // A few extra frames so the glyphs are definitely painted.
  for (let frame = 0; frame < 4; frame++) scene?.step(16.67);

  const layoutResult = (
    entity as unknown as {
      layoutResult: {
        width: number;
        height: number;
        codePoints: Uint32Array;
      } | null;
    } | null
  )?.layoutResult;

  const result: LayoutCaseResult = {
    name: spec.name,
    constructError,
    gotLayout: Boolean(layoutResult),
    glyphs: layoutResult?.codePoints.length ?? 0,
    ink: inkIn(canvas, 4, 4, 312, 90),
    // Must stay 0: if this has ink the sample region is wrong and every
    // positive count above is meaningless.
    inkBelow: inkIn(canvas, 4, 110, 312, 26),
    workerAttempts,
  };

  scene?.destroy();
  canvas.remove();
  restoreCase();
  globalThis.Worker = RealWorker;
  return result;
}

async function run(): Promise<LayoutFallbackBrowserResult> {
  const workerUsable = await probeWorkerUsable();

  const specs: CaseSpec[] = [
    // Control: whatever this document's default is (a real worker without CSP,
    // the fallback under CSP). Proves the two produce the same pixels.
    { name: 'default', setup: () => () => {} },
    // No Worker global at all — the SSR-shaped path, in a browser.
    {
      name: 'noWorkerGlobal',
      setup: () => {
        const saved = globalThis.Worker;
        (globalThis as { Worker?: unknown }).Worker = undefined;
        return () => {
          globalThis.Worker = saved;
        };
      },
    },
    // `new Worker` throws. Used to escape the MSDFTextEntity constructor.
    {
      name: 'workerCtorThrows',
      setup: () => {
        const saved = globalThis.Worker;
        // A constructor-only class IS the stub: the test needs `new Worker()` to
        // throw, which cannot be expressed without a constructor.
        // oxlint-disable-next-line typescript/no-extraneous-class
        globalThis.Worker = class {
          constructor() {
            throw new DOMException('Blocked for the test', 'SecurityError');
          }
        } as unknown as typeof Worker;
        return () => {
          globalThis.Worker = saved;
        };
      },
    },
    // A worker that constructs, then fails at runtime.
    { name: 'workerRuntimeError', setup: () => () => {}, breakAfterConstruct: true },
    // Six sequential requests, to bound Worker recreation in a permanently
    // worker-hostile document. Kept separate from the cases above because
    // `setMaxWidth` changes the wrap boundary and therefore the painted pixels,
    // so this one is not ink-compared against the control.
    { name: 'repeatedRequests', setup: () => () => {}, extraRequests: 5 },
  ];

  const cases: LayoutCaseResult[] = [];
  for (const spec of specs) cases.push(await runCase(spec));
  return { workerUsable, cases };
}

run()
  .then((result) => {
    window.__layoutFallbackResult = result;
    window.__ready = true;
  })
  .catch((error: unknown) => {
    window.__layoutFallbackError = error instanceof Error ? error.message : String(error);
    window.__ready = true;
  });
