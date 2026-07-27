# Workflow: Publish a New @vectojs/* Package Version

## Trigger

User asks to "release", "publish", "cut a version", or "bump" a package under `packages/*`.

## Preconditions

- All intended changes for the release are already committed to `main` (or the current branch is about to be merged to `main`).
- `gh` CLI available; `HTTPS_PROXY=$NETWORK_PROXY` set per the global tool-invocation rule when calling `gh`.

## Steps (translate into `carryctx progress todo` items, then execute sequentially)

1. **Add a changeset.** Run `just changeset` (= `bun run changeset`) interactively (or write the changeset markdown file directly under `.changeset/`) describing the change and bump type (patch/minor/major) for the affected package(s). Do not skip this even for a single-package change — `changesets` is the versioning source of truth here.
2. **Version the package.** Run `just version` (= `bun run version-packages` / `changeset version`). This bumps `packages/<pkg>/package.json` version and updates its CHANGELOG.md. Review the diff — confirm only the intended package(s) bumped, and check `updateInternalDependencies: patch` didn't cascade unexpected bumps into unrelated packages.
3. **Run the full quality gate** before tagging: `just verify` (= `just check` + `just test`), or `just test-pkg <pkg>` for the specific package. Fix any failures — do not proceed to tagging with a red gate.
4. **Commit the version bump.** Stage only the changeset removal + package.json + CHANGELOG.md changes for the affected package(s). Conventional commit message, e.g. `chore(release): @vectojs/<pkg>@<version>`.
5. **Push to a branch and open a PR** (never push version bumps directly to `main`) — see the `create-pr` skill for title formatting. Wait for CI (ci.yml + codeql.yml) to pass and get it merged.
6. **After merge, tag the release** from `main`: `git tag @vectojs/<pkg>@<version>` matching the exact package.json version, then `git push origin @vectojs/<pkg>@<version>`. The tag format `@vectojs/<pkg>@<version>` is what `release.yml` matches on (`push: tags: ['@vectojs/*@*']`) — get this exactly right or the workflow never triggers.

   **Push tags ONE AT A TIME, never several in a single `git push`.** GitHub does not create a push event when a single push contains more than three tags, so the tags land on the remote and *nothing triggers* — no workflow run, no error, no output anywhere. A four-package release pushed as one command produced four correct tags and zero release runs (2026-07-27); the tags had to be deleted from the remote and re-pushed individually. Loop instead, and confirm a new run appeared after each:

   ```bash
   for t in "@vectojs/core@1.21.0" "@vectojs/ui@2.4.0" "@vectojs/markdown@0.2.0"; do
     git push origin "$t"
     sleep 12
     gh run list --workflow=release.yml --limit 1 \
       --json databaseId,headBranch,status \
       --template '{{range .}}{{.databaseId}} {{.headBranch}} {{.status}}{{"\n"}}{{end}}'
   done
   ```

   Re-pushing is safe **only** while nothing has consumed the tag: check `npm view @vectojs/<pkg>@<version>` and `gh release view` are both absent first. Once a version is on npm it cannot be republished, and the fix becomes a new patch version rather than a re-tag.
7. **Monitor the triggered `release.yml` run** (`gh run watch` or `gh run list --workflow=release.yml`). It will: parse package+version from the tag, verify the tag matches `package.json`, run that package's tests, lint (`oxlint packages/<pkg>/src`), build, publish to npm (`npm publish --access public`), and attach a tarball to a GitHub Release. If it fails at the "verify tag matches package.json" step, the tag was cut against the wrong commit — fix and re-tag, don't force-push the old tag.
8. **Verify the npm publish landed**: `npm view @vectojs/<pkg>@<version>` and confirm the GitHub Release was created with the tarball attached.

9. **Sync `vectojs-website` to the new versions** — a separate repo, so this is easy to forget and was in fact skipped for two consecutive releases (1.19.0 and 1.20.0), leaving every live sandbox loading a three-versions-stale `core`. Four places must move together, and `bun run check:docs` fails on the last three if you only do the first:
   - `src/consts.ts` → `VERSIONS` (drives the docs sidebar chips)
   - `public/sandbox/*.html` → the `esm.sh` import-map pins (26 pins across 14 files as of 1.21.0)
   - `package.json` + lockfile → the real `@vectojs/*` deps; `check-docs-consistency.ts` compares `VERSIONS` against what is **installed in `node_modules`**, not the declared range, so `bun install` must run
   - `src/content/reference/ui-components.md` → the `Version documented:` line

   Confirm each new pin resolves (`curl -o /dev/null -w '%{http_code}' https://esm.sh/@vectojs/<pkg>@<version>`) **before** committing: an unresolvable pin breaks the sandbox outright rather than degrading, and it only fails at runtime in a visitor's browser. Run all five CI steps locally (`check:docs`, `check`, `test`, `format:check`, `build`), then verify the deployed page with `curl -sL` — note `/sandbox/*.html` answers `308`, so `-L` is required.

   Leave version references in docs prose alone ("available since `@vectojs/ui@2.2.0`") — those are historical availability statements, not pins.

## Do NOT

- Do not hand-edit a package's version in package.json without going through `changeset version` — it desyncs the CHANGELOG.md and the changeset ledger.
- Do not tag a version that hasn't been merged to `main` yet.
- Do not publish from a local machine (`npm publish` by hand) — the tag-triggered CI path is the only sanctioned publish path; it's the only place `NPM_TOKEN` exists.
