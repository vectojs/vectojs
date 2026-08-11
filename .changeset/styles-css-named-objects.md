---
'@vectojs/styles': minor
---

Add `@vectojs/styles`: CSS-property-name style objects mapped onto numeric
entity fields. `style()` types an object literal; `applyStyle(entity, style)`
writes mapped fields (px strings → numbers, `row`/`column` → direction,
`flex-start`/`flex-end` → align, …), skips keys the entity lacks, throws on
invalid values and on container-only keys applied to non-containers, and
marks the scene dirty once when anything was written. No parser, no cascade,
no selector — the numeric VMT stays the single source of truth.
