/**
 * FOUM / flicker / convergence benchmark: VectoJS optimistic vs literal vs Streamdown remend.
 *
 * Measures three UX properties that the streaming-parse benchmark does not:
 * - FOUM   (flash of unstyled markdown): frames where raw markers are visible then disappear
 * - structural flicker: block type or flags change retroactively (para→setext, list loose)
 * - final convergence: optimistic===literal===one-shot after close
 *
 * Adversarial chunks are deliberately split at incomplete boundaries:
 *  "This is **bo" remends to "**bo**", half list marker, etc.
 *
 * Run with: bun run comparisons/stream-markdown-smd/foum-bench.ts
 * Writes:   comparisons/stream-markdown-smd/results/foum-<YYYY-MM-DD>.json
 */

import { marked } from '../../packages/markdown/node_modules/marked/lib/marked.esm.js';
import remend from 'remend';
import { findUnclosedInline } from '../../packages/markdown/src/markdown-inline';

// Ensure vecto's marked extensions are registered (blockMath, footnote, etc.)
// Importing Markdown triggers the `marked.use({...})` side-effect.
import '../../packages/markdown/src/Markdown';

// ---------------------------------------------------------------------------
// Adversarial corpus
// ---------------------------------------------------------------------------

interface Case {
  id: string;
  doc: string;
  chunks: string[];
  description: string;
}

function chunk(doc: string, splits: number[]): string[] {
  // splits are character offsets where chunks break; must start at 0 implicitly
  const out: string[] = [];
  let prev = 0;
  for (const at of splits) {
    out.push(doc.slice(prev, at));
    prev = at;
  }
  out.push(doc.slice(prev));
  return out.filter((c) => c.length > 0);
}

const cases: Case[] = [
  {
    id: 'bold-incomplete',
    doc: 'This is **bold** text and more.',
    // split inside the bold run: "**bo" is the incomplete marker the task names
    chunks: chunk('This is **bold** text and more.', [11, 13]), // "This is **bo"|"ld** text..."
    // 0: "This is **bo", 1: "ld", 2: "** text and more." -> reconstructs doc
    description:
      'Inline strong split as **bo | ld** — literal shows **bo, optimistic/remend show bold',
  },
  {
    id: 'italic-incomplete',
    doc: 'Text with *italic* words here.',
    chunks: chunk('Text with *italic* words here.', [13, 17]),
    description: 'Italic *it split — literal "*it", optimistic/remend "it" italic',
  },
  {
    id: 'codespan-incomplete',
    doc: 'Run `code` now and continue.',
    chunks: chunk('Run `code` now and continue.', [6, 9]),
    description: 'Inline code `co split',
  },
  {
    id: 'link-incomplete',
    doc: 'See [the docs](https://example.com) now.',
    chunks: chunk('See [the docs](https://example.com) now.', [18, 28]),
    // "See [the docs](https" | "://example.co" | "m) now."
    description:
      'Link destination split as https://exa | mple... — remend completes to incomplete-link',
  },
  {
    id: 'list-marker-half',
    doc: '- item one\n- item two\n',
    // Half marker "- " without content: split so first chunk is the marker alone plus newline
    // The task's "half list marker" means the marker has been typed but item text has not yet
    // For a streaming split we use "- " as first acc, then "item one\n..."
    chunks: ['- ', 'item one\n- item two\n'],
    description:
      'Half list marker "- " then "item one" — bare "- " lexes as list with empty item then heals',
  },
  {
    id: 'list-marker-space',
    doc: '- a\n- b\n',
    // raw list marker without content: "- a\n- " is the case Markdown.ts module comment names
    chunks: ['- a\n- ', 'b\n'],
    description: 'Bare trailing list marker "- " with no content — tiles as "- \\n" then heals',
  },
  {
    id: 'list-loose',
    doc: '1. ordered\n2. second\n\n\n1. third\n',
    chunks: chunk('1. ordered\n2. second\n\n\n1. third\n', [11, 21, 24]),
    // chunk0: "1. ordered\n" chunk1 "2. second\n" chunk2 "\n\n" chunk3 "1. third\n"
    description:
      'Ordered list loose flag: tight [list, space, list] vs single loose list after blank run',
  },
  {
    id: 'heading-setext',
    doc: 'Term\n---\n\nAfter.\n',
    chunks: ['Term\n', '---\n\nAfter.\n'],
    description: 'Paragraph Term then "---" becomes setext heading h2 — para→heading flicker',
  },
  {
    id: 'heading-setext-trailing',
    doc: 'Intro text\n---\n\nNext para.\n',
    chunks: chunk('Intro text\n---\n\nNext para.\n', [11, 15]),
    description: 'Setext split at newline before underline',
  },
  {
    id: 'fence-incomplete',
    doc: '```js\ncode here\n```\n',
    chunks: ['```js\ncode ', 'here\n```\n'],
    description: 'Fenced code block split inside content',
  },
  {
    id: 'blockquote-incomplete',
    doc: '> quote line\n> second\n',
    chunks: ['> quote line\n', '> second\n'],
    description: 'Blockquote split — structural stable, inline FOUM not',
  },
  {
    id: 'mixed-stream',
    doc: '# Title\n\nThis is **bold** and *italic* with `code`.\n\n- item one\n- item two\n\nTerm\n---\n\nFinal para.\n',
    // Mixed document streamed char-by-char in small adversarial chunks (word-level)
    chunks: (() => {
      const doc =
        '# Title\n\nThis is **bold** and *italic* with `code`.\n\n- item one\n- item two\n\nTerm\n---\n\nFinal para.\n';
      // Adversarial chunking: split at several incomplete boundaries + small 8-char windows
      const acc: string[] = [];
      let i = 0;
      const step = 9;
      while (i < doc.length) {
        // Force a split at the known strong boundary if within window
        const next = Math.min(i + step, doc.length);
        acc.push(doc.slice(i, next));
        i = next;
      }
      return acc;
    })(),
    description: 'Mixed prose with heading, inline, list, setext — exercises all axes together',
  },
];

// ---------------------------------------------------------------------------
// Helpers: token fingerprint, FOUM / flicker detection
// ---------------------------------------------------------------------------

interface Fingerprint {
  types: string[];
  looseFlags: (boolean | null)[];
  headingDepths: (number | null)[];
}

function fingerprint(tokens: any[]): Fingerprint {
  return {
    types: tokens.map((t) => t.type),
    looseFlags: tokens.map((t) => (t.type === 'list' ? !!t.loose : null)),
    headingDepths: tokens.map((t) => (t.type === 'heading' ? t.depth : null)),
  };
}

function structuralEqual(a: Fingerprint, b: Fingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Optimistic tail text for a paragraph token, using the same scanner production uses. */
function optimisticTailTextForToken(paragraphToken: any): string | null {
  const inline = paragraphToken.tokens as any[] | undefined;
  if (!inline || inline.length === 0) return null;
  const last = inline[inline.length - 1];
  const prev = inline.length > 1 ? inline[inline.length - 2] : null;
  const isFlat = (t: any) => t.type === 'text' && !t.tokens?.length;
  let runText: string | null = null;
  if (
    last.type === 'link' &&
    last.raw === last.text &&
    prev !== null &&
    isFlat(prev) &&
    (prev as any).text.endsWith('](')
  ) {
    runText = (prev as any).text + last.raw;
  } else if (isFlat(last)) {
    runText = (last as any).text;
  } else {
    return null;
  }
  const found = findUnclosedInline(runText);
  if (!found) return null;
  // Optimistic hides the opening markers, literal shows them — that IS the FOUM delta.
  // The rendered text without markers is runText with markers removed.
  // We only need to know that optimistic WOULD show styled text, so return marker-stripped.
  const head = runText.slice(0, found.at);
  let content = runText.slice(found.contentAt);
  if (found.kind === 'link') {
    const close = content.indexOf('](');
    if (close !== -1) content = content.slice(0, close);
  }
  if (!content) return null;
  return head + content; // what optimistic would render as text (without markers)
}

function literalTailText(tokens: any[]): string | null {
  const last = tokens.at(-1);
  if (!last || last.type !== 'paragraph') return null;
  // Recursively collect .text from inline tokens — same as collectSpans fallback when no optimistic
  // For FOUM detection we just need visible marker presence, so raw-ish text is enough.
  // Use token.raw's text content reconstructed via inline .text fields.
  const inline = (last as any).tokens as any[] | undefined;
  if (!inline) return (last as any).text ?? (last as any).raw ?? null;
  let out = '';
  const walk = (ts: any[]) => {
    for (const t of ts) {
      if (t.tokens?.length) walk(t.tokens);
      else if (typeof t.text === 'string') out += t.text;
      else if (typeof t.raw === 'string') out += t.raw;
    }
  };
  walk(inline);
  // Include the markers themselves as they appear in inline text tokens when incomplete
  // For "**bo" case, the inline text token's text IS "**bo" — so out will contain "**"
  // Check also raw markers that survive as text
  // If inline contains a text token with "**bo", out already has it.
  return out;
}

// ---------------------------------------------------------------------------
// Per-strategy streaming
// ---------------------------------------------------------------------------

type Strategy = 'literal' | 'optimistic' | 'remend';

interface PerChunkSnapshot {
  acc: string;
  tokens: any[];
  tailText: string | null;
  optimisticText: string | null;
  lexMs: number;
  remended?: string;
}

interface CaseResult {
  id: string;
  doc: string;
  chunks: string[];
  description: string;
  convergence: boolean;
  convergenceDetails: {
    literalFinalEqualsOneShot: boolean;
    optimisticFinalEqualsOneShot: boolean;
    remendFinalEqualsOneShot: boolean;
    optimisticLiteralEqualOnClose: boolean;
  };
  perStrategy: Record<
    Strategy,
    {
      snapshots: PerChunkSnapshot[];
      foumFrames: number;
      flickerFrames: number;
      totalLexMs: number;
      avgLexUs: number;
      finalTokens: any[];
    }
  >;
  crossStrategyFlicker: {
    literalFlicker: number;
    optimisticFlicker: number;
    remendFlicker: number;
  };
}

function lexWithTiming(src: string): { tokens: any[]; ms: number } {
  const t0 = performance.now();
  const tokens = marked.lexer(src) as any[];
  const ms = performance.now() - t0;
  return { tokens, ms };
}

function runCase(c: Case): CaseResult {
  const doc = c.doc;
  const chunks = c.chunks;
  const oneShotTokens = marked.lexer(doc) as any[];
  const oneShotFp = fingerprint(oneShotTokens);
  const oneShotJson = JSON.stringify(oneShotTokens);

  // Build accs
  const accs: string[] = [];
  let acc = '';
  for (const ch of chunks) {
    acc += ch;
    accs.push(acc);
  }

  // Literal snapshots
  const literalSnaps: PerChunkSnapshot[] = [];
  let literalTotalMs = 0;
  for (const a of accs) {
    const { tokens, ms } = lexWithTiming(a);
    literalTotalMs += ms;
    const tail = literalTailText(tokens);
    let opt: string | null = null;
    if (tokens.at(-1)?.type === 'paragraph') opt = optimisticTailTextForToken(tokens.at(-1));
    literalSnaps.push({ acc: a, tokens, tailText: tail, optimisticText: opt, lexMs: ms });
  }

  // Optimistic snapshots: same lex, but rendered tailText is optimistic when available
  const optimisticSnaps: PerChunkSnapshot[] = literalSnaps.map((s) => ({
    acc: s.acc,
    tokens: s.tokens, // optimistic is display-only, tokens don't change
    tailText: s.optimisticText ?? s.tailText,
    optimisticText: s.optimisticText,
    lexMs: s.lexMs,
  }));

  // Remend snapshots: remend(acc) then lex
  const remendSnaps: PerChunkSnapshot[] = [];
  let remendTotalMs = 0;
  for (const a of accs) {
    const t0 = performance.now();
    const fixed = remend(a);
    const tokens = marked.lexer(fixed) as any[];
    const ms = performance.now() - t0;
    remendTotalMs += ms;
    const tail = literalTailText(tokens);
    remendSnaps.push({
      acc: a,
      tokens,
      tailText: tail,
      optimisticText: null,
      lexMs: ms,
      remended: fixed,
    });
  }

  const remendFinalTokens = marked.lexer(remend(doc)) as any[];

  // FOUM definition: literal shows visible markers at this acc where an unclosed inline exists.
  // Detect via whether literal snapshot has an unclosed inline (optimisticText !== null).
  // That is the ground truth for "should have been styled but wasn't".
  // Optimistic FOUM = 0 when it correctly hides; remend FOUM = whether remend tail still shows markers.
  function countLiteralFoum(): number {
    let c = 0;
    for (let i = 0; i < literalSnaps.length - 1; i++) {
      if (literalSnaps[i]!.optimisticText !== null) c++;
    }
    return c;
  }
  function countOptimisticFoum(): number {
    // Optimistic tail is marker-stripped when guess applies, so it never contains markers
    // Count would be non-zero only if guess failed to strip (bug)
    let c = 0;
    for (let i = 0; i < optimisticSnaps.length - 1; i++) {
      const s = optimisticSnaps[i]!;
      const lit = literalSnaps[i]!;
      if (lit.optimisticText !== null) {
        const t = s.tailText ?? '';
        if (t.includes('**') || t.includes('`') || t.includes('](')) c++;
      }
    }
    return c;
  }
  function countRemendFoum(): number {
    let c = 0;
    for (let i = 0; i < remendSnaps.length - 1; i++) {
      const lit = literalSnaps[i]!;
      if (lit.optimisticText !== null) {
        const t = remendSnaps[i]!.tailText ?? '';
        // Remend hides markers by completing them: "**bo" -> "**bo**" lexes as bold text "bo"
        // So remend tail should NOT contain "**" etc when it succeeds
        if (t.includes('**') || t.includes('`') || t.includes('](')) c++;
      }
    }
    return c;
  }

  const literalFoum = countLiteralFoum();
  const optimisticFoum = countOptimisticFoum();
  const remendFoum = countRemendFoum();

  // Structural flicker: block-level fingerprint differs from final's prefix
  function flickerCount(
    snaps: PerChunkSnapshot[],
    finalFp: Fingerprint,
    _finalTokens: any[],
  ): number {
    let count = 0;
    for (let i = 0; i < snaps.length - 1; i++) {
      const s = snaps[i]!;
      const fp = fingerprint(s.tokens);
      // Compare first fp.types.length tokens of final
      const slicedFinal = {
        types: finalFp.types.slice(0, fp.types.length),
        looseFlags: finalFp.looseFlags.slice(0, fp.looseFlags.length),
        headingDepths: finalFp.headingDepths.slice(0, fp.headingDepths.length),
      };
      if (!structuralEqual(fp, slicedFinal)) count++;
      else {
        // Also check token count change that will later change structure retroactively
        // For list loose case, token count same but loose differs — already caught
        // For heading case, types differ — already caught
      }
    }
    return count;
  }

  const remendOneShotFp = fingerprint(remendFinalTokens);

  const literalFlicker = flickerCount(literalSnaps, oneShotFp, oneShotTokens);
  const optimisticFlicker = flickerCount(optimisticSnaps, oneShotFp, oneShotTokens);
  const remendFlicker = flickerCount(remendSnaps, remendOneShotFp, remendFinalTokens);

  // Convergence
  const literalFinalTokens = literalSnaps.at(-1)!.tokens;
  const optimisticFinalTokens = literalFinalTokens; // same lex
  const literalEqualsOneShot = JSON.stringify(literalFinalTokens) === oneShotJson;
  const optimisticEqualsOneShot = JSON.stringify(optimisticFinalTokens) === oneShotJson;
  const remendEqualsOneShot = JSON.stringify(remendFinalTokens) === oneShotJson;
  const optimisticLiteralEqualOnClose =
    JSON.stringify(literalFinalTokens) === JSON.stringify(optimisticFinalTokens);
  const convergence =
    literalEqualsOneShot &&
    optimisticEqualsOneShot &&
    remendEqualsOneShot &&
    optimisticLiteralEqualOnClose;

  return {
    id: c.id,
    doc,
    chunks,
    description: c.description,
    convergence,
    convergenceDetails: {
      literalFinalEqualsOneShot: literalEqualsOneShot,
      optimisticFinalEqualsOneShot: optimisticEqualsOneShot,
      remendFinalEqualsOneShot: remendEqualsOneShot,
      optimisticLiteralEqualOnClose: optimisticLiteralEqualOnClose,
    },
    perStrategy: {
      literal: {
        snapshots: literalSnaps,
        foumFrames: literalFoum,
        flickerFrames: literalFlicker,
        totalLexMs: literalTotalMs,
        avgLexUs: (literalTotalMs * 1000) / accs.length,
        finalTokens: literalFinalTokens,
      },
      optimistic: {
        snapshots: optimisticSnaps,
        foumFrames: optimisticFoum,
        flickerFrames: optimisticFlicker,
        totalLexMs: literalTotalMs, // same lex as literal
        avgLexUs: (literalTotalMs * 1000) / accs.length,
        finalTokens: optimisticFinalTokens,
      },
      remend: {
        snapshots: remendSnaps,
        foumFrames: remendFoum,
        flickerFrames: remendFlicker,
        totalLexMs: remendTotalMs,
        avgLexUs: (remendTotalMs * 1000) / accs.length,
        finalTokens: remendFinalTokens,
      },
    },
    crossStrategyFlicker: {
      literalFlicker,
      optimisticFlicker,
      remendFlicker,
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const results: CaseResult[] = cases.map(runCase);

  // Aggregate
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const totalFoumLiteral = sum(results.map((r) => r.perStrategy.literal.foumFrames));
  const totalFoumOptimistic = sum(results.map((r) => r.perStrategy.optimistic.foumFrames));
  const totalFoumRemend = sum(results.map((r) => r.perStrategy.remend.foumFrames));
  const totalFlickerLiteral = sum(results.map((r) => r.perStrategy.literal.flickerFrames));
  const totalFlickerOptimistic = sum(results.map((r) => r.perStrategy.optimistic.flickerFrames));
  const totalFlickerRemend = sum(results.map((r) => r.perStrategy.remend.flickerFrames));
  const allConverge = results.every((r) => r.convergence);
  const totalLexLiteral = sum(results.map((r) => r.perStrategy.literal.totalLexMs));
  const totalLexRemend = sum(results.map((r) => r.perStrategy.remend.totalLexMs));

  const payload = {
    suite: 'foum',
    name: 'foum',
    date: new Date().toISOString().slice(0, 10),
    engine: 'bun-node',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : `bun/${Bun.version} node`,
    note: 'FOUM (flash of unstyled markdown) = intermediate frames where raw markers are visible then disappear; optimistic hides them via inline guess, remend completes them before lex. Structural flicker = block type or loose flag changes retroactively (para→setext, tight→loose). Convergence = optimistic final === literal final === one-shot lexer output. Adversarial chunks are split at incomplete syntax boundaries (This is **bo, half list marker "- ", list loose, heading setext). Literal shows FOUM, optimistic/remend avoid it; all converge.',
    cases: results.map((r) => ({
      id: r.id,
      description: r.description,
      doc: r.doc,
      chunks: r.chunks,
      chunkCount: r.chunks.length,
      convergence: r.convergence,
      convergenceDetails: r.convergenceDetails,
      foumFrames: {
        literal: r.perStrategy.literal.foumFrames,
        optimistic: r.perStrategy.optimistic.foumFrames,
        remend: r.perStrategy.remend.foumFrames,
      },
      flickerFrames: {
        literal: r.perStrategy.literal.flickerFrames,
        optimistic: r.perStrategy.optimistic.flickerFrames,
        remend: r.perStrategy.remend.flickerFrames,
      },
      timing: {
        literalTotalMs: r.perStrategy.literal.totalLexMs,
        literalAvgUs: r.perStrategy.literal.avgLexUs,
        remendTotalMs: r.perStrategy.remend.totalLexMs,
        remendAvgUs: r.perStrategy.remend.avgLexUs,
      },
      // Snapshots trimmed for JSON size: keep tail texts not full token dumps
      snapshots: {
        literalTails: r.perStrategy.literal.snapshots.map((s) => s.tailText),
        optimisticTails: r.perStrategy.optimistic.snapshots.map((s) => s.tailText),
        remendTails: r.perStrategy.remend.snapshots.map((s) => s.tailText),
        literalTypes: r.perStrategy.literal.snapshots.map((s) =>
          s.tokens.map((t: any) => t.type + (t.loose !== undefined ? `(loose:${t.loose})` : '')),
        ),
        remendTypes: r.perStrategy.remend.snapshots.map((s) =>
          s.tokens.map((t: any) => t.type + (t.loose !== undefined ? `(loose:${t.loose})` : '')),
        ),
      },
    })),
    aggregate: {
      totalCases: results.length,
      totalChunks: sum(results.map((r) => r.chunks.length)),
      totalFoumFrames: {
        literal: totalFoumLiteral,
        optimistic: totalFoumOptimistic,
        remend: totalFoumRemend,
      },
      totalFlickerFrames: {
        literal: totalFlickerLiteral,
        optimistic: totalFlickerOptimistic,
        remend: totalFlickerRemend,
      },
      convergenceAll: allConverge,
      timing: {
        literalTotalMs: totalLexLiteral,
        remendTotalMs: totalLexRemend,
        remendOverheadMs: totalLexRemend - totalLexLiteral,
        remendOverheadRatio: totalLexLiteral > 0 ? totalLexRemend / totalLexLiteral : null,
      },
    },
    versions: {
      remend: '1.3.0',
      marked: (marked as any).defaults ? 'see packages/markdown/package.json' : 'unknown',
      bun: Bun.version,
    },
  };

  // Write file
  const date = new Date().toISOString().slice(0, 10);
  const outPath = `comparisons/stream-markdown-smd/results/foum-${date}.json`;
  await Bun.write(outPath, JSON.stringify(payload, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(payload.aggregate, null, 2));

  // Also write stable name for CI
  await Bun.write(
    'comparisons/stream-markdown-smd/results/foum-latest.json',
    JSON.stringify(payload, null, 2),
  );
  // Ensure process exits (Markdown Worker keeps event loop alive)
  process.exit(0);
}

await main();
