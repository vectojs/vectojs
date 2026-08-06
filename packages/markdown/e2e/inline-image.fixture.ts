/**
 * Inline-image fixture: an image on a line it shares with text.
 *
 * Verifies in a real browser what jsdom structurally cannot. jsdom settles
 * neither `onload` nor `onerror` for any URL shape (measured, and the same
 * finding `nestedImages.test.ts` and `paragraph-image-repaint.fixture.ts` both
 * record), so the unit tests simulate a decode by forcing
 * `naturalWidth`/`naturalHeight` and invoking the handler the store installed.
 * That proves the arithmetic. It cannot prove that a real decode fires, that the
 * correction repaints, or that pixels land inside the reserved box — which is
 * exactly the failure inline math shipped once: a correctly measured, correctly
 * positioned, accessible, completely blank gap.
 *
 * Three traps inherited from `paragraph-image-repaint.fixture.ts`, all of which
 * apply here for the same reasons:
 *
 * 1. **Drain `document.fonts` before any `Scene` exists.** `Scene`'s constructor
 *    hangs a `markDirty()` off `document.fonts.ready`, which otherwise wakes the
 *    scene by coincidence and hides a missing repaint.
 * 2. **Serve the image with a delay.** A `data:` URI decodes ~synchronously, so
 *    it lands before the first paint and leaves no square-to-aspect transition to
 *    observe, which is the entire point of this fixture.
 * 3. **Bust the cache per case.** A shared URL is served from cache on the second
 *    request and arrives already decoded.
 *
 * Geometry is read through `RichText.result.nodes`, the same private-by-cast
 * probe `lazy-math.fixture.ts` uses and for the same reason: the positioned box
 * is an implementation detail everywhere except here, where it is the subject.
 */
import { Scene } from '../../core/src/index';
import { Markdown } from '../src/Markdown';
import { ensureInlineImageRaster } from '../src/markdown-image';

declare global {
  interface Window {
    __ready: boolean;
    __inlineImageResult: InlineImageBrowserResult;
    __inlineImageError: string;
  }
}

export interface InlineImageCaseResult {
  name: string;
  /** Reserved box before the decode (a square) and after it (the real aspect). */
  widthBefore: number;
  heightBefore: number;
  widthAfter: number;
  heightAfter: number;
  /** The object's accessible name, and what it identifies itself as painting. */
  alt: string;
  key: string;
  /** Painted pixels inside the reserved box, and in a control strip below it. */
  paintedPixelsInBox: number;
  paintedPixelsBelowBox: number;
  /** What the browser reported for the raster. */
  decoded: boolean;
  naturalWidth: number;
  naturalHeight: number;
  /** The alt text must NOT appear as visible prose, but must be accessible. */
  visibleTextHasAlt: boolean;
  accessibleTextHasAlt: boolean;
}

export interface InlineImageBrowserResult {
  cases: InlineImageCaseResult[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbedNode {
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  object?: {
    width: number;
    height: number;
    depth?: number;
    alt?: string;
    key?: string;
  };
}

interface ProbedRichText {
  result?: { nodes: ProbedNode[] };
  sourceText?: () => string;
  accessibleText?: () => string;
}

/** Every positioned object node under an entity subtree. */
function objectNodes(root: unknown): Array<{ node: ProbedNode; owner: ProbedRichText }> {
  const found: Array<{ node: ProbedNode; owner: ProbedRichText }> = [];
  const walk = (entity: { children?: unknown[] }): void => {
    const probe = entity as unknown as ProbedRichText;
    for (const node of probe.result?.nodes ?? []) {
      if (node.object) found.push({ node, owner: probe });
    }
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(root as { children?: unknown[] });
  return found;
}

/** Concatenated accessible text over the whole subtree. */
function accessibleTextOf(root: unknown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const probe = entity as unknown as ProbedRichText;
    if (typeof probe.accessibleText === 'function') out += probe.accessibleText();
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(root as { children?: unknown[] });
  return out;
}

/** Concatenated span text, i.e. what is painted as prose. */
function visibleTextOf(root: unknown): string {
  let out = '';
  const walk = (entity: { children?: unknown[] }): void => {
    const spans = (entity as { spans?: Array<{ text?: string }> }).spans;
    for (const span of spans ?? []) out += span.text ?? '';
    for (const child of entity.children ?? []) walk(child as { children?: unknown[] });
  };
  walk(root as { children?: unknown[] });
  return out;
}

/** Absolute canvas position of an entity. */
function absolutePosition(entity: unknown): { x: number; y: number } {
  let x = (entity as { x: number }).x;
  let y = (entity as { y: number }).y;
  let parent = (entity as { parent?: unknown }).parent;
  while (parent) {
    x += (parent as { x: number }).x;
    y += (parent as { y: number }).y;
    parent = (parent as { parent?: unknown }).parent;
  }
  return { x, y };
}

function inkIn(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const context = canvas.getContext('2d');
  if (!context || w <= 2 || h <= 2) return -1;
  const left = Math.max(0, Math.floor(x) + 1);
  const top = Math.max(0, Math.floor(y) + 1);
  const width = Math.min(Math.floor(w) - 2, canvas.width - left);
  const height = Math.min(Math.floor(h) - 2, canvas.height - top);
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
  /** Markdown source with `SRC` standing in for the case's image URL. */
  source: string;
  src: string;
}

async function runCase(spec: CaseSpec): Promise<InlineImageCaseResult> {
  // Trap 1.
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  document.body.appendChild(canvas);

  const scene = new Scene(canvas, { disableWindowResize: true });
  scene.resize(640, 400);
  const markdown = new Markdown(spec.source.replace('SRC', spec.src), {
    width: 600,
  });
  scene.add(markdown);

  // One frame, so the box exists and is positioned but the delayed image has not
  // arrived: this is the square the span reserved.
  scene.step(16.67);
  const before = objectNodes(markdown);
  if (before.length !== 1) {
    throw new Error(`${spec.name}: expected 1 object node before decode, got ${before.length}`);
  }
  const widthBefore = before[0].node.object?.width ?? -1;
  const heightBefore = before[0].node.object?.height ?? -1;

  // Trap 2: step frames until the raster reports a decode and the rebuild has
  // repainted, rather than sleeping a guessed interval.
  //
  // Waiting on the DECODE and not on ink is load-bearing. A table draws its own
  // header text and cell borders, so a sample region around a cell's box already
  // has ink before the image arrives — an ink-gated loop breaks on the table's own
  // chrome and reports `decoded: false` alongside a positive pixel count, which is
  // exactly what the first version of this fixture did.
  let painted = 0;
  let after = before;
  for (let attempt = 0; attempt < 240; attempt++) {
    scene.step(16.67);
    await sleep(10);
    const raster = ensureInlineImageRaster(spec.src);
    if (!raster.decoded) continue;
    after = objectNodes(markdown);
    if (after.length !== 1) continue;
    const node = after[0].node;
    // The rebuild has to have happened too: until it does, the box is still the
    // square and its width does not match the decoded aspect ratio.
    const expectedWidth =
      ((node.object?.height ?? 0) * (raster.naturalWidth ?? 1)) / (raster.naturalHeight ?? 1);
    if (Math.abs((node.object?.width ?? 0) - expectedWidth) > 0.5) continue;
    const position = absolutePosition(after[0].owner);
    painted = inkIn(
      canvas,
      position.x + node.x,
      position.y + node.y,
      node.object?.width ?? 0,
      node.object?.height ?? 0,
    );
    if (painted > 0) break;
  }

  if (after.length !== 1) {
    throw new Error(`${spec.name}: expected 1 object node after decode, got ${after.length}`);
  }
  const node = after[0].node;
  const object = node.object;
  const position = absolutePosition(after[0].owner);
  const raster = ensureInlineImageRaster(spec.src);

  const result: InlineImageCaseResult = {
    name: spec.name,
    widthBefore,
    heightBefore,
    widthAfter: object?.width ?? -1,
    heightAfter: object?.height ?? -1,
    alt: object?.alt ?? '',
    key: object?.key ?? '',
    paintedPixelsInBox: painted,
    // The control strip: inside the canvas, below the line, so it must stay empty.
    // Without it a sampler reading the wrong region would report ink regardless of
    // what the painter did.
    paintedPixelsBelowBox: inkIn(
      canvas,
      position.x + node.x,
      position.y + node.y + (object?.height ?? 0) + 6,
      object?.width ?? 0,
      8,
    ),
    decoded: raster.decoded,
    naturalWidth: raster.naturalWidth ?? -1,
    naturalHeight: raster.naturalHeight ?? -1,
    visibleTextHasAlt: visibleTextOf(markdown).includes('BADGEALT'),
    accessibleTextHasAlt: accessibleTextOf(markdown).includes('BADGEALT'),
  };

  scene.destroy();
  canvas.remove();
  return result;
}

async function run(): Promise<InlineImageBrowserResult> {
  const cases: InlineImageCaseResult[] = [];
  // Trap 3: a fresh URL per case.
  cases.push(
    await runCase({
      name: 'heading',
      source: '# Title ![BADGEALT](SRC) tail',
      src: `/img?kind=wide&n=${Math.random()}`,
    }),
  );
  cases.push(
    await runCase({
      name: 'tableCell',
      source: '| head |\n| --- |\n| ![BADGEALT](SRC) |',
      src: `/img?kind=wide&n=${Math.random()}`,
    }),
  );
  return { cases };
}

run()
  .then((result) => {
    window.__inlineImageResult = result;
    window.__ready = true;
  })
  .catch((error: unknown) => {
    window.__inlineImageError = error instanceof Error ? error.message : String(error);
    window.__ready = true;
  });
