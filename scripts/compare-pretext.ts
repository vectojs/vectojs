/**
 * Vecto-UI LayoutEngine vs pretext — text-layout accuracy & throughput comparison.
 *
 * Runs in headless Chrome (global Playwright + system google-chrome-stable). For
 * each corpus/font it establishes a browser-truth line count via the real DOM
 * (`Range.getClientRects().length`), then compares:
 *   - pretext            prepare()+layout()  (canvas measureText based)
 *   - vecto fallback     LayoutEngine with empty atlas (fontSize*0.5 widths)
 *   - vecto + atlas      LayoutEngine fed real measureText widths
 * reporting line-count error vs DOM truth and layout throughput.
 *
 * vecto-ui core and pretext are bundled to browser IIFE via Bun.build (no vite,
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
const PRETEXT = process.env.VECTO_PRETEXT_PATH ?? resolve(REPO, '../tmp/pretext');

function loadPlaywright() {
  const pkgDir = dirname(execSync('readlink -f "$(which playwright)"').toString().trim());
  return createRequire(join(pkgDir, 'package.json'))(pkgDir) as typeof import('playwright');
}
const chromePath = () => execSync('readlink -f "$(which google-chrome-stable)"').toString().trim();

async function bundleIIFE(entry: string): Promise<string> {
  const out = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
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
  { id: 'ja-rashomon / sans', file: 'ja-rashomon.txt', font: '16px sans-serif', fontSize: 16 },
  { id: 'ar-bukhala / serif', file: 'ar-al-bukhala.txt', font: '16px serif', fontSize: 16 },
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
    `import { LayoutEngine } from ${JSON.stringify(join(REPO, 'packages/core/src/index.ts'))};\n` +
      `(globalThis).VectoLayout = LayoutEngine;\n`,
  );
  writeFileSync(
    ptWrap,
    `import { prepare, layout } from ${JSON.stringify(join(PRETEXT, 'src/layout.ts'))};\n` +
      `(globalThis).Pretext = { prepare, layout };\n`,
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
    atlasLines: number;
    pretextPrepMs: number;
    pretextLayoutMs: number;
    vectoLayoutMs: number;
  };
  let results: Row[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addScriptTag({ content: coreJS });
    await page.addScriptTag({ content: ptJS });
    results = await page.evaluate(
      async ({ cases, maxWidth }) => {
        await (document as Document & { fonts: FontFaceSet }).fonts.ready;
        const g = globalThis as typeof globalThis & {
          VectoLayout: new (
            w: number,
            h: number,
          ) => {
            layoutText: (
              t: string,
              atlas: Record<string, unknown>,
              fs: number,
            ) => { nodes: { y: number }[] };
          };
          Pretext: {
            prepare: (t: string, f: string) => unknown;
            layout: (p: unknown, w: number, lh: number) => { lineCount: number };
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
        const time = (fn: () => void, reps: number) => {
          fn(); // warm
          const samples: number[] = [];
          for (let i = 0; i < reps; i++) {
            const t = performance.now();
            fn();
            samples.push(performance.now() - t);
          }
          return median(samples);
        };

        const out = [];
        for (const c of cases as { id: string; text: string; font: string; fontSize: number }[]) {
          const lineHeight = c.fontSize * 1.5;
          const domLines = domLineCount(c.text, c.font, maxWidth);
          const atlas = buildAtlas(c.text, c.font, c.fontSize);

          const prepared = g.Pretext.prepare(c.text, c.font);
          const pretextLines = g.Pretext.layout(prepared, maxWidth, lineHeight).lineCount;

          const fallbackLines = distinctLines(
            new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, {}, c.fontSize).nodes,
          );
          const atlasLines = distinctLines(
            new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, atlas, c.fontSize).nodes,
          );

          const pretextPrepMs = time(() => g.Pretext.prepare(c.text, c.font), 20);
          const pretextLayoutMs = time(() => g.Pretext.layout(prepared, maxWidth, lineHeight), 50);
          const vectoLayoutMs = time(
            () => new g.VectoLayout(maxWidth, 1e7).layoutText(c.text, atlas, c.fontSize),
            20,
          );

          out.push({
            id: c.id,
            chars: c.text.length,
            domLines,
            pretextLines,
            fallbackLines,
            atlasLines,
            pretextPrepMs: +pretextPrepMs.toFixed(3),
            pretextLayoutMs: +pretextLayoutMs.toFixed(3),
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
  const acc = [
    `Accuracy — line count vs DOM ground truth (maxWidth=${MAX_WIDTH}px, ${CHAR_LIMIT} char cap):`,
    '',
    '| Case | chars | DOM truth | pretext | vecto (atlas) | vecto (fallback) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.chars} | ${r.domLines} | ${err(r.pretextLines, r.domLines)} | ${err(r.atlasLines, r.domLines)} | ${err(r.fallbackLines, r.domLines)} |`,
    ),
  ];
  const perf = [
    '',
    'Throughput — median ms per call:',
    '',
    '| Case | pretext prepare | pretext layout (hot) | vecto layoutText (full) |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) => `| ${r.id} | ${r.pretextPrepMs} | ${r.pretextLayoutMs} | ${r.vectoLayoutMs} |`,
    ),
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
