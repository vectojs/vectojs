---
'@vectojs/core': patch
---

Validate arguments in the raw WASM ABI instead of trusting the caller.

The crate's exports take raw counts and dereference raw pointers, and their Safety
contracts were enforced only by the TypeScript calling convention — `capacity`
appeared 7 times against 21 `unsafe`/`static mut` sites, and the original Phase 1
review already found two out-of-bounds read paths that way. The sandbox prevents
such a bug corrupting the browser, but it can still trap, corrupt the module's own
linear memory, or silently return wrong geometry and break a frame.

`init` now records its allocated capacities, and `set_run_count`, `compose_scalar`,
`compose_simd` and `compute_aabbs` return a status code instead of `void`:

- `0` ok
- `1` a count exceeded what `init` allocated
- `2` a kernel ran before `init`
- `3` a sibling run addressed a slot or parent outside the store

A rejected call is a no-op, so it cannot half-write the store, and the JS side
skips reading results back rather than copying stale matrices over the caller's
data. Run-table validation uses checked arithmetic, so `start + len` cannot wrap
past a naive bounds comparison, and negative `i32` fields are rejected before the
cast to `usize` turns them into enormous indices.

`WasmTransformBackend.lastStatus` exposes the most recent status, and
`WASM_STATUS` is exported for comparisons. Arithmetic is unchanged — the guards
only decide whether a kernel runs, not what it computes, so the differential tests
still pass bit-exact.
