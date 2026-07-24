# Rule: Formatting & Linting Authority

## Scope

Applies to any task touching `packages/*/src/**`, `scripts/**`, `benchmarks/**`, or root config files in `vectojs/`.

## Rules

1. **oxfmt is the only formatting gate.** Run `bun run format` (writes) or `bun run format:check` (CI-mode, no writes) before considering any JS/TS/JSON change complete. Do not hand-format to a different style, even if it looks equivalent.
2. **oxlint is the only linting gate**, run with `--deny-warnings` (`bun run lint`). A warning is a failure, not a suggestion.
3. **biome is advisory only.** `biome.json` exists for fast in-editor feedback (`bun run lint:biome`). It is deliberately NOT part of `bun run check` as a formatter — oxfmt and biome disagree on some trivia (e.g. empty `for(;;)` spacing) and are not run together as competing formatters. If biome's editor squiggles conflict with what oxfmt produces, oxfmt wins; do not "fix" code to satisfy biome at the expense of an oxfmt-clean diff.
4. **Markdown**: `bun run lint:md` (markdownlint-cli2) gates all `*.md` files repo-wide.
5. **GitHub Actions**: `bun run lint:actions` (actionlint) gates `.github/workflows/*.yml`. If `actionlint` isn't on `PATH` locally, this step is skipped locally but still enforced in CI — do not treat local skip as a pass.
6. **Full gate**: `bun run check` runs format:check + lint + lint:md + lint:actions in sequence. Run this — not a subset — before declaring a change complete, unless the change touches only Rust (`crates/`), in which case use the Rust rule instead.
7. **lefthook is the pre-commit enforcement mechanism** (`lefthook.yml`), not husky/lint-staged/pre-commit. It re-runs oxfmt --write, oxlint --fix, and markdownlint --fix on staged files only, then re-stages the fixed files. Do not bypass with `--no-verify` unless the user explicitly asks.
8. **commitlint** enforces Conventional Commits on the commit message (`commit-msg` hook via lefthook). Write commit messages accordingly (`feat:`, `fix:`, `docs:`, `chore:`, etc.) so the hook doesn't reject the commit.
9. **TypeScript**: 7.x (`^7.0.2` pinned in devDependencies) everywhere in this monorepo. Do not introduce TS 5.x-only or 6.x-only syntax assumptions.
10. **knip** (`bun run knip`) flags unused exports/files/dependencies. Run it after removing or renaming exports, not as a blanket gate on every change.

## Tool invocation

All of the above are locked `devDependencies`, not global installs — always invoke via `bun run <script>` or `bunx <tool>` so the version matches CI. Do not call a globally-installed `oxfmt`/`oxlint`/`biome` binary even if one exists on `PATH`.
