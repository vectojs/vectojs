---
'@vectojs/core': patch
---

Split the shared WASM loader's byte and network paths.

`loadCoreWasmModule` accepted a union of raw bytes and URL/Response and handled
both in one `compile()`, which let CodeQL trace file data (a test's `readFileSync`,
or a bundler-emitted asset) into the `fetch` call and report
`js/file-access-to-http` — "file data in outbound network request" (CWE-200).

`compileBytes(BufferSource)` and `compileRemote(string | URL | Response)` are now
separate, with dispatch at the call site, so bytes have no syntactic path to a
network request. The per-backend loaders were already structured this way; the
shared runtime introduced in 1.17.0 re-merged them.

No behaviour change — every accepted source shape still works identically.
