// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Scene } from '../src/tree/Scene';
import { DOMPortalEntity } from '../src/tree/DOMPortalEntity';

// Scene requires a real canvas context, so we mock JSDOM's canvas getContext
const mockCtx = {
  scale: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  fillText: vi.fn(),
  beginPath: vi.fn(),
  fill: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  set globalAlpha(_v: number) {},
};

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => mockCtx) as any;
}

describe('Scene DOM Portal Integration', () => {
  it('mounts, transforms, and unmounts DOMPortalEntity cleanly', () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const scene = new Scene(canvas);
    const div = document.createElement('div');
    const portal = new DOMPortalEntity(div, 100, 50);
    scene.add(portal);

    // Render a frame
    scene.render(scene.getRenderer(), 0, 0);

    // Verify portal appended to a11yRoot (unified container)
    const a11yRoot = container.querySelector('[data-vecto-id]')?.parentElement;
    expect(a11yRoot).toBeDefined();
    expect(div.parentElement).toBe(a11yRoot);

    // Verify styles applied
    expect(div.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');

    // Unmount entity
    scene.remove(portal);
    scene.render(scene.getRenderer(), 0, 0);
    expect(div.parentElement).toBeNull();
  });
});
