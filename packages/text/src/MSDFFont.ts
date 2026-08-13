/**
 * MSDF (Multi-channel Signed Distance Field) font support.
 *
 * Parses the `msdf-atlas-gen` JSON layout — the de-facto MSDF format produced by
 * Chlumsky's `msdf-atlas-gen` / `msdfgen` — and lays a string out into textured
 * quads positioned in CSS pixels with atlas UVs. Pair {@link MSDFFont.layout}
 * with the WebGL backend's `setMSDFTexture` + `addGlyph` to render GPU text that
 * stays crisp at any scale (and supports outline/glow in the shader).
 *
 * Geometry conventions match the renderer: local space is y-down, top-left
 * origin; UVs use v=0 at the top of the atlas image (atlas uploaded without a
 * Y-flip, the same as `setTexture`/`addSprite`).
 */

/** Atlas section of an `msdf-atlas-gen` JSON file. */
export interface MSDFAtlasInfo {
  /** Field type, e.g. `'msdf'` | `'mtsdf'` | `'sdf'`. */
  type: string;
  /** Distance field range in atlas pixels — drives the shader's edge sharpness. */
  distanceRange: number;
  /** Glyph size the atlas was rasterized at (em → px), informational. */
  size: number;
  /** Atlas image width in pixels. */
  width: number;
  /** Atlas image height in pixels. */
  height: number;
  /** Whether `atlasBounds` are measured from the image bottom or top. */
  yOrigin: 'bottom' | 'top';
}

/** Font-wide metrics in em units. */
export interface MSDFMetrics {
  emSize: number;
  /** Line advance in em (multiply by font size for px). */
  lineHeight: number;
  /** Distance from baseline to the top of the line in em (positive, up). */
  ascender: number;
  /** Distance from baseline to the bottom in em (negative, down). */
  descender: number;
  underlineY?: number;
  underlineThickness?: number;
}

/** Em-unit / atlas-pixel rectangle as emitted by `msdf-atlas-gen`. */
export interface MSDFBounds {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** One glyph's metrics. Whitespace has `advance` but no plane/atlas bounds. */
export interface MSDFGlyphDef {
  unicode: number;
  /** Horizontal advance in em units. */
  advance: number;
  /** Quad position relative to the baseline, em units, y-up. */
  planeBounds?: MSDFBounds;
  /** Source rectangle in the atlas, pixels. */
  atlasBounds?: MSDFBounds;
}

/** Kerning pair adjustment in em units. */
export interface MSDFKerning {
  unicode1: number;
  unicode2: number;
  advance: number;
}

/** A parsed `msdf-atlas-gen` JSON document. */
export interface MSDFFontData {
  atlas: MSDFAtlasInfo;
  metrics: MSDFMetrics;
  glyphs: MSDFGlyphDef[];
  kerning?: MSDFKerning[];
}

/** A glyph positioned for rendering: a CSS-pixel quad + atlas UVs (0..1). */
export interface PositionedGlyph {
  /** Source character (may be a surrogate-pair astral codepoint). */
  char: string;
  /** Quad top-left in local CSS pixels (y-down). */
  x: number;
  y: number;
  /** Quad size in CSS pixels. */
  w: number;
  h: number;
  /** Atlas UVs: `(u0,v0)` top-left, `(u1,v1)` bottom-right; v=0 is the atlas top. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Result of {@link MSDFFont.layout}. */
export interface MSDFLayoutResult {
  glyphs: PositionedGlyph[];
  /** Total pen advance of the widest line in CSS pixels. */
  width: number;
  /** `lineCount × lineHeight × fontSize` in CSS pixels. */
  height: number;
}

/** Options for {@link MSDFFont.layout}. */
export interface MSDFLayoutOptions {
  /** Pen origin x (left of the first glyph), CSS pixels. Default 0. */
  x?: number;
  /** Text-block top y (baseline of line 0 = `y + ascender×size`). Default 0. */
  y?: number;
  /** Extra advance added after every glyph, CSS pixels. Default 0. */
  letterSpacing?: number;
}

/** Pack two codepoints into one number key for the kerning map. */
function kernKey(a: number, b: number): number {
  return a * 0x110000 + b;
}

/**
 * Whether `code` is a nonspacing combining mark (Unicode general category Mn) —
 * a diacritic that must stack over its base glyph and advance the pen by ZERO.
 * MSDF layout has no GPOS mark attachment, so the best it can do is not advance
 * (the mark then paints at the base glyph's origin instead of beside it); some
 * atlases nonetheless report a nonzero advance for these, which would render
 * `é` (e + U+0301) as two side-by-side glyphs.
 *
 * Kept as an explicit range list rather than a `\p{Mn}` regex so it stays cheap
 * in the per-glyph loop, and mirrors the combining ranges `@vectojs/layout`'s
 * `isComplexScript` already recognizes (this package is a leaf — it must not
 * depend on layout).
 */
function isNonspacingMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x0483 && code <= 0x0489) || // combining Cyrillic
    (code >= 0x0591 && code <= 0x05bd) || // Hebrew points
    (code >= 0x0610 && code <= 0x061a) || // Arabic marks
    (code >= 0x064b && code <= 0x065f) || // Arabic vowel marks
    (code >= 0x0e31 && code <= 0x0e3a) || // Thai vowels/tones
    (code >= 0x1ab0 && code <= 0x1aff) || // combining diacritical marks extended
    (code >= 0x1dc0 && code <= 0x1dff) || // combining diacritical marks supplement
    (code >= 0x20d0 && code <= 0x20f0) || // combining marks for symbols
    (code >= 0xfe20 && code <= 0xfe2f) // combining half marks
  );
}

/**
 * A loaded MSDF font. Construct from parsed {@link MSDFFontData}, or use
 * {@link MSDFFont.parse} to read the JSON string straight from `msdf-atlas-gen`.
 */
export class MSDFFont {
  private static idCounter = 0;
  public readonly id: string;
  readonly data: MSDFFontData;
  private readonly byCode = new Map<number, MSDFGlyphDef>();
  private readonly kern = new Map<number, number>();
  /**
   * Advance (em) used for a codepoint the atlas has no glyph for, so missing
   * glyphs leave a gap instead of collapsing the rest of the line. Prefers the
   * font's own space advance, then `.notdef`, then a 0.5em default.
   */
  private readonly missingAdvance: number;

  constructor(data: MSDFFontData) {
    this.id = `font-${MSDFFont.idCounter++}`;
    this.data = data;
    for (const g of data.glyphs) this.byCode.set(g.unicode, g);
    for (const k of data.kerning ?? []) this.kern.set(kernKey(k.unicode1, k.unicode2), k.advance);
    this.missingAdvance = this.byCode.get(0x20)?.advance ?? this.byCode.get(0)?.advance ?? 0.5;
  }

  /** Parse the `msdf-atlas-gen` JSON (string or already-parsed object). */
  static parse(json: string | MSDFFontData): MSDFFont {
    return new MSDFFont(typeof json === 'string' ? (JSON.parse(json) as MSDFFontData) : json);
  }

  /** Get a glyph's definition by its unicode value in O(1) time. */
  getGlyph(unicode: number): MSDFGlyphDef | undefined {
    return this.byCode.get(unicode);
  }

  /** Distance field range in atlas pixels (for the shader's `u_distanceRange`). */
  get distanceRange(): number {
    return this.data.atlas.distanceRange;
  }

  get atlasWidth(): number {
    return this.data.atlas.width;
  }

  get atlasHeight(): number {
    return this.data.atlas.height;
  }

  /**
   * Lay `text` out at `fontSizePx`. Returns positioned quads (skipping glyphs the
   * font doesn't contain), the widest line's advance, and the total block height.
   * Honors `\n`, kerning pairs, and `letterSpacing`.
   */
  layout(text: string, fontSizePx: number, opts: MSDFLayoutOptions = {}): MSDFLayoutResult {
    const { x = 0, y = 0, letterSpacing = 0 } = opts;
    const { width: aw, height: ah, yOrigin } = this.data.atlas;
    const { lineHeight, ascender } = this.data.metrics;

    const glyphs: PositionedGlyph[] = [];
    let penX = x;
    let line = 0;
    let maxAdvance = 0;
    let prevCode = -1;

    const chars = Array.from(text); // codepoint-aware (astral-safe)
    for (const char of chars) {
      if (char === '\n') {
        maxAdvance = Math.max(maxAdvance, penX - x);
        penX = x;
        line++;
        prevCode = -1;
        continue;
      }
      const code = char.codePointAt(0)!;
      const def = this.byCode.get(code);
      if (!def) {
        // No glyph in the atlas (e.g. CJK in a Latin-only font). Skipping the
        // advance entirely would pull every following glyph left and under-report
        // `width`, silently corrupting the layout; advance by a sensible
        // substitute instead so the rest of the line stays in place. A
        // nonspacing mark still advances zero — it never occupies width.
        if (!isNonspacingMark(code)) {
          penX += this.missingAdvance * fontSizePx + letterSpacing;
        }
        prevCode = -1;
        continue;
      }
      if (prevCode >= 0) {
        const k = this.kern.get(kernKey(prevCode, code));
        if (k) penX += k * fontSizePx;
      }

      const baseline = y + (ascender + line * lineHeight) * fontSizePx;
      const pb = def.planeBounds;
      const ab = def.atlasBounds;
      if (pb && ab) {
        const v0 = yOrigin === 'bottom' ? 1 - ab.top / ah : ab.top / ah;
        const v1 = yOrigin === 'bottom' ? 1 - ab.bottom / ah : ab.bottom / ah;
        glyphs.push({
          char,
          x: penX + pb.left * fontSizePx,
          y: baseline - pb.top * fontSizePx,
          w: (pb.right - pb.left) * fontSizePx,
          h: (pb.top - pb.bottom) * fontSizePx,
          u0: ab.left / aw,
          v0,
          u1: ab.right / aw,
          v1,
        });
      }
      // A nonspacing mark must not move the pen (it stacks on the base glyph),
      // even if the atlas reports an advance for it — otherwise `é` (e + U+0301)
      // lays out as two glyphs side by side. Its quad is still emitted above.
      // It must not replace the kerning base either: `prevCode` stays on the
      // base glyph, so the kern pair (base → next) still applies across the
      // mark — kerning is defined between spacing glyphs, never through one.
      if (!isNonspacingMark(code)) {
        penX += def.advance * fontSizePx + letterSpacing;
        prevCode = code;
      }
    }

    maxAdvance = Math.max(maxAdvance, penX - x);
    return {
      glyphs,
      width: maxAdvance,
      height: (line + 1) * lineHeight * fontSizePx,
    };
  }
}
