// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  Text,
  Button,
  Link,
  UIComponent,
  Image,
  Card,
  Stack,
  Input,
  Checkbox,
  Toggle,
  Markdown,
  RichText,
} from '../src/index';
import { LayoutEngine, type IRenderer } from '@vectojs/core';

// jsdom has no canvas getContext; measure.ts falls back to its estimate. Stub to
// keep the test output free of "Not implemented" noise.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** A renderer that records the drawing op names, for asserting render output. */
function recorder(): { ops: string[]; r: IRenderer } {
  const ops: string[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      ops.push(op);
      void args;
    };
  const r = {
    clear: rec('clear'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    scale: rec('scale'),
    rotate: rec('rotate'),
    setGlobalAlpha: rec('setGlobalAlpha'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
    fillCircle: rec('fillCircle'),
    flush: rec('flush'),
    clip: rec('clip'),
    createLinearGradient: vi.fn(() => ({})),
  } as unknown as IRenderer;
  return { ops, r };
}

describe('Text', () => {
  it('exposes its text as the a11y label and sizes to content', () => {
    const t = new Text('Hello world', { lineHeight: 20 });
    expect(t.getA11yAttributes()).toEqual({ label: 'Hello world' });
    expect(t.width).toBeGreaterThan(0);
    expect(t.height).toBe(20); // single line
  });

  it('wraps into multiple lines under maxWidth', () => {
    const t = new Text('aaaa bbbb cccc dddd eeee', {
      font: '16px sans-serif',
      maxWidth: 40,
      lineHeight: 20,
    });
    expect(t.height).toBeGreaterThan(20); // more than one line
  });

  it('honors explicit newlines as separate lines', () => {
    const t = new Text('line one\nline two\nline three', { lineHeight: 20 });
    expect(t.height).toBe(60); // 3 lines * 20
  });

  it('runs the cold layout pass through LayoutEngine', () => {
    const prep = vi.spyOn(LayoutEngine.prototype, 'prepare');
    new Text('hello world', { maxWidth: 200 });
    expect(prep).toHaveBeenCalled(); // Text is a real LayoutEngine consumer now
    prep.mockRestore();
  });

  it('setMaxWidth reflows via the hot path only; setText re-prepares', () => {
    const prep = vi.spyOn(LayoutEngine.prototype, 'prepare');
    const hot = vi.spyOn(LayoutEngine.prototype, 'layoutPrepared');

    const t = new Text('aaaa bbbb cccc dddd', { font: '16px sans-serif', maxWidth: 400 });
    const prepAfterCtor = prep.mock.calls.length;
    const hotAfterCtor = hot.mock.calls.length;
    expect(prepAfterCtor).toBeGreaterThan(0);

    t.setMaxWidth(40); // resize → hot only
    expect(prep.mock.calls.length).toBe(prepAfterCtor); // no re-prepare
    expect(hot.mock.calls.length).toBe(hotAfterCtor + 1);
    expect(t.height).toBeGreaterThan(20); // narrower now wraps

    t.setText('different text'); // content change → re-prepare
    expect(prep.mock.calls.length).toBe(prepAfterCtor + 1);

    prep.mockRestore();
    hot.mockRestore();
  });
});

describe('Button', () => {
  it('projects a native button shadow node', () => {
    const b = new Button('Submit');
    expect(b.getA11yAttributes()).toEqual({ tag: 'button', role: 'button', label: 'Submit' });
  });

  it('fires onClick on an emitted click', () => {
    const onClick = vi.fn();
    const b = new Button('Go', { onClick });
    b.emit('click', { type: 'click' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('auto-sizes from label + padding', () => {
    const b = new Button('OK', { padding: 10 });
    expect(b.width).toBeGreaterThan(20);
    expect(b.height).toBeGreaterThan(20);
  });

  it('parses the px size from a weighted font shorthand (not the weight)', () => {
    // '600 16px ...' must yield height 16 + 2*padding, NOT 600 + 2*padding.
    const b = new Button('X', { font: '600 16px sans-serif', padding: 12 });
    expect(b.height).toBe(16 + 24);
  });

  it('marks on-demand scenes dirty when hover state changes', () => {
    const markDirty = vi.fn();
    const b = new Button('Hover');
    (b as unknown as { _scene: unknown })._scene = { markDirty };

    b.emit('hover', {});
    b.emit('hover', {});
    b.emit('pointerleave', {});

    expect(markDirty).toHaveBeenCalledTimes(2);
  });
});

describe('Link', () => {
  it('projects an anchor shadow node with href', () => {
    const l = new Link('Docs', { href: 'https://example.com' });
    expect(l.getA11yAttributes()).toEqual({
      tag: 'a',
      href: 'https://example.com',
      target: '_blank',
      label: 'Docs',
    });
  });

  it('opens the href on click', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const l = new Link('Docs', { href: 'https://example.com' });
    l.emit('click', {});
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');
    open.mockRestore();
  });
});

describe('Image', () => {
  it('projects an <img> shadow node with src and alt', () => {
    const img = new Image('https://example.com/logo.png', {
      width: 64,
      height: 32,
      alt: 'Logo',
    });
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/logo.png',
      alt: 'Logo',
      label: 'Logo',
    });
    expect(img.width).toBe(64);
    expect(img.height).toBe(32);
  });

  it('draws a placeholder before load and the bitmap after', () => {
    const img = new Image('x.png', { width: 10, height: 10 });
    const before = recorder();
    img.render(before.r);
    expect(before.ops).toContain('roundRect'); // placeholder box, no drawImage yet
    expect(before.ops).not.toContain('drawImage');

    // Simulate the image having loaded.
    (img as unknown as { loaded: boolean }).loaded = true;
    const after = recorder();
    img.render(after.r);
    expect(after.ops).toContain('drawImage');
  });
});

describe('Card', () => {
  it('sizes to its options and draws a rounded background', () => {
    const card = new Card({ width: 200, height: 120, bg: '#1e293b', radius: 12 });
    expect(card.width).toBe(200);
    expect(card.height).toBe(120);
    const { ops, r } = recorder();
    card.render(r);
    expect(ops).toContain('roundRect');
    expect(ops).toContain('fill');
  });

  it('exposes a region role + label only when given one', () => {
    expect(new Card({ width: 10, height: 10 }).interactive).toBe(false);
    const labeled = new Card({ width: 10, height: 10, label: 'Feature' });
    expect(labeled.interactive).toBe(true);
    expect(labeled.getA11yAttributes()).toMatchObject({ role: 'group', label: 'Feature' });
  });
});

describe('Stack', () => {
  it('lays children out vertically with a gap and sizes to fit', () => {
    const a = new Button('A'); // some known box
    const b = new Button('B');
    const stack = new Stack({ direction: 'vertical', gap: 8 });
    stack.add(a);
    stack.add(b);

    expect(a.y).toBe(0);
    expect(b.y).toBe(a.height + 8);
    expect(a.x).toBe(0);
    expect(stack.height).toBe(a.height + 8 + b.height);
    expect(stack.width).toBe(Math.max(a.width, b.width));
  });

  it('lays children out horizontally and centers on the cross axis', () => {
    const a = new Button('Tall', { padding: 20 }); // taller
    const b = new Button('x', { padding: 2 }); // shorter
    const stack = new Stack({ direction: 'horizontal', gap: 10, align: 'center' });
    stack.add(a);
    stack.add(b);

    expect(a.x).toBe(0);
    expect(b.x).toBe(a.width + 10);
    // b is centered within the tallest child's height
    expect(b.y).toBeCloseTo((a.height - b.height) / 2);
  });

  it('wraps children to the next line when wrap is true', () => {
    const stack = new Stack({
      direction: 'horizontal',
      wrap: true,
      gap: 10,
      align: 'start',
      maxWidth: 100,
    });
    const a = new Button('A', { padding: 0 }); // 16px font + padding 0 = width ~16
    const b = new Button('B', { padding: 0 });
    a.width = 60;
    a.height = 20;
    b.width = 60;
    b.height = 20;
    stack.add(a);
    stack.add(b);

    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    // b should wrap to the next line because 60 + 10 + 60 = 130 > 100
    expect(b.x).toBe(0);
    expect(b.y).toBe(20 + 10); // a.height + gap
    expect(stack.height).toBe(20 + 10 + 20); // two rows + gap
    expect(stack.width).toBe(60); // max row width
  });
});

describe('Input', () => {
  it('projects a text <input> with placeholder and current value', () => {
    const input = new Input({ width: 200, placeholder: 'Email', value: 'a@b.com' });
    expect(input.getA11yAttributes()).toMatchObject({
      tag: 'input',
      inputType: 'text',
      placeholder: 'Email',
      value: 'a@b.com',
    });
    expect(input.width).toBe(200);
  });

  it('updates its value from a change event and notifies onChange', () => {
    const onChange = vi.fn();
    const input = new Input({ width: 100, onChange });
    input.emit('change', { value: 'typed', checked: false });
    expect(input.value).toBe('typed');
    expect(onChange).toHaveBeenCalledWith('typed');
  });

  it('renders the value text (or placeholder when empty)', () => {
    const filled = new Input({ width: 100, value: 'hi' });
    const r1 = recorder();
    filled.render(r1.r);
    expect(r1.ops).toContain('fillText');
  });

  it('change event carries selection + composition into the component', () => {
    const input = new Input({ width: 200 });
    input.emit('change', {
      value: 'hello',
      checked: false,
      selectionStart: 1,
      selectionEnd: 3,
      composition: { start: 0, length: 2 },
    });
    expect(input.value).toBe('hello');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(3);
    expect(input.composition).toEqual({ start: 0, length: 2 });
  });

  it('charOffset maps a char index to its measured x', () => {
    const input = new Input({ width: 200 }); // default 16px font → 8px/char in jsdom
    input.emit('change', { value: 'abcd', selectionStart: 4, selectionEnd: 4, composition: null });
    expect((input as any).charOffset(2)).toBe(16); // measureText('ab') = 2 * 16 * 0.5
  });

  it('draws a blinking caret only when focused', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0); // caret ON phase
    const input = new Input({ width: 200 });
    input.emit('change', { value: 'ab', selectionStart: 2, selectionEnd: 2, composition: null });

    const blurred = recorder();
    input.render(blurred.r);
    const strokesBlurred = blurred.ops.filter((o) => o === 'stroke').length;

    input.emit('focus', {});
    const focused = recorder();
    input.render(focused.r);
    const strokesFocused = focused.ops.filter((o) => o === 'stroke').length;

    expect(strokesFocused).toBe(strokesBlurred + 1); // +caret line
    (Date.now as any).mockRestore();
  });

  it('hides the caret on the blink-off phase', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500); // caret OFF phase
    const input = new Input({ width: 200 });
    input.emit('focus', {});
    input.emit('change', { value: 'ab', selectionStart: 2, selectionEnd: 2, composition: null });
    const r = recorder();
    input.render(r.r);
    expect(r.ops.filter((o) => o === 'stroke').length).toBe(1); // border only, no caret
    (Date.now as any).mockRestore();
  });

  it('draws a selection highlight when a range is selected', () => {
    const input = new Input({ width: 200 });

    input.emit('change', { value: 'abcd', selectionStart: 4, selectionEnd: 4, composition: null });
    const noSel = recorder();
    input.render(noSel.r);
    const fillsNoSel = noSel.ops.filter((o) => o === 'fill').length;

    input.emit('change', { value: 'abcd', selectionStart: 1, selectionEnd: 3, composition: null });
    const sel = recorder();
    input.render(sel.r);
    const fillsSel = sel.ops.filter((o) => o === 'fill').length;

    expect(fillsSel).toBe(fillsNoSel + 1); // +selection rect
  });

  it('underlines the composing segment during IME', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500); // caret OFF, isolate the underline stroke
    const input = new Input({ width: 200 });
    input.emit('focus', {});

    input.emit('change', { value: '你好', selectionStart: 2, selectionEnd: 2, composition: null });
    const noComp = recorder();
    input.render(noComp.r);
    const strokesNoComp = noComp.ops.filter((o) => o === 'stroke').length;

    input.emit('change', {
      value: '你好',
      selectionStart: 2,
      selectionEnd: 2,
      composition: { start: 0, length: 2 },
    });
    const comp = recorder();
    input.render(comp.r);
    const strokesComp = comp.ops.filter((o) => o === 'stroke').length;

    expect(strokesComp).toBe(strokesNoComp + 1); // +composition underline
    (Date.now as any).mockRestore();
  });

  it('scrolls so the caret stays within the box for long text', () => {
    const input = new Input({ width: 100, padding: 10 }); // inner width = 80
    const long = 'a'.repeat(50); // charOffset(50) = 50 * 8 = 400 ≫ 80
    input.emit('change', { value: long, selectionStart: 50, selectionEnd: 50, composition: null });
    input.render(recorder().r); // computes scrollLeft
    const cx = (input as any).caretScreenX();
    expect(cx).toBeLessThanOrEqual(100 - 10 + 0.5); // pinned to right inner edge
    expect(cx).toBeGreaterThan(0);
  });
});

describe('Checkbox', () => {
  it('projects a checkbox input reflecting checked state', () => {
    const c = new Checkbox({ checked: true, label: 'Agree' });
    expect(c.getA11yAttributes()).toMatchObject({
      tag: 'input',
      inputType: 'checkbox',
      checked: true,
      label: 'Agree',
    });
  });

  it('toggles on click and reports via onChange', () => {
    const onChange = vi.fn();
    const c = new Checkbox({ onChange });
    expect(c.checked).toBe(false);
    c.emit('click', {});
    expect(c.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('syncs checked from a change event (agent clicks the shadow input)', () => {
    const c = new Checkbox({});
    c.emit('change', { value: '', checked: true });
    expect(c.checked).toBe(true);
  });

  it('marks on-demand scenes dirty when checked state changes', () => {
    const markDirty = vi.fn();
    const c = new Checkbox({});
    (c as unknown as { _scene: unknown })._scene = { markDirty };

    c.emit('change', { checked: true });
    c.emit('change', { checked: true });

    expect(markDirty).toHaveBeenCalledTimes(1);
  });
});

describe('Toggle', () => {
  it('projects a switch role with aria-checked state', () => {
    const t = new Toggle({ checked: true, label: 'Dark mode' });
    expect(t.getA11yAttributes()).toMatchObject({
      role: 'switch',
      checked: true,
      label: 'Dark mode',
    });
  });

  it('flips on click', () => {
    const t = new Toggle({});
    t.emit('click', {});
    expect(t.checked).toBe(true);
    t.emit('click', {});
    expect(t.checked).toBe(false);
  });

  it('emits change on toggle so external on("change") works', () => {
    const t = new Toggle({});
    const seen: boolean[] = [];
    t.on('change', (e: { checked: boolean }) => seen.push(e.checked));
    t.emit('click', {});
    t.emit('click', {});
    expect(seen).toEqual([true, false]);
  });

  it('still invokes the onChange callback', () => {
    const onChange = vi.fn();
    const t = new Toggle({ onChange });
    t.emit('click', {});
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('marks on-demand scenes dirty when switch state changes', () => {
    const markDirty = vi.fn();
    const t = new Toggle({});
    (t as unknown as { _scene: unknown })._scene = { markDirty, prefersReducedMotion: false };

    t.emit('change', { checked: true });
    const callsAfterChange = markDirty.mock.calls.length;
    t.emit('change', { checked: true });

    expect(callsAfterChange).toBeGreaterThan(0);
    expect(markDirty).toHaveBeenCalledTimes(callsAfterChange);
  });
});

describe('UIComponent hit-testing', () => {
  it('AABB isPointInside respects the box', () => {
    const b = new Button('Hit', { padding: 10 });
    b.setPosition(100, 100);
    expect(b.isPointInside(101, 101)).toBe(true);
    expect(b.isPointInside(99, 99)).toBe(false);
    expect(b.isPointInside(100 + b.width + 1, 100)).toBe(false);
    expect(b instanceof UIComponent).toBe(true);
  });

  it('isPointInside inverts rotation and non-uniform scale', () => {
    const b = new Button('Transformed', { width: 120, height: 40 });
    b.setPosition(100, 80);
    b.scaleX = 2;
    b.scaleY = 0.5;
    b.rotation = Math.PI / 3;

    const inside = b.localToWorld(100, 35);
    const outside = b.localToWorld(121, 20);

    expect(b.isPointInside(inside.x, inside.y)).toBe(true);
    expect(b.isPointInside(outside.x, outside.y)).toBe(false);
  });
});

describe('Markdown', () => {
  it('renders markdown headers and paragraphs into RichText', () => {
    const md = new Markdown('# Title\n\nSome text.', { maxWidth: 400 });
    expect(md.content.children.length).toBe(2);
    const heading = md.content.children[0] as RichText;
    expect(heading.spans.map((s) => s.text).join('')).toBe('Title');
    const para = md.content.children[1] as RichText;
    expect(para.spans.map((s) => s.text).join('')).toBe('Some text.');
  });

  it('renders code blocks and lists', () => {
    const md = new Markdown('```\nconst a = 1;\n```\n- item 1\n- item 2', { maxWidth: 400 });
    expect(md.content.children.length).toBe(2); // code block container, list

    // CodeBlock is a single leaf entity (no child sub-tree)
    const codeBlock = md.content.children[0];
    expect(codeBlock.children.length).toBe(0);

    const list = md.content.children[1] as Stack;
    expect(list.children.length).toBe(2);
    const firstItem = list.children[0] as RichText;
    expect(firstItem.spans.map((s) => s.text).join('')).toBe('• item 1');
  });
});
