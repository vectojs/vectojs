---
'@vectojs/markdown': patch
---

Warn when a host wires a layout callback under a name `Markdown` does not have.

`onLayoutUpdated` is the only layout callback on `Markdown`, and assigning a
plausible-looking alternative through an `as unknown as` cast compiles, silences
the type error and then never fires. A property that is only ever assigned has no
read site to fail, so nothing reports it — found in production, where a blog wired
its reflow to `onHeightChanged` and every post containing an image stayed laid out
against the guessed 16:10 aspect ratio with a stale document scroll height.

The three paths that republish `width`/`height` now go through one notifier, which
checks for `onHeightChanged`, `onHeightChange`, `onLayoutUpdate` and `onResize`
when the real hook is unset and warns once per instance. The docstring also now
names all three trigger paths, including the paragraph-image decode added in
0.18.1, and states outright that `onHeightChanged` does not exist.
