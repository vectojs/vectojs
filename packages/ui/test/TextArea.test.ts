// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Scene } from '@vecto-ui/core';
import { TextArea, wrapText } from '../src/TextArea';

/** Deterministic measurer: every character is 1 unit wide. */
const len = (s: string) => s.length;

describe('wrapText', () => {
  it('returns a single empty line for empty input', () => {
    expect(wrapText('', 10, len)).toEqual([{ text: '', start: 0, end: 0 }]);
  });

  it('keeps a short line unwrapped', () => {
    expect(wrapText('hello', 10, len)).toEqual([{ text: 'hello', start: 0, end: 5 }]);
  });

  it('splits on hard newlines and consumes the newline char', () => {
    expect(wrapText('ab\ncd', 10, len)).toEqual([
      { text: 'ab', start: 0, end: 2 },
      { text: 'cd', start: 3, end: 5 },
    ]);
  });

  it('emits a trailing empty line for a trailing newline (caret can sit there)', () => {
    expect(wrapText('ab\n', 10, len)).toEqual([
      { text: 'ab', start: 0, end: 2 },
      { text: '', start: 3, end: 3 },
    ]);
  });

  it('soft-wraps on word boundaries, consuming the break space', () => {
    // "hello world", width 5: "hello" fits, break before "world".
    expect(wrapText('hello world', 5, len)).toEqual([
      { text: 'hello', start: 0, end: 5 },
      { text: 'world', start: 6, end: 11 },
    ]);
  });

  it('breaks an over-long single word at the character level', () => {
    expect(wrapText('abcdefgh', 3, len)).toEqual([
      { text: 'abc', start: 0, end: 3 },
      { text: 'def', start: 3, end: 6 },
      { text: 'gh', start: 6, end: 8 },
    ]);
  });

  it('covers the whole string: first.start=0 and last.end=length', () => {
    const v = 'the quick brown fox\njumps over';
    const lines = wrapText(v, 9, len);
    expect(lines[0].start).toBe(0);
    expect(lines[lines.length - 1].end).toBe(v.length);
  });
});

/** A no-op-everything 2D context so the render loop runs headless. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function makeScene(): { scene: Scene; root: HTMLElement; tick: (n?: number) => void } {
  const ctx = fakeCtx();
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
  };
  return { scene, root: host, tick };
}

describe('TextArea component', () => {
  it('projects a real <textarea> shadow node with placeholder + value', () => {
    const { scene, root, tick } = makeScene();
    scene.add(
      new TextArea({ width: 200, height: 80, placeholder: 'Notes', value: 'hi' }).setPosition(0, 0),
    );
    tick();
    const ta = root.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.placeholder).toBe('Notes');
    expect(ta.value).toBe('hi');
  });

  it('flows edits from the shadow textarea back into value + onChange', () => {
    const onChange = vi.fn();
    const { scene, root, tick } = makeScene();
    const area = new TextArea({ width: 200, height: 80, onChange }).setPosition(0, 0);
    scene.add(area);
    tick();

    const ta = root.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'line one\nline two';
    ta.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenLastCalledWith('line one\nline two');
    expect(area.value).toBe('line one\nline two');
  });

  it('renders multiple frames without throwing for multi-line content', () => {
    const { scene, tick } = makeScene();
    const area = new TextArea({ width: 120, height: 80, value: 'alpha beta gamma\ndelta' });
    scene.add(area.setPosition(10, 10));
    expect(() => tick(3)).not.toThrow();
  });

  it('maps a caret offset to the correct line and behaves on the last line', () => {
    const area = new TextArea({ width: 200, height: 80, value: 'ab\ncde' });
    // offset 0 → line 0; offset 5 (within "cde") → line 1
    expect(area.lineOfOffset(0)).toBe(0);
    expect(area.lineOfOffset(5)).toBe(1);
  });
});
