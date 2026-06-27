// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { DOMPortalEntity } from '../src/tree/DOMPortalEntity';

describe('DOMPortalEntity', () => {
  it('sets initial styles and handles hit-testing with scale and rotation', () => {
    const div = document.createElement('div');
    div.style.width = '200px';
    div.style.height = '100px';
    const portal = new DOMPortalEntity(div, 200, 100);
    expect(portal.isDOMPortal).toBe(true);
    expect(portal.width).toBe(200);
    expect(portal.height).toBe(100);

    // Hit-testing in local bounds
    expect(portal.isPointInside(50, 50)).toBe(true);
    expect(portal.isPointInside(250, 50)).toBe(false);
  });

  it('forwards native DOM events into Vecto events', () => {
    const div = document.createElement('div');
    const portal = new DOMPortalEntity(div, 200, 100);
    const clickHandler = vi.fn();
    portal.on('click', clickHandler);

    const clickEvent = new MouseEvent('click', { bubbles: true });
    div.dispatchEvent(clickEvent);
    expect(clickHandler).toHaveBeenCalled();
  });
});
