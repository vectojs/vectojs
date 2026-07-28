// CTX-0059 — Markdown streaming worker-transfer volume.
//
// Every streamed chunk must re-lex the whole accumulated document in the worker
// (`marked` has no incremental lexer), so the `text` field unavoidably grows with
// the document — that term stays O(N) per chunk / O(N²) per stream either way.
//
// What WAS avoidable is the SECOND such term: the request also carried
// `oldRaws`, the raw source of every token the caller already held, so each
// chunk shipped the document TWICE. The worker now keeps that raw list itself
// (keyed by Markdown instance + token version), so a steady-state chunk posts
// only the text.
//
// This bench measures the bytes actually posted per chunk (the Worker is stubbed
// so only request payloads are observed, not the lex) and reports the cumulative
// total for the new protocol vs the old one over the same stream. The expected
// result is therefore a convergence toward ~2× less transfer, not a change in
// asymptotic class — which is exactly what "stop sending the document twice"
// should look like, and is the honest ceiling until marked can lex incrementally.
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
let run = { posts: 0, newBytes: 0, oldBytes: 0, raws: [] as string[] };

/**
 * Stand-in for the shared Markdown worker. Installed BEFORE the module is
 * imported (it creates its Worker at load time), it records each request's
 * payload size and replies the way MarkdownWorker does, so the real reconcile
 * path runs. `marked` isn't bundled here, so the token split is approximated by
 * blank-line-separated blocks — enough to drive (matchLen, tail).
 */
class StubWorker {
  public onmessage: ((e: { data: any }) => void) | null = null;
  public onerror: (() => void) | null = null;
  postMessage(msg: any): void {
    if (msg?.dispose) return;
    run.posts++;
    run.newBytes += payloadBytes(msg);
    // What the OLD protocol would have sent for this same request: this message
    // plus the full prior-token raw list, every single chunk.
    run.oldBytes += payloadBytes({ ...msg, oldRaws: run.raws });

    const blocks = String(msg.text).split(/\n\n/);
    let matchLen = 0;
    const minLen = Math.min(run.raws.length, blocks.length);
    for (; matchLen < minLen; matchLen++) {
      if (run.raws[matchLen] !== blocks[matchLen]) break;
    }
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
  newBytes: number;
  oldBytes: number;
  posts: number;
} {
  // Fresh accounting for this run; the (already-installed) stub reads these.
  run = { posts: 0, newBytes: 0, oldBytes: 0, raws: [] };

  const md = new Markdown('# Streamed document');
  for (let i = 0; i < chunks; i++) {
    // Every 8th chunk starts a new block; otherwise the last paragraph grows.
    md.appendMarkdown(i % 8 === 7 ? `\n\n${SENTENCE}` : SENTENCE);
  }
  md.destroy();
  return { newBytes: run.newBytes, oldBytes: run.oldBytes, posts: run.posts };
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
    const { newBytes, oldBytes, posts } = measure(Markdown, chunks);
    rows.push({
      chunks,
      posts,
      newKB: +(newBytes / 1024).toFixed(1),
      oldKB: +(oldBytes / 1024).toFixed(1),
      reduction: +(oldBytes / Math.max(newBytes, 1)).toFixed(2),
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
