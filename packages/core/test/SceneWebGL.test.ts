// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene, Entity } from '../src/index';

HTMLCanvasElement.prototype.getContext = (() => null) as never;

/** Recording 2D context (captures arc/fill so we can assert the 2D fallback path). */
function recorderCtx() {
  const calls: string[] = [];
  const rec = (op: string) => () => calls.push(op);
  return {
    calls,
    scale: rec('scale'),
    clearRect: rec('clearRect'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    arc: rec('arc'),
    fill: rec('fill'),
    fillText: rec('fillText'),
    stroke: rec('stroke'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    closePath: rec('closePath'),
    roundRect: rec('roundRect'),
    drawImage: rec('drawImage'),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    set globalAlpha(_v: number) {},
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set font(_v: string) {},
    canvas: null as unknown,
  };
}

/** Mock WebGL2 context capturing the last uploaded point buffer + draw count. */
function mockGL() {
  const captures = {
    buffer: null as Float32Array | null,
    rectBuffer: null as Float32Array | null,
    drawCount: -1,
    rectInstances: -1,
  };
  let loc = 0;
  return {
    captures,
    gl: {
      ARRAY_BUFFER: 1,
      DYNAMIC_DRAW: 2,
      FLOAT: 3,
      POINTS: 4,
      COLOR_BUFFER_BIT: 5,
      BLEND: 6,
      SRC_ALPHA: 7,
      ONE_MINUS_SRC_ALPHA: 8,
      VERTEX_SHADER: 9,
      FRAGMENT_SHADER: 10,
      COMPILE_STATUS: 11,
      LINK_STATUS: 12,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      deleteShader: () => {},
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      deleteProgram: () => {},
      useProgram: () => {},
      getAttribLocation: () => loc++,
      getUniformLocation: () => ({}),
      createBuffer: () => ({}),
      deleteBuffer: () => {},
      createVertexArray: () => ({}),
      bindVertexArray: () => {},
      deleteVertexArray: () => {},
      vertexAttribDivisor: () => {},
      TRIANGLE_STRIP: 13,
      STATIC_DRAW: 14,
      TRIANGLES: 15,
      bindBuffer: () => {},
      bufferData: (_t: number, data: Float32Array) => {
        lastUpload = data.slice();
      },
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      uniform2f: () => {},
      uniform1f: () => {},
      enable: () => {},
      blendFunc: () => {},
      viewport: () => {},
      clearColor: () => {},
      clear: () => {},
      drawArrays: (mode: number, _f: number, count: number) => {
        if (mode === 4) {
          // POINTS = circles
          captures.drawCount = count;
          captures.buffer = lastUpload;
        } else {
          // TRIANGLES = rects (6 verts/rect)
          captures.rectInstances = count / 6;
          captures.rectBuffer = lastUpload;
        }
      },
    },
  };
}
let lastUpload: Float32Array | null = null;

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
    throw new Error('batch entity render() must not run');
  }
}
class Group extends Entity {
  isPointInside() {
    return false;
  }
  render() {}
}
class BatchBox extends Entity {
  isPointInside() {
    return false;
  }
  getBatchRect() {
    return { width: 20, height: 10, color: '#00ff00' };
  }
  render() {
    throw new Error('batch rect render() must not run on the GL backend');
  }
}

class FallbackDot extends Entity {
  isPointInside() {
    return false;
  }
  getBatchCircle() {
    return { radius: 3, color: '#ff0000' };
  }
  render(renderer: import('../src').IRenderer) {
    renderer.beginPath();
    renderer.arc(0, 0, 3, 0, Math.PI * 2);
    renderer.fill('#ff0000');
  }
}

let restoreCreate: (() => void) | null = null;
function makeScene(glOrNull: unknown) {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;

  const realCreate = document.createElement.bind(document);
  const parent = realCreate('div');
  const twoD = realCreate('canvas');
  parent.appendChild(twoD);
  const ctx = recorderCtx();
  ctx.canvas = twoD;
  (twoD as HTMLCanvasElement).getContext = (() => ctx) as never;

  // The GL canvas is created internally via document.createElement('canvas').
  const glCanvas = realCreate('canvas');
  (glCanvas as HTMLCanvasElement).getContext = (() => glOrNull) as never;
  const spy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tag: string) =>
      tag === 'canvas' ? glCanvas : realCreate(tag)) as never);
  restoreCreate = () => spy.mockRestore();

  const scene = new Scene(twoD, { pointBackend: 'webgl' });
  (scene as unknown as { isRunning: boolean }).isRunning = true;
  const tick = () => (scene as unknown as { loop: (t: number) => void }).loop(performance.now());
  return { scene, ctx, tick };
}

afterEach(() => {
  restoreCreate?.();
  restoreCreate = null;
});

describe('Scene — WebGL point backend', () => {
  it('collects batch circles into the GL renderer in world coords and skips the 2D path', () => {
    const { gl, captures } = mockGL();
    const { scene, ctx, tick } = makeScene(gl);

    scene.add(new BatchDot('a', '#ff0000').setPosition(10, 10));
    const parent = new Group('p');
    parent.setPosition(100, 50);
    parent.scaleX = 2;
    parent.scaleY = 2;
    parent.add(new BatchDot('b', '#ff0000').setPosition(10, 10));
    scene.add(parent);

    tick();

    expect(captures.drawCount).toBe(2);
    const buf = captures.buffer!;
    // dot a: world (10,10), r=3 ; dot b: world (120,70), r=6 (parent scale 2)
    expect(Array.from(buf.slice(0, 3))).toEqual([10, 10, 3]);
    expect(Array.from(buf.slice(7, 10))).toEqual([120, 70, 6]);
    // batch entities did NOT touch the 2D arc/fill path
    expect(ctx.calls).not.toContain('arc');
    expect(ctx.calls.filter((c) => c === 'fill')).toHaveLength(0);
  });

  it('collects getBatchRect() entities into the GL instanced-rect draw (world coords)', () => {
    const { gl, captures } = mockGL();
    const { scene, ctx, tick } = makeScene(gl);

    scene.add(new BatchBox('r').setPosition(40, 50));

    tick();

    expect(captures.rectInstances).toBe(1);
    const buf = captures.rectBuffer!;
    // Triangle batch: first vertex = top-left corner (40,50); third = bottom-right (60,60).
    expect(Array.from(buf.slice(0, 2))).toEqual([40, 50]);
    expect(Array.from(buf.slice(12, 14))).toEqual([60, 60]); // 40+20, 50+10
    expect(ctx.calls).not.toContain('arc');
  });

  it('falls back to the Canvas2D batch when WebGL2 is unavailable', () => {
    const { scene, ctx, tick } = makeScene(null); // getContext('webgl2') → null

    scene.add(new BatchDot('a', '#ff0000').setPosition(10, 10));
    tick();

    // No GL → the dot is drawn through the Canvas2D batch (arc + fill).
    expect(ctx.calls).toContain('arc');
    expect(ctx.calls).toContain('fill');
  });

  it('falls back to Canvas2D when an ancestor transform is not uniform', () => {
    const { gl, captures } = mockGL();
    const { scene, ctx, tick } = makeScene(gl);
    const parent = new Group('non-uniform-parent');
    parent.scaleX = 2;
    parent.scaleY = 1;
    parent.add(new FallbackDot('ellipse'));
    scene.add(parent);

    tick();

    expect(captures.drawCount).toBe(-1);
    expect(ctx.calls).toContain('arc');
    expect(ctx.calls).toContain('fill');
  });

  it('maxDPR is threaded to the WebGL point layer at construction (findings.md, 2026-07-16)', () => {
    // makeScene() fixes devicePixelRatio to 1, so this test asserts the
    // Scene->pointRenderer plumbing (the option arrives and is stored)
    // rather than the resulting pixel math — that math is already covered
    // end-to-end (with a real DPR>maxDPR gap) in WebGLPointRenderer.test.ts.
    const { gl } = mockGL();
    (globalThis as { window?: unknown }).window = {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;

    const realCreate = document.createElement.bind(document);
    const twoD = realCreate('canvas');
    const ctx = recorderCtx();
    ctx.canvas = twoD;
    (twoD as HTMLCanvasElement).getContext = (() => ctx) as never;
    const glCanvas = realCreate('canvas');
    (glCanvas as HTMLCanvasElement).getContext = (() => gl) as never;
    const spy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tag: string) =>
        tag === 'canvas' ? glCanvas : realCreate(tag)) as never);
    restoreCreate = () => spy.mockRestore();

    const scene = new Scene(twoD, { pointBackend: 'webgl', maxDPR: 2 });
    expect(
      (scene as unknown as { pointRenderer?: { maxDPR?: number } }).pointRenderer?.maxDPR,
    ).toBe(2);
  });
});
