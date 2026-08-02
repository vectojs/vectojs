// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Scene } from '../src/tree/Scene';
import { Entity } from '../src/tree/Entity';
import type { A11yAttributes, IRenderer, ScrollEventPayload } from '../src/tree/Entity';

/** A no-op-everything 2D context so the render loop runs headless. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'measureText') return (t: string) => ({ width: t.length * 8 });
        if (prop === 'canvas') return { width: 0, height: 0, style: {} };
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function makeScene(): {
  scene: Scene;
  root: HTMLElement;
  tick: (n?: number) => void;
} {
  const ctx = fakeCtx();
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const scene = new Scene(canvas);
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) (scene as unknown as { loop: (t: number) => void }).loop(i * 16);
  };
  return { scene, root: host, tick };
}

/** A minimal entity that projects a `<textarea>` mirror with editor typography. */
class Editor extends Entity {
  public scrolls: ScrollEventPayload[] = [];

  constructor() {
    super();
    this.width = 200;
    this.height = 80;
    this.interactive = true;
    this.on('scroll', (e: ScrollEventPayload) => {
      this.scrolls.push(e);
    });
  }

  public isPointInside(): boolean {
    return true;
  }

  public render(_r: IRenderer): void {}

  public getA11yAttributes(): A11yAttributes {
    return {
      tag: 'textarea',
      value: 'x',
      textInputStyle: { font: '14px monospace', lineHeight: 19.6, padding: 12 },
    };
  }
}

describe('text-input mirror scroll projection', () => {
  it("forwards the mirror's scroll offset to its entity", () => {
    const { scene, root, tick } = makeScene();
    const editor = new Editor();
    scene.add(editor);
    tick();
    const mirror = root.querySelector('textarea') as HTMLTextAreaElement;
    editor.scrolls.length = 0;

    mirror.scrollTop = 111;
    mirror.scrollLeft = 7;
    mirror.dispatchEvent(new Event('scroll'));

    expect(editor.scrolls.at(-1)).toMatchObject({
      scrollTop: 111,
      scrollLeft: 7,
    });
  });

  it("reports the mirror's initial scroll box once its geometry is written", () => {
    // Emitted at creation so an entity that paints scrollable content agrees
    // with its mirror on the first frame rather than from the first gesture —
    // and emitted *after* geometry, or `clientHeight` would still be 0.
    const { scene, tick } = makeScene();
    const editor = new Editor();
    scene.add(editor);
    tick();

    const first = editor.scrolls[0];
    expect(first).toBeDefined();
    expect(first.scrollTop).toBe(0);
    expect(first).toHaveProperty('clientHeight');
    expect(first).toHaveProperty('scrollHeight');
  });

  it("suppresses the mirror's scrollbar so it wraps text where the canvas does", () => {
    // A classic scrollbar (Firefox/Linux, measured 12px) takes its width out of
    // the content box, so the element wraps narrower than the canvas and a click
    // returns an offset for a line the canvas never drew there.
    const { scene, root, tick } = makeScene();
    scene.add(new Editor());
    tick();
    const mirror = root.querySelector('textarea') as HTMLTextAreaElement;

    expect(mirror.style.scrollbarWidth).toBe('none');
  });
});
