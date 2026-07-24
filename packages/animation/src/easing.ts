// packages/core/src/animation/easing.ts
/** An easing function: maps normalized time t in [0,1] to eased progress. */
export type EasingFn = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;

/** Curated easing set. Add sparingly — every entry must map f(0)=0, f(1)=1.
 *
 *  Integer powers are written as explicit multiplication (`x * x`, `x * x * x`)
 *  rather than `Math.pow(x, 2/3)`. `Math.pow` is not specified to be correctly
 *  rounded and V8/SpiderMonkey/JSC diverge in the last ULP for integer
 *  exponents, whereas IEEE-754 multiplication is deterministic on every engine.
 *  This also lets the WASM `ease()` kernel (crates/vectojs-core-rs/src/anim.rs)
 *  match these outputs **bit-for-bit** — it likewise uses plain multiplication,
 *  so the batched tween path is not merely close (~1e-9) but exactly equal. */
export const Easing = {
  linear: (t: number): number => t,
  easeInQuad: (t: number): number => t * t,
  easeOutQuad: (t: number): number => t * (2 - t),
  easeInOutQuad: (t: number): number => {
    if (t < 0.5) return 2 * t * t;
    const u = -2 * t + 2;
    return 1 - (u * u) / 2;
  },
  easeInCubic: (t: number): number => t * t * t,
  easeOutCubic: (t: number): number => {
    const u = 1 - t;
    return 1 - u * u * u;
  },
  easeInOutCubic: (t: number): number => {
    if (t < 0.5) return 4 * t * t * t;
    const u = -2 * t + 2;
    return 1 - (u * u * u) / 2;
  },
  easeOutBack: (t: number): number => {
    const u = t - 1;
    return 1 + c3 * (u * u * u) + c1 * (u * u);
  },
  easeInOutBack: (t: number): number => {
    const c2 = c1 * 1.525;
    if (t < 0.5) {
      const u = 2 * t;
      return (u * u * ((c2 + 1) * 2 * t - c2)) / 2;
    }
    const u = 2 * t - 2;
    return (u * u * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  },
} satisfies Record<string, EasingFn>;

/** Name of a built-in easing curve. */
export type EasingName = keyof typeof Easing;

/** Numeric id for each named easing, in the exact order `Easing` declares them.
 *  Mirrored by `ease()` in `crates/vectojs-core-rs/src/anim.rs` — the WASM
 *  batched-animation integration uses this to tell a "named easing" tween
 *  (batchable) from a custom `EasingFn` closure (which cannot cross into WASM
 *  and must stay on the JS tick path). Keep in sync with anim.rs by hand;
 *  there is no codegen link between the two. */
export const EASING_IDS: Record<EasingName, number> = Object.fromEntries(
  Object.keys(Easing).map((name, i) => [name, i]),
) as Record<EasingName, number>;
