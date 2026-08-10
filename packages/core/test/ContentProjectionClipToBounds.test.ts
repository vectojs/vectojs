// @vitest-environment jsdom
/**
 * `ContentProjection.clipToBounds` — the DOM half of an entity that clips its
 * own canvas drawing.
 *
 * The projection element is deliberately UNCLIPPED (`Scene.ts` sets no
 * `overflow` when it creates it) so a drag can start in an entity's padding or
 * blank regions and extend past its bounds. That default is load-bearing and is
 * not up for renegotiation here.
 *
 * But an entity whose `render()` clips — a horizontally scrollable code block is
 * the shipped case — then disagrees with its own DOM copy: the canvas stops at
 * the box while the transparent carriers keep going, so selecting a long line
 * paints browser highlight across whatever is drawn beside the block. Measured
 * on a live blog post at `innerWidth` 1566: a carrier extended to x=1580 from a
 * code block far narrower than that.
 *
 * So the clip is opt-in per projection, and these tests pin both halves: it is
 * applied when asked for, and it is absent when not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;

/**
 * An entity whose projected content is WIDER than its own box, i.e. the shape
 * that makes the clip observable at all.
 */
class OverflowingText extends Entity {
  public clip: boolean | undefined;
  /** Local origin of the text inside the entity, as a code block's padding is. */
  public inset = 0;
  /** Bumped by the test when it changes something a re-sync must observe. */
  public epoch = 1;

  constructor(id: string, clip: boolean | undefined) {
    super(id);
    this.width = 120;
    this.height = 40;
    this.clip = clip;
  }

  isPointInside(): boolean {
    return false;
  }

  render(): void {}

  override getContentEpoch(): number {
    return this.epoch;
  }

  override getContentProjection() {
    return {
      // Far wider than `width: 120`, so an unclipped copy visibly overhangs.
      text: 'a very long single line of content that overhangs the box by a lot',
      font: '16px monospace',
      lineHeight: 20,
      selectable: true,
      contentX: this.inset,
      contentY: this.inset,
      clipToBounds: this.clip,
    };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

function sync(scene: Scene): void {
  const s = scene as unknown as { syncA11y: (r: unknown) => void; root: unknown };
  s.syncA11y(s.root);
}

describe('ContentProjection.clipToBounds', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('writes no clip by default, so selection can still leave the box', () => {
    const scene = makeScene();
    const e = new OverflowingText('plain', undefined);
    scene.add(e);
    sync(scene);

    const el = scene.getContentElement('plain')!;
    // The property is what the default rests on: any value here would also
    // clip padding-region drag starts, which `Scene` documents it must not.
    expect(el.style.clipPath).toBe('');
    scene.destroy();
  });

  it('clips to the entity box when the projection opts in', () => {
    const scene = makeScene();
    const e = new OverflowingText('clipped', true);
    scene.add(e);
    sync(scene);

    const el = scene.getContentElement('clipped')!;
    // `inset()` in the element's OWN box, not the viewport: a `rect()` in
    // viewport coordinates would need rewriting on every scroll frame. With no
    // content inset the element box already is the entity box, so every side is
    // zero — the clip still matters, because the CARRIERS inside overflow it.
    expect(el.style.clipPath).toBe('inset(0px 0px 0px 0px)');
    scene.destroy();
  });

  it('offsets the clip by the content inset so the box stays over the entity', () => {
    const scene = makeScene();
    const e = new OverflowingText('inset', true);
    // A code block's padding: the element sits at +18,+18 inside the entity, so
    // the clip must start 18px ABOVE and LEFT of the element to land on the
    // entity's own edge rather than 18px inside it.
    e.inset = 18;
    scene.add(e);
    sync(scene);

    const el = scene.getContentElement('inset')!;
    // `inset()` is `top right bottom left`. The element sits 18px inside the
    // entity, so top/left expand OUTWARD by 18 (negative) to reach the entity's
    // edge, and right/bottom pull INWARD by 18 because the element box is the
    // entity's size but shifted — its far edges overhang by exactly the inset.
    expect(el.style.clipPath).toBe('inset(-18px 18px 18px -18px)');
    scene.destroy();
  });

  it('tracks a resized box through the element, not through a rewritten clip', () => {
    const scene = makeScene();
    const e = new OverflowingText('resize', true);
    scene.add(e);
    sync(scene);
    const el = scene.getContentElement('resize')!;
    expect(el.style.width).toBe('120px');
    const first = el.style.clipPath;

    // The code-block case reaches a narrower box through `setWidth()`, which is
    // contractually forbidden from rebuilding the grid — so the clip must not
    // need rebuilding either. Because it is stated relative to the element's own
    // border box, and that box is written from `node.width`/`node.height` every
    // sync, the effective clip shrinks while the STRING stays put.
    e.width = 60;
    e.epoch = 2;
    sync(scene);
    expect(el.style.width).toBe('60px');
    expect(el.style.clipPath).toBe(first);
    scene.destroy();
  });

  it('drops the clip when the projection stops asking for it', () => {
    const scene = makeScene();
    const e = new OverflowingText('toggle', true);
    scene.add(e);
    sync(scene);
    const el = scene.getContentElement('toggle')!;
    expect(el.style.clipPath).not.toBe('');

    // A block that scrolls back to a fitting width stops opting in, and the
    // element is POOLED — a stale clip would keep cropping text that no longer
    // overflows.
    e.clip = undefined;
    e.width = 400;
    sync(scene);
    expect(el.style.clipPath).toBe('');
    scene.destroy();
  });
});
