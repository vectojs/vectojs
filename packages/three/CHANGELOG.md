# @vectojs/three

`@vectojs/three` is excluded from the automated Changesets flow
(`.changeset/config.json`'s `ignore` list) and is versioned by hand: bump
`packages/three/package.json`, commit, tag `@vectojs/three@<version>`, and push the tag —
the [publish workflow](../../.github/workflows/release.yml) takes it from there.

## 0.1.1 (2026-07-02)

### Fixed

- **No longer dispatch to detached a11y elements.** `ThreeAdapter`'s canvas is always
  offscreen (rendered into a texture, never inserted into the page), so its a11y shadow
  root is created but never attached to `document`. `getA11yElement()` could still return
  a real-but-permanently-disconnected element, and `dispatchEventToTarget` dispatched to it
  anyway — silently dropping `onClick`/`onChange` with no visible error (native DOM APIs
  like `setPointerCapture` could also throw from a disconnected element). It now checks
  `a11yEl.isConnected` and falls back to the same direct entity-dispatch path already used
  when no a11y element exists at all. See
  [`/reference/three.md`](https://vectojs.dev/reference/three/) on the docs site for the
  full explanation and its practical consequence.

## 0.1.0 (2026-07-01)

Renamed from `@vecto-ui/three` to `@vectojs/three` and reset the version to `0.1.0`,
matching the same-day rescope of `core` and `ui`. This is a clean version reset, not a
feature release — see those packages' changelogs for details on the rebrand itself.

The adapter's pre-rebrand development (`CanvasTexture` render interception, 3D-to-2D
raycast event translation, multi-pointer WebXR tracking, resource disposal) happened under
the old `@vecto-ui/three` name but was never separately npm-published — see the root
[`CHANGELOG.md`](../../CHANGELOG.md)'s archived history for that work.
