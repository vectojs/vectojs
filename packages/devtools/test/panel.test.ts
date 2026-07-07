import { describe, it, expect, vi } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import { attachDevtools } from '../src/index';

class Box extends Entity {
  constructor(id: string, w = 40, h = 20) {
    super(id);
    this.width = w;
    this.height = h;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}

function makeHost(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

describe('attachDevtools', () => {
  it('mounts a panel, mirrors the host tree, and tears down cleanly', () => {
    const host = makeHost();
    host.add(new Box('a'));
    host.add(new Box('b'));

    const panel = attachDevtools(host, { refreshInterval: 0 });
    expect(document.querySelector('[data-vecto-devtools]')).not.toBeNull();
    expect((panel as any).index.get('a')).toBeDefined();
    expect((panel as any).index.get('b')).toBeDefined();

    panel.detach();
    expect(document.querySelector('[data-vecto-devtools]')).toBeNull();
    host.destroy();
  });

  it('select() highlights on the host overlay and fills the readout', () => {
    const host = makeHost();
    const target = new Box('sel', 60, 30);
    target.setPosition(15, 25);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    expect(panel.selection).toBe(target);
    expect(host.overlayRootEntity.children.length).toBe(1); // highlight entity
    const readout = (panel as any).detailLines.map((l: { text: string }) => l.text).join('\n');
    expect(readout).toContain('#sel');
    expect(readout).toContain('x 15');

    panel.detach();
    expect(host.overlayRootEntity.children.length).toBe(0); // highlight removed
    host.destroy();
  });

  it('armed pick selects the entity under a host click', () => {
    const host = makeHost();
    vi.spyOn(host, 'clientToScene').mockReturnValue({ x: 30, y: 30 });
    const target = new Box('picked', 100, 100);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.armPick();
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(panel.selection?.id).toBe('picked');
    panel.detach();
    host.destroy();
  });

  it('arrow keys nudge the selected entity (shift ×10)', () => {
    const host = makeHost();
    const target = new Box('nudge');
    target.setPosition(50, 50);
    host.add(target);

    const panel = attachDevtools(host, { refreshInterval: 0 });
    panel.select(target);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(target.x).toBe(51);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }));
    expect(target.y).toBe(60);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));
    expect(target.opacity).toBeCloseTo(0.9);

    panel.detach();
    host.destroy();
  });

  it('auto-refresh picks up newly added entities', () => {
    vi.useFakeTimers();
    const host = makeHost();
    const panel = attachDevtools(host, { refreshInterval: 100 });
    host.add(new Box('late'));
    vi.advanceTimersByTime(150);
    expect((panel as any).index.get('late')).toBeDefined();
    panel.detach();
    host.destroy();
    vi.useRealTimers();
  });
});
