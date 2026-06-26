// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createWebGLPointRenderer } from '../src/renderer/WebGLPointRenderer';

/** A mock WebGL2 context that records bufferData / drawArrays / viewport. */
function mockGL() {
  const captures = {
    drawArrays: [] as { mode: number; first: number; count: number }[],
    drawInstanced: [] as { mode: number; first: number; vcount: number; icount: number }[],
    bufferData: [] as { data: Float32Array; usage: number }[],
    divisors: [] as number[],
    viewport: [] as number[][],
    clearCount: 0,
  };
  let loc = 0;
  const gl = {
    // constants (arbitrary distinct numbers)
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
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    useProgram: vi.fn(),
    getAttribLocation: vi.fn(() => loc++),
    getUniformLocation: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn((_t: number, data: Float32Array, usage: number) =>
      captures.bufferData.push({ data, usage }),
    ),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn((_loc: number, divisor: number) => captures.divisors.push(divisor)),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    viewport: vi.fn((...a: number[]) => captures.viewport.push(a)),
    clearColor: vi.fn(),
    clear: vi.fn(() => captures.clearCount++),
    drawArrays: vi.fn((mode: number, first: number, count: number) =>
      captures.drawArrays.push({ mode, first, count }),
    ),
    drawArraysInstanced: vi.fn((mode: number, first: number, vcount: number, icount: number) =>
      captures.drawInstanced.push({ mode, first, vcount, icount }),
    ),
    TRIANGLE_STRIP: 13,
    STATIC_DRAW: 14,
    TRIANGLES: 15,
  };
  return { gl, captures };
}

function mockCanvas(gl: unknown | null) {
  return {
    getContext: vi.fn((type: string) => (type === 'webgl2' ? gl : null)),
    width: 0,
    height: 0,
    style: { width: '', height: '' },
  } as unknown as HTMLCanvasElement;
}

describe('createWebGLPointRenderer', () => {
  it('returns null when WebGL2 is unavailable', () => {
    expect(createWebGLPointRenderer(mockCanvas(null))).toBeNull();
  });

  it('marshals circles into one interleaved buffer and a single POINTS draw', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    expect(r).not.toBeNull();

    r.begin();
    r.addCircle(10, 20, 5, '#ff0000');
    r.addCircle(30, 20, 5, '#ff0000');
    r.flush();

    expect(captures.drawArrays).toHaveLength(1);
    expect(captures.drawArrays[0]).toMatchObject({ mode: gl.POINTS, first: 0, count: 2 });

    const buf = captures.bufferData.at(-1)!.data;
    // 7 floats per point: x, y, radius, r, g, b, a
    expect(buf.length).toBeGreaterThanOrEqual(14);
    expect(Array.from(buf.slice(0, 7))).toEqual([10, 20, 5, 1, 0, 0, 1]);
    expect(Array.from(buf.slice(7, 14))).toEqual([30, 20, 5, 1, 0, 0, 1]);
  });

  it('expands rects into a triangle batch and one TRIANGLES draw (6 verts/rect)', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addRect(10, 20, 30, 40, '#00ff00', 1, 0); // axis-aligned
    r.addRect(50, 60, 5, 5, '#00ff00');
    r.flush();

    expect(captures.drawArrays).toHaveLength(1);
    expect(captures.drawArrays[0]).toMatchObject({ mode: gl.TRIANGLES, first: 0, count: 12 }); // 2 rects × 6

    // 6 floats/vertex (x,y,r,g,b,a), 6 verts/rect → 72 floats for 2 rects.
    const buf = captures.bufferData.find((b) => b.data.length === 72)!;
    expect(buf).toBeTruthy();
    // First vertex of rect 0 = top-left corner (10,20) with green color.
    expect(Array.from(buf.data.slice(0, 6))).toEqual([10, 20, 0, 1, 0, 1]);
    // Third vertex = bottom-right corner (10+30, 20+40) = (40, 60).
    expect(Array.from(buf.data.slice(12, 14))).toEqual([40, 60]);
  });

  it('clears once and draws both rects and circles when both are present', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addRect(0, 0, 10, 10, '#fff');
    r.addCircle(5, 5, 2, '#000');
    r.flush();

    expect(captures.clearCount).toBe(1); // single clear
    expect(captures.drawArrays).toHaveLength(2); // rects (TRIANGLES) + circles (POINTS)
  });

  it('begin() resets the buffer; an empty frame clears but does not draw', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addCircle(0, 0, 1, '#fff');
    r.flush();
    expect(captures.drawArrays).toHaveLength(1);

    r.begin(); // reset
    r.flush(); // no circles
    expect(captures.drawArrays).toHaveLength(1); // still 1 — no new draw
    expect(captures.clearCount).toBe(2); // but the GL layer was cleared each flush
  });

  it('resize() sets the backing buffer with DPR and updates the viewport', () => {
    const { gl, captures } = mockGL();
    const canvas = mockCanvas(gl);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    const r = createWebGLPointRenderer(canvas)!;
    r.resize(800, 600);
    expect(canvas.width).toBe(1600); // 800 * dpr
    expect(canvas.height).toBe(1200);
    expect(captures.viewport.at(-1)).toEqual([0, 0, 1600, 1200]);
  });
});
