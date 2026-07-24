# Workflow: Publish a New @vectojs/* Package Version

## Trigger

User asks to "release", "publish", "cut a version", or "bump" a package under `packages/*`.

## Preconditions

- All intended changes for the release are already committed to `main` (or the current branch is about to be merged to `main`).
- `gh` CLI available; `HTTPS_PROXY=http://127.0.0.1:1080` set per the global tool-invocation rule when calling `gh`.

## Steps (translate into `carryctx progress todo` items, then execute sequentially)

1. **Add a changeset.** Run `bun run changeset` interactively (or write the changeset markdown file directly under `.changeset/`) describing the change and bump type (patch/minor/major) for the affected package(s). Do not skip this even for a single-package change — `changesets` is the versioning source of truth here.
2. **Version the package.** Run `bun run version-packages` (`changeset version`). This bumps `packages/<pkg>/package.json` version and updates its CHANGELOG.md. Review the diff — confirm only the intended package(s) bumped, and check `updateInternalDependencies: patch` didn't cascade unexpected bumps into unrelated packages.
3. **Run the full quality gate** before tagging: `bun run check` (format:check + lint + lint:md + lint:actions) and `bun run test` (or the specific package's `vitest run`). Fix any failures — do not proceed to tagging with a red gate.
4. **Commit the version bump.** Stage only the changeset removal + package.json + CHANGELOG.md changes for the affected package(s). Conventional commit message, e.g. `chore(release): @vectojs/<pkg>@<version>`.
5. **Push to a branch and open a PR** (never push version bumps directly to `main`) — see the `create-pr` skill for title formatting. Wait for CI (ci.yml + codeql.yml) to pass and get it merged.
6. **After merge, tag the release** from `main`: `git tag @vectojs/<pkg>@<version>` matching the exact package.json version, then `git push origin @vectojs/<pkg>@<version>`. The tag format `@vectojs/<pkg>@<version>` is what `release.yml` matches on (`push: tags: ['@vectojs/*@*']`) — get this exactly right or the workflow never triggers.
7. **Monitor the triggered `release.yml` run** (`gh run watch` or `gh run list --workflow=release.yml`). It will: parse package+version from the tag, verify the tag matches `package.json`, run that package's tests, lint (`oxlint packages/<pkg>/src`), build, publish to npm (`npm publish --access public`), and attach a tarball to a GitHub Release. If it fails at the "verify tag matches package.json" step, the tag was cut against the wrong commit — fix and re-tag, don't force-push the old tag.
8. **Verify the npm publish landed**: `npm view @vectojs/<pkg>@<version>` and confirm the GitHub Release was created with the tarball attached.

## Do NOT

- Do not hand-edit a package's version in package.json without going through `changeset version` — it desyncs the CHANGELOG.md and the changeset ledger.
- Do not tag a version that hasn't been merged to `main` yet.
- Do not publish from a local machine (`npm publish` by hand) — the tag-triggered CI path is the only sanctioned publish path; it's the only place `NPM_TOKEN` exists.
