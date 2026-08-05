// @vitest-environment jsdom
/**
 * The resident semantic tier's materialization budget (CTX-0203).
 *
 * `contentSemanticMargin: Infinity` makes a whole document's text resident, and
 * the cost of that is paid per node CREATED (~13µs), not per node held — 10000
 * resident blocks cost 2.470 ms/sync at steady state. So the front-load is a
 * scheduling problem: measured on the shipped implementation, `firstSyncMs` was
 * 46.72 ms at 1000 blocks on Chrome, past the ~30 ms trigger DEC-01KZ6RSS set
 * for needing a budget, at a document size (~3000 lines) a long transcript
 * reaches easily.
 *
 * `contentSemanticBudget` bounds how many resident blocks may be materialized in
 * one sync; the rest arrive over subsequent frames. The end state is unchanged —
 * every block ends up with the same DOM, only later — so these tests assert both
 * halves: that a single sync is bounded, AND that repeated syncs converge on the
 * complete document with nothing lost.
 *
 * The two silent failure modes this guards are a block that is present but empty
 * (findable-yet-blank), and a deferred block that thrashes instead of waiting.
 * Both are asserted directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentProjection, ContentProjectionHint } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { DEFAULT_CONTENT_SEMANTIC_BUDGET, Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;

class Block extends Entity {
  public epoch = 0;
  /** Counts `getContentProjection` calls, to prove a deferred block does not thrash. */
  public projectionCalls = 0;

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

  public fullText(): string {
    const out: string[] = [];
    for (let i = 0; i < this.lineCount; i++) out.push(`${this.id}-line${i}`);
    return out.join('\n');
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection {
    this.projectionCalls++;
    const lines: NonNullable<ContentProjection['lines']> = [];
    for (let i = 0; i < this.lineCount; i++) {
      const y = i * LINE_H;
      if (hint?.minY !== undefined && hint.maxY !== undefined) {
        if (!(y + LINE_H >= hint.minY && y <= hint.maxY)) continue;
      }
      lines.push({
        text: `${this.id}-line${i}`,
        x: 0,
        y,
        baseline: 14,
        lineHeight: LINE_H,
      });
    }
    return {
      text: this.fullText(),
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
 * A resident document whose blocks are all FAR off-viewport, so every one of them
 * is coarse-tiered and therefore budgetable.
 */
function residentDoc(
  count: number,
  options: Record<string, unknown> = {},
): { scene: Scene; blocks: Block[] } {
  const scene = makeScene({
    contentSemanticMargin: Infinity,
    contentProjectionMargin: VIEW_H,
    ...options,
  });
  const blocks: Block[] = [];
  for (let i = 0; i < count; i++) {
    const b = new Block(`b${i}`, 3);
    // Start below the viewport + margin so nothing is fine-tiered.
    b.setPosition(0, 10_000 + i * 200);
    scene.add(b);
    blocks.push(b);
  }
  return { scene, blocks };
}

function materializedCount(scene: Scene, blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) if (scene.getContentElement(b.id)) n++;
  return n;
}

describe('contentSemanticBudget: frame-budgeted resident materialization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('materializes at most `budget` resident blocks in one sync', () => {
    const { scene, blocks } = residentDoc(50, { contentSemanticBudget: 8 });
    sync(scene);
    expect(materializedCount(scene, blocks)).toBe(8);
    scene.destroy();
  });

  it('converges on the COMPLETE document over repeated syncs, losing no text', () => {
    // The other half of the contract. A budget that bounded the first sync but
    // never finished would be a capability regression disguised as a speedup.
    const { scene, blocks } = residentDoc(50, { contentSemanticBudget: 8 });
    for (let i = 0; i < 7; i++) sync(scene);
    expect(materializedCount(scene, blocks)).toBe(50);
    for (const b of blocks) {
      const el = scene.getContentElement(b.id)!;
      // Whole text, and reachable — not present-but-empty, the silent failure.
      expect(el.textContent).toBe(b.fullText());
      expect(el.style.display).toBe('');
      expect(el.children.length).toBe(0);
    }
    scene.destroy();
  });

  it('advances the frontier by `budget` on each sync', () => {
    const { scene, blocks } = residentDoc(40, { contentSemanticBudget: 10 });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      sync(scene);
      seen.push(materializedCount(scene, blocks));
    }
    expect(seen).toEqual([10, 20, 30, 40]);
    scene.destroy();
  });

  it('does not call getContentProjection on a deferred block', () => {
    // The budget must skip BEFORE the O(glyphs-in-block) build, or it would bound
    // the DOM writes while still paying the projection cost it exists to defer.
    const { scene, blocks } = residentDoc(20, { contentSemanticBudget: 5 });
    sync(scene);
    const materialized = blocks.filter((b) => scene.getContentElement(b.id));
    const deferred = blocks.filter((b) => !scene.getContentElement(b.id));
    expect(materialized.length).toBe(5);
    expect(deferred.length).toBe(15);
    for (const b of deferred) expect(b.projectionCalls).toBe(0);
    scene.destroy();
  });

  it('does not let a deferred block thrash while it waits', () => {
    // A deferred block is re-evaluated every sync. That evaluation must stay
    // O(ancestor-depth) box tests and never build a projection, or waiting would
    // cost more than materializing.
    const { scene, blocks } = residentDoc(30, { contentSemanticBudget: 4 });
    sync(scene);
    sync(scene);
    sync(scene);
    // The last block is still waiting after 3 syncs (12 of 30 materialized).
    const last = blocks[29];
    expect(scene.getContentElement(last.id)).toBeUndefined();
    expect(last.projectionCalls).toBe(0);
    scene.destroy();
  });

  it('never defers the FINE tier: on-screen text materializes immediately', () => {
    // Text a user can see must be selectable in the frame it is drawn. A budget of
    // 1 must not stop 6 in-viewport blocks from all materializing.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
      contentSemanticBudget: 1,
    });
    const blocks: Block[] = [];
    for (let i = 0; i < 6; i++) {
      const b = new Block(`v${i}`, 2);
      // 2 lines * 20px = 40px; stack inside the 300px viewport.
      b.setPosition(0, i * 45);
      scene.add(b);
      blocks.push(b);
    }
    sync(scene);
    for (const b of blocks) {
      const el = scene.getContentElement(b.id);
      expect(el).toBeDefined();
      expect(el!.children.length).toBe(2);
    }
    scene.destroy();
  });

  it('does not charge the fine tier against the resident budget', () => {
    // Fine and coarse blocks in one scene: the in-viewport ones must not consume
    // the pool, or a screenful of new text would starve the resident tier.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
      contentSemanticBudget: 3,
    });
    const fine: Block[] = [];
    for (let i = 0; i < 4; i++) {
      const b = new Block(`f${i}`, 2);
      b.setPosition(0, i * 45);
      scene.add(b);
      fine.push(b);
    }
    const coarse: Block[] = [];
    for (let i = 0; i < 10; i++) {
      const b = new Block(`c${i}`, 3);
      b.setPosition(0, 10_000 + i * 200);
      scene.add(b);
      coarse.push(b);
    }
    sync(scene);
    // All 4 fine blocks materialized...
    expect(materializedCount(scene, fine)).toBe(4);
    // ...and the coarse budget is still a full 3.
    expect(materializedCount(scene, coarse)).toBe(3);
    scene.destroy();
  });

  it('never defers an UPDATE to an existing block, which would serve stale text', () => {
    // The budget delays a first appearance only. A block that already has DOM is
    // being updated, and deferring that leaves the old string in the document —
    // silently wrong, and worse than the stall the budget exists to avoid.
    const { scene, blocks } = residentDoc(6, { contentSemanticBudget: 6 });
    sync(scene);
    expect(materializedCount(scene, blocks)).toBe(6);

    // Change every block's content in one frame, with a budget that could not
    // cover 6 fresh materializations.
    (scene as unknown as { contentSemanticBudget: number }).contentSemanticBudget = 1;
    for (const b of blocks) b.epoch++;
    sync(scene);
    for (const b of blocks) {
      expect(scene.getContentElement(b.id)!.textContent).toBe(b.fullText());
    }
    scene.destroy();
  });

  it('Infinity restores one synchronous pass', () => {
    const { scene, blocks } = residentDoc(40, {
      contentSemanticBudget: Infinity,
    });
    sync(scene);
    expect(materializedCount(scene, blocks)).toBe(40);
    scene.destroy();
  });

  it('applies a default budget when none is given', () => {
    const { scene, blocks } = residentDoc(DEFAULT_CONTENT_SEMANTIC_BUDGET + 20);
    sync(scene);
    expect(materializedCount(scene, blocks)).toBe(DEFAULT_CONTENT_SEMANTIC_BUDGET);
    scene.destroy();
  });

  it('leaves the DEFAULT configuration completely unbudgeted', () => {
    // Without a wider semantic margin there is no coarse tier, so no block is
    // budgetable and the option cannot affect the default path. This is what makes
    // the change safe to enable by default.
    const scene = makeScene({
      contentProjectionMargin: VIEW_H,
      contentSemanticBudget: 1,
    });
    const blocks: Block[] = [];
    for (let i = 0; i < 5; i++) {
      const b = new Block(`d${i}`, 2);
      b.setPosition(0, i * 45);
      scene.add(b);
      blocks.push(b);
    }
    sync(scene);
    expect(materializedCount(scene, blocks)).toBe(5);
    scene.destroy();
  });

  it('keeps a materialized block through later syncs rather than cycling it', () => {
    // Guards a budget implemented as "release the oldest to admit the newest",
    // which would satisfy a bound while making the document permanently partial
    // and thrashing the DOM every frame.
    const { scene, blocks } = residentDoc(20, { contentSemanticBudget: 5 });
    sync(scene);
    const first = blocks[0];
    const firstEl = scene.getContentElement(first.id);
    expect(firstEl).toBeDefined();
    for (let i = 0; i < 5; i++) sync(scene);
    // Same element instance, not rebuilt.
    expect(scene.getContentElement(first.id)).toBe(firstEl);
    expect(materializedCount(scene, blocks)).toBe(20);
    scene.destroy();
  });
});
