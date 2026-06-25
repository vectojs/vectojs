---
'@vecto-ui/ui': patch
---

Fix the published dependency on `@vecto-ui/core`.

Previous releases (0.1.0, 0.1.1) shipped with `"@vecto-ui/core": "workspace:*"`
in the published `package.json` — the workspace protocol was not rewritten at
publish time, so `npm install @vecto-ui/ui` failed with `EUNSUPPORTEDPROTOCOL`.
The dependency is now a real semver range (`^0.2.0`), which bun still links
locally in the monorepo and changesets keeps in sync on future core releases.
