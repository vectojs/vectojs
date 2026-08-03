// @vitest-environment jsdom
//
// Document-level front matter behaviour: what a `Markdown` renders, what it
// exposes, and how a stream that straddles the block behaves. The scanner's own
// verdicts are tested in `frontMatter.test.ts`.
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from '../src/Markdown';

// `HorizontalRule` is not exported, and exporting it purely for a test would
// widen the public API for no caller. Its constructor name is enough to tell a
// painted rule from a heading.
const kinds = (md: Markdown): string[] => md.content.children.map((c) => c.constructor.name);
const textOf = (md: Markdown, i: number): string =>
  ((md.content.children[i] as unknown as { spans?: { text: string }[] }).spans ?? [])
    .map((s) => s.text)
    .join('');
const body = (md: Markdown): string => (md as unknown as { rawMarkdown: string }).rawMarkdown;

describe('front matter is metadata, not content', () => {
  it('renders only the body, not a rule and a heading made of its own metadata', () => {
    const md = new Markdown('---\ntitle: A\nauthor: B\n---\n# Body\n\ntext');
    // Before this stripping existed marked emitted `hr` + setext `heading` for
    // the block: the opening `---` hit the thematic-break rule and the closing
    // one underlined the keys. So the document painted a horizontal rule and a
    // 28px bold "title: A\nauthor: B".
    expect(kinds(md)).not.toContain('HorizontalRule');
    expect(textOf(md, 0)).toBe('Body');
    expect(md.content.children.length).toBe(2);
  });

  it('exposes the block verbatim and as parsed fields', () => {
    const md = new Markdown('---\ntitle: A\nauthor: B\n---\n# Body');
    expect(md.frontMatter).toBe('title: A\nauthor: B\n');
    expect(md.frontMatterFields).toEqual({ title: 'A', author: 'B' });
  });

  it('reports no front matter for a document without any', () => {
    const md = new Markdown('# Body');
    expect(md.frontMatter).toBe('');
    expect(md.frontMatterFields).toEqual({});
    expect(textOf(md, 0)).toBe('Body');
  });

  it('keeps the body text out of the lexer input entirely', () => {
    const md = new Markdown('---\ntitle: A\n---\n# Body');
    // The private body string is what `workerSourceLen` and `expectedLength` are
    // offsets into, so front matter surviving here would corrupt the worker
    // delta protocol rather than merely render wrong.
    expect(body(md)).toBe('# Body');
  });

  it('renders a document that is nothing but front matter as empty', () => {
    const md = new Markdown('---\ntitle: A\n---');
    expect(md.content.children.length).toBe(0);
    expect(md.frontMatterFields).toEqual({ title: 'A' });
  });

  it('still renders a leading thematic break as a rule', () => {
    // The false-positive guard, at document level: a real `---` at the top must
    // survive. Silently eating it would delete the top of the document.
    const md = new Markdown('---\n\n# Body');
    expect(kinds(md)[0]).toBe('HorizontalRule');
  });

  it('resets front matter across setContent', () => {
    const md = new Markdown('---\ntitle: A\n---\n# One');
    expect(md.frontMatter).toBe('title: A\n');
    md.setContent('# Two');
    // Stale metadata from a replaced document would be worse than none: it reads
    // as current.
    expect(md.frontMatter).toBe('');
    expect(md.frontMatterFields).toEqual({});
    expect(textOf(md, 0)).toBe('Two');

    md.setContent('---\ntitle: C\n---\n# Three');
    expect(md.frontMatterFields).toEqual({ title: 'C' });
    expect(textOf(md, 0)).toBe('Three');
  });
});

describe('front matter across a stream', () => {
  it('holds back an unclosed block instead of painting a rule it must undo', () => {
    const md = new Markdown('');
    md.appendMarkdown('---\n');
    md.appendMarkdown('title: A\n');
    // Nothing may render yet: this prefix is still a candidate block. Lexing it
    // would paint a thematic break plus a paragraph that the closing delimiter
    // then has to tear down — and tearing it down means shrinking the body
    // string the worker holds an offset into.
    expect(md.content.children.length).toBe(0);
    expect(md.frontMatter).toBe('');

    md.appendMarkdown('---\n# Body');
    expect(md.frontMatter).toBe('title: A\n');
    expect(textOf(md, 0)).toBe('Body');
    expect(kinds(md)).not.toContain('HorizontalRule');
  });

  it('recognises a block split mid-delimiter', () => {
    const md = new Markdown('');
    for (const chunk of ['-', '-', '-', '\nti', 'tle: A\n-', '--\n# Body']) {
      md.appendMarkdown(chunk);
    }
    expect(md.frontMatterFields).toEqual({ title: 'A' });
    expect(textOf(md, 0)).toBe('Body');
  });

  it('releases a held prefix as soon as it cannot be front matter', () => {
    const md = new Markdown('');
    md.appendMarkdown('-');
    // `-` alone is undecidable — it may open `---`.
    expect(md.content.children.length).toBe(0);
    md.appendMarkdown(' item');
    // Now it is a list, and it must appear rather than stay held.
    expect(md.content.children.length).toBe(1);
    expect(body(md)).toBe('- item');
  });

  it('releases an unterminated block as content when the stream closes', async () => {
    const md = new Markdown('');
    const stream = md.createStream();
    void stream.write('---\ntitle: A');
    stream.flush();
    expect(md.content.children.length).toBe(0);

    await stream.close();
    // The stream ended with the block still open, so it was never metadata —
    // it is content, exactly as marked rendered it before this stripping
    // existed. Leaving it held would render the document permanently blank.
    expect(md.frontMatter).toBe('');
    expect(body(md)).toBe('---\ntitle: A');
    expect(md.content.children.length).toBeGreaterThan(0);
    expect(kinds(md)).toContain('HorizontalRule');
  });

  it('hands onStable a document that includes the released text', async () => {
    const md = new Markdown('');
    let stableCount = -1;
    const stream = md.createStream({
      onStable: (blocks) => {
        stableCount = blocks.length;
      },
    });
    void stream.write('---\ntitle: A');
    await stream.close();
    // onStable's contract is "the finished document", so the release has to
    // happen before settlement, not after.
    expect(stableCount).toBeGreaterThan(0);
    expect(stableCount).toBe(md.content.children.length);
  });

  it('closes cleanly when the block completed normally', async () => {
    const md = new Markdown('');
    const stream = md.createStream();
    void stream.write('---\ntitle: A\n---\n# Body');
    await stream.close();
    expect(md.frontMatterFields).toEqual({ title: 'A' });
    expect(textOf(md, 0)).toBe('Body');
  });
});

describe('front matter and the worker delta protocol', () => {
  class MockWorker {
    static instances: MockWorker[] = [];
    public onmessage: ((e: { data: unknown }) => void) | null = null;
    public onerror: ((e: unknown) => void) | null = null;
    public posted: Array<{
      id: number;
      text?: string;
      append?: string;
      expectedLength?: number;
    }> = [];
    constructor(_url: string) {
      MockWorker.instances.push(this);
    }
    postMessage(data: { id: number; text?: string; append?: string }): void {
      this.posted.push(data);
    }
    terminate(): void {}
  }

  it('never posts front matter to the worker, and keeps expectedLength on the body', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown: MD } = await import('../src/index');
    const md = new MD('---\ntitle: A\n---\n# Body');
    md.appendMarkdown('\n\nmore');

    const worker = MockWorker.instances.at(-1)!;
    expect(worker.posted.length).toBe(1);
    const posted = worker.posted[0];
    // The worker reassembles what it lexes as `cached.source + append` and
    // rejects a length mismatch with a resync. Stripping on the main thread ahead
    // of that arithmetic is what lets the worker have no notion of front matter
    // at all — so a `title:` reaching it here is a protocol bug, not a cosmetic
    // one.
    expect(posted.text).toBe('# Body\n\nmore');
    expect(posted.text).not.toContain('title');
    expect(posted.expectedLength ?? posted.text!.length).toBe('# Body\n\nmore'.length);

    vi.unstubAllGlobals();
  });

  it('does not post at all while text is held for an unclosed block', async () => {
    vi.resetModules();
    vi.stubGlobal('Worker', MockWorker);
    URL.createObjectURL = (() => 'blob:mock') as never;
    HTMLCanvasElement.prototype.getContext = (() => null) as never;

    const { Markdown: MD } = await import('../src/index');
    const md = new MD('');
    const before = MockWorker.instances.at(-1)!.posted.length;
    md.appendMarkdown('---\ntitle: A\n');
    // The chunk produced no body text, so a dispatch would post a zero-length
    // delta and spend a round trip to be told nothing changed.
    expect(MockWorker.instances.at(-1)!.posted.length).toBe(before);

    vi.unstubAllGlobals();
  });
});
