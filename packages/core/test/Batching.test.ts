// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { CanvasRenderer } from '../src/renderer/CanvasRenderer';
import { Scene, Entity, type IRenderer } from '../src/index';

// jsdom doesn't implement canvas getContext; the shared font measurer takes its
// portable null-fallback silently. Per-canvas getContext overrides still win.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** A 2D context that records draw ops (with fill style/alpha snapshots) in order. */
function recorderCtx() {
  const calls: { op: string; style?: string; alpha?: number }[] = [];
  let fillStyle = '';
  let alpha = 1;
  const ctx = {
    scale: vi.fn(),
    clearRect: () => calls.push({ op: 'clearRect' }),
    save: () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: () => calls.push({ op: 'beginPath' }),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: () => calls.push({ op: 'arc' }),
    roundRect: vi.fn(),
    drawImage: () => calls.push({ op: 'drawImage' }),
    fill: () => calls.push({ op: 'fill', style: fillStyle, alpha }),
    stroke: () => calls.push({ op: 'stroke', style: fillStyle }),
    fillText: () => calls.push({ op: 'fillText', style: fillStyle }),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set font(_v: string) {},
    canvas: null as unknown,
  };
  const canvas = {
    getContext: () => ctx,
    width: 0,
    height: 0,
    style: { width: '', height: '' },
  };
  ctx.canvas = canvas;
  return { ctx, canvas, calls };
}

function setWindow() {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

describe('CanvasRenderer — order-preserving batched circle fills', () => {
  it('coalesces consecutive same-style circles into one beginPath + N arc + one fill', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const r = new CanvasRenderer(canvas as never);

    r.fillCircle(0, 0, 5, '#f00');
    r.fillCircle(20, 0, 5, '#f00');
    r.fillCircle(40, 0, 5, '#f00');
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(0); // not flushed yet
    r.flush();

    expect(calls.filter((c) => c.op === 'beginPath')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(3);
    const fills = calls.filter((c) => c.op === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].style).toBe('#f00');
  });

  it('flushes the current run when the color changes (preserves order)', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const r = new CanvasRenderer(canvas as never);

    r.fillCircle(0, 0, 5, '#f00');
    r.fillCircle(10, 0, 5, '#00f'); // color change → flush red run first
    r.flush();

    const fills = calls.filter((c) => c.op === 'fill');
    expect(fills.map((f) => f.style)).toEqual(['#f00', '#00f']);
    expect(calls.filter((c) => c.op === 'beginPath')).toHaveLength(2);
  });

  it('a normal fill/stroke/text flushes any pending batch first', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const r = new CanvasRenderer(canvas as never);

    r.fillCircle(0, 0, 5, '#f00');
    r.beginPath();
    r.arc(50, 50, 8, 0, Math.PI * 2);
    r.fill('#0f0');

    const fills = calls.filter((c) => c.op === 'fill');
    expect(fills.map((f) => f.style)).toEqual(['#f00', '#0f0']); // batch committed before the normal fill
  });

  it('caps the batch so a huge same-color run splits into multiple fills', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const r = new CanvasRenderer(canvas as never);

    const cap = CanvasRenderer.MAX_BATCH;
    for (let i = 0; i < cap + 1; i++) r.fillCircle(i, 0, 1, '#f00');
    r.flush();

    // One fill committed at the cap, one for the +1 remainder on flush.
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(2);
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(cap + 1);
  });

  it('carries per-batch alpha and resets globalAlpha after flush', () => {
    setWindow();
    const { ctx, canvas, calls } = recorderCtx();
    const r = new CanvasRenderer(canvas as never);

    r.fillCircle(0, 0, 5, '#f00', 0.5);
    r.flush();
    const fill = calls.find((c) => c.op === 'fill')!;
    expect(fill.alpha).toBe(0.5);
    expect(ctx.globalAlpha).toBe(1); // reset after flush
  });
});

describe('Scene — batch fast-path for getBatchCircle() leaf entities', () => {
  class BatchDot extends Entity {
    color: string;
    constructor(id: string, color: string) {
      super(id);
      this.color = color;
    }
    isPointInside() {
      return false;
    }
    getBatchCircle() {
      return { radius: 3, color: this.color };
    }
    render() {
      throw new Error('fast-path entity render() must not be called');
    }
  }

  function sceneWith(canvas: unknown) {
    const scene = new Scene(canvas as never);
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
    (scene as unknown as { isRunning: boolean }).isRunning = true;
    return scene;
  }
  function tick(scene: Scene) {
    (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
  }

  it('batches same-color dots into one fill and skips per-entity save/restore + render()', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const scene = sceneWith(canvas);
    scene.add(new BatchDot('a', '#38bdf8').setPosition(10, 10));
    scene.add(new BatchDot('b', '#38bdf8').setPosition(30, 10));
    scene.add(new BatchDot('c', '#38bdf8').setPosition(50, 10));

    tick(scene); // BatchDot.render() throws if the fast-path is bypassed

    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(3);
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1); // one fill for all 3 dots
    // Only the root's save/restore — none per dot.
    expect(calls.filter((c) => c.op === 'save')).toHaveLength(1);
  });

  it('preserves z-order: a normal entity between dots splits the batch', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const scene = sceneWith(canvas);

    class Label extends Entity {
      isPointInside() {
        return false;
      }
      render(r: IRenderer) {
        r.fillText('X', 0, 0, '10px monospace', '#fff');
      }
    }

    scene.add(new BatchDot('a', '#38bdf8').setPosition(10, 10));
    scene.add(new Label('lbl').setPosition(20, 20));
    scene.add(new BatchDot('b', '#38bdf8').setPosition(30, 10));

    tick(scene);

    const ops = calls.filter((c) => c.op === 'fill' || c.op === 'fillText').map((c) => c.op);
    expect(ops).toEqual(['fill', 'fillText', 'fill']); // dot batch, label, dot batch — in order
  });

  it('multiplies a batched leaf opacity by every ancestor opacity', () => {
    setWindow();
    const { canvas, calls } = recorderCtx();
    const scene = sceneWith(canvas);
    const parent = new (class extends Entity {
      isPointInside() {
        return false;
      }
      render() {}
    })('parent');
    parent.opacity = 0.5;
    const dot = new BatchDot('dot', '#38bdf8');
    dot.opacity = 0.4;
    parent.add(dot);
    scene.add(parent);

    tick(scene);

    const fills = calls.filter((call) => call.op === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].alpha).toBeCloseTo(0.2);
  });
});
