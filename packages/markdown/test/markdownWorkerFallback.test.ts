// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { marked } from 'marked';

// jsdom supports neither Worker nor URL.createObjectURL — mock both so the
// module-level worker bootstrap in Markdown.ts actually runs.
class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public posted: Array<{ id: number; text: string; oldRaws?: string[] }> = [];
  constructor(_url: string) {
    MockWorker.instances.push(this);
  }
  postMessage(data: { id: number; text: string; oldRaws?: string[] }): void {
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

  it('sends oldRaws and reconstructs full tokens from a (matchLen, tail) delta response', async () => {
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
    expect(worker.posted[0].oldRaws).toEqual(oldRaws);

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

    const oldRaws1 = worker.posted[0].oldRaws!;
    const tokens1 = marked.lexer('Hello world');
    let matchLen1 = 0;
    for (; matchLen1 < Math.min(oldRaws1.length, tokens1.length); matchLen1++) {
      if (oldRaws1[matchLen1] !== tokens1[matchLen1].raw) break;
    }
    worker.onmessage!({
      data: { id: worker.posted[0].id, matchLen: matchLen1, tail: tokens1.slice(matchLen1) },
    });

    // Resolving the in-flight request must trigger exactly one follow-up
    // dispatch carrying the text that accumulated in the meantime.
    expect(worker.posted.length).toBe(2);
    expect(worker.posted[1].text).toBe('Hello world!');

    const oldRaws2 = worker.posted[1].oldRaws!;
    const tokens2 = marked.lexer('Hello world!');
    let matchLen2 = 0;
    for (; matchLen2 < Math.min(oldRaws2.length, tokens2.length); matchLen2++) {
      if (oldRaws2[matchLen2] !== tokens2[matchLen2].raw) break;
    }
    worker.onmessage!({
      data: { id: worker.posted[1].id, matchLen: matchLen2, tail: tokens2.slice(matchLen2) },
    });

    expect((md as unknown as { rawMarkdown: string }).rawMarkdown).toBe('Hello world!');
  });
});
