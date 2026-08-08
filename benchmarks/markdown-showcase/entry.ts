/**
 * The Markdown construct showcase: every supported construct, rendered by
 * VectoJS itself, under any of the five theme presets.
 *
 * Two jobs in one page, which is why it is here rather than in `vectojs-gallery`:
 *
 *   1. A markdown-it-demo-style surface a human can scroll to see the whole
 *      syntax surface at once, with a typographer toggle and a preset switcher.
 *   2. A DETERMINISTIC capture target for `capture-showcase.ts`. Every knob is
 *      also a URL parameter, so the capture driver can shoot one section under
 *      one preset with no interaction at all — a screenshot gate cannot depend
 *      on clicking a control, because a click that silently misses produces a
 *      valid-looking image of the wrong state.
 *
 * ONE CANVAS, deliberately. `benchmarks/screenshot-page.ts` documents an
 * unresolved grim capture defect (CTX-0198) where a page hosting more than one
 * canvas photographs blank while rendering correctly — verified byte-identical
 * backing stores. A two-canvas side-by-side source/rendered split would walk
 * straight into it, so the source pane is drawn by the same Scene, as ordinary
 * VectoJS text, into the same canvas.
 *
 * URL parameters:
 *
 *   `preset`       one of the five preset names, or `default`. Default `githubDark`.
 *   `typographer`  `1` to enable `theme.typographer`. Default off, matching the theme.
 *   `section`      a `corpus.ts` section id to render alone, or `all`. Default `all`.
 *   `source`       `1` to draw the Markdown source beside the rendered output.
 *   `chrome`       `0` to hide the interactive control strip, which a capture wants
 *                  gone so a hover state can never leak into a baseline image.
 *   `width`        rendered-column width in CSS px. Default 620.
 *
 * The page sets `document.title` to `… READY` once layout has settled, which is
 * the signal `screenshot-page.ts` already waits for.
 */
import { Scene } from '@vectojs/core';
import {
  isMathJaxReady,
  isPresetName,
  Markdown,
  preloadMathJax,
  PRESET_THEMES,
  type MarkdownTheme,
  type MarkdownThemePresetName,
} from '@vectojs/markdown';
import { Button, Stack, Text } from '@vectojs/ui';
import { SHOWCASE_SECTIONS, sectionById, type ShowcaseSection } from './corpus.ts';

const PRESETS: readonly string[] = [
  'default',
  'githubDark',
  'githubLight',
  'dracula',
  'solarizedDark',
  'solarizedLight',
];

/**
 * Page background per preset, and whether its chrome should read as light.
 *
 * `Scene` has no background-colour option and the canvas starts transparent, so
 * without this a light preset would paint dark-on-transparent over the page's
 * own dark `body` and be unreadable — the preset would look broken when it is
 * the surface that is wrong. Values are each palette's own canvas colour, taken
 * from the same upstream specs `markdown-presets.ts` cites.
 */
const SURFACES: Readonly<Record<string, { bg: string; chrome: string; light: boolean }>> = {
  default: { bg: '#0f172a', chrome: '#e2e8f0', light: false },
  githubDark: { bg: '#0d1117', chrome: '#e6edf3', light: false },
  githubLight: { bg: '#ffffff', chrome: '#24292f', light: true },
  dracula: { bg: '#282a36', chrome: '#f8f8f2', light: false },
  solarizedDark: { bg: '#002b36', chrome: '#839496', light: false },
  solarizedLight: { bg: '#fdf6e3', chrome: '#657b83', light: true },
};

const params = new URLSearchParams(location.search);
const presetParam = params.get('preset') ?? 'githubDark';
const preset = PRESETS.includes(presetParam) ? presetParam : 'githubDark';
const typographer = params.get('typographer') === '1';
const sectionParam = params.get('section') ?? 'all';
const showSource = params.get('source') === '1';
const showChrome = params.get('chrome') !== '0';
const columnWidth = Number(params.get('width') ?? 620);
/**
 * Cap on the backing-store pixel ratio, `1` by default.
 *
 * Pinned rather than inherited because this host runs at DPR 1.6, and a
 * fractional ratio is the wrong foundation for a pixel gate twice over: the
 * backing store is `logical x 1.6` so every crop rect needs a non-integer
 * scale and lands on a half-pixel, and the resulting rasterisation differs
 * between engines for reasons that have nothing to do with the constructs
 * being tested. `maxDPR` only ever caps the real ratio, so this cannot make a
 * capture SHARPER than the display — passing `dpr=2` on a DPR-1.6 panel still
 * yields 1.6. It exists to make the gate reproducible on any machine.
 */
const dprCap = Number(params.get('dpr') ?? 1);

const surface = SURFACES[preset] ?? SURFACES.default!;

const sections: readonly ShowcaseSection[] =
  sectionParam === 'all'
    ? SHOWCASE_SECTIONS
    : (() => {
        const found = sectionById(sectionParam);
        if (!found) throw new Error(`unknown section '${sectionParam}'`);
        return [found];
      })();

// Page surface. Set on the document rather than painted into the canvas because
// the canvas is transparent by design and a themed page has to agree with it.
document.documentElement.style.background = surface.bg;
document.body.style.background = surface.bg;
document.body.style.margin = '0';
document.body.style.colorScheme = surface.light ? 'light' : 'dark';

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);

const scene = new Scene(canvas, { disableWindowResize: true, maxDPR: dprCap });

/**
 * Theme passed to every `Markdown`: a preset name when that alone suffices, or
 * the preset's own object spread with the typographer flag added.
 *
 * The spread is not a style preference, it is the only correct shape. `theme`
 * accepts a preset NAME or a theme OBJECT, and `resolvePresetTheme` decides
 * which by calling `isPresetName` — a `typeof value === 'string'` check. So an
 * object like `{ preset, typographer }` fails that check, falls through to
 * `resolveTheme` as if it were a hand-written theme, and since it carries no
 * recognised colour keys, silently resolves to `DEFAULT_THEME`. Every preset
 * would appear to work with typographer off and revert to stock colours the
 * moment it was switched on.
 */
function markdownTheme(): MarkdownThemePresetName | MarkdownTheme {
  if (!isPresetName(preset)) return { typographer };
  if (!typographer) return preset;
  return { ...PRESET_THEMES[preset], typographer: true };
}

const CHROME_FONT = '600 13px sans-serif';
const LABEL_FONT = '600 15px sans-serif';
const SOURCE_FONT = '12px ui-monospace, monospace';

const PAD = 24;
const SECTION_GAP = 28;
const SOURCE_GAP = 24;
const sourceWidth = showSource ? 320 : 0;

const root = new Stack({ direction: 'vertical', gap: SECTION_GAP });
root.setPosition(PAD, PAD);
scene.add(root);

/**
 * The control strip. Buttons rather than a `Dropdown` for the preset switcher:
 * a dropdown's menu is an overlay that would need opening to be seen, and the
 * whole point of the strip is that the current state is legible in a still
 * image without any interaction.
 */
function buildChrome(): Stack {
  const strip = new Stack({ direction: 'vertical', gap: 10 });

  const heading = new Text('VectoJS Markdown construct showcase', {
    font: '700 20px sans-serif',
    color: surface.chrome,
    lineHeight: 26,
  });
  strip.add(heading);

  const state = new Text(
    `preset: ${preset}   ·   typographer: ${typographer ? 'on' : 'off'}   ·   section: ${sectionParam}`,
    { font: CHROME_FONT, color: surface.chrome, lineHeight: 18 },
  );
  strip.add(state);

  const navigate = (next: URLSearchParams): void => {
    location.search = next.toString();
  };

  const presetRow = new Stack({ direction: 'horizontal', gap: 8, align: 'center' });
  for (const name of PRESETS) {
    const active = name === preset;
    presetRow.add(
      new Button(name, {
        font: CHROME_FONT,
        padding: 8,
        radius: 6,
        bg: active ? '#2563eb' : 'rgba(127, 140, 160, 0.28)',
        hoverBg: active ? '#3b82f6' : 'rgba(127, 140, 160, 0.45)',
        color: surface.light && !active ? '#24292f' : '#ffffff',
        focusColor: surface.light ? '#0969da' : '#00f0ff',
        onClick: () => {
          const next = new URLSearchParams(location.search);
          next.set('preset', name);
          navigate(next);
        },
      }),
    );
  }
  strip.add(presetRow);

  const toggleRow = new Stack({ direction: 'horizontal', gap: 8, align: 'center' });
  toggleRow.add(
    new Button(typographer ? 'typographer: on' : 'typographer: off', {
      font: CHROME_FONT,
      padding: 8,
      radius: 6,
      bg: typographer ? '#2563eb' : 'rgba(127, 140, 160, 0.28)',
      hoverBg: typographer ? '#3b82f6' : 'rgba(127, 140, 160, 0.45)',
      color: surface.light && !typographer ? '#24292f' : '#ffffff',
      focusColor: surface.light ? '#0969da' : '#00f0ff',
      onClick: () => {
        const next = new URLSearchParams(location.search);
        if (typographer) next.delete('typographer');
        else next.set('typographer', '1');
        navigate(next);
      },
    }),
  );
  toggleRow.add(
    new Button(showSource ? 'source: shown' : 'source: hidden', {
      font: CHROME_FONT,
      padding: 8,
      radius: 6,
      bg: showSource ? '#2563eb' : 'rgba(127, 140, 160, 0.28)',
      hoverBg: showSource ? '#3b82f6' : 'rgba(127, 140, 160, 0.45)',
      color: surface.light && !showSource ? '#24292f' : '#ffffff',
      focusColor: surface.light ? '#0969da' : '#00f0ff',
      onClick: () => {
        const next = new URLSearchParams(location.search);
        if (showSource) next.delete('source');
        else next.set('source', '1');
        navigate(next);
      },
    }),
  );
  strip.add(toggleRow);

  return strip;
}

if (showChrome) root.add(buildChrome());

/** Every `Markdown` instance built, so readiness can await all of them. */
const rendered: Markdown[] = [];
/** Each section's outer Stack, kept so its settled rect can be published. */
const sectionBlocks: Array<{ id: string; block: Stack }> = [];

for (const section of sections) {
  const block = new Stack({ direction: 'vertical', gap: 10 });
  sectionBlocks.push({ id: section.id, block });

  block.add(
    new Text(section.title, {
      font: LABEL_FONT,
      color: surface.chrome,
      lineHeight: 20,
    }),
  );

  const row = new Stack({ direction: 'horizontal', gap: SOURCE_GAP, align: 'start' });

  const markdown = new Markdown(section.source, {
    maxWidth: columnWidth,
    theme: markdownTheme(),
    // Off for a capture target: affordance buttons add hover-sensitive chrome
    // whose state is not expressible in a URL, so a baseline could differ on
    // nothing but where the pointer happened to rest.
    blockAffordances: false,
    onLinkClick: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });
  rendered.push(markdown);

  if (showSource) {
    row.add(
      new Text(section.source, {
        font: SOURCE_FONT,
        color: surface.chrome,
        lineHeight: 17,
        maxWidth: sourceWidth,
        preserveLeadingSpaces: true,
      }),
    );
  }
  row.add(markdown);

  block.add(row);
  root.add(block);
}

/**
 * Size the canvas to the laid-out content.
 *
 * Content-sized rather than viewport-sized so a capture is not silently cropped
 * by the window: `screenshot-page.ts` crops to the WINDOW geometry, so anything
 * below the fold would simply be missing from a baseline image while the page
 * itself looked fine. Reporting the full height here lets the capture driver
 * size its viewport to fit instead.
 */
function layoutAndSize(): { width: number; height: number } {
  root.layout();
  const width = Math.ceil(PAD * 2 + Math.max(360, root.width));
  const height = Math.ceil(PAD * 2 + root.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  scene.resize(width, height);
  return { width, height };
}

let size = layoutAndSize();

/**
 * `scene.start()`, never `scene.step()`.
 *
 * Content projection is synced from the private rAF `loop()`, which `step()`
 * never reaches — `step()` calls `render()` and nothing else. A page driven by
 * `step()` therefore paints the canvas correctly while materializing ZERO DOM
 * carriers, so there is nothing for the browser to select and find-in-page has
 * no text to find. Measured on this page before the fix: `document.body.innerText`
 * was empty and the whole document held 6 elements. `selection-fidelity.fixture.ts`
 * records the same measurement from the other direction (0 nodes after two
 * `step()` calls, 7 after `start()`).
 *
 * A live loop also fixes the second, separate symptom: browser zoom changes the
 * device pixel ratio, which re-sizes and clears the backing store. With
 * `disableWindowResize: true` and no loop, nothing ever repainted it and the
 * page went permanently blank after a zoom.
 */
scene.start();

/** A section's settled rect in CSS px, relative to the canvas. */
export interface SectionRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    __showcase?: {
      preset: string;
      typographer: boolean;
      section: string;
      sections: string[];
      width: number;
      height: number;
      blocks: number;
      /**
       * Per-section rects, so a capture can be cropped to one construct group
       * from the backing store instead of from window geometry.
       *
       * Cropping matters for the gate rather than for looks: a single tall
       * image means any one construct's regression re-baselines every other
       * construct in the same file, and `screenshot-page.ts` crops to the
       * WINDOW, so a section below the fold is simply absent. Publishing the
       * rects lets the driver slice a full-page capture per section, keyed on
       * the same ids `corpus.ts` defines.
       */
      rects: SectionRect[];
    };
    __ready?: boolean;
  }
}

/** Absolute position of an entity within the canvas. */
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

function sectionRects(): SectionRect[] {
  return sectionBlocks.map(({ id, block }) => {
    const { x, y } = absolutePosition(block);
    return {
      id,
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.ceil(block.width),
      height: Math.ceil(block.height),
    };
  });
}

await document.fonts.ready;

/**
 * Typeset the math engine before anything is captured.
 *
 * `Markdown` loads `@vectojs/tex` through a dynamic `import()` the first time it
 * sees a formula, and until that resolves an inline `$x$` draws as LITERAL
 * SOURCE TEXT in `theme.mathFallbackColor` — the honest fallback, but not what
 * a showcase should photograph. Awaiting it here is what makes `$E = mc^2$`
 * render as a formula instead of a gold `$E = mc^2$`.
 *
 * `corpus.ts` claimed inline math was safe because it was "synchronous". That
 * was wrong: inline and block math share this one lazy path, and the only thing
 * inline math avoids is the extra async raster step. Block `$$` stays out of the
 * corpus for a different reason (its height changes after typeset, moving every
 * rect below it), not because of readiness.
 *
 * `preloadMathJax` keeps its historical name; it means "the math engine",
 * whichever one that is — today `@vectojs/tex`, not MathJax.
 */
await preloadMathJax();
if (!isMathJaxReady()) {
  throw new Error('math engine did not become ready; a capture would show literal source');
}
// The engine resolving re-typesets from tokens asynchronously, so give the
// scene's own loop frames to apply it before any geometry is read.
for (let frame = 0; frame < 3; frame++) {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

// Fonts and math both settled: re-layout once more and only then publish a size
// and rects the capture driver is allowed to trust.
size = layoutAndSize();
await new Promise((resolve) => requestAnimationFrame(resolve));

const state = {
  preset,
  typographer,
  section: sectionParam,
  sections: sections.map((s) => s.id),
  width: size.width,
  height: size.height,
  blocks: rendered.reduce((total, md) => total + md.content.children.length, 0),
  rects: sectionRects(),
};
window.__showcase = state;
window.__ready = true;
document.title = `markdown-showcase ${preset} READY`;

/**
 * Crop one section out of the canvas backing store as a PNG data URL.
 *
 * Read from the backing store rather than photographed from the window because
 * the backing store is what the engine actually drew: no compositor, no output
 * scale (this host runs 1.6x), no window decoration. That is what makes a byte
 * comparison meaningful — a grim capture of the same content differs run to run
 * on things that are not the rendering.
 *
 * `drawImage` from the source canvas rather than `getImageData` + `putImageData`
 * so the DPR scaling is handled by the draw itself: the backing store is
 * `logical x dpr` while the published rects are in CSS px, and multiplying the
 * source rect by `dpr` keeps the crop aligned without the caller doing pixel
 * arithmetic. At the pinned `dpr=1` the two coincide, but the page accepts a
 * `dpr` override and a crop that silently ignored it would be wrong rather than
 * merely coarse.
 */
function cropSection(rect: SectionRect): string {
  const dpr = canvas.width / size.width;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.width * dpr));
  out.height = Math.max(1, Math.round(rect.height * dpr));
  const context = out.getContext('2d');
  if (!context) throw new Error('no 2D context for the crop canvas');
  // Paint the preset's own surface colour FIRST, then composite the canvas over
  // it. The engine's canvas is transparent by design and the page surface is a
  // DOM background, so a raw crop carries no background at all — which breaks
  // the gate in two ways that the first recorded baselines showed directly:
  // a surface/background regression is invisible to a pixel comparison, and
  // the light presets' contrast pass on translucent overlays (`codeBgColor`,
  // `containerBgColor`, `markHighlightColor` — the whole reason those presets
  // deviate from their upstream hex) cannot be verified at all, because a
  // translucent fill over nothing composites against nothing. It also makes
  // the image legible as evidence instead of dark-on-transparent.
  context.fillStyle = surface.bg;
  context.fillRect(0, 0, out.width, out.height);
  context.drawImage(
    canvas,
    Math.round(rect.x * dpr),
    Math.round(rect.y * dpr),
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  );
  return out.toDataURL('image/png');
}

/**
 * Non-transparent pixel count in a horizontal band of the backing store.
 *
 * The gate's own precondition: a crop is only meaningful once the canvas has
 * actually been painted. Reading `state.rects` or `__ready` does not establish
 * that — those describe LAYOUT, which settles well before the first frame is
 * drawn.
 */
function paintedPixels(): number {
  const context = canvas.getContext('2d');
  if (!context) return 0;
  const band = Math.min(canvas.height, 400);
  const { data } = context.getImageData(0, 0, canvas.width, band);
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) painted++;
  }
  return painted;
}

/**
 * Wait until the scene's loop has actually painted, or give up and say so.
 *
 * Necessary because `scene.start()` renders from rAF, and rAF is throttled in a
 * window Chrome opens in the BACKGROUND — which is what happens for every
 * preset after the first, since the driver reuses one browser profile and each
 * new window lands behind the existing one. Measured directly: the first preset
 * produced a 57,258-byte crop while the next five produced ~4,200-byte
 * single-colour images, all of them reporting a correct 34 blocks and correct
 * rects. Layout was right; nothing had been drawn yet.
 *
 * Polling the backing store rather than counting frames because the number of
 * frames needed is exactly what varies here: an unthrottled window needs one,
 * a background one may need many, and `requestAnimationFrame` may not fire at
 * all until the window is focused. `markDirty()` on each attempt so a scene
 * that has already settled (`renderMode: 'onDemand'` throttles a static scene)
 * still has a reason to repaint.
 */
async function awaitFirstPaint(timeoutMs = 20_000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const painted = paintedPixels();
    if (painted > 0) return painted;
    if (performance.now() > deadline) return 0;
    scene.markDirty();
    // Use setTimeout, NOT requestAnimationFrame. rAF is throttled to ~1Hz or
    // suspended entirely in a background window (one Chrome opens behind the
    // existing foreground one), so waiting on rAF here is equivalent to a
    // 20-second sleep before the driver finally focuses the new window and rAF
    // resumes. setTimeout fires regardless of visibility, so this loop keeps
    // spinning until the driver calls focusWindow() and the first rAF frame
    // draws — at which point paintedPixels() returns > 0 on the next iteration.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// `capture=1` is the screenshot gate's entry point: crop every section and POST
// the lot to the benchmark server, which already writes a JSON body to disk.
// Done here rather than over CDP/BiDi so the driver needs exactly one
// browser-control mechanism (the Hyprland launch it already owns) instead of two.
if (params.get('capture') === '1') {
  const painted = await awaitFirstPaint();
  if (painted === 0) {
    // Fail loudly rather than posting blank crops. A silently blank baseline is
    // the worst outcome available: it is a valid PNG that every later run
    // reproduces, so the gate goes green while testing nothing.
    throw new Error('canvas never painted before capture; refusing to post blank crops');
  }
  const crops: Record<string, string> = {};
  for (const rect of state.rects) crops[rect.id] = cropSection(rect);
  await fetch('/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `name`/`engine`/`runId` are what the server keys the filename on; the
    // driver reads `showcase` and `crops`.
    body: JSON.stringify({
      name: 'markdown-showcase',
      engine: navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome',
      runId: params.get('runId') ?? `manual-${Date.now().toString(36)}`,
      showcase: state,
      crops,
    }),
  });
  document.title = `markdown-showcase ${preset} CAPTURED`;
}
