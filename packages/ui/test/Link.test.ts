// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectoJSEvent } from '@vectojs/core';
import { Link } from '../src/Link';

describe('Link URL policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('projects and opens safe relative URLs', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const link = new Link('Guide', { href: '/guide' });

    expect(link.getA11yAttributes().href).toBe('/guide');
    link.emit('click', {});
    expect(open).toHaveBeenCalledWith('/guide', '_blank', 'noopener');
  });

  it('makes obfuscated script URLs inert', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const link = new Link('Unsafe', { href: 'java\nscript:alert(1)' });

    expect(link.getA11yAttributes().href).toBe('#');
    link.emit('click', {});
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open a second tab when the shadow <a> already navigated natively', () => {
    // A real DOM click on the shadow <a> navigates the browser itself; the same
    // click is forwarded to the entity. Opening again would be a duplicate tab.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const link = new Link('Docs', { href: 'https://example.com' });
    const anchor = document.createElement('a');
    const domClick = new MouseEvent('click');
    Object.defineProperty(domClick, 'target', { value: anchor });
    link.dispatchEvent(new VectoJSEvent('click', link, domClick));
    expect(open).not.toHaveBeenCalled();
  });

  it('still opens for a canvas/Three-path click (no native anchor navigated)', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const link = new Link('Docs', { href: 'https://example.com' });
    // Canvas path: nativeEvent is a pointer-ish event whose target is NOT an <a>.
    const canvasClick = new MouseEvent('click');
    Object.defineProperty(canvasClick, 'target', {
      value: document.createElement('canvas'),
    });
    link.dispatchEvent(new VectoJSEvent('click', link, canvasClick));
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener');
  });
});
