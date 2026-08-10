// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';

/**
 * The flush guard: a worker reply must not release settlement waiters while a
 * lazy MathJax load is still outstanding.
 *
 * This needs BOTH a real (mocked) worker and an unloaded MathJax at the same
 * time, which is why it is its own file rather than a case in
 * `lazyMathJaxSettlement.test.ts`. jsdom has no `Worker`, so the other lazy tests
 * run the synchronous fallback path where `appendInFlight` is never set — and a
 * waiter that is never registered cannot be released early, so they cannot
 * observe this guard at all. `vi.resetModules()` also gives this file a freshly
 * unloaded MathJax independent of test order.
 *
 * The sequence that matters: `close()` registers a waiter while the append is in
 * flight, THEN the worker reply arrives and its callback ends by flushing. The
 * reply is what renders the closed fence, so `mathLoadPending` becomes true
 * during that same callback, a few statements before the flush. Without the guard
 * the flush releases the waiter and `close()` resolves over a document whose
 * formula is still TeX source.
 */

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

/**
 * A bounded drain for the *negative* assertion below. This is a fixed loop of
 * already-resolved promises, so it always completes and can never be the source
 * of a timeout — draining several turns only makes "the waiter was not released
 * early" a stronger claim than draining one.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('lazy MathJax settlement: a worker reply does not release waiters early', () => {
  it('keeps close() pending until the formula is typeset', async () => {
    const { Markdown, isMathJaxReady } = await loadMarkdown();
    expect(isMathJaxReady()).toBe(false);

    const md = new Markdown('');
    const stream = md.createStream();

    const source = '```math\n\\psi_{flush}\n```';
    void stream.write(source);
    stream.flush();

    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);

    // Registered while the append is in flight, so this waiter exists before the
    // reply's flush runs — the ordering the guard is about.
    let resolved = false;
    const closed = stream.close().then(() => {
      resolved = true;
    });
    await drainMicrotasks();
    expect(resolved).toBe(false);

    // Deliver the reply. Its callback renders the closed fence (starting the
    // MathJax load) and then flushes settlement waiters.
    const req = worker.posted[0];
    const reply = workerReply(source, req.oldRaws ?? []);
    worker.onmessage?.({
      data: {
        id: req.id,
        matchLen: reply.matchLen,
        tail: reply.tail,
        lexerMs: 0,
      },
    });

    // Condition-based rather than a fixed drain count: settlement here depends on
    // the lazy MathJax load, so the number of microtask turns it takes is not a
    // property of this test. A fixed count that is one turn short waits forever
    // and surfaces as vitest's 5 s default timeout.
    await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 2_000 });
    // Awaited so a rejection fails this test rather than becoming an unhandled
    // rejection attributed to a later file.
    await closed;

    // The formula is typeset by the time close() resolved, not still source.
    //
    // Identified by `constructor.name`, not `instanceof`: `vi.resetModules()`
    // gives the reloaded `../src/index` its own copy of its classes, so the
    // `MathBlock` the document constructs is a different class object from one this
    // file could import statically and every `instanceof` would be false.
    // `Markdown.test.ts` identifies entities the same way for the same reason.
    const container = md.content.children[0] as any;
    expect(container?.constructor?.name).toBe('MathBlock');
    // A typeset formula is an inline object inside a RichText, so that it reaches
    // selection and find-in-page the way inline `$..$` does.
    expect(container?.children?.[0]?.constructor?.name).toBe('RichText');
  });
});
