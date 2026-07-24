import { describe, it, expect } from 'vitest';
import { Entity, Scene, type ContentProjection } from '@vectojs/core';
import { auditEntitySelection, auditSceneSelection } from '../src/selectionAudit';

/**
 * The selection audit compares live DOM `Range.getClientRects()` against
 * projection geometry — the *geometry* half needs a real browser (jsdom returns
 * empty rects), which the `scripts/selection-harness` driver covers on real
 * Chrome/Firefox. These unit tests pin the parts that DON'T need real layout:
 * which entities are audited, and that a clean/empty result is the default.
 */
class ProjText extends Entity {
  constructor(
    id: string,
    private projection: ContentProjection | null,
  ) {
    super(id);
    this.width = 200;
    this.height = 40;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getContentProjection(): ContentProjection | null {
    return this.projection;
  }
}

function makeScene(): Scene {
  const canvas = document.createElement('canvas');
  document.createElement('div').appendChild(canvas);
  return new Scene(canvas, { disableWindowResize: true });
}

const line = (over: Partial<ContentProjection['lines'][number]> = {}) => ({
  text: 'hello world',
  x: 0,
  y: 0,
  baseline: 12,
  ...over,
});

describe('auditEntitySelection — gating', () => {
  it('is a no-op for an entity with no projection', () => {
    const scene = makeScene();
    const e = new ProjText('a', null);
    scene.add(e);
    expect(auditEntitySelection(scene, e)).toEqual([]);
  });

  it('is a no-op for an explicitly non-selectable projection', () => {
    const scene = makeScene();
    const e = new ProjText('a', {
      text: 'x',
      font: '16px sans',
      selectable: false,
      lines: [line()],
    });
    scene.add(e);
    expect(auditEntitySelection(scene, e)).toEqual([]);
  });

  it('is a no-op when the entity has no materialized content element', () => {
    const scene = makeScene();
    // Not added to the scene → no DOM projection element exists yet.
    const e = new ProjText('lonely', {
      text: 'x',
      font: '16px sans',
      lines: [line()],
    });
    expect(auditEntitySelection(scene, e)).toEqual([]);
  });
});

describe('auditSceneSelection — traversal', () => {
  it('returns an empty array for a scene with no selectable text', () => {
    const scene = makeScene();
    expect(auditSceneSelection(scene)).toEqual([]);
  });

  it('restricts to entityIds when provided', () => {
    const scene = makeScene();
    const a = new ProjText('a', {
      text: 'a',
      font: '16px sans',
      lines: [line()],
    });
    const b = new ProjText('b', {
      text: 'b',
      font: '16px sans',
      lines: [line()],
    });
    scene.add(a);
    scene.add(b);
    // jsdom yields empty client rects → no findings, but the call must not throw
    // and must accept the id filter. (Real drift numbers come from the harness.)
    expect(auditSceneSelection(scene, { entityIds: ['a'] })).toEqual([]);
  });
});
