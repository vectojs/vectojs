//! G3 spike — hit-test broad-phase over a dense viewport grid.
//!
//! `Scene.findEntityAt` today does an O(N) depth-first `isPointInside` walk PER
//! pointer event (Scene.ts `findHitRecursively`) — nothing indexes the tree. This
//! kernel replaces that with a uniform grid: each interactive entity's world-space
//! AABB is bucketed into the grid cells it overlaps (counting sort), and a point
//! query scans only the one cell the pointer falls in, returning the **topmost**
//! candidate — the highest entity index, since store/draw order is pre-order so a
//! larger index is drawn later and sits on top. The caller then confirms that one
//! candidate with the entity's precise `isPointInside` (the AABB is a coarse
//! pre-filter), so a non-rectangular hit shape stays correct.
//!
//! The grid is bounded and dense because a pointer is always inside the viewport:
//! cells cover `[0,vw] x [0,vh]` at a fixed size, so it is a flat `i32` array, no
//! hashing. Entities fully outside the viewport are skipped (already culled).
//!
//! Measurement module, like `anim`: separate SoA + `static mut`, nothing here
//! touches the transform `Store`. A later integration would read world AABBs
//! straight from G1's resident world matrices instead of a separate upload.

use core::ptr;
use std::alloc::{Layout, alloc_zeroed};

use crate::SIMD_ALIGN;

struct Hit {
    // World-space AABBs, one slot per entity. Index == draw order (topmost = max).
    minx: *mut f64,
    miny: *mut f64,
    maxx: *mut f64,
    maxy: *mut f64,

    // Dense grid over the viewport. `cell_start[c]..cell_start[c]+cell_count[c]`
    // indexes into `items` (entity indices grouped by cell). `cursor` is the
    // scatter write head, kept separate so `cell_start` stays the read offset.
    cell_start: *mut i32,
    cell_count: *mut i32,
    cursor: *mut i32,
    items: *mut i32,

    grid_w: i32,
    grid_h: i32,
    cell_size: f64,
    cell_cap: usize,
    item_cap: usize,
    item_overflow: i32, // set if a build needed more item slots than allocated
}

static mut H: Hit = Hit {
    minx: ptr::null_mut(),
    miny: ptr::null_mut(),
    maxx: ptr::null_mut(),
    maxy: ptr::null_mut(),
    cell_start: ptr::null_mut(),
    cell_count: ptr::null_mut(),
    cursor: ptr::null_mut(),
    items: ptr::null_mut(),
    grid_w: 0,
    grid_h: 0,
    cell_size: 64.0,
    cell_cap: 0,
    item_cap: 0,
    item_overflow: 0,
};

fn leak_f64(n: usize) -> *mut f64 {
    let layout = Layout::from_size_align(n * size_of::<f64>(), SIMD_ALIGN).expect("valid layout");
    let p = unsafe { alloc_zeroed(layout) } as *mut f64;
    assert!(!p.is_null(), "allocation failed");
    p
}
fn leak_i32(n: usize) -> *mut i32 {
    Box::leak(vec![0i32; n].into_boxed_slice()).as_mut_ptr()
}

/// Allocate for `entity_cap` AABBs, `cell_cap` grid cells, and `item_cap`
/// (entity, cell) membership pairs. The caller sizes `item_cap` for the expected
/// entity span (small entities ≈ 1–4 cells each).
#[unsafe(no_mangle)]
pub extern "C" fn hit_init(entity_cap: usize, cell_cap: usize, item_cap: usize) {
    let e = entity_cap + 8;
    unsafe {
        H.minx = leak_f64(e);
        H.miny = leak_f64(e);
        H.maxx = leak_f64(e);
        H.maxy = leak_f64(e);
        H.cell_start = leak_i32(cell_cap);
        H.cell_count = leak_i32(cell_cap);
        H.cursor = leak_i32(cell_cap);
        H.items = leak_i32(item_cap);
        H.cell_cap = cell_cap;
        H.item_cap = item_cap;
    }
}

macro_rules! ptr_export_f64 {
    ($name:ident, $field:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *mut f64 {
            unsafe { H.$field }
        }
    };
}
ptr_export_f64!(p_h_minx, minx);
ptr_export_f64!(p_h_miny, miny);
ptr_export_f64!(p_h_maxx, maxx);
ptr_export_f64!(p_h_maxy, maxy);

/// Did the last `hit_build` overflow `item_cap`? (1 = some memberships dropped.)
#[unsafe(no_mangle)]
pub extern "C" fn hit_overflow() -> i32 {
    unsafe { H.item_overflow }
}

#[inline]
fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Build the grid from the first `count` AABBs, covering `[0,vw] x [0,vh]` at
/// `cell_size`. Counting sort: count per cell, prefix-sum to offsets, scatter.
#[unsafe(no_mangle)]
pub extern "C" fn hit_build(count: usize, vw: f64, vh: f64, cell_size: f64) {
    unsafe {
        let cs = if cell_size > 0.0 { cell_size } else { 64.0 };
        let gw = ((vw / cs).ceil() as i32).max(1);
        let gh = ((vh / cs).ceil() as i32).max(1);
        H.grid_w = gw;
        H.grid_h = gh;
        H.cell_size = cs;
        H.item_overflow = 0;
        let cells = (gw * gh) as usize;
        // Guard: never write past the allocated cell arrays.
        let cells = if cells <= H.cell_cap {
            cells
        } else {
            H.cell_cap
        };

        for c in 0..cells {
            *H.cell_count.add(c) = 0;
        }

        // Pass 1: per-cell counts. Skip AABBs fully outside the viewport.
        for i in 0..count {
            let (cx0, cy0, cx1, cy1) = match cell_range(i, vw, vh, cs, gw, gh) {
                Some(r) => r,
                None => continue,
            };
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let c = (cy * gw + cx) as usize;
                    if c < cells {
                        *H.cell_count.add(c) += 1;
                    }
                }
            }
        }

        // Prefix sum → cell_start; seed cursor.
        let mut acc = 0i32;
        for c in 0..cells {
            *H.cell_start.add(c) = acc;
            *H.cursor.add(c) = acc;
            acc += *H.cell_count.add(c);
        }

        // Pass 2: scatter entity indices into their cells (in ascending index
        // order, so each cell's items list is naturally sorted — the query can
        // take the last match as the topmost).
        for i in 0..count {
            let (cx0, cy0, cx1, cy1) = match cell_range(i, vw, vh, cs, gw, gh) {
                Some(r) => r,
                None => continue,
            };
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let c = (cy * gw + cx) as usize;
                    if c >= cells {
                        continue;
                    }
                    let w = *H.cursor.add(c);
                    if (w as usize) < H.item_cap {
                        *H.items.add(w as usize) = i as i32;
                        *H.cursor.add(c) = w + 1;
                    } else {
                        H.item_overflow = 1;
                    }
                }
            }
        }
    }
}

/// The grid-cell range an entity's AABB overlaps, clamped to the grid, or `None`
/// if the AABB does not intersect the viewport at all.
#[inline]
unsafe fn cell_range(
    i: usize,
    vw: f64,
    vh: f64,
    cs: f64,
    gw: i32,
    gh: i32,
) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let ax0 = *H.minx.add(i);
        let ay0 = *H.miny.add(i);
        let ax1 = *H.maxx.add(i);
        let ay1 = *H.maxy.add(i);
        // Reject empty / fully-outside boxes.
        if ax1 < 0.0 || ay1 < 0.0 || ax0 > vw || ay0 > vh || ax1 < ax0 || ay1 < ay0 {
            return None;
        }
        let cx0 = clampi((ax0 / cs).floor() as i32, 0, gw - 1);
        let cy0 = clampi((ay0 / cs).floor() as i32, 0, gh - 1);
        let cx1 = clampi((ax1 / cs).floor() as i32, 0, gw - 1);
        let cy1 = clampi((ay1 / cs).floor() as i32, 0, gh - 1);
        Some((cx0, cy0, cx1, cy1))
    }
}

/// Topmost entity whose AABB contains `(px, py)`, or -1. Scans only the pointer's
/// cell. Items are in ascending index order, so the last containing item is the
/// topmost (largest draw-order index).
#[unsafe(no_mangle)]
pub extern "C" fn hit_query(px: f64, py: f64) -> i32 {
    unsafe {
        let cs = H.cell_size;
        let gw = H.grid_w;
        let gh = H.grid_h;
        if px < 0.0 || py < 0.0 {
            return -1;
        }
        let cx = (px / cs).floor() as i32;
        let cy = (py / cs).floor() as i32;
        if cx < 0 || cy < 0 || cx >= gw || cy >= gh {
            return -1;
        }
        let c = (cy * gw + cx) as usize;
        if c >= H.cell_cap {
            return -1;
        }
        let start = *H.cell_start.add(c);
        let cnt = *H.cell_count.add(c);
        let mut best = -1i32;
        for k in 0..cnt {
            let idx = *H.items.add((start + k) as usize);
            let ax0 = *H.minx.add(idx as usize);
            let ay0 = *H.miny.add(idx as usize);
            let ax1 = *H.maxx.add(idx as usize);
            let ay1 = *H.maxy.add(idx as usize);
            if px >= ax0 && px <= ax1 && py >= ay0 && py <= ay1 && idx > best {
                best = idx;
            }
        }
        best
    }
}
