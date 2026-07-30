// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity } from '@vectojs/core';
import type { RichText } from '@vectojs/ui';
import { Markdown } from '../src/Markdown';

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface SpanShape {
  text: string;
  style?: {
    bold?: boolean;
    italic?: boolean;
    fontFamily?: string;
    href?: string;
  };
}

/** Rendered spans of the document's last block. */
function tailSpans(md: Markdown): SpanShape[] {
  const last = md.content.children.at(-1) as RichText | undefined;
  if (!last || !('spans' in last)) throw new Error('Trailing block is not a RichText');
  return last.spans as SpanShape[];
}

/** Flat text of the document's last block, syntax characters included. */
function tailText(md: Markdown): string {
  return tailSpans(md)
    .map((span) => span.text)
    .join('');
}

describe('incompleteMode', () => {
  describe("'literal' (the default)", () => {
    it('leaves unclosed syntax as plain text, exactly as marked lexes it', () => {
      const md = new Markdown('');
      const stream = md.createStream();
      void stream.write('a **bo');
      stream.flush();

      expect(tailText(md)).toBe('a **bo');
      expect(tailSpans(md).some((span) => span.style?.bold)).toBe(false);
    });

    it('is the mode when no option is passed at all', () => {
      const md = new Markdown('');
      const stream = md.createStream({ maxBufferedChars: 128 });
      void stream.write('`cod');
      stream.flush();

      expect(tailText(md)).toBe('`cod');
      expect(tailSpans(md).some((span) => span.style?.fontFamily)).toBe(false);
    });
  });

  describe("'optimistic'", () => {
    it('renders unclosed strong as bold with the syntax hidden', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('a **bo');
      stream.flush();

      expect(tailText(md)).toBe('a bo');
      const guessed = tailSpans(md).at(-1)!;
      expect(guessed.text).toBe('bo');
      expect(guessed.style?.bold).toBe(true);
    });

    it('renders unclosed emphasis as italic', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('so *it');
      stream.flush();

      const guessed = tailSpans(md).at(-1)!;
      expect(guessed.text).toBe('it');
      expect(guessed.style?.italic).toBe(true);
      expect(guessed.style?.bold).toBeUndefined();
    });

    it('renders unclosed inline code in the theme code font', () => {
      const md = new Markdown('', {
        theme: { codeFont: 'MonoTest', codeColor: '#abcdef' },
      });
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('run `cod');
      stream.flush();

      const guessed = tailSpans(md).at(-1)!;
      expect(guessed.text).toBe('cod');
      expect(guessed.style?.fontFamily).toBe('MonoTest');
    });

    it('renders an unclosed link as its label only, with no href to click', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('see [the docs](https://exa');
      stream.flush();

      // No closing paren means no known URL, so nothing may imply a live link.
      expect(tailText(md)).toBe('see the docs');
      const guessed = tailSpans(md).at(-1)!;
      expect(guessed.text).toBe('the docs');
      expect(guessed.style?.href).toBeUndefined();
    });

    it('renders identically to literal when the trailing paragraph is balanced', () => {
      const source = 'a **bold** and *i* and `c` done';
      const literal = new Markdown('');
      const literalStream = literal.createStream();
      void literalStream.write(source);
      literalStream.flush();

      const optimistic = new Markdown('');
      const optimisticStream = optimistic.createStream({
        incompleteMode: 'optimistic',
      });
      void optimisticStream.write(source);
      optimisticStream.flush();

      expect(tailSpans(optimistic)).toEqual(tailSpans(literal));
    });

    it('tracks a construct split across two writes rather than one chunk in isolation', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('**b');
      stream.flush();
      expect(tailSpans(md).at(-1)!.style?.bold).toBe(true);

      // The second chunk closes it: marked now produces a real `strong` token, so
      // the guess must not be applied a second time on top of it.
      void stream.write('old** after');
      stream.flush();

      const spans = tailSpans(md);
      expect(tailText(md)).toBe('bold after');
      expect(spans.filter((span) => span.style?.bold).length).toBe(1);
      expect(spans.find((span) => span.style?.bold)!.text).toBe('bold');
    });

    it('leaves already-closed constructs before the guess untouched', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('x **done** then `op');
      stream.flush();

      const spans = tailSpans(md);
      expect(spans.some((span) => span.style?.bold && span.text === 'done')).toBe(true);
      expect(spans.at(-1)!.text).toBe('op');
      expect(tailText(md)).toBe('x done then op');
    });

    it('does not italicize an intraword underscore', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('call snake_ca');
      stream.flush();

      // `_` cannot open emphasis intraword in CommonMark, so an identifier must
      // not turn italic halfway through being typed.
      expect(tailText(md)).toBe('call snake_ca');
      expect(tailSpans(md).some((span) => span.style?.italic)).toBe(false);
    });

    it('does not guess on a marker with no content after it', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('trailing **');
      stream.flush();

      expect(tailText(md)).toBe('trailing **');
    });

    it('does not guess on an emphasis marker followed by a space', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('5 * 3 = 15');
      stream.flush();

      expect(tailText(md)).toBe('5 * 3 = 15');
      expect(tailSpans(md).some((span) => span.style?.italic)).toBe(false);
    });

    it('only ever guesses on the trailing paragraph, not an earlier one', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('first **bo');
      stream.flush();
      expect(tailSpans(md).at(-1)!.style?.bold).toBe(true);

      // A new block after it freezes the earlier paragraph: no further text can
      // land there, so its guess can never close and must be dropped now.
      void stream.write('\n\nsecond line');
      stream.flush();

      const first = md.content.children[0] as RichText;
      expect(first.spans.map((span) => span.text).join('')).toBe('first **bo');
      expect((first.spans as SpanShape[]).some((span) => span.style?.bold)).toBe(false);
    });

    it('does not guess inside a heading, list item, or blockquote', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('# head **bo\n\n- item *it\n\n> quote `co');
      stream.flush();

      // Only the trailing block is eligible, and here it is a blockquote — the
      // scan is defined over trailing PARAGRAPH tokens only.
      const heading = md.content.children[0] as RichText;
      expect(heading.spans.map((s) => s.text).join('')).toContain('**bo');
    });

    it('converges with a literal stream once the source is closed', async () => {
      const finalSource = 'text **bold** and `code` and [l](https://e.com)';
      const optimistic = new Markdown('');
      const stream = optimistic.createStream({ incompleteMode: 'optimistic' });
      // Deliberately split mid-construct so a guess is live between writes.
      for (const chunk of ['text **bo', 'ld** and `co', 'de` and [l](https', '://e.com)']) {
        void stream.write(chunk);
        stream.flush();
      }
      await stream.close();

      const direct = new Markdown(finalSource);
      expect(tailSpans(optimistic)).toEqual(tailSpans(direct));
    });

    it('converges with a literal stream when a construct never closes', async () => {
      const finalSource = 'ends with **unclosed';
      const optimistic = new Markdown('');
      const stream = optimistic.createStream({ incompleteMode: 'optimistic' });
      void stream.write(finalSource);
      stream.flush();
      expect(tailSpans(optimistic).at(-1)!.style?.bold).toBe(true);

      await stream.close();

      // close() unwinds the guess: the final document is marked's own output,
      // literal asterisks and all.
      const direct = new Markdown(finalSource);
      expect(tailSpans(optimistic)).toEqual(tailSpans(direct));
      expect(tailText(optimistic)).toBe('ends with **unclosed');
    });

    it('unwinds the guess on abort as well as close', () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('gone **bo');
      stream.flush();
      expect(tailSpans(md).at(-1)!.style?.bold).toBe(true);

      stream.abort();

      expect(tailText(md)).toBe('gone **bo');
      expect(tailSpans(md).some((span) => span.style?.bold)).toBe(false);
    });

    it('stops guessing for appends made after the stream closed', async () => {
      const md = new Markdown('');
      const stream = md.createStream({ incompleteMode: 'optimistic' });
      void stream.write('one');
      await stream.close();

      md.appendMarkdown(' **bo');

      // The mode belonged to that stream; a direct append is always literal.
      expect(tailText(md)).toBe('one **bo');
      expect(tailSpans(md).some((span) => span.style?.bold)).toBe(false);
    });
  });
});

describe('onStable', () => {
  it('fires exactly once on a successful close, with the final blocks', async () => {
    const md = new Markdown('');
    const calls: Array<readonly Entity[]> = [];
    const stream = md.createStream({
      onStable: (blocks) => {
        calls.push(blocks);
      },
    });

    void stream.write('# title\n\nbody text');
    stream.flush();
    expect(calls.length).toBe(0);

    await stream.close();

    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(md.content.children.length);
    expect([...calls[0]]).toEqual([...md.content.children]);
  });

  it('hands over a snapshot, not a live reference to the children array', async () => {
    const md = new Markdown('');
    let captured: readonly Entity[] = [];
    const stream = md.createStream({
      onStable: (blocks) => {
        captured = blocks;
      },
    });
    void stream.write('para one');
    await stream.close();

    const lengthAtCallback = captured.length;
    md.appendMarkdown('\n\npara two');

    expect(captured.length).toBe(lengthAtCallback);
    expect(md.content.children.length).toBeGreaterThan(lengthAtCallback);
  });

  it('does not fire on flush alone', () => {
    const md = new Markdown('');
    let fired = 0;
    const stream = md.createStream({
      onStable: () => {
        fired++;
      },
    });

    void stream.write('still streaming');
    stream.flush();

    expect(fired).toBe(0);
  });

  it('does not fire on abort', () => {
    const md = new Markdown('');
    let fired = 0;
    const stream = md.createStream({
      onStable: () => {
        fired++;
      },
    });

    void stream.write('partial');
    stream.abort();

    expect(fired).toBe(0);
  });

  it('does not fire on destroy', () => {
    const md = new Markdown('');
    let fired = 0;
    const stream = md.createStream({
      onStable: () => {
        fired++;
      },
    });

    void stream.write('partial');
    stream.destroy();

    expect(fired).toBe(0);
  });

  it('fires under the literal default, independent of incompleteMode', async () => {
    const md = new Markdown('');
    let fired = 0;
    const stream = md.createStream({
      onStable: () => {
        fired++;
      },
    });
    void stream.write('plain **bo');
    await stream.close();

    expect(fired).toBe(1);
    expect(tailText(md)).toBe('plain **bo');
  });

  it('rejects a reentrant appendMarkdown from inside the callback', async () => {
    const md = new Markdown('');
    let thrown: unknown = null;
    const stream = md.createStream({
      onStable: () => {
        try {
          md.appendMarkdown('more');
        } catch (error) {
          thrown = error;
        }
      },
    });
    void stream.write('body');
    await stream.close();

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('onStable');
  });

  it('rejects a reentrant setContent from inside the callback', async () => {
    const md = new Markdown('');
    let thrown: unknown = null;
    const stream = md.createStream({
      onStable: () => {
        try {
          md.setContent('replaced');
        } catch (error) {
          thrown = error;
        }
      },
    });
    void stream.write('body');
    await stream.close();

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('onStable');
  });

  it('turns a throwing callback into a rejected close, still releasing the stream', async () => {
    const md = new Markdown('');
    const stream = md.createStream({
      onStable: () => {
        throw new Error('callback exploded');
      },
    });
    void stream.write('body');

    await expect(stream.close()).rejects.toThrow('callback exploded');
    // Released either way: a failed callback must not strand the controller and
    // block every future createStream() on this instance.
    expect(() => md.createStream()).not.toThrow();
  });

  it('leaves close() resolving normally when no callback is supplied', async () => {
    const md = new Markdown('');
    const stream = md.createStream();
    void stream.write('body');

    await expect(stream.close()).resolves.toBeUndefined();
    expect(stream.state).toBe('closed');
  });
});
