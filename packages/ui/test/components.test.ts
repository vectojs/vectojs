// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Text, Button, Link, UIComponent } from '../src/index';

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
