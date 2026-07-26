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

// G4 spike — particle CPU simulation (spring/mouse/explosion/integrate/bounce/
// life). Own f32 SoA + static state; a separate f32 differential oracle from the
// f64 transform core (the particle buffer is a Float32Array). Independent of the
// transform path.
mod particle;

// f32 SIMD evaluation — bench-only f32x4 compose kernel with its own isolated
// store. Never a production backend (f32 is not bit-comparable to the JS
// reference); exists solely to measure f32x4 vs the shipped f64x2. wasm32-only.
#[cfg(target_arch = "wasm32")]
mod simd_f32_bench;

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

    // Local render bounds inputs (bx, by, bw, bh) for the world-AABB pass.
    bx: *mut f64,
    by: *mut f64,
    bw: *mut f64,
    bh: *mut f64,

    // World-space AABB outputs (min/max corner after the world transform).
    aminx: *mut f64,
    aminy: *mut f64,
    amaxx: *mut f64,
    amaxy: *mut f64,

    // Sibling runs: run `r` owns entities `[run_start[r], run_start[r] +
    // run_len[r])` whose shared parent is `run_parent[r]`.
    run_parent: *mut i32,
    run_start: *mut i32,
    run_len: *mut i32,
    run_count: usize,

    /// Entity slots allocated by `init` (the logical capacity, excluding the
    /// SIMD tail padding). Recorded so every export can validate the counts the
    /// JS side passes instead of trusting them: the Safety contracts below used
    /// to be enforced only by the TypeScript caller, and PR #136's own review
    /// found two out-of-bounds read paths that way. The sandbox stops such a bug
    /// corrupting the browser, but it can still trap, corrupt this module's own
    /// memory, or silently return wrong geometry and break a frame. One
    /// comparison per kernel call is not measurable against the work the call
    /// does.
    capacity: usize,
    /// Sibling-run slots allocated by `init`.
    run_capacity: usize,
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
    bx: ptr::null_mut(),
    by: ptr::null_mut(),
    bw: ptr::null_mut(),
    bh: ptr::null_mut(),
    aminx: ptr::null_mut(),
    aminy: ptr::null_mut(),
    amaxx: ptr::null_mut(),
    amaxy: ptr::null_mut(),
    run_parent: ptr::null_mut(),
    run_start: ptr::null_mut(),
    run_len: ptr::null_mut(),
    run_count: 0,
    capacity: 0,
    run_capacity: 0,
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
        S.bx = leak_f64(n);
        S.by = leak_f64(n);
        S.bw = leak_f64(n);
        S.bh = leak_f64(n);
        S.aminx = leak_f64(n);
        S.aminy = leak_f64(n);
        S.amaxx = leak_f64(n);
        S.amaxy = leak_f64(n);
        S.run_parent = leak_i32(max_runs);
        S.run_start = leak_i32(max_runs);
        S.run_len = leak_i32(max_runs);
        S.capacity = capacity;
        S.run_capacity = max_runs;
        S.run_count = 0;
    }
}

/// Status codes returned by the exports that can reject their arguments.
/// `0` is success; a non-zero result means the call did nothing, so the JS side
/// can fall back to its reference path rather than render from a half-written
/// store.
pub const STATUS_OK: i32 = 0;
/// A count exceeded what `init` allocated.
pub const STATUS_CAPACITY: i32 = 1;
/// A kernel ran before `init`, so the store pointers are still null.
pub const STATUS_UNINITIALIZED: i32 = 2;
/// A sibling run referenced a slot or parent outside the allocated range.
pub const STATUS_BAD_RUN: i32 = 3;

/// True once `init` has allocated the store.
#[inline]
fn initialized() -> bool {
    unsafe { S.capacity > 0 && !S.x.is_null() }
}

/// Validate that every sibling run addresses slots inside `[0, capacity)` and
/// names a parent inside the same range.
///
/// This is the check that matters most: a run's `start + len` is what the
/// composition kernels iterate, and a bad `parent` index is dereferenced to read
/// the parent matrix. Both were previously guaranteed only by convention.
fn runs_in_bounds() -> bool {
    unsafe {
        for r in 0..S.run_count {
            let parent = *S.run_parent.add(r);
            let start = *S.run_start.add(r);
            let len = *S.run_len.add(r);
            if parent < 0 || start < 0 || len < 0 {
                return false;
            }
            let parent = parent as usize;
            let start = start as usize;
            let len = len as usize;
            if parent >= S.capacity {
                return false;
            }
            // Checked arithmetic: `start + len` could otherwise wrap on a
            // hostile or corrupted table and pass a naive comparison.
            match start.checked_add(len) {
                Some(end) if end <= S.capacity => {}
                _ => return false,
            }
        }
        true
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
ptr_export!(p_bx, bx, f64);
ptr_export!(p_by, by, f64);
ptr_export!(p_bw, bw, f64);
ptr_export!(p_bh, bh, f64);
ptr_export!(p_aminx, aminx, f64);
ptr_export!(p_aminy, aminy, f64);
ptr_export!(p_amaxx, amaxx, f64);
ptr_export!(p_amaxy, amaxy, f64);
ptr_export!(p_run_parent, run_parent, i32);
ptr_export!(p_run_start, run_start, i32);
ptr_export!(p_run_len, run_len, i32);

/// Set the number of sibling runs the composition kernels will walk.
///
/// Returns [`STATUS_OK`], or a non-zero status when `n` exceeds the run table
/// `init` allocated — in which case `run_count` is left unchanged, so a rejected
/// call cannot make a later kernel walk past the table.
#[unsafe(no_mangle)]
pub extern "C" fn set_run_count(n: usize) -> i32 {
    if !initialized() {
        return STATUS_UNINITIALIZED;
    }
    unsafe {
        if n > S.run_capacity {
            return STATUS_CAPACITY;
        }
        S.run_count = n;
    }
    STATUS_OK
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
/// Returns [`STATUS_OK`], or a non-zero status when the store is uninitialized or
/// the run table addresses slots outside it — in which case nothing is written.
#[unsafe(no_mangle)]
pub extern "C" fn compose_scalar() -> i32 {
    if !initialized() {
        return STATUS_UNINITIALIZED;
    }
    if !runs_in_bounds() {
        return STATUS_BAD_RUN;
    }
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
    STATUS_OK
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
pub unsafe extern "C" fn compose_simd() -> i32 {
    if !initialized() {
        return STATUS_UNINITIALIZED;
    }
    if !runs_in_bounds() {
        return STATUS_BAD_RUN;
    }
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
    STATUS_OK
}

/// `Math.min` semantics: propagate NaN (unlike Rust's `f64::min`, which ignores
/// it), and treat `-0 < +0`. Matches the JS reference's min accumulation so the
/// AABB pass stays bit-identical even for NaN/±0 corners from overflowed
/// transforms.
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        // -0 is "less than" +0 for Math.min.
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max` semantics: propagate NaN; treat `+0 > -0`.
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// World-space AABB pass (G1+). For each of the `count` entities, transform its
/// local bounds `[bx, by, bw, bh]` through the already-composed world matrix and
/// write the min/max of the four transformed corners to `aminx/aminy/amaxx/amaxy`.
///
/// Bit-identical to `soa.ts::computeAabbsJS` (and thus to `Entity.getWorldBounds`):
/// same corner-selection bit trick, same `a*x + c*y + e` / `b*x + d*y + f` op
/// order, same min/max accumulation over exactly four corners. Scalar (not SIMD):
/// the min/max reduction across four corners per entity does not map cleanly onto
/// two-lane `f64x2` without changing the reduction order (and thus bit-identity),
/// and the pass is memory-light — the win over the JS reference is avoiding the
/// per-entity closure/object churn across the whole batch, not lane throughput.
///
/// Must run AFTER a `compose_*` kernel, which fills the world matrices this reads.
///
/// # Safety
///
/// `init` must have been called with capacity ≥ `count`, and a `compose_*`
/// kernel must have populated the world matrices for `[0, count)`. Reads/writes
/// `[0, count)` of each SoA array; `count` beyond capacity is out of bounds.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compute_aabbs(count: usize) -> i32 {
    if !initialized() {
        return STATUS_UNINITIALIZED;
    }
    // SAFETY of the loop below now rests on this check rather than on the
    // caller's discipline.
    if count > unsafe { S.capacity } {
        return STATUS_CAPACITY;
    }
    unsafe {
        for i in 0..count {
            let a = *S.wa.add(i);
            let b = *S.wb.add(i);
            let c = *S.wc.add(i);
            let d = *S.wd.add(i);
            let e = *S.we.add(i);
            let f = *S.wf.add(i);
            let bx = *S.bx.add(i);
            let by = *S.by.add(i);
            let bw = *S.bw.add(i);
            let bh = *S.bh.add(i);

            let mut min_x = f64::INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for k in 0..4 {
                let local_x = if k & 1 != 0 { bx + bw } else { bx };
                let local_y = if k & 2 != 0 { by + bh } else { by };
                let world_x = a * local_x + c * local_y + e;
                let world_y = b * local_x + d * local_y + f;
                // js_min/js_max, NOT f64::min/max: `Math.min`/`Math.max`
                // PROPAGATE NaN (result is NaN if either operand is NaN), while
                // Rust's f64::min/max IGNORE NaN. A pathological transform (e.g.
                // a 10k-deep chain whose scale overflows to Infinity, giving an
                // Infinity*0 = NaN corner) would otherwise diverge from the JS
                // reference. Matching Math.* keeps the pass bit-identical.
                min_x = js_min(min_x, world_x);
                min_y = js_min(min_y, world_y);
                max_x = js_max(max_x, world_x);
                max_y = js_max(max_y, world_y);
            }
            *S.aminx.add(i) = min_x;
            *S.aminy.add(i) = min_y;
            *S.amaxx.add(i) = max_x;
            *S.amaxy.add(i) = max_y;
        }
    }
    STATUS_OK
}
