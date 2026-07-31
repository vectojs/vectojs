// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { SVGEntity } from '../src/text/SVGEntity';
import { SVGRenderer } from '../src/renderer/SVGRenderer';

describe('SVGEntity', () => {
  it('parses dimensions correctly', () => {
    const svg = '<svg width="200" height="150"><rect/></svg>';
    const entity = new SVGEntity(svg);
    expect(entity.width).toBe(200);
    expect(entity.height).toBe(150);
  });

  it('falls back to regex parsing when window is undefined', () => {
    const svg = '<svg width="300" height="200"><rect/></svg>';
    // Temporarily delete window
    const originalWindow = global.window;
    // @ts-ignore
    delete global.window;

    const entity = new SVGEntity(svg);
    expect(entity.width).toBe(300);
    expect(entity.height).toBe(200);

    // Restore window
    global.window = originalWindow;
  });

  it('hit-tests through rotation and non-uniform scale', () => {
    const entity = new SVGEntity('<svg width="200" height="150"><rect/></svg>');
    entity.setPosition(25, 40);
    entity.scaleX = 1.75;
    entity.scaleY = 0.6;
    entity.rotation = Math.PI / 5;

    const inside = entity.localToWorld(100, 75);
    const outside = entity.localToWorld(201, 75);
    expect(entity.isPointInside(inside.x, inside.y)).toBe(true);
    expect(entity.isPointInside(outside.x, outside.y)).toBe(false);
  });

  it('exports its source as an encoded nested SVG image instead of an inert placeholder', () => {
    const entity = new SVGEntity(
      '<svg width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    );
    const renderer = new SVGRenderer(20, 10);

    entity.render(renderer);
    const output = renderer.toXMLString();

    expect(output).toContain('href="data:image/svg+xml;charset=utf-8,');
    expect(output).not.toContain('href="#"');
    expect(() => new DOMParser().parseFromString(output, 'image/svg+xml')).not.toThrow();
  });
});

/**
 * Recording stub. Only the ops `SVGEntity.render` can reach are implemented.
 */
function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const r = {
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    scale: rec('scale'),
    rotate: rec('rotate'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    flush: rec('flush'),
  } as unknown as import('../src/renderer/IRenderer').IRenderer;
  return { r, calls };
}

/**
 * What a unit test can and cannot see here, measured rather than assumed:
 * jsdom provides `Image`, `Blob`, and `URL.createObjectURL`, but
 * `createImageBitmap` is undefined and a blob-backed `<img>` fires NEITHER
 * `onload` nor `onerror` (probed: 400ms timeout, result `neither-timeout`).
 * So the async raster path and every painted pixel are unreachable from here —
 * the real gate is `e2e/svg-fallback.e2e.ts` on Chromium + Firefox. These tests
 * cover only the synchronous, observable half.
 */
describe('SVGEntity raster failure fallback', () => {
  it('flags a malformed source as failed while keeping a usable box', () => {
    const entity = new SVGEntity('<svg width="80" height="60"><<<>>> not xml');
    expect(entity.hasRasterFailed()).toBe(true);
    expect(entity.hasRasterBitmap()).toBe(false);
    // Falls back to the documented 100x100 default so the entity still occupies
    // space rather than collapsing.
    expect(entity.width).toBe(100);
    expect(entity.height).toBe(100);
  });

  it('does not flag a well-formed source', () => {
    const entity = new SVGEntity(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect/></svg>',
    );
    expect(entity.hasRasterFailed()).toBe(false);
  });

  it('does not flag a source that merely omits xmlns, and reads its real size', () => {
    // This parses as well-formed XML; only the image decoder rejects it, which
    // is why it needs the namespace repair rather than the fallback marker.
    const entity = new SVGEntity('<svg width="80" height="60"><rect/></svg>');
    expect(entity.hasRasterFailed()).toBe(false);
    expect(entity.width).toBe(80);
    expect(entity.height).toBe(60);
  });

  it('draws a visible marker instead of nothing when rasterization failed', () => {
    const entity = new SVGEntity('<svg width="80" height="60"><<<>>> not xml');
    const { r, calls } = recorder();
    entity.render(r);

    // Nothing to blit, so the box must still receive paint.
    expect(calls.some((c) => c.op === 'drawImage')).toBe(false);
    const fill = calls.find((c) => c.op === 'fill');
    expect(fill?.args[0]).toBe(entity.fallbackFill);
    const strokes = calls.filter((c) => c.op === 'stroke');
    // Box outline plus the diagonal cross.
    expect(strokes.length).toBe(2);
    expect(strokes[0]?.args[0]).toBe(entity.fallbackStroke);
    // The cross is two segments, so two moveTo/lineTo pairs.
    expect(calls.filter((c) => c.op === 'moveTo').length).toBe(2);
    expect(calls.filter((c) => c.op === 'lineTo').length).toBe(2);
  });

  it('draws nothing while a raster is merely in flight', () => {
    // A valid source has not failed, so an unresolved raster must stay empty
    // rather than flashing an error marker.
    const entity = new SVGEntity(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect/></svg>',
    );
    const { r, calls } = recorder();
    entity.render(r);
    expect(entity.hasRasterFailed()).toBe(false);
    expect(calls.some((c) => c.op === 'fill')).toBe(false);
    expect(calls.some((c) => c.op === 'stroke')).toBe(false);
    expect(calls.some((c) => c.op === 'drawImage')).toBe(false);
  });

  it('honours an opted-out fallback colour', () => {
    const entity = new SVGEntity('<svg width="80" height="60"><<<>>> not xml');
    entity.fallbackFill = 'transparent';
    entity.fallbackStroke = 'transparent';
    const { r, calls } = recorder();
    entity.render(r);
    expect(calls.find((c) => c.op === 'fill')?.args[0]).toBe('transparent');
  });

  it('clears the failure flag when a new source is set', () => {
    const entity = new SVGEntity('<svg width="80" height="60"><<<>>> not xml');
    expect(entity.hasRasterFailed()).toBe(true);
    entity.setSVGSource(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect/></svg>',
    );
    expect(entity.hasRasterFailed()).toBe(false);
    expect(entity.width).toBe(40);
  });
});
