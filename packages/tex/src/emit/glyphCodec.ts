/**
 * Binary glyph-outline codec.
 *
 * The glyph table dominates what this package ships: measured at Phase 1 it was
 * 138 763 of 186 778 gzip bytes, or 74%. It was stored as expanded SVG path text
 * — the string that goes straight into a `<path d="…">` — which is a very poor
 * encoding for what it holds. Cross-encoding the *identical* 561-glyph whitelist
 * as a subset TTF with fontTools gave 78 426 gzip against our 138 763, so roughly
 * 60 KB was pure encoding overhead.
 *
 * This module is the compact replacement. Three observations drive the format,
 * each of them measured rather than assumed:
 *
 * 1. **The SVG paths are expanded TrueType quadratic contours.** TrueType stores
 *    a quadratic B-spline as a point list with an on-curve flag per point, where
 *    two consecutive off-curve points *imply* an on-curve point at their
 *    midpoint. `generate-glyphs.ts` writes those implied points out explicitly.
 *    Measured across the shipped subset: 5 256 of 18 306 `Q` endpoints are
 *    exactly the midpoint of their two flanking controls, with **zero**
 *    counterexamples. Storing the point list instead of the expansion drops all
 *    5 256, which is data even a subset TTF still carries.
 * 2. **Every remaining coordinate is an integer.** The 4 894 `.5` coordinates in
 *    the old table were *entirely* accounted for by those implied midpoints: with
 *    them removed, 0 of the 72 616 remaining coordinates sit off the integer
 *    grid. So no fixed-point scaling is needed, and adding one would be actively
 *    harmful — an earlier revision doubled every coordinate to clear a half grid
 *    that does not exist, which cost 3.3 KB gzip by pushing deltas out of a
 *    one-byte varint.
 * 3. **Coordinates are strongly correlated along a contour.** Delta-encoding
 *    then zigzagging puts 60 637 of 72 616 deltas in a single varint byte.
 *
 * Two encodings were measured and rejected. **base85** is smaller raw (113.2 KB
 * vs 120.7 KB) but *larger* gzipped (85.1 KB vs 78.2 KB): its 5-chars-per-4-bytes
 * output is not byte-aligned, which destroys the byte-column regularity gzip
 * exploits. **WOFF2-style stream separation** (structure | flags | x | y rather
 * than per-glyph interleaving) saved only 0.5 KB gzip, which does not justify
 * the format complexity.
 *
 * The decoder is deliberately small — it ships, so a clever decoder that costs
 * more code than the encoding saves is a net loss.
 *
 * ## A note on `sideEffects`
 *
 * `package.json` declares `"sideEffects": true`, which looks like a missed
 * tree-shaking opportunity and is not. The vendored kernel fills its function and
 * symbol registries through import side effects, so declaring the package
 * side-effect-free lets a bundler delete them: measured on `main` at `d406a9a`,
 * the built bundle threw `Got group of unknown type: 'mathord'` for `x`. Unit
 * tests do not catch it because vitest aliases the package to `src/` and never
 * loads the bundle, so `test/glyphCodec.test.ts` asserts the manifest field
 * directly.
 */

/** A decoded outline. `path` is SVG path data in font units, y-up. */
export interface DecodedGlyph {
  path: string;
  advance: number;
}

/** One point of a TrueType contour. */
interface Point {
  x: number;
  y: number;
  onCurve: boolean;
}

/** Format magic: 'V','G' then a version byte. */
export const MAGIC_0 = 0x56;
export const MAGIC_1 = 0x47;
export const FORMAT_VERSION = 1;

/**
 * Sequential reader over the encoded bytes.
 *
 * `pos` is public because the index pass needs to record and restore offsets to
 * make per-glyph decoding lazy.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  u8(): number {
    return this.bytes[this.pos++];
  }

  /** LEB128 unsigned varint. */
  uvar(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.bytes[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  /** Zigzag-decoded signed varint: 0,-1,1,-2,2 -> 0,1,2,3,4. */
  svar(): number {
    const u = this.uvar();
    return u & 1 ? -((u + 1) >>> 1) : u >>> 1;
  }

  /** Length-prefixed UTF-8 string. Face names are ASCII, so this stays simple. */
  str(): string {
    const len = this.uvar();
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[this.pos++]);
    return s;
  }
}

/**
 * Formats a coordinate exactly as `generate-glyphs.ts` does.
 *
 * Decoded coordinates are integers, but synthesized midpoints land on a half
 * unit, so the `.5` case is still reachable and must format identically or the
 * round-trip gate in `encode-glyphs.ts` fails.
 */
function fmt(n: number): string {
  const rounded = Math.round(n * 2) / 2;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Expands one TrueType contour to SVG path commands.
 *
 * This mirrors `contourToPath` in `scripts/generate-glyphs.ts` and must stay
 * byte-identical to it: `encode-glyphs.ts` asserts that every one of the 561
 * shipped glyphs re-expands to the exact string the generator produced, which is
 * what carries the emit layer's 26/26 browser validation across the re-encoding.
 *
 * Two TrueType subtleties are handled explicitly rather than normalized away,
 * because both produce a plausible-looking shape when got wrong:
 * a contour may legally *begin* off-curve, and two consecutive off-curve points
 * imply an on-curve point at their midpoint.
 */
function contourToPath(points: Point[]): string {
  if (points.length === 0) return '';

  const commands: string[] = [];
  const n = points.length;

  // Find a starting on-curve point. A contour that is entirely off-curve is
  // legal and used for circular shapes; synthesize its start at the midpoint of
  // the last and first points.
  let startIndex = points.findIndex((p) => p.onCurve);
  let start: Point;
  if (startIndex < 0) {
    start = {
      x: (points[n - 1].x + points[0].x) / 2,
      y: (points[n - 1].y + points[0].y) / 2,
      onCurve: true,
    };
    startIndex = 0;
    commands.push(`M${fmt(start.x)} ${fmt(start.y)}`);
  } else {
    start = points[startIndex];
    commands.push(`M${fmt(start.x)} ${fmt(start.y)}`);
    startIndex += 1;
  }

  let control: Point | null = null;
  for (let k = 0; k < n; k++) {
    const point = points[(startIndex + k) % n];
    if (point.onCurve) {
      if (control) {
        commands.push(`Q${fmt(control.x)} ${fmt(control.y)} ${fmt(point.x)} ${fmt(point.y)}`);
        control = null;
      } else {
        commands.push(`L${fmt(point.x)} ${fmt(point.y)}`);
      }
    } else if (control) {
      // Two off-curve points in a row: the on-curve point between them is
      // implied at their midpoint. This is the case the encoder drops.
      commands.push(
        `Q${fmt(control.x)} ${fmt(control.y)} ${fmt((control.x + point.x) / 2)} ${fmt(
          (control.y + point.y) / 2,
        )}`,
      );
      control = point;
    } else {
      control = point;
    }
  }

  // Close back to the start, through a pending control point if one is left.
  if (control) {
    commands.push(`Q${fmt(control.x)} ${fmt(control.y)} ${fmt(start.x)} ${fmt(start.y)}`);
  }
  commands.push('Z');

  return commands.join('');
}

/**
 * Decodes one glyph's contours to SVG path data, starting at `reader.pos`.
 *
 * The reader is left just past this glyph, so a caller walking the table
 * sequentially needs no length prefix per glyph.
 */
export function decodeGlyphPath(reader: ByteReader): string {
  const contourCount = reader.uvar();
  let path = '';

  for (let c = 0; c < contourCount; c++) {
    const pointCount = reader.uvar();
    if (pointCount === 0) continue;

    // On-curve flags, one bit per point, 8 per byte, LSB first.
    const onCurve: boolean[] = [];
    const flagBytes = (pointCount + 7) >> 3;
    for (let i = 0; i < flagBytes; i++) {
      const b = reader.u8();
      for (let bit = 0; bit < 8 && onCurve.length < pointCount; bit++) {
        onCurve.push(((b >> bit) & 1) === 1);
      }
    }

    // X deltas for the whole contour, then Y deltas. Splitting the axes keeps
    // each run's magnitudes similar, which both varints and gzip prefer.
    const xs = new Array<number>(pointCount);
    let x = 0;
    for (let i = 0; i < pointCount; i++) {
      x += reader.svar();
      xs[i] = x;
    }
    const points = new Array<Point>(pointCount);
    let y = 0;
    for (let i = 0; i < pointCount; i++) {
      y += reader.svar();
      points[i] = { x: xs[i], y, onCurve: onCurve[i] };
    }

    path += contourToPath(points);
  }

  return path;
}

/** A face's decoded metadata plus the byte offset of each glyph's outline. */
interface FaceIndex {
  unitsPerEm: number;
  /** codepoint -> [advance, byte offset of the contour data] */
  glyphs: Map<number, [number, number]>;
}

/**
 * A lazily-decoded glyph table.
 *
 * Construction runs one pass that reads only counts, advances and codepoints,
 * recording where each glyph's outline begins. Outlines are decoded on first
 * request and cached. A document using twenty glyphs therefore pays for twenty
 * expansions rather than 561, which matters because the expansion produces
 * strings and the old table's strings were the thing being paid for at parse
 * time.
 */
export class GlyphTable {
  private readonly bytes: Uint8Array;
  private readonly faces = new Map<string, FaceIndex>();
  private readonly cache = new Map<string, DecodedGlyph | undefined>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const r = new ByteReader(bytes);
    if (r.u8() !== MAGIC_0 || r.u8() !== MAGIC_1) {
      throw new Error('glyph table: bad magic');
    }
    const version = r.u8();
    if (version !== FORMAT_VERSION) {
      throw new Error(`glyph table: unsupported version ${version}`);
    }

    const faceCount = r.uvar();
    for (let f = 0; f < faceCount; f++) {
      const name = r.str();
      const unitsPerEm = r.uvar();
      const glyphCount = r.uvar();
      const glyphs = new Map<number, [number, number]>();
      let code = 0;
      for (let g = 0; g < glyphCount; g++) {
        // Codepoints are ascending, so a delta keeps them in one varint byte
        // for the dense Latin and Greek runs.
        code += r.uvar();
        const advance = r.uvar();
        glyphs.set(code, [advance, r.pos]);
        // Skip the outline without decoding it. This is the whole point of the
        // index pass, so it must not build any strings.
        skipGlyph(r);
      }
      this.faces.set(name, { unitsPerEm, glyphs });
    }
  }

  /**
   * Returns the outline for a codepoint in a face, or `undefined` when the glyph
   * is outside the shipped whitelist.
   *
   * A miss is not an error: the caller records it and degrades, which is the
   * documented fallback for symbols outside the whitelist.
   */
  get(font: string, code: number): DecodedGlyph | undefined {
    const key = `${font}\u0000${code}`;
    // `has` rather than a truthiness check, so a cached miss is not re-decoded
    // on every subsequent request.
    if (this.cache.has(key)) return this.cache.get(key);

    const face = this.faces.get(font);
    const entry = face?.glyphs.get(code);
    if (!entry) {
      this.cache.set(key, undefined);
      return undefined;
    }
    const decoded: DecodedGlyph = {
      path: decodeGlyphPath(new ByteReader(this.bytes, entry[1])),
      advance: entry[0],
    };
    this.cache.set(key, decoded);
    return decoded;
  }

  unitsPerEm(font: string): number | undefined {
    return this.faces.get(font)?.unitsPerEm;
  }

  fonts(): string[] {
    return [...this.faces.keys()];
  }

  glyphCount(): number {
    let n = 0;
    for (const face of this.faces.values()) n += face.glyphs.size;
    return n;
  }
}

/** Advances `reader` past one glyph's contour data without decoding it. */
function skipGlyph(reader: ByteReader): void {
  const contourCount = reader.uvar();
  for (let c = 0; c < contourCount; c++) {
    const pointCount = reader.uvar();
    if (pointCount === 0) continue;
    reader.pos += (pointCount + 7) >> 3;
    // Deltas are variable width, so they must be walked rather than skipped by
    // arithmetic. Reading the continuation bit is far cheaper than materialising
    // points and formatting a path string.
    for (let i = 0; i < pointCount * 2; i++) {
      while (reader.bytes[reader.pos++] & 0x80) {
        // advance past continuation bytes
      }
    }
  }
}

/**
 * Decodes a base64 payload to bytes.
 *
 * `atob` in browsers, `Buffer` under Node and Bun. The table ships base64'd
 * because it lives inside a JS module: measured, base64 costs 10.8 KB gzip over
 * the raw bytes (78.2 vs 67.4), which buys a synchronous `getGlyph` with no
 * asset-loading step. Keeping that call synchronous matters — `emitSVG` is
 * synchronous all the way down, and making the glyph table async would push a
 * promise through the entire emit layer and into `convertMathToSVGDataURI`.
 */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // No `atob`: a non-browser host such as a bare Node build or an SSR pass.
  //
  // `Buffer` is reached through `globalThis` rather than named directly because
  // this package compiles against the browser typing surface with no `@types/node`
  // — referencing `Buffer` as an identifier is a type error, and adding the Node
  // types to a browser-targeted package to satisfy a fallback branch would be the
  // wrong trade. `Buffer.from` also returns a view onto a *pooled* ArrayBuffer, so
  // the bytes are copied rather than handed out as a window into shared memory.
  const nodeBuffer = (
    globalThis as {
      Buffer?: { from(s: string, enc: string): Uint8Array };
    }
  ).Buffer;
  if (nodeBuffer) {
    return new Uint8Array(nodeBuffer.from(b64, 'base64'));
  }

  throw new Error('glyph table: no base64 decoder available (need atob or Buffer)');
}
