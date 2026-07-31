import { Scene, SVGEntity } from '../src/index';

declare global {
  interface Window {
    __ready?: boolean;
    __svgFallbackResult?: SvgFallbackBrowserResult;
    __svgFallbackError?: string;
  }
}

/**
 * What one `SVGEntity` produced on a real canvas.
 *
 * `ink` is the count of non-transparent pixels inside the entity's own box, so
 * it is the only field that can distinguish "drew something" from "reserved a
 * box and drew nothing". Every other field here is layout or internal state,
 * which is exactly the kind of assertion that passed while inline math shipped
 * an invisible formula (CTX-0152).
 */
export interface SvgCaseResult {
  /** Case name, matching the source shape under test. */
  name: string;
  /** Entity box width, from the parsed SVG dimensions. */
  width: number;
  /** Entity box height. */
  height: number;
  /** Whether an `ImageBitmap` was produced, i.e. the source genuinely rasterized. */
  hasBitmap: boolean;
  /** Non-transparent pixels inside the box (1px inset per side). */
  ink: number;
  /** Non-transparent pixels in an untouched strip below the box. */
  inkBelow: number;
  /**
   * `[r,g,b,a]` at the centre of the box.
   *
   * Required because ink COUNT cannot tell repaired artwork from a fallback
   * marker: a solid-fill test rect and a full-box fallback fill cover the same
   * pixels and so produce identical counts. Measured — Firefox reported
   * `ink === valid.ink` while drawing the fallback. Only the colour separates
   * them.
   */
  centre: [number, number, number, number];
}

/** All cases plus the engine that produced them. */
export interface SvgFallbackBrowserResult {
  cases: SvgCaseResult[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Sources chosen from a measured survey of failure modes (CTX-0153). The three
 * groups must behave differently, and conflating them is the bug this guards:
 *
 * - `valid` / `viewboxOnly`: rasterize normally.
 * - `missingXmlns`: well-formed XML with correct dimensions whose *image
 *   decoder* rejects the blob. Repaired by declaring the namespace, so it must
 *   paint the real artwork (bitmap present), NOT a fallback marker.
 * - `malformed`: genuinely undecodable. Must paint the fallback marker
 *   (no bitmap) rather than leaving a blank box.
 */
const CASES: ReadonlyArray<{ name: string; svg: string }> = [
  {
    name: 'valid',
    svg: `<svg xmlns="${SVG_NS}" width="80" height="60"><rect width="80" height="60" fill="#00c000"/></svg>`,
  },
  {
    name: 'missingXmlns',
    svg: '<svg width="80" height="60"><rect width="80" height="60" fill="#00c000"/></svg>',
  },
  {
    name: 'malformed',
    svg: '<svg width="80" height="60"><<<>>> not xml at all',
  },
  {
    name: 'viewboxOnly',
    svg: `<svg xmlns="${SVG_NS}" viewBox="0 0 40 30"><rect width="40" height="30" fill="#0000ff"/></svg>`,
  },
];

/** Count pixels with meaningful alpha in a rect, inset to avoid edge antialiasing. */
function inkIn(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): number {
  const context = canvas.getContext('2d');
  if (!context || w <= 2 || h <= 2) return -1;
  const data = context.getImageData(
    Math.round(x) + 1,
    Math.round(y) + 1,
    Math.round(w) - 2,
    Math.round(h) - 2,
  ).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) count++;
  }
  return count;
}

/** Read one pixel at the centre of a rect. */
function centreOf(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number] {
  const context = canvas.getContext('2d');
  if (!context || w <= 0 || h <= 0) return [0, 0, 0, 0];
  const d = context.getImageData(Math.round(x + w / 2), Math.round(y + h / 2), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

async function run(): Promise<SvgFallbackBrowserResult> {
  const mounted = CASES.map((testCase) => {
    // One canvas per case so ink counts cannot bleed between them.
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 160;
    document.body.appendChild(canvas);

    const scene = new Scene(canvas, { disableWindowResize: true });
    const entity = new SVGEntity(testCase.svg);
    entity.setPosition(10, 10);
    scene.add(entity);
    return { name: testCase.name, scene, canvas, entity };
  });

  // Rasterization is async (Blob -> Image -> createImageBitmap). Step every
  // scene each frame so a slow engine cannot be mistaken for a blank box.
  for (let frame = 0; frame < 150; frame++) {
    for (const item of mounted) item.scene.step(16.67);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }

  return {
    cases: mounted.map((item) => ({
      name: item.name,
      width: item.entity.width,
      height: item.entity.height,
      hasBitmap: item.entity.hasRasterBitmap(),
      ink: inkIn(item.canvas, item.entity.x, item.entity.y, item.entity.width, item.entity.height),
      // A strip well below the box must stay empty; if it has ink, the sample
      // region is wrong and every positive count above is meaningless.
      inkBelow: inkIn(item.canvas, item.entity.x, item.entity.y + item.entity.height + 10, 60, 30),
      centre: centreOf(
        item.canvas,
        item.entity.x,
        item.entity.y,
        item.entity.width,
        item.entity.height,
      ),
    })),
  };
}

run()
  .then((result) => {
    window.__svgFallbackResult = result;
    window.__ready = true;
  })
  .catch((error: unknown) => {
    window.__svgFallbackError = error instanceof Error ? error.message : String(error);
    window.__ready = true;
  });
