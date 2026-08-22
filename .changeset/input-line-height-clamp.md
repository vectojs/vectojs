---
'@vectojs/ui': patch
---

Fix `Input` projecting a `line-height` smaller than its own font, which crushed
the value in any compact input.

`line-height` was derived as `height - 2 * padding`. With the default
`padding: 10` that falls below the font size as soon as an app asks for a compact
box — any height under 33 for a 13px font — so a 28px-tall input projected an 8px
line box and rendered `100` as something like `1QQ`.

The projected element is the real editing surface, so this was not only clipped
glyphs: a line box shorter than the font also misplaces the caret and selection
rect relative to what the canvas draws.

Now clamped to at least the font size, matching how `TextArea` already derives its
line height. Inputs tall enough to exceed the font are unchanged, so this only
affects boxes that were previously broken.

Closes #596.
