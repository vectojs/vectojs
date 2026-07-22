//! World-transform composition core for `@vectojs/core`, compiled to
//! `wasm32-unknown-unknown` and consumed as an invisible backend. The
//! TypeScript path (`packages/core/src/wasm/soa.ts`) computes the identical
//! result and is the permanent fallback; this crate must stay **bit-identical**
//! to it, which is why it is f64-only (f32 SIMD is faster but not bit-comparable
//! and is deliberately out of scope — see the task plan).
//!
//! ## Memory layout — pure SoA, not interleaved
//!
//! One flat `f64` array per field. This is load-bearing: with an interleaved
//! stride-N record, consecutive entities' `x` values sit N*8 bytes apart, so a
//! `v128` load cannot fetch two of them and SIMD is unreachable no matter how
//! the kernel is written.
//!
//! ## Sibling runs — why the store is shaped this way
//!
//! Hierarchical composition is sequential: a child needs its parent's world
//! matrix. WASM SIMD has no gather instruction, so vectorizing across entities
//! with *arbitrary* parents would require loading each parent matrix by hand.
//! Instead the store requires **children of one parent to be contiguous**; the
//! parent's world matrix is then loop-invariant across the run, splat into lanes
//! once, and the children vectorize cleanly. Runs are emitted in depth order, so
//! a run's parent is always already composed. The JS store builder
//! (`soa.ts::buildStore`) is what guarantees this ordering.
//!
//! No `wasm-bindgen`: raw `#[unsafe(no_mangle)] extern "C"` exports plus typed
//! arrays the JS side lays over `WebAssembly.Memory.buffer`. Keeping rich
//! marshalling inconvenient is intentional — the seam is two batched crossings
//! per frame, never per entity.

#![allow(clippy::too_many_arguments)]

// G2 spike — batched animation driver kernels (spring + tween). Separate SoA and
// static state; a measurement module, not part of the transform path.
mod anim;

// G3 spike — hit-test broad-phase (dense viewport grid). Same convention: its own
// SoA + static state, a measurement module independent of the transform path.
mod hit;

use core::ptr;
use std::alloc::{Layout, alloc_zeroed};

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// SIMD load/store alignment. `v128` is 16 bytes; an 8-byte-aligned f64 array
/// makes every `v128_load` 16-byte-unaligned, which V8 absorbs but SpiderMonkey
/// runs on a much slower path (measured ~7x slower on the compose kernel). Every
/// SoA field array is therefore 16-byte aligned.
pub(crate) const SIMD_ALIGN: usize = 16;

/// Per-field flat input arrays plus the SoA world-matrix outputs. `cos`/`sin`
/// are precomputed on the JS side: WASM has no transcendental instructions and
/// recomputing per frame was the single largest cost measured in round 1.
struct Store {
    // Inputs (one slot per entity).
    x: *mut f64,
    y: *mut f64,
    sx: *mut f64,
    sy: *mut f64,
    cos: *mut f64,
    sin: *mut f64,
    opacity: *mut f64,

    // Outputs: world matrices in SoA order (a, b, c, d, e, f) + world opacity.
    wa: *mut f64,
    wb: *mut f64,
    wc: *mut f64,
    wd: *mut f64,
    we: *mut f64,
    wf: *mut f64,
    wo: *mut f64,

    // Sibling runs: run `r` owns entities `[run_start[r], run_start[r] +
    // run_len[r])` whose shared parent is `run_parent[r]`.
    run_parent: *mut i32,
    run_start: *mut i32,
    run_len: *mut i32,
    run_count: usize,
}

static mut S: Store = Store {
    x: ptr::null_mut(),
    y: ptr::null_mut(),
    sx: ptr::null_mut(),
    sy: ptr::null_mut(),
    cos: ptr::null_mut(),
    sin: ptr::null_mut(),
    opacity: ptr::null_mut(),
    wa: ptr::null_mut(),
    wb: ptr::null_mut(),
    wc: ptr::null_mut(),
    wd: ptr::null_mut(),
    we: ptr::null_mut(),
    wf: ptr::null_mut(),
    wo: ptr::null_mut(),
    run_parent: ptr::null_mut(),
    run_start: ptr::null_mut(),
    run_len: ptr::null_mut(),
    run_count: 0,
};

/// Leak a zeroed, 16-byte-aligned `f64` array of `n` elements. Leaked on
/// purpose: the store is a process-lifetime singleton, so there is nothing to
/// free. `alloc_zeroed` (not `vec!`) is what guarantees the 16-byte base —
/// `Vec<f64>` is only 8-byte aligned.
fn leak_f64(n: usize) -> *mut f64 {
    let layout = Layout::from_size_align(n * size_of::<f64>(), SIMD_ALIGN).expect("valid layout");
    let p = unsafe { alloc_zeroed(layout) } as *mut f64;
    assert!(!p.is_null(), "allocation failed");
    p
}
/// Run tables are read/written scalar (no SIMD), so 4-byte `i32` alignment is
/// fine; a plain leaked `Vec` suffices.
fn leak_i32(n: usize) -> *mut i32 {
    Box::leak(vec![0i32; n].into_boxed_slice()).as_mut_ptr()
}

/// Allocate for `capacity` entities and `max_runs` sibling runs. Idempotent per
/// module instance in practice: called once after instantiation with the
/// high-water mark; a growing scene re-instantiates or the JS side caps upload.
#[unsafe(no_mangle)]
pub extern "C" fn init(capacity: usize, max_runs: usize) {
    // Pad so a 2-lane (f64) tail can read one slot past the logical end without
    // a bounds check or a separate scalar remainder loop.
    let n = capacity + 8;
    unsafe {
        S.x = leak_f64(n);
        S.y = leak_f64(n);
        S.sx = leak_f64(n);
        S.sy = leak_f64(n);
        S.cos = leak_f64(n);
        S.sin = leak_f64(n);
        S.opacity = leak_f64(n);
        S.wa = leak_f64(n);
        S.wb = leak_f64(n);
        S.wc = leak_f64(n);
        S.wd = leak_f64(n);
        S.we = leak_f64(n);
        S.wf = leak_f64(n);
        S.wo = leak_f64(n);
        S.run_parent = leak_i32(max_runs);
        S.run_start = leak_i32(max_runs);
        S.run_len = leak_i32(max_runs);
    }
}

macro_rules! ptr_export {
    ($name:ident, $field:ident, $ty:ty) => {
        /// Byte offset (as a pointer) of this SoA array in linear memory, for
        /// the JS side to lay a typed-array view over.
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *mut $ty {
            unsafe { S.$field }
        }
    };
}
ptr_export!(p_x, x, f64);
ptr_export!(p_y, y, f64);
ptr_export!(p_sx, sx, f64);
ptr_export!(p_sy, sy, f64);
ptr_export!(p_cos, cos, f64);
ptr_export!(p_sin, sin, f64);
ptr_export!(p_opacity, opacity, f64);
ptr_export!(p_wa, wa, f64);
ptr_export!(p_wb, wb, f64);
ptr_export!(p_wc, wc, f64);
ptr_export!(p_wd, wd, f64);
ptr_export!(p_we, we, f64);
ptr_export!(p_wf, wf, f64);
ptr_export!(p_wo, wo, f64);
ptr_export!(p_run_parent, run_parent, i32);
ptr_export!(p_run_start, run_start, i32);
ptr_export!(p_run_len, run_len, i32);

#[unsafe(no_mangle)]
pub extern "C" fn set_run_count(n: usize) {
    unsafe { S.run_count = n }
}

/// Seed the root (index 0) to the identity transform. The store builder always
/// places the scene root at index 0 with no run of its own.
#[inline]
unsafe fn seed_root() {
    // Edition 2024: an `unsafe fn` body is no longer implicitly unsafe.
    unsafe {
        *S.wa.add(0) = 1.0;
        *S.wb.add(0) = 0.0;
        *S.wc.add(0) = 0.0;
        *S.wd.add(0) = 1.0;
        *S.we.add(0) = 0.0;
        *S.wf.add(0) = 0.0;
        *S.wo.add(0) = 1.0;
    }
}

/// Scalar f64 composition. Canvas `T * S * R` order (translate → scale →
/// rotate), matching `renderNode` and the JS reference composer exactly.
#[unsafe(no_mangle)]
pub extern "C" fn compose_scalar() {
    unsafe {
        seed_root();
        for r in 0..S.run_count {
            let p = *S.run_parent.add(r) as usize;
            let start = *S.run_start.add(r) as usize;
            let len = *S.run_len.add(r) as usize;

            let pa = *S.wa.add(p);
            let pb = *S.wb.add(p);
            let pc = *S.wc.add(p);
            let pd = *S.wd.add(p);
            let pe = *S.we.add(p);
            let pf = *S.wf.add(p);
            let po = *S.wo.add(p);

            for i in start..start + len {
                let x = *S.x.add(i);
                let y = *S.y.add(i);
                let sx = *S.sx.add(i);
                let sy = *S.sy.add(i);
                let cos = *S.cos.add(i);
                let sin = *S.sin.add(i);

                let te = pa * x + pc * y + pe;
                let tf = pb * x + pd * y + pf;
                let sx_cos = sx * cos;
                let sx_sin = sx * sin;
                let sy_cos = sy * cos;
                let sy_sin = sy * sin;
                let a = pa * sx_cos + pc * sy_sin;
                let b = pb * sx_cos + pd * sy_sin;
                let c = pa * -sx_sin + pc * sy_cos;
                let d = pb * -sx_sin + pd * sy_cos;
                let o = po * *S.opacity.add(i);

                *S.wa.add(i) = a;
                *S.wb.add(i) = b;
                *S.wc.add(i) = c;
                *S.wd.add(i) = d;
                *S.we.add(i) = te;
                *S.wf.add(i) = tf;
                *S.wo.add(i) = o;
            }
        }
    }
}

/// f64x2 SIMD composition. `v128` holds two f64 lanes, so the ceiling is 2×
/// before load/store and tail overhead. The parent matrix is loop-invariant
/// across a run: splat once, then the contiguous children fill both lanes. The
/// `+8` padding from `init` lets an odd-length tail read one slot past the end,
/// so no scalar remainder loop is needed; those padding slots are written but
/// never read back (the JS side only reads `[start, start+len)`).
///
/// # Safety
///
/// `init` must have been called with a capacity and run count at least as large
/// as those implied by the uploaded data, and `set_run_count` must reflect the
/// number of valid runs. Each run's `[start, start+len)` range and its parent
/// index must be within the allocated capacity, and every run's parent must
/// already be composed (guaranteed by the depth-ordered emission in
/// `soa.ts::buildStore`). Violating these reads or writes out of bounds.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compose_simd() {
    // Edition 2024: an `unsafe fn` body is no longer implicitly unsafe.
    unsafe {
        seed_root();
        for r in 0..S.run_count {
            let p = *S.run_parent.add(r) as usize;
            let start = *S.run_start.add(r) as usize;
            let len = *S.run_len.add(r) as usize;

            let pa = f64x2_splat(*S.wa.add(p));
            let pb = f64x2_splat(*S.wb.add(p));
            let pc = f64x2_splat(*S.wc.add(p));
            let pd = f64x2_splat(*S.wd.add(p));
            let pe = f64x2_splat(*S.we.add(p));
            let pf = f64x2_splat(*S.wf.add(p));
            let po = f64x2_splat(*S.wo.add(p));

            let mut i = start;
            let end = start + len;
            while i < end {
                let x = v128_load(S.x.add(i) as *const v128);
                let y = v128_load(S.y.add(i) as *const v128);
                let sx = v128_load(S.sx.add(i) as *const v128);
                let sy = v128_load(S.sy.add(i) as *const v128);
                let cos = v128_load(S.cos.add(i) as *const v128);
                let sin = v128_load(S.sin.add(i) as *const v128);
                let op = v128_load(S.opacity.add(i) as *const v128);

                let te = f64x2_add(f64x2_add(f64x2_mul(pa, x), f64x2_mul(pc, y)), pe);
                let tf = f64x2_add(f64x2_add(f64x2_mul(pb, x), f64x2_mul(pd, y)), pf);

                let sx_cos = f64x2_mul(sx, cos);
                let sx_sin = f64x2_mul(sx, sin);
                let sy_cos = f64x2_mul(sy, cos);
                let sy_sin = f64x2_mul(sy, sin);

                let a = f64x2_add(f64x2_mul(pa, sx_cos), f64x2_mul(pc, sy_sin));
                let b = f64x2_add(f64x2_mul(pb, sx_cos), f64x2_mul(pd, sy_sin));
                let neg = f64x2_neg(sx_sin);
                let c = f64x2_add(f64x2_mul(pa, neg), f64x2_mul(pc, sy_cos));
                let d = f64x2_add(f64x2_mul(pb, neg), f64x2_mul(pd, sy_cos));
                let o = f64x2_mul(po, op);

                v128_store(S.wa.add(i) as *mut v128, a);
                v128_store(S.wb.add(i) as *mut v128, b);
                v128_store(S.wc.add(i) as *mut v128, c);
                v128_store(S.wd.add(i) as *mut v128, d);
                v128_store(S.we.add(i) as *mut v128, te);
                v128_store(S.wf.add(i) as *mut v128, tf);
                v128_store(S.wo.add(i) as *mut v128, o);

                i += 2;
            }
        }
    }
}
