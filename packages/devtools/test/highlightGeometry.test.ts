// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Entity, Scene } from '@vectojs/core';
import {
  formatHighlightGeometry,
  highlightGeometry,
  sampleHitRegion,
  type HighlightLayer,
  type HighlightLayerKind,
} from '../src/highlightGeometry';

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

/** An entity whose hit area is a centred circle, so it cannot match its box. */
class Disc extends Entity {
  constructor(
    id: string,
    private radius: number,
  ) {
    super(id);
    this.width = radius * 2;
    this.height = radius * 2;
  }
  override isPointInside(gx: number, gy: number): boolean {
    const cx = this.x + this.radius;
    const cy = this.y + this.radius;
    return Math.hypot(gx - cx, gy - cy) <= this.radius;
  }
  render(): void {}
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  return new Scene(canvas, { disableWindowResize: true });
}

function layerOf(layers: HighlightLayer[], kind: HighlightLayerKind): HighlightLayer {
  const found = layers.find((l) => l.kind === kind);
  if (!found) throw new Error(`no ${kind} layer`);
  return found;
}

describe('highlightGeometry', () => {
  it('reports the layout quad as four points in perimeter order', () => {
    const scene = makeScene();
    const box = new Box('b', 40, 20);
    box.setPosition(10, 5);
    scene.add(box);

    const layout = layerOf(highlightGeometry(scene, box), 'layout');
    expect(layout.polygons).toHaveLength(1);
    expect(layout.polygons[0]!.points).toEqual([
      { x: 10, y: 5 },
      { x: 50, y: 5 },
      { x: 50, y: 25 },
      { x: 10, y: 25 },
    ]);
    scene.destroy();
  });

  it('keeps the true edges of a rotated entity, which the AABB loses', () => {
    const scene = makeScene();
    const box = new Box('b', 40, 20);
    box.setPosition(100, 100);
    box.rotation = Math.PI / 4;
    scene.add(box);

    const layers = highlightGeometry(scene, box);
    const layout = layerOf(layers, 'layout');
    const aabb = layerOf(layers, 'aabb');

    // The rotated quad's own corners are not axis-aligned...
    const xs = layout.polygons[0]!.points.map((p) => p.x);
    const ys = layout.polygons[0]!.points.map((p) => p.y);
    expect(new Set(xs).size).toBeGreaterThan(2);
    expect(new Set(ys).size).toBeGreaterThan(2);

    // ...while the AABB collapses to exactly two distinct x and y values.
    const ax = aabb.polygons[0]!.points.map((p) => p.x);
    expect(new Set(ax).size).toBe(2);

    // And the divergence is reported, since this is the case the AABB hides.
    expect(layout.divergesFromLayout).toBe(true);
    scene.destroy();
  });

  it('does not flag the layout layer for an unrotated entity', () => {
    const scene = makeScene();
    const box = new Box('b');
    scene.add(box);
    expect(layerOf(highlightGeometry(scene, box), 'layout').divergesFromLayout).toBeUndefined();
    scene.destroy();
  });

  it('reports the render box when getBounds() exceeds the layout box', () => {
    const scene = makeScene();
    class Overflowing extends Box {
      override getBounds() {
        return { x: -10, y: -10, width: 100, height: 100 };
      }
    }
    const box = new Overflowing('b', 40, 20);
    scene.add(box);

    const render = layerOf(highlightGeometry(scene, box), 'render');
    expect(render.polygons[0]!.points[0]).toEqual({ x: -10, y: -10 });
    expect(render.divergesFromLayout).toBe(true);
    scene.destroy();
  });

  it('explains rather than throws when getBounds() throws', () => {
    const scene = makeScene();
    class Hostile extends Box {
      override getBounds(): never {
        throw new Error('nope');
      }
    }
    const box = new Hostile('b');
    scene.add(box);

    const render = layerOf(highlightGeometry(scene, box), 'render');
    expect(render.polygons).toHaveLength(0);
    expect(render.unavailable).toContain('nope');
    scene.destroy();
  });

  it('says the layout box is the render box when getBounds() returns null', () => {
    const scene = makeScene();
    const box = new Box('b');
    scene.add(box);
    expect(layerOf(highlightGeometry(scene, box), 'render').unavailable).toContain('null');
    scene.destroy();
  });

  it('finds the nearest clipping ancestor, not the immediate parent', () => {
    const scene = makeScene();
    const clipper = new Box('clip', 200, 100);
    clipper.clipChildren = true;
    const middle = new Box('mid', 150, 80);
    const leaf = new Box('leaf', 40, 20);
    scene.add(clipper);
    clipper.add(middle);
    middle.add(leaf);

    const clip = layerOf(highlightGeometry(scene, leaf), 'clip');
    expect(clip.polygons).toHaveLength(1);
    // 200x100 is the clipper's box, not the 150x80 middle or the 40x20 leaf.
    const pts = clip.polygons[0]!.points;
    expect(pts[2]).toEqual({ x: 200, y: 100 });
    expect(clip.divergesFromLayout).toBe(true);
    scene.destroy();
  });

  it('reports no clip layer when nothing clips the entity', () => {
    const scene = makeScene();
    const box = new Box('b');
    scene.add(box);
    expect(layerOf(highlightGeometry(scene, box), 'clip').unavailable).toContain('no ancestor');
    scene.destroy();
  });

  it('treats an all-zero DOM rect as unavailable rather than a divergence', () => {
    // jsdom reports 0x0 at 0,0 for every element. Publishing that as real
    // geometry would report every projected entity as massively drifted.
    const scene = makeScene();
    const box = new Box('b', 40, 20);
    box.setPosition(10, 10);
    scene.add(box);

    const layers = highlightGeometry(scene, box);
    for (const kind of ['content', 'a11y'] as const) {
      const layer = layerOf(layers, kind);
      expect(layer.polygons).toHaveLength(0);
      expect(layer.unavailable).toBeTruthy();
      expect(layer.divergesFromLayout).toBeUndefined();
    }
    scene.destroy();
  });

  it('computes only the requested layers', () => {
    const scene = makeScene();
    const box = new Box('b');
    scene.add(box);
    const layers = highlightGeometry(scene, box, { layers: ['aabb'] });
    expect(layers.map((l) => l.kind)).toEqual(['aabb']);
    scene.destroy();
  });

  it('omits the hit layer unless it is asked for', () => {
    const scene = makeScene();
    const box = new Box('b');
    scene.add(box);
    expect(highlightGeometry(scene, box).some((l) => l.kind === 'hit')).toBe(false);
    scene.destroy();
  });
});

describe('sampleHitRegion', () => {
  it('approximates a circular hit area and flags it as diverging from the box', () => {
    const disc = new Disc('d', 40);
    disc.setPosition(0, 0);

    const layer = sampleHitRegion(disc, { step: 4 });
    expect(layer.kind).toBe('hit');
    // One span per scanline that intersects the circle, so many spans rather
    // than the single rectangle a box would produce.
    expect(layer.polygons.length).toBeGreaterThan(4);
    expect(layer.divergesFromLayout).toBe(true);

    // Spans must narrow towards the top of the circle: that shape is the whole
    // point, and a bounding box would give equal widths.
    const widths = layer.polygons.map((p) => {
      const xs = p.points.map((pt) => pt.x);
      return Math.max(...xs) - Math.min(...xs);
    });
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });

  it('does not flag a hit area that fills its box', () => {
    class Full extends Entity {
      constructor() {
        super('full');
        this.width = 40;
        this.height = 40;
      }
      override isPointInside(): boolean {
        return true;
      }
      render(): void {}
    }
    const layer = sampleHitRegion(new Full(), { step: 4 });
    expect(layer.divergesFromLayout).toBeUndefined();
  });

  it('refuses to sample beyond the probe budget instead of stalling', () => {
    const huge = new Box('huge', 4000, 4000);
    const layer = sampleHitRegion(huge, { step: 1, budget: 100 });
    expect(layer.polygons).toHaveLength(0);
    expect(layer.unavailable).toContain('budget');
  });

  it('reports an entity that answers false everywhere', () => {
    const layer = sampleHitRegion(new Box('b', 40, 20), { step: 4 });
    expect(layer.unavailable).toContain('false everywhere');
  });

  it('treats a throwing isPointInside as a miss rather than propagating', () => {
    class Hostile extends Entity {
      constructor() {
        super('h');
        this.width = 20;
        this.height = 20;
      }
      override isPointInside(): boolean {
        throw new Error('nope');
      }
      render(): void {}
    }
    expect(() => sampleHitRegion(new Hostile(), { step: 4 })).not.toThrow();
  });
});

describe('formatHighlightGeometry', () => {
  it('renders extents, span counts and divergence, including unavailable layers', () => {
    const scene = makeScene();
    const box = new Box('b', 40, 20);
    box.setPosition(10, 5);
    scene.add(box);

    const lines = formatHighlightGeometry(highlightGeometry(scene, box));
    expect(lines.some((l) => l.startsWith('aabb: 10,5 40x20'))).toBe(true);
    // An unavailable layer is still listed: knowing a box did not drift is a
    // finding, and omitting it would read as "not computed".
    expect(lines.some((l) => l.startsWith('clip: —'))).toBe(true);
    scene.destroy();
  });

  it('counts spans for a sampled region', () => {
    const disc = new Disc('d', 20);
    const line = formatHighlightGeometry([sampleHitRegion(disc, { step: 4 })])[0]!;
    expect(line).toContain('spans');
    expect(line).toContain('diverges');
  });
});
