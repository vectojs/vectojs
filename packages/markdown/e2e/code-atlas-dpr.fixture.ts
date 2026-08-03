/**
 * Browser fixture for `code-atlas-dpr.e2e.ts`.
 *
 * Renders one document holding both a fenced code block (which blits from the
 * shared glyph atlas) and prose (which does not), then exposes a numeric probe
 * the harness reads at several device-pixel-ratios.
 *
 * The probe reports `blitScale = renderer.pixelRatio / atlas.pixelRatio` **and**
 * peak edge contrast, because neither alone is sufficient evidence:
 *
 * - `blitScale` is the mechanism, and a mechanism assertion can pass while the
 *   pixels are wrong for an unrelated reason.
 * - Contrast is the symptom the user sees, but *mean* luminance gradient is
 *   confounded by content — mono glyphs are thinner and syntax-coloured, so the
 *   code-vs-prose mean ratio measured 0.216 at a matched DPR and 0.251 at a 2.71x
 *   mismatch, i.e. it moved the **wrong way** and would have "disproved" a real
 *   defect. Peak edge contrast does not have that failure mode: a resampled blit
 *   spreads every glyph edge over more pixels, which lowers the steepest step
 *   whatever the glyph is.
 *
 * Prose is measured alongside code as a control arm. It re-rasterizes per frame at
 * whatever DPR the context carries, so its contrast is expected to hold across a
 * zoom; code sharing that behaviour is the whole point of the fix.
 */
import { Scene } from '@vectojs/core';
import { codeAtlas, codeAtlasStats, Markdown } from '../src/Markdown';

/** Page background the canvas composites over, as [r, g, b]. */
const PAGE_BG: readonly [number, number, number] = [15, 23, 42];

const DOC = [
  'Prose line rendered as ordinary text for a control arm, long enough to wrap.',
  '',
  '```ts',
  'const answer = 42;',
  'function compute(input: string): number {',
  '  return input.length + answer;',
  '}',
  '```',
  '',
  'Another prose line following the fenced block.',
].join('\n');

const canvas = document.querySelector('canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('fixture needs a canvas');

const scene = new Scene(canvas, { disableWindowResize: false });
const markdown = new Markdown(DOC, { maxWidth: 520 });
markdown.setPosition(20, 20);
scene.add(markdown);
// `start()`, not `step()`: the rAF loop is what repaints after a DPR change, and
// stopping it before a pixel readback leaves the page blank because a DPR change
// reallocates the backing store and nothing repaints into it.
scene.start();

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World-space box of the first entity satisfying `pick`, or `null`. */
function regionOf(pick: (entity: unknown) => boolean): Region | null {
  const stack: Array<{ children: unknown[] }> = [markdown as unknown as { children: unknown[] }];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    for (const child of node.children) {
      if (pick(child)) {
        // `getWorldBounds()`, never `getBounds()` — the latter returns `null` on
        // the base `Entity` and reads as "nothing painted here".
        const bounds = (child as { getWorldBounds(): Region }).getWorldBounds();
        return bounds;
      }
      stack.push(child as { children: unknown[] });
    }
  }
  return null;
}

/**
 * Peak luminance step between horizontally adjacent pixels inside `region`,
 * after compositing the canvas's premultiplied-alpha samples over the page
 * background.
 *
 * The composite is required, not cosmetic: the backing store is transparent
 * wherever nothing painted, so reading raw samples makes light-on-dark text
 * measure against `rgba(0,0,0,0)` and a blank region score as healthy ink.
 */
function peakEdgeContrast(region: Region, dpr: number): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return -1;
  const x = Math.max(0, Math.floor(region.x * dpr));
  const y = Math.max(0, Math.floor(region.y * dpr));
  const w = Math.min(canvas.width - x, Math.ceil(region.width * dpr));
  const h = Math.min(canvas.height - y, Math.ceil(region.height * dpr));
  if (w <= 1 || h <= 0) return -1;
  const data = ctx.getImageData(x, y, w, h).data;
  const luma = (index: number): number => {
    const alpha = data[index + 3] / 255;
    const r = data[index] * alpha + PAGE_BG[0] * (1 - alpha);
    const g = data[index + 1] * alpha + PAGE_BG[1] * (1 - alpha);
    const b = data[index + 2] * alpha + PAGE_BG[2] * (1 - alpha);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  let peak = 0;
  for (let row = 0; row < h; row++) {
    const rowStart = row * w * 4;
    for (let col = 1; col < w; col++) {
      const step = Math.abs(luma(rowStart + col * 4) - luma(rowStart + (col - 1) * 4));
      if (step > peak) peak = step;
    }
  }
  return peak;
}

export interface CodeAtlasProbe {
  /** Device pixels per CSS pixel the renderer is scaled to. */
  sceneDpr: number;
  /** Ratio the resident atlas rasterized its slots at, or `null` before first blit. */
  atlasDpr: number | null;
  /** `sceneDpr / atlasDpr`. Must be 1 for the blit to land unresampled. */
  blitScale: number | null;
  /** Atlas resets so far; a climbing count means the glyph set outgrew the atlas. */
  atlasResets: number | null;
  /** Resident slots, to confirm the blit path ran at all. */
  atlasSlots: number | null;
  /** Peak edge contrast inside the fenced block. */
  codeContrast: number;
  /** Peak edge contrast inside a paragraph — the control arm. */
  proseContrast: number;
  /** Backing store width, to confirm the DPR change actually reallocated it. */
  backingWidth: number;
  /** Times the fenced block has painted, so a reader can tell a repaint happened. */
  codeRenders: number;
}

function probe(): CodeAtlasProbe {
  const renderer = scene.getRenderer() as { pixelRatio?: number };
  const sceneDpr = renderer.pixelRatio ?? window.devicePixelRatio ?? 1;
  const atlas = codeAtlas();
  const stats = codeAtlasStats();
  const code = regionOf(
    (entity) => (entity as { constructor: { name: string } }).constructor.name === 'CodeBlock',
  );
  const prose = regionOf(
    (entity) =>
      (entity as { spans?: unknown[] }).spans !== undefined &&
      (entity as { constructor: { name: string } }).constructor.name !== 'CodeBlock',
  );
  return {
    sceneDpr,
    atlasDpr: atlas ? atlas.pixelRatio : null,
    blitScale: atlas ? sceneDpr / atlas.pixelRatio : null,
    atlasResets: stats ? stats.resets : null,
    atlasSlots: stats ? stats.size : null,
    codeContrast: code ? peakEdgeContrast(code, sceneDpr) : -1,
    proseContrast: prose ? peakEdgeContrast(prose, sceneDpr) : -1,
    backingWidth: canvas.width,
    codeRenders: codeRenders(),
  };
}

/**
 * Count paints of the fenced block.
 *
 * The harness needs this to wait for a *rendered frame* rather than a rAF tick:
 * an idle `always`-mode scene throttles to 2 FPS, so three rAF callbacks can
 * elapse with nothing painted and a DPR assertion would then read the pre-resize
 * state and blame the atlas.
 */
let codeRenderCount = 0;
function codeRenders(): number {
  return codeRenderCount;
}

const codeEntity = (() => {
  const stack: Array<{ children: unknown[] }> = [markdown as unknown as { children: unknown[] }];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    for (const child of node.children) {
      if ((child as { constructor: { name: string } }).constructor.name === 'CodeBlock') {
        return child as { render(r: unknown): void };
      }
      stack.push(child as { children: unknown[] });
    }
  }
  throw new Error('fixture document produced no CodeBlock');
})();
const originalRender = codeEntity.render.bind(codeEntity);
codeEntity.render = (r: unknown): void => {
  codeRenderCount++;
  originalRender(r);
};

Object.assign(window as unknown as Record<string, unknown>, {
  __codeAtlasProbe: probe,
  __codeRenderCount: codeRenders,
  /** Reallocate the backing store for the current ratio, as `Scene`'s DPR watcher does. */
  __resizeScene: () => scene.resize(scene.width, scene.height),
  __ready: true,
});
