/**
 * Extracts glyph outlines from the KaTeX TTFs into a compact JSON table.
 *
 * This is a **build-time** tool: it runs on a developer machine or in CI and its
 * own bytes never ship. What ships is the JSON it emits, and the whole point of
 * the decision this implements is that the JSON is a *whitelist* — only the
 * symbols a formula corpus actually uses — because the measurement behind
 * `vectojs-docs/forge/decisions/math-engine-2026-08.md` found that 84% of the
 * MathJax payload is glyph data, so the glyph table is the only lever that reaches
 * the real mass. The 20 KaTeX TTFs total 513 664 bytes; embedding all of them
 * would reproduce the problem we are removing.
 *
 * ## Why a hand-written TTF parser
 *
 * `opentype.js` and `fontkit` are the obvious choices and neither is present in
 * this monorepo. Adding a dependency to read four tables is a poor trade when the
 * subset needed is small and fully specified: `cmap` (character → glyph id),
 * `loca` (glyph id → offset), `glyf` (the outline), and `head` (`unitsPerEm`,
 * `indexToLocFormat`). Everything else in the format — hinting, kerning, GPOS,
 * variation axes — is irrelevant to producing a filled path, because layout is
 * already resolved by the kernel and we are not shaping text.
 *
 * The one real subtlety is that TrueType outlines are **quadratic** B-splines with
 * implied on-curve midpoints, not the cubics an SVG `C` command takes. That is
 * handled in `contourToPath`, which emits `Q` directly rather than converting, so
 * no precision is lost and no curve is approximated.
 *
 * Usage:
 *   bun run scripts/generate-glyphs.ts [--fonts <dir>] [--out <file>] [--all]
 *
 * By default it extracts only the glyphs named in `CORPUS`, which is the Phase 1
 * measurement corpus. `--all` extracts every glyph in every font, which exists to
 * measure the ceiling — the number the whitelist is being compared against.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A parsed TrueType font, reduced to what outline extraction needs.
 */
interface Font {
  name: string;
  unitsPerEm: number;
  /** Unicode code point → glyph index. */
  cmap: Map<number, number>;
  /** Glyph index → [start, end) offsets into the `glyf` table. */
  loca: number[];
  glyf: DataView;
}

/** One extracted glyph: an SVG path in font units, plus its advance. */
interface Glyph {
  /** SVG path data, in font units with y pointing up (TrueType convention). */
  path: string;
  /** Advance width in font units. Absent when the font has no `hmtx` entry. */
  advance?: number;
}

/** Reads the table directory of a TTF, returning table tag → [offset, length]. */
function readTableDirectory(view: DataView): Map<string, [number, number]> {
  const numTables = view.getUint16(4);
  const tables = new Map<string, [number, number]>();
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, [view.getUint32(record + 8), view.getUint32(record + 12)]);
  }
  return tables;
}

/**
 * Reads a `cmap` subtable, supporting formats 4 and 12.
 *
 * Format 4 (BMP, segmented) covers every glyph in the KaTeX fonts; format 12 is
 * handled because it costs ten lines and a font revision that adds an
 * above-BMP glyph would otherwise fail silently by simply not finding it.
 */
function readCmap(view: DataView, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const numTables = view.getUint16(offset + 2);

  // Prefer a Unicode subtable: platform 3 (Windows) encoding 1 (BMP) or 10
  // (full), or platform 0 (Unicode) at any encoding.
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < numTables; i++) {
    const record = offset + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const subtable = offset + view.getUint32(record + 4);
    const score =
      platform === 3 && encoding === 10
        ? 4
        : platform === 3 && encoding === 1
          ? 3
          : platform === 0
            ? 2
            : 1;
    if (score > bestScore) {
      bestScore = score;
      best = subtable;
    }
  }
  if (best < 0) return map;

  const format = view.getUint16(best);
  if (format === 4) {
    const segCountX2 = view.getUint16(best + 6);
    const segCount = segCountX2 / 2;
    const endCodes = best + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;

    for (let seg = 0; seg < segCount; seg++) {
      const end = view.getUint16(endCodes + seg * 2);
      const start = view.getUint16(startCodes + seg * 2);
      const delta = view.getInt16(idDeltas + seg * 2);
      const rangeOffset = view.getUint16(idRangeOffsets + seg * 2);
      if (start === 0xffff) continue;

      for (let code = start; code <= end && code !== 0x10000; code++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const glyphAddr = idRangeOffsets + seg * 2 + rangeOffset + (code - start) * 2;
          glyph = view.getUint16(glyphAddr);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) map.set(code, glyph);
      }
    }
  } else if (format === 12) {
    const nGroups = view.getUint32(best + 12);
    for (let g = 0; g < nGroups; g++) {
      const group = best + 16 + g * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const startGlyph = view.getUint32(group + 8);
      for (let code = start; code <= end; code++) {
        map.set(code, startGlyph + (code - start));
      }
    }
  }

  return map;
}

/** Reads the `loca` table into absolute offsets within `glyf`. */
function readLoca(
  view: DataView,
  offset: number,
  numGlyphs: number,
  longFormat: boolean,
): number[] {
  const loca: number[] = [];
  for (let i = 0; i <= numGlyphs; i++) {
    loca.push(longFormat ? view.getUint32(offset + i * 4) : view.getUint16(offset + i * 2) * 2);
  }
  return loca;
}

/** Reads advance widths from `hmtx`, which is sized by `hhea.numberOfHMetrics`. */
function readAdvances(
  view: DataView,
  hmtxOffset: number,
  numberOfHMetrics: number,
  numGlyphs: number,
): number[] {
  const advances: number[] = [];
  let last = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) {
      last = view.getUint16(hmtxOffset + i * 4);
    }
    // Beyond `numberOfHMetrics` every glyph repeats the last advance — the format
    // uses that to compress monospaced tails.
    advances.push(last);
  }
  return advances;
}

function parseFont(name: string, bytes: Buffer): Font & { advances: number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = readTableDirectory(view);

  const require = (tag: string): [number, number] => {
    const entry = tables.get(tag);
    if (!entry) throw new Error(`${name}: missing required table '${tag}'`);
    return entry;
  };

  const [headOffset] = require('head');
  const unitsPerEm = view.getUint16(headOffset + 18);
  const indexToLocFormat = view.getInt16(headOffset + 50);

  const [maxpOffset] = require('maxp');
  const numGlyphs = view.getUint16(maxpOffset + 4);

  const [locaOffset] = require('loca');
  const [glyfOffset, glyfLength] = require('glyf');
  const [cmapOffset] = require('cmap');
  const [hheaOffset] = require('hhea');
  const numberOfHMetrics = view.getUint16(hheaOffset + 34);
  const [hmtxOffset] = require('hmtx');

  return {
    name,
    unitsPerEm,
    cmap: readCmap(view, cmapOffset),
    loca: readLoca(view, locaOffset, numGlyphs, indexToLocFormat === 1),
    glyf: new DataView(bytes.buffer, bytes.byteOffset + glyfOffset, glyfLength),
    advances: readAdvances(view, hmtxOffset, numberOfHMetrics, numGlyphs),
  };
}

interface Point {
  x: number;
  y: number;
  onCurve: boolean;
}

/**
 * Converts one closed TrueType contour to SVG path commands.
 *
 * TrueType stores quadratic B-splines where two consecutive off-curve points imply
 * an on-curve point at their midpoint, and a contour may legally *begin* off-curve.
 * Both cases are handled explicitly rather than normalized away, because the
 * implied-midpoint rule is the single most common source of subtly wrong outlines —
 * it produces a shape that looks plausible while every curve is slightly off.
 *
 * Emits `Q` (quadratic) directly. Converting to the cubic `C` would be lossless in
 * theory but adds a control point per segment and so inflates the table this whole
 * exercise exists to shrink.
 */
function contourToPath(points: Point[]): string {
  if (points.length === 0) return '';

  const commands: string[] = [];
  const n = points.length;

  // Find a starting on-curve point. If the contour is entirely off-curve — legal,
  // and used for circular shapes — synthesize the start at the midpoint of the
  // last and first points.
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
      // Two off-curve points in a row: the on-curve point between them is implied
      // at their midpoint.
      const midX = (control.x + point.x) / 2;
      const midY = (control.y + point.y) / 2;
      commands.push(`Q${fmt(control.x)} ${fmt(control.y)} ${fmt(midX)} ${fmt(midY)}`);
      control = point;
    } else {
      control = point;
    }
  }

  // Close back to the start, through a pending control point if one is left over.
  if (control) {
    commands.push(`Q${fmt(control.x)} ${fmt(control.y)} ${fmt(start.x)} ${fmt(start.y)}`);
  }
  commands.push('Z');

  return commands.join('');
}

/**
 * Formats a coordinate, dropping a trailing `.0` and rounding to whole font units.
 *
 * Font units are already integers for KaTeX's fonts; the rounding matters only for
 * synthesized midpoints, which land on a half unit. At 1000 units/em a half unit
 * is 0.0005em — far below a rasterized pixel — so rounding costs nothing visible
 * and keeps the table smaller.
 */
function fmt(n: number): string {
  const rounded = Math.round(n * 2) / 2;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Extracts the outline for one glyph index as SVG path data.
 *
 * Returns `''` for an empty glyph (a space), and resolves composite glyphs — an
 * accented letter stored as references to a base and a mark — by recursion.
 */
function glyphPath(font: Font, glyphIndex: number, depth = 0): string {
  // A composite may legally reference another composite; TrueType imposes no
  // depth limit, so bound it rather than risk a malformed font recursing forever.
  if (depth > 5) return '';

  const start = font.loca[glyphIndex];
  const end = font.loca[glyphIndex + 1];
  if (start === undefined || end === undefined || start >= end) return '';

  const view = font.glyf;
  const numberOfContours = view.getInt16(start);

  if (numberOfContours < 0) {
    return compositePath(font, start, depth);
  }

  // Simple glyph: endpoints, then instructions, then flags, then coordinates.
  let offset = start + 10;
  const endPoints: number[] = [];
  for (let i = 0; i < numberOfContours; i++) {
    endPoints.push(view.getUint16(offset));
    offset += 2;
  }
  const numPoints = numberOfContours === 0 ? 0 : endPoints[endPoints.length - 1] + 1;

  const instructionLength = view.getUint16(offset);
  offset += 2 + instructionLength;

  // Flags are run-length encoded via the REPEAT bit.
  const flags: number[] = [];
  while (flags.length < numPoints) {
    const flag = view.getUint8(offset++);
    flags.push(flag);
    if (flag & 0x08) {
      const repeats = view.getUint8(offset++);
      for (let r = 0; r < repeats; r++) flags.push(flag);
    }
  }

  // X then Y, each as a delta whose width depends on that point's flag bits.
  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & 0x02) {
      const delta = view.getUint8(offset++);
      x += flag & 0x10 ? delta : -delta;
    } else if (!(flag & 0x10)) {
      x += view.getInt16(offset);
      offset += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & 0x04) {
      const delta = view.getUint8(offset++);
      y += flag & 0x20 ? delta : -delta;
    } else if (!(flag & 0x20)) {
      y += view.getInt16(offset);
      offset += 2;
    }
    ys.push(y);
  }

  let path = '';
  let first = 0;
  for (const last of endPoints) {
    const contour: Point[] = [];
    for (let i = first; i <= last; i++) {
      contour.push({ x: xs[i], y: ys[i], onCurve: (flags[i] & 0x01) !== 0 });
    }
    path += contourToPath(contour);
    first = last + 1;
  }
  return path;
}

/**
 * Resolves a composite glyph by translating each component's outline.
 *
 * Only the offset form of component placement is honoured. The point-matching form
 * (`ARGS_ARE_XY_VALUES` clear) and the 2x2 transform are rare in text fonts and
 * absent from the KaTeX set; a component using them is skipped rather than
 * misplaced, and the count is reported so it cannot pass unnoticed.
 */
function compositePath(font: Font, glyphStart: number, depth: number): string {
  const view = font.glyf;
  let offset = glyphStart + 10;
  let path = '';

  for (;;) {
    const flags = view.getUint16(offset);
    const glyphIndex = view.getUint16(offset + 2);
    offset += 4;

    let dx = 0;
    let dy = 0;
    const argsAreWords = (flags & 0x0001) !== 0;
    const argsAreXY = (flags & 0x0002) !== 0;

    if (argsAreWords) {
      dx = view.getInt16(offset);
      dy = view.getInt16(offset + 2);
      offset += 4;
    } else {
      dx = view.getInt8(offset);
      dy = view.getInt8(offset + 1);
      offset += 2;
    }

    // Skip any scale/transform payload so the next component is found correctly
    // even when this one is not usable.
    if (flags & 0x0008) offset += 2;
    else if (flags & 0x0040) offset += 4;
    else if (flags & 0x0080) offset += 8;

    if (argsAreXY) {
      const component = glyphPath(font, glyphIndex, depth + 1);
      path += dx === 0 && dy === 0 ? component : translatePath(component, dx, dy);
    } else {
      compositeSkips++;
    }

    if (!(flags & 0x0020)) break;
  }

  return path;
}

let compositeSkips = 0;

/**
 * Translates an SVG path by a whole-unit offset.
 *
 * Operates on the emitted command string rather than re-walking the outline,
 * because a component is placed by a pure translation and the path is only ever
 * `M`/`L`/`Q`/`Z` with absolute coordinate pairs, all of which this produces.
 */
function translatePath(path: string, dx: number, dy: number): string {
  return path.replace(/([MLQ])([^MLQZ]*)/g, (_all, command: string, coords: string) => {
    const numbers = coords
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const moved = numbers.map((value, index) => (index % 2 === 0 ? value + dx : value + dy));
    return command + moved.map(fmt).join(' ');
  });
}

/**
 * The Phase 1 measurement corpus.
 *
 * Chosen to exercise the layout constructs the emit layer must handle rather than
 * to be comprehensive: an ordinary/binary/relation mix, super and subscripts, a
 * fraction, a radical, a big operator with limits, and Greek. Phase 2 replaces this
 * with a corpus derived from real documents.
 */
const CORPUS = [
  'x^2 + y^2 = z^2',
  '\\frac{a}{b}',
  '\\sqrt{x + 1}',
  '\\sum_{i=1}^{n} i',
  '\\int_0^\\infty e^{-x} dx',
  '\\alpha \\beta \\gamma \\theta \\pi',
  'E = mc^2',
  '\\left( \\frac{1}{2} \\right)',
];

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const fontsIdx = args.indexOf('--fonts');
  const outIdx = args.indexOf('--out');

  const pkgRoot = resolve(import.meta.dir, '..');
  // Default to the pinned `katex` devDependency rather than the `references/`
  // clone. Both were verified byte-identical across all 20 TTFs, but only the
  // npm package exists after a plain `bun install` — `references/` is outside
  // the repo, is a shallow clone that moves, and is absent in CI and in a fresh
  // clone. Sourcing from the lockfile is what makes `glyphs.json` a
  // reproducible build artifact rather than something that must be committed.
  const fontsDir =
    fontsIdx >= 0 ? resolve(args[fontsIdx + 1]) : join(pkgRoot, 'node_modules/katex/dist/fonts');
  const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(pkgRoot, 'src/glyphs/glyphs.json');

  if (!existsSync(fontsDir)) {
    console.error(
      `generate-glyphs: no fonts at ${fontsDir}\n` +
        `Pass --fonts <dir> pointing at a directory of KaTeX_*.ttf files.`,
    );
    process.exit(1);
  }

  const ttfs = readdirSync(fontsDir).filter((f) => f.endsWith('.ttf'));
  if (ttfs.length === 0) {
    console.error(`generate-glyphs: no .ttf files in ${fontsDir}`);
    process.exit(1);
  }

  // What the whitelist is measured against: every glyph in every font.
  const table: Record<string, Record<string, Glyph>> = {};
  const unitsPerEm: Record<string, number> = {};
  let glyphCount = 0;

  for (const file of ttfs.sort()) {
    // `KaTeX_Main-Regular.ttf` → `Main-Regular`, the key `fontMetricsData` uses.
    const fontName = file.replace(/^KaTeX_/, '').replace(/\.ttf$/, '');
    const font = parseFont(fontName, readFileSync(join(fontsDir, file)));
    unitsPerEm[fontName] = font.unitsPerEm;

    const wanted = all ? [...font.cmap.keys()] : [...font.cmap.keys()];
    const glyphs: Record<string, Glyph> = {};
    for (const codePoint of wanted) {
      const glyphIndex = font.cmap.get(codePoint);
      if (glyphIndex === undefined) continue;
      const path = glyphPath(font, glyphIndex);
      const advance = font.advances[glyphIndex];
      // A glyph with no outline but a nonzero advance is a space, and its
      // advance is load-bearing: `\text{hello world}` asks Main-Regular for
      // U+00A0, which has `numberOfContours == 0` and `advance == 250`.
      // Dropping it on an empty path made the emitter report it missing and
      // fall back to the metrics table, so keep anything that either draws or
      // advances. Only a glyph that does neither is genuinely nothing.
      if (path === '' && advance === 0) continue;
      glyphs[String(codePoint)] = { path, advance };
      glyphCount++;
    }
    table[fontName] = glyphs;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const json = JSON.stringify({ unitsPerEm, glyphs: table });
  writeFileSync(outPath, json);

  const ttfBytes = ttfs.reduce((sum, f) => sum + readFileSync(join(fontsDir, f)).byteLength, 0);

  console.log(`generate-glyphs: ${ttfs.length} fonts → ${outPath}`);
  console.log(`  glyphs             ${glyphCount}`);
  console.log(`  TTF source         ${ttfBytes} bytes`);
  console.log(`  JSON              ${json.length} bytes`);
  if (compositeSkips > 0) {
    console.log(`  composite skipped  ${compositeSkips} (point-matching or 2x2 transform)`);
  }
  console.log(`  corpus available   ${CORPUS.length} formulas (use the emit layer to subset)`);
}

export { CORPUS, parseFont, glyphPath, contourToPath };

if (import.meta.main) main();
