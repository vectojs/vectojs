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
} from '../src/index';
import type { IRenderer } from '@vecto-ui/core';

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
});

describe('Link', () => {
  it('projects an anchor shadow node with href', () => {
    const l = new Link('Docs', { href: 'https://example.com' });
    expect(l.getA11yAttributes()).toEqual({ tag: 'a', href: 'https://example.com', label: 'Docs' });
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
});
