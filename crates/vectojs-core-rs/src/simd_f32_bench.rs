//! f32 SIMD evaluation kernel — **bench-only, not a production backend**.
//!
//! Answers the standing TODO question: does an `f32x4` compose kernel (4 lanes)
//! actually beat the shipped `f64x2` one (2 lanes) enough to justify a
//! lower-precision path? It is deliberately isolated from `lib.rs`'s production
//! store:
//!
//! - It has its **own** static store, `init_f32`, pointer exports, and
//!   `compose_simd_f32`, so nothing here can perturb the f64 path or its
//!   bit-identical-to-JS contract.
//! - f32 carries ~7 significant digits vs f64's ~15, so its output is NOT
//!   bit-comparable to the JS reference — it can never be the default and is
//!   never differential-tested. This module exists only to be *measured*.
//!
//! Same SoA + sibling-run layout and `T*S*R` compose math as the f64 kernel, so
//! the timing difference isolates lane width (4 vs 2) and f32-vs-f64 load/store
//! bandwidth, which is exactly what the decision needs.

#![cfg(target_arch = "wasm32")]

use crate::SIMD_ALIGN;
use core::arch::wasm32::*;
use core::ptr;
use std::alloc::{Layout, alloc_zeroed};

struct StoreF32 {
    x: *mut f32,
    y: *mut f32,
    sx: *mut f32,
    sy: *mut f32,
    cos: *mut f32,
    sin: *mut f32,
    opacity: *mut f32,
    wa: *mut f32,
    wb: *mut f32,
    wc: *mut f32,
    wd: *mut f32,
    we: *mut f32,
    wf: *mut f32,
    wo: *mut f32,
    run_parent: *mut i32,
    run_start: *mut i32,
    run_len: *mut i32,
    run_count: usize,
}

static mut SF: StoreF32 = StoreF32 {
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

fn leak_f32(n: usize) -> *mut f32 {
    let layout = Layout::from_size_align(n * size_of::<f32>(), SIMD_ALIGN).expect("valid layout");
    let p = unsafe { alloc_zeroed(layout) } as *mut f32;
    assert!(!p.is_null(), "allocation failed");
    p
}
fn leak_i32(n: usize) -> *mut i32 {
    Box::leak(vec![0i32; n].into_boxed_slice()).as_mut_ptr()
}

/// Allocate for `capacity` entities and `max_runs` runs. `+16` padding lets a
/// 4-lane tail read up to three slots past the logical end without a remainder
/// loop (the JS side never reads the padding back).
#[unsafe(no_mangle)]
pub extern "C" fn init_f32(capacity: usize, max_runs: usize) {
    let n = capacity + 16;
    unsafe {
        SF.x = leak_f32(n);
        SF.y = leak_f32(n);
        SF.sx = leak_f32(n);
        SF.sy = leak_f32(n);
        SF.cos = leak_f32(n);
        SF.sin = leak_f32(n);
        SF.opacity = leak_f32(n);
        SF.wa = leak_f32(n);
        SF.wb = leak_f32(n);
        SF.wc = leak_f32(n);
        SF.wd = leak_f32(n);
        SF.we = leak_f32(n);
        SF.wf = leak_f32(n);
        SF.wo = leak_f32(n);
        SF.run_parent = leak_i32(max_runs);
        SF.run_start = leak_i32(max_runs);
        SF.run_len = leak_i32(max_runs);
    }
}

macro_rules! ptr_export_f32 {
    ($name:ident, $field:ident, $ty:ty) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *mut $ty {
            unsafe { SF.$field }
        }
    };
}
ptr_export_f32!(p_f32_x, x, f32);
ptr_export_f32!(p_f32_y, y, f32);
ptr_export_f32!(p_f32_sx, sx, f32);
ptr_export_f32!(p_f32_sy, sy, f32);
ptr_export_f32!(p_f32_cos, cos, f32);
ptr_export_f32!(p_f32_sin, sin, f32);
ptr_export_f32!(p_f32_opacity, opacity, f32);
ptr_export_f32!(p_f32_wa, wa, f32);
ptr_export_f32!(p_f32_wb, wb, f32);
ptr_export_f32!(p_f32_wc, wc, f32);
ptr_export_f32!(p_f32_wd, wd, f32);
ptr_export_f32!(p_f32_we, we, f32);
ptr_export_f32!(p_f32_wf, wf, f32);
ptr_export_f32!(p_f32_wo, wo, f32);
ptr_export_f32!(p_f32_run_parent, run_parent, i32);
ptr_export_f32!(p_f32_run_start, run_start, i32);
ptr_export_f32!(p_f32_run_len, run_len, i32);

#[unsafe(no_mangle)]
pub extern "C" fn set_run_count_f32(n: usize) {
    unsafe { SF.run_count = n }
}

#[inline]
unsafe fn seed_root_f32() {
    unsafe {
        *SF.wa.add(0) = 1.0;
        *SF.wb.add(0) = 0.0;
        *SF.wc.add(0) = 0.0;
        *SF.wd.add(0) = 1.0;
        *SF.we.add(0) = 0.0;
        *SF.wf.add(0) = 0.0;
        *SF.wo.add(0) = 1.0;
    }
}

/// f32x4 SIMD composition — 4 lanes per `v128`, so the theoretical ceiling is 4×
/// the load/store count of scalar (vs 2× for f64x2). Same `T*S*R` math as the
/// f64 kernel. Bench-only; see the module docs on why f32 is never the default.
///
/// # Safety
///
/// Same contract as `compose_simd`: `init_f32` must cover the uploaded capacity
/// and runs, `set_run_count_f32` must be accurate, and every run's parent must
/// already be composed (depth-ordered emission).
#[target_feature(enable = "simd128")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compose_simd_f32() {
    unsafe {
        seed_root_f32();
        for r in 0..SF.run_count {
            let p = *SF.run_parent.add(r) as usize;
            let start = *SF.run_start.add(r) as usize;
            let len = *SF.run_len.add(r) as usize;

            let pa = f32x4_splat(*SF.wa.add(p));
            let pb = f32x4_splat(*SF.wb.add(p));
            let pc = f32x4_splat(*SF.wc.add(p));
            let pd = f32x4_splat(*SF.wd.add(p));
            let pe = f32x4_splat(*SF.we.add(p));
            let pf = f32x4_splat(*SF.wf.add(p));
            let po = f32x4_splat(*SF.wo.add(p));

            let mut i = start;
            let end = start + len;
            while i < end {
                let x = v128_load(SF.x.add(i) as *const v128);
                let y = v128_load(SF.y.add(i) as *const v128);
                let sx = v128_load(SF.sx.add(i) as *const v128);
                let sy = v128_load(SF.sy.add(i) as *const v128);
                let cos = v128_load(SF.cos.add(i) as *const v128);
                let sin = v128_load(SF.sin.add(i) as *const v128);
                let op = v128_load(SF.opacity.add(i) as *const v128);

                let te = f32x4_add(f32x4_add(f32x4_mul(pa, x), f32x4_mul(pc, y)), pe);
                let tf = f32x4_add(f32x4_add(f32x4_mul(pb, x), f32x4_mul(pd, y)), pf);

                let sx_cos = f32x4_mul(sx, cos);
                let sx_sin = f32x4_mul(sx, sin);
                let sy_cos = f32x4_mul(sy, cos);
                let sy_sin = f32x4_mul(sy, sin);

                let a = f32x4_add(f32x4_mul(pa, sx_cos), f32x4_mul(pc, sy_sin));
                let b = f32x4_add(f32x4_mul(pb, sx_cos), f32x4_mul(pd, sy_sin));
                let neg = f32x4_neg(sx_sin);
                let c = f32x4_add(f32x4_mul(pa, neg), f32x4_mul(pc, sy_cos));
                let d = f32x4_add(f32x4_mul(pb, neg), f32x4_mul(pd, sy_cos));
                let o = f32x4_mul(po, op);

                v128_store(SF.wa.add(i) as *mut v128, a);
                v128_store(SF.wb.add(i) as *mut v128, b);
                v128_store(SF.wc.add(i) as *mut v128, c);
                v128_store(SF.wd.add(i) as *mut v128, d);
                v128_store(SF.we.add(i) as *mut v128, te);
                v128_store(SF.wf.add(i) as *mut v128, tf);
                v128_store(SF.wo.add(i) as *mut v128, o);

                i += 4;
            }
        }
    }
}
