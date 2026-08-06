/**
 * Encodes the glyph subset into the compact binary table that ships.
 *
 * Phase 1 shipped glyph outlines as expanded SVG path text, which measured 74%
 * of the whole engine's gzip payload. This converts that table to the binary
 * format in `src/emit/glyphCodec.ts` and writes it as a base64 string inside a
 * generated TypeScript module.
 *
 * ## Why this reverses the expansion instead of changing the extractor
 *
 * The outlines start life as TrueType point lists, and `generate-glyphs.ts`
 * expands them into SVG commands. The compact format wants the point lists back,
 * so the obvious move is to change the extractor to emit them directly. That was
 * rejected deliberately.
 *
 * The emit layer is validated 26/26 against real KaTeX in a browser — worst
 * per-glyph x error 0.002 em, worst y error 0.0000 em — and that validation
 * attaches to the *path strings the extractor produces*. Changing the extractor
 * replaces those strings with a new code path, discarding the evidence and
 * requiring the whole browser cross-validation to be re-run to recover it.
 *
 * Reversing instead lets this script assert something stronger: that the shipped
 * bytes decode to the **byte-identical** string that was validated in a browser.
 * That inherits the validation rather than re-earning it. The assertion is not a
 * spot check — it covers every glyph in the table and the script refuses to write
 * output if a single one differs.
 *
 * The re-expansion deliberately runs through the *runtime decoder*, not a local
 * copy of the expansion logic. A copy could drift from the shipping code and the
 * gate would still pass, which would make it worthless.
 *
 * Usage:
 *   bun run scripts/encode-glyphs.ts [--in <file>] [--out <file>] [--check]
 *
 *   --in     subset JSON to encode. Defaults to `src/glyphs/glyphs.subset.json`.
 *   --out    generated module. Defaults to `src/glyphs/glyphs.subset.ts`.
 *   --check  verify the committed module matches what this script would write,
 *            and exit non-zero if not. For CI; writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { FORMAT_VERSION, GlyphTable, MAGIC_0, MAGIC_1 } from '../src/emit/glyphCodec';

interface Point {
  x: number;
  y: number;
  onCurve: boolean;
}

interface SubsetTable {
  unitsPerEm: Record<string, number>;
  glyphs: Record<string, Record<string, { path: string; advance: number }>>;
}

// ---------------------------------------------------------------------------
// SVG path -> TrueType point list
// ---------------------------------------------------------------------------

/** Splits a path string into commands. The generator emits only M, L, Q and Z. */
function parsePath(path: string): { op: string; args: number[] }[] {
  const out: { op: string; args: number[] }[] = [];
  const re = /([MLQZ])([^MLQZ]*)/g;
  for (;;) {
    const m = re.exec(path);
    if (m === null) break;
    const nums = m[2].match(/-?[0-9]*\.?[0-9]+/g);
    out.push({ op: m[1], args: nums ? nums.map(Number) : [] });
  }
  return out;
}

/**
 * Recovers the point list of each contour from expanded SVG commands.
 *
 * `M` and `L` endpoints are on-curve; a `Q` contributes an off-curve control
 * followed by an on-curve endpoint.
 */
function pathToContours(path: string): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] = [];
  let start: Point | null = null;

  for (const cmd of parsePath(path)) {
    if (cmd.op === 'M') {
      start = { x: cmd.args[0], y: cmd.args[1], onCurve: true };
      current = [start];
    } else if (cmd.op === 'L') {
      current.push({ x: cmd.args[0], y: cmd.args[1], onCurve: true });
    } else if (cmd.op === 'Q') {
      current.push({ x: cmd.args[0], y: cmd.args[1], onCurve: false });
      current.push({ x: cmd.args[2], y: cmd.args[3], onCurve: true });
    } else if (cmd.op === 'Z') {
      // The expansion walks the rotated point list all the way back around, so
      // its last segment *ends* at the start point. Reversing naively therefore
      // appends a duplicate of point 0, which re-expands into a spurious extra
      // `L`/`Q` before the `Z`. Drop it.
      const last = current[current.length - 1];
      if (current.length > 1 && start && last.onCurve && last.x === start.x && last.y === start.y) {
        current.pop();
      }
      contours.push(current);
      current = [];
      start = null;
    }
  }
  if (current.length > 0) contours.push(current);
  return contours;
}

/**
 * Drops on-curve points that sit exactly at the midpoint of their two off-curve
 * neighbours.
 *
 * TrueType implies such a point, so it need not be stored. Measured across the
 * shipped subset this removes 5 256 points — data a subset TTF still carries,
 * which is why this format beats one.
 *
 * The equality test is exact rather than epsilon-based on purpose: these
 * midpoints were *computed* by the generator as `(a + b) / 2` from integers, so
 * an exact match is achievable, and an epsilon would risk dropping a genuine
 * point that merely happens to sit near a midpoint.
 */
function dropImplied(points: Point[]): Point[] {
  const kept: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const next = points[i + 1];
    if (
      p.onCurve &&
      prev &&
      next &&
      !prev.onCurve &&
      !next.onCurve &&
      (prev.x + next.x) / 2 === p.x &&
      (prev.y + next.y) / 2 === p.y
    ) {
      continue;
    }
    kept.push(p);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Binary writer
// ---------------------------------------------------------------------------

class ByteWriter {
  private readonly bytes: number[] = [];

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  /** LEB128 unsigned varint. */
  uvar(v: number): void {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`uvar: ${v} is not a non-negative integer`);
    }
    let x = v;
    while (x >= 0x80) {
      this.bytes.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    this.bytes.push(x);
  }

  /** Zigzag then varint, so a small negative costs one byte like a small positive. */
  svar(v: number): void {
    if (!Number.isInteger(v)) {
      // Reaching here means a coordinate was not an integer, which contradicts
      // the measurement the format rests on. Fail rather than round silently.
      throw new Error(`svar: ${v} is not an integer`);
    }
    this.uvar(v < 0 ? -v * 2 - 1 : v * 2);
  }

  str(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.uvar(b.byteLength);
    for (const x of b) this.bytes.push(x);
  }

  get buffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** Encodes the subset table to the binary format. */
function encode(table: SubsetTable): {
  bytes: Buffer;
  glyphCount: number;
  pointCount: number;
} {
  const w = new ByteWriter();
  const fonts = Object.keys(table.glyphs).sort();

  w.u8(MAGIC_0);
  w.u8(MAGIC_1);
  w.u8(FORMAT_VERSION);
  w.uvar(fonts.length);

  let glyphCount = 0;
  let pointCount = 0;

  for (const font of fonts) {
    w.str(font);
    w.uvar(table.unitsPerEm[font]);

    const codes = Object.keys(table.glyphs[font])
      .map(Number)
      .sort((a, b) => a - b);
    w.uvar(codes.length);

    // Codepoints ascend, so store the gap. The dense Latin, digit and Greek runs
    // then cost one byte each instead of two or three.
    let prevCode = 0;
    for (const code of codes) {
      const glyph = table.glyphs[font][String(code)];
      w.uvar(code - prevCode);
      prevCode = code;
      w.uvar(glyph.advance);

      const contours = pathToContours(glyph.path).map(dropImplied);
      w.uvar(contours.length);
      for (const contour of contours) {
        w.uvar(contour.length);
        pointCount += contour.length;

        // On-curve flags, one bit per point, 8 per byte, LSB first.
        let acc = 0;
        let nbits = 0;
        for (const p of contour) {
          acc |= (p.onCurve ? 1 : 0) << nbits;
          if (++nbits === 8) {
            w.u8(acc);
            acc = 0;
            nbits = 0;
          }
        }
        if (nbits > 0) w.u8(acc);

        // All x deltas, then all y deltas. Splitting the axes keeps each run's
        // magnitudes similar; measured, it is 0.5 KB gzip better than
        // interleaving and it matches how `glyf` itself is laid out.
        let px = 0;
        for (const p of contour) {
          w.svar(p.x - px);
          px = p.x;
        }
        let py = 0;
        for (const p of contour) {
          w.svar(p.y - py);
          py = p.y;
        }
      }
      glyphCount++;
    }
  }

  return { bytes: w.buffer, glyphCount, pointCount };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Asserts that every glyph decodes to the byte-identical path string the
 * generator produced.
 *
 * This is the load-bearing correctness check for the whole re-encoding. A bbox
 * or area comparison would be far weaker — measured during Phase 1, a bbox+area
 * check is blind to 4 of 5 realistic glyph corruptions (interior coordinate
 * shift, moved control point, dropped contour, sub-unit noise). String equality
 * against the validated output is blind to none of them.
 *
 * It runs through the shipping decoder, so it cannot pass while the decoder is
 * wrong.
 */
function verifyRoundTrip(
  table: SubsetTable,
  bytes: Buffer,
): { checked: number; mismatches: string[] } {
  const decoded = new GlyphTable(new Uint8Array(bytes));
  const mismatches: string[] = [];
  let checked = 0;

  const fonts = Object.keys(table.glyphs).sort();
  for (const font of fonts) {
    if (decoded.unitsPerEm(font) !== table.unitsPerEm[font]) {
      mismatches.push(
        `${font}: unitsPerEm ${decoded.unitsPerEm(font)} != ${table.unitsPerEm[font]}`,
      );
    }
    for (const codeStr of Object.keys(table.glyphs[font])) {
      const expected = table.glyphs[font][codeStr];
      const got = decoded.get(font, Number(codeStr));
      checked++;
      if (!got) {
        mismatches.push(`${font} U+${Number(codeStr).toString(16)}: absent after decode`);
        continue;
      }
      if (got.advance !== expected.advance) {
        mismatches.push(
          `${font} U+${Number(codeStr).toString(16)}: advance ${got.advance} != ${expected.advance}`,
        );
      }
      if (got.path !== expected.path) {
        let i = 0;
        while (
          i < got.path.length &&
          i < expected.path.length &&
          got.path[i] === expected.path[i]
        ) {
          i++;
        }
        mismatches.push(
          `${font} U+${Number(codeStr).toString(16)}: path differs at char ${i}\n` +
            `      want …${expected.path.slice(Math.max(0, i - 30), i + 30)}…\n` +
            `      got  …${got.path.slice(Math.max(0, i - 30), i + 30)}…`,
        );
      }
    }
  }

  // A glyph present in the decode but absent from the source would be invisible
  // to the loop above, so compare counts too.
  if (decoded.glyphCount() !== checked) {
    mismatches.push(`decoded glyph count ${decoded.glyphCount()} != source ${checked}`);
  }

  return { checked, mismatches };
}

// ---------------------------------------------------------------------------
// Module emission
// ---------------------------------------------------------------------------

function moduleSource(
  b64: string,
  stats: { glyphs: number; faces: number; bytes: number },
): string {
  return `// GENERATED FILE - DO NOT EDIT BY HAND.
//
// Written by \`scripts/encode-glyphs.ts\` from \`src/glyphs/glyphs.subset.json\`.
// Regenerate with \`bun run encode-glyphs\`; verify with \`bun run encode-glyphs --check\`.
//
// ${stats.glyphs} glyphs across ${stats.faces} faces, ${stats.bytes} bytes before base64.
//
// This is the binary outline table described in \`src/emit/glyphCodec.ts\`. It
// replaced a JSON table of expanded SVG path text that cost 135.5 KB gzip; this
// module costs 78.2 KB gzip for the identical glyph set. Every glyph is verified
// to decode to the byte-identical path string the extractor produced, so the
// emit layer's browser validation carries across unchanged.

/** Base64 of the binary glyph table. Decode with \`base64ToBytes\`. */
export const GLYPH_TABLE_BASE64 =
  '${b64}';
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const pkgRoot = resolve(import.meta.dir, '..');

  const inIdx = args.indexOf('--in');
  const inPath =
    inIdx >= 0 ? resolve(args[inIdx + 1]) : join(pkgRoot, 'src/glyphs/glyphs.subset.json');
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx >= 0 ? resolve(args[outIdx + 1]) : join(pkgRoot, 'src/glyphs/glyphs.subset.ts');
  const checkOnly = args.includes('--check');

  let sourceBytes: Buffer;
  try {
    sourceBytes = readFileSync(inPath);
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no subset table' : String(err);
    console.error(
      `encode-glyphs: ${reason} at ${inPath}\n` +
        `Run \`bun run glyphs\` then \`bun run subset\` first.`,
    );
    process.exit(1);
  }
  const table = JSON.parse(sourceBytes.toString('utf8')) as SubsetTable;

  const { bytes, glyphCount, pointCount } = encode(table);

  // Verify before writing. A table that does not round-trip must never reach
  // disk, because the next step is a commit and the defect would be invisible.
  const { checked, mismatches } = verifyRoundTrip(table, bytes);
  if (mismatches.length > 0) {
    console.error(`encode-glyphs: ${mismatches.length} of ${checked} glyph(s) did not round-trip:`);
    for (const m of mismatches.slice(0, 10)) console.error(`  ${m}`);
    if (mismatches.length > 10) console.error(`  … and ${mismatches.length - 10} more`);
    process.exit(1);
  }

  const b64 = bytes.toString('base64');
  const faces = Object.keys(table.glyphs).length;
  const source = moduleSource(b64, {
    glyphs: glyphCount,
    faces,
    bytes: bytes.byteLength,
  });

  if (checkOnly) {
    let committed: string;
    try {
      committed = readFileSync(outPath, 'utf8');
    } catch {
      console.error(
        `encode-glyphs --check: ${outPath} does not exist. Run \`bun run encode-glyphs\`.`,
      );
      process.exit(1);
    }
    if (committed !== source) {
      // Report *where* they diverge, not just that they do. Both a hand-edit and a
      // changed input produce files of the same length surprisingly often — the
      // base64 payload has fixed width for a fixed glyph count — so a
      // length-only message reads as "124359 chars vs 124359 chars" and tells the
      // reader nothing.
      let i = 0;
      while (i < committed.length && i < source.length && committed[i] === source[i]) i++;
      const excerpt = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
      console.error(
        `encode-glyphs --check: ${outPath} is stale.\n` +
          `  first difference at char ${i} of ${committed.length} committed / ${source.length} regenerated\n` +
          `  committed   ${excerpt(committed)}\n` +
          `  regenerated ${excerpt(source)}\n` +
          `  Run \`bun run encode-glyphs\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`encode-glyphs --check: ${outPath} is up to date (${checked} glyphs round-trip).`);
    return;
  }

  writeFileSync(outPath, source);

  const jsonGz = gzipSync(sourceBytes, { level: 9 }).byteLength;
  const binGz = gzipSync(bytes, { level: 9 }).byteLength;
  const modGz = gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).byteLength;
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

  console.log(`encode-glyphs: ${glyphCount} glyphs, ${faces} faces, ${pointCount} points`);
  console.log(`  all ${checked} glyphs round-trip to byte-identical SVG path data`);
  console.log(
    `  source JSON     ${kb(sourceBytes.byteLength).padStart(9)} raw  ${kb(jsonGz).padStart(9)} gzip`,
  );
  console.log(
    `  binary          ${kb(bytes.byteLength).padStart(9)} raw  ${kb(binGz).padStart(9)} gzip`,
  );
  console.log(
    `  module (base64) ${kb(source.length).padStart(9)} raw  ${kb(modGz).padStart(9)} gzip`,
  );
  console.log(`  -> ${((modGz / jsonGz) * 100).toFixed(1)}% of the JSON table's gzip cost`);
  console.log(`  wrote ${outPath}`);
}

if (import.meta.main) main();

export { dropImplied, encode, pathToContours, verifyRoundTrip };
