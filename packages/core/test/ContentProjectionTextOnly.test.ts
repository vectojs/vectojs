// @vitest-environment jsdom
/**
 * `ContentProjectionHint.textOnly` — coarse-tier signal to skip building
 * per-line/per-glyph structures when the caller only needs the text.
 *
 * When an entity is resident but off-viewport (coarse tier), Scene needs only
 * `projection.text` for browser find. Building `lines` or `grid` in that state
 * is O(document glyphs) per synced frame for no benefit — the structures are
 * built then immediately discarded.
 *
 * This test verifies that an entity receiving `textOnly: true` can return a
 * projection with text but no lines, and that Scene accepts it without error.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentProjection, ContentProjectionHint } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;

class TextOnlyEntity extends Entity {
  public receivedHint: ContentProjectionHint | undefined;
  public text = 'Sample text for coarse tier';

  constructor(id: string) {
    super(id);
    this.width = 200;
    this.height = 100;
  }

  isPointInside(): boolean {
    return false;
  }

  render(): void {}

  override getContentProjection(hint?: ContentProjectionHint): ContentProjection | null {
    this.receivedHint = hint;
    // Honor textOnly: return text without lines.
    if (hint?.textOnly) {
      return {
        text: this.text,
        font: '16px sans-serif',
        lineHeight: 20,
        selectable: true,
      };
    }
    // Normal path: return with lines.
    return {
      text: this.text,
      font: '16px sans-serif',
      lineHeight: 20,
      lines: [
        {
          text: this.text,
          x: 0,
          y: 0,
          baseline: 16,
          font: '16px sans-serif',
          lineHeight: 20,
        },
      ],
      selectable: true,
    };
  }
}

/**
 * A resident-tier scene: a finite interaction margin so off-band blocks fall to
 * the coarse tier, and `contentSemanticMargin: Infinity` so they keep DOM there
 * rather than being released outright.
 */
function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas, {
    contentProjectionMargin: 100,
    contentSemanticMargin: Infinity,
  });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

// All tests share one sync helper that matches the pattern in other projection
// tests: call the private syncA11y(root) through a type cast.
function sync(scene: Scene): void {
  const s = scene as unknown as { syncA11y: (r: unknown) => void; root: unknown };
  s.syncA11y(s.root);
}

describe('ContentProjectionHint.textOnly', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('passes textOnly: true for coarse-tier (off-viewport) entities', () => {
    const scene = makeScene();
    const entity = new TextOnlyEntity('text-only-entity');
    entity.x = 0;
    // Well past the 100px interaction margin, so the box gate puts it coarse.
    entity.y = VIEW_H + 1000;
    scene.add(entity);
    sync(scene);

    expect(entity.receivedHint).toBeDefined();
    expect(entity.receivedHint?.textOnly).toBe(true);

    // The coarse-tier projection must still be materialized for find-in-page.
    const contentEl = scene.getContentElement(entity.id);
    expect(contentEl).toBeTruthy();
    expect(contentEl?.textContent).toContain('Sample text');
    scene.destroy();
  });

  it('does not pass textOnly for in-viewport (fine-tier) entities', () => {
    const scene = makeScene();
    const entity = new TextOnlyEntity('in-viewport-entity');
    entity.x = 10;
    entity.y = 10; // In viewport — fine tier
    scene.add(entity);
    sync(scene);

    // Fine-tier entities receive the band hint but NOT textOnly.
    expect(entity.receivedHint?.textOnly).toBeFalsy();

    const contentEl = scene.getContentElement(entity.id);
    expect(contentEl).toBeTruthy();
    expect(contentEl?.textContent).toContain('Sample text');
    scene.destroy();
  });

  it('accepts projection with text but no lines under textOnly without throwing', () => {
    const scene = makeScene();
    const entity = new TextOnlyEntity('coarse-no-lines');
    entity.x = 0;
    entity.y = VIEW_H + 2000; // Far off viewport — coarse tier
    scene.add(entity);

    expect(() => sync(scene)).not.toThrow();

    const contentEl = scene.getContentElement(entity.id);
    expect(contentEl).toBeTruthy();
    expect(contentEl?.textContent).toContain('Sample text');
    scene.destroy();
  });
});
