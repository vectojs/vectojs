//! G4 spike — particle CPU simulation kernel (SoA, scalar f32).
//!
//! Mirrors `ComputeParticleEntity.updateCPU` (`packages/core/src/tree/
//! ComputeParticleEntity.ts`): spring-to-origin, mouse repulsion, explosion
//! impulse, velocity integrate + damp, velocity cap, boundary bounce + clamp,
//! and life decay — over 10k–100k particles every frame. It is the fallback
//! exactly when there is no GPU, so the machines that most need it run this loop.
//!
//! ## f32, not f64 — a *separate* differential oracle
//!
//! The particle buffer is a `Float32Array` (matches the WGSL compute shader), so
//! this kernel commits to **f32** and is NOT bit-comparable to the f64 transform
//! core. Its differential oracle is a dedicated JS f32 reference
//! (`packages/core/src/wasm/particle-backend.ts::particleStepReferenceF32`) that
//! rounds every intermediate to f32 (`Math.fround`) in the SAME op order and
//! uses `sqrt(dx*dx+dy*dy)` (NOT `Math.hypot`, which is correctly-rounded f64):
//! with those two rules the JS reference is bit-identical to this kernel, because
//! f32 add/sub/mul/div/sqrt of f32 operands each round once whether computed
//! directly in f32 or in f64-then-`fround`. The shipped `updateCPU` stays f64 and
//! is the permanent fallback; WASM-f32 vs updateCPU-f64 differ by <1 ULP/step
//! (the accepted CPU-vs-GPU-class divergence the survey notes).
//!
//! ## SoA, not the AoS stride-8 buffer
//!
//! One flat `f32` array per field. The render/GPU buffer is AoS stride-8, so the
//! JS side transposes into these arrays once (position/velocity/life are state
//! and are read back; origin is upload-once). Scalar, not SIMD: the per-particle
//! path is branchy (mouse `dist<120`, explosion `edist<150`, per-axis bounce
//! conditions) and the loop is memory-bound (7 f32 in + 5 f32 out per particle),
//! so a masked SIMD rewrite is a separate measurement — noted, not assumed.
//!
//! Fuses `hasPendingAnimations` (a second per-frame full-buffer scan): the step
//! returns 1 if any live particle is still moving or approaching its origin (the
//! velocity/distance epsilon test), else 0 — so the buffer is walked once.

use core::ptr;
use std::alloc::{Layout, alloc_zeroed};

use crate::{SIMD_ALIGN, STATUS_CAPACITY, STATUS_UNINITIALIZED};

// hasPendingAnimations epsilons — must match ComputeParticleEntity.ts:204-205.
const EPS_VELOCITY: f32 = 0.5; // px/s — below this a particle looks at rest
const EPS_DISTANCE: f32 = 0.5; // px — below this "still approaching origin" is imperceptible

/// Per-field particle state. `px,py,vx,vy` and `life` are read back each frame;
/// `ox,oy` (origin) are upload-once. Particle `size` (AoS offset 6) is
/// render-only and never enters the sim, so it is not mirrored here.
struct Particles {
    px: *mut f32,
    py: *mut f32,
    vx: *mut f32,
    vy: *mut f32,
    ox: *mut f32,
    oy: *mut f32,
    life: *mut f32,

    /// Particle slots requested by `particle_init` (excluding the tail pad it
    /// adds). `particle_step` validates `count` against this instead of trusting
    /// the caller: the doc comment below used to delegate the whole bounds
    /// guarantee to TypeScript, and nothing recorded the capacity to check
    /// against even if the kernel had wanted to.
    capacity: usize,
}

static mut P: Particles = Particles {
    px: ptr::null_mut(),
    py: ptr::null_mut(),
    vx: ptr::null_mut(),
    vy: ptr::null_mut(),
    ox: ptr::null_mut(),
    oy: ptr::null_mut(),
    life: ptr::null_mut(),
    capacity: 0,
};

fn leak_f32(n: usize) -> *mut f32 {
    let layout = Layout::from_size_align(n * size_of::<f32>(), SIMD_ALIGN).expect("valid layout");
    let p = unsafe { alloc_zeroed(layout) } as *mut f32;
    assert!(!p.is_null(), "allocation failed");
    p
}

/// Free the SoA the previous `particle_init` allocated, if any. `capacity`
/// still records the logical count the live pointers were allocated with, so
/// this must run before `particle_init` overwrites it.
fn free_particles() {
    unsafe {
        let n = P.capacity + 8;
        crate::free_f32(P.px, n);
        crate::free_f32(P.py, n);
        crate::free_f32(P.vx, n);
        crate::free_f32(P.vy, n);
        crate::free_f32(P.ox, n);
        crate::free_f32(P.oy, n);
        crate::free_f32(P.life, n);
    }
}

/// Allocate for `capacity` particles (+padding), freeing the previous allocation
/// first — the JS side re-inits in place when a larger particle count arrives.
#[unsafe(no_mangle)]
pub extern "C" fn particle_init(capacity: usize) {
    let n = capacity + 8;
    free_particles();
    unsafe {
        P.px = leak_f32(n);
        P.py = leak_f32(n);
        P.vx = leak_f32(n);
        P.vy = leak_f32(n);
        P.ox = leak_f32(n);
        P.oy = leak_f32(n);
        P.life = leak_f32(n);
        P.capacity = capacity;
    }
}

/// True once `particle_init` has allocated the SoA.
#[inline]
fn particles_ready() -> bool {
    unsafe { P.capacity > 0 && !P.px.is_null() }
}

macro_rules! ptr_export {
    ($name:ident, $field:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *mut f32 {
            unsafe { P.$field }
        }
    };
}
ptr_export!(pp_px, px);
ptr_export!(pp_py, py);
ptr_export!(pp_vx, vx);
ptr_export!(pp_vy, vy);
ptr_export!(pp_ox, ox);
ptr_export!(pp_oy, oy);
ptr_export!(pp_life, life);

/// Advance `count` particles one step, in place, returning the fused
/// pending-animation flag (`1` = at least one live particle still moving or
/// off-origin beyond epsilon, `0` = all at rest). Scalars mirror
/// `updateCPU`'s argument clamps exactly (in f32).
///
/// `expl_active` is `1` when an explosion impulse should be applied this step.
///
/// ## Rejection is encoded as a NEGATIVE return
///
/// The success values `0`/`1` are both meaningful here, so a rejected call
/// cannot reuse them — reporting `1` would claim "still animating" and reporting
/// `0` would claim "everything settled", and the caller would scatter the
/// untouched gather buffer back either way. A violation therefore returns the
/// negated status (`-STATUS_CAPACITY`, `-STATUS_UNINITIALIZED`), which no valid
/// step can produce, and writes nothing: the caller must skip its scatter and
/// fall back to the JS `updateCPU` path.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn particle_step(
    dt: f32,
    mouse_x: f32,
    mouse_y: f32,
    width: f32,
    height: f32,
    spring_k: f32,
    damping: f32,
    bounce_damping: f32,
    max_velocity: f32,
    expl_active: i32,
    expl_x: f32,
    expl_y: f32,
    expl_force: f32,
    count: usize,
) -> i32 {
    if !particles_ready() {
        return -STATUS_UNINITIALIZED;
    }
    // SAFETY of the loop below rests on this check rather than the caller's
    // discipline: every `P.*.add(i)` for `i` in `0..count` is in bounds.
    if count > unsafe { P.capacity } {
        return -STATUS_CAPACITY;
    }
    unsafe {
        // clamp() == max(a, min(x, b)) for finite inputs (NaN cases pre-guarded),
        // so this stays bit-identical to updateCPU's Math.max(a, Math.min(x, b));
        // the JS f32 reference uses the same clamps.
        let safe_dt = if dt.is_nan() {
            0.016
        } else {
            dt.clamp(0.0, 0.1)
        };
        let safe_w = width.max(1.0);
        let safe_h = height.max(1.0);
        let k = spring_k.clamp(0.0, 10.0);
        let damp = damping.clamp(0.0, 1.0);
        let bounce = bounce_damping.clamp(0.0, 1.0);
        let max_v = max_velocity.max(1.0);
        let mouse_on =
            !mouse_x.is_nan() && !mouse_y.is_nan() && mouse_x > -9000.0 && mouse_y > -9000.0;
        let expl_on = expl_active != 0;

        let mut pending = false;

        for i in 0..count {
            let mut px = *P.px.add(i);
            let mut py = *P.py.add(i);
            let mut vx = *P.vx.add(i);
            let mut vy = *P.vy.add(i);
            let ox = *P.ox.add(i);
            let oy = *P.oy.add(i);
            let life = *P.life.add(i);

            // NaN protection (matches updateCPU).
            if px.is_nan() {
                px = ox;
            }
            if py.is_nan() {
                py = oy;
            }
            if vx.is_nan() {
                vx = 0.0;
            }
            if vy.is_nan() {
                vy = 0.0;
            }

            // 1. Spring force toward origin.
            let fx_spring = (ox - px) * k;
            let fy_spring = (oy - py) * k;

            // 2. Mouse repulsion.
            let mut fx_mouse = 0.0f32;
            let mut fy_mouse = 0.0f32;
            if mouse_on {
                let dx = mouse_x - px;
                let dy = mouse_y - py;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist < 120.0 && dist > 0.1 {
                    let force = (120.0 - dist) * 2.0;
                    fx_mouse = -(dx / dist) * force;
                    fy_mouse = -(dy / dist) * force;
                }
            }

            // 3. Explosion impulse.
            let mut fx_expl = 0.0f32;
            let mut fy_expl = 0.0f32;
            if expl_on {
                let ex = expl_x - px;
                let ey = expl_y - py;
                let edist = (ex * ex + ey * ey).sqrt();
                if edist < 150.0 && edist > 0.1 {
                    let force = (150.0 - edist) * expl_force;
                    fx_expl = -(ex / edist) * force;
                    fy_expl = -(ey / edist) * force;
                }
            }

            // 4. Integrate acceleration, damp.
            let ax = fx_spring + fx_mouse + fx_expl;
            let ay = fy_spring + fy_mouse + fy_expl;
            let mut nvx = (vx + ax * safe_dt) * damp;
            let mut nvy = (vy + ay * safe_dt) * damp;

            let speed = (nvx * nvx + nvy * nvy).sqrt();
            if speed > max_v {
                nvx = (nvx / speed) * max_v;
                nvy = (nvy / speed) * max_v;
            }

            let mut npx = px + nvx * safe_dt;
            let mut npy = py + nvy * safe_dt;

            // 5. Boundary bounce. Both the min- and max-edge cases reverse+damp
            // the same way, so they collapse to one condition per axis (matches
            // updateCPU's two branches, which assign identical values).
            if (npx <= 0.0 && nvx < 0.0) || (npx >= safe_w && nvx > 0.0) {
                nvx = -nvx * bounce;
            }
            if (npy <= 0.0 && nvy < 0.0) || (npy >= safe_h && nvy > 0.0) {
                nvy = -nvy * bounce;
            }

            npx = npx.clamp(0.0, safe_w);
            npy = npy.clamp(0.0, safe_h);

            // 6. Life decay.
            let mut nlife = life;
            if life >= 0.0 {
                nlife = (life - safe_dt * 0.5).max(0.0);
            }

            *P.px.add(i) = npx;
            *P.py.add(i) = npy;
            *P.vx.add(i) = nvx;
            *P.vy.add(i) = nvy;
            *P.life.add(i) = nlife;

            // Fused hasPendingAnimations: skip dead, then velocity/distance test.
            if nlife != 0.0 {
                if nvx * nvx + nvy * nvy > EPS_VELOCITY * EPS_VELOCITY {
                    pending = true;
                } else {
                    let ddx = npx - ox;
                    let ddy = npy - oy;
                    if ddx * ddx + ddy * ddy > EPS_DISTANCE * EPS_DISTANCE {
                        pending = true;
                    }
                }
            }
        }

        if pending { 1 } else { 0 }
    }
}
