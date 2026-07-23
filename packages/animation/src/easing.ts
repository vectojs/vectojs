// packages/core/src/animation/easing.ts
/** An easing function: maps normalized time t in [0,1] to eased progress. */
export type EasingFn = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;

/** Curated easing set. Add sparingly — every entry must map f(0)=0, f(1)=1. */
export const Easing = {
  linear: (t: number): number => t,
  easeInQuad: (t: number): number => t * t,
  easeOutQuad: (t: number): number => t * (2 - t),
  easeInOutQuad: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: (t: number): number => t * t * t,
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutBack: (t: number): number => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  easeInOutBack: (t: number): number => {
    const c2 = c1 * 1.525;
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
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
