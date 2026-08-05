// @vitest-environment jsdom
/**
 * The projection rebuild path must not read the document Selection once per
 * element (CTX-0203).
 *
 * Reading ANY property of a `Selection` forces a synchronous layout, because
 * Blink validates the selection against current box geometry before answering.
 * Measured in real Chrome against a 1000-carrier subtree, with layout dirtied
 * between reads the way materializing a block dirties it: `anchorNode` 0.5ms,
 * `rangeCount` 0.4ms, `type` 0.5ms, `isCollapsed` 0.5ms — every one
 * indistinguishable from `offsetHeight` (0.5ms), against a 0ms floor for
 * mutating without reading. There is no cheap property to probe with.
 *
 * Because every rebuilt element asked the Selection whether the rebuild would
 * destroy it, cost per materialized block rose with how many were already
 * resident. Profiled in real Chrome over a 1000-block resident drain:
 *
 *   before  2002 forced layouts, 800ms Layout+UpdateLayoutTree, ~337ms drain
 *   after     19 forced layouts,  66.8ms,                        52.3ms drain
 *
 * and per-chunk cost went from climbing (17.2 → 26ms as residency grew) to flat
 * (1.1–2.3ms at every residency). The superlinearity was this defect, not an
 * inherent property of the resident tier.
 *
 * A Selection is a single document-wide object and a sync walk cannot yield to
 * the user, so its presence cannot change mid-walk — which is what makes one
 * read per walk correct rather than merely cheaper. These tests assert the read
 * is O(1) in the number of rebuilt elements, and that the O(1) fast path does
 * not cost the selection handling it replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentProjection } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;

class Block extends Entity {
  public epoch = 0;

  constructor(
    id: string,
    private readonly lineCount: number,
  ) {
    super(id);
    this.width = 200;
    this.height = lineCount * LINE_H;
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(): void {}

  public override getContentEpoch(): number {
    return this.epoch;
  }

  public override getContentProjection(): ContentProjection {
    const lines: NonNullable<ContentProjection['lines']> = [];
    for (let i = 0; i < this.lineCount; i++) {
      lines.push({
        // Text depends on `epoch` so bumping it is a real content change: the
        // coarse branch rebuilds on `el.textContent !== projection.text`, so an
        // epoch bump that left the text identical would (correctly) rebuild
        // nothing and there would be no selection question to ask.
        text: `${this.id}-line${i}-v${this.epoch}`,
        x: 0,
        y: i * LINE_H,
        baseline: 14,
        lineHeight: LINE_H,
      });
    }
    return {
      text: lines.map((l) => l.text).join('\n'),
      font: '16px sans-serif',
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

function makeScene(options: Record<string, unknown> = {}): Scene {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas, options);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

function sync(scene: Scene): void {
  const s = scene as unknown as {
    syncA11y: (r: unknown) => void;
    root: unknown;
  };
  s.syncA11y(s.root);
}

/**
 * Counts `window.getSelection` calls. jsdom does not force layout, so the call
 * COUNT is the observable stand-in for the forced-layout count it causes in a
 * real engine — the profile above is what ties the two together.
 */
function countSelectionReads(): { calls: () => number; restore: () => void } {
  const original = window.getSelection.bind(window);
  const spy = vi.fn(() => original());
  Object.defineProperty(window, 'getSelection', {
    value: spy,
    configurable: true,
    writable: true,
  });
  return {
    calls: () => spy.mock.calls.length,
    restore: () => {
      Object.defineProperty(window, 'getSelection', {
        value: original,
        configurable: true,
        writable: true,
      });
    },
  };
}

/** All blocks far off-viewport, so each is coarse-tiered and resident. */
function residentDoc(
  count: number,
  options: Record<string, unknown> = {},
): { scene: Scene; blocks: Block[] } {
  const scene = makeScene({
    contentSemanticMargin: Infinity,
    contentProjectionMargin: VIEW_H,
    contentSemanticBudget: Infinity,
    ...options,
  });
  const blocks: Block[] = [];
  for (let i = 0; i < count; i++) {
    const b = new Block(`b${i}`, 3);
    b.setPosition(0, 10_000 + i * 200);
    scene.add(b);
    blocks.push(b);
  }
  return { scene, blocks };
}

describe('projection rebuild does not read the Selection per element', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('reads the Selection a bounded number of times regardless of block count', () => {
    const small = residentDoc(10);
    const probeSmall = countSelectionReads();
    sync(small.scene);
    const readsFor10 = probeSmall.calls();
    probeSmall.restore();
    small.scene.destroy();

    document.body.innerHTML = '';
    const large = residentDoc(200);
    const probeLarge = countSelectionReads();
    sync(large.scene);
    const readsFor200 = probeLarge.calls();
    probeLarge.restore();

    // 20x the blocks must not mean more reads. Pre-fix this was one read per
    // block (10 vs 200); the memo makes it one per walk.
    expect(readsFor200).toBe(readsFor10);
    expect(readsFor200).toBeLessThanOrEqual(2);
    large.scene.destroy();
  });

  it('materializes every block despite reading the Selection only once', () => {
    const { scene, blocks } = residentDoc(40);
    const probe = countSelectionReads();
    sync(scene);
    probe.restore();
    // The saving must come from not re-reading, not from doing less work. A
    // coarse block carries its whole text without per-line carriers, so the text
    // is what proves nothing was skipped.
    for (const b of blocks) {
      const el = scene.getContentElement(b.id);
      expect(el).toBeTruthy();
      expect(el?.textContent).toBe(b.getContentProjection().text);
    }
    scene.destroy();
  });

  it('re-reads the Selection on a later walk that rebuilds again', () => {
    const { scene, blocks } = residentDoc(20);
    sync(scene);
    // A memo that survived the walk would never notice a selection the user made
    // after it. Content must actually change, or the dirty-track early-return
    // means no rebuild is attempted and there is correctly nothing to ask about.
    for (const b of blocks) b.epoch++;
    const probe = countSelectionReads();
    sync(scene);
    const reads = probe.calls();
    probe.restore();
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(2);
    scene.destroy();
  });

  it('still releases a selection owned by a rebuilt element', () => {
    // In-viewport so the block is FINE-tiered: only that tier builds the per-line
    // carrier spans a Range can be anchored inside.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('near', 3);
    block.setPosition(0, 0);
    scene.add(block);
    sync(scene);

    const el = scene.getContentElement('near')!;
    const textNode = el.querySelector('span')?.firstChild as Text | undefined;
    expect(textNode).toBeTruthy();

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, 4);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.rangeCount).toBe(1);

    // Change the content so the carriers must be rebuilt. The fast path must not
    // swallow this case: the selection points into nodes about to be discarded.
    block.epoch++;
    sync(scene);

    // What must not survive is a range into DETACHED nodes — either the selection
    // was released, or it was re-resolved onto the new nodes.
    if (selection.rangeCount > 0 && selection.anchorNode) {
      expect(selection.anchorNode.isConnected).toBe(true);
    }
    scene.destroy();
  });

  it('does not read the Selection at all when nothing is projected', () => {
    const scene = makeScene({ contentSemanticMargin: Infinity });
    const plain = new Entity('plain');
    plain.interactive = true;
    scene.add(plain);
    const probe = countSelectionReads();
    sync(scene);
    const reads = probe.calls();
    probe.restore();
    // No content projection means no rebuild, so the memo is never even resolved.
    expect(reads).toBe(0);
    scene.destroy();
  });
});
