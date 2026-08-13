---
'@vectojs/ui': patch
---

Five P2 fixes from the 2026-08-13 review:

- **RichText**: `syncHotspots` now reassigns each existing link hotspot's `href` on every reconcile, so a `setSpans` that keeps the link count but changes the urls no longer leaves clicks and the projected `<a>` serving stale hrefs (#472).
- **VirtualList/Tree/Table**: the hand-rolled scroll integrators are dt-aware. The old per-frame gain (0.12) and decay (0.82) are the 60Hz discretization of a 7.2/s gain and an 84ms time constant (τ = −16.67/ln(0.82)), and the position step scales by dt/16.67 — a 60Hz tick reproduces the old feel exactly while the settle trajectory no longer depends on display refresh rate (#473).
- **Popover/Overlay**: the Overlay constructor now seeds the full hidden state (`a11yHidden = true` alongside `interactive = false`), `Popover` no longer forces `interactive = true` at construction, and `showAt`/`showAtPoint` restore `interactive` and clear `a11yHidden` symmetrically with `hide()` — a never-shown popover no longer projects itself or its children, and show→hide→show cycles keep projecting (#474).
- **TextArea**: caret/selection offsets for RTL content are based on the line's minimum `sourceIndex` instead of the visually-leftmost node (`nodes[0]` after x-sort), fixing caret, selection highlight, and composition geometry for mixed RTL/LTR lines (#475).
- **ProgressBar**: now sets `interactive = true` like other draw-only semantic surfaces (Image, ScrollView), so its declared `role="progressbar"`/`aria-valuenow` actually projects into the a11y DOM (#476).
