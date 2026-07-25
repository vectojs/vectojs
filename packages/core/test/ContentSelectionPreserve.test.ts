// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { Scene, Entity } from '../src';

// jsdom has no 2D canvas backend; stub getContext so Scene.render's clear()
// doesn't crash. We only care about the a11y/content-projection DOM here.
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
});

// A content entity whose selectable projection lines grow as tokens "stream" in.
class StreamingContent extends Entity {
  public text: string;
  constructor(id: string, text: string) {
    super(id);
    this.text = text;
    this.width = 400;
    this.height = 40;
  }
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
  override getContentProjection() {
    return {
      text: this.text,
      font: '16px sans-serif',
      selectable: true,
      lines: [{ text: this.text, x: 0, y: 0, baseline: 14, lineHeight: 20 }],
    };
  }
}

function makeScene(): Scene {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  return scene;
}

const tick = (scene: Scene) => {
  (scene as any).loop(0);
};

describe('content selection preservation across streaming rebuild', () => {
  it('keeps a selection made in the unchanged prefix when new tokens stream in', () => {
    const scene = makeScene();
    const e = new StreamingContent('stream', 'Hello world');
    scene.add(e);
    tick(scene);

    const el = scene.getContentElement('stream')!;
    const textNode = el.querySelector('span')!.firstChild as Text;
    expect(textNode.data).toBe('Hello world');

    // Select "Hello" (0..5) in the prefix.
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(textNode, 0, textNode, 5);
    expect(selection.toString()).toBe('Hello');

    // Stream a chunk → projection signature changes → DOM rebuilds.
    e.text = 'Hello world and then some more tokens';
    scene.markDirty();
    tick(scene);

    // Selection survived, still the same logical prefix.
    expect(selection.rangeCount).toBe(1);
    expect(selection.toString()).toBe('Hello');
    scene.destroy();
  });

  it('preserves a selection spanning into text that stays present', () => {
    const scene = makeScene();
    const e = new StreamingContent('s2', 'abcdef');
    scene.add(e);
    tick(scene);
    const el = scene.getContentElement('s2')!;
    const node = el.querySelector('span')!.firstChild as Text;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(node, 1, node, 4); // "bcd"
    expect(selection.toString()).toBe('bcd');

    e.text = 'abcdefghij'; // append only
    scene.markDirty();
    tick(scene);

    expect(selection.toString()).toBe('bcd');
    scene.destroy();
  });

  it('drops the selection when its range extended into removed (rewritten) text', () => {
    const scene = makeScene();
    const e = new StreamingContent('s3', 'keep this tail');
    scene.add(e);
    tick(scene);
    const el = scene.getContentElement('s3')!;
    const node = el.querySelector('span')!.firstChild as Text;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(node, 5, node, 14); // "this tail"
    expect(selection.toString()).toBe('this tail');

    e.text = 'keep'; // shrink below the selection offsets
    scene.markDirty();
    tick(scene);

    // Offsets ran past the new text → cleared, not restored onto wrong glyphs.
    expect(selection.rangeCount).toBe(0);
    scene.destroy();
  });

  it('does not touch a selection owned by a different element', () => {
    const scene = makeScene();
    const a = new StreamingContent('a', 'first block');
    const b = new StreamingContent('b', 'second block');
    scene.add(a);
    scene.add(b);
    tick(scene);

    const bEl = scene.getContentElement('b')!;
    const bNode = bEl.querySelector('span')!.firstChild as Text;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(bNode, 0, bNode, 6); // "second" in block B
    expect(selection.toString()).toBe('second');

    // Block A rebuilds; B's selection must be untouched.
    a.text = 'first block grew longer';
    scene.markDirty();
    tick(scene);

    expect(selection.toString()).toBe('second');
    scene.destroy();
  });
});
