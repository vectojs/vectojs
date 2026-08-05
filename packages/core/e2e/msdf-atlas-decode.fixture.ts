/**
 * Fixture for the MSDF atlas-decode e2e gate. Bundled and served by
 * `msdf-atlas-decode.e2e.ts`.
 *
 * Renders MSDF text whose atlas is served with latency, so the atlas is still
 * decoding when the entity first renders, and reports both real GL ink and the
 * upload count.
 */
// Import through the barrel, not `../src/tree/Scene`: the WebGL point renderer
// self-registers on `packages/core/src/index.ts` load, so a direct Scene import
// leaves `pointBackend: 'webgl'` silently falling back to Canvas2D and no GL
// layer is ever created.
import { Scene, MSDFTextEntity } from '../src/index';
import { MSDFFont, type MSDFFontData } from '@vectojs/text';

declare global {
  interface Window {
    __ready?: boolean;
    __msdfDecodeResult?: MsdfDecodeBrowserResult;
    __msdfDecodeError?: string;
  }
}

export interface MsdfCaseResult {
  name: string;
  renderMode: 'always' | 'onDemand';
  /** WebGL2 unavailable, so `Scene` fell back to Canvas2D: nothing to sample. */
  skipped: boolean;
  /** Painted pixels inside the text box (alpha > 8). */
  ink: number;
  /** Painted pixels in a control strip below the text — must be 0. */
  inkBelow: number;
  /** `img.complete` when the entity first submitted glyphs. */
  completeAtFirstRender: boolean | null;
  /** Real `texImage2D` calls for the atlas (`atlasSwitches`). */
  uploads: number;
  /** Uploads before the post-decode frame — must be 0: no empty commit. */
  uploadsBeforeRepaint: number;
  /** Scene dirty flag with the atlas still decoding (must be false). */
  dirtyBeforeDecode: boolean;
  /**
   * Scene dirty flag shortly after the atlas decoded. This is the repaint
   * hook's actual contract, and unlike a rendered frame it does not depend on
   * rAF scheduling — headless rAF is throttled hard enough (2 ticks in 550 ms,
   * measured) that frame-based assertions pass or fail by luck.
   */
  dirtyAfterDecode: boolean;
}

export interface MsdfDecodeBrowserResult {
  cases: MsdfCaseResult[];
}

/** Atlas geometry. One solid-white cell: the shader's median is 1.0 → full ink. */
const ATLAS_SIZE = 64;
const CELL = 32;
const FONT_SIZE = 48;
const TEXT = 'AAA';

/**
 * A one-glyph `msdf-atlas-gen` document. `A` maps to the white cell, with plane
 * bounds forming a full 1em box so each quad is `FONT_SIZE` square and the
 * expected ink is arithmetic rather than a magic number.
 */
function buildFontData(): MSDFFontData {
  return {
    atlas: {
      type: 'msdf',
      distanceRange: 4,
      size: 32,
      width: ATLAS_SIZE,
      height: ATLAS_SIZE,
      yOrigin: 'top',
    },
    metrics: { emSize: 1, lineHeight: 1.25, ascender: 0.8, descender: -0.2 },
    glyphs: [
      {
        unicode: 'A'.codePointAt(0)!,
        advance: 1,
        planeBounds: { left: 0, bottom: 0, right: 1, top: 1 },
        atlasBounds: { left: 0, bottom: CELL, right: CELL, top: 0 },
      },
    ],
  };
}

function countInk(gl: WebGL2RenderingContext, x: number, y: number, w: number, h: number): number {
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 8) ink++;
  return ink;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the atlas over HTTP with `delayMs` of latency and DO NOT await it.
 *
 * A data-URI atlas cannot reproduce the defect: it decodes faster than the
 * layout-worker round-trip, so the entity's first render already sees a decoded
 * image. Each case gets a unique URL because a shared one is served from cache
 * on the second case and arrives decoded within ~20 ms, erasing the race.
 */
function networkAtlas(name: string, delayMs: number): HTMLImageElement {
  const img = new Image();
  img.src = `/atlas.png?delay=${delayMs}&case=${encodeURIComponent(name)}`;
  return img;
}

/**
 * A canvas atlas, drawn synchronously. It has no decode state at all, so it is
 * the control: it must paint regardless of how readiness is handled.
 */
function canvasAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D context for the control atlas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CELL, CELL);
  return canvas;
}

async function runCase(
  name: string,
  renderMode: 'always' | 'onDemand',
  delayMs: number,
): Promise<MsdfCaseResult> {
  const host = document.createElement('div');
  host.style.position = 'relative';
  document.body.appendChild(host);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  host.appendChild(canvas);

  const scene = new Scene(canvas, {
    width: 320,
    height: 200,
    pointBackend: 'webgl',
    renderMode,
  });

  // Drain the Scene's own font-load wake BEFORE the atlas request starts.
  // `Scene`'s constructor does `document.fonts.ready.then(fontLoadHandler)`
  // (Scene.ts:2624) and that handler calls markDirty, so it lands shortly after
  // this scene exists no matter what the caller awaited earlier. Measured in
  // Chromium it fired at 615 ms against an atlas that decoded at 614 ms,
  // uploading the atlas by coincidence — on its own that made this gate pass
  // with the repaint hook deleted.
  await document.fonts.ready;
  await sleep(150);

  // delayMs < 0 selects the decode-free canvas control.
  const atlas: TexImageSource = delayMs < 0 ? canvasAtlas() : networkAtlas(name, delayMs);
  const image = atlas as HTMLImageElement;
  // Resolve on either outcome: a case that 404s must not hang the fixture.
  const decoded =
    typeof image.addEventListener === 'function' && typeof image.complete === 'boolean'
      ? new Promise<void>((resolve) => {
          if (image.complete && image.naturalWidth > 0) {
            resolve();
            return;
          }
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        })
      : Promise.resolve();
  const entity = new MSDFTextEntity(TEXT, {
    font: new MSDFFont(buildFontData()),
    texture: atlas,
    fontSize: FONT_SIZE,
    color: '#ffffff',
    maxWidth: 300,
  });
  entity.x = 10;
  entity.y = 10;
  scene.add(entity);

  // No WebGL2 means `Scene` legitimately fell back to Canvas2D and there is no
  // GL layer to sample — a documented capability path, not a defect, and the
  // shape CI's headless Firefox is in. Report the case as skipped rather than
  // failing; the runner separately requires that at least one engine really did
  // exercise the WebGL path, so this cannot degrade into a vacuous pass.
  const glCanvas = host.querySelector('canvas[style*="absolute"]') as HTMLCanvasElement | null;
  const gl = (glCanvas?.getContext('webgl2') ?? null) as WebGL2RenderingContext | null;
  if (!glCanvas || !gl) {
    scene.destroy();
    host.remove();
    return {
      name,
      renderMode,
      skipped: true,
      ink: -1,
      inkBelow: -1,
      completeAtFirstRender: null,
      uploads: -1,
      uploadsBeforeRepaint: -1,
      dirtyBeforeDecode: false,
      dirtyAfterDecode: false,
    };
  }

  // Record the atlas's decode state at the moment glyphs are first submitted:
  // if it is already decoded the case is not exercising the race.
  let completeAtFirstRender: boolean | null = null;
  let sawFirstSubmit = false;
  const pointRenderer = (scene as unknown as { pointRenderer: { addGlyph: unknown } })
    .pointRenderer;
  const realAddGlyph = (pointRenderer.addGlyph as (...args: unknown[]) => void).bind(pointRenderer);
  pointRenderer.addGlyph = (...args: unknown[]): void => {
    if (!sawFirstSubmit) {
      sawFirstSubmit = true;
      completeAtFirstRender = typeof image.complete === 'boolean' ? image.complete : null;
    }
    realAddGlyph(...args);
  };

  // Wait for the layout worker to reply, so the frame below really does submit
  // glyphs. Without this the first `step()` runs before layout exists,
  // `render()` early-returns on `!layoutResult`, and the atlas is never touched
  // while undecoded — the case then measures nothing (observed: the first
  // submit happened after the decode, reporting complete=true).
  // `sawFirstSubmit` is set by the submit callback the loop body triggers, not
  // reassigned in the loop itself — the rule cannot see that indirection.
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition
  for (let i = 0; i < 100 && !sawFirstSubmit; i++) {
    scene.step(16.67);
    if (sawFirstSubmit) break;
    await sleep(5);
  }

  // Render one frame so the entity submits glyphs against the undecoded atlas —
  // this is the frame that used to poison the identity cache.
  scene.step(16.67);
  // Consume the dirty flag, so anything observed as dirty after this point was
  // marked by the atlas decode and nothing else.
  scene.step(16.67);
  const dirtyBeforeDecode = scene.frameStats.dirty;

  // Wait for the atlas to land. rAF is NOT used to drive this: measured in
  // headless Chromium and Firefox the loop ran only 2 ticks in 550 ms, and
  // whether the second one fell after the decode was pure luck — that alone
  // made this gate pass with the repaint hook deleted. What the hook actually
  // promises is observable without a frame at all: the decode must mark the
  // scene dirty.
  await decoded;
  await sleep(60);
  const dirtyAfterDecode = scene.frameStats.dirty;

  // Uploads so far. Read BEFORE the post-decode frame, so it reflects only the
  // pre-decode frames: this must be 0, proving no empty texture was ever
  // committed. (An earlier version of this gate read it after a `step()` and so
  // counted that step's own upload.)
  const uploadsBeforeRepaint = scene.webglDrawStats?.atlasSwitches ?? -1;

  // Now render the frame the repaint request earns, which is also the only way
  // to read pixels: `preserveDrawingBuffer` is off and Chromium clears at
  // composite, so a rAF-time read reports 0 even for a correctly drawn frame.
  scene.step(16.67);
  const uploads = scene.webglDrawStats?.atlasSwitches ?? -1;

  // GL y is bottom-up. The text box is at (10,10) sized 3×FONT_SIZE wide by
  // roughly one line tall; sample it with a 1px inset, and a control strip
  // clear of the line's descent.
  const boxW = FONT_SIZE * TEXT.length;
  const boxTop = 10;
  const glTop = glCanvas.height - (boxTop + FONT_SIZE);
  const ink = countInk(gl, 11, glTop + 1, boxW - 2, FONT_SIZE - 2);
  const inkBelow = countInk(gl, 11, 4, boxW - 2, 12);

  const result: MsdfCaseResult = {
    name,
    renderMode,
    ink,
    inkBelow,
    skipped: false,
    completeAtFirstRender,
    uploads,
    uploadsBeforeRepaint,
    dirtyBeforeDecode,
    dirtyAfterDecode,
  };
  scene.destroy();
  host.remove();
  return result;
}

async function main(): Promise<void> {
  const cases: MsdfCaseResult[] = [];
  // Control: no decode to wait for, so this must paint under any implementation.
  cases.push(await runCase('canvasControl', 'always', -1));
  // The defect: a latent atlas in each render mode.
  cases.push(await runCase('networkAlways', 'always', 300));
  cases.push(await runCase('networkOnDemand', 'onDemand', 300));
  window.__msdfDecodeResult = { cases };
  window.__ready = true;
}

main().catch((error: unknown) => {
  window.__msdfDecodeError = error instanceof Error ? error.message : String(error);
  window.__ready = true;
});
