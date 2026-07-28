/**
 * Decode the packed WebGL quad vertex layouts the way the GPU does, so tests can
 * assert on logical values rather than on raw bytes.
 *
 * `WebGLPointRenderer` uploads packed vertices — position as f32, uv as
 * u16-normalized, tint as u8-normalized — and declares that layout through
 * `vertexAttribPointer(..., normalized: true)`. The mock GL contexts in these
 * tests stub `vertexAttribPointer` out, so nothing about the byte layout is
 * enforced by the renderer at test time; these helpers deliberately reimplement
 * the GPU's side of the contract (stride, offset, unnormalize) so that a wrong
 * offset or a wrong scale factor shows up as a wrong decoded value.
 *
 * The attribute FORMAT itself is asserted separately — see the
 * 'declares the packed vertex attribute format' tests, which read the recorded
 * `vertexAttribPointer` calls. Both halves are needed: these helpers would
 * happily decode a buffer the GPU would misread if the declared stride and the
 * writer's stride were wrong in the same way.
 */

/** Bytes per packed sprite/glyph/circle-quad vertex: pos 2xf32, uv 2xu16n, tint 4xu8n. */
export const QUAD_VERT_STRIDE = 16;
/** Bytes per packed rect vertex: pos 2xf32, tint 4xu8n. */
export const RECT_VERT_STRIDE = 12;
export const VERTS_PER_QUAD = 4;

export interface DecodedQuadVertex {
  x: number;
  y: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface DecodedRectVertex {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const viewsOf = (data: ArrayBufferView) => {
  const buf = data.buffer as ArrayBuffer;
  const base = data.byteOffset;
  return {
    f32: new Float32Array(buf, base, data.byteLength >> 2),
    u16: new Uint16Array(buf, base, data.byteLength >> 1),
    u8: new Uint8Array(buf, base, data.byteLength),
  };
};

/** Decode vertex `i` of a packed sprite/glyph/circle-quad payload. */
export function decodeQuadVertex(data: ArrayBufferView, i: number): DecodedQuadVertex {
  const { f32, u16, u8 } = viewsOf(data);
  const byte = i * QUAD_VERT_STRIDE;
  return {
    x: f32[byte >> 2]!,
    y: f32[(byte >> 2) + 1]!,
    u: u16[(byte + 8) >> 1]! / 65535,
    v: u16[((byte + 8) >> 1) + 1]! / 65535,
    r: u8[byte + 12]! / 255,
    g: u8[byte + 13]! / 255,
    b: u8[byte + 14]! / 255,
    a: u8[byte + 15]! / 255,
  };
}

/** Decode vertex `i` of a packed rect payload. */
export function decodeRectVertex(data: ArrayBufferView, i: number): DecodedRectVertex {
  const { f32, u8 } = viewsOf(data);
  const byte = i * RECT_VERT_STRIDE;
  return {
    x: f32[byte >> 2]!,
    y: f32[(byte >> 2) + 1]!,
    r: u8[byte + 8]! / 255,
    g: u8[byte + 9]! / 255,
    b: u8[byte + 10]! / 255,
    a: u8[byte + 11]! / 255,
  };
}

/** Byte length of a packed sprite/glyph/circle-quad payload holding `quads` quads. */
export const quadBytes = (quads: number): number => quads * VERTS_PER_QUAD * QUAD_VERT_STRIDE;
/** Byte length of a packed rect payload holding `quads` quads. */
export const rectBytes = (quads: number): number => quads * VERTS_PER_QUAD * RECT_VERT_STRIDE;
