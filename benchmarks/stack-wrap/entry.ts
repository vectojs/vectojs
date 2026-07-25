// P2-F stack-wrap bench: total cost of building a WRAPPING, start-aligned Stack
// one child at a time (a streaming Flow of chips/tags), fast-append vs the old
// full-layout-per-add. add() to a wrapping Stack used to re-run the whole
// O(children) layout() on every call → O(N²) total; the fast path makes each
// append O(1) → O(N) total. We A/B the real add() (fast path) against a
// reference that forces a full layout() after each push (the pre-fix behavior),
// swept over child count. Posts JSON to /results (browser-bench contract).
import { Stack } from '@vectojs/ui';
import { Entity } from '@vectojs/core';

const p = new URLSearchParams(location.search);
const COUNTS = (p.get('counts') ?? '200,500,1000,2000,4000').split(',').map(Number);
const TRIALS = Number(p.get('trials') ?? 8);
const WRAP_LIMIT = 600;

class Box extends Entity {
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
  }
  isPointInside() {
    return false;
  }
  render() {}
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}
function sizes(n: number): Array<[number, number]> {
  const rand = rng(0xf10a);
  return Array.from({ length: n }, () => [
    16 + Math.floor(rand() * 60),
    12 + Math.floor(rand() * 24),
  ]);
}
function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

const opts = {
  direction: 'horizontal' as const,
  gap: 6,
  wrap: true,
  maxWidth: WRAP_LIMIT,
};

// FAST: real add() — each append takes the O(1) wrap fast path.
function benchFast(profile: Array<[number, number]>): number {
  const ts: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const stack = new Stack(opts);
    const t0 = performance.now();
    for (const [w, h] of profile) stack.add(new Box(w, h));
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

// REFERENCE (pre-fix): push the child then force a full layout() each time.
function benchFullLayout(profile: Array<[number, number]>): number {
  const ts: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const stack = new Stack(opts);
    const t0 = performance.now();
    for (const [w, h] of profile) {
      const c = new Box(w, h);
      (stack as unknown as { children: Entity[] }).children.push(c);
      (c as unknown as { parent: Entity }).parent = stack;
      stack.layout();
    }
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

async function main() {
  const engine = /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chrome';
  const rows = COUNTS.map((n) => {
    const profile = sizes(n);
    const fastMs = benchFast(profile);
    const fullMs = benchFullLayout(profile);
    return {
      children: n,
      fastAppendMs: +fastMs.toFixed(4),
      fullLayoutPerAddMs: +fullMs.toFixed(4),
      speedup: +(fullMs / fastMs).toFixed(1),
    };
  });
  const payload = {
    name: 'stack-wrap',
    engine,
    userAgent: navigator.userAgent,
    params: { COUNTS, TRIALS, WRAP_LIMIT },
    rows,
  };
  try {
    await fetch('/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore — table still shown below
  }
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

main();
