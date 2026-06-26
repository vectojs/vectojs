import { parseColorToRGBA } from './colorParse';

/**
 * A GPU-accelerated layer that draws a large set of filled circles in a single
 * draw call. Used by {@link Scene} (via `pointBackend: 'webgl'`) to render
 * `getBatchCircle()` entities — the point-cloud / particle case where Canvas2D
 * tops out at ~7 fps for 100k circles.
 */
export interface PointRenderer {
  /** Resize the backing buffer + GL viewport to a logical `w × h` (DPR applied). */
  resize(width: number, height: number): void;
  /** Begin a frame: reset the accumulated point buffer. */
  begin(): void;
  /** Add one circle in world (CSS-pixel) coordinates; `alpha` multiplies the color's. */
  addCircle(x: number, y: number, radius: number, color: string, alpha?: number): void;
  /** Clear the layer and draw all accumulated circles in one `drawArrays`. */
  flush(): void;
  /** Release GL resources. */
  destroy(): void;
}

const FLOATS_PER_POINT = 7; // x, y, radius, r, g, b, a
const STRIDE = FLOATS_PER_POINT * 4; // bytes

const VERT_SRC = `#version 300 es
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

const FRAG_SRC = `#version 300 es
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

  const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
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

  const aPos = gl.getAttribLocation(program, 'a_pos');
  const aRadius = gl.getAttribLocation(program, 'a_radius');
  const aColor = gl.getAttribLocation(program, 'a_color');
  const uResolution = gl.getUniformLocation(program, 'u_resolution');
  const uDpr = gl.getUniformLocation(program, 'u_dpr');
  const vbo = gl.createBuffer();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let data = new Float32Array(FLOATS_PER_POINT * 1024);
  let count = 0;
  let logicalW = 0;
  let logicalH = 0;
  let dpr = 1;

  const ensure = (points: number) => {
    const needed = points * FLOATS_PER_POINT;
    if (needed <= data.length) return;
    let cap = data.length;
    while (cap < needed) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(data);
    data = grown;
  };

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
      count = 0;
    },

    addCircle(x, y, radius, color, alpha = 1) {
      ensure(count + 1);
      const [r, g, b, a] = parseColorToRGBA(color);
      const o = count * FLOATS_PER_POINT;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = radius;
      data[o + 3] = r;
      data[o + 4] = g;
      data[o + 5] = b;
      data[o + 6] = a * alpha;
      count++;
    },

    flush() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (count === 0) return;

      gl.useProgram(program);
      gl.uniform2f(uResolution, logicalW, logicalH);
      gl.uniform1f(uDpr, dpr);

      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * FLOATS_PER_POINT), gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(aRadius);
      gl.vertexAttribPointer(aRadius, 1, gl.FLOAT, false, STRIDE, 8);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, STRIDE, 12);

      gl.drawArrays(gl.POINTS, 0, count);
    },

    destroy() {
      gl.deleteBuffer(vbo);
      gl.deleteProgram(program);
    },
  };
}
