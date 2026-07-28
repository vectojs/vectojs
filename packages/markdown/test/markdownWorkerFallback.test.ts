// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { marked } from 'marked';

// jsdom supports neither Worker nor URL.createObjectURL — mock both so the
// module-level worker bootstrap in Markdown.ts actually runs.
class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public posted: Array<{
    id: number;
    text?: string;
    append?: string;
    expectedLength?: number;
    oldRaws?: string[];
    instance?: string;
    baseVersion?: number;
    dispose?: boolean;
  }> = [];
  constructor(_url: string) {
    MockWorker.instances.push(this);
  }
  postMessage(data: {
    id: number;
    text?: string;
    append?: string;
    expectedLength?: number;
    oldRaws?: string[];
  }): void {
    this.posted.push(data);
  }
  terminate(): void {}
}

describe('Markdown worker error fallback', () => {
  it('re-parses synchronously when the worker reports an error (streaming chunk must not vanish)', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# title');
    const before = (md as unknown as { tokens: unknown[] }).tokens.length;

    md.appendMarkdown('\n\na new streamed paragraph');
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    // The worker's lexer failed. Dropping the callback would lose the final
    // streaming chunk forever — the main thread must fall back to a sync parse.
    worker.onmessage!({ data: { id: worker.posted[0].id, error: 'boom' } });

    expect((md as unknown as { tokens: unknown[] }).tokens.length).toBeGreaterThan(before);
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toContain('streamed paragraph');
  });

  it('sends the full text plus oldRaws on the first request, then a chunk-sized delta', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const initialText = '# Title\n\nFirst paragraph.';
    const md = new Markdown(initialText);
    const initialChildCount = md.content.children.length;

    md.appendMarkdown('\n\nSecond paragraph.');
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    const fullText = initialText + '\n\nSecond paragraph.';
    const oldRaws = marked.lexer(initialText).map((t) => t.raw);
    // First request for this instance: the worker holds nothing for it, so the
    // full text AND the prior raws go together. Sending the text alone would
    // only earn a `needResync` and then have to send the whole document a
    // second time — the old protocol did exactly that on every first append.
    expect(worker.posted[0].text).toBe(fullText);
    expect(worker.posted[0].oldRaws).toEqual(oldRaws);
    expect(worker.posted[0].append).toBeUndefined();
    expect(typeof worker.posted[0].instance).toBe('string');
    expect(typeof worker.posted[0].baseVersion).toBe('number');

    // Mirror exactly what MarkdownWorker.ts computes, to simulate a real
    // worker response rather than hand-crafting fake tokens.
    const fullTokens = marked.lexer(fullText);
    let matchLen = 0;
    const minLen = Math.min(oldRaws.length, fullTokens.length);
    for (; matchLen < minLen; matchLen++) {
      if (oldRaws[matchLen] !== fullTokens[matchLen].raw) break;
    }
    const tail = fullTokens.slice(matchLen);

    worker.onmessage!({ data: { id: worker.posted[0].id, matchLen, tail } });

    // Reconstruction must produce the same result a full-array transfer
    // would have: both the new paragraph rendered and the original heading
    // entity reused (matchLen covered it, so it was never removed/re-added).
    expect(md.content.children.length).toBeGreaterThan(initialChildCount);
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe(fullText);

    // Now that the worker is known to hold this source, the next append ships
    // only the chunk — this is the O(chunk) steady state the protocol exists
    // for, and it must NOT re-send the document or the raws.
    md.appendMarkdown('\n\nThird paragraph.');
    expect(worker.posted.length).toBe(2);
    expect(worker.posted[1].append).toBe('\n\nThird paragraph.');
    expect(worker.posted[1].text).toBeUndefined();
    expect(worker.posted[1].oldRaws).toBeUndefined();
    // The length the worker's own source must reach once it applies the append,
    // so a dropped or duplicated chunk is caught instead of silently lexed.
    expect(worker.posted[1].expectedLength).toBe(fullText.length + '\n\nThird paragraph.'.length);
  });

  it('resends the full text and raws once when the worker reports it cannot trust what it holds', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const initialText = '# Title\n\nFirst paragraph.';
    const md = new Markdown(initialText);

    md.appendMarkdown('\n\nSecond paragraph.');
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    // Worker: "I can't trust what I hold for this instance/version."
    worker.onmessage!({ data: { id: worker.posted[0].id, needResync: true } });

    // Exactly one retry, still the full shape, for the same text.
    expect(worker.posted.length).toBe(2);
    expect(worker.posted[1].oldRaws).toEqual(marked.lexer(initialText).map((t) => t.raw));
    expect(worker.posted[1].text).toBe(worker.posted[0].text);
    expect(worker.posted[1].append).toBeUndefined();

    // The retry still reconstructs correctly.
    const fullTokens = marked.lexer(worker.posted[1].text!);
    const oldRaws = worker.posted[1].oldRaws!;
    let matchLen = 0;
    for (; matchLen < Math.min(oldRaws.length, fullTokens.length); matchLen++) {
      if (oldRaws[matchLen] !== fullTokens[matchLen].raw) break;
    }
    worker.onmessage!({
      data: {
        id: worker.posted[1].id,
        matchLen,
        tail: fullTokens.slice(matchLen),
      },
    });
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe(worker.posted[1].text);
  });

  it('falls back to the full shape after setContent, which invalidates the worker source', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# Title');
    md.appendMarkdown('\n\nFirst.');
    const worker = MockWorker.instances.at(-1)!;
    const tokens1 = marked.lexer('# Title\n\nFirst.');
    worker.onmessage!({
      data: { id: worker.posted[0].id, matchLen: 1, tail: tokens1.slice(1) },
    });

    // A steady-state append would be a delta from here.
    md.appendMarkdown('\n\nSecond.');
    expect(worker.posted[1].append).toBe('\n\nSecond.');
    const tokens2 = marked.lexer('# Title\n\nFirst.\n\nSecond.');
    worker.onmessage!({
      data: { id: worker.posted[1].id, matchLen: 2, tail: tokens2.slice(2) },
    });

    // setContent replaces the document, so the worker's copy of the source now
    // describes something that no longer exists and the next append must resend
    // the text.
    //
    // The replacement here is deliberately chosen so that it plus the following
    // append is LONGER than the source the worker held (24 chars). A shorter
    // replacement is already caught by the `workerSourceLen <= sentLength` guard
    // in dispatchAppend, so it cannot distinguish a correct implementation from
    // one that forgot to reset — this case can.
    md.setContent('# Replaced heading');
    md.appendMarkdown('\n\nAfter the reset arrives.');

    // The post this produces must be the FULL shape. Asserting on the last post
    // via `.at(-1)` would pass either way, and indexing a post that may not
    // exist asserts nothing at all — `expect(undefined).toBeUndefined()` is
    // vacuously true, which is how an earlier version of this test passed
    // against the broken code. So: pin the count first, then the shape.
    expect(worker.posted.length).toBe(3);
    const afterReset = worker.posted[2];
    expect(afterReset).toBeDefined();
    // Without the reset this is a delta sliced from offset 24 of a 44-character
    // document — text this instance never had. The worker's version check would
    // reject it, but only after a wasted round trip.
    expect(afterReset!.append).toBeUndefined();
    expect(afterReset!.text).toBe('# Replaced heading\n\nAfter the reset arrives.');
    expect(afterReset!.oldRaws).toEqual(marked.lexer('# Replaced heading').map((t) => t.raw));
  });

  it('stops sending deltas after a sync-fallback parse the worker never saw', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# Title');
    md.appendMarkdown('\n\nFirst.');
    const worker = MockWorker.instances.at(-1)!;
    const tokens1 = marked.lexer('# Title\n\nFirst.');
    worker.onmessage!({
      data: { id: worker.posted[0].id, matchLen: 1, tail: tokens1.slice(1) },
    });

    // The worker's lexer throws for the next request, so the main thread parses
    // it locally. The worker never saw that source, so its cached copy is now
    // behind by this chunk: a delta against it would lex text this instance does
    // not have and return a matchLen for tokens it never held.
    md.appendMarkdown('\n\nSecond.');
    expect(worker.posted[1].append).toBe('\n\nSecond.');
    worker.onmessage!({ data: { id: worker.posted[1].id, error: 'boom' } });

    md.appendMarkdown('\n\nThird.');
    const latest = worker.posted.at(-1)!;
    expect(latest.append).toBeUndefined();
    expect(latest.text).toBe('# Title\n\nFirst.\n\nSecond.\n\nThird.');
  });

  it('parses locally for every pending request when the worker itself crashes', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# Title');
    md.appendMarkdown('\n\nFirst.');
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    // The worker process died with a request in flight. Every pending callback
    // must still resolve — dropping one loses that chunk permanently — and the
    // worker is dropped, so subsequent appends lex on the main thread.
    worker.onerror!(new Error('worker died'));
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe('# Title\n\nFirst.');
    expect(md.content.children.length).toBeGreaterThan(0);

    const postedAfterCrash = worker.posted.length;
    md.appendMarkdown('\n\nSecond.');
    // Nothing more is posted: there is no worker to post to.
    expect(worker.posted.length).toBe(postedAfterCrash);
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toContain('Second.');
  });

  it('tells the worker to drop its cached raws when the block is destroyed', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# Title');
    md.appendMarkdown('\n\nmore');
    const worker = MockWorker.instances.at(-1)!;
    const instance = worker.posted[0].instance;

    md.destroy();

    const disposeMsg = worker.posted.find((p) => (p as { dispose?: boolean }).dispose === true);
    expect(disposeMsg).toBeDefined();
    expect((disposeMsg as { instance?: string }).instance).toBe(instance);
  });

  it('coalesces appends made while a request is in flight into a single follow-up dispatch', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('Hello');

    md.appendMarkdown(' world');
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);
    expect(worker.posted[0].text).toBe('Hello world');

    // A second append arrives before the first request resolves — must not
    // fire a second postMessage yet (that would race the in-flight one).
    md.appendMarkdown('!');
    expect(worker.posted.length).toBe(1);

    // The raws are no longer echoed in the request (the worker caches them), so
    // derive the prior list the same way the worker's cache would hold it.
    const oldRaws1 = marked.lexer('Hello').map((t) => t.raw);
    const tokens1 = marked.lexer('Hello world');
    let matchLen1 = 0;
    for (; matchLen1 < Math.min(oldRaws1.length, tokens1.length); matchLen1++) {
      if (oldRaws1[matchLen1] !== tokens1[matchLen1].raw) break;
    }
    worker.onmessage!({
      data: {
        id: worker.posted[0].id,
        matchLen: matchLen1,
        tail: tokens1.slice(matchLen1),
      },
    });

    // Resolving the in-flight request must trigger exactly one follow-up
    // dispatch carrying the text that accumulated in the meantime. The worker
    // is now known to hold 'Hello world', so that follow-up is a delta and the
    // coalesced chunk is what it carries.
    expect(worker.posted.length).toBe(2);
    expect(worker.posted[1].append).toBe('!');
    expect(worker.posted[1].expectedLength).toBe('Hello world!'.length);

    // Again derived locally, not echoed back in the request.
    const oldRaws2 = marked.lexer('Hello world').map((t) => t.raw);
    const tokens2 = marked.lexer('Hello world!');
    let matchLen2 = 0;
    for (; matchLen2 < Math.min(oldRaws2.length, tokens2.length); matchLen2++) {
      if (oldRaws2[matchLen2] !== tokens2[matchLen2].raw) break;
    }
    worker.onmessage!({
      data: {
        id: worker.posted[1].id,
        matchLen: matchLen2,
        tail: tokens2.slice(matchLen2),
      },
    });

    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe('Hello world!');
  });

  it('discards a worker reply for a document that setContent already replaced', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# original');
    const anyMd = md as unknown as {
      tokens: Array<{ raw: string }>;
      rawMarkdown: string;
      content: { children: unknown[] };
    };

    md.appendMarkdown('\n\nstreamed tail');
    const worker = MockWorker.instances.at(-1)!;
    const inFlightId = worker.posted.at(-1)!.id;

    // The caller replaces the whole document while that request is still out —
    // switching conversation threads mid-stream, for instance.
    md.setContent('# completely different document');
    const tokensAfter = anyMd.tokens.map((t) => t.raw);
    const childrenAfter = anyMd.content.children.length;

    // Now the stale reply lands. Its matchLen and tail describe the OLD
    // document, and its closure holds the OLD token snapshot; applying it
    // rebuilds the tree from a document that no longer exists, leaving
    // `tokens` disagreeing with `rawMarkdown` so the NEXT append diffs
    // against tokens the source never had.
    worker.onmessage!({
      data: {
        id: inFlightId,
        matchLen: 1,
        tail: marked.lexer('# original\n\nstreamed tail').slice(1),
      },
    });

    expect(anyMd.rawMarkdown).toBe('# completely different document');
    expect(anyMd.tokens.map((t) => t.raw)).toEqual(tokensAfter);
    expect(anyMd.content.children.length).toBe(childrenAfter);
  });

  it('keeps streaming after a setContent that dropped an in-flight request', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown } = await import('../src/index');
    const md = new Markdown('# original');
    const anyMd = md as unknown as {
      rawMarkdown: string;
      tokens: Array<{ raw: string }>;
    };

    md.appendMarkdown('\n\nstreamed tail');
    const worker = MockWorker.instances.at(-1)!;
    const postsBefore = worker.posted.length;

    md.setContent('# replaced');

    // Dropping the callback is only half the fix: `appendInFlight` gates every
    // future dispatch, so leaving it set would make the next append set
    // `appendPending` and wait forever for a reply that can never arrive.
    md.appendMarkdown(' and more');
    expect(worker.posted.length).toBe(postsBefore + 1);

    const post = worker.posted.at(-1)!;
    // The worker's source describes the replaced document, so this must be the
    // full shape rather than a delta sliced from a stale offset.
    expect(post.text).toBe('# replaced and more');
    expect(post.append).toBeUndefined();

    const tokens = marked.lexer('# replaced and more');
    worker.onmessage!({ data: { id: post.id, matchLen: 0, tail: tokens } });
    expect(anyMd.tokens.map((t) => t.raw).join('')).toContain('and more');
  });
});
