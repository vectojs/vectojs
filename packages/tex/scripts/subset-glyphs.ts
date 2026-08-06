/**
 * Glyph whitelist subsetting.
 *
 * The full outline table for all 20 KaTeX faces is 1 214 552 bytes — larger
 * than the 513 664 bytes of TTF it was extracted from, because SVG path text
 * is a far less compact encoding than `glyf`. Shipping it whole would be worse
 * than shipping the fonts, so a whitelist is mandatory rather than an
 * optimisation. This is the lever the size decision rests on: 84% of the
 * MathJax payload being replaced is glyph data, and a whitelist is the only
 * thing that reaches it.
 *
 * The whitelist is **discovered, not written by hand.** A hand-maintained list
 * of "probably needed" symbols is wrong in both directions at once: it omits
 * glyphs real formulas need (a silent visual defect, since a missing outline
 * still advances the pen) and carries glyphs nothing uses. Instead this runs
 * the real kernel and the real emit layer over a corpus and records exactly
 * which `(face, codepoint)` pairs were asked for.
 *
 * Coverage is therefore a property of the corpus. `--report` prints what a
 * given corpus demands without writing anything, and the emitter reports every
 * miss in `EmitResult.missing`, so a gap is observable rather than silent.
 *
 * Usage:
 *   bun run scripts/subset-glyphs.ts [--corpus <file>] [--out <file>] [--report]
 *
 *   --corpus  newline-delimited TeX, one formula per line. Defaults to the
 *             built-in corpus below.
 *   --out     output path. Defaults to `src/glyphs/glyphs.subset.json`.
 *   --report  print the demand table and exit without writing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { emitSVG } from '../src/emit/svg';
import { layout } from '../src/layout';

/**
 * Default corpus.
 *
 * Chosen to exercise each structural feature the emit layer handles rather than
 * to be a wide sample of mathematics: fractions, radicals with and without an
 * index, big operators with limits, stretchy delimiters, matrices, accents,
 * the alternate alphabets, and text mode. Every one is validated against real
 * KaTeX in a browser, so this doubles as the correctness corpus.
 */
const DEFAULT_CORPUS = [
  // Plain symbols and arithmetic.
  'x',
  'x + y - z',
  'x^2 + y^2 = z^2',
  'a_1 + a_2 + \\cdots + a_n',
  '2 \\times 3 \\div 4 \\pm 5',
  'x < y \\le z \\ne w \\ge v > u',
  // Fractions and radicals.
  '\\frac{a}{b}',
  '\\frac{1}{1 + \\frac{1}{1 + x}}',
  '\\sqrt{x}',
  '\\sqrt[3]{x}',
  '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '\\binom{n}{k}',
  // Big operators, limits, functions.
  '\\sum_{i=1}^{n} i',
  '\\prod_{k=0}^{m} a_k',
  '\\int_0^1 x^2 \\, dx',
  '\\oint_C \\vec{F} \\cdot d\\vec{r}',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x}',
  '\\log x + \\ln y + \\exp z',
  '\\max(a, b) \\min(c, d)',
  // Delimiters.
  '\\left( \\frac{a}{b} \\right)',
  '\\left[ \\frac{a}{b} \\right]',
  '\\left\\{ x : x > 0 \\right\\}',
  '\\left| \\frac{a}{b} \\right|',
  '\\langle x, y \\rangle',
  // Matrices and arrays.
  '\\begin{matrix} a & b \\\\ c & d \\end{matrix}',
  '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}',
  '\\begin{bmatrix} x \\\\ y \\end{bmatrix}',
  // Accents, over/underlines.
  '\\hat{x} \\tilde{y} \\vec{z}',
  '\\bar{x} \\dot{y} \\ddot{z}',
  '\\overline{AB}',
  '\\underline{x}',
  // Greek, both cases, plus the variant forms TeX provides separately.
  '\\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta',
  '\\iota\\kappa\\lambda\\mu\\nu\\xi\\pi\\rho',
  '\\sigma\\tau\\upsilon\\phi\\chi\\psi\\omega',
  '\\Gamma\\Delta\\Theta\\Lambda\\Xi\\Pi\\Sigma\\Upsilon\\Phi\\Psi\\Omega',
  '\\varepsilon\\vartheta\\varpi\\varrho\\varsigma\\varphi',
  // Bold and upright Greek reach different faces again.
  '\\mathbf{\\alpha\\beta\\gamma}',
  // Alternate alphabets, each of which routes to a distinct font face.
  // Sampling a few letters per alphabet would produce a whitelist that renders
  // the sampled letters and silently drops the rest, so ask for the whole
  // range each face actually provides. `\mathbb` and `\mathcal` are
  // uppercase-only in KaTeX's fonts.
  '\\mathbb{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathcal{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathfrak{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathfrak{abcdefghijklmnopqrstuvwxyz}',
  '\\mathsf{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathsf{abcdefghijklmnopqrstuvwxyz}',
  '\\mathsf{0123456789}',
  '\\mathtt{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathtt{abcdefghijklmnopqrstuvwxyz}',
  '\\mathtt{0123456789}',
  '\\mathbf{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathbf{abcdefghijklmnopqrstuvwxyz}',
  '\\mathbf{0123456789}',
  '\\mathit{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\mathit{abcdefghijklmnopqrstuvwxyz}',
  // Text mode and punctuation.
  '\\text{hello world}',
  '\\text{if } x > 0 \\text{ then } y',
  // Set theory and logic.
  'A \\cup B \\cap C \\subset D \\in E \\notin F',
  '\\forall x \\exists y \\neg p \\land q \\lor r',
  '\\emptyset \\infty \\partial \\nabla',
  // Arrows.
  'a \\to b \\rightarrow c \\Rightarrow d \\leftrightarrow e',
  // Calculus and physics staples.
  '\\frac{\\partial f}{\\partial x}',
  "\\frac{d}{dx} f(x) = f'(x)",
  'e^{i\\pi} + 1 = 0',
  '\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\epsilon_0}',
  // Digits in every position, so no numeral is missed.
  '0123456789',
  'x_{0123456789}^{0123456789}',
  // The full Latin alphabet in math italic, both cases.
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '\\text{abcdefghijklmnopqrstuvwxyz}',
  '\\text{ABCDEFGHIJKLMNOPQRSTUVWXYZ}',
  '\\text{0123456789 .,;:!?()[]-+*/=}',
];

interface Demand {
  /** face -> set of codepoints. */
  byFont: Map<string, Set<number>>;
  /** Formulas that failed to lay out at all. */
  failures: { tex: string; error: string }[];
  /** Glyphs requested but absent from the full table. */
  missing: Set<string>;
}

/** Runs the kernel and emit layer over a corpus, recording glyph demand. */
function collectDemand(corpus: readonly string[]): Demand {
  const byFont = new Map<string, Set<number>>();
  const failures: { tex: string; error: string }[] = [];
  const missing = new Set<string>();

  for (const tex of corpus) {
    let result;
    try {
      result = emitSVG(layout(tex));
    } catch (error) {
      failures.push({ tex, error: (error as Error).message.slice(0, 160) });
      continue;
    }
    for (const p of result.placements) {
      let set = byFont.get(p.font);
      if (!set) {
        set = new Set();
        byFont.set(p.font, set);
      }
      set.add(p.code);
    }
    for (const m of result.missing) {
      missing.add(`${m}  <- ${tex}`);
    }
  }

  return { byFont, failures, missing };
}

function main(): void {
  const args = process.argv.slice(2);
  const pkgRoot = resolve(import.meta.dir, '..');

  const corpusIdx = args.indexOf('--corpus');
  const corpus =
    corpusIdx >= 0
      ? readFileSync(resolve(args[corpusIdx + 1]), 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'))
      : DEFAULT_CORPUS;

  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx >= 0 ? resolve(args[outIdx + 1]) : join(pkgRoot, 'src/glyphs/glyphs.subset.json');

  const fullPath = join(pkgRoot, 'src/glyphs/glyphs.json');
  // Read once and keep the bytes: every figure below is derived from this single
  // read rather than a later `statSync`/`readFileSync` of the same path. Checking
  // for existence first and reading afterwards is a time-of-check/time-of-use
  // gap, and re-reading for the size and the gzip could report three mutually
  // inconsistent numbers if the generator ran concurrently.
  let fullBytes: Buffer;
  try {
    fullBytes = readFileSync(fullPath);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no full table' : String(err);
    console.error(
      `subset-glyphs: ${reason} at ${fullPath}\n` +
        `Run \`bun run scripts/generate-glyphs.ts\` first.`,
    );
    process.exit(1);
  }
  const full = JSON.parse(fullBytes.toString('utf8')) as {
    unitsPerEm: Record<string, number>;
    glyphs: Record<string, Record<string, { path: string; advance: number }>>;
  };

  const demand = collectDemand(corpus);

  if (demand.failures.length > 0) {
    console.error(`subset-glyphs: ${demand.failures.length} formula(s) failed to lay out:`);
    for (const f of demand.failures) {
      console.error(`  ${f.tex}\n    ${f.error}`);
    }
    // A formula that does not lay out contributes no demand, so its glyphs
    // would be silently dropped from the subset. Refuse rather than ship a
    // whitelist with an unexplained hole.
    process.exit(1);
  }

  if (demand.missing.size > 0) {
    console.error(
      `subset-glyphs: ${demand.missing.size} glyph(s) demanded but absent from the full table:`,
    );
    for (const m of [...demand.missing].sort()) {
      console.error(`  ${m}`);
    }
    process.exit(1);
  }

  // Build the subset, preserving the full table's shape so the runtime accessor
  // is identical either way.
  const subset: typeof full = { unitsPerEm: {}, glyphs: {} };
  let kept = 0;
  const fonts = [...demand.byFont.keys()].sort();
  for (const font of fonts) {
    const codes = [...demand.byFont.get(font)!].sort((a, b) => a - b);
    subset.unitsPerEm[font] = full.unitsPerEm[font];
    subset.glyphs[font] = {};
    for (const code of codes) {
      const g = full.glyphs[font]?.[String(code)];
      if (!g) {
        console.error(`subset-glyphs: ${font} U+${code.toString(16)} missing from full table`);
        process.exit(1);
      }
      subset.glyphs[font][String(code)] = g;
      kept++;
    }
  }

  if (args.includes('--report')) {
    console.log(`corpus formulas : ${corpus.length}`);
    console.log(`faces demanded  : ${fonts.length} of ${Object.keys(full.glyphs).length}`);
    console.log(`glyphs demanded : ${kept}`);
    console.log('');
    for (const font of fonts) {
      const n = demand.byFont.get(font)!.size;
      const avail = Object.keys(full.glyphs[font] ?? {}).length;
      console.log(`  ${font.padEnd(20)} ${String(n).padStart(4)} / ${String(avail).padStart(4)}`);
    }
    return;
  }

  const json = JSON.stringify(subset);
  writeFileSync(outPath, json);

  const fullSize = fullBytes.byteLength;
  const subSize = json.length;
  const fullGz = gzipSync(fullBytes, { level: 9 }).length;
  const subGz = gzipSync(Buffer.from(json), { level: 9 }).length;

  console.log(`subset-glyphs: ${kept} glyphs across ${fonts.length} faces -> ${outPath}`);
  console.log(`  raw   ${subSize} B  (full ${fullSize} B, ${pct(subSize, fullSize)})`);
  console.log(`  gzip  ${subGz} B  (full ${fullGz} B, ${pct(subGz, fullGz)})`);

  // A subset that saves nothing means the corpus demands almost everything,
  // which is a signal about the corpus rather than a build failure.
  if (subSize > fullSize * 0.9) {
    console.warn(
      `subset-glyphs: warning - subset is ${pct(subSize, fullSize)} of the full table, ` +
        `so the whitelist is buying little. Check the corpus.`,
    );
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;
}

main();

export { collectDemand, DEFAULT_CORPUS };
