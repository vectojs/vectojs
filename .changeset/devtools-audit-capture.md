---
'@vectojs/devtools': minor
---

Headless audit + capture layer for state-space debugging:

- `auditScene(scene, opts?)` / `auditTree(root, sceneBounds, opts?)` — structured layout findings: `text-overflow` (text escaping its container), `clip-overflow` (content cut off by a clipping ancestor, scroll-axis exempt for ScrollView-likes), sibling `overlap`, and `viewport-overflow` (drawn off-canvas). Deterministically sorted, JSON-safe, with `tolerance`/`ignore`/`ignoreOverlap`/`includeOverlay` options.
- `inspectEntity(entity)` — structured `EntityInfo` (world bounds/transform, flags, text preview, a11y projection), the machine-readable sibling of `describeEntity`; plus `entityPath(entity)` and `textPreviewOf(entity)`.
- `captureSnapshot(scene)` / `diffSnapshots(a, b)` — deterministic JSON scene-state tree and a structural-path-keyed diff for golden-state assertions.
- Panel: new **Audit** button lists findings in place of the tree; `panel.audit()` and `panel.selectFinding(i)` drive the same flow programmatically.
