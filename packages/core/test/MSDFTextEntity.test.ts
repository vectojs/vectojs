// @vitest-environment jsdom
import { test, expect, vi, beforeAll, afterEach } from 'vitest';
import { MSDFFont } from '../src/text/MSDFFont';
import { MSDFTextEntity } from '../src/text/MSDFTextEntity';
import { LayoutWorkerManager } from '../src/layout/LayoutWorkerManager';
import fontJson from './fixtures/font.json';

// Mock Worker and URL.createObjectURL since they are not supported in JSDOM/Node environment
class MockWorker {
  public onmessage?: (e: MessageEvent) => void;
  public postMessage(data: any) {
    const { id, seqId, text, fontSize, lineHeight } = data;
    const codePoints = Array.from(text).map((c) => c.charCodeAt(0));
    const xCoords = codePoints.map((_, i) => i * 10);
    const yCoords = codePoints.map(() => fontSize);
    const packedStyles = codePoints.map(() => (0xffffff << 8) | 0);
    const actualLineHeight = lineHeight ?? fontSize * 1.0;

    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage({
          data: {
            id,
            seqId,
            width: text.length * 10,
            height: actualLineHeight,
            codePoints: new Uint32Array(codePoints),
            xCoords: new Float32Array(xCoords),
            yCoords: new Float32Array(yCoords),
            packedStyles: new Uint32Array(packedStyles),
          },
        } as MessageEvent);
      }
    }, 10);
  }
  public terminate() {}
}

beforeAll(() => {
  globalThis.Worker = MockWorker as any;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  LayoutWorkerManager.getInstance().destroy();
});

test('MSDFTextEntity properties and boundary calculations', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('Vecto', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  expect(entity.isPointInside(10, 10)).toBe(false);
  entity.destroy();
});

test('MSDFTextEntity WebGL rendering under rotation', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('AB', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  // Populate fake layout response
  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65, 66]),
    xCoords: new Float32Array([0, 10]),
    yCoords: new Float32Array([18, 18]),
    packedStyles: new Uint32Array([0xffffff << 8, 0xffffff << 8]),
  };

  entity.rotation = Math.PI / 4; // 45 degrees

  const mockAddGlyph = vi.fn();
  const mockSetMSDFTexture = vi.fn();

  (entity as any)._scene = {
    pointRenderer: {
      setMSDFTexture: mockSetMSDFTexture,
      addGlyph: mockAddGlyph,
    },
    glCanvas: {},
    markDirty: vi.fn(),
  };

  entity.render(null);

  expect(mockSetMSDFTexture).toHaveBeenCalledWith(mockTexture, font.distanceRange);
  expect(mockAddGlyph).toHaveBeenCalledTimes(2);

  // Check the coordinates passed to addGlyph are computed and rotated
  const call1 = mockAddGlyph.mock.calls[0];
  // addGlyph signature: x, y, width, height, u0, v0, u1, v1, color, alpha, rotation
  expect(call1[10]).toBeCloseTo(Math.PI / 4);
});

test('MSDFTextEntity Canvas2D rendering fallback', () => {
  const font = new MSDFFont(fontJson);
  const mockTexture = {} as TexImageSource;
  const entity = new MSDFTextEntity('AB', {
    font,
    texture: mockTexture,
    fontSize: 24,
  });

  entity['layoutResult'] = {
    width: 100,
    height: 24,
    codePoints: new Uint32Array([65, 66]),
    xCoords: new Float32Array([0, 10]),
    yCoords: new Float32Array([18, 18]),
    packedStyles: new Uint32Array([0xffffff << 8, 0xffffff << 8]),
  };

  const mockRenderer = {
    fillText: vi.fn(),
  };

  entity.render(mockRenderer);

  expect(mockRenderer.fillText).toHaveBeenCalledTimes(2);
  expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
    1,
    'A',
    0,
    18,
    '24px sans-serif',
    'rgb(255,255,255)',
  );
  expect(mockRenderer.fillText).toHaveBeenNthCalledWith(
    2,
    'B',
    10,
    18,
    '24px sans-serif',
    'rgb(255,255,255)',
  );

  entity.setPosition(30, 50);
  entity.scaleX = 2;
  entity.scaleY = 0.5;
  entity.rotation = Math.PI / 4;
  const inside = entity.localToWorld(50, 12);
  const outside = entity.localToWorld(101, 12);
  expect(entity.isPointInside(inside.x, inside.y)).toBe(true);
  expect(entity.isPointInside(outside.x, outside.y)).toBe(false);
});

test('MSDFTextEntity falls back to Canvas for a sheared world transform', () => {
  const font = new MSDFFont(fontJson);
  const entity = new MSDFTextEntity('A', {
    font,
    texture: {} as TexImageSource,
    fontSize: 24,
  });
  entity['layoutResult'] = {
    width: 20,
    height: 24,
    codePoints: new Uint32Array([65]),
    xCoords: new Float32Array([0]),
    yCoords: new Float32Array([18]),
    packedStyles: new Uint32Array([0xffffff << 8]),
  };
  entity.scaleX = 2;
  entity.scaleY = 0.5;
  entity.rotation = Math.PI / 4;
  const addGlyph = vi.fn();
  (entity as any)._scene = {
    pointRenderer: { setMSDFTexture: vi.fn(), addGlyph },
    glCanvas: {},
  };
  const renderer = { fillText: vi.fn() };

  entity.render(renderer);

  expect(addGlyph).not.toHaveBeenCalled();
  expect(renderer.fillText).toHaveBeenCalledOnce();
});
