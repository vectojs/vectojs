/**
 * Parsed color as normalized `[r, g, b, a]` floats in `[0, 1]`.
 */
export type RGBA = [number, number, number, number];

const cache = new Map<string, RGBA>();
let fallbackCtx: CanvasRenderingContext2D | null | undefined;

function fromHex(hex: string): RGBA | null {
  const h = hex.slice(1);
  const n = h.length;
  if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return null;
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const short = n === 3 || n === 4;
  const hx = (i: number) => {
    const s = short ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2);
    return parseInt(s, 16) / 255;
  };
  const hasA = n === 4 || n === 8;
  return [hx(0), hx(1), hx(2), hasA ? hx(3) : 1];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function fromRgbFunc(css: string): RGBA | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(css.trim());
  if (!m) return null;
  // Modern syntax puts alpha after a slash (`r g b / a`); legacy uses a 4th
  // comma value. Channels may be comma- or whitespace-separated in either.
  const [rgbPart, alphaPart] = m[1].split('/');
  const parts = rgbPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const r = chan(parts[0]) / 255;
  const g = chan(parts[1]) / 255;
  const b = chan(parts[2]) / 255;
  const alphaToken = alphaPart !== undefined ? alphaPart.trim() : parts[3];
  const a =
    alphaToken === undefined
      ? 1
      : alphaToken.endsWith('%')
        ? parseFloat(alphaToken) / 100
        : parseFloat(alphaToken);
  if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
  // CSS (and Canvas2D) clamp out-of-range values; the WebGL path needs [0,1] too.
  return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
}

function fromCanvas(css: string): RGBA | null {
  if (typeof document === 'undefined') return null;
  if (!fallbackCtx) fallbackCtx = document.createElement('canvas').getContext('2d');
  if (!fallbackCtx) return null;
  fallbackCtx.fillStyle = css;
  fallbackCtx.fillRect(0, 0, 1, 1);
  const d = fallbackCtx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

/**
 * Parse a CSS color string into normalized `[r, g, b, a]` floats.
 *
 * Fast paths handle `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` and `rgb()`/`rgba()`;
 * other forms (named colors, `hsl()`, …) resolve via a cached 1×1 canvas when a
 * DOM is available. Results are cached per input string and shared by identity,
 * so callers must treat the returned array as read-only. Unparseable input with
 * no DOM yields opaque black `[0, 0, 0, 1]`.
 *
 * @param css - A CSS color string, e.g. `'#38bdf8'` or `'rgba(0,0,0,.5)'`.
 * @returns The cached `[r, g, b, a]` tuple in `[0, 1]`.
 */
export function parseColorToRGBA(css: string): RGBA {
  const hit = cache.get(css);
  if (hit) return hit;
  const trimmed = css.trim();
  const rgba = (trimmed[0] === '#' ? fromHex(trimmed) : null) ??
    fromRgbFunc(trimmed) ??
    fromCanvas(trimmed) ?? [0, 0, 0, 1];
  cache.set(css, rgba);
  return rgba;
}
