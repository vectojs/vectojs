// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Image } from '../src/Image';

// jsdom canvas stub
HTMLCanvasElement.prototype.getContext = (() => null) as never;

// Helper to fake an ImageBitmap without needing createImageBitmap.
function fakeBitmap(w = 32, h = 32): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}

describe('Image semanticMode a11y projection', () => {
  it('auto: url string → <img src alt>', () => {
    const img = new Image('https://example.com/a.png', {
      width: 64,
      height: 64,
      alt: 'A',
    });
    expect(img.semanticMode).toBe('auto');
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/a.png',
      alt: 'A',
      label: 'A',
    });
  });

  it('auto: {kind:url} → <img>', () => {
    const img = new Image({ kind: 'url', url: '/b.png' }, { width: 10, height: 10, alt: 'B' });
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: '/b.png',
      alt: 'B',
      label: 'B',
    });
  });

  it('auto: blob → <div role=img>', () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const img = new Image({ kind: 'blob', blob }, { width: 10, height: 10, alt: 'blob alt' });
    expect(img.getA11yAttributes()).toEqual({
      tag: 'div',
      role: 'img',
      label: 'blob alt',
    });
    // must not expose src
    expect((img.getA11yAttributes() as unknown as { src?: string }).src).toBeUndefined();
  });

  it('auto: bitmap → <div role=img>', () => {
    const bmp = fakeBitmap();
    const img = new Image({ kind: 'bitmap', bitmap: bmp }, { width: 10, height: 10, alt: 'bmp' });
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'bmp' });
  });

  it('explicit role: url → <div role=img> (never <img>)', () => {
    const img = new Image('https://example.com/a.png', {
      width: 10,
      height: 10,
      alt: 'A',
      semanticMode: 'role',
    });
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'A' });
  });

  it('explicit role: blob → <div role=img>', () => {
    const blob = new Blob(['x']);
    const img = new Image(
      { kind: 'blob', blob },
      { width: 10, height: 10, alt: 'X', semanticMode: 'role' },
    );
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'X' });
  });

  it('explicit img: url → <img src>', () => {
    const img = new Image('https://example.com/c.png', {
      width: 10,
      height: 10,
      alt: 'C',
      semanticMode: 'img',
    });
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/c.png',
      alt: 'C',
      label: 'C',
    });
  });

  it('explicit img: blob → fallback to role + warn, no blob: URL synthesized', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blob = new Blob(['x']);
    const img = new Image(
      { kind: 'blob', blob },
      { width: 10, height: 10, alt: 'FB', semanticMode: 'img' },
    );
    const attrs = img.getA11yAttributes();
    expect(attrs).toEqual({ tag: 'div', role: 'img', label: 'FB' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/semanticMode="img"/);
    warn.mockRestore();
  });

  it('explicit img: bitmap → fallback to role + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bmp = fakeBitmap();
    const img = new Image(
      { kind: 'bitmap', bitmap: bmp },
      { width: 10, height: 10, alt: 'BM', semanticMode: 'img' },
    );
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'BM' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('alt empty → label undefined, img alt is empty string', () => {
    const imgUrl = new Image('https://example.com/a.png', { width: 10, height: 10, alt: '' });
    expect(imgUrl.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/a.png',
      alt: '',
      label: undefined,
    });
    const blob = new Blob(['x']);
    const imgBlob = new Image({ kind: 'blob', blob }, { width: 10, height: 10, alt: '' });
    expect(imgBlob.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: undefined });
  });

  it('alt omitted → same as empty', () => {
    const img = new Image('https://example.com/a.png', { width: 10, height: 10 });
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/a.png',
      alt: '',
      label: undefined,
    });
  });

  it('alt with role mode projects as aria-label', () => {
    const img = new Image('https://example.com/a.png', {
      width: 10,
      height: 10,
      alt: 'desc',
      semanticMode: 'role',
    });
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'desc' });
  });

  it('setSource re-projects a11y: url→blob flips img→role, blob→url flips role→img', () => {
    const img = new Image('https://example.com/a.png', { width: 10, height: 10, alt: 'A' });
    expect(img.getA11yAttributes().tag).toBe('img');
    const blob = new Blob(['x']);
    img.setSource({ kind: 'blob', blob });
    expect(img.getA11yAttributes()).toEqual({ tag: 'div', role: 'img', label: 'A' });
    img.setSource('https://example.com/b.png');
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/b.png',
      alt: 'A',
      label: 'A',
    });
  });

  it('setSource to string shorthand normalizes to url', () => {
    const blob = new Blob(['x']);
    const img = new Image(
      { kind: 'blob', blob },
      { width: 10, height: 10, alt: 'T', semanticMode: 'auto' },
    );
    expect(img.getA11yAttributes().tag).toBe('div');
    img.setSource('https://example.com/d.png');
    expect(img.src).toBe('https://example.com/d.png');
    expect(img.imageSource).toBe('https://example.com/d.png');
    expect(img.getA11yAttributes()).toEqual({
      tag: 'img',
      src: 'https://example.com/d.png',
      alt: 'T',
      label: 'T',
    });
  });

  it('semanticMode is stored and src compat getter reflects normalized url', () => {
    const blob = new Blob(['x']);
    const img = new Image({ kind: 'blob', blob }, { width: 10, height: 10, semanticMode: 'role' });
    expect(img.src).toBe('');
    expect(img.imageSource).toEqual({ kind: 'blob', blob });
    expect(img.semanticMode).toBe('role');
  });

  it('trust boundary: role mode never exposes URL even if source is url-like blob', () => {
    // Even if a blob was somehow created from a url, role must not leak src
    const img = new Image('https://example.com/secret.png', {
      width: 10,
      height: 10,
      alt: 'secret',
      semanticMode: 'role',
    });
    const attrs = img.getA11yAttributes() as Record<string, unknown>;
    expect(attrs.src).toBeUndefined();
    expect(attrs.tag).toBe('div');
    expect(attrs.role).toBe('img');
  });
});
