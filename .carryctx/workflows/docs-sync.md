# Workflow: Sync Docs from vectojs-docs to vectojs-website

## Trigger

User asks to "update docs", "publish documentation changes", or after any edit to files under `vectojs-docs/content/{learn,reference,blog}/`.

## Preconditions

- Change was made in `vectojs-docs/` (the authoritative source), never directly in `vectojs-website/src/content/`.
- Both `vectojs-docs/` and `vectojs-website/` are separate git repos — commits happen independently in each.

## Steps (translate into `carryctx progress todo` items, then execute sequentially)

1. **Confirm the edit lives in the right place.** Framework docs (tutorials, API reference, blog posts) belong in `vectojs-docs/content/{learn,reference,blog}/`. Website-only content (landing pages, demos, non-framework blog posts) belongs directly in `vectojs-website/` and is out of scope for this sync — do not copy it.
2. **Make and verify the edit in `vectojs-docs/`** first. This repo is local-only (no remote) — commit here is still required for history, but there's no push step.
3. **Sync one-way to the website**:

   ```bash
   cp -r /mnt/data/Workspace/Projects/vectojs/vectojs-docs/content/* \
         /mnt/data/Workspace/Projects/vectojs/vectojs-website/src/content/
   ```

   This is a one-way copy — never edit `vectojs-website/src/content/` directly and copy backward. If a discrepancy is found in the website copy, fix it in `vectojs-docs/` and re-sync.
4. **Verify the website build.** In `vectojs-website/`, run its build/dev command (check `package.json` for the exact script) and confirm the synced pages render — check frontmatter, code blocks, and internal anchors survived the copy intact, especially for i18n content (see `vectojs-i18n` skill if translated docs are involved).
5. **Commit in `vectojs-docs/`** with a message describing the doc change (e.g. `docs: update WASM architecture status`).
6. **Commit and push in `vectojs-website/`** on a new branch, open a PR (see `create-pr` skill), and let CI validate before merge. `vectojs-website/` has a real GitHub remote (`github.com/vectojs/vectojs-website`) — never push directly to its `main`.

## Do NOT

- Do not edit `vectojs-website/src/content/{learn,reference,blog}/` directly — it will be silently overwritten by the next sync from `vectojs-docs/`.
- Do not sync `vectojs-docs/forge/`, `vectojs-docs/workspace/`, or the living dev docs (ARCHITECTURE.md, TODO.md, SRS.md) — only `content/` is published.
- Do not skip the website build verification step — a copy that looks fine in a text diff can still break MDX/Astro rendering (broken shortcodes, frontmatter schema mismatches).
