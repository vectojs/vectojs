import { parseColorToRGBA } from './colorParse';

/**
 * A GPU-accelerated layer that draws large sets of circles and rectangles in a
 * couple of draw calls. Used by {@link Scene} (via `pointBackend: 'webgl'`) to
 * render `getBatchCircle()` / `getBatchRect()` entities — the point-cloud /
 * particle case where Canvas2D tops out at ~7 fps for 100k primitives.
 */
export interface PointRenderer {
  /** Resize the backing buffer + GL viewport to a logical `w × h` (DPR applied). */
  resize(width: number, height: number): void;
  /** Begin a frame: reset the accumulated primitive buffers. */
  begin(): void;
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
  /** Clear the layer and draw all accumulated primitives. */
  flush(): void;
  /** Release GL resources. */
  destroy(): void;
}

const FLOATS_PER_POINT = 7; // x, y, radius, r, g, b, a
const POINT_STRIDE = FLOATS_PER_POINT * 4;
// Rectangles are batched as expanded triangles (6 vertices/rect) rather than
// instanced quads: a plain drawArrays(TRIANGLES) is far faster than
// drawArraysInstanced on software GL, and equivalent on hardware. Each vertex
// carries world position + color (6 floats).
const FLOATS_PER_RECT_VERT = 6; // x, y, r, g, b, a
const RECT_VERT_STRIDE = FLOATS_PER_RECT_VERT * 4;
const VERTS_PER_RECT = 6; // two triangles
// Sprites: same expanded-triangle batch, plus UVs to sample a texture atlas and
// a multiply tint. Each vertex: x, y, u, v, r, g, b, a.
const FLOATS_PER_SPRITE_VERT = 8;
const SPRITE_VERT_STRIDE = FLOATS_PER_SPRITE_VERT * 4;
const VERTS_PER_SPRITE = 6;

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

function grow(data: Float32Array, needed: number): Float32Array {
  if (needed <= data.length) return data;
  let cap = data.length;
  while (cap < needed) cap *= 2;
  const grown = new Float32Array(cap);
  grown.set(data);
  return grown;
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
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return null;

  const pointProgram = link(gl, POINT_VERT, POINT_FRAG);
  const rectProgram = link(gl, RECT_VERT, RECT_FRAG);
  const spriteProgram = link(gl, SPRITE_VERT, SPRITE_FRAG);
  if (!pointProgram || !rectProgram || !spriteProgram) return null;

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
  gl.vertexAttribPointer(rAPos, 2, gl.FLOAT, false, RECT_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(rAColor);
  gl.vertexAttribPointer(rAColor, 4, gl.FLOAT, false, RECT_VERT_STRIDE, 8);

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
  gl.vertexAttribPointer(sAPos, 2, gl.FLOAT, false, SPRITE_VERT_STRIDE, 0);
  gl.enableVertexAttribArray(sAUv);
  gl.vertexAttribPointer(sAUv, 2, gl.FLOAT, false, SPRITE_VERT_STRIDE, 8);
  gl.enableVertexAttribArray(sATint);
  gl.vertexAttribPointer(sATint, 4, gl.FLOAT, false, SPRITE_VERT_STRIDE, 16);
  gl.bindVertexArray(null);

  let texture: WebGLTexture | null = null;

  let pointData: Float32Array = new Float32Array(FLOATS_PER_POINT * 1024);
  let pointCount = 0;
  let rectData: Float32Array = new Float32Array(FLOATS_PER_RECT_VERT * VERTS_PER_RECT * 256);
  let rectCount = 0;
  let spriteData: Float32Array = new Float32Array(FLOATS_PER_SPRITE_VERT * VERTS_PER_SPRITE * 256);
  let spriteCount = 0;
  let logicalW = 0;
  let logicalH = 0;
  let dpr = 1;

  return {
    resize(width, height) {
      logicalW = width;
      logicalH = height;
      dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio || 1 : 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    },

    begin() {
      pointCount = 0;
      rectCount = 0;
      spriteCount = 0;
    },

    setTexture(source) {
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
    },

    addSprite(x, y, width, height, u0, v0, u1, v1, color = '#ffffff', alpha = 1, rotation = 0) {
      if (!texture) return; // nothing to sample yet
      const stride = FLOATS_PER_SPRITE_VERT * VERTS_PER_SPRITE;
      spriteData = grow(spriteData, (spriteCount + 1) * stride);
      const [r, g, b, a] = parseColorToRGBA(color);
      const al = a * alpha;
      const s = Math.sin(rotation);
      const c = Math.cos(rotation);
      const corner = (lx: number, ly: number): [number, number] => [
        x + lx * c - ly * s,
        y + lx * s + ly * c,
      ];
      // Quad corners + their UVs (TL, TR, BR, BL).
      const quad: [[number, number], [number, number]][] = [
        [corner(0, 0), [u0, v0]],
        [corner(width, 0), [u1, v0]],
        [corner(width, height), [u1, v1]],
        [corner(0, height), [u0, v1]],
      ];
      const order = [0, 1, 2, 0, 2, 3]; // two triangles
      let o = spriteCount * stride;
      for (const i of order) {
        const [[vx, vy], [vu, vv]] = quad[i];
        spriteData[o] = vx;
        spriteData[o + 1] = vy;
        spriteData[o + 2] = vu;
        spriteData[o + 3] = vv;
        spriteData[o + 4] = r;
        spriteData[o + 5] = g;
        spriteData[o + 6] = b;
        spriteData[o + 7] = al;
        o += FLOATS_PER_SPRITE_VERT;
      }
      spriteCount++;
    },

    addCircle(x, y, radius, color, alpha = 1) {
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
      const stride = FLOATS_PER_RECT_VERT * VERTS_PER_RECT;
      rectData = grow(rectData, (rectCount + 1) * stride);
      const [r, g, b, a] = parseColorToRGBA(color);
      const al = a * alpha;
      // Four corners (top-left origin), rotated about (x, y).
      const s = Math.sin(rotation);
      const c = Math.cos(rotation);
      const corner = (lx: number, ly: number): [number, number] => [
        x + lx * c - ly * s,
        y + lx * s + ly * c,
      ];
      const p0 = corner(0, 0);
      const p1 = corner(width, 0);
      const p2 = corner(width, height);
      const p3 = corner(0, height);
      // Two triangles: p0,p1,p2 and p0,p2,p3.
      const verts = [p0, p1, p2, p0, p2, p3];
      let o = rectCount * stride;
      for (const [vx, vy] of verts) {
        rectData[o] = vx;
        rectData[o + 1] = vy;
        rectData[o + 2] = r;
        rectData[o + 3] = g;
        rectData[o + 4] = b;
        rectData[o + 5] = al;
        o += FLOATS_PER_RECT_VERT;
      }
      rectCount++;
    },

    flush() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (rectCount > 0) {
        const floats = rectCount * VERTS_PER_RECT * FLOATS_PER_RECT_VERT;
        gl.useProgram(rectProgram);
        gl.bindVertexArray(rectVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, rectData.subarray(0, floats), gl.DYNAMIC_DRAW);
        gl.uniform2f(rURes, logicalW, logicalH);
        gl.drawArrays(gl.TRIANGLES, 0, rectCount * VERTS_PER_RECT);
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
      }

      if (spriteCount > 0 && texture) {
        const floats = spriteCount * VERTS_PER_SPRITE * FLOATS_PER_SPRITE_VERT;
        gl.useProgram(spriteProgram);
        gl.bindVertexArray(spriteVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, spriteData.subarray(0, floats), gl.DYNAMIC_DRAW);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(sUTex, 0);
        gl.uniform2f(sURes, logicalW, logicalH);
        gl.drawArrays(gl.TRIANGLES, 0, spriteCount * VERTS_PER_SPRITE);
      }

      gl.bindVertexArray(null);
    },

    destroy() {
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(rectBuffer);
      gl.deleteBuffer(spriteBuffer);
      gl.deleteVertexArray(pointVAO);
      gl.deleteVertexArray(rectVAO);
      gl.deleteVertexArray(spriteVAO);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(rectProgram);
      gl.deleteProgram(spriteProgram);
      if (texture) gl.deleteTexture(texture);
    },
  };
}
