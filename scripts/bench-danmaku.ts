/**
 * Release gate for the animation system's one hot-path risk: converting
 * Entity's x/y/... to accessors could tax the Danmaku demo, whose `Danmaku`
 * comments extend core `Entity` and assign `.x` per comment per frame (up to
 * ~5000 x 60fps). This measures the accessor write path against a plain-field
 * control and asserts it stays a negligible fraction of a 60fps frame budget.
 *
 * Run: bun run scripts/bench-danmaku.ts
 */
import { Entity } from '../packages/core/src/tree/Entity';

// The accessor-backed entity (post animation system) — the Danmaku case.
class Dot extends Entity {
  speed = 0.05;
  isPointInside(): boolean {
    return false;
  }
  render(): void {}
}
// Control: a plain-field object — what Entity.x was BEFORE the accessor conversion.
class PlainDot {
  x = 0;
  speed = 0.05;
}

const N = 5000;
const FRAMES = 600;

function bench<T extends { x: number; speed: number }>(items: T[]): number {
  for (let f = 0; f < 60; f++) for (const d of items) d.x -= d.speed * 16; // warm JIT
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) for (const d of items) d.x -= d.speed * 16;
  return ((performance.now() - t0) / FRAMES) * 1000; // microseconds per frame
}

const accessorUs = bench(Array.from({ length: N }, () => new Dot()));
const plainUs = bench(Array.from({ length: N }, () => new PlainDot()));
const ratio = accessorUs / plainUs;

console.log(
  JSON.stringify({
    N,
    FRAMES,
    accessorUsPerFrame: +accessorUs.toFixed(2),
    plainFieldUsPerFrame: +plainUs.toFixed(2),
    ratio: +ratio.toFixed(2),
    frameBudget60fpsUs: 16667,
  }),
);

// Gate: 5000 accessor x-writes/frame must stay well under one 60fps frame budget,
// leaving the ~16ms for the real work (rasterization, layout).
if (accessorUs > 2000) {
  console.error(
    `REGRESSION: ${accessorUs.toFixed(0)}us/frame for ${N} accessor writes exceeds the 2000us gate`,
  );
  process.exit(1);
}
console.log(
  `PASS: ${accessorUs.toFixed(0)}us/frame for ${N} writes (${ratio.toFixed(1)}x plain field), within gate`,
);
