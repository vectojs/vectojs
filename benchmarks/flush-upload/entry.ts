// CTX-0070 — where does flush() time go above the CPU/GPU crossover?
//
// CTX-0069 moved the bottleneck: at 50,000 quads on this GPU the JS accumulate
// phase is 2.38ms but the GPU submit is 4.48ms (Chrome). The findings doc says
// measure before changing anything, so this bench characterises the submit path
// and times candidate fixes against the CURRENT one, in the same run, on real
// hardware.
//
// The current submit per primitive type is:
//   bufferData(ARRAY_BUFFER, data.subarray(0, floats), DYNAMIC_DRAW)  // reallocates
//   drawArrays(TRIANGLES, 0, quads * 6)                               // 6 verts/quad
// with a 32-byte vertex (pos:2f + uv:2f + tint:4f). At 50k quads that is
// 50,000 x 6 x 32 = 9.6 MB uploaded per frame — 2.3 GB/s at 240Hz. Draw-call
// count is NOT the issue: flush() already issues at most one draw per primitive
// type.
//
// Variants measured (all draw the same pixels):
//   A baseline      bufferData + 6 verts/quad + 32B vertex        (9.6 MB @ 50k)
//   B subData       pre-sized bufferData(null) once, then
//                   bufferSubData each frame — no realloc/orphan  (9.6 MB)
//   C indexed       4 verts/quad + static ELEMENT_ARRAY index,
//                   drawElements — 33% fewer vertices             (6.4 MB)
//   D packed+idx    C plus a 16-byte vertex: pos 2xf32, uv
//                   2xu16-normalized, tint 4xu8-normalized        (3.2 MB)
//
// Timing: JS call-return time is NOT GPU time (GL is async), so where
// EXT_disjoint_timer_query_webgl2 is available we read real GPU nanoseconds.
// Chrome ships it behind a flag and Firefox generally does not expose it, so we
// also report a "pipeline-stalled" wall time (drawing then forcing completion
// with getError after a readPixels of 1 pixel) which serialises the frame and
// makes the submit cost observable without the extension. Both are reported so
// neither can be mistaken for the other.
import {
  awaitStart,
  reportFailure,
  reportResult,
  type BenchmarkResult,
} from '../_shared/client.ts';
import { median } from '../_shared/stats.ts';

const p = new URLSearchParams(location.search);
const QUAD_COUNTS = (p.get('quads') ?? '12000,24800,50000,100000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 12);
const VIEW_W = 1900;
const VIEW_H = 1000;

const VS_UNPACKED = `#version 300 es
in vec2 aPos; in vec2 aUv; in vec4 aTint;
uniform vec2 uRes;
out vec2 vUv; out vec4 vTint;
void main() {
  vUv = aUv; vTint = aTint;
  vec2 c = (aPos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vTint;
uniform sampler2D uTex;
out vec4 o;
void main() { o = texture(uTex, vUv) * vTint; }`;

function compile(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const mk = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  };
  const pr = gl.createProgram()!;
  gl.attachShader(pr, mk(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(pr));
  }
  return pr;
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Variant {
  key: string;
  label: string;
  bytesPerFrame: (n: number) => number;
  setup: (n: number) => void;
  frame: () => void;
  teardown: () => void;
}

/**
 * POST the results, then close the window so the run ends the moment the data
 * lands. `run-browsers.sh` waits on the results file and closes the window
 * itself, but a page that self-terminates means a run never depends on the
 * harness noticing — and never sits burning its timeout after finishing.
 *
 * `window.close()` is ignored for a browser-launched top-level window in some
 * engines, so this is best-effort: the harness's own close remains the fallback.
 *
 * The POST itself now goes through the shared client, which builds the full
 * envelope; `render` runs before the close because nothing after
 * `window.close()` is guaranteed to run.
 */
async function postResults(
  input: Parameters<typeof reportResult>[0],
  render: (result: BenchmarkResult) => void,
  holdMs = 0,
): Promise<void> {
  const result = await reportResult(input);
  render(result);
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  window.close();
}

async function main(): Promise<void> {
  await awaitStart();
  const startedAt = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.body.appendChild(canvas);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:12px monospace;white-space:pre';
  document.body.appendChild(pre);

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    pre.textContent = 'FATAL: no WebGL2';
    return;
  }

  // Real GPU timing if the driver/browser exposes it.
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;

  // A 4x4 white texture: we are measuring transfer + raster, not sampling.
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    4,
    4,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(4 * 4 * 4).fill(255),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.viewport(0, 0, VIEW_W, VIEW_H);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const progUnpacked = compile(gl, VS_UNPACKED, FS);
  const uResU = gl.getUniformLocation(progUnpacked, 'uRes');
  const uTexU = gl.getUniformLocation(progUnpacked, 'uTex');

  // Geometry shared by every variant, so all upload identical quads.
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const maxN = Math.max(...QUAD_COUNTS);
  const quads = Array.from({ length: maxN }, () => ({
    x: rnd() * VIEW_W,
    y: rnd() * VIEW_H,
    w: 10 + rnd() * 8,
    h: 16 + rnd() * 8,
    r: rnd(),
    g: rnd(),
    b: rnd(),
  }));

  const rows: Record<string, unknown>[] = [];

  for (const n of QUAD_COUNTS) {
    // ---- Build the four vertex layouts once per size ----------------------
    // A/B: 6 verts/quad, 8 floats each.
    const tri = new Float32Array(n * 6 * 8);
    // C: 4 verts/quad + index buffer.
    const quadVerts = new Float32Array(n * 4 * 8);
    const idx = new Uint32Array(n * 6);
    // D: 4 verts/quad, 16-byte vertex.
    const packed = new ArrayBuffer(n * 4 * 16);
    const pf32 = new Float32Array(packed);
    const pu16 = new Uint16Array(packed);
    const pu8 = new Uint8Array(packed);

    for (let i = 0; i < n; i++) {
      const q = quads[i]!;
      const cs: [number, number, number, number][] = [
        [q.x, q.y, 0, 0],
        [q.x + q.w, q.y, 1, 0],
        [q.x + q.w, q.y + q.h, 1, 1],
        [q.x, q.y + q.h, 0, 1],
      ];
      const order = [0, 1, 2, 0, 2, 3];
      for (let v = 0; v < 6; v++) {
        const c = cs[order[v]!]!;
        const o = (i * 6 + v) * 8;
        tri[o] = c[0];
        tri[o + 1] = c[1];
        tri[o + 2] = c[2];
        tri[o + 3] = c[3];
        tri[o + 4] = q.r;
        tri[o + 5] = q.g;
        tri[o + 6] = q.b;
        tri[o + 7] = 1;
      }
      for (let v = 0; v < 4; v++) {
        const c = cs[v]!;
        const o = (i * 4 + v) * 8;
        quadVerts[o] = c[0];
        quadVerts[o + 1] = c[1];
        quadVerts[o + 2] = c[2];
        quadVerts[o + 3] = c[3];
        quadVerts[o + 4] = q.r;
        quadVerts[o + 5] = q.g;
        quadVerts[o + 6] = q.b;
        quadVerts[o + 7] = 1;
        // packed: pos 2xf32 @0, uv 2xu16n @8, tint 4xu8n @12
        const b = (i * 4 + v) * 16;
        pf32[b / 4] = c[0];
        pf32[b / 4 + 1] = c[1];
        pu16[b / 2 + 4] = c[2] * 65535;
        pu16[b / 2 + 5] = c[3] * 65535;
        pu8[b + 12] = q.r * 255;
        pu8[b + 13] = q.g * 255;
        pu8[b + 14] = q.b * 255;
        pu8[b + 15] = 255;
      }
      const base = i * 4;
      const io = i * 6;
      idx[io] = base;
      idx[io + 1] = base + 1;
      idx[io + 2] = base + 2;
      idx[io + 3] = base;
      idx[io + 4] = base + 2;
      idx[io + 5] = base + 3;
    }

    // ---- Variant definitions ---------------------------------------------
    const mkUnpackedVAO = (buf: WebGLBuffer): WebGLVertexArrayObject => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const aPos = gl.getAttribLocation(progUnpacked, 'aPos');
      const aUv = gl.getAttribLocation(progUnpacked, 'aUv');
      const aTint = gl.getAttribLocation(progUnpacked, 'aTint');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 32, 8);
      gl.enableVertexAttribArray(aTint);
      gl.vertexAttribPointer(aTint, 4, gl.FLOAT, false, 32, 16);
      gl.bindVertexArray(null);
      return vao;
    };

    const variants: Variant[] = [];
    let buf: WebGLBuffer, vao: WebGLVertexArrayObject, ibo: WebGLBuffer;

    // A — current implementation.
    variants.push({
      key: 'A_bufferData_6v_32B',
      label: 'baseline: bufferData + 6 verts + 32B',
      bytesPerFrame: (k) => k * 6 * 32,
      setup() {
        buf = gl.createBuffer()!;
        vao = mkUnpackedVAO(buf);
      },
      frame() {
        gl.useProgram(progUnpacked);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, tri.subarray(0, n * 6 * 8), gl.DYNAMIC_DRAW);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(uTexU, 0);
        gl.uniform2f(uResU, VIEW_W, VIEW_H);
        gl.drawArrays(gl.TRIANGLES, 0, n * 6);
        gl.bindVertexArray(null);
      },
      teardown() {
        gl.deleteBuffer(buf);
        gl.deleteVertexArray(vao);
      },
    });

    // B — pre-sized buffer + bufferSubData (no per-frame reallocation).
    variants.push({
      key: 'B_subData_6v_32B',
      label: 'bufferSubData into pre-sized buffer',
      bytesPerFrame: (k) => k * 6 * 32,
      setup() {
        buf = gl.createBuffer()!;
        vao = mkUnpackedVAO(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, n * 6 * 32, gl.DYNAMIC_DRAW);
      },
      frame() {
        gl.useProgram(progUnpacked);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tri.subarray(0, n * 6 * 8));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(uTexU, 0);
        gl.uniform2f(uResU, VIEW_W, VIEW_H);
        gl.drawArrays(gl.TRIANGLES, 0, n * 6);
        gl.bindVertexArray(null);
      },
      teardown() {
        gl.deleteBuffer(buf);
        gl.deleteVertexArray(vao);
      },
    });

    // C — indexed: 4 verts/quad, static index buffer uploaded once.
    variants.push({
      key: 'C_indexed_4v_32B',
      label: 'indexed drawElements, 4 verts + static IBO',
      bytesPerFrame: (k) => k * 4 * 32,
      setup() {
        buf = gl.createBuffer()!;
        vao = mkUnpackedVAO(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, n * 4 * 32, gl.DYNAMIC_DRAW);
        ibo = gl.createBuffer()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
      },
      frame() {
        gl.useProgram(progUnpacked);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadVerts.subarray(0, n * 4 * 8));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(uTexU, 0);
        gl.uniform2f(uResU, VIEW_W, VIEW_H);
        gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
      },
      teardown() {
        gl.deleteBuffer(buf);
        gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);
      },
    });

    // D — indexed + 16-byte vertex (half the bytes of C, a third of A).
    variants.push({
      key: 'D_indexed_4v_16B',
      label: 'indexed + packed 16B vertex (u16 uv, u8 tint)',
      bytesPerFrame: (k) => k * 4 * 16,
      setup() {
        buf = gl.createBuffer()!;
        vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, n * 4 * 16, gl.DYNAMIC_DRAW);
        const aPos = gl.getAttribLocation(progUnpacked, 'aPos');
        const aUv = gl.getAttribLocation(progUnpacked, 'aUv');
        const aTint = gl.getAttribLocation(progUnpacked, 'aTint');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.UNSIGNED_SHORT, true, 16, 8);
        gl.enableVertexAttribArray(aTint);
        gl.vertexAttribPointer(aTint, 4, gl.UNSIGNED_BYTE, true, 16, 12);
        ibo = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
      },
      frame() {
        gl.useProgram(progUnpacked);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(packed, 0, n * 4 * 16));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(uTexU, 0);
        gl.uniform2f(uResU, VIEW_W, VIEW_H);
        gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
      },
      teardown() {
        gl.deleteBuffer(buf);
        gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);
      },
    });

    for (const v of variants) {
      v.setup(n);

      // Warm up: first use of a buffer/VAO pays one-time driver cost.
      for (let i = 0; i < 3; i++) v.frame();
      gl.finish();

      const submitMs: number[] = []; // JS call-return (what our profiler sees)
      const stalledMs: number[] = []; // pipeline forced to drain
      const gpuMs: number[] = []; // real GPU ns, when available

      for (let t = 0; t < TRIALS; t++) {
        gl.clear(gl.COLOR_BUFFER_BIT);

        // (1) JS-visible submit cost.
        const s0 = performance.now();
        v.frame();
        const s1 = performance.now();
        submitMs.push(s1 - s0);

        // (2) Same work, then force the pipeline to finish so the wall time
        // includes the GPU. gl.finish() is the honest way to attribute it.
        const w0 = performance.now();
        v.frame();
        gl.finish();
        const w1 = performance.now();
        stalledMs.push(w1 - w0);

        // (3) Real GPU time if the extension exists.
        if (timerExt) {
          const q = gl.createQuery()!;
          gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
          v.frame();
          gl.endQuery(timerExt.TIME_ELAPSED_EXT);
          gl.finish();
          const avail = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
          const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT) as boolean;
          if (avail && !disjoint) {
            gpuMs.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6);
          }
          gl.deleteQuery(q);
        }

        if ((t & 3) === 3) await yieldToBrowser();
      }

      const mb = v.bytesPerFrame(n) / 1048576;
      rows.push({
        quads: n,
        variant: v.key,
        label: v.label,
        mbPerFrame: +mb.toFixed(2),
        submitMs: +median(submitMs).toFixed(3),
        stalledMs: +median(stalledMs).toFixed(3),
        gpuMs: gpuMs.length ? +median(gpuMs).toFixed(3) : null,
        // Effective upload bandwidth implied by the stalled time.
        gbPerSec: +(mb / 1024 / (median(stalledMs) / 1000)).toFixed(2),
      });

      v.teardown();
      await yieldToBrowser();
    }

    // Render progress so a mid-run screenshot is informative.
    pre.textContent = `measured ${n} quads…\n` + JSON.stringify(rows.slice(-4), null, 1);
  }

  await postResults(
    {
      name: 'flush-upload',
      // `dpr`/`viewport` stay in params as deliberate duplication of the
      // envelope's own fields, so the params shape stays comparable.
      params: {
        trials: TRIALS,
        dpr: devicePixelRatio,
        viewport: `${VIEW_W}x${VIEW_H}`,
        gpuTimerAvailable: !!timerExt,
        renderer:
          (gl.getExtension('WEBGL_debug_renderer_info') &&
            (gl.getParameter(
              (
                gl.getExtension('WEBGL_debug_renderer_info') as {
                  UNMASKED_RENDERER_WEBGL: number;
                }
              ).UNMASKED_RENDERER_WEBGL,
            ) as string)) ||
          null,
        note: 'submitMs = JS call-return (async, understates GPU); stalledMs = same work + gl.finish(); gpuMs = EXT_disjoint_timer_query_webgl2 when present',
      },
      rows,
      durationMs: +(performance.now() - startedAt).toFixed(1),
    },
    (result) => {
      pre.textContent = JSON.stringify(result, null, 2);
    },
  );
}

main().catch((error) => reportFailure('flush-upload', error));
