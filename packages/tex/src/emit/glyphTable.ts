/**
 * Runtime access to the generated glyph outline table.
 *
 * The table is produced at build time from the KaTeX TTFs by
 * `scripts/generate-glyphs.ts`, subset against a corpus by
 * `scripts/subset-glyphs.ts`, and encoded into its shipping form by
 * `scripts/encode-glyphs.ts`. Only the encoded table ships; the extractor, the
 * intermediate JSON and the TTFs do not.
 *
 * ## Why the table is binary
 *
 * Phase 1 shipped this as JSON holding expanded SVG path text. That measured
 * 138 763 of the engine's 186 778 gzip bytes — **74% of the whole payload** — and
 * cross-encoding the identical 561-glyph whitelist as a subset TTF showed roughly
 * 60 KB of it was pure encoding overhead.
 *
 * The table is now the compact binary format in `./glyphCodec`, carried as base64
 * in a generated module. Measured on the identical glyph set: **135.5 KB gzip
 * before, 78.8 KB after**, which is 58% of the previous cost and better than a
 * subset TTF, because the format drops the 5 256 implied on-curve midpoints that
 * a TTF still stores.
 *
 * A whitelist remains mandatory regardless of encoding: the full table for all 20
 * faces is far larger than the TTFs it came from, so shipping every outline would
 * be worse than shipping the fonts.
 */

// The **subset** ships, not the full table. Importing the full table here would
// put every outline in the bundle and undo the entire size argument.
//
// This is a generated module holding a base64 string rather than a JSON import.
// A JSON import would be parsed into a full object graph at module load; a base64
// string is decoded to bytes once and expanded per glyph on demand, so a document
// using twenty glyphs pays for twenty path strings rather than 561.
import { GLYPH_TABLE_BASE64 } from '../glyphs/glyphs.subset';
import type { FontName } from './fonts';
import { base64ToBytes, GlyphTable } from './glyphCodec';

export interface Glyph {
  /** SVG path data in font units, y-up. */
  path: string;
  /** Advance width in font units. */
  advance: number;
}

// All 20 KaTeX faces are 1000 units/em, verified across the whole set by
// `generate-glyphs.ts`. Kept as a constant so a future face with a different
// grid is a loud failure rather than silent misplacement.
export const UNITS_PER_EM = 1000;

/**
 * The decoded table, built on first use.
 *
 * Deferred rather than built at module scope so that importing this module does
 * not cost the base64 decode and index pass in a bundle that never typesets
 * math. The index pass reads only counts, advances and codepoints — it decodes no
 * outlines — so the cost of the first access is small and bounded.
 */
let table: GlyphTable | undefined;

function getTable(): GlyphTable {
  table ??= new GlyphTable(base64ToBytes(GLYPH_TABLE_BASE64));
  return table;
}

/**
 * Returns the outline for a codepoint in a face, or `undefined` when the glyph
 * is outside the shipped whitelist.
 *
 * A miss is not an error: the caller records it and degrades, which is the
 * documented fallback for symbols outside the whitelist.
 */
export function getGlyph(font: FontName | string, code: number): Glyph | undefined {
  return getTable().get(font, code);
}

/** Units per em for a face. Every shipped face is 1000. */
export function unitsPerEm(font: FontName | string): number {
  return getTable().unitsPerEm(font) ?? UNITS_PER_EM;
}

/** Every face present in the shipped table. */
export function shippedFonts(): string[] {
  return getTable().fonts();
}

/** Total glyph count in the shipped table, for size reporting. */
export function shippedGlyphCount(): number {
  return getTable().glyphCount();
}
