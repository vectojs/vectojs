/**
 * Runtime access to the generated glyph outline table.
 *
 * The table is produced at build time by `scripts/generate-glyphs.ts`, which
 * reads the KaTeX TTFs directly and emits SVG path data. Only the table ships;
 * the extractor and the TTFs do not.
 *
 * The full table for all 20 faces is 1 214 552 bytes — *larger* than the
 * 513 664 bytes of TTF it came from, because SVG path text is a much less
 * compact encoding than `glyf`. That is the whole reason a whitelist is
 * mandatory rather than an optimisation: shipping every outline would be worse
 * than shipping the fonts. `scripts/subset-glyphs.ts` writes the subset that is
 * actually imported here.
 */

// The **subset** ships, not the full table. `glyphs.json` carries all 20 faces
// at 1 216 272 bytes; `glyphs.subset.json` carries only what the corpus in
// `scripts/subset-glyphs.ts` demands. Importing the full table here would put
// every outline in the bundle and undo the entire size argument.
import tableJson from '../glyphs/glyphs.subset.json' with { type: 'json' };
import type { FontName } from './fonts';

export interface Glyph {
  /** SVG path data in font units, y-up. */
  path: string;
  /** Advance width in font units. */
  advance: number;
}

interface GlyphTable {
  unitsPerEm: Record<string, number>;
  glyphs: Record<string, Record<string, Glyph>>;
}

// All 20 KaTeX faces are 1000 units/em, verified across the whole set by
// `generate-glyphs.ts`. Kept as a constant so a future face with a different
// grid is a loud failure rather than silent misplacement.
export const UNITS_PER_EM = 1000;

const table = tableJson as unknown as GlyphTable;

/**
 * Returns the outline for a codepoint in a face, or `undefined` when the glyph
 * is outside the shipped whitelist.
 *
 * A miss is not an error: the caller records it and degrades, which is the
 * documented fallback for symbols outside the whitelist.
 */
export function getGlyph(font: FontName | string, code: number): Glyph | undefined {
  return table.glyphs[font]?.[String(code)];
}

/** Units per em for a face. Every shipped face is 1000. */
export function unitsPerEm(font: FontName | string): number {
  return table.unitsPerEm[font] ?? UNITS_PER_EM;
}

/** Every face present in the shipped table. */
export function shippedFonts(): string[] {
  return Object.keys(table.glyphs);
}

/** Total glyph count in the shipped table, for size reporting. */
export function shippedGlyphCount(): number {
  let n = 0;
  for (const font of Object.keys(table.glyphs)) {
    n += Object.keys(table.glyphs[font]).length;
  }
  return n;
}
