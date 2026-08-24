---
'@vectojs/graph3d': patch
---

WASM force-kernel consistency fixes shared with the core kernels (#662): `force_init` now reports unrepresentable capacity requests as the shared `STATUS_OVERFLOW` code (it used to borrow `STATUS_CAPACITY`, which means "n exceeded an existing allocation" in `force_step`), the status vocabulary is documented to match `vectojs-core-rs` number-for-number, and the octree's worst-case pre-size uses checked arithmetic so a hostile node count can no longer wrap into an undersized allocation.
