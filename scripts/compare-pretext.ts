/**
 * VectoJS LayoutEngine vs pretext — text-layout accuracy & throughput comparison.
 *
 * Runs in headless Chrome (global Playwright + system google-chrome-stable). For
 * each corpus/font it establishes a browser-truth line count via the real DOM
 * (`Range.getClientRects().length`), then compares:
 *   - pretext            prepare()+layout()  (canvas measureText based)
 *   - vecto fallback     LayoutEngine with empty atlas (fontSize*0.5 widths)
 *   - vecto + atlas      LayoutEngine fed real measureText widths
 * reporting line-count error vs DOM truth and layout throughput.
 *
 * Throughput is reported as cold/hot pairs, because the two libraries split the
 * work the same way and only matching halves mean anything:
 *
 *   cold  pretext.prepare()  <->  LayoutEngine.prepare()
 *   hot   pretext.layout()   <->  LayoutEngine.measurePrepared()
 *
 * `measurePrepared()` is the real counterpart of pretext's hot path: both walk
 * word/segment widths and return lineCount+height without positioning a glyph.
 * `layoutPrepared()` (positions every glyph) and `layoutText()` (cold+hot in one
 * call) have no pretext counterpart and are printed in a separate table that is
 * explicitly not a comparison.
 *
 * This split is the point. Until 2026-08-04 the script timed our combined
 * `layoutText()` against pretext's hot-only `layout()` — a cold+hot path against
 * a hot one — which inflated the gap and was flagged in
 * `vectojs-docs/testing-catalog.md` (A6) as "not yet apples-to-apples ... fix
 * that before quoting a speed number publicly".
 *
 * vectojs core and pretext are bundled to browser IIFE via Bun.build (no vite,
 * no deps) and injected. Corpora come from the local pretext checkout.
 *
 * Usage:  bun run scripts/compare-pretext.ts
 * Output: markdown table on stdout + JSON at scripts/.compare-results.json
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/**
 * Local pretext checkout, for its `src/layout.ts` and `corpora/`.
 *
 * Defaults to the workspace's read-only third-party clone. The old default was
 * `../tmp/pretext`, which no longer exists — `tmp/` is per-task scratch, and the
 * reference clones moved to `references/`. Override with `VECTO_PRETEXT_PATH`.
 */
const PRETEXT = process.env.VECTO_PRETEXT_PATH ?? resolve(REPO, '../references/text/pretext');

function loadPlaywright() {
  const pkgDir = dirname(execSync('readlink -f "$(which playwright)"').toString().trim());
  return createRequire(join(pkgDir, 'package.json'))(pkgDir) as typeof import('playwright');
}
const chromePath = () => execSync('readlink -f "$(which google-chrome-stable)"').toString().trim();

async function bundleIIFE(entry: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'iife',
  });
  if (!out.success) throw new Error(`Bun.build failed for ${entry}: ${out.logs.join('\n')}`);
  return out.outputs[0].text();
}

// Each case: a corpus slice + a CSS font. fontSize must match the px in `font`.
const CASES = [
  {
    id: 'en-gatsby / monospace',
    file: 'en-gatsby-opening.txt',
    font: '16px monospace',
    fontSize: 16,
  },
  {
    id: 'en-gatsby / serif',
    file: 'en-gatsby-opening.txt',
    font: '16px Georgia, serif',
    fontSize: 16,
  },
  {
    id: 'ja-rashomon / sans',
    file: 'ja-rashomon.txt',
    font: '16px sans-serif',
    fontSize: 16,
  },
  {
    id: 'ar-bukhala / serif',
    file: 'ar-al-bukhala.txt',
    font: '16px serif',
    fontSize: 16,
  },
];
const MAX_WIDTH = 600;
const CHAR_LIMIT = 2000;

function readCorpus(file: string): string {
  return readFileSync(join(PRETEXT, 'corpora', file), 'utf8')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAR_LIMIT);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'vecto-compare-'));
  const coreWrap = join(tmp, 'core.ts');
  const ptWrap = join(tmp, 'pt.ts');
  writeFileSync(
    coreWrap,
    `import { LayoutEngine, createCanvasMeasurer } from ${JSON.stringify(join(REPO, 'packages/core/src/index.ts'))};\n` +
      `(globalThis).VectoLayout = LayoutEngine;\n` +
      `(globalThis).VectoMeasurer = createCanvasMeasurer;\n`,
  );
  writeFileSync(
    ptWrap,
    `import { prepare, layout, clearCache } from ${JSON.stringify(join(PRETEXT, 'src/layout.ts'))};\n` +
      `(globalThis).Pretext = { prepare, layout, clearCache };\n`,
  );
  const [coreJS, ptJS] = await Promise.all([bundleIIFE(coreWrap), bundleIIFE(ptWrap)]);

  const cases = CASES.map((c) => ({ ...c, text: readCorpus(c.file) }));

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath(),
    args: ['--no-sandbox'],
  });
  type Row = {
    id: string;
    chars: number;
    domLines: number;
    pretextLines: number;
    fallbackLines: number;
    measuredLines: number;
    atlasLines: number;
    /** Line count from the hot `measurePrepared()` arm; must equal `atlasLines`. */
    measuredPreparedLines: number;
    pretextPrepMs: number;
    pretextLayoutMs: number;
    vectoPrepMs: number;
    vectoMeasureMs: number;
    vectoLayoutPreparedMs: number;
    /** Combined cold+hot. Not comparable to pretext's hot arm. */
    vectoLayoutMs: number;
  };
  let results: Row[] = [];

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.addScriptTag({ content: coreJS });
    await page.addScriptTag({ content: ptJS });
    results = await page.evaluate(
      async ({ cases, maxWidth }) => {
        await (document as Document & { fonts: FontFaceSet }).fonts.ready;
        const g = globalThis as typeof globalThis & {
          VectoLayout: new (
            w: number,
            h: number,
            measurer?: unknown,
          ) => {
            layoutText: (
              t: string,
              atlas: Record<string, unknown>,
              fs: number,
            ) => { nodes: { y: number }[] };
            // The cold/hot split, so the throughput arms can be matched against
            // pretext's own `prepare()` / `layout()` split instead of timing our
            // combined path against their hot one.
            prepare: (t: string, atlas: Record<string, unknown>, fs: number) => unknown;
            layoutPrepared: (p: unknown) => { nodes: { y: number }[] };
            measurePrepared: (p: unknown) => {
              lineCount: number;
              height: number;
            };
          };
          VectoMeasurer: (fontFamily?: string, baseSize?: number) => unknown;
          Pretext: {
            prepare: (t: string, f: string) => unknown;
            layout: (p: unknown, w: number, lh: number) => { lineCount: number };
            /** Drops pretext's segment/measurement caches so a cold arm is cold. */
            clearCache: () => void;
          };
        };

        // Real browser layout = ground truth (one client rect per visual line).
        const domLineCount = (text: string, font: string, width: number) => {
          const div = document.createElement('div');
          div.style.cssText = `position:absolute;visibility:hidden;width:${width}px;font:${font};white-space:normal;word-break:normal;letter-spacing:0`;
          div.textContent = text;
          document.body.appendChild(div);
          const range = document.createRange();
          range.selectNodeContents(div);
          const lines = range.getClientRects().length;
          div.remove();
          return lines;
        };

        // measureText-based atlas so LayoutEngine gets real per-glyph widths.
        const buildAtlas = (text: string, font: string, fontSize: number) => {
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.font = font;
          const atlas: Record<string, { width: number; baseSize: number; ast: unknown }> = {};
          for (const ch of new Set([...text, ' '])) {
            atlas[ch] = {
              width: ctx.measureText(ch).width,
              baseSize: fontSize,
              ast: { paths: [] },
            };
          }
          return atlas;
        };

        const distinctLines = (nodes: { y: number }[]) =>
          new Set(nodes.map((n) => Math.round(n.y))).size;
        const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
        /**
         * Median ms per call, measured over batches rather than single calls.
         *
         * A batch is required, not a refinement: this page is not
         * cross-origin-isolated, so `performance.now()` is coarsened to 100 µs in
         * Chrome. Timing one call of a hot path that takes ~1 µs therefore reads
         * exactly `0.0` and the comparison silently becomes "0 vs 0". The old
         * single-call form only ever looked fine because the arm it timed
         * (`layoutText()`, cold+hot) was slow enough to clear the floor.
         *
         * `inner` is chosen so a batch lands well above the clock granularity,
         * then the total is divided back down to per-call.
         */
        const time = (fn: () => void, reps: number, inner = 200) => {
          fn(); // warm
          const samples: number[] = [];
          for (let i = 0; i < reps; i++) {
            const t = performance.now();
            for (let k = 0; k < inner; k++) fn();
            samples.push((performance.now() - t) / inner);
          }
          return median(samples);
        };

        const out = [];
        for (const c of cases as {
          id: string;
          text: string;
          font: string;
          fontSize: number;
        }[]) {
          const lineHeight = c.fontSize * 1.5;
          const domLines = domLineCount(c.text, c.font, maxWidth);
          const atlas = buildAtlas(c.text, c.font, c.fontSize);

          const prepared = g.Pretext.prepare(c.text, c.font);
          const pretextLines = g.Pretext.layout(prepared, maxWidth, lineHeight).lineCount;

          const fallbackLines = distinctLines(
            new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, {}, c.fontSize).nodes,
          );
          // Empty atlas + canvas measurer (the #1 fix): real per-glyph widths
          // for non-atlas text, family taken from the case's CSS font.
          const family = c.font.replace(/^\s*\d+(?:\.\d+)?px\s*/, '') || 'sans-serif';
          const measurer = g.VectoMeasurer(family, c.fontSize);
          const measuredLines = distinctLines(
            new g.VectoLayout(maxWidth, 1e7, measurer).layoutText(c.text, {}, c.fontSize).nodes,
          );
          const atlasLines = distinctLines(
            new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, atlas, c.fontSize).nodes,
          );

          // Throughput, split cold vs hot on BOTH sides so the pairs are
          // like-for-like. Timing our combined `layoutText()` against pretext's
          // hot-only `layout()` compared a cold+hot path with a hot one, which
          // made the gap look far larger than it is.
          //
          // The pairs that mean something:
          //   prepare()         <-> prepare()   (cold: shape + measure)
          //   measurePrepared() <-> layout()    (hot: lineCount + height only)
          //   layoutPrepared()  <-> (no pair)   (hot, but also positions glyphs)
          //
          // `measurePrepared()` is the true counterpart of pretext's `layout()`:
          // both walk word/segment widths and return lineCount+height without
          // positioning a glyph or allocating a node.
          // Both cold arms clear their own caches per call, or they are not cold.
          // pretext memoizes per-segment widths; we memoize the whole prepared
          // paragraph, so a repeated prepare() of identical text was a total cache
          // hit for us and only a partial one for pretext -- which is why this arm
          // read a flat 0 ms before and could not be compared to anything.
          const pretextPrepMs = time(
            () => {
              g.Pretext.clearCache();
              g.Pretext.prepare(c.text, c.font);
            },
            20,
            5,
          );
          const pretextLayoutMs = time(
            () => g.Pretext.layout(prepared, maxWidth, lineHeight),
            20,
            500,
          );

          // One engine, reused, so the constructor is not charged to every sample.
          const vectoEngine = new g.VectoLayout(maxWidth, 1e7);
          // A fresh engine is our cold cache: there is no public cache-clear, and
          // `prepare()` only drops the paragraph cache when the atlas identity
          // changes. The constructor is trivial next to shaping 2000 chars.
          const vectoPrepMs = time(
            () => {
              new g.VectoLayout(maxWidth, 1e7).prepare(c.text, atlas, c.fontSize);
            },
            20,
            5,
          );

          // Hot arms prepare ONCE outside the timer, exactly as `prepared` is
          // reused for pretext's hot arm above.
          const vectoPrepared = vectoEngine.prepare(c.text, atlas, c.fontSize);
          const vectoMeasureMs = time(() => vectoEngine.measurePrepared(vectoPrepared), 20, 500);
          const vectoLayoutPreparedMs = time(
            () => vectoEngine.layoutPrepared(vectoPrepared),
            20,
            20,
          );

          // Kept for continuity with earlier runs, and because it is what a caller
          // who lays out once and never resizes actually pays. NOT comparable to
          // pretext's hot arm, and labelled as such in the table.
          const vectoLayoutMs = time(
            () => new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, atlas, c.fontSize),
            20,
            5,
          );

          // The hot measure path must agree with the full path on line count, or
          // the fast arm is being credited for work it actually skipped.
          const measuredPreparedLines = vectoEngine.measurePrepared(vectoPrepared).lineCount;

          out.push({
            id: c.id,
            chars: c.text.length,
            domLines,
            pretextLines,
            fallbackLines,
            measuredLines,
            atlasLines,
            measuredPreparedLines,
            pretextPrepMs: +pretextPrepMs.toFixed(3),
            pretextLayoutMs: +pretextLayoutMs.toFixed(3),
            vectoPrepMs: +vectoPrepMs.toFixed(3),
            vectoMeasureMs: +vectoMeasureMs.toFixed(3),
            vectoLayoutPreparedMs: +vectoLayoutPreparedMs.toFixed(3),
            vectoLayoutMs: +vectoLayoutMs.toFixed(3),
          });
        }
        return out;
      },
      { cases, maxWidth: MAX_WIDTH },
    );
    await page.close();
  } finally {
    await browser.close();
  }

  const err = (n: number, truth: number) =>
    truth ? `${n} (${(((n - truth) / truth) * 100).toFixed(0)}%)` : `${n}`;
  // A hot arm that disagrees with the full path is not a faster way to do the
  // same work, it is a different (wrong) answer — so refuse to print a speed
  // number for it rather than quietly publishing an unearned win.
  const disagreements = results.filter((r) => r.measuredPreparedLines !== r.atlasLines);
  if (disagreements.length > 0) {
    const detail = disagreements
      .map((r) => `${r.id}: measurePrepared=${r.measuredPreparedLines} vs full=${r.atlasLines}`)
      .join('; ');
    throw new Error(
      `measurePrepared() disagreed with layoutText() on line count, so the hot-path ` +
        `timing is not measuring equivalent work: ${detail}`,
    );
  }

  const acc = [
    `Accuracy — line count vs DOM ground truth (maxWidth=${MAX_WIDTH}px, ${CHAR_LIMIT} char cap):`,
    '',
    '| Case | chars | DOM truth | pretext | vecto (atlas) | vecto (measurer) | vecto (0.5em fallback) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.chars} | ${r.domLines} | ${err(r.pretextLines, r.domLines)} | ${err(r.atlasLines, r.domLines)} | ${err(r.measuredLines, r.domLines)} | ${err(r.fallbackLines, r.domLines)} |`,
    ),
  ];
  const perf = [
    '',
    'Throughput — median ms per call:',
    '',
    '',
    'Cold path (shape + measure), like-for-like:',
    '',
    '| Case | pretext prepare | vecto prepare |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.pretextPrepMs} | ${r.vectoPrepMs} |`),
    '',
    'Hot path (lineCount + height, no glyph positioning) — this is the',
    'like-for-like speed comparison:',
    '',
    '| Case | pretext layout | vecto measurePrepared | ratio |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => {
      const ratio =
        r.pretextLayoutMs > 0
          ? (r.vectoMeasureMs / r.pretextLayoutMs).toFixed(2) + '\u00d7'
          : 'n/a';
      return `| ${r.id} | ${r.pretextLayoutMs} | ${r.vectoMeasureMs} | ${ratio} |`;
    }),
    '',
    'VectoJS paths with no pretext counterpart (it positions no glyphs and has',
    'no combined entry point), listed for completeness and NOT as a comparison:',
    '',
    '| Case | vecto layoutPrepared (hot, positions glyphs) | vecto layoutText (cold+hot) |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.vectoLayoutPreparedMs} | ${r.vectoLayoutMs} |`),
  ];
  const report = [...acc, ...perf].join('\n');
  console.log('\n' + report + '\n');
  writeFileSync(join(HERE, '.compare-results.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote ${join(HERE, '.compare-results.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
