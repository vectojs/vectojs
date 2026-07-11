// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// jsdom supports neither Worker nor URL.createObjectURL — mock both so the
// module-level worker bootstrap in Markdown.ts actually runs.
class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public posted: Array<{ id: number; text: string }> = [];
  constructor(_url: string) {
    MockWorker.instances.push(this);
  }
  postMessage(data: { id: number; text: string }): void {
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
});
