/**
 * Paragraph-image repaint fixture.
 *
 * `paragraphImage`'s `onLoad` used to nest `markDirty()` inside a
 * `naturalWidth && naturalHeight` check, so a source that loads successfully
 * while reporting a zero dimension never notified the scene. An `onDemand`
 * scene repaints only when marked, so whatever changed at decode time was never
 * drawn.
 *
 * Measuring this correctly took four attempts, and the three failed ones are
 * why this fixture is shaped the way it is:
 *
 * 1. **Do not sample `scene.dirty`.** The rAF loop consumes it before the
 *    update/render pass (`Scene.ts`), within a frame of `markDirty()`, so any
 *    later poll reads `false` — including for a control arm that definitely
 *    marked. That reads as "no bug" when the instrument is simply blind.
 * 2. **Drain `document.fonts` before the `Scene` exists.** `Scene`'s
 *    constructor does `document.fonts.ready.then(...)` and that handler calls
 *    `markDirty()`. Its stack showed up as the waker in the *failing* arm, i.e.
 *    the scene recovered by coincidence and hid the defect.
 * 3. **Serve the image with a delay.** A `data:` URI decodes ~synchronously, so
 *    the decode lands before the first paint and there is no transition to
 *    observe at all.
 *
 * Even then, counting repaints could not discriminate, because `scene.destroy()`
 * raises its own marks through `Stack.remove`. What discriminates is counting
 * `markDirty()` calls *attributable to the image's own `onload`*, sampled
 * strictly between the first paint and any teardown.
 */
import { Scene } from '../../core/src/index';
import { Markdown } from '../src/Markdown';

declare global {
  interface Window {
    __ready: boolean;
    __paragraphImageResult: ParagraphImageBrowserResult;
    __paragraphImageError: string;
  }
}

export interface ParagraphImageCaseResult {
  name: string;
  /** `markDirty()` calls raised by the image's own `onload` handler. */
  marksFromDecode: number;
  /** Whether the entity reports a decoded bitmap at all. */
  loaded: boolean;
  /** Bitmap intrinsic size as the browser reports it. */
  naturalWidth: number;
  naturalHeight: number;
  /** Entity box after the decode. */
  width: number;
  height: number;
  /** Ink inside the image box, and in a control strip below it. */
  ink: number;
  inkBelow: number;
}

export interface ParagraphImageBrowserResult {
  cases: ParagraphImageCaseResult[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ink inside a box, inset 1px per side so a border cannot be counted as fill. */
function inkIn(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const context = canvas.getContext('2d');
  if (!context || w <= 2 || h <= 2) return -1;
  const left = Math.max(0, Math.round(x) + 1);
  const top = Math.max(0, Math.round(y) + 1);
  const width = Math.min(Math.round(w) - 2, canvas.width - left);
  const height = Math.min(Math.round(h) - 2, canvas.height - top);
  if (width <= 0 || height <= 0) return -1;
  const { data } = context.getImageData(left, top, width, height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) count++;
  }
  return count;
}

interface CaseSpec {
  name: string;
  /** Query string selecting which image the runner's server returns. */
  src: string;
}

async function runCase(spec: CaseSpec): Promise<ParagraphImageCaseResult> {
  // Trap 2: drain fonts BEFORE any Scene exists, so the only thing that can
  // wake this scene is the image decode.
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { renderMode: 'onDemand' });

  // Attribute every markDirty() to its caller. A bare count cannot separate the
  // image's own onload from font-ready or from teardown.
  const marks: string[] = [];
  const sceneAny = scene as unknown as { markDirty: () => void };
  const originalMarkDirty = sceneAny.markDirty.bind(scene);
  sceneAny.markDirty = () => {
    marks.push(new Error().stack ?? '');
    originalMarkDirty();
  };

  const markdown = new Markdown(`before ![alt](${spec.src}) after`, {
    width: 600,
  });
  scene.add(markdown);
  scene.start();

  // Locate the Image entity by shape: the bundler minifies class names, so a
  // `constructor.name === 'Image'` test silently matches nothing.
  let image: {
    width: number;
    height: number;
    x: number;
    y: number;
    bitmap: HTMLImageElement | null;
    loaded: boolean;
  } | null = null;
  const walk = (entity: { children?: unknown[] }): void => {
    if ('src' in entity && 'bitmap' in entity) {
      image = entity as unknown as typeof image;
    }
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(markdown as unknown as { children?: unknown[] });
  if (!image) throw new Error(`${spec.name}: no paragraph image entity was built`);
  const img = image as NonNullable<typeof image>;

  // First paint is on screen; anything after this sample is attributable to the
  // decode, and we stop sampling before any teardown.
  await sleep(200);
  const marksBefore = marks.length;

  // Trap 3: the image is served with a delay, so wait past it.
  await sleep(900);

  const marksFromDecode = marks
    .slice(marksBefore)
    .filter((stack) => /onload|onLoad/.test(stack)).length;

  // Absolute position of the image box on the canvas.
  let absX = img.x;
  let absY = img.y;
  let parent = (img as unknown as { parent?: { x: number; y: number; parent?: unknown } }).parent;
  while (parent) {
    absX += parent.x;
    absY += parent.y;
    parent = (parent as { parent?: { x: number; y: number; parent?: unknown } }).parent;
  }

  const ink = inkIn(canvas, absX, absY, img.width, img.height);
  const inkBelow = inkIn(canvas, absX, absY + img.height + 6, img.width, 10);

  const result: ParagraphImageCaseResult = {
    name: spec.name,
    marksFromDecode,
    loaded: img.loaded,
    naturalWidth: img.bitmap?.naturalWidth ?? -1,
    naturalHeight: img.bitmap?.naturalHeight ?? -1,
    width: img.width,
    height: img.height,
    ink,
    inkBelow,
  };

  scene.destroy();
  canvas.remove();
  return result;
}

async function run(): Promise<ParagraphImageBrowserResult> {
  const cases: ParagraphImageCaseResult[] = [];
  // A cache-busting suffix per case: a shared URL is served from cache on the
  // second request and arrives already decoded, erasing the race.
  cases.push(await runCase({ name: 'sized', src: `/img?kind=sized&n=${Math.random()}` }));
  cases.push(
    await runCase({
      name: 'zeroSized',
      src: `/img?kind=zero&n=${Math.random()}`,
    }),
  );
  return { cases };
}

run()
  .then((result) => {
    window.__paragraphImageResult = result;
    window.__ready = true;
  })
  .catch((error: unknown) => {
    window.__paragraphImageError = error instanceof Error ? error.message : String(error);
    window.__ready = true;
  });
