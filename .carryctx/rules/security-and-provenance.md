# Rule: Security and Doc Provenance

## Scope

Applies to changes touching trust boundaries, supply chain, or published documentation in `vectojs/` and its docs/website siblings.

## Rules

1. Treat externally-controlled values (tag names, user input, file paths, env-derived strings) as untrusted — constrain with regex or allowlists before use in shell commands or paths, as `release.yml` does for tag parsing.
2. Pin new dependencies to an exact version; reject typosquat-risk names. Pin GitHub Actions to a commit SHA or trusted tag. Do not add `install` scripts or broaden capabilities without review.
3. Run `gitleaks detect --source .` before push when handling secrets or new deps; run the matching audit (`cargo audit` / `pip-audit` / `trivy fs`) for new dependencies. CodeQL (`codeql.yml`, `security-and-quality` queries) is the JS/TS security gate — check its categories (injection, unsafe regex, prototype pollution, etc.) on read, not only after CI.
4. Secrets, tokens, or credentials must not appear in code, config, or history. Do not bypass `lefthook` with `--no-verify` without explicit user instruction.
5. `vectojs-docs/content/` is the single source of truth for framework docs. Never invent a docs source or edit `vectojs-website/src/content/` directly; publish one-way via `scripts/sync-content.py`. See `.carryctx/workflows/docs-sync.md` for the drift/report/apply and website-gate steps.
6. Do not claim a command, package version, API, or performance figure without current evidence. Only `benchmarks/run-browsers.sh` produces quotable performance numbers (headed, GPU-backed, focused window); `scripts/benchmark.ts` and `benchmarks/debug-page.ts` are headless and not quotable. Never hardcode a refresh rate — call `calibrateRefreshRate()` and report `refreshHz`.
7. The wasm kernels (`crates/vectojs-core-rs`, `crates/vectojs-force-rs`) are invisible backends with JS fallbacks — never make a code path require wasm to function. Build only via `just wasm` (which sets `RUSTFLAGS` to avoid leaking host flags into the wasm link).
