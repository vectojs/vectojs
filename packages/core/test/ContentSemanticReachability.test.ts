// @vitest-environment jsdom
/**
 * The resident semantic tier must be REACHABLE, not merely present in the DOM
 * (CTX-0203, follow-up to CTX-0201/DEC-01KZ6Z2K).
 *
 * `contentSemanticMargin: Infinity` exists so a whole document's text is
 * findable by native find-in-page and available to screen-reader read-ahead
 * while per-line carriers stay bounded by the viewport. Shipped in
 * @vectojs/core@1.31.0, it delivered the DOM node but not the capability: the
 * coarse tier's element was `display: none`, and `display: none` text is skipped
 * by find-in-page and absent from the accessibility tree.
 *
 * The mechanism was an implication, not a coincidence. `visible` is
 * `projectionBoxVisible(node, worldTf, 0)`; a coarse block is by definition
 * outside the interaction margin, and every margin is >= 0, so a coarse block
 * necessarily fails the margin-0 test too. Coarse therefore IMPLIED
 * `display: none`.
 *
 * Measured in real headed Chrome 151 before fixing, to establish that `display`
 * is the deciding property rather than something incidental:
 *
 * - `window.find(needle)` on a transparent absolutely-positioned carrier with
 *   `display: ''` returns TRUE; the identical carrier with `display: 'none'`
 *   returns FALSE.
 * - `textContent` sees the hidden text, `innerText` does NOT, and the a11y tree
 *   lists only the visible node. This is why the existing capability proof
 *   missed it: it counted elements and read `textContent`, both blind to
 *   `display: none`.
 * - Reproducing Scene's real structure (a11yRoot 100vw/100vh, `overflow: hidden`,
 *   `pointer-events: none`, with the content element at `top: 40000px`), the
 *   clipped-but-displayed text is findable and `a11yRoot.scrollTop` /
 *   `window.scrollY` are both 0 before AND after the find. `overflow: hidden` on
 *   a non-scrollable container gives the browser nowhere to scroll a match into
 *   view, so exposing off-viewport text cannot pull the projection layer out of
 *   alignment with the canvas.
 *
 * These tests assert `style.display` together with `textContent` and carrier
 * counts, because the failure is silent in exactly the way element counts cannot
 * see.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentProjection, ContentProjectionHint } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;

/** Far enough below the viewport that no margin short of Infinity reaches it. */
const FAR_OFF_BAND_Y = 40_000;

/** Honours the hint the way the real entities do: `lines` narrows, `text` stays whole. */
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

  public fullText(): string {
    const out: string[] = [];
    for (let i = 0; i < this.lineCount; i++) out.push(`${this.id}-line${i}`);
    return out.join('\n');
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection {
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

/** A clipping ancestor, as ScrollView / VirtualList are. */
class Clip extends Entity {
  constructor(id: string, w: number, h: number) {
    super(id);
    this.width = w;
    this.height = h;
    this.clipChildren = true;
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(): void {}
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

const RESIDENT = {
  contentSemanticMargin: Infinity,
  contentProjectionMargin: VIEW_H,
};

describe('resident semantic tier reachability', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves an off-viewport resident block DISPLAYED, so find-in-page can reach it', () => {
    // The defect: this was `none`, which makes the text unfindable and removes it
    // from the a11y tree — the two things the tier exists to provide.
    const scene = makeScene(RESIDENT);
    const block = new Block('resident', 10);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    const node = el(scene, 'resident')!;
    expect(node.style.display).toBe('');
    // Still the coarse tier: whole text, zero carriers. Reachability must not
    // have been bought by materializing the interaction tier.
    expect(node.children.length).toBe(0);
    expect(node.textContent).toBe(block.fullText());
    scene.destroy();
  });

  it('keeps a resident block displayed as it drifts while staying off-viewport', () => {
    const scene = makeScene(RESIDENT);
    const block = new Block('drifting', 8);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    for (const y of [FAR_OFF_BAND_Y - 500, FAR_OFF_BAND_Y + 250, FAR_OFF_BAND_Y * 2]) {
      block.setPosition(0, y);
      sync(scene);
      const node = el(scene, 'drifting')!;
      expect(node.style.display).toBe('');
      expect(node.children.length).toBe(0);
      expect(node.textContent).toBe(block.fullText());
    }
    scene.destroy();
  });

  it('HIDES a block clipped by an ancestor that still overlaps the viewport', () => {
    // The case that stops this being "coarse means displayed". A block scrolled
    // out of a ScrollView, but geometrically over the canvas, would otherwise put
    // transparent selectable text on top of whatever is really drawn there.
    // Distinguished by whether the block overlaps the VIEWPORT at margin 0, not
    // by the tier.
    const scene = makeScene(RESIDENT);
    const clip = new Clip('clip', 200, 100);
    clip.setPosition(0, 0);
    const inside = new Block('clipped', 4);
    // Below the clip box (y=400 > clip height 100) but well inside the 300px
    // viewport, so the ancestor clip is the only thing rejecting it.
    inside.setPosition(0, 400);
    clip.add(inside);
    scene.add(clip);
    // Height keeps the clip's own box small while the child sits outside it.
    sync(scene);

    const node = el(scene, 'clipped');
    expect(node).toBeDefined();
    expect(node!.style.display).toBe('none');
    scene.destroy();
  });

  it('promotes a resident block to the fine tier, displayed, when it scrolls in', () => {
    const scene = makeScene(RESIDENT);
    const block = new Block('moving', 6);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    expect(el(scene, 'moving')!.style.display).toBe('');
    expect(el(scene, 'moving')!.children.length).toBe(0);

    block.setPosition(0, 0);
    sync(scene);
    const node = el(scene, 'moving')!;
    expect(node.style.display).toBe('');
    expect(node.children.length).toBe(6);

    // Back out: still displayed, carriers withdrawn.
    block.setPosition(0, FAR_OFF_BAND_Y);
    sync(scene);
    expect(el(scene, 'moving')!.style.display).toBe('');
    expect(el(scene, 'moving')!.children.length).toBe(0);
    scene.destroy();
  });

  it('reaches a block just off-viewport, not only ones far away', () => {
    // The non-monotonicity that made the opt-in (rather than `tier === 'coarse'`)
    // the right key. A block inside the interaction margin but outside the exact
    // viewport is FINE-tiered, so keying the exposure on the coarse tier would
    // hide it while exposing blocks further down the document. Find-in-page would
    // skip a band of matches just off-screen and report ones below it.
    const scene = makeScene(RESIDENT);
    const nearOff = new Block('near-off', 3);
    // Below the 300px viewport but inside the VIEW_H interaction margin.
    nearOff.setPosition(0, 400);
    const farOff = new Block('far-off', 3);
    farOff.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(nearOff);
    scene.add(farOff);
    sync(scene);

    expect(el(scene, 'far-off')!.style.display).toBe('');
    expect(el(scene, 'near-off')!.style.display).toBe('');
    scene.destroy();
  });

  it('serves a resident tier whose whole text is reachable across many blocks', () => {
    // The end-to-end shape of the capability: every block's text present AND
    // displayed, carriers only near the viewport.

    const scene = makeScene(RESIDENT);
    const blocks: Block[] = [];
    for (let i = 0; i < 12; i++) {
      const b = new Block(`b${i}`, 3);
      // 3 lines * 20px = 60px tall; stack them so only the first few are in view.
      b.setPosition(0, i * 200);
      scene.add(b);
      blocks.push(b);
    }
    sync(scene);

    let displayed = 0;
    let withCarriers = 0;
    for (const b of blocks) {
      const node = el(scene, b.id)!;
      expect(node.textContent).toBe(b.fullText());
      if (node.style.display !== 'none') displayed++;
      if (node.children.length > 0) withCarriers++;
    }
    // Every block reachable — that is the capability, and it is what element
    // counts alone cannot see.
    expect(displayed).toBe(12);
    // ...but not every block carrying interaction geometry.
    expect(withCarriers).toBeLessThan(12);
    expect(withCarriers).toBeGreaterThan(0);
    scene.destroy();
  });

  it('does not change the DEFAULT configuration: off-band blocks are still released', () => {
    // Purely additive. Without a semantic margin there is no coarse tier at all,
    // so nothing here can regress the default path.
    const scene = makeScene({ contentProjectionMargin: VIEW_H });
    const block = new Block('legacy', 10);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    expect(el(scene, 'legacy')).toBeUndefined();
    scene.destroy();
  });

  it('keeps hiding an off-viewport block under contentProjectionMargin: Infinity', () => {
    // The legacy escape hatch materializes every carrier and is NOT the coarse
    // tier — its blocks are all fine-tiered. Their `display` must keep following
    // the exact viewport test, or an off-screen fully-materialized block would
    // start intercepting input.
    const scene = makeScene({ contentProjectionMargin: Infinity });
    const block = new Block('legacy-inf', 12);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);

    const node = el(scene, 'legacy-inf')!;
    expect(node.children.length).toBe(12);
    expect(node.style.display).toBe('none');
    scene.destroy();
  });

  it('keeps an in-viewport fine block displayed', () => {
    const scene = makeScene(RESIDENT);
    const block = new Block('near', 4);
    block.setPosition(0, 0);
    scene.add(block);
    sync(scene);
    expect(el(scene, 'near')!.style.display).toBe('');
    expect(el(scene, 'near')!.children.length).toBe(4);
    scene.destroy();
  });

  it('still lets a displayed resident block skip an unchanged sync', () => {
    // Reachability must not cost the dirty-track skip that makes the tier
    // affordable. `display` is written from state already in the key.
    const scene = makeScene(RESIDENT);
    const block = new Block('skip', 8);
    block.setPosition(0, FAR_OFF_BAND_Y);
    scene.add(block);
    sync(scene);
    const node = el(scene, 'skip')!;
    expect(node.style.display).toBe('');

    // Mutating display externally proves the skip really skipped: a full sync
    // would rewrite it.
    // Must be a VALID display value: the CSSOM silently drops an invalid one,
    // leaving '' — which is what a full sync writes anyway, so the assertion
    // would pass without proving anything.
    node.style.display = 'inline-block';
    sync(scene);
    sync(scene);
    expect(node.style.display).toBe('inline-block');
    scene.destroy();
  });
});
