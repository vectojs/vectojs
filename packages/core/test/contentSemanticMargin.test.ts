// @vitest-environment jsdom
/**
 * The semantic/interaction margin split (CTX-0201, vectojs#343).
 *
 * `contentProjectionMargin` was one scalar arming two independent gates: the box
 * test that decides whether a block has ANY DOM, and the line band that decides
 * whether its fine per-line carriers are windowed. Only two states were
 * reachable — finite freed off-band blocks entirely, so off-screen text was
 * invisible to find-in-page and screen-reader read-ahead, and `Infinity` made
 * every block resident AND materialized every carrier, which is the
 * O(total document glyphs) regression of CTX-0024.
 *
 * `contentSemanticMargin` arms only the box gate, so the wanted middle tier —
 * coarse text resident for the whole document, fine carriers windowed to the
 * viewport — becomes expressible. (carryctx DEC-01KZ6RSS)
 *
 * These tests assert CARRIER COUNTS and `textContent`, never the option value,
 * because both failure modes here are silent: a spurious carrier per off-band
 * block is wrong-but-invisible, and an empty carrier window would blank the text
 * entirely while leaving the element in place.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentProjection, ContentProjectionHint } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;

/**
 * A multi-line text block that honours the hint the way the real entities do:
 * `lines` narrows, `text` stays whole (`ui/Text.ts:270`, `ui/RichText.ts:651`,
 * `markdown/Markdown.ts:1240`). Routing an off-band block to the plain-text
 * branch depends on exactly that property.
 */
class Block extends Entity {
  public epoch = 0;
  /** Counts `getContentProjection` calls, to prove a dirty-track skip skipped. */
  public projectionCalls = 0;
  /** Set when the last call received a band that selected none of its lines. */
  public sawEmptyBand = false;

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
    this.sawEmptyBand = lines.length === 0;
    return {
      // Full text regardless of the hint — the contract the coarse tier rides on.
      text: this.fullText(),
      font: '16px sans-serif',
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

function makeScene(options: Record<string, unknown> = {}): Scene {
  // Grid calibration runs in a deferred rAF and measures real text with
  // `Range.getBoundingClientRect`, which jsdom does not implement.
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

function el(scene: Scene, id: string): HTMLElement | undefined {
  return scene.getContentElement(id);
}

/** Far enough below the viewport that no margin short of Infinity reaches it. */
const FAR_OFF_BAND_Y = 40_000;

describe('contentSemanticMargin: resident coarse text with windowed carriers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives an off-band block its full text with ZERO carrier children', () => {
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('off', 10);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    const node = el(scene, 'off');
    // The box gate must NOT have released it: that is the whole point of a
    // resident semantic tier.
    expect(node).toBeDefined();
    // Zero carriers. Pre-change this is 1 — `projectionLineWindow` fell back to
    // keeping the single nearest line, on the assumption that a fully off-band
    // entity had already been released by the box gate.
    expect(node!.children.length).toBe(0);
    // And the text is WHOLE, not just the one nearest line. An empty carrier
    // window would leave this an empty string, which is the worse failure.
    expect(node!.textContent).toBe(block.fullText());
    expect(node!.textContent).toContain('off-line0');
    expect(node!.textContent).toContain('off-line9');
    // No stale windowing metadata on a block that is not windowed.
    expect(node!.dataset.vectoProjectionLines).toBeUndefined();
    expect(node!.dataset.vectoProjectionWindow).toBeUndefined();
    scene.destroy();
  });

  it('still gives an in-band block per-line carriers', () => {
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('on', 5);
    block.setPosition(0, 0);
    scene.add(block);
    sync(scene);

    const node = el(scene, 'on')!;
    expect(node.children.length).toBe(5);
    expect(node.textContent).toContain('on-line0');
    expect(node.textContent).toContain('on-line4');
    scene.destroy();
  });

  it('serves both tiers in one scene from one sync', () => {
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const near = new Block('near', 4);
    near.setPosition(0, 0);
    const far = new Block('far', 4);
    far.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(near);
    scene.add(far);
    sync(scene);

    expect(el(scene, 'near')!.children.length).toBe(4);
    expect(el(scene, 'far')!.children.length).toBe(0);
    // Both are findable — the capability the split exists to deliver.
    expect(el(scene, 'far')!.textContent).toBe(far.fullText());
    scene.destroy();
  });

  it('promotes a block to per-line carriers when it scrolls into the interaction band', () => {
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('moving', 6);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    expect(el(scene, 'moving')!.children.length).toBe(0);

    // Scroll it into view. Geometry alone must re-tier it: the content has not
    // changed, so the epoch has not moved.
    block.setPosition(0, 0);
    sync(scene);
    const node = el(scene, 'moving')!;
    expect(node.children.length).toBe(6);
    expect(node.textContent).toContain('moving-line0');

    // And back out again — the carriers must be released, not stranded.
    block.setPosition(0, FAR_OFF_BAND_Y);
    sync(scene);
    expect(el(scene, 'moving')!.children.length).toBe(0);
    expect(el(scene, 'moving')!.textContent).toBe(block.fullText());
    scene.destroy();
  });

  it('lets a resident off-band block skip an unchanged sync entirely', () => {
    // The coarse tier must stay compatible with #349's dirty-track skip, which is
    // what makes a resident tier affordable at all. A tier recorded as "no band"
    // is scroll-invariant by construction; one that recorded the line band would
    // carry the viewport's own position (the band is the viewport in entity-local
    // y, unclamped) and could then never match on a later frame.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('resident', 8);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    const afterFirst = block.projectionCalls;
    expect(afterFirst).toBeGreaterThan(0);

    sync(scene);
    sync(scene);
    sync(scene);
    expect(block.projectionCalls).toBe(afterFirst);
    expect(el(scene, 'resident')!.children.length).toBe(0);
    scene.destroy();
  });

  it('keeps a block coarse as it moves while remaining off-band', () => {
    // Moving the entity legitimately invalidates the dirty-track key — its world
    // transform is part of that key — so this asserts the resulting DOM rather
    // than a call count: every rebuild must land on the coarse tier again, emit
    // no carrier, and lose no text.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('drifting', 8);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    for (const y of [FAR_OFF_BAND_Y - 500, FAR_OFF_BAND_Y - 1_000, FAR_OFF_BAND_Y + 250]) {
      block.setPosition(0, y);
      sync(scene);
      const node = el(scene, 'drifting')!;
      expect(node.children.length).toBe(0);
      expect(node.textContent).toBe(block.fullText());
    }
    scene.destroy();
  });

  it('keeps all lines for a ROTATED in-band block, which also has no band', () => {
    // A rotated entity gets `null` from `projectionVisibleLocalYBand` (a y band
    // is meaningless once local x mixes into world y), so it must project every
    // line. The coarse tier ALSO has no band, so the two cases are
    // indistinguishable from the band alone — this pins that they stay distinct.
    const scene = makeScene({
      contentSemanticMargin: Infinity,
      contentProjectionMargin: VIEW_H,
    });
    const block = new Block('rotated', 5);
    block.setPosition(0, 0);
    block.rotation = 0.3;
    scene.add(block);
    sync(scene);

    const node = el(scene, 'rotated')!;
    // In-band: fine tier, every line, because there is no band to window by.
    expect(node.children.length).toBe(5);
    scene.destroy();
  });

  it('leaves today\u2019s behaviour unchanged when only contentProjectionMargin is set', () => {
    // Purely additive: with no semantic margin, the box gate still uses the
    // interaction margin, so a far-off-band block is RELEASED as before.
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const block = new Block('legacy', 10);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    expect(el(scene, 'legacy')).toBeUndefined();
    scene.destroy();
  });

  it('defaults the semantic margin to one viewport height, as before', () => {
    const scene = makeScene({});
    const off = new Block('def-off', 4);
    off.setPosition(0, FAR_OFF_BAND_Y);
    const on = new Block('def-on', 4);
    on.setPosition(0, 0);
    scene.add(off);
    scene.add(on);
    sync(scene);

    expect(el(scene, 'def-off')).toBeUndefined();
    expect(el(scene, 'def-on')!.children.length).toBe(4);
    scene.destroy();
  });

  it('keeps contentProjectionMargin: Infinity materializing everything', () => {
    // The legacy escape hatch still works, and still costs what it always did.
    const scene = makeScene({ contentProjectionMargin: Infinity });
    const block = new Block('legacy-inf', 12);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    const node = el(scene, 'legacy-inf')!;
    expect(node.children.length).toBe(12);
    scene.destroy();
  });

  it('treats a finite semantic margin as a wider box gate, not as a tier switch', () => {
    // A block inside the semantic margin but outside the interaction margin is
    // exactly the coarse tier; one inside both is fine-tiered. This is the same
    // split as Infinity, without Infinity.
    const scene = makeScene({
      contentSemanticMargin: 5_000,
      contentProjectionMargin: VIEW_H,
    });
    const coarse = new Block('coarse', 4);
    coarse.setPosition(0, 2_000);
    const fine = new Block('fine', 4);
    fine.setPosition(0, 0);
    const gone = new Block('gone', 4);
    gone.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(coarse);
    scene.add(fine);
    scene.add(gone);
    sync(scene);

    expect(el(scene, 'coarse')!.children.length).toBe(0);
    expect(el(scene, 'coarse')!.textContent).toBe(coarse.fullText());
    expect(el(scene, 'fine')!.children.length).toBe(4);
    // Beyond the semantic margin too: released entirely.
    expect(el(scene, 'gone')).toBeUndefined();
    scene.destroy();
  });
});
