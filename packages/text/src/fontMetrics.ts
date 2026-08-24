import { MSDFFont, type MSDFFontData } from './MSDFFont';

/**
 * A DOM-free source of font metrics for one family.
 *
 * Every measurement path in the framework prefers a real Canvas 2D context when
 * one exists, because that measures what the renderer will actually draw. This
 * interface is the fallback for environments that have no canvas at all — Node
 * SSR, a worker without `OffscreenCanvas`, a test runner — where the only
 * alternative is a flat `0.5em` guess per glyph.
 *
 * All values are in em units, so one registration serves every font size.
 */
export interface FontMetricsSource {
  /**
   * Horizontal advance of `char` in em units, or `undefined` when this source
   * has nothing for it (the caller then falls back).
   *
   * `char` is a grapheme, which may be an astral codepoint (a surrogate pair) or
   * a base plus combining marks. An implementation that only knows single
   * codepoints should measure the first one.
   */
  advanceEm(char: string): number | undefined;
  /**
   * Advance of a whole string in em units, honoring kerning if the source has
   * it. Optional: callers that need it fall back to summing {@link advanceEm}
   * when absent, which is correct but drops kerning.
   */
  measureEm?(text: string): number | undefined;
  /** Distance from baseline to the top of the em box, em units, positive up. */
  ascenderEm?: number;
  /** Distance from baseline to the bottom, em units, negative down. */
  descenderEm?: number;
}

/**
 * Normalize a CSS family name for lookup: case-insensitive, quotes stripped.
 *
 * A CSS shorthand's family portion may be quoted (`'"Noto Sans", sans-serif'`)
 * and is case-insensitive per CSS, so `Noto Sans` and `noto sans` must hit the
 * same registration. Only the FIRST family in a list is used — a fallback chain
 * is a renderer concern, and this registry answers "what are this family's
 * metrics", not "which family will the renderer pick".
 */
function normalizeFamily(family: string): string {
  const first = family.split(',')[0] ?? family;
  return first
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

const sources = new Map<string, FontMetricsSource>();
let version = 0;

/**
 * A counter bumped on every registration change.
 *
 * Lets a consumer cache a resolved {@link FontMetricsSource} and re-resolve only
 * when this changes, instead of re-normalizing a family name on every glyph.
 * Caching a source without checking this pins whichever source happened to be
 * registered at the time, so a later replacement is silently ignored.
 */
export function fontMetricsVersion(): number {
  return version;
}

/**
 * Register a DOM-free metrics source for one CSS font family.
 *
 * Call this once at startup in an environment without a canvas, before laying
 * out any text. In a browser this is harmless but has no effect on measurement:
 * a real canvas context always wins, so registering cannot change what a
 * browser draws.
 *
 * @param family - CSS family name, e.g. `'Noto Sans'`. Matched
 *   case-insensitively with quotes stripped; a comma-separated list registers
 *   only its first family.
 * @param source - The metrics source. Registering the same family twice
 *   replaces the previous source.
 */
export function registerFontMetrics(family: string, source: FontMetricsSource): void {
  sources.set(normalizeFamily(family), source);
  version++;
}

/**
 * Register an `msdf-atlas-gen` font as the metrics source for a family.
 *
 * The atlas image is irrelevant here — only the JSON's `glyphs[].advance`,
 * `kerning`, and `metrics` are read, so a metrics-only JSON works and nothing
 * needs to decode.
 *
 * @param family - CSS family name to answer for.
 * @param font - A parsed {@link MSDFFont}, or the raw JSON / parsed data.
 */
export function registerMSDFFontMetrics(
  family: string,
  font: MSDFFont | MSDFFontData | string,
): void {
  const resolved = font instanceof MSDFFont ? font : MSDFFont.parse(font);
  registerFontMetrics(family, createMSDFMetricsSource(resolved));
}

/**
 * Build a {@link FontMetricsSource} from a loaded {@link MSDFFont}.
 *
 * Public API status: exported and documented on purpose — it is the supported
 * way to turn an `MSDFFont` into a registrable metrics source
 * (`registerFontMetrics(family, createMSDFMetricsSource(font))`), and unlike
 * {@link createCanvasMeasurer} it never returns `null`: an MSDF font is parsed
 * JSON, so it is available wherever the JSON is.
 */
export function createMSDFMetricsSource(font: MSDFFont): FontMetricsSource {
  const m = font.data.metrics;
  return {
    advanceEm(char: string): number | undefined {
      const code = char.codePointAt(0);
      if (code === undefined) return undefined;
      return font.getGlyph(code)?.advance;
    },
    // MSDFFont.layout already walks kerning pairs and honors combining marks, so
    // measuring at 1px yields the em advance directly. This is the only path
    // that can apply kerning: the per-glyph GlyphMeasurer contract is
    // measure(char, size, family), which has no neighbouring character to kern
    // against.
    measureEm(text: string): number | undefined {
      if (text === '') return 0;
      return font.layout(text, 1).width;
    },
    ascenderEm: m.ascender,
    descenderEm: m.descender,
  };
}

/**
 * Look up the registered metrics source for a family, or `undefined`.
 *
 * @param family - CSS family name or shorthand family portion.
 */
export function getFontMetrics(family: string): FontMetricsSource | undefined {
  return sources.get(normalizeFamily(family));
}

/**
 * True when any metrics source is registered.
 *
 * Public API status: exported on purpose as a cheap probe of the process-wide
 * registry — a caller about to register fonts can short-circuit, and tests use
 * it to assert isolation. No in-repo production caller today; if that is still
 * true at the next major, this (with the whole registry API) is a candidate
 * for unexport rather than silent growth.
 */
export function hasFontMetrics(): boolean {
  return sources.size > 0;
}

/**
 * Drop every registration. Intended for test isolation — the registry is
 * process-wide, so a test that registers a font would otherwise leak into the
 * next one.
 */
export function clearFontMetrics(): void {
  sources.clear();
  version++;
}
