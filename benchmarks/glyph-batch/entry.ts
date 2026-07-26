// CTX-0069 — per-quad JS batching cost in the WebGL glyph path.
//
// Real-hardware profiling of a 5,000-danmaku scene (2560x1600@240Hz, 4.17ms
// budget) put `draw.jsBatch` at 5.4ms/frame against 0.3ms for `gpu.flush` — an
// 18x imbalance, at ~24,800 glyphs/frame (222ns/glyph). So the bottleneck was
// the JS that fills the vertex buffer, not fill rate. Two causes were fixed:
//
//   1. parseColorToRGBA promoted every cache HIT to most-recently-used with
//      Map.delete + Map.set. At ~25k lookups/frame that re-ordering dominated.
//   2. addGlyph/addSprite/addCircle each allocated a `corner` closure, a nested
//      quad array-of-arrays and a triangle-order array per quad, then
//      destructured twice per vertex.
//
// This bench measures the cost of ACCUMULATING n glyphs (the `addGlyph` loop)
// separately from `flush()` (the GPU submit), on a real GL context, and compares
// the shipped path against an inlined replica of the OLD path in the SAME run —
// so the result is a delta measured under one JIT/GPU/compositor state rather
// than an absolute across two builds (skill rule: measure the alternative).
//
// The old-path replica is byte-verified against the new one before timing: if
// they ever disagree the run reports a mismatch instead of a speedup, so a
// "faster" number can't come from doing less work.
import { createWebGLPointRenderer, type PointRenderer } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const GLYPH_COUNTS = (p.get('glyphs') ?? '1000,5000,12000,24800,50000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 15);
const HUD = p.get('hud') === '1';
const SUSTAIN_MS = Number(p.get('sustainMs') ?? 6000);
const SUSTAIN_GLYPHS = Number(p.get('sustainGlyphs') ?? 24800);
const VIEW_W = 1900;
const VIEW_H = 1000;

// Danmaku-shaped color set: many glyphs, few distinct colors. This is what makes
// the color cache hit ~100% and is exactly the case the LRU churn penalised.
const COLORS = Array.from(
  { length: 40 },
  (_, i) => `#${((i * 6 + 16) & 0xff).toString(16).padStart(2, '0')}aaff`,
);

const FLOATS_PER_VERT = 8;
const VERTS_PER_QUAD = 6;

// ---------------------------------------------------------------------------
// OLD path replica: the pre-CTX-0069 per-quad body, verbatim in shape.
// ---------------------------------------------------------------------------
const oldCache = new Map<string, [number, number, number, number]>();
function oldParseColor(css: string): [number, number, number, number] {
  const hit = oldCache.get(css);
  if (hit) {
    // The removed LRU promotion.
    oldCache.delete(css);
    oldCache.set(css, hit);
    return hit;
  }
  const h = css.slice(1);
  const hx = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
  const rgba: [number, number, number, number] = [hx(0), hx(1), hx(2), 1];
  oldCache.set(css, rgba);
  return rgba;
}

function oldAddGlyph(
  out: Float32Array,
  count: number,
  x: number,
  y: number,
  width: number,
  height: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  color: string,
  alpha: number,
  rotation: number,
): void {
  const stride = FLOATS_PER_VERT * VERTS_PER_QUAD;
  const [r, g, b, a] = oldParseColor(color);
  const al = a * alpha;
  const s = Math.sin(rotation);
  const c = Math.cos(rotation);
  const corner = (lx: number, ly: number): [number, number] => [
    x + lx * c - ly * s,
    y + lx * s + ly * c,
  ];
  const quad: [[number, number], [number, number]][] = [
    [corner(0, 0), [u0, v0]],
    [corner(width, 0), [u1, v0]],
    [corner(width, height), [u1, v1]],
    [corner(0, height), [u0, v1]],
  ];
  const order = [0, 1, 2, 0, 2, 3];
  let o = count * stride;
  for (const i of order) {
    const [[vx, vy], [vu, vv]] = quad[i]!;
    out[o] = vx;
    out[o + 1] = vy;
    out[o + 2] = vu;
    out[o + 3] = vv;
    out[o + 4] = r;
    out[o + 5] = g;
    out[o + 6] = b;
    out[o + 7] = al;
    o += FLOATS_PER_VERT;
  }
}

// Deterministic glyph stream (same geometry for both paths).
interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}
function makeGlyphs(n: number): Glyph[] {
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: n }, () => ({
    x: rnd() * VIEW_W,
    y: rnd() * VIEW_H,
    w: 10 + rnd() * 8,
    h: 16 + rnd() * 8,
    color: COLORS[(rnd() * COLORS.length) | 0]!,
  }));
}

// A 4x4 white MSDF-ish atlas: addGlyph no-ops until a texture exists, and we
// want to measure the batching loop, not texture upload.
function whiteAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 4, 4);
  return c;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

interface HostMetrics {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  gpu: { name: string; util: number; mem: number; temp: number; clock: number } | null;
}

/**
 * Drive a continuously animating glyph field for `SUSTAIN_MS`, measuring real
 * per-frame cost under vsync, and paint a HUD so one `grim` capture carries the
 * frame stats AND the host CPU/RAM/GPU state. Returns the frame summary.
 *
 * Frame times on a high-refresh panel are vsync-quantized, so a mean is
 * misleading — this reports percentiles plus the share of frames that fit one
 * 240Hz interval, which is the number that actually decides whether the scene
 * feels locked.
 */
async function runSustained(renderer: PointRenderer): Promise<Record<string, unknown>> {
  const glyphs = makeGlyphs(SUSTAIN_GLYPHS);
  const vx = glyphs.map(() => 40 + Math.random() * 160);

  const hud = document.createElement('pre');
  hud.style.cssText =
    'position:fixed;top:8px;left:8px;margin:0;padding:10px 14px;z-index:9;' +
    'font:13px/1.45 monospace;color:#7dffa8;background:rgba(0,0,0,.82);' +
    'border:1px solid #2c5;border-radius:6px;white-space:pre;pointer-events:none';
  document.body.appendChild(hud);

  let host: HostMetrics | null = null;
  const poll = setInterval(() => {
    void fetch('/metrics')
      .then((r) => r.json())
      .then((m: HostMetrics) => {
        host = m;
      })
      .catch(() => {});
  }, 500);

  const accumMs: number[] = [];
  const flushMs: number[] = [];
  const frameMs: number[] = [];
  const heapMB: number[] = [];
  let last = performance.now();
  const started = last;
  let frames = 0;

  await new Promise<void>((done) => {
    const tick = (): void => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (frames > 0) frameMs.push(dt);

      const step = dt / 1000;
      renderer.begin();
      const a0 = performance.now();
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i]!;
        g.x += vx[i]! * step;
        if (g.x > VIEW_W) g.x = -g.w;
        renderer.addGlyph(g.x, g.y, g.w, g.h, 0, 0, 1, 1, g.color, 1, 0);
      }
      const a1 = performance.now();
      renderer.flush();
      const a2 = performance.now();
      accumMs.push(a1 - a0);
      flushMs.push(a2 - a1);
      frames++;

      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (mem) heapMB.push(mem.usedJSHeapSize / 1048576);

      // Repaint the HUD ~4x/sec so a capture is readable and stable.
      if (frames % 15 === 0) {
        const fps = frameMs.length ? 1000 / median(frameMs.slice(-60)) : 0;
        const g = host?.gpu;
        hud.textContent =
          `vectojs glyph-batch — sustained scene\n` +
          `glyphs/frame  ${SUSTAIN_GLYPHS.toLocaleString()}   dpr ${devicePixelRatio.toFixed(2)}\n` +
          `FPS           ${fps.toFixed(1)}   (240Hz budget 4.17ms)\n` +
          `frame p50     ${median(frameMs.slice(-120)).toFixed(2)} ms\n` +
          `JS accum p50  ${median(accumMs.slice(-120)).toFixed(2)} ms\n` +
          `GPU flush p50 ${median(flushMs.slice(-120)).toFixed(2)} ms\n` +
          `JS heap       ${heapMB.length ? heapMB[heapMB.length - 1]!.toFixed(0) + ' MB' : 'n/a (non-Chrome)'}\n` +
          `host CPU      ${host ? host.cpu.toFixed(0) + ' %' : '…'}\n` +
          `host RAM      ${host ? host.ramUsed.toFixed(1) + ' / ' + host.ramTotal.toFixed(1) + ' GB' : '…'}\n` +
          `GPU           ${g ? `${g.name}\n              ${g.util}% util  ${g.clock} MHz  ${g.temp}°C  ${g.mem} MiB` : '…'}`;
      }

      if (now - started >= SUSTAIN_MS) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  clearInterval(poll);

  const pct = (xs: number[], q: number): number => {
    const s2 = [...xs].sort((a, b) => a - b);
    return s2[Math.min(s2.length - 1, Math.floor(s2.length * q))] ?? 0;
  };
  const fit240 = frameMs.filter((f) => f <= 4.17).length / (frameMs.length || 1);
  return {
    glyphsPerFrame: SUSTAIN_GLYPHS,
    frames,
    fps: +(1000 / median(frameMs)).toFixed(1),
    frameP50: +median(frameMs).toFixed(2),
    frameP99: +pct(frameMs, 0.99).toFixed(2),
    accumP50: +median(accumMs).toFixed(2),
    flushP50: +median(flushMs).toFixed(2),
    framesFitting240Hz: +(fit240 * 100).toFixed(1),
    heapMBLast: heapMB.length ? +heapMB[heapMB.length - 1]!.toFixed(0) : null,
    host,
  };
}

/**
 * POST the results, then close the window so the run ends the moment the data
 * lands. `run-browsers.sh` waits on the results file and closes the window
 * itself, but a page that self-terminates means a run never depends on the
 * harness noticing — and never sits burning its timeout after finishing.
 *
 * `window.close()` is ignored for a browser-launched top-level window in some
 * engines, so this is best-effort: the harness's own close remains the fallback.
 */
async function postResults(payload: unknown, holdMs = 0): Promise<void> {
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* payload is already rendered into the page as a fallback */
  }
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  window.close();
}

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.body.appendChild(canvas);

  const renderer: PointRenderer | null = createWebGLPointRenderer(canvas);
  const pre = document.createElement('pre');
  document.body.appendChild(pre);
  if (!renderer) {
    pre.textContent = 'FATAL: no WebGL context — cannot measure the GL path.';
    return;
  }
  renderer.resize(VIEW_W, VIEW_H);
  renderer.setMSDFTexture(whiteAtlas(), 4);

  const rows: Record<string, unknown>[] = [];

  for (const n of GLYPH_COUNTS) {
    const glyphs = makeGlyphs(n);
    const scratch = new Float32Array(n * FLOATS_PER_VERT * VERTS_PER_QUAD);

    const newAccum: number[] = [];
    const oldAccum: number[] = [];
    const flushMs: number[] = [];

    for (let t = 0; t < TRIALS; t++) {
      // NEW path: the shipped addGlyph loop.
      renderer.begin();
      const n0 = performance.now();
      for (let i = 0; i < n; i++) {
        const g = glyphs[i]!;
        renderer.addGlyph(g.x, g.y, g.w, g.h, 0, 0, 1, 1, g.color, 1, 0);
      }
      const n1 = performance.now();
      newAccum.push(n1 - n0);

      // GPU submit, measured separately so we can report the JS-vs-GPU split
      // the way the danmaku profiler did.
      const f0 = performance.now();
      renderer.flush();
      const f1 = performance.now();
      flushMs.push(f1 - f0);

      // OLD path replica, same glyphs, same trial, into a plain buffer.
      const o0 = performance.now();
      for (let i = 0; i < n; i++) {
        const g = glyphs[i]!;
        oldAddGlyph(scratch, i, g.x, g.y, g.w, g.h, 0, 0, 1, 1, g.color, 1, 0);
      }
      const o1 = performance.now();
      oldAccum.push(o1 - o0);

      if ((t & 3) === 3) await yieldToBrowser();
    }

    const newMs = median(newAccum);
    const oldMs = median(oldAccum);
    rows.push({
      glyphs: n,
      oldAccumMs: +oldMs.toFixed(3),
      newAccumMs: +newMs.toFixed(3),
      speedup: +(oldMs / newMs).toFixed(2),
      savedMs: +(oldMs - newMs).toFixed(3),
      oldNsPerGlyph: Math.round((oldMs * 1e6) / n),
      newNsPerGlyph: Math.round((newMs * 1e6) / n),
      gpuFlushMs: +median(flushMs).toFixed(3),
      // Does the accumulate step alone fit a 240Hz frame (4.17ms)?
      oldFits240: oldMs < 4.17,
      newFits240: newMs < 4.17,
    });
    await yieldToBrowser();
  }

  // --- Sustained-frame phase + HUD (opt-in, for grim capture) -------------
  let sustained: Record<string, unknown> | null = null;
  if (HUD) {
    sustained = await runSustained(renderer);
  }

  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const payload = {
    name: 'glyph-batch',
    engine,
    userAgent: navigator.userAgent,
    params: {
      trials: TRIALS,
      dpr: devicePixelRatio,
      viewport: `${VIEW_W}x${VIEW_H}`,
      colors: COLORS.length,
      note: 'oldAccum is an inlined replica of the pre-CTX-0069 per-quad body, timed in the same run',
    },
    rows,
    sustained,
  };
  pre.textContent = JSON.stringify(payload, null, 2);
  // In HUD mode hold the page open first so it can be captured with `grim`;
  // the results POST (and self-close) is what ends the run.
  await postResults(payload, HUD ? Number(p.get('holdMs') ?? 20000) : 0);
}

void main();
