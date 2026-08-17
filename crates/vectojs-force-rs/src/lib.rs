//! Barnes-Hut octree force kernel for `@vectojs/graph3d`, compiled to
//! `wasm32-unknown-unknown` and consumed as an invisible backend. The
//! TypeScript path (`packages/graph3d/src/layout/VectoForceLayout.ts`) computes
//! the identical result and is the permanent fallback; this crate must stay
//! **bit-identical** to it, which is why it is f64-only in the octree (the JS
//! accumulates centers of mass and the repulsion integral in f64, while
//! positions and velocities stay f32 on the JS side — this kernel only computes
//! the f64 accelerations and leaves the f32 integration to the JS tick).
//!
//! ## Scope: build + force accumulate only
//!
//! The measured phase split (graph3d-frame, 2026-08-17) shows the octree build
//! + force accumulation is 78–90% of a tick, so the kernel replaces exactly
//! that phase. Link springs, centering, velocity-decay integration and pins are
//! f32 work that stays in the JS tick unchanged — the seam is one gather of the
//! f32 positions and one read-back of the f64 accelerations per tick.
//!
//! No `wasm-bindgen`: raw `#[unsafe(no_mangle)] extern "C"` exports plus typed
//! arrays the JS side lays over `WebAssembly.Memory.buffer`.
#![allow(clippy::needless_range_loop, clippy::doc_lazy_continuation)]

use core::cell::RefCell;

const STATUS_OK: i32 = 0;
const STATUS_CAPACITY: i32 = 1;
const STATUS_UNINITIALIZED: i32 = 2;

/// Flat-array Barnes-Hut octree, mirroring the JS `BarnesHutOctree` exactly.
/// `Vec` is used (not 16-byte-aligned manual alloc) because the force
/// traversal is scalar — there is no SIMD on an irregular tree walk.
struct Octree {
    cx: Vec<f64>, // center of mass x (cell geometric center during build)
    cy: Vec<f64>,
    cz: Vec<f64>,
    mass: Vec<f64>,        // point count
    size: Vec<f64>,        // cell edge length
    child: Vec<i32>,       // 8 children per node, -1 = empty
    point_index: Vec<i32>, // point index in a leaf, -1 = internal
    px: Vec<f64>,          // leaf stored point x
    py: Vec<f64>,
    pz: Vec<f64>,
    has_point: Vec<u8>, // 1 = leaf holds a point
    node_count: usize,
    capacity: usize,
    stack: Vec<usize>, // force() traversal stack
}

thread_local! {
    static POS: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static ACCEL: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static OCTREE: RefCell<Octree> = const { RefCell::new(Octree::new()) };
    static CAPACITY: RefCell<usize> = const { RefCell::new(0) };
}

/// `Math.imul` semantics: a wrapping 32-bit multiply, bit-identical to the JS
/// mulberry32 the octree uses for its deterministic coincident-point jitter.
#[inline]
fn imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}

/// Deterministic ~1e-4-magnitude direction derived purely from the point index,
/// mirroring `BarnesHutOctree.jitterFor` (pure integer mulberry32 draws, so it
/// is bit-identical on every platform). The JS normalizes with `Math.sqrt(x*x +
/// y*y + z*z)` — NOT `Math.hypot`, which is an engine-approximated f64 and would
/// break bit-parity — so Rust's IEEE `sqrt` matches it exactly.
fn jitter_for(i: i32) -> (f64, f64, f64) {
    let mut a = i.wrapping_add(1);
    let mut next = || {
        a = a.wrapping_add(0x6d2b79f5u32 as i32);
        let mut t = a ^ ((a as u32 >> 15) as i32);
        t = imul(t, 1 | a);
        t = t.wrapping_add(imul(t ^ ((t as u32 >> 7) as i32), 61 | t)) ^ t;
        (((t ^ ((t as u32 >> 14) as i32)) as u32) as f64) / 4294967296.0
    };
    let x = next() - 0.5;
    let y = next() - 0.5;
    let z = next() - 0.5;
    let len = (x * x + y * y + z * z).sqrt();
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let scale = 1e-4 / len;
    (x * scale, y * scale, z * scale)
}

impl Octree {
    const fn new() -> Self {
        Self {
            cx: Vec::new(),
            cy: Vec::new(),
            cz: Vec::new(),
            mass: Vec::new(),
            size: Vec::new(),
            child: Vec::new(),
            point_index: Vec::new(),
            px: Vec::new(),
            py: Vec::new(),
            pz: Vec::new(),
            has_point: Vec::new(),
            node_count: 0,
            capacity: 0,
            stack: Vec::new(),
        }
    }

    fn ensure(&mut self, n: usize) {
        // Worst case an octree needs up to ~2N internal nodes; allocate
        // generously. The exact capacity is irrelevant to the results — it only
        // decides when a reallocation happens, never the tree shape.
        let need = (n * 8 + 8).max(64);
        if need <= self.capacity {
            return;
        }
        self.capacity = need;
        self.cx.resize(need, 0.0);
        self.cy.resize(need, 0.0);
        self.cz.resize(need, 0.0);
        self.mass.resize(need, 0.0);
        self.size.resize(need, 0.0);
        self.child.resize(need * 8, -1);
        self.point_index.resize(need, -1);
        self.px.resize(need, 0.0);
        self.py.resize(need, 0.0);
        self.pz.resize(need, 0.0);
        self.has_point.resize(need, 0);
    }

    fn grow(&mut self) {
        let next = (self.capacity * 2).max(64);
        self.capacity = next;
        self.cx.resize(next, 0.0);
        self.cy.resize(next, 0.0);
        self.cz.resize(next, 0.0);
        self.mass.resize(next, 0.0);
        self.size.resize(next, 0.0);
        self.child.resize(next * 8, -1);
        self.point_index.resize(next, -1);
        self.px.resize(next, 0.0);
        self.py.resize(next, 0.0);
        self.pz.resize(next, 0.0);
        self.has_point.resize(next, 0);
    }

    fn reset_node(&mut self, node: usize, cx: f64, cy: f64, cz: f64, size: f64) {
        self.size[node] = size;
        self.mass[node] = 0.0;
        self.has_point[node] = 0;
        self.point_index[node] = -1;
        self.cx[node] = cx;
        self.cy[node] = cy;
        self.cz[node] = cz;
        for k in 0..8usize {
            self.child[node * 8 + k] = -1;
        }
    }

    fn allocate_node(&mut self, cx: f64, cy: f64, cz: f64, size: f64) -> usize {
        if self.node_count >= self.capacity {
            self.grow();
        }
        let node = self.node_count;
        self.node_count += 1;
        self.reset_node(node, cx, cy, cz, size);
        node
    }

    fn build(&mut self, pos: &[f32], n: usize) {
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for i in 0..n * 3 {
            let v = pos[i] as f64;
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
        if !min.is_finite() {
            min = -1.0;
            max = 1.0;
        }
        let edge = (max - min).max(1e-3);
        let cx_root = (min + max) / 2.0;

        self.ensure(n);
        self.node_count = 1;
        self.reset_node(0, cx_root, cx_root, cx_root, edge);
        self.cx[0] = cx_root;
        self.cy[0] = cx_root;
        self.cz[0] = cx_root;

        for i in 0..n {
            self.insert(
                0,
                pos[i * 3] as f64,
                pos[i * 3 + 1] as f64,
                pos[i * 3 + 2] as f64,
                cx_root,
                cx_root,
                cx_root,
                edge,
                i as i32,
            );
        }
        self.finalize_mass();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &mut self,
        node: usize,
        mut x: f64,
        mut y: f64,
        mut z: f64,
        gcx: f64,
        gcy: f64,
        gcz: f64,
        size: f64,
        point_index: i32,
    ) {
        let mut curr = node;
        let mut ccx = gcx;
        let mut ccy = gcy;
        let mut ccz = gcz;
        let mut csize = size;
        for _depth in 0..40 {
            if self.has_point[curr] == 0 && self.child[curr * 8] == -1 {
                self.px[curr] = x;
                self.py[curr] = y;
                self.pz[curr] = z;
                self.has_point[curr] = 1;
                self.point_index[curr] = point_index;
                return;
            }
            if self.has_point[curr] == 1 {
                let mut ox = self.px[curr];
                let mut oy = self.py[curr];
                let mut oz = self.pz[curr];
                let oi = self.point_index[curr];
                self.has_point[curr] = 0;
                self.point_index[curr] = -1;
                if (ox - x).abs() < 1e-9 && (oy - y).abs() < 1e-9 && (oz - z).abs() < 1e-9 {
                    let (sx, sy, sz) = jitter_for(oi);
                    ox += sx;
                    oy += sy;
                    oz += sz;
                    let (jx, jy, jz) = jitter_for(point_index);
                    x += jx;
                    y += jy;
                    z += jz;
                }
                self.place_child(curr, ox, oy, oz, ccx, ccy, ccz, csize, oi);
            }
            let oct = (if x >= ccx { 1 } else { 0 })
                | (if y >= ccy { 2 } else { 0 })
                | (if z >= ccz { 4 } else { 0 });
            let half = csize / 2.0;
            let nccx = ccx
                + if oct & 1 != 0 {
                    half / 2.0
                } else {
                    -half / 2.0
                };
            let nccy = ccy
                + if oct & 2 != 0 {
                    half / 2.0
                } else {
                    -half / 2.0
                };
            let nccz = ccz
                + if oct & 4 != 0 {
                    half / 2.0
                } else {
                    -half / 2.0
                };
            let mut child_node = self.child[curr * 8 + oct as usize];
            if child_node == -1 {
                child_node = self.allocate_node(nccx, nccy, nccz, half) as i32;
                self.child[curr * 8 + oct as usize] = child_node;
            }
            curr = child_node as usize;
            ccx = nccx;
            ccy = nccy;
            ccz = nccz;
            csize = half;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn place_child(
        &mut self,
        node: usize,
        x: f64,
        y: f64,
        z: f64,
        ccx: f64,
        ccy: f64,
        ccz: f64,
        csize: f64,
        point_index: i32,
    ) {
        let oct = (if x >= ccx { 1 } else { 0 })
            | (if y >= ccy { 2 } else { 0 })
            | (if z >= ccz { 4 } else { 0 });
        let half = csize / 2.0;
        let nccx = ccx
            + if oct & 1 != 0 {
                half / 2.0
            } else {
                -half / 2.0
            };
        let nccy = ccy
            + if oct & 2 != 0 {
                half / 2.0
            } else {
                -half / 2.0
            };
        let nccz = ccz
            + if oct & 4 != 0 {
                half / 2.0
            } else {
                -half / 2.0
            };
        let mut child_node = self.child[node * 8 + oct as usize];
        if child_node == -1 {
            child_node = self.allocate_node(nccx, nccy, nccz, half) as i32;
            self.child[node * 8 + oct as usize] = child_node;
        }
        let cn = child_node as usize;
        self.px[cn] = x;
        self.py[cn] = y;
        self.pz[cn] = z;
        self.has_point[cn] = 1;
        self.point_index[cn] = point_index;
    }

    fn finalize_mass(&mut self) {
        for node in (0..self.node_count).rev() {
            if self.has_point[node] == 1 {
                self.mass[node] = 1.0;
                self.cx[node] = self.px[node];
                self.cy[node] = self.py[node];
                self.cz[node] = self.pz[node];
                continue;
            }
            let mut m = 0.0;
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut sz = 0.0;
            for k in 0..8usize {
                let c = self.child[node * 8 + k];
                if c == -1 {
                    continue;
                }
                let cm = self.mass[c as usize];
                m += cm;
                sx += self.cx[c as usize] * cm;
                sy += self.cy[c as usize] * cm;
                sz += self.cz[c as usize] * cm;
            }
            self.mass[node] = m;
            if m > 0.0 {
                self.cx[node] = sx / m;
                self.cy[node] = sy / m;
                self.cz[node] = sz / m;
            }
        }
    }

    fn force(
        &mut self,
        qx: f64,
        qy: f64,
        qz: f64,
        theta: f64,
        point_index: i32,
    ) -> (f64, f64, f64) {
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;
        self.stack.clear();
        self.stack.push(0);
        while let Some(node) = self.stack.pop() {
            let m = self.mass[node];
            if m == 0.0 {
                continue;
            }
            let dx = self.cx[node] - qx;
            let dy = self.cy[node] - qy;
            let dz = self.cz[node] - qz;
            let mut d2 = dx * dx + dy * dy + dz * dz;
            let is_leaf = self.has_point[node] == 1;
            if is_leaf || self.size[node] * self.size[node] < theta * theta * d2 {
                if is_leaf && self.point_index[node] == point_index {
                    continue;
                }
                if d2 < 1e-6 {
                    d2 = 1e-6;
                }
                let inv_d = 1.0 / d2.sqrt();
                let factor = -m * inv_d * inv_d * inv_d;
                ax += dx * factor;
                ay += dy * factor;
                az += dz * factor;
            } else {
                for k in 0..8usize {
                    let c = self.child[node * 8 + k];
                    if c != -1 {
                        self.stack.push(c as usize);
                    }
                }
            }
        }
        (ax, ay, az)
    }
}

/// Allocate the f32 position gather buffer (n*3) and the f64 acceleration
/// output buffer (n*3) for up to `capacity` nodes, and drop the previous
/// allocations' contents. Returns [`STATUS_OK`], or [`STATUS_CAPACITY`] when the
/// size arithmetic overflows (a hostile count).
#[unsafe(no_mangle)]
pub extern "C" fn force_init(capacity: usize) -> i32 {
    let Some(n3) = capacity.checked_mul(3) else {
        return STATUS_CAPACITY;
    };
    POS.with(|p| {
        p.borrow_mut().resize(n3, 0.0);
    });
    ACCEL.with(|a| {
        a.borrow_mut().resize(n3, 0.0);
    });
    // Pre-size the octree so a build for `capacity` nodes does not grow the
    // wasm linear memory mid-step (which would detach the JS views laid over
    // it). The pathological over-8n+8 growth path still exists in `grow`, so the
    // JS backend re-validates its views after every step regardless.
    OCTREE.with(|o| {
        o.borrow_mut().ensure(capacity);
    });
    CAPACITY.with(|c| {
        *c.borrow_mut() = capacity;
    });
    STATUS_OK
}

/// Pointer to the f32 position gather buffer (n*3), valid until the next
/// `force_init`.
#[unsafe(no_mangle)]
pub extern "C" fn force_pos() -> *mut f32 {
    POS.with(|p| p.borrow_mut().as_mut_ptr())
}

/// Pointer to the f64 acceleration output buffer (n*3), valid until the next
/// `force_init`.
#[unsafe(no_mangle)]
pub extern "C" fn force_accel() -> *mut f64 {
    ACCEL.with(|a| a.borrow_mut().as_mut_ptr())
}

/// Build the octree from the resident position buffer and accumulate the
/// repulsion acceleration for every node, writing xyz triplets (f64) into the
/// acceleration buffer in node order. `theta` is the Barnes-Hut opening angle.
///
/// Returns [`STATUS_OK`], [`STATUS_UNINITIALIZED`] when `force_init` has not
/// run, or [`STATUS_CAPACITY`] when `n` exceeds the initialized capacity (the
/// caller must fall back to the JS tick — nothing is written in that case).
#[unsafe(no_mangle)]
pub extern "C" fn force_step(n: usize, theta: f64) -> i32 {
    let cap = CAPACITY.with(|c| *c.borrow());
    if cap == 0 {
        return STATUS_UNINITIALIZED;
    }
    if n > cap {
        return STATUS_CAPACITY;
    }
    POS.with(|p| {
        let pos = p.borrow();
        ACCEL.with(|a| {
            let mut accel = a.borrow_mut();
            OCTREE.with(|o| {
                let mut t = o.borrow_mut();
                t.build(&pos, n);
                for i in 0..n {
                    let (ax, ay, az) = t.force(
                        pos[i * 3] as f64,
                        pos[i * 3 + 1] as f64,
                        pos[i * 3 + 2] as f64,
                        theta,
                        i as i32,
                    );
                    accel[i * 3] = ax;
                    accel[i * 3 + 1] = ay;
                    accel[i * 3 + 2] = az;
                }
            });
        });
    });
    STATUS_OK
}
