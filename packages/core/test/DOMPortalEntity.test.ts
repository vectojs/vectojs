// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { DOMPortalEntity } from '../src/tree/DOMPortalEntity';
import { Entity } from '../src/tree/Entity';

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

    portal.setPosition(30, 45);
    portal.scaleX = 2;
    portal.scaleY = 0.5;
    portal.rotation = Math.PI / 4;
    const inside = portal.localToWorld(150, 50);
    const outside = portal.localToWorld(201, 50);
    expect(portal.isPointInside(inside.x, inside.y)).toBe(true);
    expect(portal.isPointInside(outside.x, outside.y)).toBe(false);
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

  it('rejects child entities because portal nodes are leaves', () => {
    const portal = new DOMPortalEntity(document.createElement('div'));
    const child = new Entity('child');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    portal.add(child);

    expect(warn).toHaveBeenCalledOnce();
    expect(portal.children).toHaveLength(0);
    expect(child.parent).toBeNull();
  });
});
