# @vectojs/devtools

## 0.4.1

### Patch Changes

- e282f2f: Route browser pointer cancellation through projected entities and DOM portals, release projected pointer capture safely, and retain cancellation in DevTools event traces.

## 0.4.0

### Minor Changes

- fc96dfa: Make browser-native text selection a reusable VectoJS contract. Core now keeps dynamically
  materialized content projections in VMT order, removes them with their subtree, hides projections
  outside clipping ancestors, and exposes `Scene.getContentElement()` for tooling. UI adds
  configurable selection to Text, RichText, Markdown, CodeBlock, and Table cells; projects fenced
  code; preserves RichText wrap points; and gives Table an explicit, render-pure layout pass with
  wrapped, single-owner cell projections. UI's Core peer range is also aligned with its stable API
  contract (`>=1.0.0 <2.0.0`). DevTools event traces now report `source: "content"` for events
  originating on projected selectable text.

## 0.3.1

### Patch Changes

- 8bbb5a2: Add the `@vectojs/devtools/headless` entry for audits, event traces, snapshots, inspection, and picking without bundling the visual panel or `@vectojs/ui`.

## 0.3.0

### Minor Changes

- Add an opt-in, bounded event-routing trace for pointer, wheel, and keyboard
  events. The in-page panel can render recent trace entries, while
  `createEventTrace` provides the same JSON-safe records to tests and agents.

## 0.2.0

### Minor Changes

- 72d8b3d: Headless audit + capture layer for state-space debugging:

  - `auditScene(scene, opts?)` / `auditTree(root, sceneBounds, opts?)` — structured layout findings: `text-overflow` (text escaping its container), `clip-overflow` (content cut off by a clipping ancestor, scroll-axis exempt for ScrollView-likes), sibling `overlap`, and `viewport-overflow` (drawn off-canvas). Deterministically sorted, JSON-safe, with `tolerance`/`ignore`/`ignoreOverlap`/`includeOverlay` options.
  - `inspectEntity(entity)` — structured `EntityInfo` (world bounds/transform, flags, text preview, a11y projection), the machine-readable sibling of `describeEntity`; plus `entityPath(entity)` and `textPreviewOf(entity)`.
  - `captureSnapshot(scene)` / `diffSnapshots(a, b)` — deterministic JSON scene-state tree and a structural-path-keyed diff for golden-state assertions.
  - Panel: new **Audit** button lists findings in place of the tree; `panel.audit()` and `panel.selectFinding(i)` drive the same flow programmatically.

## 0.1.1

### Patch Changes

- Tighten the `@vectojs/core`/`@vectojs/ui` peer dependency ranges to `>=1.0.0 <2.0.0` now that both have reached 1.0.0. The previous unbounded `>=0.1.0`/`>=0.2.7` ranges would have silently accepted a future breaking `2.0.0` of either package with no peer-dependency warning, defeating the point of the semver commitment.

## 0.1.0

### Minor Changes

- d00abdd: New package @vectojs/devtools: the in-page Virtual Math Tree inspector — live tree view with type/geometry/animation badges, one-shot entity picking, world-transform readout, keyboard nudge editing, and a host-overlay selection highlight; the panel itself is rendered with VectoJS. Core gains read-only Scene.rootEntity/overlayRootEntity accessors for tooling.
