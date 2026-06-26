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
    textureBinds: [] as unknown[],
    texUploads: 0,
    uniform1f: [] as number[],
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
    uniform1f: vi.fn((_loc: unknown, val: number) => captures.uniform1f.push(val)),
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
    // Texture path (for sprites)
    TEXTURE_2D: 16,
    TEXTURE0: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    LINEAR: 20,
    CLAMP_TO_EDGE: 21,
    TEXTURE_MIN_FILTER: 22,
    TEXTURE_MAG_FILTER: 23,
    TEXTURE_WRAP_S: 24,
    TEXTURE_WRAP_T: 25,
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn((_t: number, tex: unknown) => captures.textureBinds.push(tex)),
    texImage2D: vi.fn(() => captures.texUploads++),
    texParameteri: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    deleteTexture: vi.fn(),
    pixelStorei: vi.fn(),
    UNPACK_FLIP_Y_WEBGL: 26,
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

  it('setTexture uploads the atlas image to a GL texture', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    const img = {} as TexImageSource;
    r.setTexture(img);
    expect(captures.texUploads).toBe(1);
    expect(captures.textureBinds.length).toBeGreaterThan(0);
  });

  it('addSprite expands to a textured triangle batch and one TRIANGLES draw', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);

    r.begin();
    r.addSprite(10, 20, 30, 40, 0, 0, 0.5, 0.5); // default white tint, alpha 1, no rotation
    r.addSprite(50, 60, 10, 10, 0.5, 0.5, 1, 1);
    r.flush();

    // sprites drawn as TRIANGLES, 6 verts/sprite → 12 for 2 sprites
    const spriteDraw = captures.drawArrays.find((d) => d.mode === gl.TRIANGLES && d.count === 12);
    expect(spriteDraw).toBeTruthy();

    // 8 floats/vertex (x,y,u,v,r,g,b,a) × 6 verts × 2 sprites = 96 floats
    const buf = captures.bufferData.find((b) => b.data.length === 96)!;
    expect(buf).toBeTruthy();
    // First vertex of sprite 0: pos (10,20), uv (0,0), white tint (1,1,1,1).
    expect(Array.from(buf.data.slice(0, 8))).toEqual([10, 20, 0, 0, 1, 1, 1, 1]);
    // Third vertex (bottom-right): pos (40,60), uv (0.5,0.5).
    expect(Array.from(buf.data.slice(16, 20))).toEqual([40, 60, 0.5, 0.5]);
  });

  it('addSprite applies a tint color and alpha', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1, '#ff0000', 0.5);
    r.flush();
    const buf = captures.bufferData.find((b) => b.data.length === 48)!; // 1 sprite × 6 × 8
    expect(Array.from(buf.data.slice(4, 8))).toEqual([1, 0, 0, 0.5]); // red, alpha 0.5
  });

  it('does not draw sprites when no texture is set', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1); // no setTexture → skipped
    r.flush();
    expect(captures.drawArrays.filter((d) => d.mode === gl.TRIANGLES)).toHaveLength(0);
  });

  it('setMSDFTexture uploads the field atlas to its own texture', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);
    expect(captures.texUploads).toBe(1);
    expect(captures.textureBinds.length).toBeGreaterThan(0);
  });

  it('addGlyph expands to a textured triangle batch and feeds the distance range', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);

    r.begin();
    r.addGlyph(10, 20, 30, 40, 0, 0, 0.5, 0.5); // default white tint, alpha 1
    r.addGlyph(50, 60, 10, 10, 0.5, 0.5, 1, 1);
    r.flush();

    // glyphs drawn as TRIANGLES, 6 verts/glyph → 12 for 2 glyphs
    const glyphDraw = captures.drawArrays.find((d) => d.mode === gl.TRIANGLES && d.count === 12);
    expect(glyphDraw).toBeTruthy();
    // distance range plumbed to the shader (no points drawn → only this uniform1f)
    expect(captures.uniform1f).toContain(4);

    // 8 floats/vertex (x,y,u,v,r,g,b,a) × 6 verts × 2 glyphs = 96 floats
    const buf = captures.bufferData.find((b) => b.data.length === 96)!;
    expect(buf).toBeTruthy();
    // First vertex of glyph 0: pos (10,20), uv (0,0), white tint (1,1,1,1).
    expect(Array.from(buf.data.slice(0, 8))).toEqual([10, 20, 0, 0, 1, 1, 1, 1]);
    // Third vertex (bottom-right): pos (40,60), uv (0.5,0.5).
    expect(Array.from(buf.data.slice(16, 20))).toEqual([40, 60, 0.5, 0.5]);
  });

  it('addGlyph applies a tint color and alpha', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);
    r.begin();
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1, '#ff0000', 0.5);
    r.flush();
    const buf = captures.bufferData.find((b) => b.data.length === 48)!; // 1 glyph × 6 × 8
    expect(Array.from(buf.data.slice(4, 8))).toEqual([1, 0, 0, 0.5]); // red, alpha 0.5
  });

  it('does not draw glyphs when no MSDF texture is set', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.begin();
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1); // no setMSDFTexture → skipped
    r.flush();
    expect(captures.drawArrays.filter((d) => d.mode === gl.TRIANGLES)).toHaveLength(0);
  });
});
