// @vitest-environment jsdom
// The hit-grid reuse gate must key on frame AND structure version: within a
// single frame, a structural mutation (Entity.add/remove → markStructureChanged)
// has to force a rebuild, or the WASM path answers pointer queries against
// pre-mutation geometry while the JS walk sees live state (#677).
import { describe, it, expect } from 'vitest';
import { Entity } from '../src/index';
import { HitTester } from '../src/tree/scene/HitTester';
import { WasmBackendFacade } from '../src/tree/scene/WasmBackendFacade';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

class Rect extends Entity {
  constructor(
    id: string,
    public width: number,
    public height: number,
  ) {
    super(id);
  }
  getBounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }
  isPointInside(gx: number, gy: number): boolean {
    const local = this.worldToLocal(gx, gy);
    if (!local) return false;
    return local.x >= 0 && local.x <= this.width && local.y >= 0 && local.y <= this.height;
  }
  render(): void {}
}

/** Records how many times the spatial index was actually built. */
class MockHitBackend {
  runs = 0;
  private views = {
    minx: new Float32Array(64),
    miny: new Float32Array(64),
    maxx: new Float32Array(64),
    maxy: new Float32Array(64),
  };
  ensure(): void {}
  revalidateViews(): void {}
  inputView() {
    return this.views;
  }
  runBuild(): boolean {
    this.runs++;
    return true;
  }
}

describe('hit-grid cache key (frame + structure version)', () => {
  it('rebuilds within the same frame after markStructureChanged', () => {
    const root = new Rect('root', 200, 200);
    root.add(new Rect('a', 100, 100));
    const facade = new WasmBackendFacade(root);
    const hit = new MockHitBackend();
    facade.setHit(hit as never);
    const tester = new HitTester(root, root, facade);

    // First query of frame 1 builds the grid.
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(hit.runs).toBe(1);

    // Same frame, unchanged structure: served from cache.
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(hit.runs).toBe(1);

    // Same-frame structural mutation: the stale grid must not be reused.
    facade.markStructureChanged();
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(hit.runs).toBe(2);

    // And the rebuilt grid is again cacheable for that version.
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(hit.runs).toBe(2);
  });

  it('setHit still forces a rebuild regardless of structure version', () => {
    const root = new Rect('root', 200, 200);
    const facade = new WasmBackendFacade(root);
    const first = new MockHitBackend();
    facade.setHit(first as never);
    const tester = new HitTester(root, root, facade);

    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(first.runs).toBe(1);
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(first.runs).toBe(1);

    const second = new MockHitBackend();
    facade.setHit(second as never);
    expect(tester.ensureHitGrid(1, 800, 600)).toBe(true);
    expect(second.runs).toBe(1);
  });
});
