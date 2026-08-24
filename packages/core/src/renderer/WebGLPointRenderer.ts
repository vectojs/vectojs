import { parseColorToRGBA } from './colorParse';

/**
 * A GPU-accelerated layer that draws large sets of circles and rectangles in a
 * couple of draw calls. Used by {@link Scene} (via `pointBackend: 'webgl'`) to
 * render `getBatchCircle()` / `getBatchRect()` entities — the point-cloud /
 * particle case where Canvas2D tops out at ~7 fps for 100k primitives.
 */
/** Per-frame and cumulative WebGL draw accounting. */
export interface WebGLDrawStats {
  /** Draw calls issued for the last completed frame. */
  drawCalls: number;
  /** Cumulative draw calls since creation. */
  totalDrawCalls: number;
  /** Cumulative mid-frame MSDF atlas switches, each costing an extra draw. */
  atlasSwitches: number;
  /** Programs compiled at creation — a fixed capability, not a per-frame cost. */
  programs: number;
  /** Textures currently allocated (colour atlas and/or MSDF atlas). */
  textures: number;
  /**
   * Circles routed to the quad path rather than `gl.POINTS`, cumulatively.
   *
   * A circle takes the quad path when it could clip off-viewport or exceeds the
   * driver's maximum aliased point size. A high share means the POINTS fast path
   * is not being used and each circle costs four vertices instead of one.
   */
  circleQuadFallbacks: number;
  /** Circles drawn through the `gl.POINTS` fast path, cumulatively. */
  circlePoints: number;
}

export interface PointRenderer {
  /** Resize the backing buffer + GL viewport to a logical `w × h` (DPR applied). */
  resize(width: number, height: number): void;
  /**
   * Cap on the effective device pixel ratio applied by {@link resize}.
   * `undefined` (default) uses the real, uncapped `devicePixelRatio`. Set
   * before calling `resize()` for it to take effect on that call (matches
   * {@link import('../tree/Scene').SceneOptions.maxDPR} — `Scene` sets this
   * once at construction and again before every `resize()` call, since a
   * factory function has no other way to receive the option: the WebGL point
   * layer's creator is a plain `(canvas) => PointRenderer` registered once by
   * `@vectojs/core`'s module init, with no room for a per-Scene constructor
   * argument).
   */
  maxDPR?: number;
  /** Begin a frame: reset the accumulated primitive buffers. */
  begin(): void;
  /**
   * Draw-call counters for the most recent frame, plus cumulative totals.
   *
   * Batching here is by primitive type — one draw per active type — so draw calls
   * and batches are the same number, and both are bounded at five plus one per
   * mid-frame atlas switch (MSDF or sprite). Those switches are the only
   * variable term and the only thing worth watching: each forces a commit of
   * glyphs/sprites batched against the previous atlas.
   */
  stats?(): WebGLDrawStats;
  /** Add one circle in world (CSS-pixel) coordinates; `alpha` multiplies the color's. */
  addCircle(x: number, y: number, radius: number, color: string, alpha?: number): void;
  /**
   * Add one rectangle: top-left at world `(x, y)`, `width × height` in world units,
   * rotated `rotation` radians about `(x, y)`; `alpha` multiplies the color's.
   */
  addRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    alpha?: number,
    rotation?: number,
  ): void;
  /**
   * Upload a texture atlas used by {@link addSprite}. Pass any `TexImageSource`
   * (HTMLImageElement, HTMLCanvasElement, ImageBitmap, …). Call once (or whenever
   * the atlas changes) before adding sprites.
   */
  setTexture(source: TexImageSource): void;
  /**
   * Add one textured sprite sampling the atlas region `[u0,v0]–[u1,v1]` (UVs in
   * `0..1`): top-left at world `(x, y)`, `width × height` in world units, rotated
   * `rotation` radians about `(x, y)`. `color` multiplies the sampled texel
   * (white = unchanged; use it to tint white glyphs); `alpha` multiplies further.
   * No-op until a texture is set via {@link setTexture}.
   */
  addSprite(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color?: string,
    alpha?: number,
    rotation?: number,
  ): void;
  /**
   * Upload an MSDF (multi-channel signed distance field) glyph atlas used by
   * {@link addGlyph}, kept separate from the {@link setTexture} atlas so both can
   * be active. `distanceRange` is the field's pixel range (the atlas JSON's
   * `atlas.distanceRange`) — it drives the shader's edge sharpness. Pair with
   * `MSDFFont.layout` to position the glyphs.
   */
  setMSDFTexture(source: TexImageSource, distanceRange: number): void;
  /**
   * Add one MSDF glyph quad sampling `[u0,v0]–[u1,v1]` (UVs in `0..1`): top-left
   * at world `(x, y)`, `width × height` in world units. The fragment shader
   * reconstructs a crisp, resolution-independent edge from the distance field, so
   * glyphs stay sharp at any scale. `color` tints the glyph (default white);
   * `alpha` multiplies coverage. No-op until {@link setMSDFTexture} is called.
   */
  addGlyph(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color?: string,
    alpha?: number,
    rotation?: number,
  ): void;
  /** Clear the layer and draw all accumulated primitives. */
  flush(): void;
  /** Release GL resources. */
  destroy(): void;
}

const FLOATS_PER_POINT = 7; // x, y, radius, r, g, b, a
const POINT_STRIDE = FLOATS_PER_POINT * 4;
// Quads (rects, sprites, glyphs, carved circles) are batched as INDEXED
// triangles: 4 vertices per quad plus a static index buffer, drawn with
// drawElements. They were previously expanded to 6 vertices and drawn with
// drawArrays, which re-uploaded the two shared corners every frame.
//
// The submit path is bandwidth-bound, not draw-call-bound — flush() already
// issues at most one draw per primitive type. Measured on real hardware
// (benchmarks/flush-upload, RTX 4060, work + gl.finish(), median of 12), the
// 6-vertex upload cost, versus this 4-vertex indexed form:
//
//   quads    6-vert   indexed
//   12,000   0.59ms   0.10ms   (5.9x)
//   50,000   2.30ms   0.69ms   (3.3x)
//  100,000  12.28ms   3.00ms   (4.1x)
//
// Firefox shows the same ordering at 1.5-2.0x (it is pinned near ~1 GB/s
// effective upload bandwidth, so its time tracks bytes almost linearly).
// Dropping 6 verts to 4 also cuts the JS fill by a third: writeQuad writes 32
// floats instead of 48.
const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
// Vertex attributes are PACKED rather than all-float, which halves the upload
// again on top of the indexing above. `normalized: true` in vertexAttribPointer
// makes the GPU expand an integer attribute back to a float in [0,1] before the
// shader sees it, so the shaders are unchanged — only the pointer setup and the
// writers differ from the all-float form.
//
//   sprite/glyph/circle-quad vertex, 16 B:  pos 2xf32 @0, uv 2xu16n @8, tint 4xu8n @12
//   rect vertex, 12 B:                      pos 2xf32 @0,              tint 4xu8n @8
//
// Position stays f32: it is a logical-pixel coordinate that has no bounded range
// to normalize against. UV and tint are [0,1] by construction, which is exactly
// what a normalized integer attribute encodes.
//
// Precision, measured rather than assumed (the reason this was split out of the
// indexing work and decided separately):
//
//   - u16 uv resolves to 1/65535 of the atlas, i.e. 0.016px on a 2048px atlas and
//     0.031px on 4096px. MSDF atlasBounds are integer pixel edges, so this is
//     exact for any atlas up to 65535px.
//   - u8 tint RGB is lossless: colours originate as CSS 0-255 and are divided by
//     255 on parse (see colorParse.ts), so this round-trips exactly.
//   - u8 tint ALPHA is the one lossy field, and it carries live animated opacity
//     (colour alpha x accumulated ancestor opacity x particle life), not a static
//     colour. It is still safe, because alpha is not displayed — it is a blend
//     factor into an 8-bit framebuffer, so d(out)/d(alpha) is bounded by 1 and
//     half a u8 step of alpha error moves the composited result by at most half
//     one framebuffer step. A 4s fade at 240Hz produces 256 distinct output
//     levels and a longest identical-output run of 4 frames with BOTH f32 and u8
//     alpha: the banding in a slow fade comes from the 8-bit framebuffer, not
//     from this. Worst single-layer composited error is 1 of 255 levels; worst
//     low-alpha overdraw (alpha 0.02 x 50 coincident layers) is 1.9 levels.
//     Keeping alpha as f32 would cost a third of the bandwidth win to fix an
//     artifact below the visibility threshold.
//
// Encoding rounds to nearest (see {@link encodeUnorm}). Truncating instead — as
// the benchmark prototype did — doubles the worst-case error from half a step to
// a full step for free.
const PACKED_QUAD_VERT_STRIDE = 16;
const PACKED_RECT_VERT_STRIDE = 12;
/** Byte offset of the uv pair within a packed sprite vertex. */
const PACKED_UV_OFFSET = 8;
/** Byte offset of the tint word within a packed sprite vertex. */
const PACKED_TINT_OFFSET = 12;
/** Byte offset of the tint word within a packed rect vertex. */
const PACKED_RECT_TINT_OFFSET = 8;

/**
 * Build the static index buffer contents for `quads` quads: for quad `i` the
 * two triangles are (0,1,2) and (0,2,3) over its 4 vertices. Uploaded once and
 * regrown geometrically, never re-sent per frame.
 *
 * `Uint16Array` would cap at 65,535/4 = 16,383 quads, which real scenes exceed
 * (the danmaku workload runs ~25k glyph quads), so this uses 32-bit indices —
 * always available in WebGL2.
 */
function buildQuadIndices(quads: number): Uint32Array {
  const out = new Uint32Array(quads * INDICES_PER_QUAD);
  for (let i = 0; i < quads; i++) {
    const v = i * VERTS_PER_QUAD;
    const o = i * INDICES_PER_QUAD;
    out[o] = v;
    out[o + 1] = v + 1;
    out[o + 2] = v + 2;
    out[o + 3] = v;
    out[o + 4] = v + 2;
    out[o + 5] = v + 3;
  }
  return out;
}

/**
 * Encode a normalized float into an unsigned integer of `max` full scale, the
 * inverse of what `normalized: true` does on the GPU.
 *
 * Rounds to nearest, which halves the worst-case error against truncation (half
 * a step versus a full step). Clamps, because a typed-array store wraps: an
 * unclamped uv of 1.0000001 encodes to 65536, stores as 0, and samples the
 * opposite edge of the atlas — a stark visual bug from a rounding error. Alpha
 * likewise clamps, since `Entity.opacity` is not range-checked on assignment.
 */
function encodeUnorm(v: number, max: number): number {
  // `| 0` truncates, so the + 0.5 is the rounding; both operands are already
  // non-negative after the clamp.
  return v <= 0 ? 0 : v >= 1 ? max : (v * max + 0.5) | 0;
}

/**
 * Whether this platform is little-endian, which decides the byte order of the
 * packed tint word.
 *
 * A `Uint32Array` store writes in platform byte order while the GPU reads the
 * four tint bytes positionally (byte 0 is red), so the shift order has to follow
 * the platform. Writing the four bytes through a `Uint8Array` instead would avoid
 * the question, but costs 16 stores per quad against 4 — this is the hot path at
 * ~25k glyphs/frame. Every browser-bearing platform in practice is little-endian;
 * the big-endian branch exists so that is a fact rather than an assumption.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Pack RGBA in [0,1] into one 32-bit word laid out so that a `Uint32Array` store
 * places red at the lowest byte address.
 */
function packTint(r: number, g: number, b: number, a: number): number {
  const ri = encodeUnorm(r, 255);
  const gi = encodeUnorm(g, 255);
  const bi = encodeUnorm(b, 255);
  const ai = encodeUnorm(a, 255);
  return LITTLE_ENDIAN
    ? (ai << 24) | (bi << 16) | (gi << 8) | ri
    : (ri << 24) | (gi << 16) | (bi << 8) | ai;
}

/**
 * A vertex buffer with the overlapping typed-array views the packed layouts need.
 *
 * One `ArrayBuffer` viewed three ways rather than a `DataView`: `DataView` would
 * force an explicit endianness argument per store and is measurably slower, and
 * the views agree with the GPU by construction because both read the same bytes
 * in platform order. The 16- and 12-byte strides are chosen so every view index
 * divides exactly — a 14-byte vertex would misalign the u32 tint store.
 */
interface PackedBuffer {
  bytes: ArrayBuffer;
  f32: Float32Array;
  u16: Uint16Array;
  u32: Uint32Array;
  u8: Uint8Array;
}

function createPackedBuffer(byteLength: number): PackedBuffer {
  const bytes = new ArrayBuffer(byteLength);
  return {
    bytes,
    f32: new Float32Array(bytes),
    u16: new Uint16Array(bytes),
    u32: new Uint32Array(bytes),
    u8: new Uint8Array(bytes),
  };
}

/**
 * Grow `buf` to hold at least `neededBytes`, doubling and copying. Returns the
 * original when it already fits, so the steady state allocates nothing.
 */
function growPacked(buf: PackedBuffer, neededBytes: number): PackedBuffer {
  if (neededBytes <= buf.bytes.byteLength) return buf;
  let cap = buf.bytes.byteLength;
  while (cap < neededBytes) cap *= 2;
  const grown = createPackedBuffer(cap);
  grown.u8.set(buf.u8);
  return grown;
}

const POINT_VERT = `#version 300 es
in vec2 a_pos;
in float a_radius;
in vec4 a_color;
uniform vec2 u_resolution;
uniform float u_dpr;
out vec4 v_color;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_radius * 2.0 * u_dpr;
  v_color = a_color;
}`;

const POINT_FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float aa = fwidth(d);
  float alpha = 1.0 - smoothstep(0.5 - aa, 0.5, d);
  if (alpha <= 0.0) discard;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}`;

const RECT_VERT = `#version 300 es
in vec2 a_pos;
in vec4 a_rcolor;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_rcolor;
}`;

const RECT_FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = vec4(v_color.rgb, v_color.a);
}`;

const SPRITE_VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec4 a_tint;
uniform vec2 u_resolution;
out vec2 v_uv;
out vec4 v_tint;
void main() {
  vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
  v_tint = a_tint;
}`;

const SPRITE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_tint;
out vec4 outColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  outColor = vec4(t.rgb * v_tint.rgb, t.a * v_tint.a);
}`;

// Circle quads reuse the sprite vertex layout (pos + uv + tint) and carve the
// disk in the fragment shader — the fallback for circles gl.POINTS cannot
// represent: primitive clipping discards a point the instant its CENTER
// leaves the viewport (the disk pops), and gl_PointSize is capped by
// ALIASED_POINT_SIZE_RANGE (big circles silently shrink).
const CIRCLE_QUAD_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_tint;
out vec4 outColor;
void main() {
  vec2 c = v_uv - 0.5;
  float d = length(c);
  float aa = fwidth(d);
  float alpha = 1.0 - smoothstep(0.5 - aa, 0.5, d);
  if (alpha <= 0.0) discard;
  outColor = vec4(v_tint.rgb, v_tint.a * alpha);
}`;

// MSDF glyphs reuse the sprite vertex layout (pos + uv + tint) but reconstruct a
// resolution-independent edge from the distance field: median of the 3 channels
// is the signed distance, and a screen-space-derivative range gives crisp AA at
// any zoom (Chlumsky's method). Tint colors the glyph; coverage scales its alpha.
const MSDF_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_distanceRange;
in vec2 v_uv;
in vec4 v_tint;
out vec4 outColor;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 msd = texture(u_tex, v_uv).rgb;
  float sd = median(msd.r, msd.g, msd.b);
  vec2 unitRange = vec2(u_distanceRange) / vec2(textureSize(u_tex, 0));
  vec2 screenTexSize = vec2(1.0) / fwidth(v_uv);
  float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
  float screenPxDistance = screenPxRange * (sd - 0.5);
  float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
  if (opacity <= 0.0) discard;
  outColor = vec4(v_tint.rgb, v_tint.a * opacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * Write one textured quad's 4 vertices (TL, TR, BR, BL) into `out` at
 * `byteOffset`, rotated by `rotation` about `(x, y)`. Triangle assembly is left
 * to the shared static index buffer (see {@link buildQuadIndices}); the packed
 * 16-byte layout is described at {@link PACKED_QUAD_VERT_STRIDE}.
 *
 * Deliberately allocation-free and closure-free: an earlier version built a
 * `corner` closure plus ~10 temporary arrays per quad and destructured twice per
 * vertex. That is invisible at a few hundred sprites and dominant at ~25k
 * glyphs/frame — profiling a 5,000-danmaku scene put the JS batching loop at
 * 5.4ms/frame (Chrome) against 0.3ms for the GPU submit. Corner maths is
 * unrolled and a `rotation === 0` fast path skips the sin/cos entirely, which is
 * the overwhelmingly common case for text.
 */
function writeQuad(
  out: PackedBuffer,
  byteOffset: number,
  x: number,
  y: number,
  width: number,
  height: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  r: number,
  g: number,
  b: number,
  al: number,
  rotation: number,
): void {
  // Corner positions (TL, TR, BR, BL).
  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  let x3: number;
  let y3: number;
  if (rotation === 0) {
    x1 = x + width;
    y1 = y;
    x2 = x + width;
    y2 = y + height;
    x3 = x;
    y3 = y + height;
  } else {
    const s = Math.sin(rotation);
    const c = Math.cos(rotation);
    const wc = width * c;
    const ws = width * s;
    const hc = height * c;
    const hs = height * s;
    x1 = x + wc;
    y1 = y + ws;
    x2 = x + wc - hs;
    y2 = y + ws + hc;
    x3 = x - hs;
    y3 = y + hc;
  }
  // uv and tint are identical for all four vertices of a quad in every axis but
  // the corner they name, so encode once and store the words four times.
  const iu0 = encodeUnorm(u0, 65535);
  const iv0 = encodeUnorm(v0, 65535);
  const iu1 = encodeUnorm(u1, 65535);
  const iv1 = encodeUnorm(v1, 65535);
  const tint = packTint(r, g, b, al);
  const f32 = out.f32;
  const u16 = out.u16;
  const u32 = out.u32;
  // Per-view indices. The 16-byte stride keeps each division exact.
  const fi = byteOffset >> 2;
  const si = (byteOffset + PACKED_UV_OFFSET) >> 1;
  const ti = (byteOffset + PACKED_TINT_OFFSET) >> 2;
  f32[fi] = x;
  f32[fi + 1] = y;
  u16[si] = iu0;
  u16[si + 1] = iv0;
  u32[ti] = tint;
  f32[fi + 4] = x1;
  f32[fi + 5] = y1;
  u16[si + 8] = iu1;
  u16[si + 9] = iv0;
  u32[ti + 4] = tint;
  f32[fi + 8] = x2;
  f32[fi + 9] = y2;
  u16[si + 16] = iu1;
  u16[si + 17] = iv1;
  u32[ti + 8] = tint;
  f32[fi + 12] = x3;
  f32[fi + 13] = y3;
  u16[si + 24] = iu0;
  u16[si + 25] = iv1;
  u32[ti + 12] = tint;
}

/**
 * Write one solid-color quad's 4 vertices (no UVs) into `out` at `byteOffset`,
 * in the packed 12-byte layout. Same rationale as {@link writeQuad}.
 */
function writeRectQuad(
  out: PackedBuffer,
  byteOffset: number,
  x: number,
  y: number,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  al: number,
  rotation: number,
): void {
  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  let x3: number;
  let y3: number;
  if (rotation === 0) {
    x1 = x + width;
    y1 = y;
    x2 = x + width;
    y2 = y + height;
    x3 = x;
    y3 = y + height;
  } else {
    const s = Math.sin(rotation);
    const c = Math.cos(rotation);
    const wc = width * c;
    const ws = width * s;
    const hc = height * c;
    const hs = height * s;
    x1 = x + wc;
    y1 = y + ws;
    x2 = x + wc - hs;
    y2 = y + ws + hc;
    x3 = x - hs;
    y3 = y + hc;
  }
  const tint = packTint(r, g, b, al);
  const f32 = out.f32;
  const u32 = out.u32;
  // 12-byte stride: 3 f32 slots per vertex, tint in the third.
  const fi = byteOffset >> 2;
  f32[fi] = x;
  f32[fi + 1] = y;
  u32[fi + 2] = tint;
  f32[fi + 3] = x1;
  f32[fi + 4] = y1;
  u32[fi + 5] = tint;
  f32[fi + 6] = x2;
  f32[fi + 7] = y2;
  u32[fi + 8] = tint;
  f32[fi + 9] = x3;
  f32[fi + 10] = y3;
  u32[fi + 11] = tint;
}

/**
 * Grow an all-float vertex array, doubling and copying. Only the `gl.POINTS`
 * circle path still uses this — every quad batch is packed and goes through
 * {@link growPacked}.
 */
function grow(data: Float32Array, needed: number): Float32Array {
  if (needed <= data.length) return data;
  let cap = data.length;
  while (cap < needed) cap *= 2;
  const grown = new Float32Array(cap);
  grown.set(data);
  return grown;
}

/**
 * Does `source` currently hold pixels worth uploading?
 *
 * `setTexture`/`setMSDFTexture` cache on source **identity**, so an upload of a
 * not-yet-decoded raster is not merely wasted — it is permanent. `texImage2D`
 * would store a 0×0 texture, `source` would be recorded as the current one, and
 * every later frame would take the identity fast path and never re-upload. The
 * atlas then decodes and nothing samples it: layout, hit-testing, and the a11y
 * projection are all correct while the text is invisible forever.
 *
 * That is not hypothetical. Measured on Chromium and Firefox (2026-07-31) with
 * a network-served MSDF atlas: `img.complete === false` at the first
 * `addGlyph`, `naturalWidth === 64` once decoded, and **0 ink after 150
 * frames** with exactly one `texImage2D` call. `MSDFTextEntityOptions.texture`
 * is caller-supplied and there is no loader helper, so the obvious
 * `const img = new Image(); img.src = url;` hits it every time.
 *
 * Duck-typed rather than `instanceof`: this module must stay usable where
 * `HTMLImageElement`/`HTMLVideoElement` are not globals (SSR, workers), and the
 * set of `TexImageSource` types grows over time. Anything without decode state
 * — `ImageBitmap`, `HTMLCanvasElement`, `OffscreenCanvas`, `ImageData`,
 * `VideoFrame` — has no readiness to check and is always ready.
 */
function isSourceReady(source: TexImageSource): boolean {
  const candidate = source as {
    complete?: unknown;
    naturalWidth?: unknown;
    readyState?: unknown;
  };
  // HTMLImageElement / SVGImageElement. `complete` alone is not enough: a 404
  // or a decode failure also reports `complete === true`, with no pixels.
  if (typeof candidate.complete === 'boolean') {
    if (!candidate.complete) return false;
    if (typeof candidate.naturalWidth === 'number' && candidate.naturalWidth === 0) return false;
    return true;
  }
  // HTMLVideoElement: HAVE_CURRENT_DATA (2) is the first state with a frame.
  if (typeof candidate.readyState === 'number') return candidate.readyState >= 2;
  return true;
}

/**
 * Create a WebGL2-backed {@link PointRenderer} on `canvas`, or `null` when WebGL2
 * (or shader compilation) is unavailable — callers fall back to Canvas2D.
 *
 * @param canvas - A dedicated canvas (WebGL2 context); should be stacked over the
 *   scene's 2D canvas.
 * @returns A point renderer, or `null` if WebGL2 isn't supported.
 */
export function createWebGLPointRenderer(canvas: HTMLCanvasElement): PointRenderer | null {
  // The shaders output straight (non-premultiplied) alpha and blend with
  // SRC_ALPHA/ONE_MINUS_SRC_ALPHA. The default premultipliedAlpha:true canvas
  // would make the compositor read that buffer as premultiplied — bright
  // fringes on every anti-aliased edge — so opt out to match.
  const gl = canvas.getContext('webgl2', {
    premultipliedAlpha: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;

  // Track this attempt's programs: a later link failure must release the
  // ones that already linked, or every init retry after a driver hiccup
  // leaks another program generation (#686).
  const programs: WebGLProgram[] = [];
  const linkTracked = (vsSrc: string, fsSrc: string): WebGLProgram | null => {
    const program = link(gl, vsSrc, fsSrc);
    if (program) programs.push(program);
    return program;
  };

  const pointProgram = linkTracked(POINT_VERT, POINT_FRAG);
  const rectProgram = linkTracked(RECT_VERT, RECT_FRAG);
  const spriteProgram = linkTracked(SPRITE_VERT, SPRITE_FRAG);
  const msdfProgram = linkTracked(SPRITE_VERT, MSDF_FRAG); // shares the sprite vertex layout
  const circleQuadProgram = linkTracked(SPRITE_VERT, CIRCLE_QUAD_FRAG);
  if (!pointProgram || !rectProgram || !spriteProgram || !msdfProgram || !circleQuadProgram) {
    for (const program of programs) gl.deleteProgram(program);
    // Hand the context back to the browser as well — a failed init used to
    // leave it resident across retries. No-op where the extension is missing.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // --- Point program state (one VAO so its attrib layout/divisors are isolated) ---
  const pAPos = gl.getAttribLocation(pointProgram, 'a_pos');
  const pARadius = gl.getAttribLocation(pointProgram, 'a_radius');
  const pAColor = gl.getAttribLocation(pointProgram, 'a_color');
  const pURes = gl.getUniformLocation(pointProgram, 'u_resolution');
  const pUDpr = gl.getUniformLocation(pointProgram, 'u_dpr');
  const pointBuffer = gl.createBuffer();
  const pointVAO = gl.createVertexArray();
  gl.bindVertexArray(pointVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
  gl.enableVertexAttribArray(pAPos);
  gl.vertexAttribPointer(pAPos, 2, gl.FLOAT, false, POINT_STRIDE, 0);
  gl.enableVertexAttribArray(pARadius);
  gl.vertexAttribPointer(pARadius, 1, gl.FLOAT, false, POINT_STRIDE, 8);
  gl.enableVertexAttribArray(pAColor);
  gl.vertexAttribPointer(pAColor, 4, gl.FLOAT, false, POINT_STRIDE, 12);

  // --- Rect program state (expanded triangle batch) ---
  const rAPos = gl.getAttribLocation(rectProgram, 'a_pos');
  const rAColor = gl.getAttribLocation(rectProgram, 'a_rcolor');
  const rURes = gl.getUniformLocation(rectProgram, 'u_resolution');
  const rectBuffer = gl.createBuffer();
  const rectVAO = gl.createVertexArray();
  gl.bindVertexArray(rectVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
  gl.enableVertexAttribArray(rAPos);
  gl.vertexAttribPointer(rAPos, 2, gl.FLOAT, false, PACKED_RECT_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(rAColor);
  gl.vertexAttribPointer(
    rAColor,
    4,
    gl.UNSIGNED_BYTE,
    true,
    PACKED_RECT_VERT_STRIDE,
    PACKED_RECT_TINT_OFFSET,
  );

  // --- Sprite program state (textured-quad triangle batch) ---
  const sAPos = gl.getAttribLocation(spriteProgram, 'a_pos');
  const sAUv = gl.getAttribLocation(spriteProgram, 'a_uv');
  const sATint = gl.getAttribLocation(spriteProgram, 'a_tint');
  const sURes = gl.getUniformLocation(spriteProgram, 'u_resolution');
  const sUTex = gl.getUniformLocation(spriteProgram, 'u_tex');
  const spriteBuffer = gl.createBuffer();
  const spriteVAO = gl.createVertexArray();
  gl.bindVertexArray(spriteVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
  gl.enableVertexAttribArray(sAPos);
  gl.vertexAttribPointer(sAPos, 2, gl.FLOAT, false, PACKED_QUAD_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(sAUv);
  gl.vertexAttribPointer(
    sAUv,
    2,
    gl.UNSIGNED_SHORT,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_UV_OFFSET,
  );
  gl.enableVertexAttribArray(sATint);
  gl.vertexAttribPointer(
    sATint,
    4,
    gl.UNSIGNED_BYTE,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_TINT_OFFSET,
  );

  // --- MSDF glyph program state (same vertex layout as sprites) ---
  const gAPos = gl.getAttribLocation(msdfProgram, 'a_pos');
  const gAUv = gl.getAttribLocation(msdfProgram, 'a_uv');
  const gATint = gl.getAttribLocation(msdfProgram, 'a_tint');
  const gURes = gl.getUniformLocation(msdfProgram, 'u_resolution');
  const gUTex = gl.getUniformLocation(msdfProgram, 'u_tex');
  const gURange = gl.getUniformLocation(msdfProgram, 'u_distanceRange');
  const glyphBuffer = gl.createBuffer();
  const glyphVAO = gl.createVertexArray();
  gl.bindVertexArray(glyphVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
  gl.enableVertexAttribArray(gAPos);
  gl.vertexAttribPointer(gAPos, 2, gl.FLOAT, false, PACKED_QUAD_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(gAUv);
  gl.vertexAttribPointer(
    gAUv,
    2,
    gl.UNSIGNED_SHORT,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_UV_OFFSET,
  );
  gl.enableVertexAttribArray(gATint);
  gl.vertexAttribPointer(
    gATint,
    4,
    gl.UNSIGNED_BYTE,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_TINT_OFFSET,
  );

  // --- Circle-quad program state (POINTS fallback; sprite vertex layout) ---
  const cAPos = gl.getAttribLocation(circleQuadProgram, 'a_pos');
  const cAUv = gl.getAttribLocation(circleQuadProgram, 'a_uv');
  const cATint = gl.getAttribLocation(circleQuadProgram, 'a_tint');
  const cURes = gl.getUniformLocation(circleQuadProgram, 'u_resolution');
  const circleQuadBuffer = gl.createBuffer();
  const circleQuadVAO = gl.createVertexArray();
  gl.bindVertexArray(circleQuadVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, circleQuadBuffer);
  gl.enableVertexAttribArray(cAPos);
  gl.vertexAttribPointer(cAPos, 2, gl.FLOAT, false, PACKED_QUAD_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(cAUv);
  gl.vertexAttribPointer(
    cAUv,
    2,
    gl.UNSIGNED_SHORT,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_UV_OFFSET,
  );
  gl.enableVertexAttribArray(cATint);
  gl.vertexAttribPointer(
    cATint,
    4,
    gl.UNSIGNED_BYTE,
    true,
    PACKED_QUAD_VERT_STRIDE,
    PACKED_TINT_OFFSET,
  );
  gl.bindVertexArray(null);

  // --- Shared static quad index buffer ------------------------------------
  // One ELEMENT_ARRAY_BUFFER serves every quad batch (rect/sprite/glyph/circle
  // quad): they all use the same (0,1,2, 0,2,3) winding over 4 vertices, and the
  // largest batch dictates its size. Uploaded on growth only, never per frame.
  const quadIndexBuffer = gl.createBuffer();
  let quadIndexCapacity = 0;
  /**
   * Ensure the shared index buffer covers `quads` quads, growing geometrically.
   *
   * Deliberately does NOT unbind ELEMENT_ARRAY_BUFFER afterwards. `flush()` calls
   * this with a quad VAO already bound, and a VAO *records* its
   * ELEMENT_ARRAY_BUFFER binding — so a trailing `bindBuffer(ELEMENT_ARRAY_BUFFER,
   * null)` writes that null into whichever VAO is current and permanently clears
   * its index binding. Every later `drawElements` on that VAO is then
   * GL_INVALID_OPERATION and silently draws nothing: measured on real hardware
   * (Chrome and Firefox alike) as a fully transparent framebuffer, hitting rects in
   * a mixed scene and glyphs in a text-only one, i.e. whichever batch happened to
   * trigger the growth. Rebinding the same buffer here is harmless precisely
   * because the VAO already holds it from setup below.
   */
  const ensureQuadIndices = (quads: number): void => {
    if (quads <= quadIndexCapacity) return;
    let cap = quadIndexCapacity || 256;
    while (cap < quads) cap *= 2;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, buildQuadIndices(cap), gl.STATIC_DRAW);
    quadIndexCapacity = cap;
  };

  // Bind the shared index buffer into each quad VAO once. A VAO records its
  // ELEMENT_ARRAY_BUFFER binding, so drawElements needs no per-frame rebind.
  for (const vao of [rectVAO, spriteVAO, glyphVAO, circleQuadVAO]) {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
    gl.bindVertexArray(null);
  }

  let texture: WebGLTexture | null = null;
  let textureSource: TexImageSource | null = null;
  let msdfTexture: WebGLTexture | null = null;
  let msdfSource: TexImageSource | null = null;
  let distanceRange = 4;

  let pointData: Float32Array = new Float32Array(FLOATS_PER_POINT * 1024);
  let pointCount = 0;
  let rectData = createPackedBuffer(PACKED_RECT_VERT_STRIDE * VERTS_PER_QUAD * 256);
  let rectCount = 0;
  let spriteData = createPackedBuffer(PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD * 256);
  let spriteCount = 0;
  // Glyphs reuse the sprite vertex layout (16 bytes/vert, 4 verts/quad).
  let glyphData = createPackedBuffer(PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD * 1024);
  let glyphCount = 0;
  // Draw accounting. Always on: this is a handful of integer increments per
  // frame against a backend that is already issuing GL calls, and a counter that
  // has to be switched on is a counter nobody has when they need it.
  let frameDrawCalls = 0;
  let lastFrameDrawCalls = 0;
  let totalDrawCalls = 0;
  let atlasSwitches = 0;
  let circleQuadFallbacks = 0;
  let circlePoints = 0;
  let circleQuadData = createPackedBuffer(PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD * 64);
  let circleQuadCount = 0;
  let logicalW = 0;
  let logicalH = 0;
  let dpr = 1;
  let destroyed = false;
  // Device-pixel cap on gl_PointSize; diameters beyond it must use quads.
  // (getParameter guarded for minimal test doubles / exotic contexts.)
  const pointSizeRange =
    typeof gl.getParameter === 'function'
      ? (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null)
      : null;
  const maxPointSize = pointSizeRange ? pointSizeRange[1] : Infinity;

  // Commit the pending sprite batch with the CURRENTLY bound atlas. Called
  // from flush(), and from setTexture() before an atlas switch so sprites
  // batched against the previous raster aren't drawn with the new one — the
  // sprite-path counterpart of drawGlyphs()'s MSDF-atlas guard.
  const drawSprites = () => {
    if (spriteCount === 0 || !texture) return;
    const bytes = spriteCount * VERTS_PER_QUAD * PACKED_QUAD_VERT_STRIDE;
    gl.useProgram(spriteProgram);
    gl.bindVertexArray(spriteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, spriteData.u8.subarray(0, bytes), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(sUTex, 0);
    gl.uniform2f(sURes, logicalW, logicalH);
    ensureQuadIndices(spriteCount);
    gl.drawElements(gl.TRIANGLES, spriteCount * INDICES_PER_QUAD, gl.UNSIGNED_INT, 0);
    frameDrawCalls++;
    spriteCount = 0;
  };

  // Commit the pending glyph batch with the CURRENTLY bound MSDF atlas. Called
  // from flush(), and from setMSDFTexture() before an atlas switch so glyphs
  // batched against the previous font aren't drawn with the new one.
  const drawGlyphs = () => {
    if (glyphCount === 0 || !msdfTexture) return;
    const bytes = glyphCount * VERTS_PER_QUAD * PACKED_QUAD_VERT_STRIDE;
    gl.useProgram(msdfProgram);
    gl.bindVertexArray(glyphVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, glyphData.u8.subarray(0, bytes), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, msdfTexture);
    gl.uniform1i(gUTex, 0);
    gl.uniform2f(gURes, logicalW, logicalH);
    gl.uniform1f(gURange, distanceRange);
    ensureQuadIndices(glyphCount);
    gl.drawElements(gl.TRIANGLES, glyphCount * INDICES_PER_QUAD, gl.UNSIGNED_INT, 0);
    frameDrawCalls++;
    gl.bindVertexArray(null);
    glyphCount = 0;
  };

  const renderer: PointRenderer = {
    maxDPR: undefined,
    resize(width, height) {
      logicalW = width;
      logicalH = height;
      const realDpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio || 1 : 1;
      dpr = renderer.maxDPR !== undefined ? Math.min(realDpr, renderer.maxDPR) : realDpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    stats() {
      return {
        drawCalls: lastFrameDrawCalls,
        totalDrawCalls,
        atlasSwitches,
        // Fixed at creation: five programs compiled once, never per frame, so
        // these are capability facts rather than counters.
        programs: 5,
        textures: (texture ? 1 : 0) + (msdfTexture ? 1 : 0),
        circleQuadFallbacks,
        circlePoints,
      };
    },

    begin() {
      // The frame that just ended is the one a reader wants; capture it before
      // resetting. `flush()` is the wrong place — mid-frame commits mean flush can
      // run more than once per frame.
      lastFrameDrawCalls = frameDrawCalls;
      totalDrawCalls += frameDrawCalls;
      frameDrawCalls = 0;
      pointCount = 0;
      rectCount = 0;
      spriteCount = 0;
      glyphCount = 0;
      circleQuadCount = 0;
      // Clear at frame start (not in flush) so mid-frame batch commits — e.g.
      // a glyph draw forced by an MSDF atlas switch — survive to the end.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    setTexture(source) {
      if (source === textureSource && texture) return; // atlas unchanged: free
      // Same identity-cache hazard as setMSDFTexture: uploading a raster that
      // has not decoded would pin an empty texture forever. Skip so the next
      // frame retries. No in-repo caller passes an undecoded source today, but
      // this is public API and the sprite path has the identical shape.
      if (!isSourceReady(source)) return;
      // Different atlas: sprites already batched belong to the previous raster
      // — draw them with it before the upload replaces the texture contents.
      // Without this commit they would survive into flush() and be drawn
      // sampling the NEW atlas with the OLD UVs.
      drawSprites();
      if (!texture) {
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, texture);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      textureSource = source;
    },

    addSprite(x, y, width, height, u0, v0, u1, v1, color = '#ffffff', alpha = 1, rotation = 0) {
      if (!texture) return; // nothing to sample yet
      const stride = PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD;
      spriteData = growPacked(spriteData, (spriteCount + 1) * stride);
      const rgba = parseColorToRGBA(color);
      writeQuad(
        spriteData,
        spriteCount * stride,
        x,
        y,
        width,
        height,
        u0,
        v0,
        u1,
        v1,
        rgba[0],
        rgba[1],
        rgba[2],
        rgba[3] * alpha,
        rotation,
      );
      spriteCount++;
    },

    setMSDFTexture(source, range) {
      if (source === msdfSource && msdfTexture) {
        distanceRange = range;
        return; // same atlas re-set (entities do this every render): free
      }
      // Still decoding? Record nothing and upload nothing, so the next frame
      // retries. Caching an undecoded source here is what made MSDF text
      // permanently invisible — see isSourceReady. `distanceRange` is still
      // applied so the value is current the moment the atlas does land.
      if (!isSourceReady(source)) {
        distanceRange = range;
        return;
      }
      // Different atlas: glyphs already batched belong to the previous font —
      // draw them with it before the upload replaces the texture contents.
      atlasSwitches++;
      drawGlyphs();
      distanceRange = range;
      if (!msdfTexture) {
        msdfTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, msdfTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, msdfTexture);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      msdfSource = source;
    },

    addGlyph(x, y, width, height, u0, v0, u1, v1, color = '#ffffff', alpha = 1, rotation = 0) {
      if (!msdfTexture) return; // no glyph atlas yet
      const stride = PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD;
      glyphData = growPacked(glyphData, (glyphCount + 1) * stride);
      const rgba = parseColorToRGBA(color);
      writeQuad(
        glyphData,
        glyphCount * stride,
        x,
        y,
        width,
        height,
        u0,
        v0,
        u1,
        v1,
        rgba[0],
        rgba[1],
        rgba[2],
        rgba[3] * alpha,
        rotation,
      );
      glyphCount++;
    },

    addCircle(x, y, radius, color, alpha = 1) {
      // gl.POINTS cannot represent this circle when its center could clip
      // off-viewport (the whole disk pops) or its diameter exceeds the GPU
      // point-size cap (it silently shrinks) — carve it from a quad instead.
      const needsQuad =
        (logicalW > 0 &&
          (x < radius || y < radius || x > logicalW - radius || y > logicalH - radius)) ||
        radius * 2 * dpr > maxPointSize;
      if (needsQuad) {
        circleQuadFallbacks++;
        const stride = PACKED_QUAD_VERT_STRIDE * VERTS_PER_QUAD;
        circleQuadData = growPacked(circleQuadData, (circleQuadCount + 1) * stride);
        const rgba = parseColorToRGBA(color);
        const d = radius * 2;
        writeQuad(
          circleQuadData,
          circleQuadCount * stride,
          x - radius,
          y - radius,
          d,
          d,
          0,
          0,
          1,
          1,
          rgba[0],
          rgba[1],
          rgba[2],
          rgba[3] * alpha,
          0,
        );
        circleQuadCount++;
        return;
      }
      circlePoints++;
      pointData = grow(pointData, (pointCount + 1) * FLOATS_PER_POINT);
      const [r, g, b, a] = parseColorToRGBA(color);
      const o = pointCount * FLOATS_PER_POINT;
      pointData[o] = x;
      pointData[o + 1] = y;
      pointData[o + 2] = radius;
      pointData[o + 3] = r;
      pointData[o + 4] = g;
      pointData[o + 5] = b;
      pointData[o + 6] = a * alpha;
      pointCount++;
    },

    addRect(x, y, width, height, color, alpha = 1, rotation = 0) {
      const stride = PACKED_RECT_VERT_STRIDE * VERTS_PER_QUAD;
      rectData = growPacked(rectData, (rectCount + 1) * stride);
      const rgba = parseColorToRGBA(color);
      writeRectQuad(
        rectData,
        rectCount * stride,
        x,
        y,
        width,
        height,
        rgba[0],
        rgba[1],
        rgba[2],
        rgba[3] * alpha,
        rotation,
      );
      rectCount++;
    },

    flush() {
      if (rectCount > 0) {
        const bytes = rectCount * VERTS_PER_QUAD * PACKED_RECT_VERT_STRIDE;
        gl.useProgram(rectProgram);
        gl.bindVertexArray(rectVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, rectData.u8.subarray(0, bytes), gl.DYNAMIC_DRAW);
        gl.uniform2f(rURes, logicalW, logicalH);
        ensureQuadIndices(rectCount);
        gl.drawElements(gl.TRIANGLES, rectCount * INDICES_PER_QUAD, gl.UNSIGNED_INT, 0);
        frameDrawCalls++;
      }

      if (pointCount > 0) {
        gl.useProgram(pointProgram);
        gl.bindVertexArray(pointVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          pointData.subarray(0, pointCount * FLOATS_PER_POINT),
          gl.DYNAMIC_DRAW,
        );
        gl.uniform2f(pURes, logicalW, logicalH);
        gl.uniform1f(pUDpr, dpr);
        gl.drawArrays(gl.POINTS, 0, pointCount);
        frameDrawCalls++;
      }

      if (circleQuadCount > 0) {
        const bytes = circleQuadCount * VERTS_PER_QUAD * PACKED_QUAD_VERT_STRIDE;
        gl.useProgram(circleQuadProgram);
        gl.bindVertexArray(circleQuadVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, circleQuadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, circleQuadData.u8.subarray(0, bytes), gl.DYNAMIC_DRAW);
        gl.uniform2f(cURes, logicalW, logicalH);
        ensureQuadIndices(circleQuadCount);
        gl.drawElements(gl.TRIANGLES, circleQuadCount * INDICES_PER_QUAD, gl.UNSIGNED_INT, 0);
        frameDrawCalls++;
      }

      if (spriteCount > 0 && texture) {
        drawSprites();
      }

      gl.bindVertexArray(null);
      drawGlyphs();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(rectBuffer);
      gl.deleteBuffer(spriteBuffer);
      gl.deleteBuffer(glyphBuffer);
      gl.deleteBuffer(circleQuadBuffer);
      gl.deleteBuffer(quadIndexBuffer);
      gl.deleteVertexArray(pointVAO);
      gl.deleteVertexArray(rectVAO);
      gl.deleteVertexArray(spriteVAO);
      gl.deleteVertexArray(glyphVAO);
      gl.deleteVertexArray(circleQuadVAO);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(rectProgram);
      gl.deleteProgram(spriteProgram);
      gl.deleteProgram(msdfProgram);
      gl.deleteProgram(circleQuadProgram);
      if (texture) gl.deleteTexture(texture);
      if (msdfTexture) gl.deleteTexture(msdfTexture);
    },
  };
  return renderer;
}
