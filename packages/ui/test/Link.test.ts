// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
