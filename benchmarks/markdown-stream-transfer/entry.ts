// CTX-0059 — Markdown streaming worker-transfer volume.
//
// The request payload has been through three generations, and this bench reports
// all three over the same stream because each one removed a different O(N) term:
//
//   1. `{ text: <whole document>, oldRaws: [<raw of every token held>] }`
//      — the document went over the wire TWICE per chunk.
//   2. (#233) `{ text: <whole document> }` — the worker keeps the raw list
//      itself, keyed by Markdown instance + token version.
//   3. (this change) `{ append: <chunk>, expectedLength }` — the worker keeps the
//      SOURCE too, so a steady-state chunk posts only the new characters.
//
// An earlier version of this comment claimed the `text` term was unavoidable
// because `marked` has no incremental lexer. That conflated two costs. The LEX is
// still O(N) per chunk — nothing here changes that, and it is why `expectedLength`
// exists rather than a subtler diff. But the lex runs on the worker thread, while
// the transfer is a structured clone charged to the CALLER's thread, and that term
// is what generation 3 removes: posts go from O(N) to O(chunk).
//
// Measured on real hardware (Chrome, per-append main-thread postMessage cost):
// full-text 4.08µs @8KB → 34.54 @128KB → 219.68 @512KB, versus a flat 2.07–2.50µs
// for the append shape at every size. Whole-stream main-thread time saved: ~3ms at
// 32KB, ~68ms at 128KB, ~1.8s at 512KB.
//
// This bench measures the bytes actually posted per chunk (the Worker is stubbed
// so only request payloads are observed, not the lex) and reports the cumulative
// total for each generation. Unlike generation 2's ~2× constant-factor win, the
// generation-3 ratio GROWS with the stream — that asymptotic change is the point.
// NOTE: `@vectojs/markdown` creates its shared Worker at MODULE LOAD time, so
// the stub must be installed BEFORE the module is imported — hence the dynamic
// import in main() rather than a static import here.
import { awaitStart, reportFailure, reportResult } from '../_shared/client.ts';

type MarkdownCtor = new (text: string) => {
  appendMarkdown(chunk: string): unknown;
  destroy(): void;
};

const p = new URLSearchParams(location.search);
const CHUNK_COUNTS = (p.get('chunks') ?? '25,50,100,200,400').split(',').map(Number);
// A chunk that looks like LLM output: a sentence, periodically a new block.
const SENTENCE = 'The quick brown fox jumps over the lazy dog and keeps running. ';

/** Bytes a structured-clone-able payload costs, approximated by its JSON size. */
function payloadBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Accounting for the run currently being measured; swapped per measurement. */
let run = {
  posts: 0,
  deltas: 0,
  resyncs: 0,
  /** Generation 3: what this build actually posts. */
  deltaBytes: 0,
  /** Generation 2: the whole document as `text`, every chunk. */
  fullTextBytes: 0,
  /** Generation 1: the whole document plus the caller's raw list, every chunk. */
  fullTextRawsBytes: 0,
  /** The source the worker holds, mirroring the real worker's cache. */
  source: '',
  /** The raw list the worker holds — and therefore what generation 1 resent. */
  raws: [] as string[],
};

/**
 * Stand-in for the shared Markdown worker. Installed BEFORE the module is
 * imported (it creates its Worker at load time), it records each request's
 * payload size and replies the way MarkdownWorker does, so the real reconcile
 * path runs. `marked` isn't bundled here, so the token split is approximated by
 * blank-line-separated blocks — enough to drive (matchLen, tail).
 *
 * Both request shapes are handled, including the `expectedLength` check, because
 * the caller's delta/full decision is exactly what this bench measures: a stub
 * that only understood `text` would silently score every post as a resync.
 */
class StubWorker {
  public onmessage: ((e: { data: any }) => void) | null = null;
  public onerror: (() => void) | null = null;
  postMessage(msg: any): void {
    if (msg?.dispose) return;
    run.posts++;
    run.deltaBytes += payloadBytes(msg);

    // Reconstruct the document the way the real worker does, and reject a delta
    // whose result does not match the length the caller expects.
    let source: string;
    if (typeof msg.append === 'string') {
      run.deltas++;
      source = run.source + msg.append;
      if (source.length !== msg.expectedLength) {
        run.resyncs++;
        run.source = '';
        run.raws = [];
        this.onmessage?.({ data: { id: msg.id, needResync: true } });
        return;
      }
    } else if (typeof msg.text === 'string') {
      source = msg.text;
    } else {
      return;
    }

    // What the two earlier generations would have posted for this same request.
    const { append: _append, expectedLength: _expectedLength, ...rest } = msg;
    const asFullText = { ...rest, text: source };
    run.fullTextBytes += payloadBytes(asFullText);
    run.fullTextRawsBytes += payloadBytes({ ...asFullText, oldRaws: run.raws });

    const blocks = source.split(/\n\n/);
    let matchLen = 0;
    const minLen = Math.min(run.raws.length, blocks.length);
    for (; matchLen < minLen; matchLen++) {
      if (run.raws[matchLen] !== blocks[matchLen]) break;
    }
    run.source = source;
    run.raws = blocks.slice();
    const tail = blocks.slice(matchLen).map((b) => ({
      type: 'paragraph',
      raw: b,
      text: b,
      tokens: [{ type: 'text', raw: b, text: b }],
    }));
    this.onmessage?.({ data: { id: msg.id, matchLen, tail } });
  }
  terminate(): void {}
}
(globalThis as any).Worker = StubWorker as never;
(globalThis as any).URL.createObjectURL ??= () => 'blob:stub';

/**
 * Drive `chunks` appends through a real Markdown instance with the Worker
 * stubbed out, capturing every posted payload. The stub answers each request the
 * way the real worker would (matchLen against the prior raws + the changed
 * tail), so the reconcile path runs for real.
 */
function measure(
  Markdown: MarkdownCtor,
  chunks: number,
): {
  deltaBytes: number;
  fullTextBytes: number;
  fullTextRawsBytes: number;
  posts: number;
  deltas: number;
  resyncs: number;
} {
  // Fresh accounting for this run; the (already-installed) stub reads these.
  run = {
    posts: 0,
    deltas: 0,
    resyncs: 0,
    deltaBytes: 0,
    fullTextBytes: 0,
    fullTextRawsBytes: 0,
    source: '',
    raws: [],
  };

  const md = new Markdown('# Streamed document');
  for (let i = 0; i < chunks; i++) {
    // Every 8th chunk starts a new block; otherwise the last paragraph grows.
    md.appendMarkdown(i % 8 === 7 ? `\n\n${SENTENCE}` : SENTENCE);
  }
  md.destroy();
  return {
    deltaBytes: run.deltaBytes,
    fullTextBytes: run.fullTextBytes,
    fullTextRawsBytes: run.fullTextRawsBytes,
    posts: run.posts,
    deltas: run.deltas,
    resyncs: run.resyncs,
  };
}

async function main() {
  await awaitStart();
  const startedAt = performance.now();
  // Imported only now, so the stub Worker above is the one it picks up.
  //
  // The stub itself is installed at module top level, before this runs, because
  // @vectojs/markdown creates its shared Worker at module load time — the start
  // gate does not move that, it only delays the measurement.
  const { Markdown } = (await import('@vectojs/markdown')) as unknown as {
    Markdown: MarkdownCtor;
  };
  const rows: any[] = [];
  for (const chunks of CHUNK_COUNTS) {
    const m = measure(Markdown, chunks);
    rows.push({
      chunks,
      posts: m.posts,
      deltas: m.deltas,
      // Non-zero means the caller's offset tracking drifted from the worker's
      // source — a correctness signal, not a tuning knob.
      resyncs: m.resyncs,
      deltaKB: +(m.deltaBytes / 1024).toFixed(1),
      fullTextKB: +(m.fullTextBytes / 1024).toFixed(1),
      fullTextRawsKB: +(m.fullTextRawsBytes / 1024).toFixed(1),
      // Ratios against what this build actually posts. `vsFullText` is the win
      // from this change; it should grow with `chunks`, unlike `fullTextRaws /
      // fullText`, which is a ~2× constant.
      vsFullText: +(m.fullTextBytes / Math.max(m.deltaBytes, 1)).toFixed(2),
      vsFullTextRaws: +(m.fullTextRawsBytes / Math.max(m.deltaBytes, 1)).toFixed(2),
    });
  }
  // `engine` and `userAgent` are gone from here: the shared envelope supplies both.
  // The POST's own try/catch is gone too — the shared client never throws on a
  // failed post, for the same reason this file swallowed it: the page must still
  // render its fallback table.
  const result = await reportResult({
    name: 'markdown-stream-transfer',
    params: { CHUNK_COUNTS, sentenceLen: SENTENCE.length },
    rows,
    durationMs: +(performance.now() - startedAt).toFixed(1),
  });
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main().catch((error) => reportFailure('markdown-stream-transfer', error));
