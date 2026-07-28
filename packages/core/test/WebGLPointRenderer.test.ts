// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createWebGLPointRenderer } from '../src/renderer/WebGLPointRenderer';
import { decodeQuadVertex, decodeRectVertex, quadBytes, rectBytes } from './helpers/packedVertex';

/** A mock WebGL2 context that records bufferData / draw calls / viewport. */
function mockGL() {
  const captures = {
    drawArrays: [] as { mode: number; first: number; count: number }[],
    drawElements: [] as { mode: number; count: number; type: number; offset: number }[],
    drawInstanced: [] as { mode: number; first: number; vcount: number; icount: number }[],
    /** ELEMENT_ARRAY_BUFFER uploads (the shared static quad index buffer). */
    indexData: [] as { data: Uint32Array; usage: number }[],
    bufferData: [] as { data: ArrayBufferView; usage: number }[],
    /** Declared vertex attribute formats, so the packed layout is pinned. */
    attribs: [] as {
      loc: number;
      size: number;
      type: number;
      normalized: boolean;
      stride: number;
      offset: number;
    }[],
    divisors: [] as number[],
    /**
     * The ELEMENT_ARRAY_BUFFER recorded by the VAO bound at each drawElements.
     * `null` means the draw would be GL_INVALID_OPERATION on a real GPU.
     */
    drawIndexBindings: [] as unknown[],
    viewport: [] as number[][],
    clearCount: 0,
    textureBinds: [] as unknown[],
    texUploads: 0,
    uniform1f: [] as number[],
  };
  let loc = 0;
  // A VAO records its ELEMENT_ARRAY_BUFFER binding, and getting that wrong is
  // invisible unless the mock models it — see the regression test below.
  let currentVAO: unknown = null;
  const vaoIndexBinding = new Map<unknown, unknown>();
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
    bindVertexArray: vi.fn((vao: unknown) => {
      currentVAO = vao;
    }),
    deleteVertexArray: vi.fn(),
    bindBuffer: vi.fn((target: number, buffer: unknown) => {
      // 30 === ELEMENT_ARRAY_BUFFER. The binding belongs to the bound VAO, so a
      // bind (including a null one) mutates that VAO's state, not global state.
      if (target === 30 && currentVAO !== null) vaoIndexBinding.set(currentVAO, buffer);
    }),
    bufferData: vi.fn(
      (target: number, data: Float32Array | Uint32Array | Uint8Array | number, usage: number) => {
        // The shared quad index buffer uploads Uint32Array to ELEMENT_ARRAY_BUFFER;
        // keep it out of `bufferData` so vertex-payload assertions stay precise.
        if (target === 30) {
          captures.indexData.push({ data: data as Uint32Array, usage });
          return;
        }
        captures.bufferData.push({ data: data as ArrayBufferView, usage });
      },
    ),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(
      (
        loc: number,
        size: number,
        type: number,
        normalized: boolean,
        stride: number,
        offset: number,
      ) => captures.attribs.push({ loc, size, type, normalized, stride, offset }),
    ),
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
    drawElements: vi.fn((mode: number, count: number, type: number, offset: number) => {
      captures.drawElements.push({ mode, count, type, offset });
      captures.drawIndexBindings.push(vaoIndexBinding.get(currentVAO) ?? null);
    }),
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
    ALIASED_POINT_SIZE_RANGE: 27,
    UNSIGNED_SHORT: 28,
    ELEMENT_ARRAY_BUFFER: 30,
    UNSIGNED_INT: 31,
    getParameter: vi.fn(() => new Float32Array([1, 255])),
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

  it('expands rects into an indexed quad batch and one TRIANGLES drawElements', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addRect(10, 20, 30, 40, '#00ff00', 1, 0); // axis-aligned
    r.addRect(50, 60, 5, 5, '#00ff00');
    r.flush();

    // Indexed: 4 verts/rect uploaded, 6 INDICES/rect drawn.
    expect(captures.drawElements).toHaveLength(1);
    expect(captures.drawElements[0]).toMatchObject({
      mode: gl.TRIANGLES,
      count: 12, // 2 rects × 6 indices
      type: gl.UNSIGNED_INT,
      offset: 0,
    });

    // 12 bytes/vertex (pos 2xf32, tint 4xu8n), 4 verts/rect → 96 bytes for 2 rects.
    const buf = captures.bufferData.find((b) => b.data.byteLength === rectBytes(2))!;
    expect(buf).toBeTruthy();
    // First vertex of rect 0 = top-left corner (10,20) with green color.
    expect(decodeRectVertex(buf.data, 0)).toEqual({ x: 10, y: 20, r: 0, g: 1, b: 0, a: 1 });
    // Third vertex = bottom-right corner (10+30, 20+40) = (40, 60).
    const v2 = decodeRectVertex(buf.data, 2);
    expect([v2.x, v2.y]).toEqual([40, 60]);
  });

  it('clears once and draws both rects and circles when both are present', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addRect(0, 0, 10, 10, '#fff');
    r.addCircle(5, 5, 2, '#000');
    r.flush();

    expect(captures.clearCount).toBe(1); // single clear
    expect(captures.drawElements).toHaveLength(1); // rects, indexed
    expect(captures.drawArrays).toHaveLength(1); // circles keep the POINTS path
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

  it('maxDPR caps the backing store below the real DPR (findings.md, 2026-07-16)', () => {
    const { gl, captures } = mockGL();
    const canvas = mockCanvas(gl);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3;
    const r = createWebGLPointRenderer(canvas)!;
    r.maxDPR = 2;
    r.resize(800, 600);
    expect(canvas.width).toBe(1600); // 800 * 2 (capped), not * 3
    expect(canvas.height).toBe(1200);
    expect(captures.viewport.at(-1)).toEqual([0, 0, 1600, 1200]);
  });

  it('maxDPR above the real DPR is a no-op (never scales UP)', () => {
    const { gl } = mockGL();
    const canvas = mockCanvas(gl);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    const r = createWebGLPointRenderer(canvas)!;
    r.maxDPR = 4;
    r.resize(800, 600);
    expect(canvas.width).toBe(1600); // still 800 * 2 (the real DPR), not * 4
    expect(canvas.height).toBe(1200);
  });

  it('maxDPR undefined (default) keeps the uncapped, real-DPR behavior unchanged', () => {
    const { gl } = mockGL();
    const canvas = mockCanvas(gl);
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    const r = createWebGLPointRenderer(canvas)!;
    expect(r.maxDPR).toBeUndefined();
    r.resize(800, 600);
    expect(canvas.width).toBe(1600); // 800 * 2, unchanged
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

    // sprites drawn indexed: 6 indices/sprite → 12 for 2 sprites
    const spriteDraw = captures.drawElements.find((d) => d.mode === gl.TRIANGLES && d.count === 12);
    expect(spriteDraw).toBeTruthy();

    // 16 bytes/vertex (pos 2xf32, uv 2xu16n, tint 4xu8n) × 4 verts × 2 sprites.
    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(2))!;
    expect(buf).toBeTruthy();
    // First vertex of sprite 0: pos (10,20), uv (0,0), white tint (1,1,1,1).
    expect(decodeQuadVertex(buf.data, 0)).toEqual({
      x: 10,
      y: 20,
      u: 0,
      v: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    });
    // Third vertex (bottom-right): pos (40,60), uv (0.5,0.5). uv is u16-normalized,
    // so 0.5 is not exactly representable — 32768/65535.
    const v2 = decodeQuadVertex(buf.data, 2);
    expect([v2.x, v2.y]).toEqual([40, 60]);
    expect(v2.u).toBeCloseTo(0.5, 4);
    expect(v2.v).toBeCloseTo(0.5, 4);
    // Fourth vertex (bottom-left) closes the quad; the index buffer builds the
    // two triangles, so no corner is duplicated in the payload.
    const v3 = decodeQuadVertex(buf.data, 3);
    expect([v3.x, v3.y]).toEqual([10, 60]);
    expect(v3.u).toBe(0);
    expect(v3.v).toBeCloseTo(0.5, 4);
  });

  it('addSprite rotates quad corners about its origin', () => {
    // The batching path unrolls the corner maths and fast-paths rotation === 0
    // (it is the hot loop: ~25k glyphs/frame). Pin the rotated geometry so that
    // optimisation cannot silently regress non-zero rotations.
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.begin();
    // 90deg CW in screen space (y down): local +x maps to +y, local +y to -x.
    r.addSprite(100, 100, 20, 10, 0, 0, 1, 1, '#ffffff', 1, Math.PI / 2);
    r.flush();
    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(1))!;
    const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 4);
    const v = (i: number) => decodeQuadVertex(buf.data, i);
    // v0 = origin, unmoved by rotation.
    near(v(0).x, 100);
    near(v(0).y, 100);
    // v1 = origin + width along rotated +x → (100, 120).
    near(v(1).x, 100);
    near(v(1).y, 120);
    // v2 = + height along rotated +y → (90, 120).
    near(v(2).x, 90);
    near(v(2).y, 120);
    // v3 (bottom-left) = origin + height along rotated +y → (90, 100).
    near(v(3).x, 90);
    near(v(3).y, 100);
  });

  it('addSprite applies a tint color and alpha', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1, '#ff0000', 0.5);
    r.flush();
    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(1))!;
    const v0 = decodeQuadVertex(buf.data, 0);
    expect([v0.r, v0.g, v0.b]).toEqual([1, 0, 0]); // red round-trips exactly through u8
    // Alpha is u8-normalized, so 0.5 lands on 128/255 — see the precision note on
    // PACKED_QUAD_VERT_STRIDE for why this is the intended tradeoff.
    expect(v0.a).toBeCloseTo(0.5, 2);
  });

  // The packed vertex layout only works if the writer and the DECLARED attribute
  // format agree. Nothing else in this suite checks the declaration — the mock's
  // vertexAttribPointer used to be a no-op — so a wrong offset or a missing
  // `normalized` flag would pass every payload assertion above and render garbage
  // on a real GPU. These two tests are that missing half of the contract.
  it('declares the packed 16-byte attribute format for sprites, glyphs and circle-quads', () => {
    const { gl, captures } = mockGL();
    createWebGLPointRenderer(mockCanvas(gl));

    // pos 2xf32 @0, uv 2xu16-normalized @8, tint 4xu8-normalized @12, stride 16.
    const packedTriples = captures.attribs.filter((a) => a.stride === 16);
    // Three programs share this layout: sprite, MSDF glyph, circle-quad.
    expect(packedTriples).toHaveLength(9);

    const pos = packedTriples.filter((a) => a.offset === 0);
    const uv = packedTriples.filter((a) => a.offset === 8);
    const tint = packedTriples.filter((a) => a.offset === 12);
    expect(pos).toHaveLength(3);
    expect(uv).toHaveLength(3);
    expect(tint).toHaveLength(3);

    for (const a of pos) {
      expect(a).toMatchObject({ size: 2, type: gl.FLOAT, normalized: false });
    }
    for (const a of uv) {
      // normalized: true is what makes the GPU expand u16 back to [0,1]; without
      // it the shader would see raw 0..65535 and sample far outside the atlas.
      expect(a).toMatchObject({ size: 2, type: gl.UNSIGNED_SHORT, normalized: true });
    }
    for (const a of tint) {
      expect(a).toMatchObject({ size: 4, type: gl.UNSIGNED_BYTE, normalized: true });
    }
  });

  it('declares the packed 12-byte attribute format for rects', () => {
    const { gl, captures } = mockGL();
    createWebGLPointRenderer(mockCanvas(gl));

    // Rects carry no uv: pos 2xf32 @0, tint 4xu8-normalized @8, stride 12.
    const rectAttribs = captures.attribs.filter((a) => a.stride === 12);
    expect(rectAttribs).toHaveLength(2);
    expect(rectAttribs[0]).toMatchObject({
      size: 2,
      type: gl.FLOAT,
      normalized: false,
      offset: 0,
    });
    expect(rectAttribs[1]).toMatchObject({
      size: 4,
      type: gl.UNSIGNED_BYTE,
      normalized: true,
      offset: 8,
    });
  });

  // Encoding rounds to nearest rather than truncating. Truncation was the
  // prototype's behaviour and doubles the worst-case error for free: 0.999 would
  // encode to 254/255 rather than 255/255, and a uv of 0.99999 would land a full
  // texel short on a large atlas.
  it('rounds packed uv and tint to nearest rather than truncating', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.begin();
    // Both values land on a half-step, which is the only place the two differ:
    // uv 0.5 * 65535 = 32767.5 and alpha 0.999 * 255 = 254.745.
    r.addSprite(0, 0, 10, 10, 0, 0, 0.5, 0.5, '#ffffff', 0.999);
    r.flush();

    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(1))!;
    const v2 = decodeQuadVertex(buf.data, 2); // bottom-right carries u1/v1
    // Exact comparison, not toBeCloseTo: the whole point is which side of the
    // half-step it lands on. Truncating would give 32767/65535.
    expect(v2.u).toBe(32768 / 65535);
    expect(v2.v).toBe(32768 / 65535);
    const v0 = decodeQuadVertex(buf.data, 0);
    expect(v0.a).toBe(1); // 254.745 -> 255, not 254
    expect(v0.r).toBe(1); // white stays exactly white
  });

  it('clamps packed tint alpha, since Entity.opacity is not range-checked', () => {
    // `Entity.opacity` has no clamp on assignment, so an out-of-range accumulated
    // opacity can reach the writer. u8-normalized cannot represent >1 or <0, and a
    // typed-array store would WRAP rather than saturate — 1.5 * 255 = 382 stores as
    // 126, i.e. a nearly-transparent quad where an opaque one was asked for.
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);

    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1, '#ffffff', 1.5);
    r.flush();
    const over = captures.bufferData.find((b) => b.data.byteLength === quadBytes(1))!;
    expect(decodeQuadVertex(over.data, 0).a).toBe(1);

    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1, '#ffffff', -0.5);
    r.flush();
    const under = captures.bufferData.filter((b) => b.data.byteLength === quadBytes(1)).at(-1)!;
    expect(decodeQuadVertex(under.data, 0).a).toBe(0);
  });

  // Regression, found by a real-GPU probe rather than by this suite: the shared
  // quad index buffer is bound INTO each quad VAO at setup, and `flush()` calls
  // ensureQuadIndices() with a quad VAO already bound. A VAO records its
  // ELEMENT_ARRAY_BUFFER binding, so a trailing bindBuffer(ELEMENT_ARRAY_BUFFER,
  // null) inside that helper wrote the null into whichever VAO was current and
  // permanently cleared its index binding — every later drawElements on it was
  // GL_INVALID_OPERATION and drew nothing at all. On real hardware that was a
  // fully transparent framebuffer on both Chrome and Firefox: rects vanished in a
  // mixed scene, glyphs in a text-only one, i.e. whichever batch triggered the
  // index-buffer growth.
  //
  // This suite could not see it because the mock did not model VAO state, so both
  // assertions below depend on the mock's vaoIndexBinding map.
  it('keeps an index buffer bound in every quad VAO across an index-buffer growth', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.setMSDFTexture({} as TexImageSource, 4);

    // First frame: this is the one that grows the index buffer from 0 to 256.
    r.begin();
    r.addRect(0, 0, 10, 10, '#ffffff');
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1);
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1);
    r.flush();

    // Second frame, past the growth, and a third that forces another growth
    // beyond the 256-quad seed so the helper runs again with a VAO bound.
    r.begin();
    r.addRect(0, 0, 10, 10, '#ffffff');
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1);
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1);
    r.flush();

    r.begin();
    for (let i = 0; i < 300; i++) r.addRect(0, 0, 2, 2, '#ffffff');
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1);
    r.flush();

    // Every indexed draw must have had a non-null index buffer bound.
    expect(captures.drawElements.length).toBeGreaterThanOrEqual(8);
    expect(captures.drawIndexBindings).toHaveLength(captures.drawElements.length);
    expect(captures.drawIndexBindings.filter((b) => b === null)).toEqual([]);
  });

  it('does not draw sprites when no texture is set', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.begin();
    r.addSprite(0, 0, 10, 10, 0, 0, 1, 1); // no setTexture → skipped
    r.flush();
    expect(captures.drawElements.filter((d) => d.mode === gl.TRIANGLES)).toHaveLength(0);
  });

  it('setMSDFTexture uploads the field atlas to its own texture', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);
    expect(captures.texUploads).toBe(1);
    expect(captures.textureBinds.length).toBeGreaterThan(0);
  });

  it('skips re-uploading an identical texture source (per-frame re-set must be free)', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    const atlasA = {} as TexImageSource;
    r.setMSDFTexture(atlasA, 4);
    r.setMSDFTexture(atlasA, 4); // MSDFTextEntity re-sets its atlas every render
    r.setMSDFTexture(atlasA, 4);
    expect(captures.texUploads).toBe(1);

    const atlasB = {} as TexImageSource;
    r.setMSDFTexture(atlasB, 2); // a different source must re-upload
    expect(captures.texUploads).toBe(2);

    const spriteAtlas = {} as TexImageSource;
    r.setTexture(spriteAtlas);
    r.setTexture(spriteAtlas);
    expect(captures.texUploads).toBe(3); // sprite path caches too
  });

  it('draws pending glyphs before switching to a different MSDF atlas', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    const atlasA = {} as TexImageSource;
    const atlasB = {} as TexImageSource;

    r.begin();
    r.setMSDFTexture(atlasA, 4);
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1);
    // Second font: glyphs already batched against atlas A must be committed
    // now, or they'd be drawn with atlas B's texture (wrong glyphs).
    r.setMSDFTexture(atlasB, 4);
    r.addGlyph(20, 0, 10, 10, 0, 0, 1, 1);
    r.flush();

    const glyphDraws = captures.drawElements.filter(
      (d) => d.mode === gl.TRIANGLES && d.count === 6,
    );
    expect(glyphDraws).toHaveLength(2); // one draw per atlas
  });

  it('addGlyph expands to a textured triangle batch and feeds the distance range', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);

    r.begin();
    r.addGlyph(10, 20, 30, 40, 0, 0, 0.5, 0.5); // default white tint, alpha 1
    r.addGlyph(50, 60, 10, 10, 0.5, 0.5, 1, 1);
    r.flush();

    // glyphs drawn indexed: 6 indices/glyph → 12 for 2 glyphs
    const glyphDraw = captures.drawElements.find((d) => d.mode === gl.TRIANGLES && d.count === 12);
    expect(glyphDraw).toBeTruthy();
    // distance range plumbed to the shader (no points drawn → only this uniform1f)
    expect(captures.uniform1f).toContain(4);

    // Glyphs share the packed sprite layout: 16 bytes/vertex × 4 verts × 2 glyphs.
    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(2))!;
    expect(buf).toBeTruthy();
    // First vertex of glyph 0: pos (10,20), uv (0,0), white tint (1,1,1,1).
    expect(decodeQuadVertex(buf.data, 0)).toEqual({
      x: 10,
      y: 20,
      u: 0,
      v: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    });
    // Third vertex (bottom-right): pos (40,60), uv (0.5,0.5).
    const v2 = decodeQuadVertex(buf.data, 2);
    expect([v2.x, v2.y]).toEqual([40, 60]);
    expect(v2.u).toBeCloseTo(0.5, 4);
    expect(v2.v).toBeCloseTo(0.5, 4);
  });

  it('addGlyph applies a tint color and alpha', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setMSDFTexture({} as TexImageSource, 4);
    r.begin();
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1, '#ff0000', 0.5);
    r.flush();
    const buf = captures.bufferData.find((b) => b.data.byteLength === quadBytes(1))!;
    const v0 = decodeQuadVertex(buf.data, 0);
    expect([v0.r, v0.g, v0.b]).toEqual([1, 0, 0]);
    expect(v0.a).toBeCloseTo(0.5, 2);
  });

  it('does not draw glyphs when no MSDF texture is set', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.begin();
    r.addGlyph(0, 0, 10, 10, 0, 0, 1, 1); // no setMSDFTexture → skipped
    r.flush();
    expect(captures.drawArrays.filter((d) => d.mode === gl.TRIANGLES)).toHaveLength(0);
  });

  it('destroy releases each GL resource exactly once', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.setTexture({} as TexImageSource);
    r.setMSDFTexture({} as TexImageSource, 4);

    r.destroy();
    r.destroy();

    // 5 vertex buffers + the shared static quad index buffer.
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(6);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(5);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(5); // + the circle-quad fallback path
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
  });
});

describe('gl.POINTS clip fallback', () => {
  it('routes circles near the viewport edge to the triangle-quad path', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.resize(800, 600);
    r.begin();
    // Center 5px from the left edge, radius 20: gl.POINTS would vanish the
    // moment the center clips off-viewport; the quad path never does.
    r.addCircle(5, 300, 20, '#00ff00');
    r.flush();

    const points = captures.drawArrays.filter((d) => d.mode === gl.POINTS);
    const tris = captures.drawElements.filter((d) => d.mode === gl.TRIANGLES);
    expect(points).toHaveLength(0);
    expect(tris).toHaveLength(1);
    expect(tris[0].count).toBe(6); // one quad = 6 indices
  });

  it('routes circles larger than the GPU max point size to the quad path', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.resize(800, 600);
    r.begin();
    r.addCircle(400, 300, 200, '#00f'); // diameter 400 > mocked max 255
    r.flush();

    expect(captures.drawArrays.filter((d) => d.mode === gl.POINTS)).toHaveLength(0);
    expect(captures.drawElements.filter((d) => d.mode === gl.TRIANGLES)).toHaveLength(1);
  });

  it('interior small circles keep the fast POINTS path', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.resize(800, 600);
    r.begin();
    r.addCircle(400, 300, 10, '#fff'); // safely interior
    r.addCircle(5, 300, 20, '#fff'); // edge → quad
    r.flush();

    const points = captures.drawArrays.filter((d) => d.mode === gl.POINTS);
    const tris = captures.drawElements.filter((d) => d.mode === gl.TRIANGLES);
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe(1);
    expect(tris).toHaveLength(1);
  });
});

describe('draw accounting', () => {
  it('counts one draw call per active primitive type', () => {
    const { gl, captures } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    r.begin();
    r.addCircle(10, 20, 5, '#ff0000');
    r.addRect(10, 20, 30, 40, '#00ff00');
    r.flush();
    // begin() closes the frame, so the count is readable on the next one.
    r.begin();

    const stats = r.stats!();
    // Two active types, two draws: batching here is per primitive type.
    expect(stats.drawCalls).toBe(2);
    expect(captures.drawArrays.length + captures.drawElements.length).toBe(2);
    expect(stats.totalDrawCalls).toBe(2);
  });

  it('accumulates totals across frames while drawCalls stays per-frame', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;

    for (let frame = 0; frame < 3; frame++) {
      r.begin();
      r.addCircle(10, 20, 5, '#ff0000');
      r.flush();
    }
    r.begin();

    const stats = r.stats!();
    expect(stats.drawCalls).toBe(1);
    expect(stats.totalDrawCalls).toBe(3);
  });

  it('reports zero draws for an empty frame', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.begin();
    r.flush();
    r.begin();
    expect(r.stats!().drawCalls).toBe(0);
  });

  it('splits circles between the POINTS fast path and the quad fallback', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    r.resize(200, 200);

    r.begin();
    r.addCircle(100, 100, 5, '#f00'); // interior: POINTS
    r.addCircle(2, 100, 5, '#f00'); // near the edge: could clip, so quad
    r.flush();
    r.begin();

    const stats = r.stats!();
    expect(stats.circlePoints).toBe(1);
    expect(stats.circleQuadFallbacks).toBe(1);
  });

  it('counts an MSDF atlas switch, which costs an extra draw', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    const atlasA = { width: 4, height: 4 } as unknown as TexImageSource;
    const atlasB = { width: 8, height: 8 } as unknown as TexImageSource;

    r.begin();
    r.setMSDFTexture!(atlasA, 4); // first upload is itself a switch: none before it
    r.setMSDFTexture!(atlasA, 4); // same atlas re-set: free, must not count
    r.setMSDFTexture!(atlasB, 4); // a real switch
    r.flush();
    r.begin();

    // Two: the initial upload and the change. The middle call is the one that
    // matters — entities re-set their atlas every render, and counting those
    // would make the number meaningless.
    expect(r.stats!().atlasSwitches).toBe(2);
  });

  it('reports programs and textures as fixed capabilities', () => {
    const { gl } = mockGL();
    const r = createWebGLPointRenderer(mockCanvas(gl))!;
    const stats = r.stats!();
    // Five programs compiled once at creation, never per frame.
    expect(stats.programs).toBe(5);
    // No atlas uploaded yet.
    expect(stats.textures).toBe(0);
  });
});
