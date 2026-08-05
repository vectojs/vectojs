// The transcript corpus for `markdown-transcript`, in its own module so it can be
// asserted on without importing `entry.ts` (which runs `main()` on import).
//
// Block weighting is MEASURED, not invented: `marked.lexer` over all 75 files of
// `vectojs-docs/content` (2,503 non-space top-level blocks, 562,883 chars) gives,
// by block count / by chars:
//
//   paragraph 37.4 / 35.7      hr          5.4 / 0.1
//   heading   30.4 /  5.6      blockquote  2.4 / 3.4
//   code      13.5 / 24.9      html        2.0 / 4.4
//   list       6.8 / 13.2      table       2.0 / 12.6
//
// The columns disagree sharply and it matters: `heading` is 30% of blocks but
// 5.6% of chars; `code` is 13.5% of blocks but 24.9%. This corpus matches the
// BLOCK-COUNT column, because reconciliation cost is per-block-event, and the
// bench reports the resulting char mix so the other axis stays auditable.
//
// `html` is omitted on purpose: only a `<svg>` block renders an entity, so that
// 2% is mostly comments and bare divs rendering nothing, and standing in an SVG
// would measure `SVGEntity` rasterisation instead of reconciliation.

/** Every turn varies its text so no cache can answer for a later turn. */
const heading = (t: number, n: number): string =>
  `${'#'.repeat(2 + (n % 3))} Section ${t}.${n}: reconciling a streamed tree\n\n`;

const paragraph = (t: number, n: number): string =>
  `Streaming turn ${t} paragraph ${n}. When the model emits Markdown one token ` +
  `at a time, the accumulated source is re-lexed on every chunk, and the ` +
  `reconciler decides whether the tail block can be updated in place or must be ` +
  `rebuilt from scratch. That decision is the whole cost of this benchmark.\n\n`;

const code = (t: number, n: number): string =>
  '```ts\n' +
  `// turn ${t}, block ${n}\n` +
  `const md = new Markdown(source${n}, { maxWidth: 820 });\n` +
  `for (const chunk of stream) {\n` +
  `  md.appendMarkdown(chunk);\n` +
  `}\n` +
  '```\n\n';

const list = (t: number, n: number): string =>
  `- turn ${t} item one for block ${n}\n` +
  `- the prefix match is a raw-string comparison\n` +
  `- only the trailing token may be updated in place\n` +
  `- everything after it is destroyed and rebuilt\n\n`;

const table = (t: number, n: number): string =>
  `| block ${n} | reuse | turn |\n` +
  `| --- | --- | --- |\n` +
  `| paragraph | in place | ${t} |\n` +
  `| table | append rows | ${t} |\n\n`;

const blockquote = (t: number, n: number): string =>
  `> Turn ${t} note ${n}: reuse is not an optimisation of last resort; a rebuild\n` +
  `> discards a whole subtree and re-measures every glyph in it.\n\n`;

const rule = (): string => '---\n\n';

// The literal fences are kept as separate concatenated strings so the LaTeX
// body stays a template literal without escaping a nested backtick run.
const math = (t: number, n: number): string =>
  // oxlint-disable-next-line eslint/no-useless-concat
  '```math\n' + `\\sum_{k=1}^{${n + 2}} \\frac{1}{k^${t + 2}} = \\zeta(${t + 2})\n` + '```\n\n';

/** A valid 8x8 PNG. Verified to decode in both Chromium and Firefox — an
 *  undecodable fixture reports as a permanent placeholder and looks like a bug. */
const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o' +
  '6GBFTEMLQkAe3tLAfuiUfAAAAAASUVORK5CYII=';

const figure = (t: number, n: number): string =>
  `Figure ${t}.${n}: ![reconciler timeline ${n}](${IMG}) caption text that keeps ` +
  `going after the image so the trailing run grows.\n\n`;

/**
 * One assistant turn: 27 blocks, block-weighted to the measured mix.
 *
 * 10 paragraph (37%), 8 heading (30%), 4 code (13.5%), 2 list (6.8%), 1 hr
 * (5.4% -> 1.5), 1 blockquote (2.4%), 1 table (2%).
 *
 * Math and one figure ride along from turn 2. Neither appears in the doc corpus
 * (it has no `math` fences, and its images are inline in paragraphs), but both
 * have shipped reuse paths and a real assistant answer does emit them, so
 * omitting them would leave two of the eight paths under test unmeasured. One of
 * each is the smallest honest inclusion.
 */
export function turn(t: number): string {
  const out: string[] = [];
  out.push(`## Turn ${t}\n\n`);
  for (let n = 0; n < 4; n++) {
    out.push(heading(t, n * 2));
    out.push(paragraph(t, n * 2));
    out.push(paragraph(t, n * 2 + 1));
    out.push(heading(t, n * 2 + 1));
    out.push(code(t, n));
    if (n === 0) out.push(list(t, n));
    if (n === 1) out.push(blockquote(t, n));
    if (n === 2) out.push(list(t, n));
    if (n === 3) out.push(table(t, n));
    if (n === 1 && t >= 2) out.push(math(t, n));
    if (n === 2 && t >= 2) out.push(figure(t, n));
  }
  out.push(paragraph(t, 90));
  out.push(paragraph(t, 91));
  out.push(rule());
  return out.join('');
}

export function transcript(turns: number): string {
  const out: string[] = [];
  for (let t = 0; t < turns; t++) out.push(turn(t));
  return out.join('');
}

/**
 * Split a document the way a stream delivers it.
 *
 * `token` approximates an LLM's SSE tokens — leading whitespace plus up to five
 * non-space chars — so a chunk lands mid-word and mid-construct as real output
 * does. Granularity dominates the result: measured on one 635-char document,
 * in-place updates go 141 (token) / 37 (16 chars) / 11 (48 chars) / 3 (sentence),
 * a 47x spread. The shapes in `markdown-stream-phases` use ~48 chars, so they
 * understate reuse work by about an order of magnitude against real SSE.
 */
export function chunkify(doc: string, granularity: string): string[] {
  // The trailing `\s+$` alternative is load-bearing: `\s*\S{1,5}` requires at
  // least one non-space char, so without it the document's final `\n\n` is
  // dropped and the last block never closes -- the stream would end
  // mid-construct and the bench would measure a different document than it
  // built. Pinned by the round-trip test.
  if (granularity === 'token') return doc.match(/\s*\S{1,5}|\s+$/g) ?? [];
  if (granularity === 'sentence') return doc.match(/[^.]*\.\s*|[^.]+$/g) ?? [];
  const n = Number(granularity);
  if (!Number.isFinite(n) || n < 1) throw new Error(`bad granularity: ${granularity}`);
  const out: string[] = [];
  for (let i = 0; i < doc.length; i += n) out.push(doc.slice(i, i + n));
  return out;
}
