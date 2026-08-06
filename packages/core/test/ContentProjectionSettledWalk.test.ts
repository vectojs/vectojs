// @vitest-environment jsdom
/**
 * The settled-walk fast path (vectojs#350, CTX-0222).
 *
 * `syncContentProjection` early-returns for an unchanged block, but only AFTER
 * paying `getWorldTransform()` and up to three `projectionBoxVisible()` calls —
 * each an O(ancestor-depth) ancestor walk. On a settled resident-tier document
 * that is the entire remaining per-frame cost: measured 3.0-3.2 ms at 10 000
 * blocks, 72% of a 4.16 ms frame at 240 Hz, paid forever on a document where
 * nothing changes (CTX-0203, PX-0401).
 *
 * The fix hoists a cheap gate above that work. A child's world transform is its
 * own local transform composed with its parent's world transform, so if BOTH are
 * unchanged the world transform is unchanged by construction — and then so are
 * the tier, the line band and the visibility flag that the existing dirty-track
 * comparison derives from it. That makes the box tests provably redundant rather
 * than merely usually-redundant.
 *
 * These tests assert CALL COUNTS on `projectionBoxVisible`, because the failure
 * mode is silent in both directions: too many calls is only slow, but too few
 * means a block that moved or changed kept stale DOM — stale text in the
 * accessibility tree and in find-in-page, with nothing to ever correct it.
 */
import { describe, expect, it } from 'vitest';
import type { ContentProjection, ContentProjectionHint } from '../src/tree/Entity';
import { Entity } from '../src/tree/Entity';
import { Scene } from '../src/tree/Scene';

const VIEW_W = 400;
const VIEW_H = 300;
const LINE_H = 20;
const LINES = 4;
const PITCH = LINES * LINE_H + 14;

/** Mirrors the real entities: `lines` narrows to the band, `text` stays whole. */
class Block extends Entity {
  public epoch = 1;
  public projectionCalls = 0;

  constructor(id: string) {
    super(id);
    this.width = 200;
    this.height = LINES * LINE_H;
  }

  public override isPointInside(): boolean {
    return false;
  }

  public override render(): void {}

  public override getContentEpoch(): number {
    return this.epoch;
  }

  public setText(): void {
    this.epoch++;
  }

  public override getContentProjection(hint?: ContentProjectionHint): ContentProjection {
    this.projectionCalls++;
    const lines: NonNullable<ContentProjection['lines']> = [];
    for (let i = 0; i < LINES; i++) {
      const y = i * LINE_H;
      if (hint?.minY !== undefined && hint.maxY !== undefined) {
        if (!(y + LINE_H >= hint.minY && y <= hint.maxY)) continue;
      }
      lines.push({
        text: `${this.id}-l${i}-e${this.epoch}`,
        x: 0,
        y,
        width: 200,
        height: LINE_H,
      });
    }
    return {
      text: `${this.id}-full-e${this.epoch}`,
      lineHeight: LINE_H,
      selectable: true,
      lines,
    };
  }
}

interface Harness {
  scene: Scene;
  canvas: HTMLCanvasElement;
  blocks: Block[];
  /** Run one sync, returning how many `projectionBoxVisible` calls it made. */
  syncCountingBoxTests(): number;
  sync(): void;
  /**
   * This scene's own projection element for `id`.
   *
   * Scoped to the scene's `a11yRoot` rather than `document`, because `destroy()`
   * does NOT remove that root — so every scene built in this file leaves its
   * elements in the shared jsdom document, and a document-wide query returns the
   * FIRST test's stale element instead of this one's. That cost real debugging
   * time: four assertions failed against an already-destroyed scene's DOM while
   * the engine was behaving correctly.
   */
  contentEl(id: string): HTMLElement | null;
  destroy(): void;
}

/** The gallery's shipped config: resident semantic tier, finite carrier margin. */
function build(count: number): Harness {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.body.appendChild(canvas);
  const scene = new Scene(canvas, {
    contentProjectionMargin: VIEW_H,
    contentSemanticMargin: Number.POSITIVE_INFINITY,
    contentSemanticBudget: Number.POSITIVE_INFINITY,
    disableWindowResize: true,
  });
  const docH = count * PITCH;
  const scrollY = Math.max(0, docH / 2 - VIEW_H / 2);
  const blocks: Block[] = [];
  for (let i = 0; i < count; i++) {
    const b = new Block(`b${i}`);
    b.setPosition(20, i * PITCH - scrollY);
    scene.add(b);
    blocks.push(b);
  }

  const s = scene as unknown as {
    syncA11y: (n: Entity) => void;
    root: Entity;
    projectionBoxVisible: (...a: never[]) => boolean;
    a11yRoot: HTMLElement | null;
  };
  const sync = () => s.syncA11y(s.root);
  // Drain to a fully settled state.
  for (let i = 0; i < 40; i++) sync();

  return {
    scene,
    canvas,
    blocks,
    sync,
    syncCountingBoxTests(): number {
      let calls = 0;
      const orig = s.projectionBoxVisible;
      s.projectionBoxVisible = function (...args: never[]) {
        calls++;
        return orig.apply(this, args);
      } as never;
      sync();
      s.projectionBoxVisible = orig;
      return calls;
    },
    contentEl(id: string): HTMLElement | null {
      return s.a11yRoot?.querySelector<HTMLElement>(`[data-vecto-content="${id}"]`) ?? null;
    },
    destroy() {
      scene.destroy();
      canvas.remove();
      // Drop the a11y root too: `Scene.destroy()` leaves it attached, so without
      // this each test leaks its projection elements into the next one's queries.
      s.a11yRoot?.remove();
    },
  };
}

describe('settled-walk fast path', () => {
  it('costs no box tests per block once the document is settled', () => {
    const h = build(400);
    // Every block is unchanged and unmoved, so no block needs a box test.
    // Before the fix this is ~2 per block (~800): the semantic gate never fires
    // in the resident tier, so each block pays the interaction-band test and the
    // exact visibility test before the dirty-track early-return.
    expect(h.syncCountingBoxTests()).toBeLessThan(h.blocks.length / 10);
    h.destroy();
  });

  it('still re-syncs a block whose content changes while off-viewport', () => {
    const h = build(400);
    // b3 is far above the viewport (the doc is scrolled to its middle) and is
    // therefore coarse+resident: one text node carrying its whole text. If the
    // fast path skipped it on position alone, this edit would never reach the
    // DOM and find-in-page would report the old text forever.
    const before = h.contentEl('b3')?.textContent ?? null;
    expect(before).toContain('e1');
    h.blocks[3].setText();
    h.sync();
    expect(h.contentEl('b3')?.textContent).toContain('e2');
    h.destroy();
  });

  it('still re-places a block that moves while its content is unchanged', () => {
    const h = build(400);
    const el = () => h.contentEl('b5');
    const topBefore = el()?.style.top;
    h.blocks[5].y += 37;
    h.sync();
    expect(el()?.style.top).not.toBe(topBefore);
    h.destroy();
  });

  it('still re-syncs every block when the whole document scrolls', () => {
    const h = build(400);
    // Move the root, not the blocks: each child's local transform is untouched,
    // so a gate that only compared the child's own transform would wrongly skip
    // all of them. The parent's transform is the other half of the key.
    const root = (h.scene as unknown as { root: Entity }).root;
    const b0Top = h.contentEl('b0')?.style.top;
    root.y -= 500;
    h.sync();
    expect(h.contentEl('b0')?.style.top).not.toBe(b0Top);
    h.destroy();
  });

  it('promotes a block to the fine tier when it scrolls into the interaction band', () => {
    const h = build(400);
    // A coarse block has NO per-line carriers; a fine one does. Scrolling the
    // document must therefore rebuild carriers for newly-in-band blocks, which a
    // position-blind skip would not do.
    const carriersOf = (id: string) => h.contentEl(id)?.children.length ?? 0;
    expect(carriersOf('b0')).toBe(0);
    const root = (h.scene as unknown as { root: Entity }).root;
    // Bring b0 to the viewport: it sits at -scrollY, so undo that.
    root.y += (400 * PITCH) / 2 - VIEW_H / 2;
    h.sync();
    expect(carriersOf('b0')).toBeGreaterThan(0);
    h.destroy();
  });

  it('re-syncs a block that changes box without moving', () => {
    const h = build(400);
    // A re-wrapped block keeps its position but changes height, which changes
    // both its tier and its band. Nothing in the transform half of the fast
    // path's key can see that, so the box fields carry it.
    const el = () => h.contentEl('b7');
    const heightBefore = el()?.style.height;
    h.blocks[7].height += 40;
    h.sync();
    expect(el()?.style.height).not.toBe(heightBefore);
    h.destroy();
  });

  it.each([
    ['x', (b: Block) => (b.x += 23), (el: HTMLElement) => el.style.left],
    ['scaleX', (b: Block) => (b.scaleX = 1.5), (el: HTMLElement) => el.style.transform],
    ['scaleY', (b: Block) => (b.scaleY = 1.5), (el: HTMLElement) => el.style.transform],
    ['rotation', (b: Block) => (b.rotation = 0.3), (el: HTMLElement) => el.style.transform],
    ['width', (b: Block) => (b.width += 30), (el: HTMLElement) => el.style.width],
  ])('re-syncs a block whose %s changes', (_name, mutate, read) => {
    const h = build(400);
    // Each of these is one field of the fast path's key. Asserted individually
    // rather than as one "geometry changed" case, because a missing field is
    // silent: the block simply keeps DOM describing where it used to be, and
    // only the field that was dropped is affected.
    const el = () => h.contentEl('b11');
    const before = read(el()!);
    mutate(h.blocks[11]);
    h.sync();
    expect(read(el()!)).not.toBe(before);
    h.destroy();
  });

  it('re-syncs a block whose interactive flag flips', () => {
    const h = build(400);
    // Drives `aria-hidden` on the text copy: a block that becomes interactive
    // must stop being announced as static text.
    const el = () => h.contentEl('b9');
    const ariaBefore = el()?.getAttribute('aria-hidden');
    h.blocks[9].interactive = true;
    h.sync();
    expect(el()?.getAttribute('aria-hidden')).not.toBe(ariaBefore);
    h.destroy();
  });

  it('re-syncs every block after the scene is resized', () => {
    const h = build(400);
    // A resize re-tiers blocks without moving any of them — invisible to both
    // transforms in the fast path's key. `contentViewportEpoch` carries it.
    for (const b of h.blocks) b.projectionCalls = 0;
    h.scene.resize(VIEW_W, VIEW_H * 2);
    h.sync();
    const rebuilt = h.blocks.filter((b) => b.projectionCalls > 0).length;
    expect(rebuilt).toBe(h.blocks.length);
    h.destroy();
  });

  it('disableSettledFastPath restores the unpruned walk', () => {
    // The benchmark's control arm depends on this flag actually doing something.
    // Without this test, a typo would leave both arms measuring the fast path and
    // report a speedup of 1.0x — or worse, a plausible-looking number.
    const h = build(400);
    const s = h.scene as unknown as { disableSettledFastPath: boolean };
    const withFastPath = h.syncCountingBoxTests();
    s.disableSettledFastPath = true;
    const without = h.syncCountingBoxTests();
    expect(withFastPath).toBeLessThan(h.blocks.length / 10);
    expect(without).toBeGreaterThan(h.blocks.length);
    h.destroy();
  });

  it('re-syncs every block when the font epoch changes', () => {
    const h = build(400);
    for (const b of h.blocks) b.projectionCalls = 0;
    // A webfont finishing load bumps contentFontEpoch without moving anything.
    (h.scene as unknown as { contentFontEpoch: number }).contentFontEpoch++;
    h.sync();
    const rebuilt = h.blocks.filter((b) => b.projectionCalls > 0).length;
    expect(rebuilt).toBe(h.blocks.length);
    h.destroy();
  });
});
