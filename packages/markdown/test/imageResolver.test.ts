// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../src/Markdown';
import { clearInlineImageRasters } from '../src/markdown-image';
import type { ImageSource } from '@vectojs/ui';

function findImages(md: Markdown): any[] {
  const found: any[] = [];
  const walk = (entity: any): void => {
    if ('src' in entity && 'bitmap' in entity) found.push(entity);
    for (const child of entity.children ?? []) walk(child);
  };
  walk(md as any);
  return found;
}

function objectSpans(md: Markdown): any[] {
  const found: any[] = [];
  const walk = (entity: any): void => {
    const spans = entity.spans as any[] | undefined;
    for (const span of spans ?? []) if (span.object) found.push(span.object);
    for (const child of entity.children ?? []) walk(child);
  };
  walk(md as any);
  return found;
}

beforeEach(() => {
  clearInlineImageRasters();
});

describe('Markdown imageResolver', () => {
  it('default resolver maps src to url ImageSource', () => {
    const md = new Markdown('![alt](https://example.test/a.png)', { maxWidth: 600 });
    const imgs = findImages(md);
    expect(imgs).toHaveLength(1);
    // Image src getter still returns url string for compat
    expect(imgs[0].src).toBe('https://example.test/a.png');
    // But imageSource is the generic object
    expect(imgs[0].imageSource).toEqual({ kind: 'url', url: 'https://example.test/a.png' });
    expect(imgs[0].getA11yAttributes().src).toBe('https://example.test/a.png');
  });

  it('custom sync resolver can return bitmap', () => {
    const fakeBitmap = { width: 80, height: 40, close: vi.fn() } as unknown as ImageBitmap;
    const resolver = (src: string): ImageSource => {
      if (src === 'https://example.test/b.png') return { kind: 'bitmap', bitmap: fakeBitmap };
      return { kind: 'url', url: src };
    };
    const md = new Markdown('![alt](https://example.test/b.png)', {
      maxWidth: 600,
      imageResolver: resolver,
    });
    const imgs = findImages(md);
    expect(imgs).toHaveLength(1);
    // bitmap source has no url, src is empty string for a11y compat
    expect(imgs[0].src).toBe('');
    expect(imgs[0].imageSource).toEqual({ kind: 'bitmap', bitmap: fakeBitmap });
    expect(imgs[0].decodedImage?.width).toBe(80);
    expect(imgs[0].decodedImage?.height).toBe(40);
    // a11y src is undefined for non-url, not empty string
    expect(imgs[0].getA11yAttributes().src).toBeUndefined();
    // external bitmap dispose is noop — not closed on destroy
    md.destroy();
    expect(fakeBitmap.close).not.toHaveBeenCalled();
  });

  it('custom sync resolver can return blob via createImageBitmap', async () => {
    const blob = new Blob(['fake'], { type: 'image/png' });
    const fakeBitmap = { width: 64, height: 64, close: vi.fn() } as unknown as ImageBitmap;
    const origCreate = (globalThis as any).createImageBitmap;
    (globalThis as any).createImageBitmap = vi.fn(async () => fakeBitmap);

    const md = new Markdown('![alt](blob-test)', {
      maxWidth: 600,
      imageResolver: () => ({ kind: 'blob', blob }),
    });
    const imgs = findImages(md);
    expect(imgs).toHaveLength(1);
    // blob decodes async via createImageBitmap
    await vi.waitFor(() => expect(imgs[0].decodedImage?.width).toBe(64));
    expect(imgs[0].decodedImage?.source).toBe(fakeBitmap);

    // internal bitmap is closed on destroy
    md.destroy();
    expect(fakeBitmap.close).toHaveBeenCalledTimes(1);

    (globalThis as any).createImageBitmap = origCreate;
  });

  it('async resolver updates Image after promise resolves', async () => {
    let resolve: (v: ImageSource) => void;
    const promise = new Promise<ImageSource>((r) => {
      resolve = r;
    });
    const md = new Markdown('![alt](https://example.test/async.png)', {
      maxWidth: 600,
      imageResolver: () => promise,
    });
    const imgs = findImages(md);
    expect(imgs).toHaveLength(1);
    // fallback while pending — still url of original src
    expect(imgs[0].src).toBe('https://example.test/async.png');
    expect(imgs[0].imageSource).toEqual({ kind: 'url', url: 'https://example.test/async.png' });

    const fakeBitmap = { width: 100, height: 50, close: vi.fn() } as unknown as ImageBitmap;
    resolve!({ kind: 'bitmap', bitmap: fakeBitmap });
    await promise;
    // allow microtask and setSource's synchronous decode
    await new Promise((r) => setTimeout(r, 0));
    // after resolve, Image should have bitmap source
    expect(imgs[0].imageSource).toEqual({ kind: 'bitmap', bitmap: fakeBitmap });
    expect(imgs[0].decodedImage?.width).toBe(100);
    expect(imgs[0].src).toBe('');
  });

  it('CapGlyph adapter example: capglyph: prefix returns bitmap, otherwise url', async () => {
    const fakeBitmap = { width: 120, height: 30, close: vi.fn() } as unknown as ImageBitmap;
    const fakeBlob = new Blob(['cap'], { type: 'image/png' });
    const origFetch = globalThis.fetch;
    const origCreate = (globalThis as any).createImageBitmap;
    // Mock fetch to return blob for capglyph urls
    globalThis.fetch = vi.fn(async () => ({ blob: async () => fakeBlob }) as any);
    (globalThis as any).createImageBitmap = vi.fn(async () => fakeBitmap);

    const capResolver: (src: string) => Promise<ImageSource> = async (src) => {
      if (src.startsWith('capglyph:')) {
        const res = await fetch(src.replace('capglyph:', 'https://cap.example/'));
        const blob = await res.blob();
        const bitmap = await (globalThis as any).createImageBitmap(blob);
        return { kind: 'bitmap', bitmap };
      }
      return { kind: 'url', url: src };
    };

    // capglyph image
    const mdCap = new Markdown('![cap](capglyph:abc123)', {
      maxWidth: 600,
      imageResolver: capResolver,
    });
    const capImgs = findImages(mdCap);
    expect(capImgs).toHaveLength(1);
    // initially fallback url
    expect(capImgs[0].src).toBe('capglyph:abc123');
    await vi.waitFor(() => expect(capImgs[0].decodedImage?.width).toBe(120));
    expect(capImgs[0].imageSource).toEqual({ kind: 'bitmap', bitmap: fakeBitmap });

    // normal url still goes via url path
    const mdUrl = new Markdown('![alt](https://example.test/normal.png)', {
      maxWidth: 600,
      imageResolver: capResolver,
    });
    const urlImgs = findImages(mdUrl);
    expect(urlImgs[0].imageSource).toEqual({ kind: 'url', url: 'https://example.test/normal.png' });

    globalThis.fetch = origFetch;
    (globalThis as any).createImageBitmap = origCreate;
  });

  it('inline heading image uses resolver for blob/bitmap', async () => {
    const fakeBitmap = { width: 80, height: 20, close: vi.fn() } as unknown as ImageBitmap;
    const md = new Markdown('# Title ![alt](capglyph:inline)', {
      maxWidth: 600,
      imageResolver: (src) =>
        src.startsWith('capglyph:')
          ? { kind: 'bitmap', bitmap: fakeBitmap }
          : { kind: 'url', url: src },
    } as any);
    // heading image is an inline object, not a block Image entity
    const objs = objectSpans(md);
    expect(objs).toHaveLength(1);
    // aspect 4:1 should be reflected in width = height * aspect, height is runSize * scale
    // Just check that object exists and alt is preserved
    expect(objs[0].alt).toBe('alt');
    // After decode, width should be 4 * height (since bitmap is 80x20)
    const height = objs[0].height;
    expect(objs[0].width).toBeCloseTo(height * 4, 1);
  });

  it('resolver returning string shorthand is supported', () => {
    const md = new Markdown('![alt](https://example.test/shorthand.png)', {
      maxWidth: 600,
      imageResolver: (src) => src, // string shorthand
    });
    const imgs = findImages(md);
    expect(imgs[0].imageSource).toBe('https://example.test/shorthand.png');
    expect(imgs[0].src).toBe('https://example.test/shorthand.png');
  });
});
