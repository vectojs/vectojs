/**
 * Phase 1 size and latency measurement.
 *
 * This script exists to convert the size *estimate* in
 * `vectojs-docs/forge/decisions/math-engine-2026-08.md` into a *measurement*,
 * because the decision's revisit trigger depends on it: if the kernel plus emit
 * layer exceeds ~200 KB gzip, the decision reopens.
 *
 * What is measured, and why it is measured this way:
 *
 * - **Minified and gzipped, never raw source.** Raw source size is dominated by
 *   comments and type annotations, both of which vanish on bundling, so it
 *   overstates by a wide margin. The vendor step reports a 6.3% raw reduction
 *   for removing 157 MathML sites, which is meaningless as a shipping figure.
 * - **Bundled by `bun build --minify --target browser`**, which is what a
 *   consumer's bundler does. Measuring individual files ignores tree shaking.
 * - **Broken out by part**, because the parts have very different fates: the
 *   glyph table is the free variable a whitelist controls, while the kernel is
 *   fixed by what KaTeX needs to parse and lay out.
 * - **Against the real baseline**: the `mathjax-full` chunk this replaces, built
 *   the same way in the same tree, rather than the figure recorded in the
 *   decision doc. The doc's own provenance section notes its probe directories
 *   no longer exist, so that number is not currently reproducible in place.
 *
 * Usage: bun run scripts/measure.ts [--keep] [--json <file>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

interface Sizes {
  raw: number;
  gzip: number;
  brotli: number;
}

function sizes(buf: Buffer | string): Sizes {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return {
    raw: b.byteLength,
    // Level 9 so the number is the best a static asset pipeline would achieve,
    // not whatever the default happens to be.
    gzip: gzipSync(b, { level: 9 }).byteLength,
    brotli: brotliCompressSync(b).byteLength,
  };
}

/** Bundles an entry point the way a consumer's bundler would. */
function bundle(entry: string, outDir: string, label: string): Buffer {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'bun',
    [
      'build',
      entry,
      '--minify',
      '--target',
      'browser',
      '--format',
      'esm',
      '--outfile',
      join(outDir, `${label}.js`),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return readFileSync(join(outDir, `${label}.js`));
}

function fmtKB(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

function row(label: string, s: Sizes, ofGzip?: number): string {
  const pct = ofGzip ? ` ${((s.gzip / ofGzip) * 100).toFixed(0)}%`.padStart(6) : '';
  return `${label.padEnd(34)} ${fmtKB(s.raw).padStart(10)} ${fmtKB(s.gzip).padStart(10)} ${fmtKB(
    s.brotli,
  ).padStart(10)}${pct}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pkgRoot = resolve(import.meta.dir, '..');
  const work = mkdtempSync(join(tmpdir(), 'vectojs-tex-measure-'));
  const keep = args.includes('--keep');

  const report: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    bundler: execFileSync('bun', ['--version']).toString().trim(),
  };

  try {
    // ---- Part 1: the whole engine, as a consumer would import it -----------
    const engineEntry = join(work, 'engine-entry.ts');
    writeFileSync(
      engineEntry,
      `import { layout } from ${JSON.stringify(join(pkgRoot, 'src/layout.ts'))};\n` +
        `import { emitSVG } from ${JSON.stringify(join(pkgRoot, 'src/emit/svg.ts'))};\n` +
        `export function typeset(tex: string) { return emitSVG(layout(tex)); }\n` +
        `globalThis.__typeset = typeset;\n`,
    );
    const engine = bundle(engineEntry, work, 'engine');
    const engineSizes = sizes(engine);

    // ---- Part 2: kernel + emit with the glyph table excluded ---------------
    // The glyph table is a JSON import, so the bundler inlines it. Measuring
    // the code alone requires stubbing it, and the stub must keep the same
    // shape or tree shaking will remove code that really ships.
    const stubDir = join(work, 'stub');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, 'glyphs.json'),
      JSON.stringify({
        unitsPerEm: { 'Main-Regular': 1000 },
        glyphs: { 'Main-Regular': {} },
      }),
    );
    const codeEntry = join(work, 'code-entry.ts');
    const glyphTableSrc = readFileSync(join(pkgRoot, 'src/emit/glyphTable.ts'), 'utf8');
    const patchedGlyphTable = glyphTableSrc.replace(
      /from ['"]\.\.\/glyphs\/glyphs(?:\.subset)?\.json['"]/,
      `from ${JSON.stringify(join(stubDir, 'glyphs.json'))}`,
    );
    if (patchedGlyphTable === glyphTableSrc) {
      throw new Error('measure: could not redirect the glyph table import; check glyphTable.ts');
    }
    const shadowDir = join(work, 'shadow', 'emit');
    mkdirSync(shadowDir, { recursive: true });
    // The shadowed copies live outside the package, so every relative import in
    // them has to be rewritten to an absolute path against the real tree.
    // Copying a file to a temp directory and leaving `../kernel/domTree` alone
    // simply fails to resolve.
    const absolutise = (src: string, fromDir: string): string =>
      src.replace(
        /from ['"](\.[^'"]*)['"]/g,
        (_m, spec: string) => `from ${JSON.stringify(resolve(fromDir, spec))}`,
      );

    writeFileSync(
      join(shadowDir, 'glyphTable.ts'),
      absolutise(patchedGlyphTable, join(pkgRoot, 'src/emit')),
    );
    // Shadow only `glyphTable`; everything else must resolve to the real tree
    // so the measurement covers the code that actually ships.
    // A plain string replace, not a RegExp: an absolute path is full of regex
    // metacharacters and building a pattern out of one silently fails to match.
    const svgSrc = absolutise(
      readFileSync(join(pkgRoot, 'src/emit/svg.ts'), 'utf8'),
      join(pkgRoot, 'src/emit'),
    ).replace(
      JSON.stringify(join(pkgRoot, 'src/emit/glyphTable')),
      JSON.stringify(join(shadowDir, 'glyphTable.ts')),
    );
    if (!svgSrc.includes(shadowDir)) {
      throw new Error('measure: failed to shadow the glyph table in svg.ts');
    }
    writeFileSync(join(shadowDir, 'svg.ts'), svgSrc);
    writeFileSync(
      codeEntry,
      `import { layout } from ${JSON.stringify(join(pkgRoot, 'src/layout.ts'))};\n` +
        `import { emitSVG } from ${JSON.stringify(join(shadowDir, 'svg.ts'))};\n` +
        `globalThis.__typeset = (t: string) => emitSVG(layout(t));\n`,
    );
    const code = bundle(codeEntry, work, 'code');
    const codeSizes = sizes(code);

    // ---- Part 3: the glyph tables on their own ----------------------------
    const fullTablePath = join(pkgRoot, 'src/glyphs/glyphs.json');
    const subsetPath = join(pkgRoot, 'src/glyphs/glyphs.subset.json');
    const fullTable = existsSync(fullTablePath) ? sizes(readFileSync(fullTablePath)) : null;
    const subsetTable = existsSync(subsetPath) ? sizes(readFileSync(subsetPath)) : null;

    // ---- Part 4: the MathJax baseline this replaces ------------------------
    // Built in this tree with this bundler, so it is comparable rather than
    // quoted from a record whose probe directory no longer exists.
    let mathjax: Sizes | null = null;
    // `mathjax-full` is a dependency of `@vectojs/markdown`, so bun installs it
    // into `packages/markdown/node_modules`. An entry point in a temp directory
    // cannot resolve it, so write the entry inside that package instead and
    // remove it afterwards.
    const mjHost = resolve(pkgRoot, '../markdown');
    const mjEntry = join(mjHost, `.measure-mathjax-entry.${process.pid}.ts`);
    writeFileSync(
      mjEntry,
      `import { mathjax } from 'mathjax-full/js/mathjax.js';\n` +
        `import { TeX } from 'mathjax-full/js/input/tex.js';\n` +
        `import { SVG } from 'mathjax-full/js/output/svg.js';\n` +
        `import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';\n` +
        `import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';\n` +
        `import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';\n` +
        `globalThis.__mj = { mathjax, TeX, SVG, liteAdaptor, RegisterHTMLHandler, AllPackages };\n`,
    );
    try {
      mathjax = sizes(bundle(mjEntry, work, 'mathjax'));
    } catch (error) {
      console.warn(
        `measure: could not bundle the MathJax baseline (${
          (error as Error).message.split('\n')[0]
        }). Run \`bun install\` so @vectojs/markdown's deps are present.`,
      );
    } finally {
      rmSync(mjEntry, { force: true });
    }

    // ---- Part 5: typeset latency ------------------------------------------
    // Reported for information only. It is a **JavaScriptCore** figure because
    // this runs under Bun, so it is not a quotable browser number; the point of
    // the decision was payload, and the record already establishes that cold
    // typeset is not the hot path.
    const { layout } = await importFresh(join(pkgRoot, 'src/layout.ts'));
    const { emitSVG } = await importFresh(join(pkgRoot, 'src/emit/svg.ts'));
    const LATENCY_CORPUS = [
      'x^2 + y^2 = z^2',
      '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
      '\\sum_{i=1}^{n} i',
      '\\int_0^1 x^2 \\, dx',
      '\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}',
    ];
    // Warm up so the figure is steady-state rather than first-call JIT.
    for (let i = 0; i < 50; i++) {
      for (const tex of LATENCY_CORPUS) emitSVG(layout(tex));
    }
    const latency: Record<string, number> = {};
    for (const tex of LATENCY_CORPUS) {
      const N = 200;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) emitSVG(layout(tex));
      latency[tex] = (performance.now() - t0) / N;
    }

    // ---- Report -----------------------------------------------------------
    const trigger = 200 * 1024;
    console.log('');
    console.log(
      `${'part'.padEnd(34)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)} ${'brotli'.padStart(10)}`,
    );
    console.log('-'.repeat(70));
    console.log(row('kernel + emit (no glyphs)', codeSizes));
    if (subsetTable) console.log(row(`glyph subset`, subsetTable));
    console.log(row('engine, shipped (code + subset)', engineSizes));
    if (fullTable) console.log(row('glyph table, all 20 faces', fullTable));
    if (mathjax) {
      console.log('-'.repeat(70));
      console.log(row('mathjax-full AllPackages + SVG', mathjax));
    }
    console.log('');

    console.log(`Reopen trigger: kernel + emit above ${fmtKB(trigger)} gzip.`);
    console.log(
      `  kernel + emit = ${fmtKB(codeSizes.gzip)} gzip -> ${
        codeSizes.gzip > trigger ? 'EXCEEDED, decision reopens' : 'under the trigger'
      } (${((codeSizes.gzip / trigger) * 100).toFixed(0)}% of it)`,
    );
    if (mathjax) {
      console.log(
        `  vs MathJax: ${(mathjax.gzip / engineSizes.gzip).toFixed(2)}x smaller gzip, ` +
          `${(mathjax.raw / engineSizes.raw).toFixed(2)}x smaller raw`,
      );
    }
    console.log('');
    console.log('Typeset latency (JavaScriptCore under Bun, NOT a quotable browser figure):');
    for (const [tex, ms] of Object.entries(latency)) {
      console.log(`  ${ms.toFixed(3)} ms  ${tex}`);
    }

    Object.assign(report, {
      codeOnly: codeSizes,
      glyphSubset: subsetTable,
      engineShipped: engineSizes,
      glyphTableFull: fullTable,
      mathjaxBaseline: mathjax,
      reopenTriggerGzip: trigger,
      triggerExceeded: codeSizes.gzip > trigger,
      latencyMsJavaScriptCore: latency,
    });

    const jsonIdx = args.indexOf('--json');
    if (jsonIdx >= 0) {
      const out = resolve(args[jsonIdx + 1]);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${out}`);
    }
  } finally {
    if (keep) {
      console.log(`\nbuild artifacts kept at ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/** Imports a module fresh, bypassing any cached instance. */
async function importFresh(path: string): Promise<any> {
  return import(`${path}?t=${Date.now()}`);
}

await main();
