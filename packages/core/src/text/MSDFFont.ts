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
 * A loaded MSDF font. Construct from parsed {@link MSDFFontData}, or use
 * {@link MSDFFont.parse} to read the JSON string straight from `msdf-atlas-gen`.
 */
export class MSDFFont {
  readonly data: MSDFFontData;
  private readonly byCode = new Map<number, MSDFGlyphDef>();
  private readonly kern = new Map<number, number>();

  constructor(data: MSDFFontData) {
    this.data = data;
    for (const g of data.glyphs) this.byCode.set(g.unicode, g);
    for (const k of data.kerning ?? []) this.kern.set(kernKey(k.unicode1, k.unicode2), k.advance);
  }

  /** Parse the `msdf-atlas-gen` JSON (string or already-parsed object). */
  static parse(json: string | MSDFFontData): MSDFFont {
    return new MSDFFont(typeof json === 'string' ? (JSON.parse(json) as MSDFFontData) : json);
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
        prevCode = -1;
        continue; // no glyph: don't advance (unknown width)
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
      penX += def.advance * fontSizePx + letterSpacing;
      prevCode = code;
    }

    maxAdvance = Math.max(maxAdvance, penX - x);
    return {
      glyphs,
      width: maxAdvance,
      height: (line + 1) * lineHeight * fontSizePx,
    };
  }
}
