---
'@vectojs/core': minor
---

Define and export the `ProjectionBackend` interface (`tree/scene/ProjectionBackend.ts`): the mount/update/unmount vocabulary from RFC1 §5 with the `ProjectionBackendKind` backend id, plus a doc mapping of the three existing projections (canvas via `IRenderer`, `A11yProjectionManager`, `ContentProjectionManager`) onto their current driver sites. Vocabulary only — zero behavior change; the `DOMProjection` row is reserved for RFC2.
