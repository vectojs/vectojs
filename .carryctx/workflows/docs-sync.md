# Workflow: Sync Docs from vectojs-docs to vectojs-website

## Trigger

User asks to "update docs", "publish documentation changes", or after any edit to files under `vectojs-docs/content/{learn,reference,blog}/`.

## Preconditions

- Change was made in `vectojs-docs/` (the authoritative source), never directly in `vectojs-website/src/content/`.
- Both `vectojs-docs/` and `vectojs-website/` are separate git repos — commits happen independently in each.

## Steps (translate into `carryctx progress todo` items, then execute sequentially)

1. **Confirm the edit lives in the right place.** Framework docs (tutorials, API reference, blog posts) belong in `vectojs-docs/content/{learn,reference,blog}/`. Website-only content (landing pages, demos, non-framework blog posts) belongs directly in `vectojs-website/` and is out of scope for this sync — do not copy it.
2. **Make and verify the edit in `vectojs-docs/`** first. This repo is local-only (no remote) — commit here is still required for history, but there's no push step.
3. **Report what actually differs**, then sync:

   ```bash
   cd $VECTOJS_WORKSPACE/vectojs-docs
   scripts/sync-content.py            # report only
   scripts/sync-content.py --apply    # copy the files that really differ
   ```

   Do **not** use `cp -r content/* .../src/content/`. That was this step until 2026-07-31 and it is wrong three ways, all measured:

   - The website holds lines `vectojs-docs` does not, so a recursive copy **deletes** published content.
   - It clobbers the 408 localized files under `src/content/i18n/`, which have no source in `vectojs-docs` — that repo has no `i18n/` directory at all.
   - A raw diff is not a drift signal. The website runs prettier in CI (`format:check`) and `vectojs-docs` has none, so the same content differs on disk permanently. Of 10 files a raw diff flagged, 8 were formatting.

   The script normalizes both sides with the website's own locked prettier before comparing, excludes `i18n/`, and never deletes. It exits 1 when real content differs, so it also works as a gate. This is a one-way publish — never edit `vectojs-website/src/content/` directly and copy backward; fix it in `vectojs-docs/` and re-sync.

4. **Run the website's gates.** In `vectojs-website/`: `bun run check:docs`, `bun run check:anchors`, `bun run format`, then `bunx astro build`. `check:anchors` is the one that matters most here — it resolves every cross-page fragment and compares heading structure against English, so it catches both a dead anchor and an English section that has no localized counterpart yet. A new English `##` section will fail it with one error per locale until the translations land; that is correct, not a bug to work around. Note `bun run build` also runs `fetch:assets`, which hard-fails on a 403 from an external video host — use `bunx astro build` directly.
5. **Commit in `vectojs-docs/`** with a message describing the doc change (e.g. `docs: update WASM architecture status`).
6. **Commit and push in `vectojs-website/`** on a new branch, open a PR (see `create-pr` skill), and let CI validate before merge. `vectojs-website/` has a real GitHub remote (`github.com/vectojs/vectojs-website`) — never push directly to its `main`.

## Do NOT

- Do not edit `vectojs-website/src/content/{learn,reference,blog}/` directly — the next sync from `vectojs-docs/` overwrites it. `sync-content.py` reports such a file rather than silently clobbering it, but the fix is still to move the change into `vectojs-docs/`.
- Do not sync `src/content/i18n/`. Localized docs are authored in the website repo and have no source in `vectojs-docs/`; the script excludes them.
- Do not sync `vectojs-docs/forge/`, `vectojs-docs/workspace/`, or the living dev docs (ARCHITECTURE.md, TODO.md, SRS.md) — only `content/` is published.
- Do not skip the website build verification step — a copy that looks fine in a text diff can still break MDX/Astro rendering (broken shortcodes, frontmatter schema mismatches).
