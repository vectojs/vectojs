// @vitest-environment jsdom
//
// The worker half of the streaming protocol. `markdownWorkerFallback.test.ts`
// covers the main-thread side with a mocked Worker; this drives the REAL worker
// module, because the cache and the length check are what make a delta protocol
// safe and neither is exercised by mocking the thing that implements them.
//
// The worker is written against `self.onmessage` / `self.postMessage`, so it is
// loaded with those stubbed and then driven directly.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';

interface WorkerResponse {
  id: number;
  matchLen?: number;
  tail?: { raw: string }[];
  needResync?: boolean;
  error?: string;
  lexerMs?: number;
  sourceCharsLexed?: number;
}

let onmessage: ((e: { data: unknown }) => void) | null = null;
let responses: WorkerResponse[] = [];

/** Load a fresh worker module with `self` stubbed, so its cache starts empty. */
async function loadWorker(): Promise<void> {
  responses = [];
  const selfStub = {
    set onmessage(handler: (e: { data: unknown }) => void) {
      onmessage = handler;
    },
    postMessage(data: WorkerResponse): void {
      responses.push(data);
    },
  };
  vi.stubGlobal('self', selfStub);
  vi.resetModules();
  await import('../src/MarkdownWorker');
}

/** Post one request and return the single response it produced. */
function request(data: Record<string, unknown>): WorkerResponse {
  const before = responses.length;
  onmessage!({ data });
  expect(responses.length).toBe(before + 1);
  return responses[responses.length - 1]!;
}

describe('MarkdownWorker delta protocol', () => {
  beforeEach(async () => {
    await loadWorker();
  });

  it('asks for a resync when a delta arrives with nothing cached for the instance', () => {
    // No prior full request, so the worker holds no source to extend. It must
    // not guess: `append` alone describes a document it has never seen.
    const res = request({
      id: 1,
      append: 'more text',
      instance: 'md-0',
      baseVersion: 0,
    });
    expect(res.needResync).toBe(true);
    expect(res.matchLen).toBeUndefined();
  });

  it('lexes a delta against its own cached source and returns only the changed tail', () => {
    const initial = '# Title\n\nFirst paragraph.';
    const full = request({
      id: 1,
      text: initial,
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: marked.lexer(initial).map((t) => t.raw),
    });
    // Prior raws matched the whole document, so nothing changed.
    expect(full.matchLen).toBe(marked.lexer(initial).length);

    // The delta carries only the chunk. The worker must reconstruct
    // `initial + chunk` itself and diff against the raws it cached.
    const chunk = '\n\nSecond paragraph.';
    const delta = request({
      id: 2,
      append: chunk,
      expectedLength: initial.length + chunk.length,
      instance: 'md-0',
      baseVersion: 1,
    });
    const expectedTokens = marked.lexer(initial + chunk);
    expect(delta.needResync).toBeUndefined();
    // The tail must be exactly the tokens after the matched prefix, and
    // reconstructing prefix+tail must reproduce the full token list.
    const raws = marked.lexer(initial).map((t) => t.raw);
    let matchLen = 0;
    for (; matchLen < Math.min(raws.length, expectedTokens.length); matchLen++) {
      if (raws[matchLen] !== expectedTokens[matchLen].raw) break;
    }
    expect(delta.matchLen).toBe(matchLen);
    expect(delta.tail!.map((t) => t.raw)).toEqual(expectedTokens.slice(matchLen).map((t) => t.raw));
  });

  it('sustains a stream of deltas, each carrying only its own chunk', () => {
    let doc = '# Stream';
    request({
      id: 0,
      text: doc,
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: marked.lexer(doc).map((t) => t.raw),
    });

    // Twenty appends, none of which resend the document. A single stale-cache
    // response anywhere in here would mean the worker had lost the source.
    for (let i = 1; i <= 20; i++) {
      const chunk = `\n\nParagraph ${i}.`;
      doc += chunk;
      const res = request({
        id: i,
        append: chunk,
        expectedLength: doc.length,
        instance: 'md-0',
        baseVersion: i,
      });
      expect(res.needResync).toBeUndefined();
      expect(res.error).toBeUndefined();
    }

    // After the whole stream the worker's reconstructed source must still lex to
    // exactly what the document is, which is the property the protocol rests on.
    const finalTokens = marked.lexer(doc);
    const last = responses[responses.length - 1]!;
    const reconstructedLen = last.matchLen! + last.tail!.length;
    expect(reconstructedLen).toBe(finalTokens.length);
  });

  it('asks for a resync on a version mismatch instead of extending a stale source', () => {
    const initial = '# Title';
    request({
      id: 1,
      text: initial,
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: marked.lexer(initial).map((t) => t.raw),
    });

    // The cache is now at version 1. A delta claiming to extend version 5 comes
    // from a caller whose token list moved without the worker — a setContent or a
    // main-thread parse — so its source and the cached one have diverged.
    const res = request({
      id: 2,
      append: ' more',
      expectedLength: initial.length + 5,
      instance: 'md-0',
      baseVersion: 5,
    });
    expect(res.needResync).toBe(true);
  });

  it('rejects a delta whose expected length does not match, rather than lexing a diverged source', () => {
    const initial = '# Title';
    request({
      id: 1,
      text: initial,
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: marked.lexer(initial).map((t) => t.raw),
    });

    // The version lines up, so the cache looks usable — but the caller says the
    // document should total 999 characters and the worker's own source plus this
    // append does not. That means a chunk was dropped, duplicated, or reordered
    // somewhere, and every token from here on would come from text the caller
    // does not have. This is the check that turns a silent corruption into one
    // resync, and it is the whole reason `expectedLength` is on the wire.
    const res = request({
      id: 2,
      append: ' more',
      expectedLength: 999,
      instance: 'md-0',
      baseVersion: 1,
    });
    expect(res.needResync).toBe(true);

    // The entry is dropped too, so a retry cannot land on the same bad state:
    // even a correctly-versioned delta now has to resync.
    const retry = request({
      id: 3,
      append: ' more',
      expectedLength: initial.length + 5,
      instance: 'md-0',
      baseVersion: 1,
    });
    expect(retry.needResync).toBe(true);
  });

  it('keeps each instance separate, so one stream cannot read another one source', () => {
    request({
      id: 1,
      text: '# A',
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: ['# A'],
    });
    request({
      id: 2,
      text: '# B',
      instance: 'md-1',
      baseVersion: 0,
      oldRaws: ['# B'],
    });

    // md-1's delta must extend md-1's source. If the cache were keyed loosely the
    // two streams would silently interleave into each other's documents.
    const res = request({
      id: 3,
      append: '\n\nfrom B',
      expectedLength: '# B\n\nfrom B'.length,
      instance: 'md-1',
      baseVersion: 1,
    });
    expect(res.needResync).toBeUndefined();
    const tails = res.tail!.map((t) => t.raw).join('');
    expect(tails).toContain('from B');
    expect(tails).not.toContain('# A');
  });

  it('drops the cache on dispose, so a reused instance id cannot resume a dead stream', () => {
    request({
      id: 1,
      text: '# A',
      instance: 'md-0',
      baseVersion: 0,
      oldRaws: ['# A'],
    });
    // Dispose is fire-and-forget: no response, or the caller would have to track
    // an id for a teardown it already finished.
    const before = responses.length;
    onmessage!({ data: { instance: 'md-0', dispose: true } });
    expect(responses.length).toBe(before);

    const res = request({
      id: 2,
      append: ' more',
      expectedLength: '# A more'.length,
      instance: 'md-0',
      baseVersion: 1,
    });
    expect(res.needResync).toBe(true);
  });

  it('reports the lexer cost of the WHOLE source, not just the delta', () => {
    // The reason the reuse counters were renamed: a delta shrinks the transfer, not
    // the lex. `marked` has no incremental lexing API, so every append re-lexes the
    // full accumulated document, and `sourceCharsLexed` is what makes that visible.
    const initial = '# Title\n\nFirst paragraph.';
    const first = request({
      id: 1,
      text: initial,
      instance: 'md-0',
      baseVersion: 0,
      // `oldRaws` is required on a first request: without it, and with nothing
      // cached, the worker resyncs rather than guessing and never reaches the lexer.
      oldRaws: marked.lexer(initial).map((t) => t.raw),
    });
    expect(first.needResync).toBeUndefined();
    expect(first.sourceCharsLexed).toBe(initial.length);
    expect(typeof first.lexerMs).toBe('number');
    expect(first.lexerMs).toBeGreaterThanOrEqual(0);

    // A tiny append. The transfer is a short tail...
    const append = '\n\nSecond.';
    const second = request({
      id: 2,
      append,
      expectedLength: initial.length + append.length,
      instance: 'md-0',
      baseVersion: 1,
    });
    expect(second.matchLen).toBeGreaterThan(0);
    expect(second.tail!.length).toBeLessThan(4);
    // ...but the lex covered the whole document, appended text included.
    expect(second.sourceCharsLexed).toBe(initial.length + append.length);
    expect(second.sourceCharsLexed).toBeGreaterThan(first.sourceCharsLexed!);
  });

  it('ignores a malformed message instead of driving the lexer with it', () => {
    const before = responses.length;
    onmessage!({ data: null });
    onmessage!({ data: 42 });
    // Neither `text` nor `append`: not a request shape at all.
    onmessage!({ data: { id: 1, instance: 'md-0', baseVersion: 0 } });
    onmessage!({
      data: { id: 2, text: 123, instance: 'md-0', baseVersion: 0 },
    });
    expect(responses.length).toBe(before);
  });
});
