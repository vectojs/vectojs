// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';

// jsdom has neither Worker nor URL.createObjectURL, so the module-level worker
// bootstrap in Markdown.ts is skipped unless both are stubbed. Mirrors the mock
// in markdownWorkerFallback.test.ts.
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
  postMessage(data: { id: number }): void {
    this.posted.push(data as MockWorker['posted'][number]);
  }
  terminate(): void {}
}

async function loadMarkdown(): Promise<typeof import('../src/index')> {
  vi.resetModules();
  vi.stubGlobal('Worker', MockWorker);
  URL.createObjectURL = (() => 'blob:mock') as never;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  return import('../src/index');
}

/** Compute the (matchLen, tail) reply the real worker would send for `source`. */
function workerReply(
  source: string,
  priorRaws: string[],
): { matchLen: number; tail: ReturnType<typeof marked.lexer> } {
  const tokens = marked.lexer(source);
  let matchLen = 0;
  const minLen = Math.min(priorRaws.length, tokens.length);
  for (; matchLen < minLen; matchLen++) {
    if (priorRaws[matchLen] !== tokens[matchLen].raw) break;
  }
  return {
    matchLen,
    tail: tokens.slice(matchLen) as ReturnType<typeof marked.lexer>,
  };
}

/** Resolve after enough microtask turns for a settled close() to have run. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('close() settlement against the worker', () => {
  it('does not resolve until the in-flight worker reply has been applied', async () => {
    const { Markdown } = await loadMarkdown();
    const md = new Markdown('');
    const stream = md.createStream();

    void stream.write('# title');
    // flush() commits the chunk, which posts to the worker and returns — the
    // document does NOT reflect it yet.
    stream.flush();
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    let resolved = false;
    const closed = stream.close().then(() => {
      resolved = true;
    });

    await drainMicrotasks();
    // The reply is still outstanding, so close() must still be pending: this is
    // the guarantee `onStable`'s "final blocks" contract rests on.
    expect(resolved).toBe(false);
    expect(md.content.children.length).toBe(0);

    const { matchLen, tail } = workerReply('# title', []);
    worker.onmessage!({ data: { id: worker.posted[0].id, matchLen, tail } });

    await closed;
    expect(resolved).toBe(true);
    expect(md.content.children.length).toBe(1);
  });

  it('gives onStable the post-reply document, not the pre-reply one', async () => {
    const { Markdown } = await loadMarkdown();
    const md = new Markdown('');
    let seen = -1;
    const stream = md.createStream({
      onStable: (blocks) => {
        seen = blocks.length;
      },
    });

    void stream.write('para one\n\npara two');
    stream.flush();
    const worker = MockWorker.instances.at(-1)!;

    const closed = stream.close();
    await drainMicrotasks();
    expect(seen).toBe(-1);

    const { matchLen, tail } = workerReply('para one\n\npara two', []);
    worker.onmessage!({ data: { id: worker.posted[0].id, matchLen, tail } });
    await closed;

    expect(seen).toBe(md.content.children.length);
    expect(seen).toBeGreaterThan(0);
  });

  it('waits through a coalesced re-dispatch instead of resolving one chunk early', async () => {
    const { Markdown } = await loadMarkdown();
    const md = new Markdown('');
    let fired = 0;
    const stream = md.createStream({
      onStable: () => {
        fired++;
      },
    });

    void stream.write('A');
    stream.flush();
    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    // Second chunk while request #1 is in flight: only one lex request may be
    // outstanding, so this sets appendPending rather than posting.
    void stream.write('B');
    stream.flush();
    expect(worker.posted.length).toBe(1);

    let resolved = false;
    const closed = stream.close().then(() => {
      resolved = true;
    });
    await drainMicrotasks();
    expect(resolved).toBe(false);

    // Reply #1 applies 'A' and immediately re-dispatches for 'AB'. Inside that
    // callback appendInFlight goes false and then straight back to true, both
    // synchronously — a naive "resolve when the flag clears" would fire here,
    // one chunk early.
    const first = workerReply('A', []);
    worker.onmessage!({ data: { id: worker.posted[0].id, ...first } });
    await drainMicrotasks();

    expect(worker.posted.length).toBe(2);
    expect(resolved).toBe(false);
    expect(fired).toBe(0);

    const second = workerReply(
      'AB',
      marked.lexer('A').map((t) => t.raw),
    );
    worker.onmessage!({ data: { id: worker.posted[1].id, ...second } });
    await closed;

    expect(resolved).toBe(true);
    expect(fired).toBe(1);
    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe('AB');
    const tail = md.content.children.at(-1) as {
      spans: Array<{ text: string }>;
    };
    expect(tail.spans.map((s) => s.text).join('')).toBe('AB');
  });

  it('resolves close() even when the worker fails and the fallback lexer throws', async () => {
    const { Markdown } = await loadMarkdown();
    const md = new Markdown('');
    const stream = md.createStream();

    void stream.write('body text');
    stream.flush();
    const worker = MockWorker.instances.at(-1)!;

    const closed = stream.close();
    await drainMicrotasks();

    // Worker error → main-thread fallback parse → that throws too. Neither path
    // can produce an update, so nothing would ever clear the in-flight flag and
    // close() would hang forever without the dropped-request path.
    const lexerSpy = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('lexer exploded');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      worker.onmessage!({ data: { id: worker.posted[0].id, error: 'boom' } });
      await expect(closed).resolves.toBeUndefined();
    } finally {
      lexerSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('unwinds an optimistic guess before onStable sees the blocks', async () => {
    const { Markdown } = await loadMarkdown();
    const md = new Markdown('');
    let guessVisible: boolean | null = null;
    const stream = md.createStream({
      incompleteMode: 'optimistic',
      onStable: (blocks) => {
        const tail = blocks.at(-1) as {
          spans?: Array<{ style?: { bold?: boolean } }>;
        };
        guessVisible = (tail.spans ?? []).some((span) => span.style?.bold);
      },
    });

    void stream.write('ends **unclosed');
    stream.flush();
    const worker = MockWorker.instances.at(-1)!;
    const { matchLen, tail } = workerReply('ends **unclosed', []);
    worker.onmessage!({ data: { id: worker.posted[0].id, matchLen, tail } });

    const bold = (
      md.content.children.at(-1) as {
        spans: Array<{ style?: { bold?: boolean } }>;
      }
    ).spans;
    expect(bold.some((span) => span.style?.bold)).toBe(true);

    await stream.close();

    // The callback must observe the converged document, never a guess.
    expect(guessVisible).toBe(false);
  });
});
