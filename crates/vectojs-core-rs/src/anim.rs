//! G2 spike — batched animation driver kernels (spring + tween), SoA, scalar.
//!
//! This is a **measurement spike**, not an integrated backend: it exists so
//! `benchmarks/anim-wasm` can find the driver-count crossover where advancing all
//! active drivers in one WASM call beats the JS `driver.tick()` loop. In real UIs
//! the active-driver count is usually small, so unlike the transform core (100k
//! nodes every frame) this only pays off for mass animation — the number decides
//! whether G2 integrates.
//!
//! Scalar on purpose. It is the fair "batched, no per-driver JS dispatch"
//! comparison and keeps the spring **bit-identical** to `@vectojs/math`
//! `SpringPhysics` (pure arithmetic, same op order). The tween is only
//! close-to-identical: its cubic/back easings use `Math.pow(_, 3)` on the JS
//! side, which Rust's `powi`/`powf` do not reproduce to the last ULP — a real
//! parity limit worth recording before committing to a tween WASM path.
//!
//! Separate SoA + `static mut` from the transform `Store`; nothing here touches
//! that path. Same raw C-ABI convention (leak arrays, export pointers).

use core::ptr;
use std::alloc::{Layout, alloc_zeroed};

use crate::SIMD_ALIGN;

// SpringPhysics constants — must match packages/math/src/SpringPhysics.ts exactly.
const MAX_FRAME_DT: f64 = 0.25; // seconds simulated per update() call
const MAX_STEP_DT: f64 = 1.0 / 120.0;
const VAL_EPSILON: f64 = 0.005;
const VEL_EPSILON: f64 = 0.005;

struct Anim {
    // Spring SoA (updated in place; value + velocity are state).
    s_val: *mut f64,
    s_target: *mut f64,
    s_vel: *mut f64,
    s_stiff: *mut f64,
    s_damp: *mut f64,
    s_mass: *mut f64,

    // Tween SoA. `t_elapsed` is state (advanced each step); `t_val` is output.
    t_from: *mut f64,
    t_to: *mut f64,
    t_elapsed: *mut f64,
    t_dur: *mut f64,
    t_delay: *mut f64,
    t_ease: *mut f64, // easing id, stored as f64 (0..=8), truncated on read
    t_val: *mut f64,
}

static mut A: Anim = Anim {
    s_val: ptr::null_mut(),
    s_target: ptr::null_mut(),
    s_vel: ptr::null_mut(),
    s_stiff: ptr::null_mut(),
    s_damp: ptr::null_mut(),
    s_mass: ptr::null_mut(),
    t_from: ptr::null_mut(),
    t_to: ptr::null_mut(),
    t_elapsed: ptr::null_mut(),
    t_dur: ptr::null_mut(),
    t_delay: ptr::null_mut(),
    t_ease: ptr::null_mut(),
    t_val: ptr::null_mut(),
};

fn leak_f64(n: usize) -> *mut f64 {
    let layout = Layout::from_size_align(n * size_of::<f64>(), SIMD_ALIGN).expect("valid layout");
    let p = unsafe { alloc_zeroed(layout) } as *mut f64;
    assert!(!p.is_null(), "allocation failed");
    p
}

/// Allocate for `spring_cap` springs and `tween_cap` tweens (+8 tail pad).
#[unsafe(no_mangle)]
pub extern "C" fn anim_init(spring_cap: usize, tween_cap: usize) {
    let s = spring_cap + 8;
    let t = tween_cap + 8;
    unsafe {
        A.s_val = leak_f64(s);
        A.s_target = leak_f64(s);
        A.s_vel = leak_f64(s);
        A.s_stiff = leak_f64(s);
        A.s_damp = leak_f64(s);
        A.s_mass = leak_f64(s);
        A.t_from = leak_f64(t);
        A.t_to = leak_f64(t);
        A.t_elapsed = leak_f64(t);
        A.t_dur = leak_f64(t);
        A.t_delay = leak_f64(t);
        A.t_ease = leak_f64(t);
        A.t_val = leak_f64(t);
    }
}

macro_rules! ptr_export {
    ($name:ident, $field:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *mut f64 {
            unsafe { A.$field }
        }
    };
}
ptr_export!(p_s_val, s_val);
ptr_export!(p_s_target, s_target);
ptr_export!(p_s_vel, s_vel);
ptr_export!(p_s_stiff, s_stiff);
ptr_export!(p_s_damp, s_damp);
ptr_export!(p_s_mass, s_mass);
ptr_export!(p_t_from, t_from);
ptr_export!(p_t_to, t_to);
ptr_export!(p_t_elapsed, t_elapsed);
ptr_export!(p_t_dur, t_dur);
ptr_export!(p_t_delay, t_delay);
ptr_export!(p_t_ease, t_ease);
ptr_export!(p_t_val, t_val);

#[inline]
fn is_at_rest(val: f64, target: f64, vel: f64) -> bool {
    (val - target).abs() < VAL_EPSILON && vel.abs() < VEL_EPSILON
}

/// Advance `count` springs by `dt` seconds, in place. Bit-identical to
/// `SpringPhysics.update` (same substep loop, same op order, same rest snap).
#[unsafe(no_mangle)]
pub extern "C" fn spring_step(dt: f64, count: usize) {
    unsafe {
        for i in 0..count {
            let mut val = *A.s_val.add(i);
            let target = *A.s_target.add(i);
            let mut vel = *A.s_vel.add(i);

            if is_at_rest(val, target, vel) {
                *A.s_val.add(i) = target;
                *A.s_vel.add(i) = 0.0;
                continue;
            }
            // Matches JS `if (!(dt > 0)) return;` — rejects 0, negatives, and NaN.
            if dt.is_nan() || dt <= 0.0 {
                continue;
            }

            let stiff = *A.s_stiff.add(i);
            let damp = *A.s_damp.add(i);
            let mass = *A.s_mass.add(i);

            let mut remaining = if dt < MAX_FRAME_DT { dt } else { MAX_FRAME_DT };
            while remaining > 0.0 {
                let step = if remaining < MAX_STEP_DT {
                    remaining
                } else {
                    MAX_STEP_DT
                };
                let force_spring = -stiff * (val - target);
                let force_damping = -damp * vel;
                let acceleration = (force_spring + force_damping) / mass;
                vel += acceleration * step;
                val += vel * step;
                remaining -= step;
                if is_at_rest(val, target, vel) {
                    val = target;
                    vel = 0.0;
                    break;
                }
            }
            *A.s_val.add(i) = val;
            *A.s_vel.add(i) = vel;
        }
    }
}

const C1: f64 = 1.70158;
const C3: f64 = C1 + 1.0;

/// Named easings, by id, matching packages/animation/src/easing.ts order:
/// 0 linear, 1 easeInQuad, 2 easeOutQuad, 3 easeInOutQuad, 4 easeInCubic,
/// 5 easeOutCubic, 6 easeInOutCubic, 7 easeOutBack, 8 easeInOutBack.
/// NOTE: cubic/back use integer powers that the JS side writes as `Math.pow`;
/// Rust cannot reproduce V8's `pow` to the ULP, so results match to ~1e-12, not
/// bit-for-bit (recorded as a spike finding).
#[inline]
fn ease(id: i32, t: f64) -> f64 {
    match id {
        0 => t,
        1 => t * t,
        2 => t * (2.0 - t),
        3 => {
            if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            }
        }
        4 => t * t * t,
        5 => 1.0 - (1.0 - t).powi(3),
        6 => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        7 => 1.0 + C3 * (t - 1.0).powi(3) + C1 * (t - 1.0).powi(2),
        8 => {
            let c2 = C1 * 1.525;
            if t < 0.5 {
                ((2.0 * t).powi(2) * ((c2 + 1.0) * 2.0 * t - c2)) / 2.0
            } else {
                ((2.0 * t - 2.0).powi(2) * ((c2 + 1.0) * (t * 2.0 - 2.0) + c2) + 2.0) / 2.0
            }
        }
        _ => t,
    }
}

/// Advance `count` tweens by `dt` ms, writing `t_val`. Matches `TweenDriver.tick`
/// (advance elapsed, clamp progress, ease) except for the easing ULP caveat.
#[unsafe(no_mangle)]
pub extern "C" fn tween_step(dt: f64, count: usize) {
    unsafe {
        for i in 0..count {
            let elapsed = *A.t_elapsed.add(i) + dt;
            *A.t_elapsed.add(i) = elapsed;
            let active = elapsed - *A.t_delay.add(i);
            if active <= 0.0 {
                continue;
            }
            let dur = *A.t_dur.add(i);
            let p = (active / dur).min(1.0);
            let from = *A.t_from.add(i);
            let to = *A.t_to.add(i);
            let id = *A.t_ease.add(i) as i32;
            *A.t_val.add(i) = from + (to - from) * ease(id, p);
        }
    }
}
